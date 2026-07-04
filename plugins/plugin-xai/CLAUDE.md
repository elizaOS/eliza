# @elizaos/plugin-xai

xAI Grok models for text generation and embeddings in elizaOS.

## Purpose / Role

Registers xAI's Grok family as the active model handlers for `TEXT_SMALL`,
`TEXT_LARGE`, and `TEXT_EMBEDDING` within an Eliza agent runtime. It is
**opt-in and auto-enabled** — the elizaOS plugin loader enables it automatically
when `XAI_API_KEY` or `GROK_API_KEY` is present in the environment (via
`auto-enable.ts`). No actions, providers, services, or evaluators are added;
this plugin is purely a model-handler registration. For X (Twitter) social
interactions, use `@elizaos/plugin-x` instead.

## Plugin Surface

This plugin registers **no actions, providers, services, or evaluators**. It
registers three model handlers:

| ModelType          | Handler            | Default model   |
| ------------------ | ------------------ | --------------- |
| `TEXT_SMALL`       | `handleTextSmall`  | `grok-3-mini`   |
| `TEXT_LARGE`       | `handleTextLarge`  | `grok-3`        |
| `TEXT_EMBEDDING`   | `handleTextEmbedding` | `grok-embedding` |

All handlers POST to the xAI OpenAI-compatible REST API (`/chat/completions`,
`/embeddings`). Streaming (`onStreamChunk`) is supported for both text handlers.
Tool-call plumbing (`tools`, `toolChoice`, `responseSchema`, `messages`) is
handled natively via `generateText` in `models/grok.ts`; callers that pass
those fields receive an `XaiNativeTextResult` shape rather than a plain string.
Token usage is emitted via `EventType.MODEL_USED` after every call; if the API
does not return usage data, it is estimated from character count.

## Layout

```
plugins/plugin-xai/
  index.ts              Plugin definition (XAIPlugin export, model handler wiring)
  index.node.ts         Node/Bun entry — re-exports index.ts
  index.browser.ts      Browser entry — re-exports index.ts
  auto-enable.ts        elizaos.plugin.autoEnableModule — lightweight env check
  models/
    grok.ts             All Grok logic: getConfig, generateText, createEmbedding,
                        handleTextSmall, handleTextLarge, handleTextEmbedding,
                        listModels, isGrokConfigured, tool-call normalization
    index.ts            Re-exports grok.ts
  __tests__/
    native-plumbing.shape.test.ts   Unit tests for tool-call normalization shapes
    error-policy.shape.test.ts      #12182 failure-path surfaces (typed errors, no fabricated completions)
    plugin.live.test.ts             Live API integration test (requires XAI_API_KEY)
  build.ts              Bun.build script (produces node ESM, browser ESM, CJS)
  vitest.config.ts      Vitest config
```

## Commands

All scripts from this plugin's `package.json`:

```bash
bun run --cwd plugins/plugin-xai build        # compile to dist/
bun run --cwd plugins/plugin-xai dev          # watch build (bun --hot)
bun run --cwd plugins/plugin-xai test         # vitest run
bun run --cwd plugins/plugin-xai typecheck    # tsgo --noEmit
bun run --cwd plugins/plugin-xai lint         # biome check
bun run --cwd plugins/plugin-xai format       # biome format --write
bun run --cwd plugins/plugin-xai format:check # biome format (check only)
bun run --cwd plugins/plugin-xai clean        # rm -rf dist .turbo
```

## Config / Env Vars

| Variable              | Required | Default                  | Description                              |
| --------------------- | -------- | ------------------------ | ---------------------------------------- |
| `XAI_API_KEY`         | one-of   | —                        | xAI API key. Checked first; falls back to `GROK_API_KEY`. |
| `GROK_API_KEY`        | one-of   | —                        | Alias accepted by both auto-enable and `getConfig`; used if `XAI_API_KEY` is not set. |
| `XAI_MODEL`           | no       | `grok-3`                 | Large text model. Also aliased as `XAI_LARGE_MODEL`. |
| `XAI_SMALL_MODEL`     | no       | `grok-3-mini`            | Small text model.                        |
| `XAI_EMBEDDING_MODEL` | no       | `grok-embedding`         | Embedding model.                         |
| `XAI_BASE_URL`        | no       | `https://api.x.ai/v1`   | API base URL (useful for proxies).       |

*At least one of `XAI_API_KEY` / `GROK_API_KEY` is required. Both keys are
accepted by `getConfig` in `models/grok.ts` (`XAI_API_KEY ?? GROK_API_KEY`),
so either key is sufficient for model calls.

Read via `runtime.getSetting(key)` — not `process.env` directly.

## How to Extend

**Add a new model type handler** (e.g. `TEXT_TOKENIZE`):

1. Implement the handler function in `models/grok.ts` following the pattern of
   `handleTextSmall` / `handleTextLarge`.
2. Export it from `models/index.ts`.
3. Register it in the `models` map in `index.ts`:
   ```ts
   [ModelType.TEXT_TOKENIZE]: handleTextTokenize,
   ```
4. Add the corresponding capability string to the `elizaos.plugin.capabilities`
   array in `package.json` if a standard name exists.

**Add a provider or action** — this plugin intentionally has none. If you need
runtime context exposure or conversation-level actions, consider adding a
separate plugin rather than bloating this model-only plugin.

## Conventions / Gotchas

- **`XAI_API_KEY` and `GROK_API_KEY` are both accepted.** `getConfig` in
  `models/grok.ts` reads `XAI_API_KEY ?? GROK_API_KEY`, so either key works for
  model calls as well as auto-enable.
- **Native vs. string return.** `generateText` returns `XaiNativeTextResult`
  when `messages`, `tools`, `toolChoice`, or `responseSchema` are passed. The
  handler's TypeScript signature says `Promise<string | TextStreamResult>` to
  satisfy the elizaOS `ModelHandler` type, but callers passing those fields
  receive the native shape. Do not widen the return type — the elizaOS plugin
  contract does not support it.
- **Streaming.** Pass `stream: true` and `onStreamChunk` together. The handler
  returns the accumulated `fullText` string, not a stream object.
- **No native SDK dependency.** This plugin calls the xAI REST API directly
  with `fetch` — there is no `openai` or `xai-sdk` npm package involved. This
  keeps the bundle small and browser-compatible.
- **Dual build targets.** The package exports separate `browser` and `node`
  builds (see `exports` in `package.json`). Both resolve to the same `index.ts`
  logic since `fetch` is available in both environments.
- For repo-wide logger rules, naming, and architecture commandments, see the
  root `AGENTS.md`.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → `.github/issue-evidence/<issue#>-<slug>.<ext>`; attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — model provider:**
- A trajectory from a **live** call to this provider (not the proxy, not a mock): full request, raw response, token usage, finish reason, and streamed chunks.
- Proof of tool/function-calling and structured-output parsing against the real model.
- The error paths exercised: bad key, model-not-found, oversized context, timeout, rate-limit, mid-stream disconnect — plus latency and cost from the real call.
- If no key is available in CI, attach the documented live-run transcript as evidence — never a mocked client passed off as a pass.
<!-- END: evidence-and-e2e-mandate -->
