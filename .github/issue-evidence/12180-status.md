# Issue #12180 — Foundation slice (D1–D5) status

Branch: `feat/12180-local-agent-transport-foundation` (rebased onto develop tip
`f02f9fc8810`). This PR implements the **behavior-neutral foundation slice**
(plan §D, items 2 + 1 + 3). Nothing device-gated is included. Port-gating is
opt-in and unused by any caller; the desktop transport resolver is dormant
(inert until a future item-4 RPC handler exists). Every default boot path is
byte-for-byte identical to today.

## Review round (post-adversarial-review fixes)

Five confirmed findings were addressed after the first review:

1. **biome format** — all new/edited files reformatted to their package's biome
   config (plugin → TAB, agent/shared/app-core/ui → 2-space + array wrapping).
   `biome format .` exits **0** for `plugin-capacitor-bridge`; every file this
   change touches passes `biome format`. The one agent format red is a
   pre-existing, out-of-scope `.d.ts` — see "biome format" below.
2. **skipApiListen correctness** — `syncResolvedApiPort` + the "listening on
   http://…" / "Control UI:" log/console lines now run only `if (!skipApiListen)`
   in `eliza.ts`, so no never-bound port is synced into env and no false
   "listening" URL is emitted; the IPC branch logs "route kernel ready (no TCP
   listener bound)".
3. **removed speculative stub** — the unused `requestStream` surface
   (`StdioBridgeStreamHandler`, `requestStream?` option, `defaultRequestStream`,
   the returned field, and its 2 placeholder tests) was stripped from
   `stdio-bridge.ts`. Streaming will be added with its real consumer in item 5/6.
4. **single source of truth for frame types** — `ios/bridge.ts` now imports the
   shared `StdioBridgeRequestFrame`/`StdioBridgeResponseFrame` (aliased to the
   local `BridgeRequest`/`BridgeResponse` names) and drops the byte-for-byte
   duplicate interfaces + the two casts at the `createStdioBridge` call site.
5. **real behavioral test for skipListen** — `server.ts` cannot be imported into
   the agent vitest lane (app-core subpath alias → ENOTDIR), but it DOES load
   under a plain Bun runtime. A Bun child-process harness
   (`__fixtures__/skip-listen-boot-harness.ts`) now boots the REAL
   `startApiServer` and the test asserts `skipListen: true` → port NOT bound AND
   (non-vacuous control) unset → port bound. Verified locally: the boot runs
   (~13s, two real boots) and passes. When the module graph can't load (sparse
   checkout without built dist/generated i18n), the harness reports the failure
   and the behavioral case skips explicitly with a warning rather than
   false-passing — the source-level assertions still hold.

## What was implemented

### D1 — `resolveApiExposePort` + `API_EXPOSE_PORT_KEYS`
`packages/shared/src/runtime-env.ts`. Follows the exact
`resolveApiSecurityConfig` / `isTruthyEnvValue` pattern. Off by default; truthy
`ELIZA_API_EXPOSE_PORT` → `true`. Test:
`packages/shared/src/runtime-env.expose-port.test.ts` (17 cases).

### D2 — Port-bind gate threaded through `startEliza`
`packages/app-core/src/runtime/eliza.ts`. Adds `localAgentMode?: boolean` to
`StartElizaOptionsExt`. In the server-only boot path, when
`localAgentMode === true` AND `resolveApiExposePort(process.env) !== true`,
forwards `skipListen: true` to `startApiServer` so the process binds no port; the
in-process route kernel still initializes. **No caller sets `localAgentMode`
yet**, so desktop Electrobun launcher / `eliza start` / server-only are unchanged.
Test: `packages/app-core/src/runtime/eliza-local-agent-port-gate.test.ts` — the
gate predicate is evaluated against the *real* `resolveApiExposePort`, plus
source-level wiring assertions (`eliza.ts` cannot be imported/booted in the
vitest lane; see "Environment limits").

