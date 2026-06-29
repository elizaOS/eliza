# App UI-Smoke Bun Path Evidence

Issue: #9943 testing / CI reliability umbrella
Related: #9626 build process cross-platform audit
Date: 2026-06-29
Machine: Windows, PowerShell, Bun 1.4.0-canary.1, Node 24

## Problem

The app UI-smoke/aesthetic-audit wrapper seeded `BUN` as `bun.exe` / `bun`
when Bun was installed through WinGet and no `BUN_INSTALL` was present. Node's
child-process spawn could not resolve that fallback on this Windows machine.

Observed before this change:

```text
$ bun run --cwd packages/app audit:app
Error: spawn bun ENOENT
  syscall: 'spawn bun'
  path: 'bun'
  spawnargs: [ 'run', 'build:views' ]
```

This blocked the required `packages/app audit:app` loop before any screenshots
could be produced.

## Fix

Both UI-smoke launchers now resolve Bun from `PATH` using Windows `PATHEXT`
before falling back to `bun.exe` / `bun`:

- `packages/app/scripts/run-ui-playwright.mjs`
- `packages/app-core/scripts/playwright-ui-live-stack.ts`

On this machine, that resolves:

```text
C:\Users\Administrator\AppData\Local\Microsoft\WinGet\Links\bun.exe
```

## Validation

```text
$ bun run biome check --config-path biome.json --files-ignore-unknown=true --no-errors-on-unmatched packages\app\scripts\run-ui-playwright.mjs packages\app-core\scripts\playwright-ui-live-stack.ts
Checked 2 files in 1603ms. No fixes applied.
```

After the patch, the same audit command gets past the previous spawn failure:

```text
$ bun run --cwd packages/app audit:app
[build-views] plugins\plugin-app-control
...
[build-views] plugins\plugin-trajectory-logger
...
ERROR  @elizaos/core#build: command (...) C:\Users\Administrator\AppData\Local\Microsoft\WinGet\Links\bun.exe run build exited (1)
```

The remaining failure is the existing local dependency-store corruption in
`drizzle-orm`:

```text
error: Could not resolve: "./table.js"
error: Could not resolve: "../table.utils.js"
error: Could not resolve: "../tracing.js"
```

So this change fixes the Windows Bun resolution blocker; the audit is now
blocked later by the known incomplete `node_modules/.bun` store.
