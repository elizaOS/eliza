# Mobile Agentic IDE Platform Plan

Last reviewed: 2026-05-11

## Goal

Milady should expose the strongest agentic IDE capability each platform can
honestly support:

- AOSP / ElizaOS Android: full on-device backend, terminal, file creation,
  dynamic TypeScript / JavaScript app creation, and coding-agent orchestration.
- iOS App Store and Google Play: store-friendly local applets over a virtual
  file system, plus cloud containers for full shell / Claude / Codex / OpenCode.
- iOS local development / sideload builds: on-device local mode for developers
  and sideload users, without assuming enterprise distribution. This target may
  bundle signed native inference/runtime components, but the backend still has
  to run inside iOS-safe app boundaries instead of pretending Bun or a host
  shell exists.
- Desktop direct builds: full local execution.
- Desktop store builds: OS-sandboxed app behavior, with cloud containers for
  unrestricted coding-agent work.

Cloud hosting is not a mobile-only fallback. It remains a first-class hosting
option on every platform, including desktop. When a user selects Cloud, the
agent runs in a cloud container and can be resumed from other devices.

## Current Code State

This branch now has the following foundation:

- AOSP plugin loading includes `@elizaos/plugin-shell`,
  `@elizaos/plugin-coding-tools`, and `agent-orchestrator` through
  `ELIZAOS_ANDROID_TERMINAL_PLUGINS`.
- The Android service exports `SHELL=/system/bin/sh` and
  `CODING_TOOLS_SHELL=/system/bin/sh` for the Bun agent process.
- `plugin-coding-tools` resolves the host shell by platform instead of
  hardcoding `/bin/bash`.
- `mobile-safe-runtime.ts` has a provider contract for:
  - `android-avf-microdroid`
  - `android-isolated-process`
  - `safe-js-applet`
  - `javascriptcore`
  - `quickjs`
  - `wasm`
- `MobileSafeVirtualFileSystem` now includes read/write/delete/mkdir/stat/list,
  snapshots, diffs, rollback, and quota reporting, with in-memory quota and
  max-file enforcement for store-mobile applets.
- The app-core VFS contract can broker file capabilities and adapt the agent
  `VirtualFilesystemService`.
- The agent `VirtualFilesystemService` remains the durable on-disk VFS:
  project quotas, max-file quotas, traversal rejection, symlink rejection,
  snapshots, diffs, and rollback.
- Workbench exposes VFS REST routes for project creation, file read/write/list,
  quota, snapshots, diffs, rollback, TypeScript plugin compilation, and loading
  a VFS-sourced plugin into the running agent runtime.
- The Android template exposes a reflection-only AVF/Microdroid probe through
  `ElizaNative.getAndroidVirtualization()` and request contract through
  `ElizaNative.requestAndroidVirtualization(...)`. It does not yet package a
  Microdroid payload.
- The Eliza Cloud plugin exposes local routes and service methods for promoting
  a VFS bundle into a coding container, requesting a Claude/Codex/OpenCode
  container, and syncing changes. These fail closed with 503-style unavailable
  responses when Cloud auth or the backend control-plane endpoint is unavailable.
- `android-cloud` mobile builds produce a release AAB by default, with
  `android-cloud-debug` reserved for iteration. Cloud builds strip the on-device
  agent service, privileged default-role activities, system-only permissions,
  staged `assets/agent` runtime, disguised native runtime libraries,
  `MANAGE_VIRTUAL_MACHINE`, and cloud-disallowed native plugin references, then
  audit the source tree and output artifact.
- Store desktop builds remove local execution plugins from the load set even
  when config or environment asks for shell, coding tools, or agent
  orchestrator.
- iOS local dev/sideload builds have an `ios-local` build target that bakes
  `runtimeMode=local`, starts the native Agent plugin in local mode, routes
  foreground local-agent requests through the WebView ITTP kernel, exposes a
  foreground native `Agent.request` / `Agent.chat` bridge into that kernel,
  persists the kernel's local state through the native storage bridge, and reports
  `GET /api/local-agent/capabilities`.
- The iOS ITTP kernel intentionally reports `task_service_unavailable` for
  `/api/background/run-due-tasks` and `/api/internal/wake`; Capacitor
  BackgroundRunner runs in a separate JSContext and cannot call the WebView
  kernel while suspended. This preserves the single `ScheduledTask` primitive
  instead of adding a parallel mobile task store.

## Policy Baseline

