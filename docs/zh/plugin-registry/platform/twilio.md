---
title: "Twilio 插件"
sidebarTitle: "Twilio"
description: "Eliza 的 Twilio 连接器 — 通过 Twilio API 进行短信和语音集成。"
---

Twilio 插件将 Eliza 代理连接到 Twilio，实现通过 Twilio 电话号码进行短信消息和语音互动。

**Package:** `@elizaos/plugin-twilio`

<div id="installation">

## 安装

</div>

```bash
eliza plugins install @elizaos/plugin-twilio
```

<div id="setup">

## 设置

</div>

<div id="1-get-your-twilio-credentials">

### 1. 获取你的 Twilio 凭据

</div>

1. 在 [twilio.com](https://www.twilio.com/) 注册
2. 从 Twilio 控制台仪表板复制你的 **Account SID** 和 **Auth Token**
3. 购买或配置一个 Twilio 电话号码

<div id="2-configure-eliza">

### 2. 配置 Eliza

</div>

```json
{
  "connectors": {
    "twilio": {
      "accountSid": "YOUR_ACCOUNT_SID",
      "authToken": "YOUR_AUTH_TOKEN",
      "phoneNumber": "YOUR_PHONE_NUMBER"
    }
  }
}
```

或通过环境变量：

```bash
export TWILIO_ACCOUNT_SID=YOUR_ACCOUNT_SID
export TWILIO_AUTH_TOKEN=YOUR_AUTH_TOKEN
export TWILIO_PHONE_NUMBER=YOUR_PHONE_NUMBER
```

<div id="configuration">

## 配置

</div>

| 字段 | 必填 | 描述 |
|------|------|------|
| `accountSid` | 是 | Twilio Account SID |
| `authToken` | 是 | Twilio Auth Token |
| `phoneNumber` | 是 | Twilio 电话号码（E.164 格式） |
| `enabled` | 否 | 设置为 `false` 以禁用（默认：`true`） |

<div id="environment-variables">

## 环境变量

</div>

```bash
export TWILIO_ACCOUNT_SID=YOUR_ACCOUNT_SID
export TWILIO_AUTH_TOKEN=YOUR_AUTH_TOKEN
export TWILIO_PHONE_NUMBER=YOUR_PHONE_NUMBER
```

<div id="related">

## 相关内容

</div>

- [连接器指南](/zh/guides/connectors) — 连接器通用文档
