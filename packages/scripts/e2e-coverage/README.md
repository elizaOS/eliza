# e2e coverage ship-gate (issue #8802)

The umbrella coverage gate: every slash command, pre-LLM shortcut (#8791),
plugin-declared HTTP route, and view that ships a real user-triggerable effect
must have a real recorded e2e — or a written exemption. A new one that ships
uncovered fails CI, following the exact precedent of
`packages/app/test/route-coverage.test.ts`.

## Pieces

- **`inventory.ts`** — builds the canonical coverage matrix from real source:
  enumerates the served slash-command catalog (`getConnectorCommands`), the
  route-wiring plugins (`discoverRoutePlugins`), zero-test plugins
  (`discoverZeroTestPlugins`), the #8791 shortcut registry
  (`discoverShortcutRegistry`), and resolves each against the manifest with
  anti-larp signal verification (`resolveCoverage`). No runtime boot.
- **`manifest.ts`** — the committed source of truth: `PLUGIN_ROUTE_COVERAGE`
  (covered/exempt per route plugin), `COMMAND_COVERAGE`, `ZERO_TEST_EXEMPT`,
  `VIEW_COVERAGE_GATES`, `LARP_TEST_ARTIFACTS`, `SHORTCUT_REGISTRY_HINTS`.
- **`../__tests__/e2e-coverage.test.ts`** — the enforced `bun test` gate.
- **`../check-e2e-coverage.ts`** — the report CLI →
  `reports/coverage/e2e-matrix.json` + an HTML contact sheet
  (`reports/coverage/viewer/`). Advisory by default; `--fail-on-missing` (or
  `E2E_COVERAGE_GATE_ENFORCE=1`) makes it exit non-zero on a blocking gap.

## What counts as coverage (anti-larp, issue §6)

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

## Adding coverage

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

## Advisory → required (issue §5)

The issue prescribes the gate "start advisory for one cycle (like
`coverage-gate.yml`), then flip to required once the baseline is green." So the
develop-landscape-sensitive ratchets (route-wiring drift, blocking gaps,
zero-test documentation) are **advisory by default** — they log a warning and
pass — and become hard failures under `E2E_COVERAGE_GATE_ENFORCE=1`. This keeps
a PR from going red merely because the develop base it merges against churned
its own plugin/test landscape (a sibling PR adding/removing a route plugin or a
plugin's first test). The stable structural checks (larp rejection, exemption
reasons, view gates, the command contract) stay hard regardless. Flip the gate
to required by setting `E2E_COVERAGE_GATE_ENFORCE=1` in the CI step once the
baseline holds steady on develop.

## Run

```bash
bun test packages/scripts/__tests__/e2e-coverage.test.ts            # advisory
E2E_COVERAGE_GATE_ENFORCE=1 bun test packages/scripts/__tests__/e2e-coverage.test.ts  # required
bun packages/scripts/check-e2e-coverage.ts --report-dir reports/coverage
```
