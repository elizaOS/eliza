---
title: GitHub 连接器
sidebarTitle: GitHub
description: 使用 @elizaos/plugin-github 包将你的代理连接到 GitHub。
---

将你的代理连接到 GitHub，进行仓库管理、issue 跟踪和 pull request 工作流。

<div id="overview">

## 概述

</div>

GitHub 连接器是一个 elizaOS 插件，将你的代理桥接到 GitHub API。它支持仓库管理、issue 跟踪、pull request 创建和审查，以及代码搜索。此连接器可从插件注册表获取。

<div id="package-info">

## 包信息

</div>

| 字段 | 值 |
|------|----|
| 包 | `@elizaos/plugin-github` |
| 配置键 | `connectors.github` |
| 安装 | `eliza plugins install @elizaos/plugin-github` |

<div id="setup-requirements">

## 设置要求

</div>

- GitHub API 令牌（个人访问令牌或细粒度令牌）

<div id="configuration">

## 配置

</div>

```json
{
  "connectors": {
    "github": {
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
| `GITHUB_API_TOKEN` | 个人访问令牌或细粒度令牌 |
| `GITHUB_OWNER` | 默认仓库所有者 |
| `GITHUB_REPO` | 默认仓库名称 |

<div id="features">

## 功能

</div>

- 仓库管理
- Issue 跟踪和创建
- Pull request 工作流（创建、审查、合并）
- 代码搜索和文件访问

<div id="related">

## 相关内容

</div>

- [连接器概述](/zh/guides/connectors#github)
