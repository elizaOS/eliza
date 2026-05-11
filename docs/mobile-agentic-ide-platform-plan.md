# Mobile Agentic IDE Platform Plan

Last reviewed: 2026-05-11

## Goal

Milady should expose the strongest agentic IDE capability each platform can
honestly support:

- AOSP / ElizaOS Android: full on-device backend, terminal, file creation,
  dynamic TypeScript / JavaScript app creation, and coding-agent orchestration.
- iOS App Store and Google Play: store-friendly local applets over a virtual
  file system, plus cloud containers for full shell / Claude / Codex / OpenCode.
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
4. TODO-STORE-MOBILE-BRIDGES: Store-mobile provider attachment: real JSCore/QuickJS/WASM bridge wiring to
   `MobileSafeRuntimeProvider`. Provider detection no longer advertises JSCore,
   QuickJS, or in-process safe-js unless an actual boundary/dev flag is attached.
5. TODO-VFS-UI: VFS UI: snapshot, diff, rollback, quota display, and "promote to cloud
   container" flow.
6. TODO-CLOUD-BACKEND: Cloud workspace backend/control plane: accept VFS bundle uploads,
   start Claude/Codex/OpenCode containers, stream terminal/task state, and pull
   back patches. The local plugin/API contract exists.
7. TODO-REVIEW-NOTES: Review posture: app descriptions and review notes must describe local
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
