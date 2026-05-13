# Ollama Plugin

This plugin connects [Ollama](https://ollama.com/) to ElizaOS so agents can use **local** LLMs for text, embeddings, and JSON object generation—without sending prompts to a third-party API.

## Why this plugin exists

- **Privacy and compliance:** All inference can stay on your LAN or laptop.
- **Cost:** No per-token cloud billing for experimentation.
- **Offline / air-gapped:** Works wherever Ollama runs, including containers and remote servers.

## Requirements

- [Ollama](https://ollama.com/) installed and reachable (same machine or network).
- ElizaOS runtime with this package enabled.
- At least one Eliza-1 model created, e.g. `ollama create eliza-1-2b -f packages/training/cloud/ollama/Modelfile.eliza-1-2b-q4_k_m`.

## Installation

```bash
bun add @elizaos/plugin-ollama
```

Ensure Ollama is running:

```bash
ollama serve
```

Register the plugin on your character / app config (exact shape depends on your ElizaOS version):

```json
"plugins": ["@elizaos/plugin-ollama"]
```

## Architecture: Vercel AI SDK + `ollama-ai-provider-v2`

Handlers use **`generateText`** (completion, structured generation, and non-streaming fallbacks for schema-only stream contexts or toolChoice-only requests), **`streamText`** (plain SSE chat **or** `stream: true` **with native tools**), **`generateObject`**, and **`embed`** from the **`ai`** package, backed by **`ollama-ai-provider-v2`**.

## Streaming chat (`TextStreamResult`)

When **`useModel`** is invoked with **`stream: true`** during an SSE reply, `AgentRuntime` only iterates **`textStream`** and forwards chunks if the model handler returns a **`TextStreamResult`** (see `isTextStreamResult` in `packages/core/src/runtime.ts`). **Why:** returning a bare **`string`** skips that branch entirely—tokens still generate, but the UI and conversation routes can log **“no streamed text”** because no chunks were delivered.

This plugin returns **`TextStreamResult`** from **`streamText`** when **`stream: true`** and either:

- **Plain chat:** no **`responseSchema`**, **tools**, or **`toolChoice`** — every text delta is yielded to **`textStream`** (normal SSE).
- **Native tools:** **tools** are present — Ollama streams the chat request with tools on the wire. For **`RESPONSE_HANDLER`** / **`ACTION_PLANNER`**, **`useModel`**’s streaming path concatenates only **`textStream`** chunks into the string passed to **`parseMessageHandlerOutput`**, so this adapter **drains** model text deltas internally and **yields a single trailing chunk** of the first tool’s **`arguments`** JSON (the v5 plan). **Why:** prepending arbitrary streamed text would break **`JSON.parse`** on that accumulated string. Other **`TEXT_*`** types forward all text chunks and attach **`toolCalls`** on the result (parity with OpenAI/OpenRouter).

**Still `generateText`:** **`stream: true`** with **`responseSchema`** only (no tools), e.g. nested **`FACT_EXTRACTOR`** during SSE — **`stream` may still be true** on params; we **do not throw** and we **log at debug** because structured **`format: json`** is not wired through **`streamText`** here.

**Still `generateText`:** **`stream: true`** with **`toolChoice`** but **no** resolved **`ToolSet`** on the wire — **log at debug**, then **`generateText`**. **Why:** the AI SDK’s **`streamText`** path used here expects **`tools`** in the same request; `toolChoice` alone is invalid for streaming and is not produced by core v5 (Stage 1 always passes tools with `toolChoice`).

### Streaming routing (quick reference)

| `stream` | `tools` on wire | `responseSchema` / `toolChoice` | Path | Why |
|----------|-----------------|----------------------------------|------|-----|
| `true` | yes | (any; schema dropped if both) | **`streamText`** + tools | Same surface as other provider plugins; Ollama v2 supports tools on streaming `/api/chat`. |
| `true` | no | no schema, no `toolChoice` | **`streamText`** plain | **`TextStreamResult`** so `useModel` can forward SSE chunks. |
| `true` | no | schema only | **`generateText`** | Structured **`format`** is not implemented on **`streamText`** in this adapter; nested schema calls must not throw. |
| `true` | no | `toolChoice` only | **`generateText`** | **`streamText`+tools** requires a tool set; log explains misconfiguration. |
| `false` / absent | (any) | (any) | **`generateText`** (or structured serialize) | Normal completion path; Stage 1 without inherited streaming uses this. |

### Why `ollama-ai-provider-v2` (not the old `ollama-ai-provider`)

ElizaOS tracks **AI SDK 5/6**. Older `ollama-ai-provider` exposed **model specification v1**; current `ai` only accepts **v2+** models and throws:

`Unsupported model version v1 for provider "ollama.chat"`.

The v2 provider implements the same provider contract as the rest of the ecosystem, so local Ollama behaves like other LLM backends from Eliza’s perspective.

See **`CHANGELOG.md`** for the full migration note.

## Configuration

Environment variables (or character `settings` with the same keys—**why:** lets you override per-agent without touching global `.env`):

| Variable | Default | Purpose |
|----------|---------|---------|
| `OLLAMA_API_ENDPOINT` | `http://localhost:11434` (normalized to `…/api`) | Ollama HTTP API base. |
| `OLLAMA_SMALL_MODEL` / `SMALL_MODEL` | `eliza-1-2b` | Small / fast text model. |
| `OLLAMA_LARGE_MODEL` / `LARGE_MODEL` | `eliza-1-4b` | Larger text model. |
| `OLLAMA_EMBEDDING_MODEL` | `eliza-1-2b` | Embedding model id. |
| `OLLAMA_DISABLE_STRUCTURED_OUTPUT` | _unset_ | If `1` / `true` / `yes` / `on`, **disables** JSON-schema structured text (see below). |

Optional model overrides: `OLLAMA_NANO_MODEL`, `OLLAMA_MEDIUM_MODEL`, `OLLAMA_MEGA_MODEL`, `OLLAMA_RESPONSE_HANDLER_MODEL`, `OLLAMA_ACTION_PLANNER_MODEL` (see `utils/config.ts`). **Why separate keys:** v5 Stage 1 (`RESPONSE_HANDLER`) is tool-heavy—you may want a larger tag than `TEXT_SMALL` without paying that cost on every `TEXT_LARGE` reply; planners often default to medium-sized models for latency.

### Example `.env`

```
OLLAMA_API_ENDPOINT=http://localhost:11434/api
OLLAMA_SMALL_MODEL=eliza-1-2b
OLLAMA_LARGE_MODEL=eliza-1-4b
OLLAMA_EMBEDDING_MODEL=eliza-1-2b
```

### Example `settings` block

```json
{
  "settings": {
    "OLLAMA_API_ENDPOINT": "http://localhost:11434/api",
    "OLLAMA_SMALL_MODEL": "eliza-1-2b",
    "OLLAMA_LARGE_MODEL": "eliza-1-4b",
    "OLLAMA_EMBEDDING_MODEL": "eliza-1-2b"
  }
}
```

## Structured output (`responseSchema`)

Eliza core passes **`responseSchema`** on text model calls when it needs **machine-parseable JSON** (e.g. fact extraction ops, structured planner/evaluator outputs).

This plugin maps that to the AI SDK’s **`Output.object({ schema: jsonSchema(...) })`**, which the Ollama provider turns into Ollama’s **`format`** field (`json` or JSON Schema, depending on Ollama version and request).

**Why it matters:** Without this path, those calls **failed** under Ollama and features silently degraded (warnings in logs, no memory updates).

**Caveats:**

- Quality depends on the **model**; small local models may still emit invalid JSON.
- **`stream: true` with `responseSchema`:** Core may set `stream` from an active chat streaming context even for nested calls (e.g. `FACT_EXTRACTOR`). The adapter **does not throw**; it runs **non-streaming** `generateText` with your schema. **Why:** the handler never used `streamText` for structured calls; rejecting only surfaced as spurious failures during SSE replies.

### Disabling structured output: `OLLAMA_DISABLE_STRUCTURED_OUTPUT`

Set to `1`, `true`, `yes`, or `on` if:

- Ollama errors or hangs on `format` / schema requests, or
- A specific model returns prose instead of JSON.

**Effect:** `responseSchema` is **stripped**; generation runs as plain text. Callers that require JSON may then fail parsing—**why:** this is an intentional escape hatch for operators, not a silent “fix” for broken prompts.

## Model handlers

| Model type | Role |
|------------|------|
| `TEXT_*` | Chat / completion-style text. |
| `TEXT_EMBEDDING` | Vector embeddings. |
| `OBJECT_*` | `generateObject` with `output: "no-schema"` (best-effort JSON object). |
| `RESPONSE_HANDLER` / `ACTION_PLANNER` | Same text path; v5 Stage 1 uses **messages + tools + `toolChoice`**; other pipelines may use **`responseSchema`** for JSON. |

### Text example

```js
const text = await runtime.useModel(ModelType.TEXT_LARGE, {
  prompt: "Explain quantum tunneling briefly.",
  maxTokens: 8192,
  temperature: 0.7,
});
```

### Embedding example

```js
const embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
  text: "hello world",
});
```

## Chat messages, native tools, and `toolChoice` (v5)

ElizaOS v5 can call text models with **`messages`** (chat turns), **`tools`** (function / tool definitions), and **`toolChoice`** (for example `"required"` on the message-handler stage so the model must emit a planner tool call).

This plugin forwards those fields to the Vercel AI SDK **`generateText`** or **`streamText`** (when **`stream: true`** and tools are present) backed by **`ollama-ai-provider-v2`**, and when the call is “native shaped” (messages, tools, tool choice, or structured output), it may return a **`GenerateTextResult`-like object at runtime** or a **`TextStreamResult`** with **`toolCalls`** — TypeScript still types `useModel` text handlers as `string` for historical reasons.

**Why cast instead of changing core types everywhere:** OpenRouter and OpenAI adapters already use the same pattern—core’s v5 parser (`parseMessageHandlerNativeToolCall`, trajectory recording) expects **`toolCalls`** with `id` / `name` / `arguments` compatible fields. Matching that contract keeps Ollama on the same code path as cloud providers.

**Tool definitions:** Core usually passes **`ToolDefinition[]`** (array). Callers may also pass an AI SDK **`ToolSet`** object; both are accepted. Array entries are normalized to `jsonSchema(...)` parameters the way the OpenAI plugin does (without Cerebras-only name/schema tweaks).

**When both `tools` and `responseSchema` are set:** The adapter **drops structured output for that request** and keeps tools. **Why:** `generateText` cannot reasonably combine native tool calling and `Output.object` in one call for all models; v5 Stage 1 needs tools, so schema-backed structured output loses that race by design.

**Streaming flag:** See **Streaming routing** above. In prose: **tools + `stream: true`** prefer **`streamText`**; **schema-only + `stream: true`** stays on **`generateText`**; **plain chat + `stream: true`** returns **`TextStreamResult`** from **`streamText`** (same contract as OpenRouter).

### Known limitations

- **`providerOptions`** from `GenerateTextParams` are **not** merged into the Ollama `generateText` call yet. Core may attach cache-budget metadata for other providers; Ollama ignores those fields here until we wire them explicitly.
- **Tool quality is model-dependent.** Some local models ignore tools or emit invalid tool JSON; try a stronger tag (e.g. tool-friendly instruct models) or route through OpenAI-compatible Ollama (`/v1`) with another plugin if you need battle-tested tool UX.

## Troubleshooting

| Symptom | Likely cause | Mitigation |
|---------|----------------|------------|
| Chat UI empty / “no streamed text” with Ollama | Handler returned a string while `stream: true` | Fixed in current adapter: plain chat uses **`streamText`** → **`TextStreamResult`**. Schema-only streaming still uses **`generateText`**; tool calls with **`stream: true`** use **`streamText`** (planner types may only emit one trailing plan chunk on **`textStream`**). |
| `Unsupported model version v1` | Stale lockfile / wrong `ollama-ai-provider` | Run `bun install` at repo root; confirm dependency is `ollama-ai-provider-v2`. |
| `[Ollama] Native tools, toolChoice plumbing is not supported` (older builds) | Pre–native-tools adapter | Upgrade `@elizaos/plugin-ollama` to a build that forwards tools (see `CHANGELOG.md`). |
| `v5 messageHandler returned invalid MessageHandlerResult` | Model did not return the expected planner tool / JSON | Use a model with reliable tool calling; confirm `OLLAMA_RESPONSE_HANDLER_MODEL` is not too small for your prompt. |
| Fact / planner JSON errors | Model ignores schema | Try a stronger model; tighten prompts; or set `OLLAMA_DISABLE_STRUCTURED_OUTPUT=1` temporarily. |
| Debug: `toolChoice but no tools on wire` | `stream: true` with `toolChoice` but no `ToolSet` passed | Should not happen from core v5; if you see it, ensure `tools` and `toolChoice` are passed together. Adapter falls back to **`generateText`**. |
| **`streamText.textStream` failed** / **`AI_NoOutputGeneratedError`** / process exit after Ollama **500** | Ollama returned an error body (e.g. **insufficient system memory** for the model) during a **streaming** `/api/chat` call; AI SDK retried then failed. | Check logs for **`ollamaResponseBody`** (plugin now extracts it). Free RAM on the Ollama host, use a smaller model, or lower concurrency. Streaming errors occur while **`useModel`** consumes **`textStream`**, not only inside **`generateText`**. |
| Connection errors | Ollama not running or wrong URL | `curl` the `/api/tags` endpoint; fix `OLLAMA_API_ENDPOINT`. |

More context: [Ollama plugin docs](https://docs.eliza.ai/) (registry page: `plugin-registry/llm/ollama`).

## API reference

Ollama’s HTTP API: [Ollama API docs](https://github.com/ollama/ollama/blob/main/docs/api.md).

## Changelog

See **[CHANGELOG.md](./CHANGELOG.md)**.

## License

See [LICENSE](./LICENSE).
