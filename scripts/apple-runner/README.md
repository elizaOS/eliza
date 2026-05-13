# apple-runner — Mac/iOS verification kit

Cold-runnable scripts for an Apple Silicon Mac that:

1. Build `elizaOS/llama.cpp` for `darwin-arm64-metal` and run the five
   Metal kernel verifiers (`turbo3`, `turbo4`, `turbo3_tcq`, `qjl`,
   `polar`) against the JSON fixtures in
   `local-inference/kernels/verify/fixtures/`.
2. Build the iOS xcframework (`ios-arm64-metal` + `ios-arm64-simulator-metal`),
   stage it as a drop-in for the `llama-cpp-capacitor` plugin's vendored
   `LlamaCpp.xcframework`, and run a Capacitor instrumentation smoke
   that loads Eliza-1 mobile and generates ten
   tokens.

Every step writes a self-contained Markdown report under
`reports/porting/<UTC-date>/`.

This kit is **produced by an agent without a Mac**. The intent is for the
next agent (running on a self-hosted M-series Mac runner) to clone the
worktree, run `./run-mac.sh && ./run-ios.sh`, and ship back the two
report files plus exit codes.

## Prerequisites

| Requirement | Why | How to satisfy |
|---|---|---|
| macOS 14+ on Apple Silicon | `metal_verify` JIT-compiles `.metal` source via `MTLDevice.newLibraryWithSource`. The fork's iOS targets pin `CMAKE_OSX_DEPLOYMENT_TARGET=14.0`. | `sw_vers -productVersion` should report 14.x or newer. |
| Xcode 15+ (full IDE, not just CLT) | `xcrun --find metal` and `xcodebuild` need the Metal toolchain that only ships with full Xcode. | Download from the App Store or developer portal, then run `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`. |
| iPhoneOS + iPhoneSimulator SDKs | iOS xcframework build. | Open Xcode once after install so the SDKs unpack. |
| Cocoapods | `pod install` for the patched `LlamaCpp.xcframework` plugin. | `sudo gem install cocoapods` (Apple Silicon: prefer `brew install cocoapods`). |
| `bun`, `cmake`, `git`, `make`, `clang`, `clang++` | Build orchestration + verifier harness. | `brew install bun cmake`. clang/clang++ ship with Xcode CLT. |
| ~10 GB free disk on `$HOME` | llama.cpp source checkout (~300 MB), per-target build trees (~2 GB each), xcframework slices, plus model GGUFs for the smoke test. | `df -g $HOME`. |

## One-command run

```bash
cd /path/to/eliza/checkout
./scripts/apple-runner/run-mac.sh && ./scripts/apple-runner/run-ios.sh
```

Both scripts are idempotent: if a previous build already populated
`$ELIZA_STATE_DIR/local-inference/bin/dflash/<target>/`, the build step is
skipped. Force a fresh build with `APPLE_RUNNER_FORCE_REBUILD=1`.

For a faster turnaround during iteration:

```bash
./run-mac.sh --skip-build         # reuse existing darwin-arm64-metal artifacts
./run-ios.sh --skip-build         # reuse existing iOS xcframework slices
./run-ios.sh --device-only        # device archive only, no simulator, no smoke
./run-ios.sh --sim-only           # simulator archive only, run smoke on sim
```

## Smoke-test models

`run-mac.sh` looks for any Q4_K_M GGUF under common cache locations, in
order:

1. `$APPLE_RUNNER_SMOKE_MODEL` (explicit override).
2. `$ELIZA_STATE_DIR/local-inference/models/**/*Q4_K_M*.gguf`.
3. `~/Library/Caches/Eliza/**/*Q4_K_M*.gguf`.
4. `~/.cache/eliza/**/*Q4_K_M*.gguf`.

If none are found, the smoke step is reported as `SKIP` (not `FAIL`); the
report still includes everything that ran. To enable the smoke step
deterministically:

```bash
APPLE_RUNNER_SMOKE_MODEL=/abs/path/to/eliza-1-2b-32k.gguf ./run-mac.sh
```

