importScripts("generated.js");

const CUSTOM_RULE_BASE = 2_000_000;
const SITE_RULE_BASE = 3_000_000;
const GLOBAL_ALLOW_ID = 3_999_999;
const MAX_CUSTOM_RULES = 4000;
const MAX_DISABLED_SITES = 900;
const BADGE_COLOR = "#b42318";

const DEFAULT_SETTINGS = {
  enabled: true,
  lists: Object.fromEntries(ADBLOCK_LISTS.map((list) => [list.id, Boolean(list.default)])),
  disabledSites: [],
  customFilters: "",
  customCosmetic: [],
};

let cachedSettings = null;
let counts = new Map();
let countsLoaded = false;
let flushTimer = null;
let cosmeticDataPromise = null;
let cosmeticCache = new Map();
let applyChain = Promise.resolve();

async function loadSettings() {
  if (cachedSettings) return cachedSettings;
  const stored = await chrome.storage.local.get("settings");
  const value = stored.settings || {};
  cachedSettings = {
    ...DEFAULT_SETTINGS,
    ...value,
    lists: { ...DEFAULT_SETTINGS.lists, ...(value.lists || {}) },
    disabledSites: Array.isArray(value.disabledSites) ? value.disabledSites : [],
    customFilters: typeof value.customFilters === "string" ? value.customFilters : "",
    customCosmetic: Array.isArray(value.customCosmetic) ? value.customCosmetic : [],
  };
  return cachedSettings;
}

async function saveSettings(settings) {
  cachedSettings = settings;
  await chrome.storage.local.set({ settings });
}

function setCachedSettings(settings) {
  cachedSettings = settings;
}

async function applyAll() {
  const settings = await loadSettings();
  setCachedSettings(settings);
  const staticResult = await applyStaticRules(settings);
  const dynamicResult = await syncDynamicRules(settings);
  clearCosmeticCache();
  await refreshAllBadges(settings);
  return { ...staticResult, ...dynamicResult };
}

function scheduleApply() {
  applyChain = applyChain
    .then(() => applyAll())
    .catch((err) => console.error("AdBlock Mini: apply failed", err));
  return applyChain;
}

async function applyStaticRules(settings) {
  const desired = new Set();
  if (settings.enabled) {
    for (const list of ADBLOCK_LISTS) {
      if (settings.lists[list.id]) {
        for (const ruleset of list.rulesets) desired.add(ruleset);
      }
    }
  }

  let enabled = await chrome.declarativeNetRequest.getEnabledRulesets();
  const toDisable = enabled.filter((id) => !desired.has(id));
  if (toDisable.length) {
    try {
      await chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: toDisable });
    } catch (err) {
      console.warn("AdBlock Mini: could not disable rulesets", err);
    }
  }

  enabled = await chrome.declarativeNetRequest.getEnabledRulesets();
  const missing = [...desired].filter((id) => !enabled.includes(id));
  if (!missing.length) {
    return { enabledRulesets: enabled, staticWarning: null };
  }

  const countsByRuleset = {};
  for (const list of ADBLOCK_LISTS) {
    list.rulesets.forEach((id, index) => {
      countsByRuleset[id] = list.rulesetCounts?.[index] || 25000;
    });
  }

  let available = Number.MAX_SAFE_INTEGER;
  try {
    available = await chrome.declarativeNetRequest.getAvailableStaticRuleCount();
  } catch {
    // Older Chrome. Try enabling and let the API enforce the limit.
  }

  let warning = null;
  for (const id of missing) {
    const need = countsByRuleset[id] || 25000;
    if (need > available) {
      warning = `静态规则配额不足，未启用 ${id}（需要 ${need}，剩余 ${available}）。`;
      continue;
    }
    try {
      await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: [id] });
      available -= need;
    } catch (err) {
      warning = `启用 ${id} 失败：${err?.message || err}`;
      console.warn("AdBlock Mini:", warning);
    }
  }

  enabled = await chrome.declarativeNetRequest.getEnabledRulesets();
  return { enabledRulesets: enabled, staticWarning: warning };
}

