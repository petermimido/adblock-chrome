#!/usr/bin/env python3
"""End-to-end smoke test for the unpacked extension using Selenium + Chromium.

Chrome 137+ ignores --load-extension for branded stable builds, so this test
defaults to Microsoft Edge (Chromium) and falls back to Chrome if requested:

    py -3 tools/test_extension.py
    $env:ADBLOCK_TEST_BROWSER="chrome"; py -3 tools/test_extension.py
"""

from __future__ import annotations

import http.server
import os
import socketserver
import tempfile
import threading
import time
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.chrome.options import Options as ChromeOptions
from selenium.webdriver.edge.options import Options as EdgeOptions

ROOT = Path(__file__).resolve().parent.parent
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
BROWSER = os.environ.get("ADBLOCK_TEST_BROWSER", "edge").lower()

RULE_FILES = [
    "rules/easylist_0.json",
    "rules/easylist_1.json",
    "rules/easylist_2.json",
    "rules/easyprivacy_0.json",
    "rules/easyprivacy_1.json",
    "rules/easyprivacy_2.json",
    "rules/annoyances_0.json",
]

PAGE = """<!doctype html>
<html><head><meta charset="utf-8"><title>AdBlock Mini Test</title></head>
<body>
  <div id="content">clean content</div>
  <div id="ad-banner-1" class="ad-banner">advertisement</div>
  <img id="ad-img" src="/adserver.png" alt="ad">
  <script src="/clean.js"></script>
  <script src="/adserver.js"></script>
  <script src="/custom-ad.js"></script>
</body></html>
"""

CLEAN_JS = "window.__cleanLoaded = true;"
AD_JS = "window.__adserverLoaded = true;"
CUSTOM_AD_JS = "window.__customAdLoaded = true;"


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        routes = {
            "/": ("text/html; charset=utf-8", PAGE.encode()),
            "/clean.js": ("application/javascript", CLEAN_JS.encode()),
            "/adserver.js": ("application/javascript", AD_JS.encode()),
            "/custom-ad.js": ("application/javascript", CUSTOM_AD_JS.encode()),
            "/adserver.png": (
                "image/png",
                bytes.fromhex(
                    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
                    "0000000d49444154789c6360000002000154a24f5f0000000049454e44ae426082"
                ),
            ),
        }
        route = routes.get(self.path)
        if not route:
            self.send_response(404)
            self.end_headers()
            return
        content_type, body = route
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def wait_for_extension_target(driver, timeout=20):
    deadline = time.time() + timeout
    targets = []
    while time.time() < deadline:
        try:
            targets = driver.execute_cdp_cmd("Target.getTargets", {})["targetInfos"]
        except Exception:
            targets = []
        for target in targets:
            url = target.get("url", "")
            if url.startswith("chrome-extension://") and "/background" in url:
                return url.split("/")[2], targets
        for target in targets:
            url = target.get("url", "")
            if url.startswith("chrome-extension://"):
                return url.split("/")[2], targets
        time.sleep(0.5)
    return None, targets


def build_driver():
    options = EdgeOptions() if BROWSER == "edge" else ChromeOptions()
    options.binary_location = EDGE if BROWSER == "edge" else CHROME
    profile = tempfile.mkdtemp(prefix="adblock-mini-test-")
    options.add_argument("--headless=new")
    options.add_argument(f"--user-data-dir={profile}")
    options.add_argument(f"--disable-extensions-except={ROOT}")
    options.add_argument(f"--load-extension={ROOT}")
    options.add_argument("--no-first-run")
    options.add_argument("--no-default-browser-check")
    options.add_argument("--disable-gpu")
    options.add_argument("--window-size=1280,900")
    options.set_capability("goog:loggingPrefs", {"browser": "ALL", "performance": "ALL"})
    return webdriver.Edge(options=options) if BROWSER == "edge" else webdriver.Chrome(options=options)


def send_extension(driver, message, timeout=30):
    driver.set_script_timeout(timeout)
    return driver.execute_async_script(
        """
        const message = arguments[0];
        const done = arguments[arguments.length - 1];
        chrome.runtime.sendMessage(message, (response) => done(response));
        """,
        message,
    )