`run-ios.sh` requires explicit GGUF paths because the simulator can't
auto-discover models inside the host's home directory:

```bash
APPLE_RUNNER_ELIZA1_GGUF=/abs/path/to/eliza-1-2b-32k.gguf ./run-ios.sh
```

## Expected outputs

```
reports/porting/<UTC-date>/
├── mac-metal-smoke.md            # ./run-mac.sh
└── ios-capacitor-smoke.md        # ./run-ios.sh
```

`mac-metal-smoke.md` contains:

- Toolchain versions (DEVELOPER_DIR, xcrun metal path, cmake, bun, llama.cpp ref).
- The `CAPABILITIES.json` written by the dflash builder.
- A 5-row table — one per kernel — with `PASS`/`FAIL`/`SKIP` and detail.
- The smoke-generation status (`PASS` requires a Metal device marker in stderr).
- Tail of the full run log.

`ios-capacitor-smoke.md` contains:

- Toolchain versions (iPhoneOS + iPhoneSimulator SDK paths, xcodebuild version).
- Per-triple build summary (archive count + metallib presence).
- The staged xcframework binary paths and sizes.
- Capacitor smoke status: either `xcodebuild test` exit code (if a Tests
  scheme exists) or symbol-presence verification on the staged
  `LlamaCpp` framework binary (`llama_init_context`, `llama_model_load`,
  `llama_init_from_model`).
- Tail of the full run log.

Exit codes (both scripts):

- `0` — every step succeeded (or was deliberately skipped).
- `1` — kernel verification failed (one or more `metal_verify` runs returned non-zero).
- `2` — the smoke step failed.

## Common failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `xcrun --find metal failed` | Only CLT installed, full Xcode missing. | Install Xcode from App Store; `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`. |
| `xcrun: error: invalid active developer path` | `xcode-select` pointing at a moved/missing Xcode bundle. | Re-run `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`. |
| `iPhoneOS SDK not installed` | Xcode installed but never opened. | Open Xcode once and accept the license; SDKs unpack on first launch. |
| `metal_verify` reports `FAIL` for `qjl` or `polar` only | The fixture was generated from the Linux reference; if `block_qjl1_256` / `block_q4_polar` byte layout drifted in the fork, the .metal shader will read garbage. | Diff `local-inference/kernels/verify/qjl_polar_ref.h` against the fork's `ggml-common.h`; regenerate fixtures. |
| Pod install fails with "platform :ios, '15.0' not supported" | Cocoapods too old. | `gem update cocoapods` to ≥ 1.13. |
| `xcodebuild test` fails with `ld: framework not found LlamaCpp` | Stage step ran but Pods/ wasn't refreshed. | `cd packages/app/ios/App && pod install` then re-run. |
| `xcodebuild` build fails with code-sign error | Default scheme wants a signing identity. | The script passes `CODE_SIGNING_ALLOWED=NO`; if the project overrides this, set `CODE_SIGN_IDENTITY=""` `CODE_SIGNING_REQUIRED=NO` `CODE_SIGNING_ALLOWED=NO` in the failing target. |
| `dflash-build` emits "ios target requires macOS host with Xcode" | Script run on Linux. | Expected — refusal path. Ship the kit to a Mac runner. |
| Build hangs on first cmake configure for ~5 minutes | Initial git clone of the fork plus header fetches. | Wait. Subsequent runs reuse `~/.cache/eliza-dflash/`. |

## Where reports land

Both scripts write into `reports/porting/<UTC-date>/` (mirroring the
existing porting-report convention from `2026-05-09-baseline/`,
`2026-05-09-unified/`, `2026-05-09-w2/`). Override with
`APPLE_RUNNER_REPORT_DIR=/abs/path`.

After a run, the worktree branch will have those report files
uncommitted. The Mac runner is expected to:

```bash
cd /path/to/eliza/worktree
git add reports/porting/<UTC-date>/{mac-metal-smoke.md,ios-capacitor-smoke.md}
git commit -m "wave-3-G: apple-runner verification reports"
git push
```

