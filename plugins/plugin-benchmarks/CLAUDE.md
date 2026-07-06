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

- **Handlers are pass-through adapters.** Every action handler returns `success: true` with the structured parameters passed through as `data`. The actual benchmark operation is performed by the external benchmark environment, not by the handler. Do not add real side effects here.
- **`promoteSubactionsToActions`** from `@elizaos/core` reads the first parameter's `schema.enum` array and generates one virtual `Action` per entry, named `<UMBRELLA>_<SUBACTION_UPPERCASED>`. The umbrella action itself is also included. Tau-bench uses the umbrella action directly because `tool_name` has no enum.
- **`subActions` is mutated by `promoteSubactionsToActions`.** After calling it, the umbrella action's `subActions` array is populated (9 for vending, 5 for webshop, 11 for OSWorld, 7 for visualwebbench). Tests assert these counts.
- **No external dependencies** beyond `@elizaos/core`. No native addons, no network calls, no file I/O.
- **Total action count is 37.** Tests assert this — update the assertion whenever actions are added or removed.
- See the root `AGENTS.md` for repo-wide architecture rules, logger conventions, ESM constraints, and naming standards.

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

**Capture & manually review for this package — eval / trajectory harness:**
- A live-model scenario run producing the JSON report + run viewer + native jsonl, with the trajectory **opened and reviewed**.
- The harness's own e2e tests against a real `AgentRuntime` — not a mocked runtime; assert **outcomes**, not routing (see #9970).
- Determinism/seed handling and the failure/partial-run reporting paths.
- The shape of the corpus/records emitted, inspected by hand.
<!-- END: evidence-and-e2e-mandate -->
