---
title: Instagram 连接器
sidebarTitle: Instagram
description: 使用 @elizaos/plugin-instagram 包将你的代理连接到 Instagram。
---

将你的代理连接到 Instagram，进行媒体发布、评论监控和私信处理。

<div id="overview">

## 概述

</div>

Instagram 连接器是一个 elizaOS 插件，将你的代理桥接到 Instagram。它支持媒体发布并自动生成文字说明、评论回复和私信处理。此连接器可从插件注册表获取。

<div id="package-info">

## 包信息

</div>

| 字段 | 值 |
|------|----|
| 包 | `@elizaos/plugin-instagram` |
| 配置键 | `connectors.instagram` |
| 安装 | `eliza plugins install @elizaos/plugin-instagram` |

<div id="setup-requirements">

## 设置要求

</div>

- Instagram 账户凭据（用户名和密码）

<div id="configuration">

## 配置

</div>

```json
{
  "connectors": {
    "instagram": {
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
| `INSTAGRAM_USERNAME` | Instagram 用户名 |
| `INSTAGRAM_PASSWORD` | Instagram 密码 |
| `INSTAGRAM_DRY_RUN` | 设置为 `true` 以测试而不发布 |
| `INSTAGRAM_POLL_INTERVAL` | 轮询间隔（毫秒） |
| `INSTAGRAM_POST_INTERVAL_MIN` | 发布之间的最小秒数 |
| `INSTAGRAM_POST_INTERVAL_MAX` | 发布之间的最大秒数 |

<div id="features">

## 功能

</div>

- 媒体发布并自动生成文字说明
- 评论监控和回复
- 私信处理
- 测试模式（不实际发布）
- 可配置的发布和轮询间隔

<div id="related">

## 相关内容

</div>

- [连接器概述](/zh/guides/connectors#instagram)
