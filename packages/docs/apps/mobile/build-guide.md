---
title: "Mobile build guide"
sidebarTitle: "Build guide"
description: "Build, sync, sign, install, and verify the elizaOS iOS and Android apps."
---

The commands on this page run from the repository root and use the scripts in
`packages/app/package.json`.

## Prerequisites

Both platforms require Bun, repository dependencies, and the workspace native
plugins. iOS additionally requires macOS, Xcode, and CocoaPods. Android requires
a JDK, Android Studio or command-line SDK tools, and an installed Android SDK.

```bash
bun install
bun run --cwd packages/app plugin:build
```

## Build

```bash
# Compile the web app and native plugins, then sync Capacitor
bun run --cwd packages/app build:ios
bun run --cwd packages/app build:android
```

Open the generated project after building:

```bash
bun run --cwd packages/app ios
bun run --cwd packages/app android
```

The `ios` and `android` scripts perform a build before opening Xcode or Android
Studio.

## Sync an existing web build

When the web assets and plugins are already built, sync them without rebuilding
the whole application:

```bash
bun run --cwd packages/app cap:sync:ios
bun run --cwd packages/app cap:sync:android

# Or sync both
bun run --cwd packages/app cap:sync
```

Do not use sync-only commands after changing a native plugin unless that plugin
has also been rebuilt.

## Local-runtime iOS build

```bash
bun run --cwd packages/app build:ios:local
```

This lane enables the full Bun engine and fails when its required native
artifact or model assets are unavailable. It is distinct from an ordinary
Capacitor build.

## Signing and distribution

Xcode manages iOS development and distribution signing. Android release builds
require a protected keystore and matching signing configuration. Never commit
certificates, provisioning profiles, keystores, or their passwords.

Run the appropriate preflight before distribution:

```bash
bun run --cwd packages/app preflight:ios:sideload
bun run --cwd packages/app preflight:ios:store
bun run --cwd packages/app preflight:android:sideload
bun run --cwd packages/app preflight:android:store
```

## Install helpers

```bash
bun run --cwd packages/app install:ios:sideload
bun run --cwd packages/app install:android:adb
```

These operate on an already built artifact. Rebuild first whenever the source
or bundled web assets changed.

## Verification

```bash
bun run --cwd packages/app test:e2e:ios
bun run --cwd packages/app test:e2e:android
```

Confirm the installed application is the current build, then inspect device
logs and the real UI output. Device, local-model, Cloud, and store lanes have
different prerequisites; consult `packages/app/CLAUDE.md` and the script help
for the current specialized commands.