## Dispatching the next agent

After the Mac run completes, dispatch the next wave-3 agent with:

> Read `reports/porting/<UTC-date>/mac-metal-smoke.md` and
> `reports/porting/<UTC-date>/ios-capacitor-smoke.md`. If `metal_verify`
> reports 5/5 PASS, flip the four `ELIZA_DFLASH_PATCH_METAL_*` env vars
> to always-on in
> `packages/app-core/scripts/build-llama-cpp-dflash.mjs:applyForkPatches`
> and update the matrix in `local-inference/kernels/README.md` to mark
> "Compiles to AIR / Runs on real GPU / Numerically matches CUDA" as
> verified. If the iOS smoke reports `PASS` with non-empty
> `GENERATED_TOKENS`, mark `iOS Metal` as `✓` in the per-technique
> table in `docs/porting/unified-fork-strategy.md` for the kernels that
> verified.

If anything is `FAIL` or `SKIP`, **do not flip the patch hooks** — the
current default-OFF gating exists precisely to prevent regressing the
production path before hardware verification lands. Investigate the
report's "Generated tail" + "Full log" sections, fix the underlying
cause, and re-run the kit.

---

## Audit findings

The agent that produced this kit walked the codebase for Apple-specific
assumptions that would break a fresh Mac run. Findings:

### iOS deployment-target inconsistency (low risk, documented)

- `packages/app-core/scripts/build-llama-cpp-dflash.mjs:402` sets
  `CMAKE_OSX_DEPLOYMENT_TARGET=14.0` for the static llama.cpp slices.
- The host Capacitor app pins `IPHONEOS_DEPLOYMENT_TARGET = 15.0` in
  `packages/app-core/platforms/ios/App/App.xcodeproj/project.pbxproj`
  and `platform :ios, '15.0'` in `App/Podfile`.

This is **not a build break**: a static `.a` compiled with
`-mios-version-min=14.0` is forward-compatible with apps targeting iOS
15. The `LlamaCpp.framework` slice will link cleanly into a 15.0 host
app, and the Metal capability set used by the kernels (SIMD-group
operations, threadgroup memory) is available since iOS 13.

If you want the slice and host to match exactly (recommended for CI
reproducibility), bump the build script:

```diff
-      "-DCMAKE_OSX_DEPLOYMENT_TARGET=14.0",
+      "-DCMAKE_OSX_DEPLOYMENT_TARGET=15.0",
```

Left as-is in this kit because (a) the worktree's W1-D commit explicitly
chose 14.0 to "cover every supported Capacitor target", and (b) changing
it should be a separate, intentional commit by the owning agent.

### No hardcoded Xcode paths (clean)

`grep -rn "/Applications/Xcode" packages/ scripts/ local-inference/`
returns zero hits across non-`node_modules`, non-`dist/` source. The one
build-script Xcode reference (the asset-catalog actool invocation in
`packages/app-core/platforms/ios/App/App.xcodeproj/project.pbxproj:310`)
correctly uses the `${DEVELOPER_DIR}` env var that Xcode itself sets,
not a literal path. `xcode-select -p` is the source of truth.

### Codesigning expectations (clean)

The only `codesign` invocation in the iOS build path lives in
`packages/app-core/patches/llama-cpp-capacitor@0.1.5.patch:163-164`:

```sh
if command -v codesign >/dev/null 2>&1; then
    codesign --remove-signature ../Frameworks/LlamaCpp.framework/LlamaCpp 2>/dev/null || true
fi
```

This *removes* an existing signature on a vendored prebuilt; it does not
require a developer identity. The host Capacitor app uses Xcode's
default signing config, which `xcodebuild build CODE_SIGNING_ALLOWED=NO`
disables for the smoke build. **No identity-pinned `codesign --sign`
calls anywhere in the inference / xcframework pipeline.**

### `NSAllowsArbitraryLoads` / Info.plist (not required)

