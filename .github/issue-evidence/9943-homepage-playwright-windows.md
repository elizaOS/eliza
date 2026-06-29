# Homepage Playwright Windows Launcher Evidence

Issue: #9943 testing coverage / CI reliability umbrella
Related: #9626 build process cross-platform audit
Date: 2026-06-29
Machine: Windows, PowerShell, Bun 1.4.0-canary.1, Node 24

## Problem

The homepage Playwright config started its web server with POSIX-only inline
environment syntax:

```text
VITE_ELIZACLOUD_API_URL=https://www.elizacloud.ai node ../../node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4444
```

On Windows, the default command failed before Vite could start:

```text
$ bun run --cwd packages/homepage test:e2e -- marketing-cloud-download.spec.ts
[WebServer] 'VITE_ELIZACLOUD_API_URL' is not recognized as an internal or external command,
[WebServer] operable program or batch file.
Error: Process from config.webServer was not able to start. Exit code: 1
```

## Fix

Replaced the shell-specific web server command with
`node scripts/run-playwright-web-server.mjs`.

The launcher:

- runs the same `sync-to-public.mjs ./public` preparation step;
- injects `VITE_ELIZACLOUD_API_URL` through Node's `env` object;
- starts Vite through `process.execPath`;
- forwards shutdown signals to the Vite child process.

The homepage Playwright per-test timeout was raised from the default 30 seconds
to 60 seconds so cold Vite startup and live `HEAD` link checks pass on Windows
without retry-only success. Assertion timeout is unchanged.

## Validation

```text
$ bun run biome check --config-path biome.json --files-ignore-unknown=true --no-errors-on-unmatched packages\homepage\playwright.config.ts packages\homepage\scripts\run-playwright-web-server.mjs
Checked 2 files in 287ms. No fixes applied.
```

```text
$ bun run --cwd packages/homepage test
2 pass
0 fail
```

```text
$ bun run --cwd packages/homepage test:e2e -- marketing-cloud-download.spec.ts --project=chromium
Running 2 tests using 2 workers
  ok 1 [chromium] › tests\e2e\marketing-cloud-download.spec.ts:157:1 › homepage live marketing links resolve for cloud, os, release, and downloads (37.2s)
  ok 2 [chromium] › tests\e2e\marketing-cloud-download.spec.ts:48:1 › homepage centers Eliza App downloads and product CTAs (42.7s)
  2 passed (1.2m)
```

## Remaining Local Limitation

`bun run --cwd packages/homepage typecheck` is still blocked on this machine by
the interrupted local dependency store:

```text
src/components/login/country-flag.tsx(2,33): error TS2307: Cannot find module 'country-flag-icons/react/3x2' or its corresponding type declarations.
```

That module-resolution failure predates this launcher change and is tracked as a
local install/dependency-store limitation in the broader Windows verification
work.