### iOS / iPadOS App Store

Hard constraints:

- No local Bun backend, no local shell, no PTY-spawned Claude/Codex/OpenCode,
  and no local Linux VM.
- Apple requires executable code on iOS-family platforms to be signed by Apple
  certificates and prevents unsigned/self-modifying executable code.
- App Review Guideline 2.5.2 says apps must be self-contained and may not
  download, install, or execute code that introduces or changes app features or
  functionality.

Allowed shape:

- User-created projects, scripts, and applets stored as user documents in our
  VFS. Public VFS API responses intentionally omit host filesystem roots.
- Interpretation by an attached, reviewable runtime boundary such as
  JavaScriptCore, QuickJS isolated process, or WASM, provided the applet is
  treated as user content in the IDE and cannot escape into native code, private
  APIs, or forbidden platform behavior. The in-process `safe-js-applet` fallback
  is dev-only and is not advertised as a hard sandbox.
- Full shell and coding agents through Cloud hosting containers.

### iOS / iPadOS Local Development And Sideload

This is a separate target from the App Store build. It covers local Xcode
developer installs, Homebrew-assisted local development flows, and normal
sideloading with the user's development signing identity. It does **not** rely
on enterprise distribution.

Allowed shape:

- Bundle signed native frameworks at build time, including the on-device
  llama.cpp bridge used by local inference.
- Bake `runtimeMode=local` into the Capacitor app and route the stable
  `http://127.0.0.1:31337` local-agent URL through an in-process route kernel
  or a native app-owned IPC surface such as `WKURLSchemeHandler`.
- Run the backend as signed/bundled app code, JSCore/QuickJS/WASM code shipped
  with the app, or user-authored IDE content inside the mobile-safe runtime.

Still not allowed / not assumed:

- No enterprise entitlement assumptions.
- No hidden Bun runtime unless it is proven to run as signed, bundled app code
  inside iOS sandbox constraints.
- No downloaded native plugins, toolchains, or unsigned executable code.
- No host-like shell/PTY assumption; any "backend local" path must use iOS
  storage, background, networking, and sandbox APIs explicitly.

### Google Play Android

Hard constraints:

- Do not ship the privileged AOSP Bun/local-agent path to Play.
- Do not download dex/JAR/native `.so` executable code outside Play.
- Runtime-loaded interpreted languages are allowed only if they cannot enable
  Google Play policy violations.

Allowed shape:

- Android app sandbox plus VFS-backed applets.
- Android `isolatedProcess` service for stricter local execution boundaries.
- Packaged WASM/QuickJS/JS runtimes for constrained user-authored applets.
- Cloud containers for shell, Claude, Codex, OpenCode, and broad repo work.

### AOSP / ElizaOS Android

Hard constraints:

- This is not a Play Store artifact. It can use privileged/system-app behavior
  and platform-signed permissions that Play cannot.
- AVF/Microdroid Java APIs are currently `@SystemApi` and require the restricted
  `MANAGE_VIRTUAL_MACHINE` permission, so this is realistic for AOSP/system
  builds, not normal third-party APKs.
- Microdroid is a strong isolation boundary, but it is not a full Android app
  environment. It supports native/Bionic payloads, Binder RPC over vsock,
  Verified Boot, SELinux, and a subset of APIs. It does not support the normal
  `android.*` Java app API surface.

Allowed shape:

- Full on-device Bun agent service.
- Shell via `/system/bin/sh`.
- PTY / terminal UI where the AOSP image permits it.
- Bundled toolchain: `git`, `rg`, coreutils/toybox/busybox, TypeScript
  compiler, Bun, and any Android-compatible coding-agent adapter binaries.
- Optional AVF/Microdroid execution boundary when the device/build exposes it.
- Agent VFS fallback when AVF is missing or unsuitable.

### Desktop Stores

- Mac App Store: App Sandbox is required. Embedded helper tools can work if
  signed correctly and sandbox-inherited, but arbitrary user-installed CLIs are
  not a good store posture.
- Microsoft Store: MSIX AppContainer is the strong sandbox posture. Full-trust
  MSIX weakens the security claim.
- Flathub: keep filesystem permissions narrow, prefer portals, and avoid
  `--filesystem=home` / `--filesystem=host` for the store build.

## Platform Capability Matrix

