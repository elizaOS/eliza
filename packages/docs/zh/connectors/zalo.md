---
title: Zalo 连接器
sidebarTitle: Zalo
description: 使用 @elizaos/plugin-zalo 包将你的代理连接到 Zalo。
---

将你的代理连接到 Zalo，进行官方账号消息和客服工作流。

<div id="overview">

## 概述

</div>

Zalo 连接器是一个 elizaOS 插件，通过官方账号 API 将你的代理桥接到 Zalo 平台。此连接器可从插件注册表获取。个人账号变体也可用，名为 `@elizaos/plugin-zalouser`。

<div id="package-info">

## 包信息

</div>

| 字段 | 值 |
|------|----|
| 包 | `@elizaos/plugin-zalo` |
| 配置键 | `connectors.zalo` |
| 安装 | `eliza plugins install @elizaos/plugin-zalo` |

<div id="setup-requirements">

## 设置要求

</div>

- Zalo 官方账号 (OA) 访问令牌

<div id="configuration">

## 配置

</div>

```json
{
  "connectors": {
    "zalo": {
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
| `ZALO_ACCESS_TOKEN` | OA 访问令牌 |
| `ZALO_REFRESH_TOKEN` | 令牌刷新凭据 |
| `ZALO_APP_ID` | 应用 ID |
| `ZALO_SECRET_KEY` | 应用密钥 |

<div id="features">

## 功能

</div>

- 官方账号消息和客服工作流
- 基于 webhook 的消息处理
- 客户互动管理

<div id="related">

## 相关内容

</div>

- [连接器概述](/zh/guides/connectors#zalo)
