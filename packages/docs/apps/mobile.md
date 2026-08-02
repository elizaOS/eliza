---
title: "Mobile app"
sidebarTitle: "Mobile app"
description: "Run and develop the Capacitor-based elizaOS app on iOS and Android."
---

The mobile app is the shared `packages/app` web interface inside a Capacitor
shell. The shell adds native lifecycle handling and bridges for device
capabilities. The application ID is `ai.elizaos.app`; app identity and branding
come from `packages/app/app.config.ts`.

## Runtime modes

The mobile shell supports three runtime arrangements:

| Mode | Agent runtime | Typical use |
| --- | --- | --- |
| Remote | A paired agent on another device or host | Connect a phone to an existing local deployment |
| Cloud | Eliza Cloud | Managed access without running the agent on the phone |
| Local | An on-device runtime bundle | Offline or device-resident operation on supported builds |

Availability depends on the platform, build variant, native artifacts, and
credentials. A successful Capacitor build does not by itself prove that a
local model or on-device Bun engine is present.

## Build and open a platform project

From the repository root:

```bash
bun install

# Build, sync, and open the native IDE
bun run --cwd packages/app ios
bun run --cwd packages/app android
```

Use the build-only commands in automation:

```bash
bun run --cwd packages/app build:ios
bun run --cwd packages/app build:android
```

See the [mobile build guide](/apps/mobile/build-guide) for prerequisites,
sync-only iteration, signing, installation, and release checks.

## Local iOS runtime

```bash
bun run --cwd packages/app build:ios:local
```

This selects the iOS-local build lane and enables the full Bun engine. It
requires the native engine artifact and local-inference assets expected by the
build script. Device installation additionally requires a valid Apple signing
identity and provisioning profile.

## Native capabilities

Workspace Capacitor packages under `packages/native/plugins` cover agent and
runtime bridges, camera, contacts, location, messages, calendar, speech,
screen capture, device settings, local inference, gateway connectivity, and
other platform integrations.

Every capability is feature-detected. The UI must render loading, unavailable,
and error states separately; browser fallbacks are not evidence that a native
implementation exists. See [Capacitor plugins](/apps/mobile/capacitor-plugins).

## Deep links and authentication

The app receives platform deep links and routes accepted paths through the
shared shell. Authentication callbacks are validated by the application; a
synthetic callback must not create or replace a session. Use the committed
mobile E2E commands to test the real OS delivery path.

## Verify a mobile change

Build and install the current tree before testing. Capacitor packages the web
bundle into the native app, so restarting an older installed build does not
pick up renderer changes.

```bash
bun run --cwd packages/app test:e2e:ios
bun run --cwd packages/app test:e2e:android
```

Hardware- and account-dependent lanes require their documented simulator,
emulator, device, signing, model, or Cloud prerequisites. A skipped lane is not
a passing result.

## Related

- [Build guide](/apps/mobile/build-guide)
- [Capacitor plugins](/apps/mobile/capacitor-plugins)
- [Desktop app](/apps/desktop)
