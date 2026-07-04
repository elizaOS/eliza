# Evidence: #12262 remove script-test root wrappers

Date: 2026-07-04

## Change

- Deleted root `trajectory:inspect:test`.
- Deleted root `audit:e2e-coverage:test`.
- Documented direct `bun test ...` replacements in root `CLAUDE.md` / `AGENTS.md`.
- Updated `packages/scripts/e2e-coverage/README.md` to use the direct unit-test command.

Screenshots/recordings: N/A. This is a root script/docs cleanup with no UI behavior change.

## Verification

```bash
node -e "const p=require('./package.json'); for (const n of ['trajectory:inspect:test','audit:e2e-coverage:test']) if (Object.hasOwn(p.scripts,n)) throw new Error(n+' still exists'); if (Object.keys(p.scripts).length !== 205) throw new Error('script count '+Object.keys(p.scripts).length); console.log('script test wrapper deletion assertions passed')"
# script test wrapper deletion assertions passed
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
grep -RIn "trajectory:inspect:test\|audit:e2e-coverage:test" .github docs packages plugins scripts CLAUDE.md AGENTS.md package.json
# Remaining hits are root migration docs and historical #10200 evidence.
```

```bash
bun test packages/scripts/__tests__/trajectory-validate.test.ts
# Initial run without local node_modules failed resolving adze.
# Rerun with a temporary node_modules symlink to /Users/shawwalters/eliza/node_modules:
# 11 pass
# 0 fail
```

```bash
bun test packages/scripts/e2e-coverage/check-e2e-coverage.test.ts
# Initial run without local node_modules failed resolving @elizaos/core.
# Rerun with a temporary node_modules symlink still failed:
# error: ENOENT while resolving package '@elizaos/core' from '/Users/shawwalters/eliza-script-turbo-cache/plugins/plugin-commands/src/actions/handlers.ts'
```

Local dependency limitation:

```bash
ls -l /Users/shawwalters/eliza/node_modules/@elizaos/core
# /Users/shawwalters/eliza/node_modules/@elizaos/core -> ../../../../packages/core

test -e /Users/packages/core || echo "/Users/packages/core missing"
# /Users/packages/core missing
```

The e2e-coverage unit test needs workspace package resolution through `@elizaos/core`; the shared install available to this auxiliary worktree has a broken relative symlink. CI with a fresh workspace install should execute it normally.

```bash
git diff --check
# no output
```
