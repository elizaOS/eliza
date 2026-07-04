# Evidence: #12262 remove browser-bridge root wrappers

Date: 2026-07-04

## Change

- Deleted root `test:browser-bridge`.
- Deleted root `test:browser-bridge:safari`.
- Renamed package-local `packages/browser-extension` CI-style test surface:
  - `test:unit` now runs the Vitest unit suite.
  - `test` now runs `test:unit && test:smoke`.
  - `test:ci` was removed.
- Documented direct replacements in root `CLAUDE.md` / `AGENTS.md`.
- Updated `packages/browser-extension/CLAUDE.md` / `AGENTS.md` command docs.

Screenshots/recordings: N/A. This is a root/package script and docs cleanup with no UI behavior change.

## Verification

```bash
node <<'NODE'
const root = require('./package.json').scripts;
for (const n of ['test:browser-bridge','test:browser-bridge:safari']) if (Object.hasOwn(root,n)) throw new Error(`${n} still exists`);
if (Object.keys(root).length !== 203) throw new Error(`root script count ${Object.keys(root).length}`);
const browser = require('./packages/browser-extension/package.json').scripts;
if (browser.test !== 'bun run test:unit && bun run test:smoke') throw new Error(`browser test body: ${browser.test}`);
if (!browser['test:unit']) throw new Error('missing test:unit');
if (Object.hasOwn(browser,'test:ci')) throw new Error('browser test:ci still exists');
console.log('browser bridge wrapper deletion assertions passed');
NODE
# browser bridge wrapper deletion assertions passed
```

```bash
node scripts/assert-agents-claude-identical.mjs
# [assert-agents-claude-identical] PASS: 301 tracked CLAUDE.md/AGENTS.md pair(s) are byte-identical.
```

```bash
node packages/scripts/audit-scripts.mjs
# [audit-scripts] OK - no orphan/no-op/broken scripts.
```

```bash
grep -RIn "test:browser-bridge\(:safari\)\?\|test:ci" packages/browser-extension .github docs packages plugins scripts CLAUDE.md AGENTS.md package.json
# Remaining root-name hits are root migration docs and historical #10200 evidence.
# Other `test:ci` hits are unrelated package-local or renamed-root migration references.
```

```bash
bun run --cwd packages/browser-extension test:smoke
# run with a temporary node_modules symlink to /Users/shawwalters/eliza/node_modules
# Built Agent Browser Bridge extension 2.0.0-beta.2 (2.0.0.40002) to .../packages/browser-extension/dist/chrome
# Agent Browser Bridge extension smoke checks passed.
```

```bash
bun run --cwd packages/browser-extension test:smoke:safari
# run with a temporary node_modules symlink to /Users/shawwalters/eliza/node_modules
# exited 0
```

Unit-test limitation:

```bash
bun run --cwd packages/browser-extension test:unit
# failed to load config from .../packages/browser-extension/vitest.extension.config.ts
# Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'vitest' imported from /Users/shawwalters/eliza/node_modules/.vite-temp/...
```

The auxiliary worktree relies on the main checkout's shared dependency install, whose Vitest package/shim is incomplete. The package-local unit command should run in CI with a fresh install.

```bash
git diff --check
# no output
```
