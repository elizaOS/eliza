---
title: "Models"
sidebarTitle: "Models"
description: "Model management, provider selection, model configuration, embedding models, and the Eliza model config schema."
---

Eliza selects AI models from the configured provider plugins. Model selection flows from the agent config through environment variables to the loaded provider plugin, which handles the actual API calls.

## Model Selection Algorithm

Model provider plugins are selected by which API key environment variables are present:

```
ANTHROPIC_API_KEY              → @elizaos/plugin-anthropic
CLAUDE_API_KEY                 → @elizaos/plugin-anthropic
OPENAI_API_KEY                 → @elizaos/plugin-openai
AI_GATEWAY_API_KEY             → @elizaos/plugin-vercel-ai-gateway
AIGATEWAY_API_KEY              → @elizaos/plugin-vercel-ai-gateway
GOOGLE_API_KEY                 → @elizaos/plugin-google-genai
GOOGLE_GENERATIVE_AI_API_KEY   → @elizaos/plugin-google-genai
GOOGLE_CLOUD_API_KEY           → @elizaos/plugin-google-antigravity
GROQ_API_KEY                   → @elizaos/plugin-groq
XAI_API_KEY                    → @elizaos/plugin-xai
GROK_API_KEY                   → @elizaos/plugin-xai
OPENROUTER_API_KEY             → @elizaos/plugin-openrouter
OLLAMA_BASE_URL                → @elizaos/plugin-ollama
ZAI_API_KEY                    → @elizaos/plugin-zai
DEEPSEEK_API_KEY               → @elizaos/plugin-deepseek
TOGETHER_API_KEY               → @elizaos/plugin-together
MISTRAL_API_KEY                → @elizaos/plugin-mistral
COHERE_API_KEY                 → @elizaos/plugin-cohere
PERPLEXITY_API_KEY             → @elizaos/plugin-perplexity
ELIZAOS_CLOUD_API_KEY          → @elizaos/plugin-elizacloud
ELIZAOS_CLOUD_ENABLED          → @elizaos/plugin-elizacloud
CUA_API_KEY                    → @elizaos/plugin-cua
CUA_HOST                       → @elizaos/plugin-cua
OBSIDIAN_VAULT_PATH            → @elizaos/plugin-obsidian
REPOPROMPT_CLI_PATH            → @elizaos/plugin-repoprompt
```

When multiple providers are configured, all are loaded. The `MODEL_PROVIDER` runtime setting (set from `agents.defaults.model.primary`) tells the agent which one to use for generation.

### Eliza Cloud Mode

When Eliza Cloud is active (`cloud.enabled: true` or `cloud.apiKey` is set), all direct AI provider plugins are removed from the load set. Eliza Cloud handles all model calls through its gateway:

```typescript
if (cloudEffectivelyEnabled) {
  pluginsToLoad.add("@elizaos/plugin-elizacloud");
  // Remove all direct provider plugins
  for (const p of directProviders) {
    pluginsToLoad.delete(p);
  }
}
```

## Primary Model Configuration

The primary model is stored in `agents.defaults.model.primary` as a `"provider/model"` string:

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-sonnet-4.6",
        "fallbacks": ["openai/gpt-5", "groq/openai/gpt-oss-120b"]
      }
    }
  }
}
```

`resolvePrimaryModel()` extracts this value and passes it to `AgentRuntime` as the `MODEL_PROVIDER` setting.

## Cloud Model Defaults

When Eliza Cloud is enabled and no explicit model is set:

```typescript
const small = models?.small || "openai/gpt-5-mini";
const large = models?.large || "anthropic/claude-sonnet-4.6";
```

These are set as `SMALL_MODEL`, `LARGE_MODEL`, `ELIZAOS_CLOUD_SMALL_MODEL`, and `ELIZAOS_CLOUD_LARGE_MODEL`.

## ModelsConfig

The `ModelsConfig` type in `eliza.json` configures model providers and selections:

```typescript
export type ModelsConfig = {
  mode?: "merge" | "replace";
  providers?: Record<string, ModelProviderConfig>;
  bedrockDiscovery?: BedrockDiscoveryConfig;
  small?: string;
  large?: string;
};
```

### ModelProviderConfig

Define a custom model provider (e.g., a self-hosted OpenAI-compatible endpoint):

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "my-provider": {
        "baseUrl": "https://my-llm-server.example.com/v1",
        "apiKey": "secret",
        "api": "openai-completions",
        "models": [
          {
            "id": "my-provider/my-model",
            "name": "My Custom Model",
            "reasoning": false,
            "input": ["text"],
            "cost": {
              "input": 0.001,
              "output": 0.002,
              "cacheRead": 0.0005,
              "cacheWrite": 0.001
            },
            "contextWindow": 128000,
            "maxTokens": 4096
          }
        ]
      }
    }
  }
}
```