async function syncDynamicRules(settings) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing
    .filter((rule) => rule.id >= CUSTOM_RULE_BASE && rule.id < 4_000_000)
    .map((rule) => rule.id);

  const addRules = [];
  const errors = [];

  if (!settings.enabled) {
    addRules.push({
      id: GLOBAL_ALLOW_ID,
      priority: 1_000_000,
      action: { type: "allowAllRequests" },
      condition: { resourceTypes: ["main_frame", "sub_frame"] },
    });
  } else {
    const parsed = parseCustomFilters(settings.customFilters);
    errors.push(...parsed.errors);
    for (const rule of parsed.rules) {
      const regex = rule.condition.regexFilter;
      if (regex) {
        try {
          const answer = await chrome.declarativeNetRequest.isRegexSupported({ regex });
          if (!answer.isSupported) {
            errors.push(`正则不支持（${answer.reason}）：${regex.slice(0, 60)}`);
            continue;
          }
        } catch (err) {
          errors.push(`正则校验失败：${err?.message || err}`);
          continue;
        }
      }
      addRules.push(rule);
    }

    const sites = settings.disabledSites.slice(0, MAX_DISABLED_SITES);
    sites.forEach((site, index) => {
      if (!isValidDomain(site)) return;
      addRules.push({
        id: SITE_RULE_BASE + index,
        priority: 1_000_000,
        action: { type: "allowAllRequests" },
        condition: {
          urlFilter: `||${site}^`,
          resourceTypes: ["main_frame", "sub_frame"],
        },
      });
    });
  }

  const limit = chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES || 5000;
  if (addRules.length > limit) {
    errors.push(`动态规则超过浏览器上限（${limit} 条），已截断。`);
    addRules.length = limit;
  }

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  } catch (err) {
    errors.push(`写入动态规则失败：${err?.message || err}`);
    console.warn("AdBlock Mini: dynamic rules failed", err);
  }

  return { dynamicErrors: errors };
}

function isValidDomain(value) {
  if (typeof value !== "string") return false;
  const domain = value.trim().toLowerCase();
  if (!domain || domain.length > 253) return false;
  if (domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return false;
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain);
}

const TYPE_ALIASES = {
  script: "script",
  image: "image",
  stylesheet: "stylesheet",
  css: "stylesheet",
  object: "object",
  "object-subrequest": "object",
  xmlhttprequest: "xmlhttprequest",
  xhr: "xmlhttprequest",
  subdocument: "sub_frame",
  frame: "sub_frame",
  document: "main_frame",
  doc: "main_frame",
  font: "font",
  media: "media",
  ping: "ping",
  websocket: "websocket",
  webtransport: "webtransport",
  webbundle: "webbundle",
  other: "other",
};

const UNSUPPORTED_OPTIONS = new Set([
  "csp", "redirect", "redirect-rule", "removeparam", "replace",
  "inline-script", "inline-font", "empty", "mp4", "ghide", "ehide",
  "shide", "specifichide", "generichide", "elemhide", "genericblock",
  "webrtc", "popup", "all", "badfilter", "denyallow", "from", "to",
  "method", "header", "cookie",
]);

function splitFilter(line) {
  if (line.startsWith("/")) {
    let end = line.length - 1;
    while (end > 0 && !(line[end] === "/" && line[end - 1] !== "\\")) end -= 1;
    if (end > 1 && line[end] === "/") {
      const rest = line.slice(end + 1);
      if (!rest || rest.startsWith("$")) {
        return {
          pattern: line.slice(1, end),
          opts: rest ? rest.slice(1).split(",").filter(Boolean) : [],
          regex: true,
        };
      }
    }
  }
  const idx = line.indexOf("$");
  if (idx === -1) return { pattern: line, opts: [], regex: false };
  return {
    pattern: line.slice(0, idx),
    opts: line.slice(idx + 1).split(",").filter(Boolean),
    regex: false,
  };
}

