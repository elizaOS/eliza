---
title: "Capacitor plugins"
sidebarTitle: "Capacitor plugins"
description: "Understand and extend the native capability bridges used by the elizaOS mobile app."
---

Custom native bridges live under `packages/native/plugins`. Each package owns
its TypeScript contract and whichever Swift, Kotlin, web, or desktop
implementations it supports.

The package source is the API reference. This page explains the integration
rules that apply across the set without duplicating every method signature.

## Capability groups

The workspace includes bridges for:

- agent and on-device runtime communication;
- local inference and Bun runtime hosting;
- gateway discovery and transport;
- camera, screen capture, canvas, and browser surfaces;
- contacts, messages, phone, calendar, location, Wi-Fi, and device settings;
- speech recognition, wake words, talk mode, and mobile signals;
- activity, reminders, tasks, app blocking, and website blocking.

Platform support is not uniform. Some packages are intentionally iOS-only,
Android-only, web-only, or a shared facade over different native behaviors.

## Build before use

```bash
bun run --cwd packages/app plugin:build
bun run --cwd packages/app cap:sync:ios
bun run --cwd packages/app cap:sync:android
```

Rebuild a plugin after changing its TypeScript or native source. A stale native
project can otherwise contain an older bridge while the web bundle expects a
new contract.

## Feature detection

Initialize the shared bridge before accessing a capability and check the
reported capability map. A package being installed in the workspace does not
guarantee that its native implementation is available on the current platform
or build variant.

```typescript
import { isFeatureAvailable, waitForBridge } from "./bridge/plugin-bridge";

await waitForBridge();

if (!isFeatureAvailable("camera")) {
  renderCameraUnavailable();
  return;
}

await window.Eliza.plugins.camera.requestPermissions();
```

Render permission denial, unsupported capability, native error, and loading as
distinct states.

## Add or change a bridge

1. Read the plugin package's `CLAUDE.md` and existing TypeScript definition.
2. Change the shared contract additively when existing clients depend on it.
3. Implement and test each claimed platform; use an explicit unavailable
   result for unsupported platforms.
4. Register the package with the app bridge and its capability probe.
5. Rebuild, sync, reinstall, and exercise the real simulator, emulator, or
   device path.

Do not treat a web mock as native proof. Verify permissions, lifecycle changes,
cancellation, repeated calls, background/foreground transitions, and teardown
on every affected platform.

Browse the maintained package contracts in
[`packages/native/plugins`](https://github.com/elizaOS/eliza/tree/develop/packages/native/plugins).
