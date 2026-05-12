# iOS Bun Port — Project Plan

**Status:** Greenlit 2026-05-11. Multi-month engineering project.
**Owner:** TBD.
**Goal:** Ship Bun as a statically-linked, no-JIT, sandbox-safe library inside the Milady iOS app, hosting the existing `agent-bundle.js` payload in-process. The same runtime that ships on desktop + Android-AOSP ships on iOS, with `fs`-class APIs that simply error gracefully on calls the iOS sandbox forbids.

This document is the source of truth for the port. It is intentionally pessimistic about timelines and explicit about what is unknown — the audit at `REPORT.md` makes the case against this path; this plan is the case *for* executing it.

---

## 0. Decision Context

The user is taking on **4–6 months** of engineering to preserve runtime consistency across desktop, Android-AOSP, and iOS. The WKWebView alternative path (1–2 weeks, full JIT, zero binary cost) was knowingly declined in favor of "same Bun everywhere." The cost we accept:

- Permanent fork-and-rebase tax against upstream `oven-sh/bun` (weekly releases).
- LLInt-only JS performance on iOS (~7× slower on CPU-bound JS; tolerable since heavy work is in Metal/llama.cpp).
- ~8–15 MB of additional binary in the iOS app.
- Upstream is mid-rewrite from Zig to Rust as of Dec 2025. The fork either tracks the rewrite or stays on the last Zig release. We choose: **track the Zig branch until the Rust rewrite stabilizes, then make a separate fork decision.**
- ~6 weeks of work auditing `posix_spawn` / `fork` / `dlopen` / TinyCC sites in Bun's source for sandbox safety.
- Likely 1–2 App Review rejection cycles even with a policy-compliant build.

We accept these. The benefit we keep:

- One agent runtime mental model.
- No "WKWebView edge case" debugging surface.
- A future-proof position if Apple loosens JIT entitlement rules for embedded runtimes (BrowserEngineKit-style, EU DMA, etc.) — at which point flipping JIT on is a build-flag change.
- `bun:ffi` to statically-linked native libs gives us a clean integration story for `LlamaCppCapacitor` and future native plugins without going through Capacitor's plugin overhead.

---

## 1. Architecture

```
┌──────────────────── iOS .app bundle ────────────────────┐
│                                                          │
│  AppDelegate.swift                                       │
│    didFinishLaunching → ElizaBunRuntime.shared.start()  │
│                                                          │
│  ┌──────────── ElizaBunRuntime (Swift) ──────────────┐  │
│  │  Loads libbun.a (statically linked into app)      │  │
│  │  Calls bun_embedded_run(bundle_path, env, sock)   │  │
│  │  Manages lifecycle: launch, suspend, resume       │  │
│  └─────────────────────────────────────────────────┬─┘  │
│                                                    │     │
│  ┌─── libbun.a (statically linked) ────────────────▼─┐  │
│  │  JSC (no-JIT, LLInt only, ENABLE_JIT=0)           │  │
│  │  bun runtime (Zig + C++, refactored entry)        │  │
│  │  BoringSSL, c-ares, lolhtml, zstd (static)        │  │
│  │  bun:ffi → static symbol allow-list only          │  │
│  │  fs/net/http/crypto: real, sandbox-aware          │  │
│  │  child_process/spawn: throw ENOTSUP               │  │
│  │  TinyCC: stripped out                              │  │
│  └──────────────────────┬─────────────────────────────┘  │
│                         │                                │
│                         │ loads at runtime:              │
│                         ▼                                │
│  agent-bundle.js (signed bundle resource)                │
│    - statically inlined plugins                          │
│    - PGlite over Capacitor Filesystem                    │
│    - LocalInferenceLoader → bun:ffi → libllama.a         │
│                                                          │
│  WKWebView (React UI)                                    │
│    └─ talks to agent via:                                │
│         - in-process loopback (127.0.0.1:31337)         │
│         - or JSContext bridge via Capacitor plugin       │
│                                                          │
│  Statically linked native libs (in libbun.a or sep .a):  │
│    - libllama.a (llama.cpp arm64-ios, Metal-enabled)     │
│    - libwhisper.a (whisper.cpp arm64-ios, optional)      │
│    - libpglite.a (PGlite WASM runtime, optional)         │
└──────────────────────────────────────────────────────────┘
```

**Key invariants:**