function parseDomains(value) {
  const include = [];
  const exclude = [];
  for (const raw of value.split("|")) {
    const part = raw.trim();
    if (!part) continue;
    const negated = part.startsWith("~");
    const domain = (negated ? part.slice(1) : part).toLowerCase();
    if (!isValidDomain(domain)) return null;
    (negated ? exclude : include).push(domain);
  }
  return { include, exclude };
}

function parseFilterLine(line) {
  let body = line;
  const isException = body.startsWith("@@");
  if (isException) body = body.slice(2);
  if (!body) return null;

  const { pattern, opts, regex } = splitFilter(body);
  if (!pattern) return null;

  const resourceTypes = new Set();
  const excludedTypes = new Set();
  const initiatorDomains = new Set();
  const excludedInitiatorDomains = new Set();
  let domainType = null;
  let priority = isException ? 100 : 1;
  let caseSensitive = false;

  for (const raw of opts) {
    const opt = raw.trim();
    if (!opt) continue;
    const negated = opt.startsWith("~");
    const name = negated ? opt.slice(1) : opt;

    if (name === "third-party") {
      domainType = negated ? "firstParty" : "thirdParty";
      continue;
    }
    if (name === "match-case") {
      caseSensitive = true;
      continue;
    }
    if (name === "important") {
      priority = 10;
      continue;
    }
    if (name.startsWith("domain=")) {
      const parsed = parseDomains(name.slice(7));
      if (!parsed) return null;
      for (const domain of parsed.include) initiatorDomains.add(domain);
      for (const domain of parsed.exclude) excludedInitiatorDomains.add(domain);
      continue;
    }
    if (TYPE_ALIASES[name]) {
      (negated ? excludedTypes : resourceTypes).add(TYPE_ALIASES[name]);
      continue;
    }
    return null;
  }

  if (resourceTypes.size && excludedTypes.size) return null;

  const condition = {};
  if (regex) {
    if (pattern.length > 1000 || !/^[\x00-\x7F]*$/.test(pattern)) return null;
    if (/[()]|\\[1-9]|\\k<|\\[pP]\{/.test(pattern)) return null;
    condition.regexFilter = pattern;
  } else {
    if (pattern.length > 1500 || !/^[\x00-\x7F]*$/.test(pattern)) return null;
    if (/[ \\#$]/.test(pattern)) return null;
    if (["*", "|", "||", "^"].includes(pattern)) return null;
    let inner = pattern;
    if (inner.startsWith("||")) inner = inner.slice(2);
    else if (inner.startsWith("|")) inner = inner.slice(1);
    if (inner.endsWith("|")) inner = inner.slice(0, -1);
    if (inner.includes("|")) return null;
    if (pattern.startsWith("||*")) return null;
    if (/^\|\|[a-z0-9][a-z0-9.-]*$/.test(pattern)) {
      condition.urlFilter = `${pattern}^`;
    } else {
      condition.urlFilter = pattern;
    }
  }

  if (resourceTypes.size) condition.resourceTypes = [...resourceTypes].sort();
  if (excludedTypes.size) condition.excludedResourceTypes = [...excludedTypes].sort();
  if (initiatorDomains.size) condition.initiatorDomains = [...initiatorDomains].slice(0, 200);
  if (excludedInitiatorDomains.size) {
    condition.excludedInitiatorDomains = [...excludedInitiatorDomains].slice(0, 200);
  }
  if (domainType) condition.domainType = domainType;
  if (caseSensitive) condition.isUrlFilterCaseSensitive = true;

  return {
    priority,
    action: { type: isException ? "allow" : "block" },
    condition,
  };
}

function parseCustomFilters(text) {
  const rules = [];
  const errors = [];
  const seen = new Set();
  const lines = String(text || "").split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith("!") || line.startsWith("[")) continue;
    if (line.includes("##") || line.includes("#@#") || line.includes("#?#") ||
        line.includes("#$#") || line.includes("#%#")) {
      continue;
    }
    if (line.startsWith("#")) continue;
    if (rules.length >= MAX_CUSTOM_RULES) {
      errors.push(`自定义网络规则超过 ${MAX_CUSTOM_RULES} 条，其余已忽略。`);
      break;
    }
    const rule = parseFilterLine(line);
    if (!rule) {
      errors.push(`第 ${index + 1} 行无法转换：${line.slice(0, 120)}`);
      continue;
    }
    const key = JSON.stringify(rule);
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push({ id: CUSTOM_RULE_BASE + rules.length, ...rule });
  }
  return { rules, errors };
}

async function getCosmeticData() {
  if (!cosmeticDataPromise) {
    cosmeticDataPromise = fetch(chrome.runtime.getURL("rules/cosmetic-domains.json"))
      .then((response) => {
        if (!response.ok) throw new Error(`cosmetic fetch failed: ${response.status}`);
        return response.json();
      })
      .catch((err) => {
        cosmeticDataPromise = null;
        throw err;
      });
  }
  return cosmeticDataPromise;
}

function clearCosmeticCache() {
  cosmeticCache.clear();
}

function hostSuffixes(hostname) {
  const parts = hostname.split(".").filter(Boolean);
  if (parts.length <= 1) return [hostname];
  const suffixes = [];
  for (let i = 0; i < parts.length - 1; i += 1) suffixes.push(parts.slice(i).join("."));
  return suffixes;
}

function siteIsDisabled(settings, hostname) {
  return settings.disabledSites.some(
    (site) => hostname === site || hostname.endsWith(`.${site}`),
  );
}

async function getCosmeticCSS(hostname) {
  const settings = await loadSettings();
  if (!settings.enabled || siteIsDisabled(settings, hostname)) return "";
  if (cosmeticCache.has(hostname)) return cosmeticCache.get(hostname);

  const data = await getCosmeticData();
  const suffixes = hostSuffixes(hostname);
  const selectors = new Set();
  const excluded = new Set(data.globalExceptions || []);

  for (const suffix of suffixes) {
    for (const selector of data.domains?.[suffix] || []) selectors.add(selector);
    for (const selector of data.exceptions?.[suffix] || []) excluded.add(selector);
  }

  for (const entry of settings.customCosmetic) {
    if (!entry || !isSafeSelector(entry.selector)) continue;
    const domain = String(entry.domain || "").toLowerCase();
    if (!domain || hostname === domain || hostname.endsWith(`.${domain}`)) {
      selectors.add(entry.selector);
    }
  }

  let css = "";
  for (const selector of selectors) {
    if (excluded.has(selector)) continue;
    css += `${selector}{display:none!important}\n`;
  }
  if (cosmeticCache.size > 200) cosmeticCache.clear();
  cosmeticCache.set(hostname, css);
  return css;
}

async function ensureCountsLoaded() {
  if (countsLoaded) return;
  countsLoaded = true;
  const all = await chrome.storage.session.get(null);
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith("count_")) {
      const tabId = Number(key.slice("count_".length));
      if (Number.isFinite(tabId) && Number.isFinite(value)) counts.set(tabId, value);
    }
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    await ensureCountsLoaded();
    const payload = {};
    for (const [tabId, value] of counts) payload[`count_${tabId}`] = value;
    try {
      await chrome.storage.session.set(payload);
    } catch (err) {
      console.warn("AdBlock Mini: count flush failed", err);
    }
  }, 1000);
}

