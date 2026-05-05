---
title: LINE 连接器
sidebarTitle: LINE
description: 使用 @elizaos/plugin-line 包将你的代理连接到 LINE。
---

将你的代理连接到 LINE，进行机器人消息和客户对话。

<div id="overview">

## 概述

</div>

LINE 连接器是一个 elizaOS 插件，将你的代理桥接到 LINE Messaging API。它支持富消息类型、群聊和基于 webhook 的事件处理。此连接器可从插件注册表获取。

<div id="package-info">

## 包信息

</div>

| 字段 | 值 |
|------|----|
| 包 | `@elizaos/plugin-line` |
| 配置键 | `connectors.line` |
| 安装 | `eliza plugins install @elizaos/plugin-line` |

<div id="setup-requirements">

## 设置要求

</div>

- LINE 频道访问令牌
- LINE 频道密钥
- 在 [developers.line.biz](https://developers.line.biz) 创建 Messaging API 频道

<div id="configuration">

## 配置

</div>

```json
{
  "connectors": {
    "line": {
      "enabled": true
    }
  }
}
```

<div id="environment-variables">

## 环境变量

</div>

| 变量 | 描述 |
|------|------|
| `LINE_CHANNEL_ACCESS_TOKEN` | 来自 LINE 开发者控制台的频道访问令牌 |
| `LINE_CHANNEL_SECRET` | 用于 webhook 验证的频道密钥 |
| `LINE_CUSTOM_GREETING` | 新用户的自定义欢迎消息 |

<div id="features">

## 功能

</div>

- 机器人消息和客户对话
- 富消息类型（文本、贴纸、图片、视频）
- 群聊支持
- 基于 webhook 的事件处理

<div id="related">

## 相关内容

</div>

- [连接器概述](/zh/guides/connectors#line)
