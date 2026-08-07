# @elizaos/electrobun

Native desktop shell for the elizaOS app on macOS, Windows, and Linux.

## Role

This package owns the Electrobun main process, preload, native desktop integration, renderer asset serving, RPC boundary, window/tray/menu lifecycle, updater, and packaged-agent startup. It is a shell around the shared app and agent runtime, not a second implementation of either.

The main-process composition root is `src/index.ts`. Keep renderer-facing behavior behind the typed RPC schema and local API proxy. Native modules belong under `src/native/`; cross-surface agent and API behavior belongs in app-core or the agent package.

## Layout

```
src/
  index.ts                    main-process composition and lifecycle
  rpc-schema.ts               renderer/main RPC contract
  rpc-handlers.ts             handler composition
  *-rpc.ts                    focused RPC slices
  native/                     agent host, desktop features, permissions, updates
  lifecycle/                  readiness, API ownership, and session state
  renderer-static.ts          packaged renderer asset serving
  renderer-api-proxy.ts       authenticated local API forwarding
  surface-windows.ts          detached view/window ownership
  application-menu.ts         native menu model
  desktop-tray-config.ts      tray and popover policy
  main-window-session.ts      renderer partition and window-mode policy
assets/                       branded icons and generated brand data
entitlements/                 macOS signing capabilities and rationale
scripts/                      preload, signing, packaging, and smoke helpers
docs/                         desktop architecture and audit records
electrobun.config.ts          packaging configuration
```

## Commands

```bash
bun run --cwd packages/app-core/platforms/electrobun dev
bun run --cwd packages/app-core/platforms/electrobun build
bun run --cwd packages/app-core/platforms/electrobun build:preload
bun run --cwd packages/app-core/platforms/electrobun build:native-effects
bun run --cwd packages/app-core/platforms/electrobun typecheck
bun run --cwd packages/app-core/platforms/electrobun lint:check
bun run --cwd packages/app-core/platforms/electrobun test
bun run --cwd packages/app-core/platforms/electrobun voice:validate:dry
bun run --cwd packages/app-core/platforms/electrobun voice:validate:live
```

The package build delegates to `packages/app-core/scripts/desktop-build.mjs`, which owns the complete production pipeline.

## Boundaries and invariants

- Resolve the agent API base once through the lifecycle owners; do not let individual RPC handlers invent ports or authentication.
- Validate every renderer/main message at the RPC boundary. Keep the preload narrow and do not expose unrestricted filesystem, process, or shell access.
- Preserve desktop session partitioning, auth priming, and renderer proxy rules when changing window startup.
- Main-window, tray, kiosk, detached-surface, and cloud-auth windows have distinct lifecycle and privacy requirements; update their focused modules and tests together.
- Use this package's logger. Main-process failures must appear in startup diagnostics and user-visible fatal/recovery state where appropriate.
- Signing, entitlements, bundled native libraries, and updater metadata are release contracts. Test packaged output, not only `electrobun dev`.
- macOS native effects must be rebuilt after changing their sources. Windows proof requires the real installer and interactive desktop; Linux proof requires the produced package on its target distribution.
- UI changes still follow `packages/app` visual review requirements because this shell renders that app.

## Verification

Follow the [app-core guide](../../CLAUDE.md), the [app guide](../../../app/CLAUDE.md), and the repository-wide standard in the [root CLAUDE.md](../../../../CLAUDE.md). Run typecheck and tests, build the current renderer and desktop package, install it, and manually review startup, authentication, agent readiness, windows, menus, tray behavior, updates, logs, and shutdown on every affected operating system.

