# @elizaos/plugin-eliza-classic

Deterministic offline ELIZA-style pattern-matching model handlers for Eliza agents — no network, no LLM API key required.

## Purpose / role

This plugin replaces text/planning inference calls with deterministic keyword-pattern responses modelled after the 1966 ELIZA chatbot. It does not register embeddings; load a real embedding provider when retrieval or knowledge search is enabled. Use it as a zero-cost fallback, for testing agent pipelines, or when a real LLM backend is unavailable.

The plugin is **opt-in** — add it to the agent's `plugins` array. It declares `priority: 200`, which is higher than most inference plugins, so it will win the model-handler election when loaded alongside a real LLM plugin unless that plugin declares a higher priority.

## Plugin surface

Registered in the `elizaClassicPlugin` / `plugin` export. No actions, providers, evaluators, services, routes, or events. Only model handlers:

| Model type | Handler |
|---|---|
| `TEXT_NANO`, `TEXT_SMALL`, `TEXT_MEDIUM`, `TEXT_LARGE`, `TEXT_MEGA` | `handleText` — pattern-matches user turn, returns ELIZA-style JSON response |
| `RESPONSE_HANDLER` | `handleText` |
| `ACTION_PLANNER` | `handleText` |
| `TEXT_COMPLETION` | `handleText` |

`handleText` extracts the last user turn from the prompt using a `User:|Human:|You:` regex, runs it through `generateElizaResponse`, and returns a structured JSON string with `thought`, `actions: ["REPLY"]`, `providers: []`, `text`, and `useKnowledgeProviders: false`.

## Layout

```
plugins/plugin-eliza-classic/
  index.ts              All plugin logic: pattern table, generateElizaResponse,
                        getElizaGreeting, handleText,
                        elizaClassicPlugin export
  index.browser.ts      Browser entry — re-exports everything from index.ts
  scripts/build.mjs     Bun.build script; also hand-writes dist/index.d.ts
  tsup.config.ts        tsup config (used by `dev` watch script)
  tsconfig.json         Extends repo root tsconfig; noEmit only
  dist/                 Compiled ESM (index.js, index.browser.js, *.d.ts, *.map)
```

All logic lives in `index.ts`. There are no subdirectories.

## Commands

```bash
bun run --cwd plugins/plugin-eliza-classic build        # Bun.build → dist/
bun run --cwd plugins/plugin-eliza-classic dev          # tsup watch
bun run --cwd plugins/plugin-eliza-classic clean        # rm -rf dist .turbo
bun run --cwd plugins/plugin-eliza-classic typecheck    # tsgo --noEmit
```

`lint` and `test` are no-ops in this package.

## Config / env vars

None. This plugin has no environment variables or runtime config. It is fully deterministic and requires only `@elizaos/core` as a peer dependency.

## How to extend

**Add a new keyword pattern** — edit the `responses` array in `index.ts`. Each entry is `{ pattern: RegExp, response: string }`. Patterns are tested in order; the first match wins. The catch-all `/.*/` must remain last.

**Add an action or provider** — follow the root [AGENTS.md](../../AGENTS.md) conventions for authoring actions/providers, then add them to the `elizaClassicPlugin` object:

```ts
export const elizaClassicPlugin: Plugin = {
  name: "eliza-classic",
  // ...existing fields...
  actions: [myAction],
  providers: [myProvider],
};
```

**Add a new model type** — import the new `ModelType` variant from `@elizaos/core` and add an entry to the `models` map pointing at `handleText` or a new handler.

After any source change, rebuild:

```bash
bun run --cwd plugins/plugin-eliza-classic build
```

## Conventions / gotchas

- **Build script is custom.** `scripts/build.mjs` uses `Bun.build` (not tsup) and hand-writes `dist/index.d.ts` from a template string. If you add new exported symbols, update the declaration template in that script or the types will be stale.
- **`dev` script uses tsup**, not the custom build script. The two outputs are equivalent for the compiled JS but the `dev` watcher regenerates `.d.ts` via tsup's own dts pipeline.
- **Browser entry is a thin re-export.** `index.browser.ts` just re-exports `index.ts`; no browser-specific divergence exists today. Keep it that way unless a genuine browser/Node difference arises.
- **Priority 200 wins.** If this plugin is registered alongside a real LLM plugin with a lower priority, all inference will be handled by ELIZA pattern matching. Confirm load order when debugging unexpected offline behaviour.
- **No embedding handler.** ELIZA Classic is text/planning only. Do not add a fake embedding handler; use a real embedding provider for semantic retrieval.
- **No src/ subdirectory.** Source files live directly at the package root, not under `src/`.
