const $ = (id) => document.getElementById(id);

let current = null;
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

function totalRuleCount() {
  return (ADBLOCK_LISTS || []).reduce((sum, list) => sum + (list.ruleCount || 0), 0);
}

function render(state) {
  current = state;
  const settings = state.settings || {};
  const enabled = Boolean(settings.enabled);
  const hostname = state.hostname;

  document.body.classList.toggle("off", !enabled);
  $("globalToggle").checked = enabled;
  $("globalLabel").textContent = enabled ? "全局拦截已开启" : "全局拦截已关闭";

  $("siteSection").hidden = !hostname;
  if (hostname) {
    $("siteHost").textContent = hostname;
    $("siteToggle").checked = !state.siteDisabled;
    $("siteToggle").disabled = !enabled;
    $("siteState").textContent = !enabled
      ? "全局已关闭"
      : state.siteDisabled
        ? "此网站已暂停拦截"
        : "此网站正在拦截";
  }

  $("count").textContent = enabled ? String(state.count || 0) : "—";
  $("status").textContent = !enabled
    ? "打开上方开关以恢复拦截"
    : state.count > 0
      ? "拦截统计来自本标签页已加载的请求"
      : "刷新页面后开始统计";

  const enabledRules = (state.enabledRulesets || []).length;
  $("ruleInfo").textContent = `${totalRuleCount().toLocaleString()} 条网络规则 · ${enabledRules} 个规则集`;

  const warning = state.staticWarning || (state.dynamicErrors || [])[0];
  $("warning").hidden = !warning;
  $("warning").textContent = warning || "";
  $("warning").title = warning || "";
}

async function load() {
  try {
    const state = await send({ type: "getState" });
    if (!state?.ok) throw new Error(state?.error || "读取状态失败");
    render(state);
  } catch (error) {
    $("status").textContent = `扩展未就绪：${error.message}`;
  }
}

$("globalToggle").addEventListener("change", async (event) => {
  if (busy) return;
  busy = true;
  event.target.disabled = true;
  try {
    const response = await send({ type: "toggleGlobal" });
    if (!response?.ok) throw new Error(response?.error || "切换失败");
    render(response);
  } catch (error) {
    $("status").textContent = error.message;
    event.target.checked = current?.settings?.enabled ?? false;
  } finally {
    busy = false;
    event.target.disabled = false;
  }
});

$("siteToggle").addEventListener("change", async (event) => {
  if (busy || !current?.hostname) return;
  busy = true;
  event.target.disabled = true;
  try {
    const response = await send({ type: "toggleSite", hostname: current.hostname });
    if (!response?.ok) throw new Error(response?.error || "切换失败");
    render(response);
  } catch (error) {
    $("status").textContent = error.message;
    event.target.checked = !current?.siteDisabled;
  } finally {
    busy = false;
    event.target.disabled = !current?.settings?.enabled;
  }
});

$("picker").addEventListener("click", async () => {
  try {
    const response = await send({ type: "startPicker" });
    if (!response?.ok) throw new Error(response?.error || "无法启动元素拦截");
    window.close();
  } catch (error) {
    $("status").textContent = error.message;
  }
});

$("options").addEventListener("click", async () => {
  try {
    await chrome.runtime.openOptionsPage();
  } catch {
    // Fallback for builds where options_ui is unavailable.
    chrome.tabs.create({ url: chrome.runtime.getURL("src/options.html") });
  }
  window.close();
});

load();
