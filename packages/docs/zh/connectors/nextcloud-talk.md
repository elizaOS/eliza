---
title: Nextcloud Talk 连接器
sidebarTitle: Nextcloud Talk
description: 使用 @elizaos/plugin-nextcloud-talk 包将你的代理连接到 Nextcloud Talk。
---

将你的代理连接到 Nextcloud Talk，进行自托管协作消息。

<div id="overview">

## 概述

</div>

Nextcloud Talk 连接器是一个 elizaOS 插件，将你的代理桥接到 Nextcloud Talk 房间。它支持自托管 Nextcloud 实例上的私信和群组对话。此连接器可从插件注册表获取。

<div id="package-info">

## 包信息

</div>

| 字段 | 值 |
|------|----|
| 包 | `@elizaos/plugin-nextcloud-talk` |
| 配置键 | `connectors.nextcloud-talk` |
| 安装 | `eliza plugins install @elizaos/plugin-nextcloud-talk` |

<div id="setup-requirements">

## 设置要求

</div>

- 启用了 Talk 应用的 Nextcloud 实例
- 用于 Webhook 身份验证的 Bot 密钥（在 Nextcloud Talk 管理设置中配置）
- Webhook 端点的公开可访问 URL

<div id="configuration">

## 配置

</div>

```json
{
  "connectors": {
    "nextcloud-talk": {
      "enabled": true
    }
  }
}
```

<div id="environment-variables">

## 环境变量

</div>

| 变量 | 必需 | 描述 |
|------|------|------|
| `NEXTCLOUD_URL` | 是 | Nextcloud 实例的基本 URL（例如 `https://cloud.example.com`） |
| `NEXTCLOUD_BOT_SECRET` | 是 | 用于 Webhook 签名验证的 Bot 密钥 |
| `NEXTCLOUD_WEBHOOK_HOST` | 否 | Webhook 监听器的主机地址 |
| `NEXTCLOUD_WEBHOOK_PORT` | 否 | Webhook 监听器的端口 |
| `NEXTCLOUD_WEBHOOK_PATH` | 否 | Webhook 端点的路径 |
| `NEXTCLOUD_WEBHOOK_PUBLIC_URL` | 否 | Webhook 的完整公开 URL（覆盖 host/port/path） |
| `NEXTCLOUD_ALLOWED_ROOMS` | 否 | 以逗号分隔的房间/频道 ID 列表 |
| `NEXTCLOUD_ENABLED` | 否 | 设为 `true` 以启用（配置的替代方式） |

```json
{
  "connectors": {
    "nextcloud-talk": {
      "enabled": true
    }
  },
  "env": {
    "NEXTCLOUD_URL": "https://cloud.example.com",
    "NEXTCLOUD_BOT_SECRET": "YOUR_BOT_SECRET",
    "NEXTCLOUD_WEBHOOK_PUBLIC_URL": "https://your-agent.example.com/hooks/nextcloud",
    "NEXTCLOUD_ALLOWED_ROOMS": "general,support"
  }
}
```

<div id="features">

## 功能

</div>

- 基于 Talk 房间的消息
- 支持私信和群组对话
- 基于 Webhook 的消息传递，带签名验证
- 房间白名单，控制代理参与的对话
- 自托管 — 所有数据保留在你的 Nextcloud 实例上

<div id="related">

## 相关内容

</div>

- [连接器概述](/zh/guides/connectors#nextcloud-talk)
