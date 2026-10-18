const $ = (id) => document.getElementById(id);

let state = null;
let cosmetic = [];
let busy = false;

function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function setStatus(text, kind = "") {
  const status = $("status");
  status.textContent = text || "";
  status.className = `bar-status ${kind}`.trim();
}

function renderLists() {
  const container = $("lists");
  container.textContent = "";
  for (const list of ADBLOCK_LISTS || []) {
    const label = document.createElement("label");
    label.className = "list-item";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.listId = list.id;
    checkbox.checked = Boolean(state.settings.lists[list.id]);

    const text = document.createElement("div");
    const name = document.createElement("div");
    name.className = "list-name";
    name.textContent = list.name;
    const desc = document.createElement("div");
    desc.className = "list-desc";
    desc.textContent = list.description;
    const count = document.createElement("div");
    count.className = "list-count";
    count.textContent = `${(list.ruleCount || 0).toLocaleString()} 条网络规则`;
    text.append(name, desc, count);

    label.append(checkbox, text);
    container.appendChild(label);
  }
}

function renderCosmetic() {
  const container = $("customCosmetic");
  container.textContent = "";
  if (!cosmetic.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "还没有元素隐藏规则。打开任意网页，点击扩展图标 →“拦截元素”。";
    container.appendChild(empty);
    return;
  }
  cosmetic.forEach((entry, index) => {
    const row = document.createElement("div");
    row.className = "cosmetic-item";
    const domain = document.createElement("span");
    domain.className = "domain";
    domain.textContent = entry.domain || "所有网站";
    const selector = document.createElement("span");
    selector.className = "selector";
    selector.textContent = entry.selector;
    selector.title = entry.selector;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "删除";
    remove.addEventListener("click", () => {
      cosmetic.splice(index, 1);
      renderCosmetic();
    });
    row.append(domain, selector, remove);
    container.appendChild(row);
  });
}

function renderStats() {
  const stats = state.stats;
  const hero = $("heroStats");
  hero.textContent = "";
  const values = stats
    ? [
        [stats.totalNetworkRules, "网络规则"],
        [stats.totalCosmeticSelectors, "隐藏选择器"],
        [(state.enabledRulesets || []).length, "已启用规则集"],
      ]
    : [
        [(ADBLOCK_LISTS || []).reduce((sum, list) => sum + (list.ruleCount || 0), 0), "网络规则"],
        [(state.enabledRulesets || []).length, "已启用规则集"],
      ];
  for (const [value, label] of values) {
    const wrap = document.createElement("div");
    const b = document.createElement("b");
    b.textContent = Number(value || 0).toLocaleString();
    const span = document.createElement("span");
    span.textContent = label;
    wrap.append(b, span);
    hero.appendChild(wrap);
  }

  const container = $("stats");
  container.textContent = "";
  if (!stats) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "规则统计不可用。请确认 rules/stats.json 存在。";
    container.appendChild(empty);
    return;
  }
  const items = [
    [stats.totalNetworkRules, "网络拦截规则"],
    [stats.totalCosmeticSelectors, "元素隐藏选择器"],
    [stats.domainSelectors, "按域名生效的选择器"],
    [stats.genericSelectors, "全局选择器"],
    [stats.regexRules, "正则规则"],
    [(state.enabledRulesets || []).length, "已启用规则集"],
  ];
  for (const [value, label] of items) {
    const box = document.createElement("div");
    box.className = "stat";
    const b = document.createElement("b");
    b.textContent = Number(value || 0).toLocaleString();
    const span = document.createElement("span");
    span.textContent = label;
    box.append(b, span);
    container.appendChild(box);
  }
}

function render() {
  renderLists();
  $("customFilters").value = state.settings.customFilters || "";
  $("disabledSites").value = (state.settings.disabledSites || []).join("\n");
  cosmetic = (state.settings.customCosmetic || []).map((entry) => ({ ...entry }));
  renderCosmetic();
  renderStats();
}

function collectPayload() {
  const lists = {};
  for (const checkbox of document.querySelectorAll("#lists input[data-list-id]")) {
    lists[checkbox.dataset.listId] = checkbox.checked;
  }
  const disabledSites = $("disabledSites").value
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);
  return {
    enabled: Boolean(state.settings.enabled),
    lists,
    disabledSites,
    customFilters: $("customFilters").value,
    customCosmetic: cosmetic,
  };
}

async function save(payload = collectPayload(), message = "设置已保存。") {
  if (busy) return;
  busy = true;
  $("save").disabled = true;
  setStatus("正在应用规则…");
  try {
    const response = await send({ type: "saveSettings", settings: payload });
    if (!response?.ok) throw new Error(response?.error || "保存失败");
    state = response;
    render();
    const warnings = [
      ...(response.dynamicErrors || []),
      response.staticWarning,
    ].filter(Boolean);
    if (warnings.length) {
      setStatus(warnings[0], "error");
    } else {
      setStatus(message, "ok");
    }
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    busy = false;
    $("save").disabled = false;
  }
}

$("save").addEventListener("click", () => save());

document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    save();
  }
});

$("export").addEventListener("click", () => {
  const payload = collectPayload();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "adblock-mini-settings.json";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus("设置已导出。", "ok");
});

$("import").addEventListener("click", () => $("importFile").click());

$("importFile").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (!parsed || typeof parsed !== "object") throw new Error("文件格式不正确。");
    const payload = {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : Boolean(state.settings.enabled),
      lists: parsed.lists && typeof parsed.lists === "object" ? parsed.lists : state.settings.lists,
      disabledSites: Array.isArray(parsed.disabledSites) ? parsed.disabledSites : [],
      customFilters: typeof parsed.customFilters === "string" ? parsed.customFilters : "",
      customCosmetic: Array.isArray(parsed.customCosmetic) ? parsed.customCosmetic : [],
    };
    await save(payload, "设置已导入并保存。");
  } catch (error) {
    setStatus(`导入失败：${error.message}`, "error");
  }
});

async function load() {
  try {
    const response = await send({ type: "getOptions" });
    if (!response?.ok) throw new Error(response?.error || "读取设置失败");
    state = response;
    render();
    setStatus("就绪。");
  } catch (error) {
    setStatus(`扩展未就绪：${error.message}`, "error");
  }
}

load();
