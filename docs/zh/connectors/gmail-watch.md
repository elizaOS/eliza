---
title: Gmail Watch 连接器
sidebarTitle: Gmail Watch
description: 使用 @elizaos/plugin-gmail-watch 包监控 Gmail 收件箱。
---

使用 Pub/Sub 监控 Gmail 收件箱中的传入消息。

<div id="overview">

## 概述

</div>

Gmail Watch 连接器是一个 elizaOS 插件，通过 Google Cloud Pub/Sub 监控 Gmail 收件箱。它监视新消息并触发代理事件。此连接器通过功能标志而非 `connectors` 部分启用。可从插件注册表获取。

<div id="package-info">

## 包信息

</div>

| 字段 | 值 |
|------|----|
| 包 | `@elizaos/plugin-gmail-watch` |
| 功能标志 | `features.gmailWatch` |
| 安装 | `eliza plugins install @elizaos/plugin-gmail-watch` |

<div id="setup-requirements">

## 设置要求

</div>

- Google Cloud 服务账户或具有 Gmail API 访问权限的 OAuth 凭据
- 为 Gmail 推送通知配置的 Pub/Sub 主题

<div id="configuration">

## 配置

</div>

Gmail Watch 在 `eliza.json` 中的两个位置进行配置：

### 1. 通过功能标志启用

```json
{
  "features": {
    "gmailWatch": true
  }
}
```

### 2. 在 hooks 中配置 Gmail 账户

```json
{
  "hooks": {
    "gmail": {
      "account": "user@gmail.com",
      "label": "INBOX",
      "includeBody": true
    }
  }
}
```

### 完整示例

```json
{
  "features": {
    "gmailWatch": true
  },
  "hooks": {
    "enabled": true,
    "gmail": {
      "account": "user@gmail.com",
      "label": "INBOX",
      "includeBody": true
    }
  }
}
```

### Gmail 配置字段

| 字段 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `account` | string | — | 要监控的 Gmail 地址（必需） |
| `label` | string | `"INBOX"` | 要监视的 Gmail 标签 |
| `includeBody` | boolean | `false` | 在代理事件中包含邮件正文内容 |

<div id="features">

## 功能

</div>

- 通过 Pub/Sub 监视 Gmail 消息
- 自动续订监视订阅
- 传入邮件事件处理
- 标签过滤，实现收件箱的定向监控

<div id="related">

## 相关内容

</div>

- [连接器概述](/zh/guides/connectors#gmail-watch)
