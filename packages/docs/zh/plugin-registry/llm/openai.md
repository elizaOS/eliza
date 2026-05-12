---
title: "OpenAI 插件"
sidebarTitle: "OpenAI"
description: "Eliza 的 OpenAI 模型提供者 — GPT-4o、o1、o3、嵌入向量、图像生成和语音。"
---

OpenAI 插件将 Eliza 代理连接到 OpenAI 的 API，提供对 GPT-4o、o1/o3 推理模型系列、DALL-E 图像生成和 Whisper 语音转文字的访问。

**Package:** `@elizaos/plugin-openai`

<div id="installation">

## 安装

</div>

```bash
eliza plugins install @elizaos/plugin-openai
```

或添加到 `eliza.json`：

```json
{
  "plugins": {
    "allow": ["openai"]
  }
}
```

<div id="auto-enable">

## 自动启用

</div>

当环境中存在 `OPENAI_API_KEY` 时，插件会自动启用：

```bash
export OPENAI_API_KEY=sk-...
```

<div id="configuration">

## 配置

</div>

| 环境变量 | 必需 | 描述 |
|---------|------|------|
| `OPENAI_API_KEY` | 是 | 来自 [platform.openai.com](https://platform.openai.com) 的 OpenAI API 密钥 |
| `OPENAI_API_URL` | 否 | 自定义基础 URL（用于 Azure OpenAI 或兼容 API） |
| `OPENAI_ORG_ID` | 否 | 用于使用量跟踪的组织 ID |
| `OPENAI_PROJECT_ID` | 否 | 用于配额管理的项目 ID |

<div id="elizajson-example">

### eliza.json 示例

</div>

```json
{
  "auth": {
    "profiles": {
      "default": {
        "provider": "openai",
        "model": "gpt-4o"
      }
    }
  }
}
```

<div id="supported-models">

## 支持的模型

</div>

<div id="text-generation">

### 文本生成

</div>

| 模型 | 上下文 | 最适合 |
|------|--------|--------|
| `gpt-5.5` | 1M | 最新旗舰模型 |
| `gpt-5-mini` | 1M | 快速、经济的任务 |
| `gpt-5.5-nano` | 1M | 超快速、最低成本 |
| `gpt-4o` | 128k | 多模态推理 |
| `gpt-5-mini` | 128k | 快速多模态任务 |

<div id="reasoning-models">

### 推理模型

</div>

| 模型 | 上下文 | 最适合 |
|------|--------|--------|
| `o1` | 200k | 深度推理任务 |
| `o1-mini` | 128k | 快速推理 |
| `o3` | 200k | 最先进的推理 |
| `o3-mini` | 200k | 高效推理 |
| `o4-mini` | 200k | 最新高效推理 |

<div id="other-capabilities">

### 其他能力

</div>

| 能力 | 模型 |
|------|------|
| 嵌入向量 | `text-embedding-3-small`、`text-embedding-3-large` |
| 图像生成 | `dall-e-3`、`dall-e-2` |
| 语音转文字 | `whisper-1` |
| 文字转语音 | `tts-1`、`tts-1-hd` |
| 视觉 | `gpt-4o`（多模态） |

<div id="model-type-mapping">

## 模型类型映射

</div>

| elizaOS 模型类型 | OpenAI 模型 |
|-----------------|------------|
| `TEXT_SMALL` | `gpt-5-mini` |
| `TEXT_LARGE` | `gpt-4o` |
| `TEXT_EMBEDDING` | `text-embedding-3-small` |
| `IMAGE` | `dall-e-3` |
| `TRANSCRIPTION` | `whisper-1` |
| `TEXT_TO_SPEECH` | `tts-1` |

<div id="features">

## 功能特性

</div>

- 流式响应
- 函数/工具调用
- 视觉（使用 `gpt-4o` 输入图像）
- 结构化 JSON 输出（`response_format: { type: "json_object" }`）
- 批量 API 支持
- Token 使用量跟踪

<div id="usage-example">

## 使用示例

</div>

```typescript
// In a plugin or action handler:
const response = await runtime.useModel("TEXT_LARGE", {
  prompt: "Explain quantum entanglement in simple terms.",
  maxTokens: 500,
  temperature: 0.7,
});
```

<div id="rate-limits-and-pricing">

## 速率限制与定价

</div>

速率限制取决于您的 OpenAI 使用层级。请参阅 [platform.openai.com/docs/guides/rate-limits](https://platform.openai.com/docs/guides/rate-limits) 了解各层级的当前限制。

定价：[openai.com/pricing](https://openai.com/pricing)

<div id="related">

## 相关

</div>

- [Anthropic 插件](/zh/plugin-registry/llm/anthropic) — Claude 模型系列
- [OpenRouter 插件](/zh/plugin-registry/llm/openrouter) — 在多个提供者之间路由
- [模型提供者](/zh/runtime/models) — 比较所有提供者
