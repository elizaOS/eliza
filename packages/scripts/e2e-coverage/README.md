# Synthetic-world and e2e coverage gates

The canonical #22897 gate inventories every production-registered runtime
surface and gives every row an explicit synthetic-world disposition. The two
older #8801/#8802 projections remain available for compatibility.

## Canonical synthetic-world inventory (#22897)

`synthetic-world-inventory.ts` uses the TypeScript compiler graph to follow
real plugin registration objects through imports, factories, arrays, and
spreads. It inventories actions and promoted subactions, providers, services,
evaluators, event handlers, routes, views, model handlers, connector ingress
and egress, scheduled workers, queues, native bridges, and deployable Cloud
services. Cloud routes come from the generated production router plus explicit
manual Hono mounts; a dead `route.ts` file that is not mounted does not count.

Every discovered row must exist in `synthetic-world-manifest.json` with exactly
one status: `covered`, `exempt`, `platform-deferred`,
`provider-qualified-only`, or `unsupported-product`, and a written reason.
Covered rows additionally require an existing executable artifact and a
boundary-specific signal found in that artifact. This prevents unit shape tests
from being reported as E2E proof. Mock-only evidence remains `simulated`; it is
never promoted to provider qualification.

The manifest is an exact per-surface ratchet. A new registration fails CI, a
removed registration makes its disposition stale, and a covered artifact whose
signal disappears becomes invalid. `generate-synthetic-world-manifest.ts` is a
review-only bootstrap aid and refuses to write without
`--bootstrap-reviewed-baseline`; do not use it to silence drift.

The machine report records owner, package, source, platform requirements,
external dependencies, mock fidelity, reset support, deterministic and
live-model scenario IDs, Cloud E2E cells, evidence class, workstream, status,
and reason. Its summaries group gaps by owner, dependency, scenario lane, and
mock-world workstream.

```bash
bun run audit:e2e-coverage
bun run audit:e2e-coverage -- --json
bun packages/scripts/e2e-coverage/write-coverage-matrix-report.ts --report-dir reports/coverage
bun test packages/scripts/e2e-coverage/synthetic-world-inventory.test.ts
```

The report writer preserves the #8802 files and additionally writes
`synthetic-world-inventory.json` and `SYNTHETIC_WORLD.md`. Root `bun run verify`
runs the canonical drift gate.

## Compatibility contracts (#8801 and #8802)

Both legacy contracts remain callable and keep their existing output fields:

1. **Surface coverage ship-gate (issue #8802)** — every slash command, pre-LLM
   shortcut (#8791), plugin-declared HTTP route, and view must have a real
   recorded e2e or a written exemption.
2. **Per-plugin keyless-e2e coverage gate (issue #8801)** — every plugin that
   exposes an agent surface (actions and/or a message connector) must ship at
   least one keyless e2e scenario, or be ratcheted in the baseline.

The default `audit:e2e-coverage` human output now leads with the canonical row
count, while `--list-uncovered` remains the old plugin-directory list and
`--json` retains `newlyUncovered`, `staleCovered`, `staleMissing`, and `ok`
alongside the new `syntheticWorld` and `inventory` fields. The #8802 matrix
schema and filenames are unchanged.

---

## 1. Surface coverage ship-gate (issue #8802)

The umbrella coverage gate: every slash command, pre-LLM shortcut (#8791),
plugin-declared HTTP route, and view that ships a real user-triggerable effect
must have a real recorded e2e — or a written exemption. A new one that ships
uncovered fails CI, following the exact precedent of
`packages/app/test/route-coverage.test.ts`.

### Pieces

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
- **`write-coverage-matrix-report.ts`** — the report CLI →
  `reports/coverage/e2e-matrix.json` + an HTML contact sheet
  (`reports/coverage/viewer/`). Advisory by default; `--fail-on-missing` (or
  `E2E_COVERAGE_GATE_ENFORCE=1`) makes it exit non-zero on a blocking gap.

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

### Adding coverage

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

### Advisory → required (issue §5)

The develop-landscape-sensitive checks (route-wiring drift, blocking gaps,
zero-test documentation) are **advisory by default** — they log a warning and
pass — and become hard failures under `E2E_COVERAGE_GATE_ENFORCE=1`. This keeps
a PR from going red merely because the develop base it merges against churned
its own plugin/test landscape (a sibling PR adding/removing a route plugin or a
plugin's first test). The stable structural checks (larp rejection, exemption
reasons, view gates, the command contract) stay hard regardless.

### Run

```bash
bun test packages/scripts/__tests__/e2e-coverage.test.ts            # advisory
E2E_COVERAGE_GATE_ENFORCE=1 bun test packages/scripts/__tests__/e2e-coverage.test.ts  # required
bun packages/scripts/e2e-coverage/write-coverage-matrix-report.ts --report-dir reports/coverage
```

---

## 2. Per-plugin keyless-e2e coverage gate (issue #8801)

A plugin that exposes an agent surface — actions and/or a message connector —
but ships **zero keyless e2e coverage** is a broken pipeline: a capability users
reach with no zero-cost regression test. This gate flags exactly that.

"Keyless e2e" = a scenario that runs on a PR under the deterministic model provider
(`SCENARIO_USE_DETERMINISTIC_MODEL=1`) with **no credentials**:

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
- `check-e2e-coverage.ts` — the gate. Ratchets the set of surface-but-uncovered
  plugins against `keyless-e2e-baseline.json`.
- `keyless-e2e-baseline.json` — the ratchet. Lists plugins that have a surface
  but no keyless e2e **yet**. It may only shrink.
- `check-e2e-coverage.test.ts` — unit tests for the inventory + gate, including
  the ratchet failure modes.

### Run

```bash
bun run audit:e2e-coverage          # the gate (exit 1 on failure)
bun test packages/scripts/e2e-coverage/check-e2e-coverage.test.ts
bun packages/scripts/e2e-coverage/check-e2e-coverage.ts --list-uncovered
bun packages/scripts/e2e-coverage/check-e2e-coverage.ts --json
```

### Rules (ratchet)

1. Every plugin with a surface must either have a keyless scenario or appear in
   `keyless-e2e-baseline.json`.
2. The baseline may only **shrink**. The gate fails if a baselined plugin is now
   covered, no longer has a surface, or no longer exists — forcing the stale
   entry out so coverage never silently regresses.
3. A new plugin with a surface that is neither covered nor baselined fails the
   gate. Add a keyless (`lane: "pr-deterministic"`) scenario, or add it to the
   baseline with justification.
