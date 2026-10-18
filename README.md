# AdBlock Mini

一个可以直接在 Chrome / Edge 里运行的 Manifest V3 广告与追踪器拦截扩展。规则由 EasyList / EasyPrivacy 在本地构建成 `declarativeNetRequest` 静态规则，加上一套元素隐藏（cosmetic filter）管线。

- 纯 MV3，API 级拦截，不注入页面脚本做网络请求，性能开销低
- 116k+ 条网络规则、94k+ 条元素隐藏选择器（可重新构建）
- 全局开关、网站级白名单、自定义 Adblock 规则、元素拦截器、拦截计数
- 零运行时依赖；构建与测试只需要 Python 3 标准库（测试额外用到 Selenium）





1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）
2. 打开右上角“开发者模式”
3. 点“加载已解压的扩展程序”，选择本目录 `adblock-chrome`
4. 打开一个新闻/视频网站，点扩展图标查看拦截计数

> Chrome 137 起，品牌版 Chrome 忽略命令行 `--load-extension`，但 `chrome://extensions` 的“加载已解压”仍然可用。自动化测试因此默认用 Edge（同为 Chromium）。



## 功能

- **网络拦截**：EasyList（广告）、EasyPrivacy（追踪器），可选 Fanboy Annoyances（Cookie 提示/社交按钮）
- **元素隐藏**：通用 + 按域名的 CSS 选择器，支持 `#@#` 例外，跟随全局/网站白名单一起关闭
- **自定义规则**：Adblock 语法，支持 `||domain^`、`*`、`^`、`$third-party`、类型选项、`$domain=`、`$important`、`@@` 例外、正则（运行时校验）
- **网站白名单**：弹窗一键暂停当前网站，或在设置里维护列表
- **元素拦截器**：弹窗点“拦截元素”，在页面上点选要隐藏的元素，自动生成选择器
- **计数徽章**：未打包加载时通过 `onRuleMatchedDebug` 统计每标签页拦截数
- **导入/导出**：设置 JSON 备份



## 限制

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
