# `@elizaos/agent` code-quality and startup audit

Date: 2026-08-02

## Executive summary

`@elizaos/agent` typechecks and passes a full-source Biome check, but it has
outgrown the shape of a standalone process wrapper. The package contains 918
tracked files and roughly 305,000 lines; 491 non-test TypeScript files account
for about 174,000 lines. Runtime boot, API hosting, route implementation,
configuration projection, optional-plugin compatibility, UI-facing DTOs, TEE
policy, wallet plumbing, and several application features all meet here.

The highest-value work is not broad renaming or formatting. It is to make boot a
typed sequence of idempotent phases, make restart reuse those phases, reduce the
API server to transport composition, retire stale TEE artifacts, and replace
ambient declarations and process-global configuration with owned interfaces.

This audit made the following low-risk changes:

- removed stale imports and aliases from `api/server.ts`;
- removed the CLI's redundant server keepalive timer;
- fixed hot reload passing stale config into prompt/trajectory preparation;
- widened lint coverage from a curated directory list to all of `src`;
- fixed the three issues that wider lint coverage exposed;
- corrected source-package `types` export targets that named nonexistent
  `.d.ts` files;
- stopped production builds from emitting declaration maps or test/fixture
  artifacts;
- removed four unreferenced package-local test-support modules from the public
  root barrel and source tree;
- removed thirteen confirmed zero-import dependencies and refreshed the lockfile;
- retired four validators/smokes for a TEE implementation and fixtures that no
  longer exist in the repository, then corrected the surviving TEE docs;
- replaced global logger method mutation with disposable structured-log
  listeners shared by early boot and the API server;
- made server startup release its resources when socket binding fails;
- made malformed/unreadable config fail startup instead of becoming an empty
  healthy configuration;
- made server-only API startup throw a typed error rather than terminating the
  host process;
- removed or annotated the remaining silent production catches found in the
  focused cleanup and made best-effort failures observable;
- stopped logging transformed database connection URLs and now log only the
  parsed endpoint identity;
- removed stale view-affinity fixtures for actions deleted with their plugins
  and repaired a route-test runtime fixture that omitted a required method;
- removed the duplicate `/api/restart` implementation from the API composition
  root and added route-level restart coverage;
- made trigger notification and prompt-capture failures observable through
  `runtime.reportError`, without recording failed prompt captures as saved;
- consolidated duplicate ambient media declarations and removed three shims for
  workspace packages that already publish declarations;
- made package cleanup remove generated declaration residue beside source files,
  including an orphaned ignored declaration pair found by the second pass;
- removed unused `@solana/web3.js` and `ignore` direct dependencies and taught
  Knip about seven dependencies loaded through string/dynamic plugin maps;
- corrected package-local startup, TEE, lint, and script-layout guidance;
- added compliant prose headers to two source files; and
- formatted one previously unformatted route block.

The package lint, typecheck, and production build pass after these changes.

## Scope and method

The review covered tracked source, scripts, package exports, generated and
ignored artifacts, runtime and API startup, plugin collection/resolution,
hot-reload construction, error handling, environment access, type escape
hatches, dependency ownership, and static dead-code signals.

Baseline observations:

| Measure | Result |
| --- | ---: |
| Tracked package files | 918 |
| Tracked TypeScript source files | 858 |
| Test files | 363 |
| Non-test TypeScript files | 491 |
| Total tracked lines | ~305,000 |
| Non-test source lines | ~174,000 |
| Non-test files over 500 lines | 75 |
| Catch clauses in production source | 932 |
| `error-policy:J1`–`J7` annotations in production source | 131 |
| `process.env` occurrences in production source | 776 |
| Explicit `any` occurrences in production source | 20 |

Static dead-code analysis reported one unused file, but it was a false positive:
`vitest.push-real.config.ts` is invoked by the real-live suite inventory and
documented by the push service. It should stay.

## How startup currently works

1. `src/bin.ts` enables the V8 compile cache, configures mobile DNS, anchors
   mobile-only imports so bundling cannot remove them, and calls the CLI.
