---
title: "Gmail Watch 插件"
sidebarTitle: "Gmail Watch"
description: "Eliza 的 Gmail Watch 连接器 — 监控 Gmail 收件箱并响应传入邮件。"
---

Gmail Watch 插件将 Eliza 代理连接到 Gmail，实现传入邮件监控和自动回复。

**Package:** `@elizaos/plugin-gmail-watch`

<div id="installation">

## 安装

</div>

```bash
eliza plugins install @elizaos/plugin-gmail-watch
```

<div id="setup">

## 设置

</div>

<div id="1-enable-the-feature-flag">

### 1. 启用功能标志

</div>

Gmail Watch 插件通过 Eliza 配置中的 `features.gmailWatch` 标志激活：

```json
{
  "features": {
    "gmailWatch": true
  }
}
```

<div id="2-configure-gmail-api-access">

### 2. 配置 Gmail API 访问

</div>

按照 Google Cloud Console 设置来启用 Gmail API 并为你的代理获取 OAuth 凭据。

<div id="configuration">

## 配置

</div>

| 字段 | 必填 | 描述 |
|------|------|------|
| `features.gmailWatch` | 是 | 设置为 `true` 以启用 Gmail Watch 插件 |

```json
{
  "features": {
    "gmailWatch": true
  }
}
```

<div id="related">

## 相关内容

</div>

- [连接器指南](/zh/guides/connectors) — 连接器通用文档
