---
title: "Nextcloud Talk 插件"
sidebarTitle: "Nextcloud Talk"
description: "Eliza 的 Nextcloud Talk 连接器 — 与 Nextcloud Talk 聊天的机器人集成。"
---

Nextcloud Talk 插件将 Eliza 代理连接到 Nextcloud Talk，实现 Nextcloud Talk 对话中的消息处理。

**Package:** `@elizaos/plugin-nextcloud-talk`

<div id="installation">

## 安装

</div>

```bash
eliza plugins install @elizaos/plugin-nextcloud-talk
```

<div id="setup">

## 设置

</div>

<div id="1-configure-your-nextcloud-instance">

### 1. 配置你的 Nextcloud 实例

</div>

1. 确保 Nextcloud Talk 已在你的 Nextcloud 实例上安装并启用
2. 创建一个机器人用户或使用现有账户作为代理
3. 记下 Nextcloud 服务器 URL 和凭据

<div id="2-configure-eliza">

### 2. 配置 Eliza

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

<div id="configuration">

## 配置

</div>

| 字段 | 必填 | 描述 |
|------|------|------|
| `connectors.nextcloud-talk` | 是 | Nextcloud Talk 的配置块 |
| `enabled` | 否 | 设置为 `false` 以禁用（默认：`true`） |

```json
{
  "connectors": {
    "nextcloud-talk": {
      "enabled": true
    }
  }
}
```

<div id="related">

## 相关内容

</div>

- [连接器指南](/zh/guides/connectors) — 连接器通用文档
