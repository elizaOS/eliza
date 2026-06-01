# @elizaos/plugin-benchmarks

Canonical elizaOS Action wrappers for benchmark tool vocabularies (vending-bench, webshop, OSWorld, tau-bench, visualwebbench).

## Purpose / role

This plugin adds a fixed, stable set of elizaOS actions that mirror the tool vocabularies of five standard agent evaluation benchmarks. Each action captures benchmark-specific parameters in a structured, typed form so that fine-tuning on benchmark traces produces consistent action names regardless of which benchmark the trace came from. The plugin is opt-in — include `benchmarksPlugin` in the `plugins` array of an `AgentRuntime` to enable it.

## Plugin surface

The exported plugin object `benchmarksPlugin` registers **37 actions total** — five umbrella actions promoted into per-subaction virtuals via `promoteSubactionsToActions` from `@elizaos/core`:

| Umbrella action | Subactions (promoted as `<UMBRELLA>_<SUBACTION>`) | Count |
|---|---|---|
| `VENDING_MACHINE` | `view_state`, `view_suppliers`, `place_order`, `restock_slot`, `set_price`, `collect_cash`, `update_notes`, `check_deliveries`, `advance_day` | 1 + 9 |
| `WEBSHOP` | `search`, `click`, `select_option`, `back`, `buy` | 1 + 5 |
| `OSWORLD` | `click`, `double_click`, `right_click`, `type`, `key`, `scroll`, `drag`, `screenshot`, `wait`, `done`, `fail` | 1 + 11 |
| `TAU_BENCH_TOOL` | None (tool_name is free-text, not an enum; no virtuals promoted) | 1 |
| `VISUALWEBBENCH_TASK` | `web_caption`, `webqa`, `heading_ocr`, `element_ocr`, `element_ground`, `action_prediction`, `action_ground` | 1 + 7 |

No providers, services, evaluators, routes, or events are registered.

## Layout

```
plugins/plugin-benchmarks/
  index.ts                     Re-exports from src/index
  src/
    index.ts                   Plugin assembly — imports actions, calls promoteSubactionsToActions, exports benchmarksPlugin
    actions/
      vending-machine.ts       VENDING_MACHINE action (vending-bench)
      webshop.ts               WEBSHOP action (WebShop benchmark)
      osworld.ts               OSWORLD action (OSWorld desktop-control benchmark)
      tau-bench.ts             TAU_BENCH_TOOL action (tau-bench retail/airline tools)
      visualwebbench.ts        VISUALWEBBENCH_TASK action (VisualWebBench vision tasks)
  __tests__/
    plugin.test.ts             Vitest suite — verifies action counts, umbrella names, promoted virtuals
  build.ts                     Build script (Bun.build)
  vitest.config.ts             Test config
  package.json
```

## Commands

All scripts are defined in `package.json` and scoped to this package:

```bash
bun run --cwd plugins/plugin-benchmarks build       # compile to dist/
bun run --cwd plugins/plugin-benchmarks dev         # hot-rebuild during development
bun run --cwd plugins/plugin-benchmarks test        # run vitest suite
bun run --cwd plugins/plugin-benchmarks typecheck   # tsgo --noEmit
bun run --cwd plugins/plugin-benchmarks lint        # biome check --write --unsafe
bun run --cwd plugins/plugin-benchmarks lint:check  # biome check (read-only)
bun run --cwd plugins/plugin-benchmarks format      # biome format --write
bun run --cwd plugins/plugin-benchmarks clean       # rm -rf dist .turbo
```

## Config / env vars

None. This plugin reads no environment variables and has no runtime configuration. It is purely a vocabulary shim — real benchmark execution happens in the benchmark harness environment, not inside the action handlers.

## How to extend

### Add a new benchmark action

1. Create `src/actions/<bench-name>.ts`. Export a named `Action` constant.
   - If the benchmark has a fixed set of operations, use a `const` enum array for the `action` parameter and call `promoteSubactionsToActions` in `src/index.ts`.
   - If operations are dynamic (like tau-bench), register the action directly without promotion.
2. Add the import and export to `src/index.ts`.
3. Add the action (or its promoted virtuals) to the `actions` array in `benchmarksPlugin`.
4. Add a test case in `__tests__/plugin.test.ts` covering the umbrella name, promoted virtual names, and expected action count.

### Add a subaction to an existing benchmark

1. Add the subaction name to the `const` array in the relevant `src/actions/*.ts` file (e.g., `VENDING_SUBACTIONS`).
2. Update the `parameters[0].schema.enum` accordingly — the array spread keeps them in sync automatically.
3. Update the expected count in `__tests__/plugin.test.ts`.

## Conventions / gotchas

- **Handlers are stubs.** Every action handler returns `success: true` with the structured parameters passed through as `data`. The actual benchmark operation is performed by the external benchmark environment, not by the handler. Do not add real side effects here.
- **`promoteSubactionsToActions`** from `@elizaos/core` reads the first parameter's `schema.enum` array and generates one virtual `Action` per entry, named `<UMBRELLA>_<SUBACTION_UPPERCASED>`. The umbrella action itself is also included. Tau-bench skips promotion because `tool_name` has no enum.
- **`subActions` is mutated by `promoteSubactionsToActions`.** After calling it, the umbrella action's `subActions` array is populated (9 for vending, 5 for webshop, 11 for OSWorld, 7 for visualwebbench). Tests assert these counts.
- **No external dependencies** beyond `@elizaos/core`. No native addons, no network calls, no file I/O.
- **Total action count is 37.** Tests assert this — update the assertion whenever actions are added or removed.
- See the root `AGENTS.md` for repo-wide architecture rules, logger conventions, ESM constraints, and naming standards.