async function getCount(tabId) {
  await ensureCountsLoaded();
  return counts.get(tabId) || 0;
}

async function clearCount(tabId) {
  await ensureCountsLoaded();
  counts.delete(tabId);
  try {
    await chrome.storage.session.remove(`count_${tabId}`);
  } catch {
    // Session storage can be unavailable during shutdown.
  }
  await chrome.action.setBadgeText({ tabId, text: "" });
}

function formatBadge(count) {
  if (count <= 0) return "";
  if (count > 999) return "999+";
  return String(count);
}

const badgeTimers = new Map();

function scheduleBadge(tabId) {
  if (badgeTimers.has(tabId)) return;
  badgeTimers.set(tabId, setTimeout(async () => {
    badgeTimers.delete(tabId);
    if (cachedSettings && !cachedSettings.enabled) {
      chrome.action.setBadgeText({ tabId, text: "OFF" });
      return;
    }
    const count = await getCount(tabId);
    chrome.action.setBadgeText({ tabId, text: formatBadge(count) });
    chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR });
  }, 300));
}

function recordMatch(tabId) {
  if (tabId < 0) return;
  counts.set(tabId, (counts.get(tabId) || 0) + 1);
  scheduleFlush();
  scheduleBadge(tabId);
}

async function refreshAllBadges(settings) {
  if (settings.enabled) {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab.id) continue;
      const count = await getCount(tab.id);
      chrome.action.setBadgeText({ tabId: tab.id, text: formatBadge(count) });
      chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: BADGE_COLOR });
    }
  } else {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id) chrome.action.setBadgeText({ tabId: tab.id, text: "OFF" });
    }
    chrome.action.setBadgeBackgroundColor({ color: "#6b7280" });
  }
}

