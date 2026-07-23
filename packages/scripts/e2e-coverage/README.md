# e2e coverage reports

Two complementary coverage reports live in this directory. Both read real
source statically (no runtime boot) and share `inventory.ts`.

1. **Surface coverage report (issue #8802)** — lists slash commands, pre-LLM
   shortcuts (#8791), plugin-declared HTTP routes, views, and their recorded
   e2e evidence.
2. **Per-plugin keyless-e2e report (issue #8801)** — lists plugins exposing an
   agent surface and whether a credential-free deterministic scenario covers
   each one.

---

## 1. Surface coverage report (issue #8802)

The report inventories every slash command, pre-LLM shortcut (#8791),
plugin-declared HTTP route, and view that ships a user-triggerable effect. It
records evidence and gaps without deriving a merge decision from a minimum,
baseline, or manifest count.

### Pieces

- **`inventory.ts`** — builds the canonical coverage matrix from real source:
  enumerates the served slash-command catalog (`getConnectorCommands`), the
  route-wiring plugins (`discoverRoutePlugins`), zero-test plugins
  (`discoverZeroTestPlugins`), the #8791 shortcut registry
  (`discoverShortcutRegistry`), and resolves each against the manifest with
  anti-larp signal verification (`resolveCoverage`). No runtime boot.
- **`manifest.ts`** — the committed source of truth: `PLUGIN_ROUTE_COVERAGE`
  (covered/exempt per route plugin), `COMMAND_COVERAGE`, `ZERO_TEST_EXEMPT`,
  `VIEW_COVERAGE_ARTIFACTS`, `LARP_TEST_ARTIFACTS`, `SHORTCUT_REGISTRY_HINTS`.
- **`write-coverage-matrix-report.ts`** — the report CLI →
  `reports/coverage/e2e-matrix.json` + an HTML contact sheet
  (`reports/coverage/viewer/`).

### What counts as coverage (anti-larp, issue §6)

A `covered` manifest entry only counts when:

1. every cited artifact file exists, and
2. each declared `signal` string appears in at least one artifact.

For new plugin-route tests the signal is **`tryHandleRuntimePluginRoute`** (or
`buildHonoAppForRuntime` for `routeHandler`-shaped routes) — the real prod
dispatch entry. A shape-only unit test that drives a handler with mocked
`json`/`error` functions never names it, so it cannot satisfy the gate. Known
shape-only tests (e.g. `packages/agent/src/api/commands-routes.test.ts`) are
listed in `LARP_TEST_ARTIFACTS` and are rejected outright if cited.

So a "test" that asserts only shape (`length > 0`, `kind === 'navigate'`)
without booting the real handler does **not** count — the gate requires a real
`api`/route/Playwright turn.

### Adding coverage metadata

- **New route-wiring plugin** → add a `routes-e2e.test.ts` that boots the real
  handler via `tryHandleRuntimePluginRoute` (see
  `plugins/plugin-mysticism/src/__tests__/routes-e2e.test.ts` for the reference
  pattern), then add a `covered(...)` entry in `manifest.ts`. The drift check
  fails until the manifest and the discovered wiring agree.
- **New slash command** → it is covered collectively by the full-catalog
  contract (`COMMAND_COVERAGE`); no per-command edit is needed because the
  real-server test + scenario assert the served set == `getConnectorCommands`.
- **New zero-test plugin** → add a real test, or a `ZERO_TEST_EXEMPT` entry with
  a written reason.
- **Shortcuts (#8791)** → the surface is empty/advisory until the registry lands
  at one of `SHORTCUT_REGISTRY_HINTS`; then it becomes required.

### Run

```bash
bun packages/scripts/e2e-coverage/write-coverage-matrix-report.ts --report-dir reports/coverage
```

---

## 2. Per-plugin keyless-e2e coverage report (issue #8801)

A plugin that exposes an agent surface — actions and/or a message connector —
but ships **zero keyless e2e coverage** appears in the uncovered section of the
report.

"Keyless e2e" = a scenario that runs on a PR under the deterministic LLM proxy
(`SCENARIO_USE_LLM_PROXY=1`) with **no credentials**:

- any scenario in `packages/scenario-runner/test/scenarios` (the deterministic
  corpus, which runs keyless by construction), or
- a scenario in the big `packages/test/scenarios` corpus tagged
  `lane: "pr-deterministic"`.

A plugin "has keyless e2e" when at least one such scenario names it in its
`requires.plugins`.

### Files

- `inventory.ts` — static (source-only, no plugin import) discovery of each
  checked-out plugin's surface (`hasActions` / `hasConnector`) and the keyless
  scenarios that require it (`inventoryPluginSurfaces`, `keylessScenariosByPlugin`,
  `buildPluginCoverage`).
- `check-e2e-coverage.ts` — emits covered and uncovered surface-plugin lists.
- `../__tests__/e2e-coverage-report.test.ts` — fixture-driven unit tests for
  inventory and report helpers
  partitioning.

### Run

```bash
bun run report:e2e-coverage
bun test packages/scripts/__tests__/e2e-coverage-report.test.ts
bun packages/scripts/e2e-coverage/check-e2e-coverage.ts --list-uncovered
bun packages/scripts/e2e-coverage/check-e2e-coverage.ts --json
```
