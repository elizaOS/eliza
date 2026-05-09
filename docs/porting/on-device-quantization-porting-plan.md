# On-device quantization porting plan

This document tracks the AOSP / cuttlefish on-device agent bring-up. The target is a working end-to-end chat round-trip on the AOSP image using the bundled `agent-bundle.js`, then layering DFlash + draft-model paired inference on top.

## Current state on the AOSP image

**Last verified: 2026-05-09 04:42 PDT (worktree-agent-af5238436024dfb1d, branch `worktree-agent-af5238436024dfb1d`).**

### What works

- `bun install` succeeds at the repo root after fixing the corrupt `llama-cpp-capacitor@0.1.5.patch` hunk header.
- `bun run --cwd packages/agent build:mobile` produces a 36 MB `agent-bundle.js` plus PGlite assets (pglite.wasm, initdb.wasm, pglite.data, vector.tar.gz, fuzzystrmatch.tar.gz) and `plugins-manifest.json` in `packages/agent/dist-mobile/`.
- The bundle parses and imports cleanly under host Bun (`bun -e 'import("./agent-bundle.js")'`).
- The bundle runs on cuttlefish through the following boot stages:
  - musl loader + bun spawn (~30 s on cvd x86_64)
  - sigsys handler install
  - local AI config init
  - PGlite data dir creation (~2 min later)
  - registry hydration (warns about missing `entries/{apps,plugins,connectors}` payloads — those need to be staged into the APK; not boot-fatal)

### What does not yet work

- The bundle dies before the API server binds. Each fix unblocks one Bun.build symbol-loss bug and exposes the next. Pattern: top-level `const X = ...` declarations in `@elizaos/core` and `@elizaos/app-core` get rewritten to `var X` declarations whose initialiser sits inside a deferred `__esm` wrapper; on the AOSP runtime the wrapper sometimes runs after the first call site, leaving the symbol undefined.

- Known remaining failure points (in observed boot order):
  - `ethers is not defined` warning — `@elizaos/agent`'s wallet hydrator references `ethers.x` while Bun emitted `init_ethers = () => {}` (empty stub). Currently a non-fatal warning; will become fatal once hydrate path actually runs.
  - The agent crashes mid-`runVaultBootstrap` after the registry warnings. Each successive boot exposes one more TDZ-style symbol that needs to be patched into a function-scope or lazy-evaluated form (the `loadRegistry` `entriesDir` and the vault-bootstrap `ENV_VAR_KEY` regex are the two surfaced and patched in the latest commits; the next is unfortunately the next module-level `const` Bun decides to defer).

### Verified-working baseline numbers

- Bundle size: 36.23 MB (35,992 KB)
- `agent-bundle.js` cold-boot up to PGlite create: ~2 minutes on cuttlefish x86_64 vCPU. Bun is the bottleneck — JIT + module init under seccomp + no JIT cache.
- No tok/s yet — inference path not reached.

## Open root-cause investigation

Bun.build 1.3.13 has multiple TDZ bugs in `__esm` wrapper code generation:

1. `import * as ns from "./x"; ns.foo` → emits bare `foo` reference without declaring it (when `./x` is also re-exported via `export * from`).
2. Re-export aliasing chains (`export { _foo as foo }` over multiple barrel hops) → emits `foo: () => foo` getter that points at an unrenamed identifier.
3. Top-level `const X = ...` declarations → hoisted to `var X;` with assignment moved inside `__esm`; sometimes the wrapper doesn't fire before the first call site.

The strategic fix is upgrading Bun (each of these is a known class of upstream bug). Until then, the workarounds are:
- Replace `import * as ns` with named imports.
- Hop directly to leaf files (`@elizaos/core/features/.../leaf` instead of going through 4 barrel hops).
- Replace top-level `const X = literal` with `function X() { return literal; }` so the binding is established at parse time.

## Verification commands (for next agent)

```bash
# Build the bundle
bun run --cwd packages/agent build:mobile

# Push and restart cuttlefish
adb -s 0.0.0.0:6520 shell am force-stop ai.milady.milady
adb -s 0.0.0.0:6520 shell pkill -9 -f bun
sleep 2
adb -s 0.0.0.0:6520 push packages/agent/dist-mobile/agent-bundle.js \
    /data/data/ai.milady.milady/files/agent/agent-bundle.js
adb -s 0.0.0.0:6520 shell chmod 600 /data/data/ai.milady.milady/files/agent/agent-bundle.js
adb -s 0.0.0.0:6520 shell chown u0_a36:u0_a36 /data/data/ai.milady.milady/files/agent/agent-bundle.js
adb -s 0.0.0.0:6520 shell rm -rf /data/user/0/ai.milady.milady/files/.eliza/workspace/.eliza/.elizadb
adb -s 0.0.0.0:6520 shell rm -f /data/data/ai.milady.milady/files/agent/agent.log
adb -s 0.0.0.0:6520 shell monkey -p ai.milady.milady -c android.intent.category.LAUNCHER 1

# Watch boot (allow ~3 min for PGlite + registry stages)
adb -s 0.0.0.0:6520 logcat -d | grep ElizaAgent | tail -30
```

The bundle on device must be 37 MB after push. If it falls back to ~22 MB, the Android service re-extracted from the APK (`.apk-stamp` mismatch) — confirm `pkgUpdate == stampedUpdate` or rebuild the APK once the bundle stabilises.

## End-to-end chat verification (once boot completes)

```bash
adb -s 0.0.0.0:6520 forward tcp:31337 tcp:31337
curl localhost:31337/api/health     # expect 200
curl -X POST localhost:31337/api/messages -H 'Content-Type: application/json' \
    -d '{"text":"hi"}'              # expect non-empty reply
```
