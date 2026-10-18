#!/usr/bin/env python3
"""Build Chrome MV3 declarativeNetRequest rules + cosmetic filters.

Usage:
    py -3 tools/build_rules.py            # use cached lists when present
    py -3 tools/build_rules.py --refresh  # force re-download

Only the Python standard library is required.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.request
from collections import OrderedDict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RULES_DIR = ROOT / "rules"
CACHE_DIR = ROOT / "tools" / "cache"
SRC_DIR = ROOT / "src"

CHUNK_SIZE = 25_000
# Chrome's RE2 engine rejects several common Adblock regexes with
# memoryLimitExceeded, and warnings are noisy. Skip bundled regex filters;
# user-supplied regexes are checked at runtime with isRegexSupported().
REGEX_BUDGET = 0

LISTS = [
    {
        "id": "easylist",
        "name": "EasyList",
        "description": "广告过滤主列表",
        "url": "https://easylist.to/easylist/easylist.txt",
        "default": True,
        "base_id": 1_000_000,
    },
    {
        "id": "easyprivacy",
        "name": "EasyPrivacy",
        "description": "追踪器与统计脚本",
        "url": "https://easylist.to/easylist/easyprivacy.txt",
        "default": True,
        "base_id": 2_000_000,
    },
    {
        "id": "annoyances",
        "name": "Fanboy Annoyances",
        "description": "Cookie 提示、社交按钮、悬浮窗（可选）",
        "url": "https://easylist.to/easylist/fanboy-annoyance.txt",
        "default": False,
        "base_id": 3_000_000,
    },
]

# Resource type aliases used by Adblock/uBO style filters.
TYPE_ALIASES = {
    "script": "script",
    "image": "image",
    "stylesheet": "stylesheet",
    "css": "stylesheet",
    "object": "object",
    "object-subrequest": "object",
    "xmlhttprequest": "xmlhttprequest",
    "xhr": "xmlhttprequest",
    "subdocument": "sub_frame",
    "frame": "sub_frame",
    "document": "main_frame",
    "doc": "main_frame",
    "font": "font",
    "media": "media",
    "ping": "ping",
    "websocket": "websocket",
    "webtransport": "webtransport",
    "webbundle": "webbundle",
    "other": "other",
}

# Filter options we cannot express with declarativeNetRequest. A rule using one
# of these is skipped rather than weakened, because weakening can over-block.
UNSUPPORTED_OPTIONS = {
    "csp",
    "redirect",
    "redirect-rule",
    "removeparam",
    "replace",
    "inline-script",
    "inline-font",
    "empty",
    "mp4",
    "ghide",
    "ehide",
    "shide",
    "specifichide",
    "generichide",
    "elemhide",
    "genericblock",
    "webrtc",
    "popup",
    "all",
    "badfilter",
    "denyallow",
    "from",
    "to",
    "method",
    "header",
    "cookie",
}

COSMETIC_SKIP = (
    ":style(",
    ":remove(",
    ":has-text(",
    ":contains(",
    ":xpath(",
    ":upward(",
    ":watch-attr(",
    ":matches-css",
    ":matches-attr",
    ":min-text-length(",
    ":others(",
    ":if(",
    ":if-not(",
    "-abp-",
    "+js(",
)

DOMAIN_RE = re.compile(r"^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$")
HOSTS_RE = re.compile(r"^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$")


def log(msg: str) -> None:
    print(msg, flush=True)


def fetch_list(item: dict, refresh: bool) -> str:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache = CACHE_DIR / f"{item['id']}.txt"
    if cache.exists() and not refresh:
        log(f"  cache: {cache.name} ({cache.stat().st_size / 1024:.0f} KiB)")
        return cache.read_text(encoding="utf-8", errors="replace")
    log(f"  download: {item['url']}")
    req = urllib.request.Request(item["url"], headers={"User-Agent": "Mozilla/5.0 AdBlockMini"})
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            raw = resp.read()
        text = raw.decode("utf-8", "replace")
        cache.write_text(text, encoding="utf-8")
        log(f"  saved: {cache.name} ({len(raw) / 1024:.0f} KiB)")
        return text
    except Exception as exc:
        if cache.exists():
            log(f"  download failed ({exc}); using stale cache")
            return cache.read_text(encoding="utf-8", errors="replace")
        raise


def split_options(line: str) -> tuple[str, list[str], bool]:
    """Split an Adblock filter into pattern, options, and regex flag.

    Handles regex filters where '$' may appear inside the pattern.
    """
    if line.startswith("/"):
        end = len(line) - 1
        while end > 0:
            if line[end] == "/" and line[end - 1] != "\\":
                break
            end -= 1
        if end > 1 and line[end] == "/":
            rest = line[end + 1 :]
            if not rest or rest.startswith("$"):
                opts = [o for o in rest[1:].split(",") if o] if rest else []
                return line[1:end], opts, True
    idx = line.find("$")
    if idx == -1:
        return line, [], False
    return line[:idx], [o for o in line[idx + 1 :].split(",") if o], False


def valid_domain(value: str) -> bool:
    value = value.strip().lower()
    if not value or value.startswith(".") or value.endswith("."):
        return False
    if ".." in value or len(value) > 253:
        return False
    return bool(DOMAIN_RE.match(value))


def parse_domains(value: str) -> tuple[list[str], list[str]] | None:
    include: list[str] = []
    exclude: list[str] = []
    for part in value.split("|"):
        part = part.strip()
        if not part:
            continue
        negated = part.startswith("~")
        domain = part[1:] if negated else part
        domain = domain.lower()
        if not valid_domain(domain):
            return None
        (exclude if negated else include).append(domain)
    return include, exclude


def parse_network_filter(line: str) -> dict | None:
    """Convert one Adblock network filter into a DNR rule (without id)."""
    is_exception = line.startswith("@@")
    if is_exception:
        line = line[2:]
    if not line:
        return None

    pattern, opts, is_regex = split_options(line)
    if not pattern:
        return None

    resource_types: list[str] = []
    excluded_types: list[str] = []
    initiator_domains: list[str] = []
    excluded_initiator_domains: list[str] = []
    domain_type: str | None = None
    priority = 100 if is_exception else 1
    case_sensitive = False

    for opt in opts:
        opt = opt.strip()
        if not opt:
            continue
        negated = opt.startswith("~")
        body = opt[1:] if negated else opt

        if body == "third-party":
            if negated:
                domain_type = "firstParty"
            else:
                domain_type = "thirdParty"
            continue
        if body == "match-case":
            case_sensitive = True
            continue
        if body == "important":
            priority = 10
            continue
        if body.startswith("domain="):
            parsed = parse_domains(body[len("domain=") :])
            if parsed is None:
                return None
            inc, exc = parsed
            initiator_domains.extend(inc)
            excluded_initiator_domains.extend(exc)
            continue
        if body in TYPE_ALIASES:
            target = TYPE_ALIASES[body]
            if negated:
                excluded_types.append(target)
            else:
                resource_types.append(target)
            continue
        if body in UNSUPPORTED_OPTIONS or "=" in body:
            return None
        # Unknown bare option: skip the rule instead of risking wrong matches.
        return None

    if resource_types and excluded_types:
        return None
    if not resource_types:
        resource_types = sorted(set(resource_types))
    else:
        resource_types = sorted(set(resource_types))
    excluded_types = sorted(set(excluded_types))
    initiator_domains = sorted(set(initiator_domains))
    excluded_initiator_domains = sorted(set(excluded_initiator_domains))

    condition: dict = {}
    if is_regex:
        if len(pattern) > 1000 or not pattern.isascii():
            return None
        # RE2 supports groups, but Chrome rejects capturing groups for plain
        # matching rules, so only keep regexes without parentheses.
        if re.search(r"[()]|\\[1-9]|\\k<|\\[pP]\{", pattern):
            return None
        condition["regexFilter"] = pattern
    else:
        if not pattern.isascii() or len(pattern) > 1500:
            return None
        if any(ch in pattern for ch in (" ", "\\", "#", "$")):
            return None
        if pattern in ("*", "|", "||", "^"):
            return None
        # '|' is only meaningful at the two ends in DNR. A leading '||' is
        # the domain anchor and is valid.
        inner = pattern
        if inner.startswith("||"):
            inner = inner[2:]
        elif inner.startswith("|"):
            inner = inner[1:]
        if inner.endswith("|"):
            inner = inner[:-1]
        if "|" in inner:
            return None
        if pattern.startswith("||*"):
            return None
        # Bare domain anchor should end in a separator, otherwise
        # ||example.com also matches example.company.
        m = re.fullmatch(r"\|\|([a-z0-9][a-z0-9.-]*)", pattern)
        if m:
            pattern += "^"
        condition["urlFilter"] = pattern

    if resource_types:
        condition["resourceTypes"] = resource_types
    if excluded_types:
        condition["excludedResourceTypes"] = excluded_types
    if initiator_domains:
        condition["initiatorDomains"] = initiator_domains[:200]
    if excluded_initiator_domains:
        condition["excludedInitiatorDomains"] = excluded_initiator_domains[:200]
    if domain_type:
        condition["domainType"] = domain_type
    if case_sensitive:
        condition["isUrlFilterCaseSensitive"] = True

    return {
        "priority": priority,
        "action": {"type": "allow" if is_exception else "block"},
        "condition": condition,
    }


def add_network_rule(
    line: str,
    seen: set[str],
    out: list[dict],
    regex_slots: list[int],
) -> None:
    rule = parse_network_filter(line)
    if rule is None:
        return
    condition = rule["condition"]
    if "regexFilter" in condition:
        if regex_slots[0] >= REGEX_BUDGET:
            return
        regex_slots[0] += 1
    key = json.dumps(rule, sort_keys=True, separators=(",", ":"))
    if key in seen:
        return
    seen.add(key)
    out.append(rule)


def parse_cosmetic(line: str) -> tuple[bool, str, str, str] | None:
    """Return (is_exception, kind, domain_part, selector)."""
    markers = ["#@?#", "#@$#", "#@%#", "#@#", "#?#", "#$#", "#%#", "##"]
    best_idx = -1
    best = ""
    for marker in markers:
        idx = line.find(marker)
        if idx != -1 and (best_idx == -1 or idx < best_idx):
            best_idx = idx
            best = marker
    if best_idx == -1:
        return None
    domain_part = line[:best_idx]
    selector = line[best_idx + len(best) :]
    is_exception = best.startswith("#@")
    kind = best.replace("@", "")
    if kind != "##":
        return None
    if not selector or any(token in selector for token in COSMETIC_SKIP):
        return None
    if "{" in selector or "}" in selector or "\n" in selector:
        return None
    return is_exception, kind, domain_part, selector


def add_cosmetic(
    line: str,
    generic: OrderedDict[str, None],
    global_exceptions: OrderedDict[str, None],
    domains: dict[str, OrderedDict[str, None]],
    exceptions: dict[str, OrderedDict[str, None]],
) -> None:
    parsed = parse_cosmetic(line)
    if parsed is None:
        return
    is_exception, _kind, domain_part, selector = parsed

    positives: list[str] = []
    negatives: list[str] = []
    if domain_part:
        for part in domain_part.split(","):
            part = part.strip().lower()
            if not part:
                continue
            if part.startswith("~"):
                negatives.append(part[1:])
            else:
                positives.append(part)

    if is_exception:
        if positives:
            for domain in positives:
                exceptions.setdefault(domain, OrderedDict())[selector] = None
        else:
            global_exceptions[selector] = None
        return

    if not positives:
        generic[selector] = None
        for domain in negatives:
            exceptions.setdefault(domain, OrderedDict())[selector] = None
        return

    for domain in positives:
        domains.setdefault(domain, OrderedDict())[selector] = None
    for domain in negatives:
        exceptions.setdefault(domain, OrderedDict())[selector] = None


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )


def build() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--refresh", action="store_true")
    args = parser.parse_args()

    RULES_DIR.mkdir(parents=True, exist_ok=True)
    SRC_DIR.mkdir(parents=True, exist_ok=True)

    generic: OrderedDict[str, None] = OrderedDict()
    global_exceptions: OrderedDict[str, None] = OrderedDict()
    domains: dict[str, OrderedDict[str, None]] = {}
    exceptions: dict[str, OrderedDict[str, None]] = {}

    generated_lists = []
    manifest_resources = []
    regex_slots = [0]

    for item in LISTS:
        log(f"[{item['id']}] {item['name']}")
        text = fetch_list(item, args.refresh)

        rules: list[dict] = []
        seen: set[str] = set()
        network_count = 0
        cosmetic_count = 0
        skipped = 0

        for raw in text.splitlines():
            line = raw.strip()
            if not line or line.startswith("!") or line.startswith("["):
                continue
            if any(marker in line for marker in ("##", "#@#", "#?#", "#$#", "#%#")):
                before = len(generic) + sum(len(v) for v in domains.values())
                add_cosmetic(line, generic, global_exceptions, domains, exceptions)
                after = len(generic) + sum(len(v) for v in domains.values())
                cosmetic_count += int(after > before or "#@#" in line)
                continue
            if line.startswith("#"):
                continue
            if line.startswith("@@"):
                before = len(rules)
                add_network_rule(line, seen, rules, regex_slots)
                network_count += len(rules) - before
                skipped += int(len(rules) == before)
                continue
            before = len(rules)
            add_network_rule(line, seen, rules, regex_slots)
            network_count += len(rules) - before
            skipped += int(len(rules) == before)

        chunks = [rules[i : i + CHUNK_SIZE] for i in range(0, len(rules), CHUNK_SIZE)]
        ruleset_ids = []
        ruleset_counts = []
        for index, chunk in enumerate(chunks):
            ruleset_id = f"{item['id']}_{index}"
            out = []
            for offset, rule in enumerate(chunk):
                out.append({"id": item["base_id"] + index * CHUNK_SIZE + offset, **rule})
            write_json(RULES_DIR / f"{ruleset_id}.json", out)
            manifest_resources.append(
                {
                    "id": ruleset_id,
                    "enabled": bool(index == 0 and item["default"]),
                    "path": f"rules/{ruleset_id}.json",
                }
            )
            ruleset_ids.append(ruleset_id)
            ruleset_counts.append(len(chunk))

        log(
            f"  network: {len(rules)} rules in {len(chunks)} ruleset(s); "
            f"cosmetic: {cosmetic_count}; skipped/unconvertible: {skipped}"
        )
        generated_lists.append(
            {
                "id": item["id"],
                "name": item["name"],
                "description": item["description"],
                "default": item["default"],
                "rulesets": ruleset_ids,
                "rulesetCounts": ruleset_counts,
                "ruleCount": len(rules),
            }
        )

    # Generic cosmetic rules are injected by the manifest, so build a plain
    # stylesheet. Domain-specific rules are served by the service worker.
    generic_css = "".join(f"{sel}{{display:none!important}}\n" for sel in generic)
    (RULES_DIR / "cosmetic-generic.css").write_text(generic_css, encoding="utf-8")

    domain_payload = {
        "domains": {k: list(v.keys()) for k, v in domains.items()},
        "exceptions": {k: list(v.keys()) for k, v in exceptions.items()},
        "globalExceptions": list(global_exceptions.keys()),
    }
    write_json(RULES_DIR / "cosmetic-domains.json", domain_payload)

    generated_js = (
        "// Generated by tools/build_rules.py. Do not edit by hand.\n"
        "globalThis.ADBLOCK_LISTS = "
        + json.dumps(generated_lists, ensure_ascii=False, indent=2)
        + ";\n"
    )
    (SRC_DIR / "generated.js").write_text(generated_js, encoding="utf-8")

    # Keep manifest rule_resources in sync without touching the rest of it.
    manifest_path = ROOT / "manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest.setdefault("declarative_net_request", {})["rule_resources"] = manifest_resources
        manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    total_rules = sum(item["ruleCount"] for item in generated_lists)
    total_cosmetic = len(generic) + sum(len(v) for v in domains.values())
    write_json(
        RULES_DIR / "stats.json",
        {
            "lists": generated_lists,
            "totalNetworkRules": total_rules,
            "totalCosmeticSelectors": total_cosmetic,
            "domainSelectors": sum(len(v) for v in domains.values()),
            "genericSelectors": len(generic),
            "regexRules": regex_slots[0],
        },
    )
    log("")
    log(f"Done. network rules: {total_rules}; cosmetic selectors: {total_cosmetic}")
    log(f"Regex rules used: {regex_slots[0]}/{REGEX_BUDGET}")
    log(f"Rule files: {len(manifest_resources)}")
    return 0


if __name__ == "__main__":
    sys.exit(build())