async function getTabState() {
  const settings = await loadSettings();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let hostname = null;
  try {
    if (tab?.url) {
      const url = new URL(tab.url);
      if (url.protocol === "http:" || url.protocol === "https:") hostname = url.hostname;
    }
  } catch {
    hostname = null;
  }

  let count = tab?.id ? await getCount(tab.id) : 0;
  if (tab?.id && count === 0) {
    try {
      const matched = await chrome.declarativeNetRequest.getMatchedRules({ tabId: tab.id });
      count = matched.rules.length;
    } catch {
      // declarativeNetRequestFeedback is only available for unpacked builds.
    }
  }

  return {
    ok: true,
    settings,
    hostname,
    siteDisabled: Boolean(hostname && siteIsDisabled(settings, hostname)),
    count,
    tabId: tab?.id ?? null,
    lists: ADBLOCK_LISTS,
    enabledRulesets: await chrome.declarativeNetRequest.getEnabledRulesets(),
  };
}

async function toggleGlobal() {
  const settings = await loadSettings();
  settings.enabled = !settings.enabled;
  setCachedSettings(settings);
  await saveSettings(settings);
  const result = await applyAll();
  return { ...(await getTabState()), ...result };
}

async function toggleSite(hostname) {
  if (!hostname || !isValidDomain(hostname)) {
    return { ok: false, error: "当前页面不支持网站级开关。" };
  }
  const settings = await loadSettings();
  const disabled = new Set(settings.disabledSites);
  if (disabled.has(hostname)) disabled.delete(hostname);
  else disabled.add(hostname);
  settings.disabledSites = [...disabled].slice(0, MAX_DISABLED_SITES);
  setCachedSettings(settings);
  await saveSettings(settings);
  clearCosmeticCache();
  const result = await syncDynamicRules(settings);
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id) await clearCount(tab.id);
  }
  return { ...(await getTabState()), ...result };
}

async function saveFromOptions(payload) {
  const current = await loadSettings();
  const next = {
    enabled: typeof payload.enabled === "boolean" ? payload.enabled : current.enabled,
    lists: { ...current.lists },
    disabledSites: current.disabledSites,
    customFilters: current.customFilters,
    customCosmetic: current.customCosmetic,
  };

  if (payload.lists && typeof payload.lists === "object") {
    for (const list of ADBLOCK_LISTS) {
      if (typeof payload.lists[list.id] === "boolean") next.lists[list.id] = payload.lists[list.id];
    }
  }

  if (Array.isArray(payload.disabledSites)) {
    next.disabledSites = [...new Set(
      payload.disabledSites
        .map((site) => String(site).trim().toLowerCase())
        .filter(isValidDomain),
    )].slice(0, MAX_DISABLED_SITES);
  }

  if (typeof payload.customFilters === "string") {
    next.customFilters = payload.customFilters.slice(0, 200_000);
  }

  if (Array.isArray(payload.customCosmetic)) {
    next.customCosmetic = payload.customCosmetic
      .filter((entry) => entry && isSafeSelector(entry.selector))
      .map((entry) => ({
        domain: String(entry.domain || "").toLowerCase(),
        selector: entry.selector,
      }))
      .filter((entry) => !entry.domain || isValidDomain(entry.domain))
      .slice(0, 5000);
  }

  setCachedSettings(next);
  await saveSettings(next);
  const result = await applyAll();
  return { ...(await getOptionsState()), ...result };
}