- `libbun.a` is a static archive. No `dlopen` of disk paths at runtime. `dlopen(NULL, ...)` for in-binary symbols is the only allowed FFI pattern (this is the same trick Flutter uses to pass App Review).
- The agent JS bundle ships **inside the .ipa** as a resource. It is not downloaded post-install. Apple's guideline 2.5.2 carve-out explicitly permits bundled interpreted code.
- All network is loopback or to user-configured remote hosts. Server-side bind to non-loopback requires `NSLocalNetworkUsageDescription` and a user prompt.
- `child_process.spawn` / `Bun.spawn` / `posix_spawn` / `fork` are **stubbed at the runtime level to throw `ENOTSUP`**. No code path can reach a `fork(2)` syscall. This is enforced both in the agent JS (via stubs) and in `libbun.a` (by removing the implementation).
- TinyCC (Bun's `bun:ffi` JIT thunk generator) is **removed**, not stubbed. The binary must not contain executable-page-allocation code paths.
- WebAssembly runs on the IPInt interpreter (no JIT). PGlite + any future WASM payloads work, just slower.

---

## 2. Repository Layout

New top-level: `native/ios-bun-port/`. Everything iOS-Bun-specific lives here. The repo currently does not have a `native/` directory; we add it.

```
native/ios-bun-port/
├── README.md                          # quickstart, contract, current status
├── PLATFORM_MATRIX.md                 # what each Bun API does on iOS
├── toolchain/
│   ├── ios.cmake                      # CMake toolchain file for arm64-ios
│   ├── ios-simulator.cmake            # toolchain for arm64-ios-simulator
│   └── zig-ios-targets.zon            # Zig build target additions
├── vendor-webkit/
│   ├── WEBKIT_VERSION                 # pinned upstream commit
│   ├── apply-no-jit-patches.sh        # patch JSC for ENABLE_JIT=0 iOS
│   ├── patches/                       # WebKit fork patches
│   └── build-jsc-ios.sh               # cross-build JSC static lib
├── vendor-deps/
│   ├── boringssl-ios.sh
│   ├── c-ares-ios.sh
│   ├── lolhtml-ios.sh
│   ├── mimalloc-ios.sh
│   └── zstd-ios.sh
├── src-bun-fork/                      # git submodule → our Bun fork
│   └── (oven-sh/bun + our ios branch)
├── stubs/                              # iOS-specific implementations
│   ├── ios-child-process.zig          # throw ENOTSUP for spawn/fork
│   ├── ios-ffi-allowlist.zig          # static-symbol allow-list for bun:ffi
│   ├── ios-os.zig                     # os.homedir/tmpdir → sandbox paths
│   └── ios-tinycc-removed.zig         # confirms TinyCC is excluded
├── ios-embed/
│   ├── ElizaBunRuntime.swift          # Swift host that calls into libbun
│   ├── bun-embedded.h                 # C ABI for embedding
│   └── BunBridge.xcframework/         # output: stage dir for the framework
├── build-scripts/
│   ├── build-all-deps.sh              # one-shot cross-build of all native deps
│   ├── build-bun-ios.sh               # cross-build the Bun fork for iOS
│   ├── package-xcframework.sh         # bundle into BunBridge.xcframework
│   └── verify-no-jit.sh               # static-analyze the .a for forbidden symbols
├── tests/
│   ├── ios-policy-grep.sh             # CI: grep for posix_spawn/fork/dlopen
│   ├── hello-world-simulator.sh       # simulator smoke test
│   └── api-surface.test.ts            # agent-bundle.js API coverage on iOS
└── milestones/
    ├── M01-jsc-no-jit-builds.md       # acceptance criteria per milestone
    ├── M02-deps-cross-build.md
    ├── ...
    └── M12-app-store-submission.md
```

This isolates the iOS-port work from the rest of the codebase. The Bun fork (`src-bun-fork/`) is a submodule so we track upstream cleanly.

---

## 3. Milestones

Twelve gated milestones, each with explicit acceptance criteria. Sequencing is mostly linear but where work can parallelize (e.g., M02 deps and M03 Zig target additions) we note it.

### M01 — JSC no-JIT builds for iOS

**Acceptance:**
- `vendor-webkit/build-jsc-ios.sh` produces `libJavaScriptCore.a` for `aarch64-ios` and `aarch64-ios-simulator`.
- Built with `ENABLE_JIT=0 ENABLE_DFG_JIT=0 ENABLE_FTL_JIT=0 ENABLE_WEBASSEMBLY_BBQJIT=0 ENABLE_WEBASSEMBLY_OMGJIT=0`.
- `nm libJavaScriptCore.a | grep -E '_jit|_FTL'` returns empty.
- Static-link smoke test: a tiny iOS app with `JSContext` runs `1+1` from C++.

**Sources:** lift from `mceSystems/node-jsc/deps/jscshim/docs/webkit_fork_and_compilation.md`, NativeScript's WebKit fork, `phoboslab/JavaScriptCore-iOS`.

**Effort:** 2–3 weeks. The recipes exist; the work is wiring them to a current WebKit revision.

**Long pole:** WebKit private-API leakage. NativeScript hit this and patched. Expect 2–4 weeks of "fix this symbol, rebuild, repeat."

### M02 — Cross-build native dependencies

**Acceptance:**
- `libssl.a`, `libcrypto.a` (BoringSSL) for both iOS slices.
- `libcares.a` (c-ares).
- `liblolhtml.a` (Cloudflare's lol-html, used by Bun for HTMLRewriter).
- `libmimalloc.a`.
- `libzstd.a`.
- All built without symbols requiring private iOS APIs.

**Parallelizable with M01.** Standard CMake toolchain files exist for all of these.

**Effort:** 1–2 weeks.

### M03 — Zig + CMake iOS targets in Bun fork

**Acceptance:**
- `build.zig` has explicit `aarch64-ios` and `aarch64-ios-simulator` targets.
- `cmake/SetupWebKit.cmake` (in our fork) accepts a `BUN_IOS=1` flag that points at `vendor-webkit/` instead of the prebuilt-WebKit download URL.
- All `cmake/` toolchain detection (`if (APPLE)`, etc.) splits into `if (APPLE_MACOS)` and `if (APPLE_IOS)`.
- `bun --version` builds and links against iOS sysroot (does not yet run).

**Effort:** 2 weeks. The Zig support is there since 0.10; Bun's build config splitting is the work.

### M04 — `bun_embedded_run()` C ABI

**Acceptance:**
- New entry `bun_embedded_run(int argc, const char *const *argv, const char *bundle_path, const BunHostCallbacks *callbacks) -> int` in `src-bun-fork/src/main.zig`.
- Replaces `main()` for iOS builds. macOS / Linux / Windows `main()` is untouched.
- `BunHostCallbacks` exposes: `log(level, msg)`, `request_exit(code)`, `time_ms() → u64`, `read_file(path, buf, len) → i32`. Minimal surface; the host (iOS Swift code) implements them.
- Single-process model: no `Bun.serve` listening on a socket *unless* the agent JS asks for one (loopback). No daemon mode.
- Bun's signal handlers, atexit, and ProcessEnv init are gated on a `BUN_EMBEDDED` flag and either skipped or routed through `BunHostCallbacks`.

**Effort:** 1–2 weeks for the ABI; the gating-flags work is interspersed throughout M05.

### M05 — Audit + stub forbidden syscalls

**Acceptance:**
- `grep -rE 'posix_spawn|vfork|^fork\(|execve|execv|system\(' src-bun-fork/src/` returns only sites that are wrapped in `if (!BUN_EMBEDDED)` or explicitly return `ENOTSUP` on iOS.
- `bun:ffi` `dlopen` path:
  - `dlopen(NULL, RTLD_LAZY)` → allowed; resolves in-binary symbols.
  - `dlopen("/usr/lib/system/libSystem.dylib", ...)` → allowed; iOS system frameworks.
  - `dlopen(any_other_path)` → throws `BunErr.UnsupportedOnIOS("dlopen of arbitrary paths is forbidden on iOS")`.
- TinyCC (`vendor/tinycc/`) is **removed** from the iOS build product. `bun:ffi`'s `cc` builder throws on iOS.
- `Bun.spawn`, `Bun.spawnSync` → throw helpful errors.
- `child_process` Node-shape module → throws helpful errors.
- `worker_threads` → if it can spawn additional JSC `VM`s without JIT, keep it; otherwise stub.

**The long pole.** Effort: 3–4 weeks. This is the work that determines whether the build even has a chance of passing review.

### M06 — Simulator hello-world

**Acceptance:**
- Bun fork cross-built for `aarch64-ios-simulator`.
- Toy iOS app embedding `libbun.a`, loads a `hello.js` resource, runs `console.log("hello from bun on iOS")`.
- Output appears in Xcode console.
- App boots in <2s on iPhone 15 Pro Simulator (Apple Silicon Mac).

**Effort:** 1–2 weeks. Includes Swift host + xcframework packaging.

### M07 — Real-device hello-world

**Acceptance:**
- Same as M06 but on physical iPhone 15 Pro (or whatever the latest device is at the time).
- Code-signed with a Developer certificate.
- Sandbox path correctness: `os.homedir()` returns `~/Library/Application Support/Milady/`; `os.tmpdir()` returns `NSTemporaryDirectory()`.
- `fs.readFile(bundle resource path)` works.
- No crashes from missing entropy sources, missing system frameworks, or signal-handler mismatches.

**Effort:** 1–2 weeks. Most of the work is sandbox-debugging.

### M08 — Agent bundle loads + Bun globals work

**Acceptance:**
- `agent-bundle.js` from `build-mobile-bundle.mjs` loads in `libbun.a` on simulator.
- `Bun.serve` starts a loopback HTTP server on 127.0.0.1:31337.
- `Bun.file("agent-bundle.js")` returns a usable handle.
- All `node:*` imports resolve (mostly via Bun's built-in compat).
- The agent reaches the "ready" state — same JSON status payload it returns on Android.

**Effort:** 2 weeks. Most of this is fixing assumptions in our agent code that didn't expect LLInt-only JS.

### M09 — LlamaCppCapacitor → libllama static linkage

**Acceptance:**
- `libllama.a` cross-built for iOS arm64 with Metal enabled.
- `bun:ffi` can call `llama_*` symbols via the `dlopen(NULL, ...)` static-link path.
- The agent's `LocalInferenceLoader` route through `@elizaos/plugin-capacitor-bridge` (or a new `@elizaos/plugin-ios-bun-bridge`) reaches `llama_*` symbols and generates tokens against Eliza-1 0.6B.
- Tokens stream back to the WebView UI via the loopback HTTP server.

**Effort:** 2 weeks. The Android side has this working; iOS path is parallel with iOS-specific Metal init.

### M10 — End-to-end Simulator: user types "hello", model replies

**Acceptance:**
- `bun run ios:simulator` (or platform-specific equivalent) builds, code-signs, and launches the simulator.
- UI loads, agent boots, model loads (Eliza-1 0.6B Q4_K_M from app bundle), user types "hello", reply streams in.
- Reproducible from clean checkout on a fresh M-series Mac in <30 min.
- Chat persists across app relaunch (PGlite via Capacitor Filesystem in `Documents/.milady/db.pglite`).

**This is "iOS local agent fully working end to end" per the original request.** Effort: 2 weeks. Mostly integration debugging.

### M11 — Real device end-to-end + battery / thermal characterization

**Acceptance:**
- Same as M10 but on iPhone 15 Pro / iPhone 16 Pro (or current).
- 10-message conversation with Eliza-1 0.6B completes in <60s total wall-clock.
- Thermal stays in `fair` or better.
- Battery drain quantified (<5% for the 10-message conversation).

**Effort:** 2 weeks. Includes profiling + tuning thread counts + KV-cache sizing for mobile.

### M12 — App Store submission

**Acceptance:**
- App Review accepts the binary.
- `PrivacyInfo.xcprivacy` complete.
- Fastlane `release` lane succeeds end-to-end.
- No `_jit` / `_dlopen("/var/...")` / `_posix_spawn` symbols in the shipped binary (per `verify-no-jit.sh`).

**Effort:** 2–4 weeks including expected 1–2 rejection cycles.

---

## 4. Total Estimate

Sum of optimistic estimates: **~6 calendar months for a 2-engineer team.** Add 50% buffer for the unknowns: **9 months realistic.** Add another 50% for the Anthropic Zig→Rust rewrite landing and breaking everything: **12 months pessimistic.**

| Quarter | Milestones | What ships |
|---------|------------|------------|
| Q1 | M01, M02, M03 | JSC + deps build; Bun fork has iOS targets but doesn't run |
| Q2 | M04, M05, M06, M07 | `libbun.a` runs hello.js on Sim + device; syscall audit complete |
| Q3 | M08, M09, M10 | Agent bundle loads, llama.cpp linked, end-to-end Simulator works |
| Q4 | M11, M12 | Device-tested, battery/thermal characterized, App Store submitted |

---

## 5. Risk Register (Ordered by Severity)

### R1 — Bun mid-rewrite to Rust (Severity: extreme)

Anthropic acquired Bun Dec 2025; the team is trialing a Zig→Rust port. Our fork tracks the Zig branch. If the Rust rewrite lands and Zig branch is abandoned, we either rebase onto Rust (potentially full rewrite of our patches) or stay on the last Zig release forever.

**Mitigation:** Quarterly check-ins on upstream direction. If the Rust rewrite ships and is the official path, pause the port at the next milestone boundary and re-evaluate.

### R2 — JSC private-API leakage (Severity: high)

WebKit's JSC build has historically pulled in symbols that are private API on iOS (mach, dyld internals, etc.). Detection requires actual link runs.

**Mitigation:** M01 acceptance gate includes a `nm` audit. Tracked patch set in `vendor-webkit/patches/`.

### R3 — App Review rejection (Severity: high)

Even with policy-compliant code, reviewers may flag the embedded JS interpreter or the `bun:ffi` allow-list trick.

**Mitigation:** Pre-submission TestFlight beta; have the cover letter ready; reference accepted apps that ship JSC + JS bundles (Realm, Hyperview, every RN-no-Hermes app).

### R4 — LLInt performance cliff on cold-start (Severity: medium)

Bun's startup includes JS-side init code (resolve plugins, build prompt registry, etc.). LLInt-only means 7× slower than JIT for this code.

**Mitigation:** Profile + optimize the cold path. Move heavy init to background after first paint. Cache parsed prompt registries to disk.

### R5 — `bun:ffi` semantics break (Severity: medium)

Our codebase has 13 `bun:ffi` sites, all in `plugin-aosp-local-inference`. Those are gated by `ELIZA_LOCAL_LLAMA=1` so they don't run on iOS by default. New plugins might assume the desktop `bun:ffi` model (arbitrary `dlopen`).

**Mitigation:** Plugin API doc explicitly states "iOS supports `bun:ffi` only for statically-linked, allow-listed symbols." Lint rule that catches new `dlopen("/path/...")` calls.

### R6 — Worker threads memory pressure (Severity: medium)

Each JSC `VM` is ~30–50 MB. A worker pool of 4 doubles memory, which is painful on a 6 GB iPhone.

**Mitigation:** Cap workers at 1–2 on iOS. Document the constraint.

### R7 — Background execution still bounded (Severity: low; this is everyone's problem)

iOS gives no continuous background mode for non-audio/VoIP apps. Bun runs in foreground + background-audio + push-wake windows.

**Mitigation:** Accept the constraint. The product is foreground-first; background work routes through `BGTaskScheduler` for opportunistic execution. Same constraint as the WKWebView path would have hit.

---

## 6. What Lands in This Session (Concrete First Steps)

I cannot complete a 6-month port in a single session. What I CAN do right now, that the team picks up:

1. **Scaffold `native/ios-bun-port/`** with the directory structure above and placeholder READMEs per subdir.
2. **Write the `M01–M12` milestone docs** with acceptance criteria so the next engineer knows what "done" means per stage.
3. **Add iOS-specific entries to `eliza/packages/agent/scripts/mobile-stubs/`** for the small Node API surface that needs to throw or shim on iOS (child_process, fs writers, Bun.spawn).
4. **Extend `build-mobile-bundle.mjs`** with an `--target=ios` mode that emits the bundle suitable for `libbun.a` consumption (different external imports list, different stub set).
5. **Draft `vendor-webkit/build-jsc-ios.sh`** referencing the node-jsc + NativeScript recipes — not a working script yet (we don't have WebKit checked out), but the exact commands + env vars needed.
6. **Update `SETUP_IOS.md`** to reflect the chosen architecture: the "cloud-hybrid" framing goes away; the new framing is "on-device Bun + on-device Llama."
7. **Wire CI hooks** so that future PRs touching `native/ios-bun-port/` trigger an iOS-specific lint pass.

The team picks up M01 from there.

---

## 7. Acceptance Criteria for "Port is Done"

When all of these are true, we declare the port shipped:

- [ ] M01–M12 acceptance gates all green.
- [ ] iPhone Simulator on Apple Silicon: `bun run ios:simulator` ships a working chat app with on-device Eliza-1 0.6B inference.
- [ ] iPhone 15 Pro / 16 Pro device: same.
- [ ] App Store TestFlight build available.
- [ ] App Store public submission accepted.
- [ ] `verify-no-jit.sh` passes on the shipped binary (no JIT symbols, no arbitrary-path `dlopen`, no `posix_spawn`).
- [ ] CI runs the simulator smoke test on every PR touching `native/ios-bun-port/` or `eliza/packages/agent/`.
- [ ] Documented runbook for rebasing onto upstream Bun releases.
- [ ] Documented fallback plan if the Anthropic Zig→Rust rewrite lands and breaks the fork.

When the above are true, the iOS local agent is real, consistent with the rest of the runtime, and on a real distribution channel. Everything else is feature work (Talk Mode, App Intents, ODR for larger models, etc.) and follows the existing audit at `REPORT.md`.
