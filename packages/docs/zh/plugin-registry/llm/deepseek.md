---
title: "DeepSeek 插件"
sidebarTitle: "DeepSeek"
description: "Eliza 的 DeepSeek 模型提供者 — DeepSeek-V3 和 DeepSeek-R1 推理模型。"
---

<Warning>
此插件尚未在 Eliza 插件注册表中提供。要使用 DeepSeek 模型，请通过 [OpenRouter 插件](/plugin-registry/llm/openrouter) 配置，使用相应的模型 ID。
</Warning>

DeepSeek 插件将 Eliza 代理连接到 DeepSeek 的 API，以极具竞争力的价格提供对 DeepSeek-V3（通用）和 DeepSeek-R1（专注推理）模型的访问。

**Package:** `@elizaos/plugin-deepseek`（尚未发布）

<div id="installation">

## 安装

</div>

```bash
eliza plugins install @elizaos/plugin-deepseek
```

<div id="auto-enable">

## 自动启用

</div>

当 `DEEPSEEK_API_KEY` 存在时，插件会自动启用：

```bash
export DEEPSEEK_API_KEY=sk-...
```

<div id="configuration">

## 配置

</div>

| 环境变量 | 必需 | 描述 |
|---------|------|------|
| `DEEPSEEK_API_KEY` | 是 | 来自 [platform.deepseek.com](https://platform.deepseek.com) 的 DeepSeek API 密钥 |
| `DEEPSEEK_API_URL` | 否 | 自定义基础 URL（默认：`https://api.deepseek.com`） |

<div id="elizajson-example">

### eliza.json 示例

</div>

```json
{
  "auth": {
    "profiles": {
      "default": {
        "provider": "deepseek",
        "model": "deepseek-chat"
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
| `deepseek-chat` | 64k | 通用对话（DeepSeek-V3） |
| `deepseek-reasoner` | 64k | 思维链推理（DeepSeek-R1） |

DeepSeek-V3 是一个拥有 671B 参数（37B 活跃）的混合专家模型。DeepSeek-R1 是一个通过强化学习训练的推理模型。

<div id="model-type-mapping">

## 模型类型映射

</div>

| elizaOS 模型类型 | DeepSeek 模型 |
|-----------------|--------------|
| `TEXT_SMALL` | `deepseek-chat` |
| `TEXT_LARGE` | `deepseek-chat` 或 `deepseek-reasoner`（配置大型 slot） |

<div id="features">

## 功能特性

</div>

- 兼容 OpenAI 的 API 格式
- 流式响应
- 函数调用 / 工具使用
- 多轮对话
- 代码生成（V3 中继承了 DeepSeek-Coder）
- 思维链推理（R1）
- 价格极具竞争力——比同等的西方模型便宜得多

<div id="deepseek-r1-reasoning">

## DeepSeek-R1 推理

</div>

`deepseek-reasoner` 模型在最终回答之前会生成一个包含推理链的 `<think>` 块。将**大型**文本 slot 配置为 `deepseek-reasoner`，然后使用 `TEXT_LARGE`：

```typescript
const response = await runtime.useModel("TEXT_LARGE", {
  prompt: "Prove that there are infinitely many prime numbers.",
});
```

<div id="local-deepseek-via-ollama">

## 通过 Ollama 本地运行 DeepSeek

</div>

本地推理请使用 [Ollama 插件](/zh/plugin-registry/llm/ollama) 配置 Eliza-1，
不要通过本地模型服务器路由 DeepSeek。

<div id="rate-limits-and-pricing">

## 速率限制与定价

</div>

DeepSeek 提供极具竞争力的按 token 定价。请参阅 [platform.deepseek.com/docs/pricing](https://platform.deepseek.com/docs/pricing) 了解当前费率。

DeepSeek-V3 在大多数任务上质量与 GPT-4o 相当，但价格仅为其一小部分。

<div id="related">

## 相关

</div>

- [OpenRouter 插件](/zh/plugin-registry/llm/openrouter) — 通过 OpenRouter 访问 DeepSeek
- [Groq 插件](/zh/plugin-registry/llm/groq) — 快速推理替代方案
- [Ollama 插件](/zh/plugin-registry/llm/ollama) — 本地运行 DeepSeek
- [模型提供者](/zh/runtime/models) — 比较所有提供者
