---
title: "Zalo 插件"
sidebarTitle: "Zalo"
description: "Eliza 的 Zalo 连接器 — 与 Zalo 消息平台的机器人集成。"
---

Zalo 插件将 Eliza 代理连接到 Zalo，实现通过 Zalo 官方账号 API 的消息处理。

**Package:** `@elizaos/plugin-zalo`

<div id="installation">

## 安装

</div>

```bash
eliza plugins install @elizaos/plugin-zalo
```

<div id="setup">

## 设置

</div>

<div id="1-create-a-zalo-official-account">

### 1. 创建 Zalo 官方账号

</div>

1. 前往 [Zalo 开发者门户](https://developers.zalo.me/)
2. 创建应用并获取你的 App ID 和 App Secret
3. 生成访问令牌和刷新令牌以访问 API

<div id="2-configure-eliza">

### 2. 配置 Eliza

</div>

```json
{
  "connectors": {
    "zalo": {
      "accessToken": "YOUR_ACCESS_TOKEN",
      "refreshToken": "YOUR_REFRESH_TOKEN",
      "appId": "YOUR_APP_ID",
      "appSecret": "YOUR_APP_SECRET"
    }
  }
}
```

或通过环境变量：

```bash
export ZALO_ACCESS_TOKEN=YOUR_ACCESS_TOKEN
export ZALO_REFRESH_TOKEN=YOUR_REFRESH_TOKEN
export ZALO_APP_ID=YOUR_APP_ID
export ZALO_APP_SECRET=YOUR_APP_SECRET
```

<div id="configuration">

## 配置

</div>

| 字段 | 必填 | 描述 |
|------|------|------|
| `accessToken` | 是 | Zalo API 访问令牌 |
| `refreshToken` | 是 | Zalo API 刷新令牌 |
| `appId` | 是 | Zalo 应用 ID |
| `appSecret` | 是 | Zalo 应用密钥 |
| `enabled` | 否 | 设置为 `false` 以禁用（默认：`true`） |

<div id="environment-variables">

## 环境变量

</div>

```bash
export ZALO_ACCESS_TOKEN=YOUR_ACCESS_TOKEN
export ZALO_REFRESH_TOKEN=YOUR_REFRESH_TOKEN
export ZALO_APP_ID=YOUR_APP_ID
export ZALO_APP_SECRET=YOUR_APP_SECRET
```

<div id="related">

## 相关内容

</div>

- [连接器指南](/zh/guides/connectors) — 连接器通用文档
