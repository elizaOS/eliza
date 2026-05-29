# Scenario Runner Deterministic PR Catalog

`bun run --cwd packages/scenario-runner test:pr:e2e` runs the zero-cost PR
catalog with `SCENARIO_USE_LLM_PROXY=1` and
`SCENARIO_LLM_PROXY_STRICT=1`:

- `deterministic-pr-smoke` covers the deterministic LLM proxy reply plus
  VIEWS manager, pin, detached window, and mounted-view interact flows.
- `deterministic-app-control-actions` covers VIEWS list, search, show, and
  broadcast plus APP list, launch, and relaunch.
- `deterministic-view-switching` covers every built-in view route through the
  VIEWS show action.
- `deterministic-app-control-nl-routing` covers natural-language APP/VIEWS
  routing with strict Stage 1 and planner fixtures, proving the real message
  runtime selects APP/VIEWS and then executes the real handlers without a live
  provider key.

The direct action scenarios assert handler parameters, `ActionResult` fields,
and exact loopback request/response ledgers. The natural-language scenario
asserts the same handler side effects after strict `RESPONSE_HANDLER` and
`ACTION_PLANNER` fixture JSON routes the message through the real runtime. The
shared `_helpers/app-control-http-stub.ts` wrapper prevents one scenario's
loopback stubs from leaking into the next.

Live-mode scenario execution remains separate:

```bash
bun run --cwd packages/scenario-runner test:live:e2e
```

That script intentionally does not set `SCENARIO_USE_LLM_PROXY`; the CLI still
requires a real provider key for live natural-language planner runs.

## Residual Gaps

- APP `create`, APP `load_from_directory`, VIEWS `create`, VIEWS `edit`, and
  VIEWS `delete` are still excluded. They need temp repo/plugin fixtures,
  coding-worker fakes, protected-app assertions, and strict registry routing
  before they can be reliable zero-key PR checks.
- Cross-plugin LifeOps/Gmail/calendar action flows remain live or mock-ledger
  coverage outside this PR catalog. They should not be promoted to zero-key
  deterministic PR scenarios until their action names and structured payloads
  are supplied by the strict registry.
- The scenario runtime currently removes `UPDATE_ENTITY` from
  `runtime.actions`, so entity-update realism is intentionally lower than a
  production runtime until action-selection ambiguity is resolved.