2. `src/cli/index.ts` dispatches `serve`, `runtime`, mobile bridge, and benchmark
   commands. `serve` installs process crash guards and calls
   `startEliza({ serverOnly: true })`.
3. `runtime/eliza.ts:startEliza` registers static plugin importers, captures
   early logs, loads config, projects config and vault values into
   `process.env`, configures accounts/models/database/TEE, resolves plugins,
   constructs and initializes `AgentRuntime`, wires services, and starts
   deferred plugin waves.
4. Non-headless startup dynamically imports `api/server.ts`, creates the route
   kernel and HTTP/WebSocket server, and supplies an inline hot-restart callback.
5. Server-only mode registers cloud sandbox discovery, installs signal handlers,
   and holds the process open. Interactive mode creates a deterministic chat
   world/room and enters a readline loop.
6. Cloud thin-client mode takes an early branch and does not create a local
   `AgentRuntime`.

The ordering is performance-aware and well instrumented, but the implementation
encodes that ordering through shared mutable state, environment mutation, long
closures, and duplicated reconstruction logic. Those properties make small
changes hard to reason about and hard to test independently.

## Priority findings

### Resolved — stale TEE validation stack

Four scripts referenced a removed concrete TEE implementation or deleted
fixtures and had no viable execution path:

- `scripts/tee-local-smoke.ts`
- `scripts/tee-dstack-local-smoke.ts`
- `scripts/validate-tee-deployment.mjs`
- `scripts/validate-tee-revocations.mjs`

They were removed. The already-deleted root validator was also removed from the
script-inventory test. Package docs now describe the provider-neutral
`tee-evidence-provider.ts` seam and leave concrete evidence collection with the
deployment that registers it. This preserves the standalone/mobile boundary.

### P1 — split `startEliza` into an explicit boot pipeline

`runtime/eliza.ts` is about 6,350 lines, has 60 static imports, 86 catch clauses,
and 195 `process.env` occurrences. `startEliza` spans config loading, secret
projection, database setup, provider selection, plugin resolution, runtime
construction, initialization, deferred work, API startup, hot reload, cloud
registration, signal handling, and interactive chat.

Extract a `BootContext` and a small ordered phase interface:

```ts
interface BootPhase {
  name: string;
  run(context: BootContext): Promise<void>;
  dispose?(context: BootContext): Promise<void>;
}
```

Suggested phases:

1. load and validate configuration;
2. resolve secrets and build an immutable runtime-settings projection;
3. resolve the deployment mode and plugin plan;
4. construct and initialize the runtime;
5. attach host services and API transport;
6. start deferred capabilities; and
7. register process-boundary lifecycle handlers.

Keep the current boot timer around the phase runner. Make phase outputs explicit
instead of communicating through `process.env` and module globals.

### P1 — cold boot and hot reload are separate implementations

The inline `onRestart` callback in `runtime/eliza.ts` repeats environment
projection, account-pool credential setup, plugin resolution, preferred-provider
priority mutation, runtime construction, SQL/core pre-registration, role gating,
autonomy setup, and trajectory setup. Comments such as “same as startup” mark
the drift risk directly. This audit fixed one instance: hot reload passed the
old `config` to prompt/trajectory preparation after constructing the runtime
from `freshConfig`.

Create one `buildInitializedRuntime(config, hostContext)` function used by both
cold boot and restart. Return a typed result containing the runtime, resolved
plugin plan, workspace paths, and disposable resources. Restart should be:

1. build the replacement without mutating the active server state;
2. atomically swap the runtime;
3. dispose the old runtime; and
4. report a structured failure while leaving the old runtime active if build
   fails.

The current order stops the old runtime before proving the replacement can
initialize, so a failed restart can leave the API alive with no healthy runtime.

### P1 — `startApiServer` is a second composition root

`api/server.ts` is about 5,284 lines with 79 imports. Its
`startApiServer` function is roughly 1,700 lines and closes over configuration,
route state, training, apps, WebSockets, event buffers, runtime swapping,
connector sessions, logging, deferred work, and listener lifecycle.

