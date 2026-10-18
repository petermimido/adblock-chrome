# AdBlock Mini

一个可以直接在 Chrome / Edge 里运行的 Manifest V3 广告与追踪器拦截扩展。规则由 EasyList / EasyPrivacy 在本地构建成 `declarativeNetRequest` 静态规则，加上一套元素隐藏（cosmetic filter）管线。

- 纯 MV3，API 级拦截，不注入页面脚本做网络请求，性能开销低
- 116k+ 条网络规则、94k+ 条元素隐藏选择器（可重新构建）
- 全局开关、网站级白名单、自定义 Adblock 规则、元素拦截器、拦截计数
- 零运行时依赖；构建与测试只需要 Python 3 标准库（测试额外用到 Selenium）



## 快速开始

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）
2. 打开右上角“开发者模式”
3. 点“加载已解压的扩展程序”，选择本目录 `adblock-chrome`
4. 打开一个新闻/视频网站，点扩展图标查看拦截计数

> Chrome 137 起，品牌版 Chrome 忽略命令行 `--load-extension`，但 `chrome://extensions` 的“加载已解压”仍然可用。自动化测试因此默认用 Edge（同为 Chromium）。

想直接用成熟方案：

```powershell
py -3 tools/fetch_ubol.py
# 然后在 chrome://extensions 加载 alternatives/ubol
```

## 功能

- **网络拦截**：EasyList（广告）、EasyPrivacy（追踪器），可选 Fanboy Annoyances（Cookie 提示/社交按钮）
- **元素隐藏**：通用 + 按域名的 CSS 选择器，支持 `#@#` 例外，跟随全局/网站白名单一起关闭
- **自定义规则**：Adblock 语法，支持 `||domain^`、`*`、`^`、`$third-party`、类型选项、`$domain=`、`$important`、`@@` 例外、正则（运行时校验）
- **网站白名单**：弹窗一键暂停当前网站，或在设置里维护列表
- **元素拦截器**：弹窗点“拦截元素”，在页面上点选要隐藏的元素，自动生成选择器
- **计数徽章**：未打包加载时通过 `onRuleMatchedDebug` 统计每标签页拦截数
- **导入/导出**：设置 JSON 备份

## 目录结构

```
adblock-chrome/
├─ manifest.json              # MV3 清单（rule_resources 由构建脚本写入）
├─ src/
│  ├─ background.js           # Service Worker：规则开关、动态规则、计数、元素隐藏 CSS
│  ├─ content.js              # 元素隐藏注入 + 元素拦截器
│  ├─ popup.html/.css/.js     # 弹窗
│  ├─ options.html/.css/.js   # 设置页
│  └─ generated.js            # 构建产物：过滤列表元数据（勿手改）
├─ rules/                     # 构建产物
│  ├─ easylist_0..2.json      # 网络规则，每个规则集 < 25000 条
│  ├─ easyprivacy_0..2.json
│  ├─ annoyances_0.json
│  ├─ cosmetic-generic.css    # 通用元素隐藏样式
│  ├─ cosmetic-domains.json   # 按域名/例外映射
│  └─ stats.json
├─ icons/
├─ tools/
│  ├─ build_rules.py          # 下载过滤列表 -> 生成 DNR 规则与 CSS
│  ├─ make_icons.py           # 生成图标 PNG
│  ├─ fetch_ubol.py           # 下载官方 uBOL 构建
│  └─ test_extension.py       # Selenium 冒烟测试
└─ alternatives/ubol/         # tools/fetch_ubol.py 下载的官方 uBOL（可选）
```

## 重建规则

```powershell
py -3 tools/build_rules.py            # 使用 tools/cache 里的列表缓存
py -3 tools/build_rules.py --refresh  # 重新下载 EasyList / EasyPrivacy / Annoyances
py -3 tools/make_icons.py             # 重新生成图标
```

构建脚本会：

1. 解析 Adblock 网络规则，转换为 `declarativeNetRequest` 规则（`urlFilter` / `regexFilter` / 类型 / 第三方 / 域名限定）
2. 生成 `@@` 例外为高优先级 `allow` 规则
3. 解析元素隐藏规则，输出通用 CSS 与按域名映射（含例外）
4. 按 25000 条切分规则集，更新 `manifest.json` 的 `rule_resources` 与 `src/generated.js`
5. 重新加载扩展使其生效

## 测试

```powershell
py -3 -m pip install selenium
py -3 tools/test_extension.py
$env:ADBLOCK_TEST_BROWSER="chrome"; py -3 tools/test_extension.py   # 可选
```

测试会起一个本地 HTTP 服务，验证：EasyList 拦截、元素隐藏、通用 CSS 不影响正常内容、自定义规则生效、全局开关、网站白名单，以及所有内置正则都能被 `isRegexSupported` 接受。

## 设计要点

- **为什么不用 `webRequest`**：MV3 不再允许阻塞式 `webRequest`；`declarativeNetRequest` 由浏览器在网络栈里执行，扩展完全看不到请求内容，隐私和性能都更好。
- **规则集分片**：Chrome 每个静态规则集上限 30000 条，全局配额按其他扩展占用浮动。每个列表切成多个 <25000 条的规则集；清单里只默认开启第一片，Service Worker 启动时根据 `getAvailableStaticRuleCount()` 逐个补齐，配额不足时保留核心规则并提示。
- **网站白名单**：用 `allowAllRequests` 动态规则，`urlFilter: "||host^"` + `priority: 1000000`，命中后该框架层级内的请求全部放行；全局关闭也用同一种规则实现即时生效，同时关闭静态规则集。
- **元素隐藏**：通用 CSS 只在顶层框架按需 `fetch` 后注入，避免每个 iframe 解析 40k 选择器；按域名的选择器由 Service Worker 按域名后缀匹配后返回。
- **正则规则**：Chrome 的 RE2 会以 `memoryLimitExceeded` 拒绝不少常见 Adblock 正则，因此内置规则默认跳过正则（仅损失十几条），用户自定义正则会先通过 `isRegexSupported` 校验。

## 已知限制

- 不支持 `$popup`、`$redirect`、`$removeparam`、`$csp`、scriptlet（`+js(...)`）等 MV3 DNR 无法表达的规则；这些在构建时被跳过而不是近似转换，避免误杀
- 不支持 `#?#` 过程式选择器、`#$#` 样式注入、`#%#` scriptlet
- 拦截计数依赖 `declarativeNetRequestFeedback`，该权限只在“未打包加载”时可用；打包上架后计数会显示 0
- 规则是构建时固化的，更新列表需要重新运行 `build_rules.py` 并重载扩展（没有在线更新器）
- 通用元素隐藏只在顶层框架注入；iframe 内依赖按域名规则和网络拦截
- 网站白名单按当前 hostname 记录，`www.example.com` 与 `example.com` 视为两个条目

## 许可

- 扩展代码：GPL-3.0-or-later（见 `LICENSE`）
- 过滤列表：EasyList / EasyPrivacy / Fanboy Annoyances 均为 GPLv3，`rules/` 下由它们派生的规则同样按 GPLv3 分发
- `alternatives/ubol` 是 uBlock Origin Lite 官方构建，版权归其作者，遵循其自身的 GPLv3 许可
