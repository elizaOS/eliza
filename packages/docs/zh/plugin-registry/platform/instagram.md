---
title: "Instagram 插件"
sidebarTitle: "Instagram"
description: "Eliza 的 Instagram 连接器 — 与 Instagram 消息和内容互动。"
---

Instagram 插件将 Eliza 代理连接到 Instagram，实现消息处理和内容互动。

**Package:** `@elizaos/plugin-instagram`

<div id="installation">

## 安装

</div>

```bash
eliza plugins install @elizaos/plugin-instagram
```

<div id="setup">

## 设置

</div>

<div id="1-get-your-instagram-credentials">

### 1. 获取你的 Instagram 凭据

</div>

1. 使用你的 Instagram 账户用户名和密码
2. 对于自动化，建议为你的代理创建一个专用账户

<div id="2-configure-eliza">

### 2. 配置 Eliza

</div>

```json
{
  "connectors": {
    "instagram": {
      "username": "YOUR_USERNAME",
      "password": "YOUR_PASSWORD"
    }
  }
}
```

或通过环境变量：

```bash
export INSTAGRAM_USERNAME=YOUR_USERNAME
export INSTAGRAM_PASSWORD=YOUR_PASSWORD
```

<div id="configuration">

## 配置

</div>

| 字段 | 必填 | 描述 |
|------|------|------|
| `username` | 是 | Instagram 账户用户名 |
| `password` | 是 | Instagram 账户密码 |
| `enabled` | 否 | 设置为 `false` 以禁用（默认：`true`） |

<div id="environment-variables">

## 环境变量

</div>

```bash
export INSTAGRAM_USERNAME=YOUR_USERNAME
export INSTAGRAM_PASSWORD=YOUR_PASSWORD
```

<div id="related">

## 相关内容

</div>

- [连接器指南](/zh/guides/connectors) — 连接器通用文档