### D3 — `skipListen` primitive in `startApiServer`
`packages/agent/src/api/server.ts`. Adds optional `skipListen?: boolean`;
short-circuits before `server.listen(...)`, returning the un-bound server with
routes + `dispatchRoute` wired and the same
`{ port, close, updateRuntime, updateStartup }` contract. Shared connector/stream
teardown factored into `stopServerSideResources()` and reused by both close
paths. `skipListen` unset → identical to today. In local-agent IPC mode the
port-sync + "listening" logs are suppressed (review fix #2). Test:
`packages/agent/src/api/server-skip-listen.test.ts` — source-level assertions
(`server.ts` can't be imported into the vitest lane; the `@elizaos/app-core`
subpath alias → ENOTDIR, per `health-routes.canRespond-ws.test.ts`) PLUS a real
Bun-subprocess behavioral test (`__fixtures__/skip-listen-boot-harness.ts`) that
boots the actual `startApiServer` and asserts port-not-bound with `skipListen`
and port-bound without it.

### D4 — `createStdioBridge` shared NDJSON kernel
New `plugins/plugin-capacitor-bridge/src/shared/stdio-bridge.ts` extracts the
platform-neutral half of the iOS stdio loop (line reader, JSON frame parse,
in-order dispatch, error→frame). `runIosBridgeCli` in
`plugins/plugin-capacitor-bridge/src/ios/bridge.ts` now delegates its
buffering/dispatch to it via `createStdioBridge({ request, writeFrame,
interceptLine })`, keeping iOS ownership of host-call interleaving
(`interceptLine = tryHandleHostResultLine`), the runtime host, stdout
reservation, and status shims. **Buffered only** — no `requestStream` surface at
all (the speculative stub was removed, review fix #3); streaming is added with
its real consumer in item 5/6. `ios/bridge.ts` imports the shared frame types as
the single source of truth (review fix #4). `ios-bridge --stdio` behavior
unchanged; existing `ios/bridge.routes.test.ts` stays green (15/15). Test:
`plugins/plugin-capacitor-bridge/src/shared/stdio-bridge.test.ts` (7 cases, incl.
`/api/health` buffered round-trip).

### D5 — Dormant desktop local-agent transport resolver
New `packages/ui/src/api/desktop-local-agent-transport.ts`:
`desktopLocalAgentTransportForUrl(url)` gated on `isElectrobunLocalMode(url)`
(the `eliza-local-agent://ipc` scheme under Electrobun, mirroring
`isMobileLocalAgentIpcUrl`), backed by
`window.__ELIZA_ELECTROBUN_RPC__.request.localAgentRequest(...)`. Inserted into
BOTH resolver chains (`client-base.ts`, `csrf-client.ts`) immediately before
`desktopHttpTransportForUrl`. Missing RPC method → clear not-yet-implemented
throw (never a silent HTTP fallback). **Dormant**: no code path sets the desktop
API base to the IPC scheme yet, so the resolver always returns `null` today.
Test: `packages/ui/src/api/desktop-local-agent-transport.test.ts` (8 cases:
null for non-IPC / non-Electrobun URLs, routes through the stub only when the IPC
base is active, POST body forward, missing-handler throw, and resolver-order
`android → iOS → desktop-local-agent → desktop-http → native-cloud` in both
chains).

## Test results (real output, this worktree)

Run via the parent worktree's vitest binary (the sparse worktree `node_modules`
resolves `@elizaos/*` and vitest from the shared parent tree).

```
packages/shared           runtime-env.expose-port.test.ts             17 pass
packages/agent            server-skip-listen.test.ts                   7 pass
                            (5 source-level + 2 real Bun-subprocess boot; the
                             behavioral boot runs ~13s and asserts
                             skip→unbound, control→bound)
packages/app-core         eliza-local-agent-port-gate.test.ts          8 pass
plugins/plugin-capacitor-bridge
  shared/stdio-bridge.test.ts                                          7 pass
  ios/bridge.routes.test.ts                                           15 pass (regression green)
  (full suite: 76 pass / 2 fail* — the 2 are pre-existing, see below)
packages/ui               desktop-local-agent-transport.test.ts        8 pass;
                          + desktop-http/ios/android/native-cloud transport 28 pass;
                          + client-base* 21 pass; csrf-client.test.ts 4 pass
```

`*` The 2 failures in `plugin-capacitor-bridge` are
`mobile-device-bridge-bootstrap.serving-status.test.ts`, which binds a **Linux
abstract socket** (`\0name`) → `EINVAL` on macOS/Darwin. Pre-existing,
platform-gated, and unrelated to this change (it touches neither `ios/bridge.ts`
nor the new `shared/stdio-bridge.ts`). Green on Linux/CI.

## Typecheck (real, this worktree)

`tsgo --noEmit` per touched package (parent `@types` + `bun-types` symlinked into
the sparse worktree `node_modules` for type-lib resolution — a tooling-only,
uncommitted step):

```
packages/shared                 EXIT 0, 0 errors
packages/agent                  EXIT 0, 0 errors
packages/app-core               EXIT 0, 0 errors
plugins/plugin-capacitor-bridge EXIT 0, 0 errors
packages/ui                     0 errors in touched files; 1 UNRELATED error:
    src/spatial/__e2e__/immersive-fixture.ts — "Cannot find module 'iwer'"
    (iwer is a declared dep not present in this sparse-install environment; not
     in this change's diff — no spatial/ files were touched). CI has the full
     install.
```

No committed code fails typecheck.

## biome format (CI `format:check` gate)

```
plugins/plugin-capacitor-bridge   `biome format .`  →  EXIT 0  (34 files, clean)
packages/agent                    every file THIS change touches passes
                                  `biome format` (server.ts, server-skip-listen
                                  .test.ts, __fixtures__/skip-listen-boot-harness
                                  .ts → EXIT 0)
packages/shared / app-core / ui   every touched/new file passes `biome format`
```

One agent format red exists — `packages/agent/src/external-modules.d.ts` — but
it is **NOT in this change's diff, is also red on `origin/develop`**, and the
agent package has no `format:check` script (only `format`), so it is not a
regression introduced here. Left untouched per scope discipline.

## Regression-safety of D2/D3 (default path still binds the port)

The default boot path passes no `localAgentMode`, so `skipApiListen` is `false`
and `startApiServer` binds exactly as today. Proven at unit level against the
real resolver in `eliza-local-agent-port-gate.test.ts`:
`shouldSkipApiListen(undefined, {}) === false`,
`shouldSkipApiListen(false, {}) === false`, and
`shouldSkipApiListen(true, { ELIZA_API_EXPOSE_PORT: "1" }) === false`.

The live `lsof` port-still-bound proof (plan §D verify line) requires booting the
full stack, which needs the built dist + a running agent — not available in this
sparse worktree. **Deferred to CI / a build host** (see below).

## Environment limits (why some proofs are CI-gated even for pure-TS code)

- This is a `.claude/worktrees/*` sparse checkout sharing the parent tree's
  `node_modules`; it has no per-package `dist` and no generated i18n data by
  default. `server.ts` / `eliza.ts` cannot be imported into the vitest lane
  (the `@elizaos/app-core` subpath alias → ENOTDIR), so the D2/D3 tests carry
  source-level + predicate-level assertions matching the repo's own pattern for
  un-bootable modules (`public-route-audit.test.ts`,
  `health-routes.canRespond-ws.test.ts`). NOTE: under a plain Bun runtime the
  `server.ts` module graph DOES load once the generated i18n data exists — which
  is exactly how the D3 real behavioral subprocess test (review fix #5) boots the
  actual `startApiServer` and proves the no-bind guarantee here, not just in CI.
- `bun run verify` repo-wide (turbo typecheck+lint across all workspaces) needs
  the full install/dist; run it in CI. Per-package `tsgo` was run here instead
  (results above).

---

# Device / hardware-gated remainder (NOT in this slice)

Per `PR_EVIDENCE.md`, each item below requires real device/simulator/desktop
hardware and is out of scope for this behavior-neutral foundation PR. Exact
commands from plan §E:

## Item 4 — Desktop RPC handlers + api-base switch (code is pure-TS; proof device-gated)
```bash
bun run --cwd packages/app capture:linux-desktop
bun run --cwd packages/app capture:windows-desktop
# inspect main-process logs for "[rpc-handlers] localAgentRequest"
lsof -iTCP -sTCP:LISTEN -n | grep -E '31337|2138'   # nothing once item 4+11 land
```

## Item 5 — iOS streaming adapter (Swift + WebView)
```bash
bun run --cwd packages/app capture:ios-sim
# device/simulator console: multiple agentStreamChunk-equivalent events per turn
# screen-record token-by-token rendering
```

## Item 6 — Android stdio switch (kill loopback listener)
```bash
bun run --cwd packages/app capture:android-emu
adb shell "cat /proc/net/tcp" | grep -i 1337        # must print nothing
# adb logcat: "[ElizaAgentService] stdio request" replaces HttpURLConnection lines
```

## Item 7 — iOS `WKURLSchemeHandler` + Range
```bash
bun run --cwd packages/app capture:ios-sim
# play + seek a voice message and a transcript audio clip on-device
# Safari Web Inspector network panel: confirm "206 Partial Content"
```

## Item 8 — Android `shouldInterceptRequest` + Range
```bash
bun run --cwd packages/app capture:android-emu
# play + seek voice/transcript audio
adb logcat   # confirm interceptor firing with 206 responses
```

## Item 9 — Electrobun custom scheme handler + Range
```bash
bun run --cwd packages/app capture:linux-desktop
bun run --cwd packages/app capture:windows-desktop
# play + seek media; main-process logs show the scheme handler served bytes,
# not renderer-api-proxy.ts
```

## Item 10 — Cross-platform chat SSE end-to-end proof
```bash
# the capture commands above (5, 6, 4/9), each showing incremental token
# rendering — this item has no code of its own, only the aggregated recordings
```

## Full port-removal proof matrix (Definition of Done, all platforms)
```bash
# Desktop, LOCAL mode, ELIZA_API_EXPOSE_PORT unset — must print nothing:
lsof -iTCP -sTCP:LISTEN -n | grep -E '31337|2138'
# Android emulator/device, local mode — hex 1337 == dec 31337; expect no row:
adb shell "cat /proc/net/tcp" | grep -i 1337
# iOS: already port-free — confirm via device network capture / FullBunEngineHost.
# Opt-in regression (all platforms): set ELIZA_API_EXPOSE_PORT=1 and confirm the
# port + e2e/Playwright HTTP harnesses still work.
```

Evidence bundle location (when the device-gated items land):
`.github/issue-evidence/12180-local-agent-ipc-transport-<platform>-<slug>.<ext>`.
