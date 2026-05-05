---
title: Bluesky 连接器
sidebarTitle: Bluesky
description: 使用 @elizaos/plugin-bluesky 包将你的代理连接到 Bluesky。
---

将你的代理连接到 Bluesky，在 AT 协议网络上进行社交发布和互动。

<div id="overview">

## 概述

</div>

Bluesky 连接器是一个 elizaOS 插件，通过 AT 协议将你的代理桥接到 Bluesky。它支持自动发布、提及监控和回复处理。

与 18 个自动启用的连接器（Discord、Telegram 等）不同，Bluesky 是一个**注册表插件**，必须在使用前手动安装。仅靠连接器配置不会自动启用它。

<div id="package-info">

## 包信息

</div>

| 字段 | 值 |
|------|----|
| 包 | `@elizaos/plugin-bluesky` |
| 配置键 | `connectors.bluesky` |
| 安装 | `eliza plugins install @elizaos/plugin-bluesky` |

<div id="setup-requirements">

## 设置要求

</div>

- Bluesky 账户凭据（handle 和应用密码）
- 在 [bsky.app/settings/app-passwords](https://bsky.app/settings/app-passwords) 生成应用密码

<div id="configuration">

## 配置

</div>

```json
{
  "connectors": {
    "bluesky": {
      "enabled": true,
      "postEnable": true,
      "postIntervalMin": 90,
      "postIntervalMax": 180
    }
  }
}
```

<div id="environment-variables">

## 环境变量

</div>

| 变量 | 描述 |
|------|------|
| `BLUESKY_USERNAME` | Bluesky 用户名/邮箱 |
| `BLUESKY_PASSWORD` | 应用密码（不是你的主密码） |
| `BLUESKY_HANDLE` | Bluesky handle（例如 `yourname.bsky.social`） |
| `BLUESKY_ENABLED` | 设置为 `true` 以启用 |
| `BLUESKY_DRY_RUN` | 设置为 `true` 以测试而不发布 |

<div id="features">

## 功能

</div>

- 以可配置的间隔创建帖子
- 提及和回复监控
- 测试模式（不实际发布）
- 基于 AT 协议的去中心化社交网络

<div id="related">

## 相关内容

</div>

- [连接器概述](/zh/guides/connectors#bluesky)