The file already has many extracted route modules, but transport composition
still owns business and feature initialization. Continue the split:

- `createServerState(config, runtime)` — state only;
- `createRouteKernel(dependencies)` — dispatch only;
- `createEventHub()` — WebSocket/event buffering and subscriptions;
- `createServerResources()` — connector/training/app lifecycle;
- `listenHttpServer()` — socket policy and listener lifecycle; and
- `closeServerResources()` — awaited, idempotent teardown.

Make `close()` await every teardown operation. The current connector-session
cleanup calls several `stop()` methods without awaiting them and suppresses
errors.

### Resolved — global logger capture ownership

Early boot and the API server now use `addLogListener`, share one conversion to
the UI log-entry contract, and release their listeners during handoff or server
teardown. Logger objects are no longer mutated, and socket-startup failures run
the same resource cleanup before rejecting.

### Partially resolved — library startup result and process ownership

Server-only API startup now throws a fatal `ElizaError` with a stable code,
mode context, and cause. The public library path no longer terminates its host
process.

Similarly, `startEliza(): Promise<AgentRuntime | undefined>` conflates several
states: a local runtime, intentional cloud thin-client mode, and failure/no
runtime. Return a discriminated result such as `{ mode: "local", runtime }` or
`{ mode: "cloud", proxy }`. Then make `bootElizaRuntime` explicitly reject a
cloud result instead of interpreting `undefined` generically.

### Resolved — API configuration load failures

`startApiServer` now treats only `ENOENT` as the designed first-run state.
Malformed, unreadable, and otherwise failed loads throw `ElizaError` with the
config path and original cause. Sharing the full runtime/API loader remains a
useful consolidation when the boot pipeline is extracted.

### P1 — process environment is acting as the runtime dependency container

Production source contains 776 `process.env` occurrences. Boot writes provider,
wallet, database, cloud, model, connector, feature, and compatibility state into
the global process environment; hot reload then tries to replay selected writes.
This prevents isolated runtime instances and makes precedence dependent on call
order and prior boots.

Create a parsed `AgentEnvironment` once at the process boundary. Build typed
`RuntimeSettings`, `DatabaseSettings`, `ProviderSettings`, and
`ConnectorSettings` values from it plus persisted config. Keep environment
mirroring only in a documented adapter for legacy plugins, with a complete list
of mirrored keys and a reset strategy for restart/tests.

### P1 — ambient internal-module declarations shadow real packages

`src/external-modules.d.ts` is 957 lines and declares large surfaces for
workspace packages including elizacloud, app-manager, UI, and mobile bridges.
These declarations can silently diverge from the real packages while agent
typechecking stays green. This audit removed the duplicate media shim file and
declarations for three workspace packages that already publish their own types.

Replace internal-package declarations with exported contract-only subpaths or
small interfaces owned by the agent. Keep ambient declarations only for truly
untyped third-party modules. Rename the remaining ambient file by purpose so
ownership is obvious while it is being retired.

### Partially resolved — package dependency ownership

Static analysis flags numerous workspace plugin dependencies because they load
through generated/dynamic import maps; those are expected false positives and
should be encoded as Knip configuration. The following exact-zero-import
dependencies were removed and the lockfile was regenerated:

- `async-lock`
- `clean-git-ref`
- `crc-32`
- `diff3`
- `minimisted`
- `pako`
- `pify`
- `readable-stream`
- `sha.js`
- `simple-get`
- `@solana/web3.js`
- `ignore`

The duplicate `@lydell/node-pty` dev dependency was also removed because
`plugin-pty` owns it. Build, package inspection, and the Android mobile bundle
load smoke cover the agent package; an isolated-consumer smoke remains
appropriate before release.

`@elizaos/plugin-x402` is dynamically imported by API routing but is neither
present in this repository nor declared by the package. Make the intended
contract explicit: either declare it as an optional peer dependency and test
the absent path, or remove the dormant integration. The sandbox live smoke has
the same unresolved ownership problem for `@elizaos/plugin-e2b-sandbox`.