### ModelDefinitionConfig Fields

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique model identifier (e.g., `"anthropic/claude-sonnet-4.6"`) |
| `name` | string | Human-readable name |
| `api` | ModelApi | API format: `"openai-completions"`, `"openai-responses"`, `"anthropic-messages"`, `"google-generative-ai"`, `"bedrock-converse-stream"` |
| `reasoning` | boolean | Whether the model supports extended thinking / reasoning |
| `input` | `Array<"text" \| "image">` | Supported input modalities |
| `cost.input` | number | Cost per input token (USD) |
| `cost.output` | number | Cost per output token (USD) |
| `cost.cacheRead` | number | Cost per cached-read token (USD) |
| `cost.cacheWrite` | number | Cost per cache-write token (USD) |
| `contextWindow` | number | Maximum context length in tokens |
| `maxTokens` | number | Maximum output tokens |
| `compat` | ModelCompatConfig | API compatibility flags |

### ModelCompatConfig

```typescript
export type ModelCompatConfig = {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
};
```

### ModelProviderAuthMode

```typescript
export type ModelProviderAuthMode = "api-key" | "aws-sdk" | "oauth" | "token";
```

## AWS Bedrock Discovery

Eliza supports auto-discovery of available Bedrock models:

```json
{
  "models": {
    "bedrockDiscovery": {
      "enabled": true,
      "region": "us-east-1",
      "providerFilter": ["anthropic", "amazon"],
      "refreshInterval": 3600,
      "defaultContextWindow": 200000,
      "defaultMaxTokens": 4096
    }
  }
}
```

## Per-Agent Model Config

Each agent in `agents.list` can override the model:

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "model": "anthropic/claude-opus-4.7"
      },
      {
        "id": "coder",
        "model": {
          "primary": "anthropic/claude-sonnet-4.6",
          "fallbacks": ["openai/gpt-5"]
        }
      }
    ]
  }
}
```

The `AgentModelConfig` type allows either a string shorthand or the full `{ primary, fallbacks }` object.

## Thinking / Reasoning Models

Models with `reasoning: true` support extended thinking. Per-agent defaults:

```json
{
  "agents": {
    "defaults": {
      "thinkingDefault": "medium"
    }
  }
}
```

Accepted values: `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`.

## Sub-agent Models

Sub-agents spawned via session tools can have their own model:

```json
{
  "agents": {
    "defaults": {
      "subagents": {
        "model": {
          "primary": "anthropic/claude-haiku-4.5-5",
          "fallbacks": ["openai/gpt-5-mini"]
        }
      }
    }
  }
}
```

## Onboarding Model Selection

During first-run onboarding, users choose from these providers:

| Provider | Env Key | Example |
|---|---|---|
| Anthropic (Claude) | `ANTHROPIC_API_KEY` | `sk-ant-...` |
| OpenAI (GPT) | `OPENAI_API_KEY` | `sk-...` |
| OpenRouter | `OPENROUTER_API_KEY` | `sk-or-...` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` | `aigw_...` |
| Google Gemini | `GOOGLE_API_KEY` | `AI...` |
| xAI (Grok) | `XAI_API_KEY` | `xai-...` |
| Groq | `GROQ_API_KEY` | `gsk_...` |
| DeepSeek | `DEEPSEEK_API_KEY` | `sk-...` |
| Mistral | `MISTRAL_API_KEY` | — |
| Together AI | `TOGETHER_API_KEY` | — |
| Ollama (local) | `OLLAMA_BASE_URL` | `http://localhost:11434` |

<Note>
DeepSeek, Mistral, and Together AI appear as onboarding provider options but were not included in earlier versions of the provider plugin map. If you selected one of these providers during onboarding and the env var is set (e.g., `DEEPSEEK_API_KEY`), the corresponding plugin will auto-load via `AUTH_PROVIDER_PLUGINS`. If you want to load one of these providers without setting an env var, add it to `plugins.allow` in `eliza.json` explicitly:

```json
{
  "plugins": {
    "allow": ["deepseek", "mistral", "together"]
  }
}
```
</Note>

## Embedding Model

For vector memory, the embedding model defaults to:

```
nomic-embed-text-v1.5.Q5_K_M.gguf (768 dimensions)
```

Configured via `embedding.*` in `eliza.json`. See [Memory](/runtime/memory) for full embedding configuration.

## Related Pages

- [Memory](/runtime/memory) — embedding model configuration
- [Core Runtime](/runtime/core) — provider plugin loading
- [Configuration Reference](/configuration) — full config schema
