# App UI-Smoke Windows Follow-Up Evidence

Issue: #9943 testing / CI reliability umbrella  
Related: #9626 build process cross-platform audit  
Date: 2026-06-29  
Machine: Windows, PowerShell, Bun 1.4.0-canary.1, Node 24

## Problem

After PR #10045 fixed the original `spawn bun ENOENT` blocker, continuing the
same `packages/app audit:app` run uncovered the next Windows launch failures:

1. `playwright.ui-smoke.config.ts` invoked the app-core live-stack helper with a
   bare `node`, which failed on this machine with `'node' is not recognized`.
2. The app config imports `@elizaos/shared/brand` before Vite aliases apply, so
   a fresh checkout without `packages/shared/dist` can fail before the UI smoke
   server starts.
3. The Node build of `@elizaos/core` exposed `VIEW_KINDS` in its export list
   without importing/exporting the value from `types/view-kind`, causing bare
   Node imports to fail.

Observed before the follow-up:

```text
[WebServer] 'node' is not recognized as an internal or external command,
operable program or batch file.
```

and, after the web server launched:

```text
SyntaxError: Export 'VIEW_KINDS' is not defined in module
```

## Fix

- Resolve a real Node executable once in `packages/app/scripts/run-ui-playwright.mjs`
  and pass it as `ELIZA_NODE_PATH`.
- Use `ELIZA_NODE_PATH` in `packages/app/playwright.ui-smoke.config.ts` instead
  of a bare `node` command.
- Normalize both `PATH` and Windows `Path` when prepending Bun's directory.
- Make `packages/app-core/scripts/playwright-ui-live-stack.ts` honor Windows
  `Path` when resolving executables.
- Prebuild both `@elizaos/shared` and `@elizaos/core` before UI-smoke runs so
  app config loading and renderer bundling have the workspace package dists.
- Explicitly export `VIEW_KINDS`, `VIEW_KIND_META`, and view-kind helpers from
  `packages/core/src/index.node.ts`.

## Validation

Targeted checks passed:

```text
$ bun run biome check packages\core\src\index.node.ts packages\app\scripts\run-ui-playwright.mjs packages\app\playwright.ui-smoke.config.ts packages\app-core\scripts\playwright-ui-live-stack.ts
Checked 4 files in 1390ms. No fixes applied.

$ bun run --cwd packages/core build:node --skip-testing
... declarations emitted successfully ...

$ node -e "import('@elizaos/core').then(m=>console.log('ok core', JSON.stringify(m.VIEW_KINDS)))"
ok core ["system","release","developer","preview"]

$ node packages\scripts\run-turbo.mjs run build --filter=@elizaos/shared --filter=@elizaos/core
Tasks: 5 successful, 5 total
```

The app audit now launches the live-stack through the absolute Node executable:

```text
"C:\Program Files\nodejs\node.exe" packages/app-core/scripts/run-node-tsx.mjs packages/app-core/scripts/playwright-ui-live-stack.ts
"C:\Program Files\nodejs\node.exe" --conditions=eliza-source --import tsx packages/app-core/scripts/playwright-ui-live-stack.ts
```

The remaining local blocker is the incomplete local `node_modules/.bun` package
store. After repairing several missing local package payloads/links, `build:web`
advanced into the wallet/Solana graph and transformed more than 7,000 modules,
then failed on additional missing nested package links, for example:

```text
✓ 7191 modules transformed.
[vite]: Rollup failed to resolve import "@solana/subscribable" from
node_modules/.bun/@solana+rpc-subscriptions-channel-websocket@5.5.1+009971104ee2239c/...
```

This prevents producing fresh screenshots/video on this machine right now, but
it is downstream of the Windows launcher and workspace prebuild issues fixed by
this PR.