| Platform/build | Local VFS applets | Local shell | Coding agents | AVF / VM | Cloud containers |
| --- | --- | --- | --- | --- | --- |
| iOS App Store | Yes: JSCore/QuickJS/WASM | No | Cloud only | No | Yes |
| iOS local dev / sideload | Yes: JSCore/QuickJS/WASM + bundled native inference | No host shell; iOS-safe route/runtime only | Planned on-device backend subset; cloud for shell agents | No | Yes |
| Android Play | Yes: isolatedProcess/WASM/QuickJS | No for store build | Cloud only | Not for third-party APKs today | Yes |
| AOSP / ElizaOS Android | Yes | Yes | Yes, after bundled adapters are validated | Yes if build/device exposes AVF | Yes |
| macOS direct | Yes | Yes | Yes | Optional local VM, usually not needed | Yes |
| Mac App Store | Yes | App-container only | Cloud preferred | Hypervisor entitlement only if approved | Yes |
| Windows direct | Yes | Yes | Yes | Optional | Yes |
| Microsoft Store AppContainer | Yes | Container-scoped only | Cloud preferred | No separate VM needed | Yes |
| Linux direct | Yes | Yes | Yes | Optional | Yes |
| Flathub | Yes | Sandbox-scoped only | Cloud preferred | No separate VM needed | Yes |

## Recommended Runtime Layers

### Layer 1: VFS Applets Everywhere

Every platform gets a project VFS. Generated apps are stored as VFS projects
with a manifest, entrypoint, dependencies, and declared capabilities. The agent
can:

1. Create files in the VFS.
2. Compile TypeScript to JavaScript using a bundled compiler.
3. Snapshot before risky edits.
4. Run tests or app previews through the selected safe runtime provider.
5. Roll back if an applet breaks.

On store mobile, these applets are user content inside the IDE. They cannot
install native code, mutate the host app binary, spawn shell, or bypass the
platform sandbox.

### Layer 2: Store-Mobile Local Execution

iOS and Play builds should route local app execution through:

- `MobileSafeVirtualFileSystem`
- `MobileSafeCapabilityBroker`
- `javascriptcore` or `quickjs` on iOS
- `android-isolated-process`, `quickjs`, or `wasm` on Android

This is enough for dynamic UI/app prototypes, local validators, small JS
programs, workflow scripts, and generated app previews. It is not a substitute
for a real terminal or coding-agent CLI.

### Layer 3: AOSP Full Local IDE

AOSP should route local execution through the existing Bun backend, now with
shell/coding-tools/orchestrator loaded. The remaining AOSP work is:

1. Validate PTY behavior on Cuttlefish and real devices.
2. Bundle and expose a known-good toolchain under the app/service path.
3. Decide coding-agent adapters:
   - Prefer ACP/ACPX or in-process adapters when available.
   - Use PTY-backed CLIs only when Android-compatible binaries exist.
   - Fall back to Cloud containers for Codex/Claude/OpenCode when local
     binaries are unavailable.
4. Package the Microdroid payload and attach VM lifecycle/RPC to the existing
   native AVF bridge for supported AOSP builds.
5. Use the agent VFS for snapshots/rollback even when writing into a broader
   workspace.

### Layer 4: Cloud Containers Everywhere

When the user has Eliza Cloud, local devices should be able to start a cloud
workspace container with Claude, Codex, OpenCode, shell, repo tools, and full
agent-orchestrator support. This is the correct solution for:

- iOS full coding-agent sessions.
- Google Play full coding-agent sessions.
- Desktop store builds that should not run arbitrary host CLIs.
- Any device that lacks local toolchain support.

## AVF / Microdroid Plan

Use AVF only where the Android build can legally and technically access it:

- AOSP/system app: yes.
- OEM/enterprise partner image: yes, if the permission and API are granted.
- Google Play third-party APK: no, not with the current public API surface.

Implementation steps:

1. Done: Java `AndroidVirtualizationBridge` probes `VirtualMachineManager`,
   permission state, feature state, and exposed capabilities through reflection.
2. Done: app-core can attach a feature probe / boundary from
   `window.ElizaNative`.
3. Done: feature detection only advertises AVF when an env/native/global probe
   reports support.
4. Remaining: package a Microdroid payload embedded in the APK/product image.
5. Remaining: expose Binder/vsock RPC for:
   - `shell.exec`
   - `app.compile`
   - `app.load`
   - `app.run`
   - VFS file exchange
6. Treat AVF as an execution boundary for dangerous work. Do not assume the
   whole Bun backend can move into Microdroid until Bun-on-Bionic/Microdroid is
   proven.

