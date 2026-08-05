# Changelog

All notable changes to `@elizaos/plugin-ollama` are documented here.
This project follows [Semantic Versioning](https://semver.org/) where the published package uses it; monorepo consumers may pin `workspace:*`.

## [Unreleased]

### Added

- **Native `messages`, `tools`, and `toolChoice` for text** — v5 `RESPONSE_HANDLER` / planner paths call `useModel` with chat messages and optional tools (e.g. `toolChoice: "required"`). When **`stream`** is off (or no streaming context), the adapter uses **`generateText`** and returns a **`GenerateTextResult`-shaped** object (cast to `string` for the handler contract), matching OpenRouter/OpenAI so **`parseMessageHandlerNativeToolCall`** can read planner output. When **`stream: true`** and a **tool set** is present, the adapter uses **`streamText`** (see **`streamText` with native tools** below). If both tools and `responseSchema` are supplied, tools take precedence and structured output is omitted for that request.

- **Structured text output (`responseSchema`)** — Text handlers now map Eliza’s `responseSchema` (JSON Schema objects or full AI SDK output specs) to the Vercel AI SDK `Output.object` path, which `ollama-ai-provider-v2` translates to Ollama’s `format: "json"` / schema request body.
  **Why:** Core features such as `FACT_EXTRACTOR`, planner/evaluator pipelines, and trajectory-aware prompts call `useModel` with a schema. Without this path, those calls threw and silently skipped work when Ollama was the active provider.

- **`OLLAMA_DISABLE_STRUCTURED_OUTPUT`** — When set to `1`, `true`, `yes`, or `on` (case-insensitive), the plugin strips `responseSchema` before generation and uses plain text only.
  **Why:** Some local models or older Ollama builds return malformed JSON, hang, or error on strict `format` requests. Operators need a single switch to fall back to unstructured generation without swapping providers.

- **Plain-text SSE (`streamText` → `TextStreamResult`)** — When `stream: true` and the request has no `responseSchema`, tools, or `toolChoice`, text handlers return **`TextStreamResult`** so `AgentRuntime.useModel` can forward chunks. **Why:** core only enters the streaming branch when the return value satisfies `isTextStreamResult`; a bare string produced successful generations with empty streamed UIs.

- **`streamText` with native tools** — When `stream: true` and **tools** are present, text handlers use **`streamText`** (same AI SDK surface as OpenAI/OpenRouter) instead of buffering with **`generateText`**. **`RESPONSE_HANDLER`** / **`ACTION_PLANNER`** drain SDK text deltas and yield one **`textStream`** chunk of the first tool’s plan JSON so **`parseMessageHandlerOutput`** still succeeds after **`useModel`** concatenation; other model types forward all text chunks and expose **`toolCalls`** on the stream result. **Why:** Ollama’s v2 provider supports tools on the streaming `/api/chat` path; Stage 1 often runs with `stream: true` from inherited SSE context and needs a parseable accumulated string.

### Documentation

- **README**, **registry** (`packages/docs/plugin-registry/llm/ollama.md`), and **inline module comments** (`models/text.ts`, `utils/ai-sdk-wire.ts`, `plugin.ts`) spell out *why* v5 tools, structured output, **`stream` vs `streamText`**, **`TextStreamResult`** / SSE behavior, and `OLLAMA_*` overrides behave the way they do.

- **`streamText` + tools** — README (**Streaming routing** table) and registry docs describe plain vs tool streaming, planner **single-chunk** `textStream` behavior, schema-only **`generateText`**, and **`toolChoice` without tools** (debug + fall back). **`models/text.ts`** and **`plugin.ts`** comments explain *why* each branch exists.

### Changed

- **Dependency: `ollama-ai-provider-v2` replaces `ollama-ai-provider`** — The v1 package exposed AI SDK “model spec v1” objects; Eliza ships `ai@^6`, which requires v2-compatible providers and produced `Unsupported model version v1 for provider "ollama.chat"`.
  **Why:** Staying on the supported provider surface avoids runtime failures and keeps parity with other first-party plugins that use `generateText` / `generateObject` from the same `ai` major line.

- **Text adapter polish** — `shouldReturnNative` is derived only after the final structured-output decision (so tools + `responseSchema` cannot disagree with what we send). Empty `stopSequences` are omitted on the wire; `renderChatMessagesForPrompt` runs only on the prompt fallback path; usage fallback uses serialized chat messages when the messages path is used, and native-shaped results now include normalized usage.

- **Streaming branch ordering** — When **`stream: true`**, the handler evaluates **`tools`** first (**`streamText`+tools**), then plain **`streamText`**, then schema-only and **`toolChoice`-without-tools** paths with explicit **debug** logs. **Why:** avoids nesting **`streamText`+tools** under “no `toolChoice`” checks and makes misconfiguration visible instead of silently falling through to **`generateText`**.

- **Richer errors on Ollama failures** — `models/text.ts` logs **`ollamaResponseBody`**, **`httpStatus`**, **`requestUrl`**, and **`attemptErrors`** (from AI SDK retries) for **`generateText`** and when **`streamText`** fails while **`textStream`** is consumed. **Why:** Ollama often returns actionable JSON (e.g. insufficient RAM) on **HTTP 500**; the default error string was only “Internal Server Error”, and streaming failures happened outside the handler’s outer **`try`/`catch`**, so logs were easy to miss before the process exited.

### Fixed

- **AI SDK 5/6 compatibility** — Generation no longer fails immediately with “Unsupported model version v1” for any Ollama model id when using current `ai` + `ollama-ai-provider-v2`.

- **v5 `RESPONSE_HANDLER` with Ollama** — Stage 1 previously threw `[Ollama] Native tools, toolChoice plumbing is not supported by this adapter yet` because core passes `messages`, `tools`, and `toolChoice: "required"`. The text adapter now wires those into `generateText` and returns a native-shaped result so message-handler parsing matches OpenRouter/OpenAI. **Why it broke before:** the adapter intentionally rejected any native tool plumbing until the AI SDK + Ollama provider path was implemented end-to-end.

- **Structured calls during streaming chat** — Removed hard errors when `stream: true` is set together with `responseSchema` or with tools / `toolChoice`. **Why:** `AgentRuntime.useModel` sets `stream` whenever a streaming context exists (e.g. SSE chat), including for nested calls like **`FACT_EXTRACTOR`** that still need JSON schema; the Ollama text path already used non-streaming `generateText` only, so throwing only broke those actions with a misleading “cannot be used together with stream” message.

---

## [2.0.0-beta.0] — prior baseline

- Text, object, and embedding handlers via legacy `ollama-ai-provider`.
- No `responseSchema` support in the text adapter (native tools / schema calls threw).
