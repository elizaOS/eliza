# Mobile Agentic IDE Platform Plan

This plan tracks the mobile-safe runtime boundary for iOS, stock Android, web
fallbacks, and privileged AOSP system builds.

## Runtime Providers

The mobile-safe runtime provider set is:

- android-avf-microdroid
- safe-js-applet
- javascriptcore
- quickjs
- wasm
- android-isolated-process

Provider availability is capability-driven. A provider appears only when the
native boundary or WebView primitive exists; otherwise the app stays on Cloud
containers, VFS, or WASM-safe applets.

## Privileged AOSP Terminal Plugins

Privileged AOSP builds can enable terminal and coding surfaces that stock mobile
builds cannot expose:

- @elizaos/plugin-shell
- @elizaos/plugin-coding-tools
- agent-orchestrator

These plugins require a system image that can run the local Bun agent under an
appropriate SELinux context. Store and Play builds must keep these out of the
local runtime surface.

## Implementation Tracking

- TODO-AOSP-PTY: validate PTY behavior under the privileged Android service.
- TODO-AOSP-TOOLCHAIN: lock the AOSP toolchain, SDK, and binary staging path.
- TODO-AVF-PAYLOAD: define the AVF/Microdroid payload build, RPC lifecycle, and
  capability reporting.
- TODO-STORE-MOBILE-NATIVE-BRIDGES: keep App Store and Play Store builds on
  approved native bridges only.
- TODO-VFS-UI: expose mobile-safe VFS state, quota, diff, and rollback in the
  UI.
- TODO-CLOUD-RUNTIME-UX: make Cloud fallback and Cloud container execution
  explicit in mobile UX.
- TODO-REVIEW-NOTES: keep review notes tied to the current provider matrix and
  build targets.