## What Is Not Feasible

- Full local shell/coding agents on iOS App Store.
- Local Linux VM on iOS/iPadOS.
- Bun backend hidden inside a Play Store app as a general arbitrary-code
  execution environment.
- AVF/Microdroid for normal third-party Play Store APKs while the API remains
  restricted.
- Downloaded native toolchains, dex/JARs, or `.so` plugins outside app-store
  update channels.

## Open Engineering Gaps

These are intentionally written as concrete TODOs because the surrounding
architecture is otherwise easy to overstate in product or API docs.

1. TODO-AOSP-PTY: AOSP real-device terminal validation: PTY, foreground service lifetime,
   stdout/stderr streaming, process cleanup.
2. TODO-AOSP-TOOLCHAIN: AOSP bundled tools: `git`, `rg`, archive tools, package-manager stance, and
   Android-compatible coding-agent adapters.
3. TODO-AVF-PAYLOAD: Microdroid payload work: VM lifecycle, payload build, Binder/vsock RPC,
   file sync, telemetry, and fallback to VFS.
4. TODO-STORE-MOBILE-BRIDGES / TODO-STORE-MOBILE-NATIVE-BRIDGES: Store-mobile provider attachment: real JSCore/QuickJS/WASM bridge wiring to
   `MobileSafeRuntimeProvider`. Provider detection no longer advertises JSCore,
   QuickJS, or in-process safe-js unless an actual boundary/dev flag is attached.
5. TODO-IOS-SIDELOAD-LOCAL-BACKEND: iOS dev/sideload local backend: the build target,
   native local start/status path, ITTP foreground routing, native-synced local
   state, and capability reporting exist. Remaining work is to replace the
   WebView-only compatibility kernel with the real shared route kernel, mount
   durable iOS database/storage for the AgentRuntime, and validate foreground
   chat plus background `ScheduledTask` dispatch on a signed physical device.
6. TODO-VFS-UI: VFS UI: snapshot, diff, rollback, quota display, and "promote to cloud
   container" flow.
7. TODO-CLOUD-RUNTIME-UX: Cloud coding runtime UX: stream terminal/task state
   from the running Claude/Codex/OpenCode container and add a real patch applier
   if callers need patch-format sync. The backend now forwards VFS bundles into
   the persistent workspace volume, starts coding containers, applies full-file
   sync pushes, and exports files for pull/roundtrip sync.
8. TODO-REVIEW-NOTES: Review posture: app descriptions and review notes must describe local
   applets as IDE/user-content execution, and full shell as Cloud/AOSP/direct
   only.

## Verification Guard Rails

The policy surface is guarded by tests rather than prose alone:

- `packages/agent/src/runtime/plugin-collector-aosp.test.ts` checks that
  AOSP loads shell, coding tools, and orchestrator while stock mobile and store
  desktop builds do not.
- `packages/app-core/src/runtime/mobile-safe-runtime.test.ts` checks provider
  detection, AVF preference, isolated-process fallback, VFS snapshots, diffs,
  rollback, quota, and brokered operations.
- `packages/app-core/src/runtime/android-avf-microdroid-bridge.test.ts` checks
  the JS-facing Android AVF probe/boundary contract.
- `packages/agent/src/api/workbench-vfs-routes.test.ts` checks the VFS REST
  project/file/snapshot/diff flow.

## External References

- Apple App Review Guidelines:
  https://developer.apple.com/app-store/review/guidelines/
- Apple code signing security:
  https://support.apple.com/en-ie/guide/security/sec7c917bf14/web
- Google Play Developer Program policy:
  https://support.google.com/googleplay/android-developer/answer/16549787
- Android application sandbox:
  https://source.android.google.cn/docs/security/app-sandbox?hl=en
- Android `isolatedProcess` services:
  https://developer.android.com/guide/topics/manifest/service-element
- Android Microdroid:
  https://source.android.com/docs/core/virtualization/microdroid?hl=en
- Android Virtualization Framework Java API README:
  https://android.googlesource.com/platform/packages/modules/Virtualization/+/c63581a77c8b08fbe7bce83c603b4abaa0d81d31/javalib/README.md
- MSIX AppContainer:
  https://learn.microsoft.com/en-us/windows/msix/msix-containerization-overview
- Flatpak sandbox permissions:
  https://docs.flatpak.org/en/latest/sandbox-permissions.html
