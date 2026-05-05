---
title: "Bluesky 插件"
sidebarTitle: "Bluesky"
description: "Eliza 的 Bluesky 连接器 — 在 AT 协议网络上发布、回复和互动。"
---

Bluesky 插件通过 AT 协议将 Eliza 代理连接到 Bluesky 社交网络，实现发布、回复和社交互动。

**Package:** `@elizaos/plugin-bluesky`

<div id="installation">

## 安装

</div>

```bash
eliza plugins install @elizaos/plugin-bluesky
```

<div id="setup">

## 设置

</div>

<div id="1-get-your-bluesky-credentials">

### 1. 获取你的 Bluesky 凭据

</div>

1. 前往 [bsky.app](https://bsky.app) 创建账户（或使用现有账户）
2. 记下你的 handle（例如 `yourname.bsky.social`）
3. 使用你的账户用户名和密码（或在设置 → 应用密码中生成应用密码）

<div id="2-configure-eliza">

### 2. 配置 Eliza

</div>

```json
{
  "connectors": {
    "bluesky": {
      "username": "YOUR_USERNAME",
      "password": "YOUR_PASSWORD",
      "handle": "YOUR_HANDLE"
    }
  }
}
```

或通过环境变量：

```bash
export BLUESKY_USERNAME=YOUR_USERNAME
export BLUESKY_PASSWORD=YOUR_PASSWORD
export BLUESKY_HANDLE=YOUR_HANDLE
```

<div id="configuration">

## 配置

</div>

| 字段 | 必填 | 描述 |
|------|------|------|
| `username` | 是 | Bluesky 账户用户名 |
| `password` | 是 | Bluesky 账户密码或应用密码 |
| `handle` | 是 | Bluesky handle（例如 `yourname.bsky.social`） |
| `enabled` | 否 | 设置为 `false` 以禁用（默认：`true`） |

<div id="environment-variables">

## 环境变量

</div>

```bash
export BLUESKY_USERNAME=YOUR_USERNAME
export BLUESKY_PASSWORD=YOUR_PASSWORD
export BLUESKY_HANDLE=YOUR_HANDLE
```

<div id="related">

## 相关内容

</div>

- [连接器指南](/zh/guides/connectors) — 连接器通用文档
