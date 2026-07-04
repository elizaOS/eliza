# Issue #12259 - test:core uses the test orchestrator

## Change

- Removed the root `turbo.json` `test` task so root test lanes are not routed through a generic Turbo package graph.
- Rewired root `test:core` from `run-turbo.mjs run test --filter=./packages/core` to `run-all-tests.mjs --only=test --no-cloud --filter='@elizaos/core \\(packages/core\\)#test'`.

## Verification

Run on 2026-07-04:

- `node -e "const fs=require('fs'); const t=JSON.parse(fs.readFileSync('turbo.json','utf8')).tasks; if ('test' in t) process.exit(1);"`
- `node -e "const fs=require('fs'); const pkg=JSON.parse(fs.readFileSync('package.json','utf8')); if (!pkg.scripts['test:core'].includes('run-all-tests.mjs') || pkg.scripts['test:core'].includes('run-turbo.mjs')) process.exit(1);"`
- `node packages/scripts/run-all-tests.mjs --only=test --no-cloud --filter='@elizaos/core \\(packages/core\\)#test' --plan=json`
- `git diff --check origin/develop..HEAD`

The plan output selected exactly one task:

- `@elizaos/core (packages/core)#test`

Attempted full runtime verification:

- `bun run test:core`

That command reached `@elizaos/core (packages/core)#test`, then failed because the auxiliary worktree did not have a local install and the temporary shared `node_modules` symlink did not contain `vitest/vitest.mjs`. A fresh monorepo install was not attempted because the machine had about 7.8 GiB free at the time of verification.

## Evidence notes

Screenshots and recordings are N/A: this is a root CLI/Turbo configuration change with no user interface.
