---
title: "Desktop app"
description: "Run, build, and extend the elizaOS desktop shell for macOS, Windows, and Linux."
---

The desktop product uses the shared `packages/app` React interface inside an
Electrobun shell. The shell owns native windows, menus, deep links, updates,
permissions, and communication with the agent process.

## Run from source

```bash
bun install
bun run dev:macos:watch # macOS assistant: tray-owned pill + on-demand Workspace
bun run dev:desktop:watch # generic full-window Workspace on any desktop
```

Packaged macOS builds default to the normal full-window Workspace experience.
Use `bun run build:macos` for that local production candidate, or the explicit
`bun run build:macos:assistant` command for the tray-owned assistant/pill
experiment. Both experiences render the shared app and canonical `ChatOverlay`;
this is a startup/window policy, not a second macOS UI or bundle identity.

For renderer-only work, use the app package's shared development server:

```bash
bun run --cwd packages/app dev:shared
bun run --cwd packages/app dev:status
```

The shared server chooses a deterministic worktree port so concurrent lanes do
not contend for the default UI port. See
[Shared development server](/development/shared-dev-server).

## Runtime modes

The shell can host a local agent process or connect the UI to a remote or Cloud
runtime, depending on the build and selected configuration. The desktop main
process owns startup and health checks; the renderer displays runtime state but
does not spawn or supervise the agent itself.

The API port defaults to `31337` and the development UI port to `2138`. Use
`ELIZA_API_PORT` and `ELIZA_UI_PORT` when a lane needs explicit values.

## Native capabilities

Desktop integrations include window and menu control, global shortcuts, deep
links, file and external-URL handling, gateway discovery, audio and talk mode,
screen capture, camera, canvas, location, and permission checks. Availability
varies by operating system.

Access native behavior through the registered bridge and feature detection.
Never import a platform implementation directly into shared renderer code.

See [Native modules](/apps/desktop/native-modules) for the maintained package
boundaries.

## Deep links

The application registers the `elizaos` URL scheme. The main process validates
and forwards accepted links to the shared routing layer. Treat every link as
untrusted input: validate its scheme, path, host-like parameters, and requested
operation before navigation or external access.

## Updates

Packaged desktop builds use signed release metadata and artifacts. The updater
must verify the selected release authority before applying an update. Local
development builds do not prove the packaged update path.

See [Self-updates](/self-updates) and [Build and release](/build-and-release).

## Development rules

- Keep business logic outside the main-process transport and RPC layers.
- Preserve the three UI states: loading, designed empty/unavailable, and error.
- Release native resources and subscriptions when a window or runtime stops.
- Validate every renderer-to-main request and every URL opened outside the app.
- Rebuild the packaged shell before collecting desktop evidence; a running old
  package does not contain current renderer or main-process changes.

Package layout, scripts, environment variables, and platform-specific test lanes
are documented in `packages/app/CLAUDE.md` and
`packages/app-core/CLAUDE.md`.

## Related

- [Desktop local development](/apps/desktop-local-development)
- [Native modules](/apps/desktop/native-modules)
- [Mobile app](/apps/mobile)