### P2 — error-policy adoption remains incomplete

Production source has 932 catch clauses but only 131 `error-policy:J1`–`J7`
annotations. Counts are not proof of incorrectness, but the gap is too large for
the repository's mechanically checkable policy.

This pass eliminated the empty production catch patterns found by the focused
scan and annotated/logged justified teardown, sanitization, explicit degrade,
and diagnostics handlers in the named files. High-density files are still
`runtime/eliza.ts` (86), `conversation-routes.ts` (37),
`api/server.ts` (35), `plugin-resolver.ts` (34), and
`trajectory-internals.ts` (26). Other handlers require semantic
boundary-by-boundary review rather than blanket comments.

Audit by boundary, not by adding comments mechanically:

- translate only at HTTP/process/action boundaries;
- use `ElizaError` with `cause` for contextual rethrows;
- call `runtime.reportError` from services/background work;
- make teardown catches J6 and observable; and
- replace model-catalog parse/network fallbacks with an explicit unavailable or
  partial result rather than silently returning a healthy-looking empty list.

### P2 — unsafe generic coercion bypasses boundary validation

`api/server.ts` defines `coerce<T>(value: unknown): T`, a generic cast with no
runtime check. Similar ambient shims and casts make dynamic plugins convenient
but move failures away from their source. Replace each use with a schema,
type guard, or a narrow adapter that validates the exact plugin API version.

### Resolved — database URL logging

Startup now parses the URL and logs only `host[:port]/database`. Credentials,
query parameters, and fragments are never copied into the log message; an
invalid URL is reported as such without echoing its value.

### P2 — hardcoded startup policy is mixed with mechanism

Examples include automatically setting
`ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS=true`, clearing Google keys using a fixed
prefix/length heuristic, fixed plugin priority boosts, fixed network timeouts,
and dynamic port fallback. Some are intentional operational policy, but they
are embedded inside the boot mechanism and cannot be reviewed or tested as one
configuration surface.

Move these into a typed boot policy with named defaults and validation. The
destructive-migration default deserves a separate decision: a runtime should
not silently opt every deployment into destructive schema changes.

### P2 — large feature modules need ownership splits

The largest non-test files are:

| File | Lines |
| --- | ---: |
| `runtime/eliza.ts` | 6,350 |
| `api/server.ts` | 5,284 after this cleanup |
| `api/chat-routes.ts` | 5,180 |
| `api/conversation-routes.ts` | 4,111 |
| `api/inbox-routes.ts` | 2,965 |
| `services/remote-plugin-adapter.ts` | 2,674 |
| `runtime/plugin-resolver.ts` | 2,568 |
| `actions/contact.ts` | 2,391 |
| `runtime/trajectory-internals.ts` | 2,264 |

Split by cohesive capability and keep route files as validation/translation
only. In particular, conversation persistence/idempotency/streaming and chat
attachment/media behavior should be services with route adapters, not sibling
route implementations that can drift.

### P3 — comments contain too much history and change narration

Many startup comments are valuable, but several are mini incident reports using
“old”, “previously”, “used to”, exact former behavior, and long chronology. That
conflicts with the repository's greenfield comment rule and makes already-large
files harder to scan. Move durable performance investigations to package docs;
keep code comments focused on the current invariant, ordering constraint, and
consumer.

## Files and artifacts that can be removed

### Safe generated cleanup

- `packages/agent/dist/`, `dist-mobile/`, `dist-mobile-ios/`, and
  `dist-mobile-ios-jsc/` are ignored and are removed by
  `bun run --cwd packages/agent clean`. Before this audit, `dist/` contained
  478 generated `.d.ts.map` files plus compiled `__tests__`/`__fixtures__`
  files; the build now emits neither category. The same clean command also
  removes compiler-generated declarations accidentally written beside source.
- `.turbo/` and package-local `node_modules/` are ignored caches/install state
  and can be regenerated by normal tooling.

### Do not delete without an explicit state decision

