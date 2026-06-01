# @elizaos/plugin-suno

Suno AI music generation backend for Eliza agents — contributes a handler and status provider for the `MUSIC` umbrella action.

## Purpose / role

This plugin integrates the Suno AI API so Eliza agents can generate, custom-generate, and extend audio tracks. It is **opt-in**: it auto-enables when `SUNO_API_KEY` is present in the environment, or when `media.audio.provider === 'suno'` and `media.audio.mode === 'own-key'` in agent config. The plugin does not register its own top-level action; instead it exports `sunoGenerateMusicHandler` to be wired in by `@elizaos/plugin-music` (the MUSIC umbrella dispatcher).

## Plugin surface

**Providers**

| Name | File | Purpose |
|---|---|---|
| `SUNO_STATUS` | `src/providers/suno.ts` | Injects Suno availability into `media`-context turns. Reports `configured: true/false` and the available subactions (`generate`, `custom_generate`, `extend`). Scope: `turn`; contextGate: `media`. |

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
  auto-enable.ts               # shouldEnable() — read by the auto-enable engine at boot
  package.json
```

## Commands

Only scripts defined in this package's `package.json`:

```bash
bun run --cwd plugins/plugin-suno build        # tsup ESM build → dist/
bun run --cwd plugins/plugin-suno dev          # watch build
bun run --cwd plugins/plugin-suno test         # vitest run
bun run --cwd plugins/plugin-suno format       # biome format src/
bun run --cwd plugins/plugin-suno format:check # biome format check (no write)
bun run --cwd plugins/plugin-suno lint:fix     # biome check --write src/
```

`typecheck` and `lint` are no-ops (skipped for release).

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
