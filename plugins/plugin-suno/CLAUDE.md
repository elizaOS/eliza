# @elizaos/plugin-suno

Suno AI music generation backend for Eliza agents — contributes a handler and status provider for the `MUSIC` umbrella action.

## Purpose / role

This plugin integrates the Suno AI API so Eliza agents can generate, custom-generate, and extend audio tracks. It is **opt-in**: it auto-enables when `SUNO_API_KEY` is present in the environment, or when `media.audio.provider === 'suno'` and `media.audio.mode === 'own-key'` in agent config. The plugin does not register its own top-level action; instead it exports `sunoGenerateMusicHandler` to be wired in by `@elizaos/plugin-music` (the MUSIC umbrella dispatcher).

## Plugin surface

**Providers**

| Name | File | Purpose |
|---|---|---|
| `SUNO_STATUS` | `src/providers/suno.ts` | Injects Suno availability into `media`-context turns. Reports `configured: true/false` and the available subactions (`generate`, `custom_generate`, `extend`). Scope: `turn`; contextGate: `{ anyOf: ['media'] }`. |

**Exported handler** (not a registered action — consumed by the MUSIC dispatcher)

| Export | File | Purpose |
|---|---|---|
| `sunoGenerateMusicHandler` | `src/actions/musicGeneration.ts` | Implements `generate`, `custom_generate`, and `extend` subactions against the Suno REST API. Infers subaction from params or message text when not explicit. |

**Class**

| Export | File | Purpose |
|---|---|---|
| `SunoProvider` | `src/providers/suno.ts` | HTTP client for `https://api.suno.ai/v1`. Reads `SUNO_API_KEY` from runtime settings. Wraps every fetch in `recordLlmCall` for observability. |

## Layout

```
plugins/plugin-suno/
  src/
    index.ts                   # Plugin object (sunoPlugin); re-exports handler + provider
    actions/
      musicGeneration.ts       # sunoGenerateMusicHandler — generate / custom_generate / extend
    providers/
      suno.ts                  # SunoProvider class + sunoStatusProvider + param interfaces
    types/
      index.ts                 # Duplicate param interfaces (GenerateParams, CustomGenerateParams,
                               #   ExtendParams, GenerationResponse) — canonical definitions
                               #   live in providers/suno.ts
    index.test.ts              # Plugin smoke tests
    suno.behavior.test.ts      # Behaviour/integration tests for SunoProvider and sunoGenerateMusicHandler
  auto-enable.ts               # shouldEnable() — read by the auto-enable engine at boot
  package.json
```

## Commands

Only scripts defined in this package's `package.json`:

```bash
bun run --cwd plugins/plugin-suno build        # tsup ESM build → dist/
bun run --cwd plugins/plugin-suno dev          # watch build
bun run --cwd plugins/plugin-suno test         # vitest run
bun run --cwd plugins/plugin-suno typecheck    # tsgo --noEmit
bun run --cwd plugins/plugin-suno lint         # biome check
bun run --cwd plugins/plugin-suno format       # biome format src/
bun run --cwd plugins/plugin-suno format:check # biome format check (no write)
bun run --cwd plugins/plugin-suno lint:fix     # biome check --write src/
```

## Config / env vars

| Var | Required | Where read | Notes |
|---|---|---|---|
| `SUNO_API_KEY` | Yes | `runtime.getSetting('SUNO_API_KEY')` in `SunoProvider.get()` | Must be a non-empty string; throws if missing |
| `media.audio.provider` | No | `ctx.config?.media?.audio?.provider` in `auto-enable.ts` | Set to `'suno'` to auto-enable without API key env var |
| `media.audio.mode` | No | `ctx.config?.media?.audio?.mode` in `auto-enable.ts` | Must be `'own-key'` alongside `provider: 'suno'` |

Default Suno base URL: `https://api.suno.ai/v1` (hardcoded; no env override).

## How to extend

**Add a new subaction** (e.g. `remix`):

1. Add `'remix'` to `SunoMusicSubaction` in `src/actions/musicGeneration.ts`.
2. Extend `normalizeSubaction()` to recognise the new string variants.
3. Add an inference branch in `inferSubaction()` if it can be detected from message text.
4. Add the endpoint dispatch block in `sunoGenerateMusicHandler` (set `endpoint` and build `body`).
5. Wire the new subaction into the MUSIC dispatcher in `@elizaos/plugin-music`.

**Add a new provider** (e.g. quota status):

1. Create `src/providers/<name>.ts` exporting a `Provider` object.
2. Import and add it to the `providers` array in `src/index.ts`.

## Conventions / gotchas

- **No registered action.** `sunoPlugin` has `providers` only; it registers no `actions`. The `sunoGenerateMusicHandler` export is intended for `@elizaos/plugin-music` to mount under the `MUSIC` action. Do not add a standalone Suno action without coordinating with that plugin.
- **`recordLlmCall` wrapping.** Every Suno HTTP request goes through `recordLlmCall` in `SunoProvider.request()`. This is required for cost/observability tracking — do not bypass it.
- **30 s timeout.** `SUNO_ACTION_TIMEOUT_MS = 30_000` aborts hung requests via `AbortController`. Suno generation can be slow; do not lower this without testing.
- **Response cap.** Responses larger than `MAX_SUNO_RESPONSE_BYTES = 4000` are truncated before being passed to the callback/ActionResult to avoid context bloat.
- **Duplicate type definitions.** `src/types/index.ts` duplicates the param interfaces already in `src/providers/suno.ts`. The provider file is the canonical location; `src/types/index.ts` is a legacy artefact that can be removed if the repo is cleaned up.
- **`auto-enable.ts` must stay lightweight.** The auto-enable engine imports this module for every installed plugin at boot. No service init, no transitive imports of the full plugin runtime.
- See the repo-wide `AGENTS.md` at the repo root for logging conventions, ESM rules, architecture commandments, and git workflow.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../AGENTS.md)**. Read it.
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

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — voice / audio:**
- Captured **audio** of the real round-trip (STT in, TTS out) plus the transcript, with a narrated walkthrough of what is happening.
- Latency, barge-in/interruption, and wake-word behavior measured on real audio — across platforms, not Linux-x64-synthetic only (see #9958).
- The model trajectory for any LLM turn inside the loop.
- Failure paths: no mic, silence, noise, overlapping speech, network drop mid-stream.
<!-- END: evidence-and-e2e-mandate -->
