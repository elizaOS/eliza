# Desktop Bottom-Bar Follow-Up Evidence

Issue: #9953
Follow-up to merged PR: #10032
Date: 2026-06-29
Machine: Windows, PowerShell, Bun 1.4.0-canary.1, Node 24

## Fixes

- Main-window diagnostics now use the same shell presentation metadata as
  `createMainWindow()`, so bottom-bar and kiosk windows report
  `titleBarStyle: "hidden"` instead of the old platform default.
- Tray popover now opens as an app renderer window with the app URL, preload,
  RPC object, app partition, and API-base injection on `dom-ready`.
- Open tray popovers are included in later API-base broadcasts alongside the
  main and detached surface windows.

## Validation

```text
$ git diff --check
passed

$ bunx @biomejs/biome check packages/app-core/platforms/electrobun/src/desktop-bottom-bar-config.ts packages/app-core/platforms/electrobun/src/desktop-bottom-bar-config.test.ts packages/app-core/platforms/electrobun/src/index.ts packages/app-core/platforms/electrobun/src/native/desktop.ts packages/app-core/platforms/electrobun/src/native/desktop-window.test.ts
Checked 5 files in 2s. No fixes applied.
```

Direct Vitest without the app-core config:

```text
$ bunx vitest run packages/app-core/platforms/electrobun/src/desktop-bottom-bar-config.test.ts packages/app-core/platforms/electrobun/src/native/desktop-window.test.ts --environment node
packages/app-core/platforms/electrobun/src/desktop-bottom-bar-config.test.ts: 13 passed
packages/app-core/platforms/electrobun/src/native/desktop-window.test.ts: blocked before collection by missing local dependency `chalk`
```

Configured app-core Vitest remains blocked before collection by the incomplete
local install:

```text
Cannot find module 'react/package.json'
```

Package typecheck is also blocked locally because `tsgo` is absent from the
workspace install:

```text
bun: command not found: tsgo
```

Screenshots/video are N/A for this follow-up: the patch is native window boot
plumbing and diagnostics metadata, not a visual renderer change. The merged
bottom-bar UI still needs the broader packaged Electrobun/aesthetic evidence
loop before #9953 can be closed.
