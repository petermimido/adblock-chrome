(() => {
  const STYLE_ID = "__adblock_mini_cosmetic";
  let pickerActive = false;

  function injectCSS(css) {
    if (!css) return;
    let attempts = 0;
    const append = () => {
      const root = document.head || document.documentElement;
      if (!root) {
        if (attempts++ < 100) setTimeout(append, 10);
        return;
      }
      let style = document.getElementById(STYLE_ID);
      if (!style) {
        style = document.createElement("style");
        style.id = STYLE_ID;
        root.appendChild(style);
      }
      style.textContent = css;
    };
    append();
  }

  async function applyCosmetic(response) {
    if (!response?.ok) return;
    let css = response.css || "";
    if (response.allowGeneric && window.top === window) {
      try {
        const generic = await fetch(chrome.runtime.getURL("rules/cosmetic-generic.css"));
        if (generic.ok) css = `${await generic.text()}\n${css}`;
      } catch {
        // Domain-specific rules are still useful without the generic sheet.
      }
    }
    if (css) injectCSS(css);
  }

  async function requestCosmetic() {
    if (!location.hostname) return;
    try {
      const response = await chrome.runtime.sendMessage({
        type: "getCosmetic",
        hostname: location.hostname,
      });
      await applyCosmetic(response);
    } catch {
      // The service worker may be starting up; retry once.
      setTimeout(async () => {
        try {
          const response = await chrome.runtime.sendMessage({
            type: "getCosmetic",
            hostname: location.hostname,
          });
          await applyCosmetic(response);
        } catch {
          // Page is shutting down or extension was reloaded.
        }
      }, 150);
    }
  }

  function cssEscape(value) {
    if (window.CSS?.escape) return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
  }

  function uniqueSelector(selector) {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  }

  function buildSelector(element) {
    if (!(element instanceof Element)) return null;
    if (element.id) {
      const byId = `#${cssEscape(element.id)}`;
      if (uniqueSelector(byId)) return byId;
    }

    const parts = [];
    let node = element;
    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement) {
      let part = node.localName;
      if (!part) break;
      if (node.id) {
        part += `#${cssEscape(node.id)}`;
      } else {
        const parent = node.parentElement;
        if (parent) {
          const siblings = [...parent.children].filter(
            (child) => child.localName === node.localName,
          );
          if (siblings.length > 1) {
            part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
          }
        }
      }
      parts.unshift(part);
      const candidate = parts.join(" > ");
      if (uniqueSelector(candidate)) return candidate;
      node = node.parentElement;
      if (parts.length >= 6) break;
    }
    return parts.length ? parts.join(" > ") : null;
  }

  function showToast(text, isError = false) {
    const toast = document.createElement("div");
    toast.textContent = text;
    Object.assign(toast.style, {
      position: "fixed",
      left: "50%",
      bottom: "24px",
      transform: "translateX(-50%)",
      zIndex: "2147483647",
      padding: "10px 14px",
      borderRadius: "8px",
      background: isError ? "#b42318" : "#111827",
      color: "#fff",
      font: "13px/1.4 system-ui, sans-serif",
      boxShadow: "0 8px 30px rgba(0,0,0,.25)",
      pointerEvents: "none",
      maxWidth: "80vw",
    });
    (document.body || document.documentElement).appendChild(toast);
    setTimeout(() => toast.remove(), 2200);
  }

  function startPicker() {
    if (pickerActive) return;
    pickerActive = true;

    const box = document.createElement("div");
    Object.assign(box.style, {
      position: "fixed",
      zIndex: "2147483646",
      border: "2px solid #ff3b30",
      background: "rgba(255,59,48,.12)",
      pointerEvents: "none",
      boxSizing: "border-box",
      transition: "all .05s linear",
      display: "none",
    });

    const label = document.createElement("div");
    Object.assign(label.style, {
      position: "fixed",
      zIndex: "2147483647",
      padding: "4px 8px",
      borderRadius: "6px",
      background: "#111827",
      color: "#fff",
      font: "12px/1.3 ui-monospace, monospace",
      pointerEvents: "none",
      display: "none",
      maxWidth: "80vw",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    });

    document.documentElement.appendChild(box);
    document.documentElement.appendChild(label);

    let hovered = null;

    const update = (event) => {
      const target = document.elementFromPoint(event.clientX, event.clientY);
      if (!target || target === box || target === label) return;
      hovered = target;
      const rect = target.getBoundingClientRect();
      Object.assign(box.style, {
        display: "block",
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
      const selector = buildSelector(target) || target.localName;
      label.textContent = selector;
      label.style.display = "block";
      const labelTop = Math.max(4, rect.top - 26);
      label.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - 320))}px`;
      label.style.top = `${labelTop}px`;
    };

    const onClick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const target = hovered;
      finish();
      if (!target) return;
      if (target === document.documentElement || target === document.body) {
        showToast("不能拦截页面根元素", true);
        return;
      }
      const selector = buildSelector(target);
      if (!selector) {
        showToast("无法生成选择器", true);
        return;
      }
      target.style.setProperty("display", "none", "important");
      chrome.runtime.sendMessage({ type: "addCosmetic", selector }).then((response) => {
        if (response?.ok) showToast(`已拦截：${selector}`);
        else showToast(response?.error || "保存失败", true);
      }).catch(() => showToast("保存失败", true));
    };

    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish();
        showToast("已取消");
      }
    };

    const onScroll = () => {
      Object.assign(box.style, { display: "none" });
      label.style.display = "none";
    };

    function finish() {
      if (!pickerActive) return;
      pickerActive = false;
      document.removeEventListener("mousemove", update, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      box.remove();
      label.remove();
    }

    document.addEventListener("mousemove", update, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    showToast("点击要拦截的元素，按 Esc 取消");
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "startPicker") {
      startPicker();
      sendResponse({ ok: true });
    }
    return false;
  });

  requestCosmetic();
})();
