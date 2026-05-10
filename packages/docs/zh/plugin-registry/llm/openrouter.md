---
title: "OpenRouter 插件"
sidebarTitle: "OpenRouter"
description: "Eliza 的 OpenRouter 多提供者网关 — 通过单一 API 访问来自 OpenAI、Anthropic、Google、Meta 等的 200 多个模型。"
---

OpenRouter 插件将 Eliza 代理连接到 OpenRouter 的统一推理网关，通过单一 API 密钥和端点提供对所有主要提供者的 200 多个模型的访问。

**Package:** `@elizaos/plugin-openrouter`

<div id="eliza-pinned-version-and-upstream-bundle-bug">

## Eliza：固定版本与上游 bundle 错误

</div>

在 Eliza 的 monorepo 中，**`@elizaos/plugin-openrouter` 被固定为 `2.0.0-alpha.13`**（根 `package.json` 中的精确版本，反映在 `bun.lock` 中）。

**为什么要固定版本**

- **npm 上的 `2.0.0-alpha.12` 是一次错误发布：** Node 和浏览器 ESM bundle 被**截断**。它们只包含打包的配置辅助函数；**主插件对象缺失**，但文件仍然**导出** `openrouterPlugin` 和一个默认别名。**运行时失败的原因：** Bun（以及任何严格的工具链）尝试加载该文件时会报错，因为这些绑定在模块中**从未被声明**。
- **为什么不用 `^2.0.0-alpha.10`：** 语义化版本范围可能会浮动到 **`alpha.12`**，这会导致所有使用 OpenRouter 的人在执行 `bun install` / 刷新 lockfile 时出错。
- **为什么不在 `patch-deps.mjs` 中修补：** 与一个完整文件中错误的导出*名称*不同，这个 tarball 省略了**整个实现代码块**。postinstall 字符串替换无法凭空创建插件；安全的修复方式是**使用一个正常的版本**。

**何时移除固定版本**

在上游发布修复版本后，验证 `dist/node/index.node.js` 包含完整的插件（数百行，而非约 80 行），并且 `bun build …/index.node.js --target=bun` 成功执行，然后升级版本并根据需要放宽范围。

**参考：** [插件解析 — 固定的 OpenRouter](/zh/plugin-resolution-and-node-path#pinned-elizaosplugin-openrouter)。

<div id="installation">

## 安装

</div>

```bash
eliza plugins install @elizaos/plugin-openrouter
```

<div id="auto-enable">

## 自动启用

</div>

当 `OPENROUTER_API_KEY` 存在时，插件会自动启用：

```bash
export OPENROUTER_API_KEY=sk-or-...
```

<div id="configuration">

## 配置

</div>

| 环境变量 | 必需 | 描述 |
|---------|------|------|
| `OPENROUTER_API_KEY` | 是 | 来自 [openrouter.ai](https://openrouter.ai) 的 OpenRouter API 密钥 |

<div id="elizajson-example">

### eliza.json 示例

</div>

```json
{
  "auth": {
    "profiles": {
      "default": {
        "provider": "openrouter",
        "model": "anthropic/claude-sonnet-4.6"
      }
    }
  }
}
```

<div id="supported-models">

## 支持的模型

</div>

OpenRouter 提供对所有主要提供者模型的访问。使用带有提供者前缀的完整模型 ID：

<div id="openai-via-openrouter">

### 通过 OpenRouter 使用 OpenAI

</div>

| 模型 ID | 描述 |
|---------|------|
| `openai/gpt-4o` | GPT-4o 多模态 |
| `openai/gpt-5-mini` | 快速高效 |
| `openai/o1` | 推理模型 |
| `openai/o3-mini` | 快速推理 |

<div id="anthropic-via-openrouter">

### 通过 OpenRouter 使用 Anthropic

</div>

| 模型 ID | 描述 |
|---------|------|
| `anthropic/claude-opus-4.7` | 最强大的 Claude |
| `anthropic/claude-sonnet-4.6` | 均衡的 Claude |
| `anthropic/claude-haiku-4.5` | 最快的 Claude |

<div id="meta-via-openrouter">

### 通过 OpenRouter 使用 Meta

</div>

| 模型 ID | 描述 |
|---------|------|
| `meta-llama/llama-3.1-405b-instruct` | Llama 3.1 405B |

<div id="google-via-openrouter">

### 通过 OpenRouter 使用 Google

</div>

| 模型 ID | 描述 |
|---------|------|
| `google/gemini-2.5-pro` | Gemini 2.5 Pro |
| `google/gemini-2.5-flash` | Gemini 2.5 Flash |

浏览所有模型：[openrouter.ai/models](https://openrouter.ai/models)。

<div id="model-type-mapping">

## 模型类型映射

</div>

| elizaOS 模型类型 | 默认 OpenRouter 模型 |
|-----------------|-------------------|
| `TEXT_SMALL` | `anthropic/claude-haiku-4.5` |
| `TEXT_LARGE` | `anthropic/claude-sonnet-4.6` |

<div id="features">

## 功能特性

</div>

- 单一 API 密钥访问 200 多个模型
- 当主要提供者不可用时自动回退到备用提供者
- 成本优化——路由到最便宜的可用提供者
- 模型比较和 A/B 测试
- 使用分析仪表板
- 流式响应
- 兼容 OpenAI 的 API 格式
- 提供免费模型（社区层级）

<div id="provider-routing">

## 提供者路由

</div>

OpenRouter 支持按成本、延迟或吞吐量设置路由偏好：

```json
{
  "auth": {
    "profiles": {
      "default": {
        "provider": "openrouter",
        "model": "anthropic/claude-sonnet-4.6",
        "providerPreferences": {
          "order": ["Anthropic", "AWS Bedrock"],
          "allowFallbacks": true
        }
      }
    }
  }
}
```

<div id="free-models">

## 免费模型

</div>

OpenRouter 提供对精选开源模型的免费访问（有速率限制）：

- `meta-llama/llama-3.2-3b-instruct:free`
- `google/gemma-2-9b-it:free`
- `mistralai/mistral-7b-instruct:free`

<div id="rate-limits-and-pricing">

## 速率限制与定价

</div>

定价按模型计算，因提供者而异。OpenRouter 收取与底层提供者相同的费率，部分模型会加收少量费用。

请参阅 [openrouter.ai/docs#limits](https://openrouter.ai/docs#limits) 了解速率限制详情。

<div id="related">

## 相关

</div>

- [OpenAI 插件](/zh/plugin-registry/llm/openai) — 直接集成 OpenAI
- [Anthropic 插件](/zh/plugin-registry/llm/anthropic) — 直接集成 Anthropic
- [模型提供者](/zh/runtime/models) — 比较所有提供者
