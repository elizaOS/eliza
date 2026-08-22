# e2e gates and synthetic-world coverage reporting

Two coverage gates and one advisory inventory live in this directory. They read real
production registration source and configuration statically, without booting a
provider or importing plugin side effects.

1. **Canonical runtime-surface inventory (issue #22897)** — every maintained
   plugin and host registration is inventoried across actions, promoted
   subactions, providers, services, evaluators, events, routes, views, models,
   connector ingress/egress, scheduled workers, queues, native bridges, and
   Cloud services. Coverage and dependency dispositions are derived from the
   current source tree; the inventory is report-only while its proof corpus grows.
2. **Surface coverage ship-gate (issue #8802)** — every slash command, pre-LLM
   shortcut (#8791), plugin-declared HTTP route, and view must have a real
   recorded e2e or a written exemption.
3. **Per-plugin keyless-e2e compatibility gate (issue #8801)** — the historical
   action/connector package ratchet remains available while consumers migrate
   to the row-level canonical inventory.

## 1. Canonical runtime-surface inventory (issue #22897)

`runtime-surface-inventory.ts` follows typed `Plugin` registrations, imported
spreads and arrays, factories, promoted subactions, platform exports, host
registration calls, generated-router-mounted Cloud route modules and service
entry points, JSONC/TOML Worker queue and cron bindings, and Capacitor bridge
registrations. It does not infer a surface from a directory name such as
`actions/` or import application code. Generated Cloud `ROUTE_MOUNTS` records
are parsed as the authority for both each dynamic import and its canonical
`/api/...` path; filesystem directory names never substitute for the served
path. Package source conditions such as `eliza-source` take precedence over
compiled-output guesses and compatibility barrels.

Each generated row records:

- owner, package, production source and registration field;
- runtime/platform requirements and package-manager dependencies;
- explicit external service/protocol dependencies, their mock owner
  and source, or an actionable missing-mock/local-only/unresolved disposition;
- mock availability/fidelity and reset support;
- deterministic and live-model scenario ids and Cloud E2E cells;
- evidence class, exact boundary artifacts/signals and owning #22896 workstream;
- one derived status such as `covered`, `uncovered`, `platform-deferred`, or
  `provider-qualified-only`, with a written reason.

`uncovered` is the report-time default for a production surface that has no
executable boundary proof yet. Provider, connector, and model surfaces without
explicit mock ownership are reported as `provider-qualified-only`; they cannot
be presented as covered.

The same artifact includes a census of every maintained plugin, the core,
agent, and app-core hosts, Cloud API, and every production Cloud service
package. A package with no production runtime registration is retained as
`no-runtime-registration` with a written reason instead of silently
disappearing from the inventory. Canonical row ids use package, kind, and the
registered boundary name; moving an implementation file does not change its id.

`runtime-surface-dependencies.json` is the reviewed dependency authority for
every discovered production surface kind, including actions, services,
scheduled workers, queues, views, and native bridges. External-service rules
select explicit kinds, exact canonical ids, or implementation source prefixes;
remaining surfaces fail closed as unresolved unless an explicit matching rule
proves a local or external boundary. No unlisted package or newly added surface
falls through to an automatic local-only default, and unresolved Cloud routes
remain visible rather than inheriting every dependency used anywhere in Cloud
API. Package imports such as React, Zod, SDKs, parsers, and database drivers
remain visible under `packageDependencies`, but never imply an external service
or mock. A service rule names its protocol and either a repository-local mock
source plus owner or a concrete missing-mock reason. Mock ownership is limited
to exact canonical surface ids and exact HTTP method/path operations parsed
from UUID-registered Mockoon routes. The parser accounts for endpoint prefixes,
supported verbs, unique served operations, and one valid default inline
response; file existence or marker text never establishes protocol fidelity.
Partial REST fixtures therefore cannot claim
unowned WebSocket, webhook, OAuth, mutation, or external PostgreSQL boundaries.
Mock/reset evidence remains row-specific and is not inferred from catalog
ownership. The catalog records closed draft PR #23185 only as a design reference
for a richer provider conformance catalog; it does not treat that unmerged work
as present evidence or a required stack. The
current-develop migration has 55 selected rules across 43 packages and zero
package-wide local fallbacks. Every unmatched surface remains unresolved.
No rule uses a package-wide `all` selector. Calendar's selected operational
surfaces declare Google Calendar, Microsoft Graph, Apple EventKit, and guarded
ICS-feed protocols, while its Google webhook, local migration, provider, and
view have exact narrower dispositions. An unreviewed new Calendar surface
fails closed. Cloud Stripe routes are selected by their implementation path and
Stripe remains mock-missing until a genuine external fixture exists; all other
Cloud route and worker dependencies remain explicitly unresolved instead of
inheriting a package-wide protocol list. Vision's local bridge surfaces remain
local while its runtime-selected model execution is unresolved; neither claims
ownership of an unrelated HTTP fixture. Wallet's
mixed RPC, indexer, RSS, hosted-trading, and local services remain unresolved
except for its exact process-local profile service, rather than all being
misreported as blockchain RPC.
Browser bridge management is separated from browser automation, and Discord's
web-app scraper is separated from the bot REST/Gateway protocol.

Coverage and dependency status are derived, never baselined. A deterministic scenario declares the
full canonical id in its exported `runtimeSurfaceIds` array. Canonical bare
objects and `scenario({...})` exports are both resolved; action evidence must
come from an asserted turn, and other runtime calls must be reachable from a
turn assertion or final-check callback. Setup, seed, unused-helper, comment,
and prefix collisions never count. A Cloud E2E test
uses the exact title `runtime-surface:<canonical-id>` and asserts the matching
request or runtime call in that same test callback. Package ownership, an id,
or a boundary-name substring alone never counts. The initial proof corpus
includes a deterministic Notes action scenario and a real booted-Cloud locale
route cell, so both artifact classes are nonzero before any future enforcement.

Drift comparison is opt-in and requires explicit package scopes. It compares
two generated reports rather than consulting Git or a whole-repository frozen
snapshot. The report command always exits zero for inventory findings; malformed
arguments or an inventory construction error remain ordinary command failures.

Run the advisory report and generate its machine-readable and reviewer-readable
artifacts with:

```bash
bun run report:runtime-surface-coverage
bun test packages/scripts/e2e-coverage/runtime-surface-inventory.test.ts
bun packages/scripts/e2e-coverage/write-coverage-matrix-report.ts --report-dir reports/coverage
```

Compare one package against a previously generated report with:

```bash
bun run report:runtime-surface-coverage -- --compare reports/coverage/runtime-surfaces.json --package @elizaos/plugin-notes
```

The report command writes `runtime-surfaces.json`, `runtime-surfaces.md`, and
`runtime-surfaces.html` beside the #8802 matrix. Its timestamp comes from the
source commit rather than wall-clock time, so repeated generation at one SHA is
byte-for-byte deterministic. The unchanged scenario PR workflow uploads that
directory, making the same generated inventory available to the Cloud test
matrix and the parent #22896 workstreams.

### #8801/#8802 compatibility

`bun run audit:e2e-coverage` retains the existing #8801/#8802 enforcement
contract. The #22897 runtime census does not run in that gate. Its JSON,
Markdown, and HTML outputs are additive report artifacts for reviewers and the
parent #22896 workstreams. Enforcement is deliberately deferred until the
proof corpus and mock ownership catalog are materially complete.

---

## 2. Surface coverage ship-gate (issue #8802)

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

## 3. Per-plugin keyless-e2e compatibility gate (issue #8801)

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
