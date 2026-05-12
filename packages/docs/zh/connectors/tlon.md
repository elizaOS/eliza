---
title: Tlon 连接器
sidebarTitle: Tlon
description: 使用 @elizaos/plugin-tlon 包将你的代理连接到 Tlon/Urbit。
---

通过 Tlon 将你的代理连接到 Urbit 网络，进行 ship-to-ship 消息。

<div id="overview">

## 概述

</div>

Tlon 连接器是一个 elizaOS 插件，将你的代理桥接到 Urbit 网络。它支持 ship-to-ship 消息和群聊参与。此连接器可从插件注册表获取。

<div id="package-info">

## 包信息

</div>

| 字段 | 值 |
|------|----|
| 包 | `@elizaos/plugin-tlon` |
| 配置键 | `connectors.tlon` |
| 安装 | `eliza plugins install @elizaos/plugin-tlon` |

<div id="setup-requirements">

## 设置要求

</div>

- Tlon ship 凭据（Urbit ship 名称和访问代码）

<div id="configuration">

## 配置

</div>

```json
{
  "connectors": {
    "tlon": {
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
| `TLON_SHIP` | Urbit ship 名称 |
| `TLON_CODE` | Ship 访问代码 |
| `TLON_URL` | Ship URL |

<div id="features">

## 功能

</div>

- 基于 Urbit 的聊天和社交互动
- Ship-to-ship 消息
- 群聊参与

<div id="related">

## 相关内容

</div>

- [连接器概述](/zh/guides/connectors#tlon)
