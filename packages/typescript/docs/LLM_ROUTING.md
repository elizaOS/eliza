# LLM routing in `@elizaos/core`: `useModel`, `dynamicPromptExecFromState`, and `PromptBatcher`

This document explains **how** the core chooses among LLM entry points and **why** each exists. It is the reference for contributors migrating call sites or debugging “wrong API” issues.

---

## The three layers (mental model)

| Entry point | What it drives | Typical outputs |
|-------------|----------------|-----------------|
| **`runtime.useModel(modelType, params)`** | Any registered model by **type** (text, embedding, vision, speech, transcription, …) | Varies: text stream/string, vectors, audio buffers, transcriptions |
| **`runtime.dynamicPromptExecFromState` (DPE)** | **Text generation** with a **schema**, validation/retry, optional streaming hooks | Parsed `Record<string, unknown>` matching the schema |
| **`runtime.promptBatcher`** | **Scheduling and packing** of structured sections; each dispatch ends in **DPE** | Same as DPE per section, plus drain metadata |

**Why three:** `useModel` is the low-level plugin bridge for *all* modalities. DPE adds *structured* text generation (formats, validation, metrics) on top of text models. The batcher adds *when* and *how many* LLM calls run (affinity, parallelism, packing) without changing the fact that **text structured output is still implemented via DPE** inside [`PromptDispatcher`](../src/utils/prompt-batcher/dispatcher.ts).

---

## When to use `useModel`

Use **`useModel`** when the work is **not** “plain structured text from a prompt + schema”:

- **`TEXT_EMBEDDING`** — vector output, not a chat completion.
- **`TEXT_TO_SPEECH`** — binary audio; see message service voice paths.
- **`IMAGE_DESCRIPTION`** — vision model with `imageUrl` / multimodal params.
- **`TRANSCRIPTION`** — audio/video input (URL or buffer), not a free-form text prompt.
- **Tokenizers, object models, custom plugin types** — whatever the plugin registered.

**Why not route these through DPE:** DPE is built around `GenerateTextParams`-style prompts and schema-parsed *text* fields. Vision, speech, and transcription use different `ModelType` values and parameter shapes; forcing them through DPE would blur types and duplicate plugin logic.

---

## When to use `dynamicPromptExecFromState` (DPE)

Use **DPE** for **agent-visible or pipeline-critical structured text**: replies, should-respond decisions, parameter repair, continuations, multi-step decision/summary, etc.

**Why DPE instead of raw `useModel(TEXT_*)`:**

- **Schema-first output** — field definitions, TOON/XML/JSON encapsulation options.
- **Validation and retries** — checkpoint codes, configurable levels, fewer silent parse failures.
- **Streaming** — optional field-level streaming for user-facing text.
- **Optimization hooks** — prompt naming, caching keys, DSPy-related paths where enabled.

**Optional `state`:** If you omit `state`, DPE uses an empty `State` so fixed prompts still work without message context.

---

## When to use `PromptBatcher` / `askNow`

**`PromptBatcher`** registers **sections** (once, per-drain, recurring). The **dispatcher** packs compatible sections into fewer `dynamicPromptExecFromState` calls (subject to token limits and model separation).

Use **`promptBatcher.askNow(...)`** for **one-shot, structured extractions** that benefit from the same scheduling and packing as the rest of the system (e.g. entity resolution, classifier, trigger extraction): stateless prompts with a schema, immediate priority.

**Why not use the batcher for everything:** Latency-sensitive, streaming-heavy paths (e.g. main reply in the message service) often call **DPE directly** so streaming and response ID semantics stay in one place. The batcher is ideal when **coordination** (parallelism limits, coalescing, affinity) matters more than avoiding every indirection.

**`selfContained` (via `askNow` when no `providers`):** If the preamble is already a full composed prompt, the batcher skips injecting default character context. **Why:** Avoids duplicating bio/style/topics tokens and keeps one-shot prompts closer to “compose once, send once.”

---

## Batcher behavior (WHY highlights)

- **`enabled` and `initPromise`:** The batcher becomes active after runtime initialization. **`once` / `immediate`** sections scheduled **before** init still get a drain scheduled on `initPromise` so awaiting `askNow` does not hang. **`per-drain`** sections do not use that pre-init path; they wait for normal drains. **Why:** Avoids duplicate drains for recurring sections while fixing the “registered too early” case for one-shots.
- **Single-section dispatch:** When a call plan has **one** section, the dispatcher uses a slimmer prompt (no multi-section preamble) and **no field namespacing** by section id. **Why:** Fewer tokens and simpler field names for the common `askNow` case; multi-section calls still prefix fields to avoid collisions.

---

## Message service (`services/message.ts`) — how it maps

| Concern | API |
|---------|-----|
| Should-respond LLM branch | DPE (`promptName: shouldRespond`) |
| Main reply, continuation, multi-step | DPE |
| **Parameter repair** (missing required action params) | DPE (`promptName: parameterRepair`, structured `params` field) |
| First-sentence / remainder **voice** | `useModel(TEXT_TO_SPEECH)` |
| **Image description** for attachments | `useModel(IMAGE_DESCRIPTION)` |
| **Audio/video transcription** | `useModel(TRANSCRIPTION)` |

**Why repair uses DPE:** Same validation/retry and structured parsing as the rest of the pipeline; repair runs only when actions declare required parameters but the first parse did not supply them.

---

## Settings

- **`BATCHER_MAX_PARALLEL`** — caps concurrent batcher-backed DPE calls (default `2` if unset/invalid). **Why:** Protects local or hosted inference from unbounded parallelism when many sections drain together.

---

## Related docs

- [DESIGN.md](./DESIGN.md) — message races, providers, and other core behavior.
- [CHANGELOG.md](../CHANGELOG.md) — dated / unreleased notes with per-change WHY.
- Code: [`IAgentRuntime`](../src/types/runtime.ts), [`PromptBatcher`](../src/utils/prompt-batcher/batcher.ts), [`PromptDispatcher`](../src/utils/prompt-batcher/dispatcher.ts), [`DefaultMessageService`](../src/services/message.ts).
