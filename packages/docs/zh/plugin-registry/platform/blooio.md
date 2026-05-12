---
title: "Blooio 插件"
sidebarTitle: "Blooio"
description: "Eliza 的 Blooio 连接器 — 通过 Blooio 桥接服务使用签名 webhook 进行 iMessage 和短信通讯。"
---

Blooio 插件通过 Blooio 服务将 Eliza 代理连接到 iMessage 和短信通讯。入站消息通过签名 webhook 传递以确保安全性。

**包：** `@elizaos/plugin-blooio`

<div id="installation">
## 安装
</div>

```bash
eliza plugins install @elizaos/plugin-blooio
```

<div id="setup">
## 设置
</div>

<div id="1-get-blooio-credentials">
### 1. 获取 Blooio 凭证
</div>

从你的 Blooio 账户获取 API 密钥。

<div id="2-configure-eliza">
### 2. 配置 Eliza
</div>

```json
{
  "connectors": {
    "blooio": {
      "enabled": true,
      "apiKey": "YOUR_BLOOIO_API_KEY",
      "webhookUrl": "https://your-domain.com/blooio/webhook"
    }
  }
}
```

或使用环境变量：

```bash
export BLOOIO_API_KEY=your-blooio-api-key
export BLOOIO_WEBHOOK_URL=https://your-domain.com/blooio/webhook
```

<div id="auto-enable">
## 自动启用
</div>

当连接器配置中存在 `apiKey`、`token` 或 `botToken` 时，插件会自动启用。

<div id="configuration">
## 配置
</div>

| 变量 | 必需 | 描述 |
|------|------|------|
| `apiKey` | 是 | Blooio 平台 API 密钥 |
| `webhookUrl` | 否 | 用于接收入站消息的公共 URL |

<div id="features">
## 功能
</div>

- 通过 Blooio 桥接进行 iMessage 和短信通讯
- 签名 webhook 验证以确保入站消息安全
- 出站消息发送
- 会话管理和消息路由

<div id="related">
## 相关链接
</div>

- [iMessage 插件](/zh/plugin-registry/platform/imessage) — macOS 原生 iMessage（无需桥接）
- [连接器指南](/zh/guides/connectors#blooio) — 完整配置参考