async function getOptionsState() {
  const settings = await loadSettings();
  let stats = null;
  try {
    const response = await fetch(chrome.runtime.getURL("rules/stats.json"));
    if (response.ok) stats = await response.json();
  } catch {
    stats = null;
  }
  return {
    ok: true,
    settings,
    lists: ADBLOCK_LISTS,
    stats,
    enabledRulesets: await chrome.declarativeNetRequest.getEnabledRulesets(),
  };
}

function isSafeSelector(selector) {
  return (
    typeof selector === "string" &&
    selector.length > 0 &&
    selector.length <= 500 &&
    !/[{}<>\r\n]/.test(selector)
  );
}

async function addCustomCosmetic(selector, hostname) {
  if (!isSafeSelector(selector)) {
    return { ok: false, error: "选择器无效。" };
  }
  const settings = await loadSettings();
  const domain = hostname && isValidDomain(hostname) ? hostname : "";
  const exists = settings.customCosmetic.some(
    (entry) => entry.selector === selector && entry.domain === domain,
  );
  if (!exists) {
    settings.customCosmetic.push({ domain, selector });
    settings.customCosmetic = settings.customCosmetic.slice(-5000);
    setCachedSettings(settings);
    await saveSettings(settings);
    clearCosmeticCache();
  }
  return { ok: true };
}

chrome.runtime.onInstalled.addListener(() => {
  scheduleApply();
});

chrome.runtime.onStartup.addListener(() => {
  scheduleApply();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" || changeInfo.url) {
    clearCount(tabId).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  counts.delete(tabId);
  chrome.storage.session.remove(`count_${tabId}`).catch(() => {});
});

if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
    if (info?.request?.tabId >= 0) recordMatch(info.request.tabId);
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message?.type) {
        case "getState":
          sendResponse(await getTabState());
          break;
        case "toggleGlobal":
          sendResponse(await toggleGlobal());
          break;
        case "toggleSite":
          sendResponse(await toggleSite(String(message.hostname || "").toLowerCase()));
          break;
        case "getCosmetic": {
          const hostname = String(message.hostname || "").toLowerCase();
          const settings = await loadSettings();
          const allowGeneric = settings.enabled && !siteIsDisabled(settings, hostname);
          const css = hostname && allowGeneric ? await getCosmeticCSS(hostname) : "";
          sendResponse({ ok: true, css, allowGeneric });
          break;
        }
        case "startPicker": {
          let tabId = sender.tab?.id;
          if (!tabId) {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            tabId = tab?.id;
          }
          if (!tabId) {
            sendResponse({ ok: false, error: "无法定位当前标签页。" });
            break;
          }
          await chrome.tabs.sendMessage(tabId, { type: "startPicker" });
          sendResponse({ ok: true });
          break;
        }
        case "addCosmetic": {
          let hostname = "";
          try {
            hostname = new URL(sender.tab?.url || "").hostname;
          } catch {
            hostname = "";
          }
          sendResponse(await addCustomCosmetic(message.selector, hostname));
          break;
        }
        case "getOptions":
          sendResponse(await getOptionsState());
          break;
        case "saveSettings":
          sendResponse(await saveFromOptions(message.settings || {}));
          break;
        case "openOptions":
          chrome.runtime.openOptionsPage();
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: "未知消息。" });
      }
    } catch (err) {
      console.error("AdBlock Mini message error", err);
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();
  return true;
});

scheduleApply();