`grep -n "NSAllowsArbitraryLoads" packages/app-core/platforms/ios/App/App/Info.plist`
returns zero. iOS uses the in-process Capacitor `llama-cpp-capacitor`
plugin (loaded via `Pods/LlamaCppCapacitor.framework`), not a separate
`llama-server` HTTP process. No ATS exception is needed because there's
no localhost socket. The Android path is the one that runs llama-server
out-of-process via `bun:ffi`; iOS does in-process inference through the
plugin's C++ bridge (`cap-bridge.cpp` in the patch).

### `bun:ffi` library suffixes (Android-only path)

The `bun:ffi` calls in this codebase target either:

- macOS `libMacWindowEffects.dylib` (Electrobun desktop, see
  `packages/app-core/platforms/electrobun/src/native/permissions-darwin.ts`),
- Android `libllama.so` via the AOSP musl path
  (`packages/app-core/scripts/aosp/compile-libllama.mjs`).

iOS does not use `bun:ffi` for inference at all — it goes through the
Capacitor plugin's Swift / Objective-C bridge, which links the static
`LlamaCpp.framework` directly. Conclusion: no
`.so`-vs-`.dylib` suffix gotcha on the iOS path; the macOS desktop path
(`libMacWindowEffects.dylib`) is unrelated to llama.cpp and already
correctly suffixed.

### `df -g` portability (handled)

Both scripts use `df -g $HOME` for the disk-free check. `-g` is BSD/macOS
syntax; on Linux it errors out. The scripts redirect stderr and guard on
`[ -n "${DISK_FREE_GB}" ]`, so a Linux self-test silently skips the
check rather than failing. On a real Mac the value populates and the
≥ 10 GB invariant is enforced.

### Deferred (out of scope, but flagged for the next agent)

- **`patchMetalTurbo4` is always-on** even when no metal_verify run has
  hardware-confirmed it. Per `local-inference/kernels/README.md`, this
  is intentional — it predates the standalone shader and is required
  for the fork's existing `block_turbo4_0` to compile on Metal at all.
  But it means a regression in the fork's stale Turbo4 path could
  silently break on-device inference without `metal_verify` flagging
  it. Add a regression assertion in a follow-up: after `make metal`,
  run `metal_verify` against the *patched* shader source from the
  fork's `ggml-metal.metal` (not the standalone `metal/turbo4.metal`)
  to confirm the patch produced the expected layout.
- **Drafter pairing for the iOS smoke** — `run-ios.sh` accepts
  `APPLE_RUNNER_ELIZA1_GGUF` env vars, but
  the actual XCUITest target that consumes them is **not in this
  worktree**. The script falls back to a symbol-presence check on the
  staged `LlamaCpp.framework` binary as a build-only proxy. Wiring a
  real instrumentation test that loads both GGUFs and asserts
  `outputTokens >= 10` is the next agent's job; the harness is
  ready for it.

## Self-test

The agent that produced this kit ran the following on Linux to verify
the scripts behave as documented:

```bash
$ bash -n run-mac.sh && bash -n run-ios.sh
# (no output — both scripts are syntactically valid)

$ bash run-mac.sh
[apple-runner/mac] preflight: verifying macOS host
[apple-runner/mac] FAIL: macOS host required (uname -s = Linux)
$ echo $?
1

$ bash run-ios.sh
[apple-runner/ios] preflight: host check
[apple-runner/ios] FAIL: macOS host required (uname -s = Linux)
$ echo $?
1

$ bun run packages/app-core/scripts/build-llama-cpp-dflash.mjs --target ios-arm64-metal --dry-run
[dflash-build] skip target=ios-arm64-metal: ios target requires macOS host with Xcode
[dflash-build] target ios-arm64-metal is not buildable on this host: ios target requires macOS host with Xcode
```

A stubbed `xcrun` / `xcode-select` test (PATH-prepending fake binaries)
confirmed the `run-mac.sh` flow advances past the macOS-host preflight
and the Xcode-CLT preflight, then bails on the next missing tool
(`clang`) — i.e. the host-platform refusal isn't a layer-zero veto, it's
the documented order of preflight checks that lets a Mac runner reach
the actual build.
