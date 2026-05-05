---
title: Twilio 连接器
sidebarTitle: Twilio
description: 使用 @elizaos/plugin-twilio 包将你的代理连接到 Twilio 以获取短信和语音功能。
---

将你的代理连接到 Twilio，获取短信消息和语音通话功能。

<div id="overview">

## 概述

</div>

Twilio 连接器是一个 elizaOS 插件，将你的代理桥接到 Twilio 的通信 API。它支持入站和出站短信，以及语音通话功能。此连接器可从插件注册表获取。

<div id="package-info">

## 包信息

</div>

| 字段 | 值 |
|------|----|
| 包 | `@elizaos/plugin-twilio` |
| 配置键 | `connectors.twilio` |
| 安装 | `eliza plugins install @elizaos/plugin-twilio` |

<div id="setup-requirements">

## 设置要求

</div>

- Twilio Account SID 和 Auth Token
- 一个 Twilio 电话号码

<div id="configuration">

## 配置

</div>

```json
{
  "connectors": {
    "twilio": {
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
| `TWILIO_ACCOUNT_SID` | Twilio Account SID |
| `TWILIO_AUTH_TOKEN` | Twilio Auth Token |
| `TWILIO_PHONE_NUMBER` | 用于发送/接收的 Twilio 电话号码 |

<div id="features">

## 功能

</div>

- 短信消息（发送和接收）
- 语音通话功能
- 基于 webhook 的入站消息处理

<div id="related">

## 相关内容

</div>

- [连接器概述](/zh/guides/connectors#twilio)
