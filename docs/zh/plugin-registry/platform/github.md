---
title: "GitHub 插件"
sidebarTitle: "GitHub"
description: "Eliza 的 GitHub 连接器 — 与仓库、issue 和 pull request 互动。"
---

GitHub 插件将 Eliza 代理连接到 GitHub，实现与仓库、issue、pull request 和其他 GitHub 资源的互动。

**Package:** `@elizaos/plugin-github`

<div id="installation">

## 安装

</div>

```bash
eliza plugins install @elizaos/plugin-github
```

<div id="setup">

## 设置

</div>

<div id="1-create-a-github-personal-access-token">

### 1. 创建 GitHub 个人访问令牌

</div>

1. 前往 [github.com/settings/tokens](https://github.com/settings/tokens)
2. 点击 **Generate new token**（经典）或 **Fine-grained token**
3. 选择你的用例所需的权限（例如 `repo`、`issues`、`pull_requests`）
4. 复制生成的令牌

<div id="2-configure-eliza">

### 2. 配置 Eliza

</div>

```json
{
  "connectors": {
    "github": {
      "apiToken": "YOUR_API_TOKEN",
      "owner": "YOUR_GITHUB_OWNER",
      "repo": "YOUR_GITHUB_REPO"
    }
  }
}
```

或通过环境变量：

```bash
export GITHUB_API_TOKEN=YOUR_API_TOKEN
export GITHUB_OWNER=YOUR_GITHUB_OWNER
export GITHUB_REPO=YOUR_GITHUB_REPO
```

<div id="configuration">

## 配置

</div>

| 字段 | 必填 | 描述 |
|------|------|------|
| `apiToken` | 是 | GitHub 个人访问令牌 |
| `owner` | 是 | GitHub 仓库所有者（用户或组织） |
| `repo` | 是 | GitHub 仓库名称 |
| `enabled` | 否 | 设置为 `false` 以禁用（默认：`true`） |

<div id="environment-variables">

## 环境变量

</div>

```bash
export GITHUB_API_TOKEN=YOUR_API_TOKEN
export GITHUB_OWNER=YOUR_GITHUB_OWNER
export GITHUB_REPO=YOUR_GITHUB_REPO
```

<div id="related">

## 相关内容

</div>

- [连接器指南](/zh/guides/connectors) — 连接器通用文档
