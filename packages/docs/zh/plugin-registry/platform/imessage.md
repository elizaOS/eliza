---
title: "iMessage 插件"
sidebarTitle: "iMessage"
description: "Eliza 的 iMessage 连接器 — macOS 原生消息传递，支持 iMessage 和短信、数据库访问及远程主机连接。"
---

iMessage 插件将 Eliza 代理连接到 macOS 上的 iMessage，支持 iMessage 和短信对话，具有可配置的服务选择和附件处理功能。

**包：** `@elizaos/plugin-imessage`

<div id="installation">
## 安装
</div>

```bash
eliza plugins install @elizaos/plugin-imessage
```

<div id="setup">
## 设置
</div>

<div id="1-prerequisites">
### 1. 先决条件
</div>

- 已配置并登录 iMessage 的 macOS
- 已向运行 Eliza 的终端或应用程序授予完全磁盘访问权限（用于访问聊天数据库）

<div id="2-configure-eliza">
### 2. 配置 Eliza
</div>

```json
{
  "connectors": {
    "imessage": {
      "enabled": true,
      "service": "auto",
      "dmPolicy": "pairing"
    }
  }
}
```

<div id="configuration">
## 配置
</div>

| 字段 | 必需 | 描述 |
|------|------|------|
| `service` | 否 | 服务类型：`imessage`、`sms` 或 `auto`（默认：`auto`） |
| `cliPath` | 否 | iMessage CLI 工具路径 |
| `dbPath` | 否 | iMessage 数据库路径 |
| `remoteHost` | 否 | 用于 SSH 访问的远程主机 |
| `region` | 否 | 区域配置 |
| `includeAttachments` | 否 | 在消息中包含附件（默认：`true`） |
| `dmPolicy` | 否 | 私信处理策略 |

<div id="features">
## 功能
</div>

- **服务选择** — 在 iMessage、短信或自动检测之间选择
- **数据库访问** — 直接访问 macOS iMessage 数据库以获取消息历史
- **远程主机** — 通过 SSH 连接到远程 Mac 上的 iMessage
- **附件** — 发送和接收多媒体附件
- **按组配置** — 按组配置提及要求和工具访问权限
- **多账户** — 通过 `accounts` 映射支持多个账户

<div id="auto-enable">
## 自动启用
</div>

当 `connectors.imessage` 块存在时，插件会自动启用：

```json
{
  "connectors": {
    "imessage": {
      "enabled": true
    }
  }
}
```

<div id="troubleshooting">
## 故障排除
</div>

<div id="full-disk-access">
### 完全磁盘访问
</div>

如果消息检索失败，请确保已授予完全磁盘访问权限：

1. 打开 **系统设置 → 隐私与安全 → 完全磁盘访问**
2. 添加终端应用程序或 Eliza 进程

<div id="database-path">
### 数据库路径
</div>

默认的 iMessage 数据库位于 `~/Library/Messages/chat.db`。如果使用非标准位置，请显式设置 `dbPath`。

<div id="related">
## 相关链接
</div>

- [Signal 插件](/zh/plugin-registry/platform/signal) — Signal 消息集成
- [连接器指南](/zh/guides/connectors) — 通用连接器文档
