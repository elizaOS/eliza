---
title: "LINE 插件"
sidebarTitle: "LINE"
description: "Eliza 的 LINE 连接器 — 与 LINE 消息平台的机器人集成。"
---

LINE 插件将 Eliza 代理作为机器人连接到 LINE，实现聊天和群组中的消息处理。

**Package:** `@elizaos/plugin-line`

<div id="installation">

## 安装

</div>

```bash
eliza plugins install @elizaos/plugin-line
```

<div id="setup">

## 设置

</div>

<div id="1-create-a-line-messaging-api-channel">

### 1. 创建 LINE Messaging API 频道

</div>

1. 前往 [LINE Developers Console](https://developers.line.biz/console/)
2. 创建新的提供者（或使用现有的）
3. 创建新的 **Messaging API** 频道
4. 在 **Messaging API** 标签页下，签发 **Channel access token**
5. 从 **Basic settings** 标签页记下 **Channel secret**

<div id="2-configure-eliza">

### 2. 配置 Eliza

</div>

```json
{
  "connectors": {
    "line": {
      "channelAccessToken": "YOUR_CHANNEL_ACCESS_TOKEN",
      "channelSecret": "YOUR_CHANNEL_SECRET"
    }
  }
}
```

或通过环境变量：

```bash
export LINE_CHANNEL_ACCESS_TOKEN=YOUR_CHANNEL_ACCESS_TOKEN
export LINE_CHANNEL_SECRET=YOUR_CHANNEL_SECRET
```

<div id="configuration">

## 配置

</div>

| 字段 | 必填 | 描述 |
|------|------|------|
| `channelAccessToken` | 是 | LINE Messaging API 频道访问令牌 |
| `channelSecret` | 是 | LINE 频道密钥 |
| `enabled` | 否 | 设置为 `false` 以禁用（默认：`true`） |

<div id="environment-variables">

## 环境变量

</div>

```bash
export LINE_CHANNEL_ACCESS_TOKEN=YOUR_CHANNEL_ACCESS_TOKEN
export LINE_CHANNEL_SECRET=YOUR_CHANNEL_SECRET
```

<div id="related">

## 相关内容

</div>

- [连接器指南](/zh/guides/connectors) — 连接器通用文档
