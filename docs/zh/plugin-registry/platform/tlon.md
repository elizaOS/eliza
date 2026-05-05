---
title: "Tlon 插件"
sidebarTitle: "Tlon"
description: "Eliza 的 Tlon 连接器 — 与 Tlon (Urbit) 消息平台的机器人集成。"
---

Tlon 插件将 Eliza 代理连接到 Tlon (Urbit)，实现通过连接的 Urbit ship 处理消息。

**Package:** `@elizaos/plugin-tlon`

<div id="installation">

## 安装

</div>

```bash
eliza plugins install @elizaos/plugin-tlon
```

<div id="setup">

## 设置

</div>

<div id="1-get-your-urbit-ship-credentials">

### 1. 获取你的 Urbit ship 凭据

</div>

1. 拥有一个运行中的 Urbit ship（planet、star 或 comet）
2. 记下 ship 名称（例如 `~zod`）
3. 从 ship 的网页界面获取访问代码（设置 → 访问密钥）
4. 记下 ship 的 URL（例如 `http://localhost:8080`）

<div id="2-configure-eliza">

### 2. 配置 Eliza

</div>

```json
{
  "connectors": {
    "tlon": {
      "ship": "YOUR_SHIP",
      "code": "YOUR_CODE",
      "url": "YOUR_URL"
    }
  }
}
```

或通过环境变量：

```bash
export TLON_SHIP=YOUR_SHIP
export TLON_CODE=YOUR_CODE
export TLON_URL=YOUR_URL
```

<div id="configuration">

## 配置

</div>

| 字段 | 必填 | 描述 |
|------|------|------|
| `ship` | 是 | Urbit ship 名称（例如 `~zod`） |
| `code` | 是 | Urbit ship 访问代码 |
| `url` | 是 | Urbit ship URL |
| `enabled` | 否 | 设置为 `false` 以禁用（默认：`true`） |

<div id="environment-variables">

## 环境变量

</div>

```bash
export TLON_SHIP=YOUR_SHIP
export TLON_CODE=YOUR_CODE
export TLON_URL=YOUR_URL
```

<div id="related">

## 相关内容

</div>

- [连接器指南](/zh/guides/connectors) — 连接器通用文档
