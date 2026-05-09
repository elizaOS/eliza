---
title: "Anthropic 插件"
sidebarTitle: "Anthropic"
description: "Eliza 的 Anthropic Claude 模型提供者 — Claude Opus 4.7、Sonnet 4.6、Haiku 4.5，以及自适应思维支持。"
---

Anthropic 插件将 Eliza 代理连接到 Anthropic 的 Claude API，并提供当前的 Claude Opus 4.7、Claude Sonnet 4.6 和 Claude Haiku 4.5 模型。

**Package:** `@elizaos/plugin-anthropic`

<div id="installation">

## 安装

</div>

```bash
eliza plugins install @elizaos/plugin-anthropic
```

<div id="auto-enable">

## 自动启用

</div>

当 `ANTHROPIC_API_KEY` 或 `CLAUDE_API_KEY` 存在时，插件会自动启用：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

<div id="configuration">

## 配置

</div>

| 环境变量 | 必需 | 描述 |
|---------|------|------|
| `ANTHROPIC_API_KEY` | 是* | 来自 [console.anthropic.com](https://console.anthropic.com) 的 Anthropic API 密钥 |
| `CLAUDE_API_KEY` | 是* | `ANTHROPIC_API_KEY` 的别名 |
| `ANTHROPIC_API_URL` | 否 | 自定义基础 URL |

*需要 `ANTHROPIC_API_KEY` 或 `CLAUDE_API_KEY`。

<div id="elizajson-example">

### eliza.json 示例

</div>

```json
{
  "auth": {
    "profiles": {
      "default": {
        "provider": "anthropic",
        "model": "claude-sonnet-4-6"
      }
    }
  }
}
```

<div id="supported-models">

## 支持的模型

</div>

| 模型 | 上下文 | 最适合 |
|------|--------|--------|
| `claude-opus-4-7` | 200k | 最适合复杂推理和长流程代理的最强模型 |
| `claude-sonnet-4-6` | 200k | 默认大模型，适合编码、分析和通用任务 |
| `claude-haiku-4-5-20251001` | 200k | 快速、轻量任务 |

<div id="model-type-mapping">

## 模型类型映射

</div>

| elizaOS 模型类型 | Anthropic 模型 |
|-----------------|---------------|
| `TEXT_SMALL` | `claude-haiku-4-5-20251001` |
| `TEXT_LARGE` | `claude-sonnet-4-6` |

<div id="features">

## 功能特性

</div>

- 流式响应
- 工具使用（函数调用）
- 视觉输入（所有模型都支持图片输入）
- `claude-sonnet-4-6` 和 `claude-opus-4-7` 支持自适应/扩展思维
- 通过工具使用实现结构化 JSON 输出
- 所有模型都支持 200k token 上下文窗口
- 通过提示缓存降低重复上下文成本

<div id="extended-thinking">

## 扩展思维

</div>

Claude Sonnet 4.6 和 Claude Opus 4.7 支持 Anthropic 的自适应/扩展思维模式，适合复杂推理和多步骤规划。

```typescript
const response = await runtime.useModel("TEXT_LARGE", {
  prompt: "Design a database schema for a multi-tenant SaaS application.",
  thinking: { type: "enabled", budgetTokens: 10000 },
});
```

<div id="rate-limits-and-pricing">

## 速率限制与定价

</div>

速率限制取决于你的 Anthropic 使用层级。当前限制见 [docs.anthropic.com/en/api/rate-limits](https://docs.anthropic.com/en/api/rate-limits)。

定价： [anthropic.com/pricing](https://www.anthropic.com/pricing)

<div id="related">

## 相关内容

</div>

- [OpenAI 插件](/zh/plugin-registry/llm/openai) — GPT-4o 和推理模型
- [OpenRouter 插件](/zh/plugin-registry/llm/openrouter) — 包括 Anthropic 在内的多提供者路由
- [模型提供者](/zh/runtime/models) — 比较所有提供者