def check_regex_rules(driver):
    driver.set_script_timeout(120)
    return driver.execute_async_script(
        """
        const files = arguments[0];
        const done = arguments[arguments.length - 1];
        (async () => {
          const results = { total: 0, unsupported: [] };
          for (const file of files) {
            const rules = await (await fetch(chrome.runtime.getURL(file))).json();
            for (const rule of rules) {
              const condition = rule.condition || {};
              if (!condition.regexFilter) continue;
              results.total += 1;
              const answer = await chrome.declarativeNetRequest.isRegexSupported({
                regex: condition.regexFilter,
              });
              if (!answer.isSupported) {
                results.unsupported.push({
                  id: rule.id,
                  file,
                  reason: answer.reason,
                  regex: condition.regexFilter.slice(0, 160),
                });
              }
            }
          }
          done(results);
        })();
        """,
        RULE_FILES,
    )


def main():
    server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()

    driver = build_driver()
    failures = []
    try:
        ext_id, targets = wait_for_extension_target(driver)
        print(f"browser: {BROWSER}")
        print("extension id:", ext_id)
        if not ext_id:
            failures.append("extension service-worker target not found")
            print("targets:", [(t.get("type"), t.get("url")) for t in targets][:15])

        driver.get(f"http://127.0.0.1:{port}/")
        time.sleep(2.5)
        result = driver.execute_script(
            """
            return {
              adLoaded: Boolean(window.__adserverLoaded),
              cleanLoaded: Boolean(window.__cleanLoaded),
              customAdLoaded: Boolean(window.__customAdLoaded),
              bannerDisplay: getComputedStyle(document.getElementById('ad-banner-1')).display,
              contentDisplay: getComputedStyle(document.getElementById('content')).display,
            };
            """
        )
        print("page state:", result)
        if result["adLoaded"]:
            failures.append("EasyList did not block /adserver.js")
        if not result["cleanLoaded"]:
            failures.append("control script /clean.js was blocked")
        if result["bannerDisplay"] != "none":
            failures.append("cosmetic rule #ad-banner did not hide element")
        if result["contentDisplay"] == "none":
            failures.append("cosmetic rules hid normal content")

        if ext_id:
            driver.get(f"chrome-extension://{ext_id}/src/options.html")
            time.sleep(0.5)
            state = send_extension(driver, {"type": "getOptions"})
            print("settings enabled:", state.get("settings", {}).get("enabled"))
            print("enabled rulesets:", len(state.get("enabledRulesets") or []), state.get("enabledRulesets"))
            if not state or not state.get("ok"):
                failures.append(f"getOptions failed: {state}")
            elif len(state.get("enabledRulesets") or []) < 6:
                failures.append(
                    f"expected at least 6 enabled rulesets, got {state.get('enabledRulesets')}"
                )

            # The popup "advanced settings" button relies on options_ui.
            driver.get(f"chrome-extension://{ext_id}/src/popup.html")
            time.sleep(0.4)
            before = set(driver.window_handles)
            open_result = driver.execute_async_script(
                """
                const done = arguments[arguments.length - 1];
                chrome.runtime.openOptionsPage()
                  .then(() => done("ok"))
                  .catch((error) => done(`error: ${error.message}`));
                """
            )
            opened = None
            for _ in range(10):
                time.sleep(0.3)
                targets = driver.execute_cdp_cmd("Target.getTargets", {})["targetInfos"]
                match = next(
                    (t for t in targets if "src/options.html" in t.get("url", "")),
                    None,
                )
                if match:
                    opened = match["url"]
                    break
            print("openOptionsPage:", open_result, opened)
            print("targets after open:", [(t.get("type"), t.get("url")) for t in targets][:12])
            if open_result != "ok" or not opened:
                failures.append(f"advanced settings did not open: {open_result} / {opened}")

            driver.get(f"chrome-extension://{ext_id}/src/options.html")
            time.sleep(0.3)
            regex = check_regex_rules(driver)
            print("regex rules:", regex["total"], "unsupported:", len(regex["unsupported"]))
            if regex["unsupported"]:
                for item in regex["unsupported"][:8]:
                    print("  unsupported regex:", item)
                failures.append(f"unsupported regex rules: {len(regex['unsupported'])}")

            payload = {
                "enabled": True,
                "lists": state.get("settings", {}).get("lists", {}),
                "disabledSites": [],
                "customFilters": "/custom-ad.",
                "customCosmetic": [],
            }
            saved = send_extension(driver, {"type": "saveSettings", "settings": payload})
            if not saved or not saved.get("ok"):
                failures.append(f"saveSettings failed: {saved}")
            elif saved.get("dynamicErrors"):
                failures.append(f"custom filter errors: {saved['dynamicErrors']}")
            driver.get(f"http://127.0.0.1:{port}/")
            time.sleep(2.5)
            custom = driver.execute_script(
                "return {customAdLoaded: Boolean(window.__customAdLoaded), cleanLoaded: Boolean(window.__cleanLoaded)};"
            )
            print("custom filter state:", custom)
            if custom["customAdLoaded"]:
                failures.append("custom filter /custom-ad. did not block request")
            if not custom["cleanLoaded"]:
                failures.append("custom filter accidentally blocked control script")

            driver.get(f"chrome-extension://{ext_id}/src/options.html")
            time.sleep(0.3)
            restored = send_extension(
                driver,
                {
                    "type": "saveSettings",
                    "settings": {
                        "enabled": True,
                        "lists": {"easylist": True, "easyprivacy": True, "annoyances": False},
                        "disabledSites": [],
                        "customFilters": "",
                        "customCosmetic": [],
                    },
                },
            )
            if not restored or not restored.get("ok"):
                failures.append(f"restore settings failed: {restored}")

            driver.get(f"chrome-extension://{ext_id}/src/options.html")
            time.sleep(0.3)
            toggled = send_extension(driver, {"type": "toggleGlobal"})
            if not toggled or toggled.get("settings", {}).get("enabled"):
                failures.append("toggleGlobal did not disable")
            driver.get(f"http://127.0.0.1:{port}/")
            time.sleep(2.5)
            off_state = driver.execute_script(
                """
                return {
                  adLoaded: Boolean(window.__adserverLoaded),
                  bannerDisplay: getComputedStyle(document.getElementById('ad-banner-1')).display,
                };
                """
            )
            print("global off state:", off_state)
            if not off_state["adLoaded"]:
                failures.append("global off still blocked /adserver.js")
            if off_state["bannerDisplay"] == "none":
                failures.append("global off still hid cosmetic elements")

            # Prioritized rulesets stay disabled by the global switch.
            driver.get(f"chrome-extension://{ext_id}/src/options.html")
            time.sleep(0.3)
            on = send_extension(driver, {"type": "toggleGlobal"})
            if not on or not on.get("settings", {}).get("enabled"):
                failures.append("toggleGlobal did not re-enable")

            # Site whitelist: /adserver.js must load again on 127.0.0.1.
            driver.get(f"chrome-extension://{ext_id}/src/popup.html")
            time.sleep(0.3)
            site = send_extension(driver, {"type": "toggleSite", "hostname": "127.0.0.1"})
            if not site or not site.get("ok"):
                failures.append(f"toggleSite failed: {site}")
            driver.get(f"http://127.0.0.1:{port}/")
            time.sleep(2.5)
            site_state = driver.execute_script(
                "return {adLoaded: Boolean(window.__adserverLoaded), bannerDisplay: getComputedStyle(document.getElementById('ad-banner-1')).display};"
            )
            print("site whitelist state:", site_state)
            if not site_state["adLoaded"]:
                failures.append("site whitelist did not allow /adserver.js")
            if site_state["bannerDisplay"] == "none":
                failures.append("site whitelist did not stop cosmetic hiding")

            # Revert whitelist.
            driver.get(f"chrome-extension://{ext_id}/src/popup.html")
            time.sleep(0.3)
            send_extension(driver, {"type": "toggleSite", "hostname": "127.0.0.1"})
            driver.get(f"http://127.0.0.1:{port}/")
            time.sleep(2.0)
            final = driver.execute_script(
                "return {adLoaded: Boolean(window.__adserverLoaded), bannerDisplay: getComputedStyle(document.getElementById('ad-banner-1')).display};"
            )
            print("after whitelist revert:", final)
            if final["adLoaded"]:
                failures.append("removing site whitelist did not restore blocking")

        logs = driver.get_log("browser")
        ignored = ("favicon", "ERR_BLOCKED_BY_CLIENT")
        severe = [
            entry for entry in logs
            if entry.get("level") == "SEVERE"
            and not any(token in entry.get("message", "") for token in ignored)
        ]
        if severe:
            print("severe browser logs:", severe[:10])
        for entry in severe:
            failures.append(f"browser log: {entry.get('message')}")

    finally:
        driver.quit()
        server.shutdown()

    if failures:
        print("\nFAILURES:")
        for failure in failures:
            print(" -", failure)
        raise SystemExit(1)
    print("\nOK: all extension smoke checks passed")


if __name__ == "__main__":
    main()