- `packages/agent/.elizadb/` is ignored and about 67 MB, but it is a real local
  PostgreSQL data directory and may contain user conversations/configuration.
  Move development state outside the source package by setting
  `ELIZA_STATE_DIR`; do not treat this directory like compiler output.

### Tracked declaration files

There are no tracked `.d.ts.map` files in this package. The two tracked
`.d.ts` files are authored source:

- `src/external-modules.d.ts` — internal/optional package shims; retire through
  real contracts, not blind deletion;
- `src/types/elizaos-action-augments.d.ts` — a module augmentation; preferably
  move the field into the owning core `Action` contract, then delete the
  augmentation.

### Candidates requiring a product/ownership decision

- dormant x402 and E2B sandbox integration code if those packages are no longer
  distributed; and
- the authored ambient declarations after their contracts move to owning
  packages.

Four agent-local test-support modules were not imported anywhere in the
repository and were exported only through the production root barrel. They were
removed in this audit; equivalent helpers that are still used elsewhere remain
owned by `@elizaos/shared`. The stale TEE scripts and exact-zero-import
dependencies were also removed rather than left as candidates.

## Recommended refactor sequence

1. Add a boot characterization test that records phase order and results for
   local, first-run, server-only, local-agent/skip-listen, and cloud modes.
2. Introduce immutable `AgentEnvironment`, `BootPolicy`, and `BootContext`
   types without changing behavior.
3. Extract one shared `buildInitializedRuntime` used by cold boot and restart;
   switch restart to build-before-swap.
4. Return a discriminated boot result and keep process/signal ownership at the
   CLI boundary.
5. Split the API server resource, event, route-kernel, and listener layers.
6. Move conversation/chat business logic behind services and shrink route
   modules to boundary translation.
7. Retire internal ambient declarations through contract-only package exports.
8. Audit catches in descending-density order and enforce the annotation policy
   on the entire package.
9. Add an isolated package install/start smoke to catch dependency and export
   residue before release.

## Verification performed in this audit

- `bun run --cwd packages/agent lint:check`
- `bun run --cwd packages/agent typecheck`
- `bun run --cwd packages/agent build`
- `bun run --cwd packages/agent pack:dry-run`
- `bun run --cwd packages/agent build:mobile`
- `AGENT_TEST_BATCH_SIZE=10 bun run --cwd packages/agent test`
- post-build check that every literal `types` export target exists
- post-build check that `dist` contains no declaration maps, test directories,
  or fixture directories
- structured early-log listener smoke, including listener handoff cleanup
- focused API skip-listen lifecycle suite: 9/9 tests passed
- focused view-action affinity suite: 27/27 tests passed
- focused chat-augmentation route suite: 3/3 tests passed
- Knip scan for files, dependencies, unresolved imports, and cycles
- tracked/ignored artifact inventory and declaration-map check

All 355 files in the deterministic package inventory received a green or
configured-skip result: 352 files passed and 3 were skipped, with 3,172 passing
tests and 22 configured skips. The run used the script's supported batch-size
override to avoid 355 separate Vitest process startups. A stale affinity
fixture failed the first pass because several referenced actions had been
deleted with their plugins, and a route fixture failed because it omitted the
now-required `getParticipantsForRoom` collaborator. Both fixtures were repaired
and their focused suites plus the affected final inventory segment were rerun
green.

The dry-run tarball contains 953 files, is 4.4 MB compressed, and has no emitted
`.d.ts.map`, test, or fixture artifacts. Knip no longer reports any of the
removed exact-zero-import npm dependencies. Its sole unused-file result is the
documented live-suite config; the other output is an intentionally referenced
optional peer plus configuration-hygiene hints. The Android mobile bundle built
successfully and passed its module-load smoke. Live-model, TEE hardware, cloud,
push-delivery, and UI evidence remain outside this static/refactor audit because
this pass did not change those behaviors.

The final post-cleanup lint, typecheck, and production build pass. The build
artifacts were inspected and then removed, so no generated `dist` residue is
left in the working tree.
