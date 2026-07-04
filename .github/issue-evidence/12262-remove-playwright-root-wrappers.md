# Evidence: #12262 remove Playwright root wrappers

Date: 2026-07-04

## Change

- Deleted root `test:cloud:playwright` and `test:ui:playwright`.
- Replaced active call sites with `bun run --cwd packages/app test:e2e`.
- Updated the scenario PR workflow contract test so it asserts the root wrappers stay absent.
- Updated root `CLAUDE.md` / `AGENTS.md` migration rows and script count.

Screenshots/recordings: N/A. This is a root script/docs/test-contract cleanup with no UI behavior change.

## Verification

```bash
node -e "const p=require('./package.json'); for (const n of ['test:ui:playwright','test:cloud:playwright']) if (Object.hasOwn(p.scripts,n)) throw new Error(n+' still exists'); if (Object.keys(p.scripts).length !== 208) throw new Error('script count '+Object.keys(p.scripts).length); console.log('playwright wrapper deletion assertions passed')"
# playwright wrapper deletion assertions passed
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
node -e "JSON.parse(require('fs').readFileSync('packages/app-core/test/regression-matrix.json','utf8')); console.log('regression matrix json parsed')"
# regression matrix json parsed
```

```bash
node -e "const app=require('./packages/app/package.json').scripts; if (!app['test:e2e']) throw new Error('missing packages/app test:e2e'); if (!app['test:desktop:packaged']) throw new Error('missing packages/app test:desktop:packaged'); console.log('app package replacement scripts exist')"
# app package replacement scripts exist
```

```bash
node <<'NODE'
const fs = require('fs');
const scenario = fs.readFileSync('packages/scenario-runner/src/scenario-pr-workflow.test.ts','utf8');
for (const needle of [
  'expect(rootPackage.scripts?.["test:cloud:playwright"]).toBeUndefined()',
  'expect(rootPackage.scripts?.["test:ui:playwright"]).toBeUndefined()',
  'bun run --cwd packages/app test:e2e'
]) {
  if (!scenario.includes(needle)) throw new Error(`missing scenario assertion: ${needle}`);
}
const parallel = fs.readFileSync('packages/app-core/test/scripts/test-parallel.mjs','utf8');
if (!parallel.includes('args: ["run", "--cwd", "packages/app", "test:e2e"]')) throw new Error('parallel runner still uses root wrapper');
const matrix = JSON.parse(fs.readFileSync('packages/app-core/test/regression-matrix.json','utf8'));
if (matrix.suites?.['ui-playwright-smoke']?.command !== 'bun run --cwd packages/app test:e2e') throw new Error('matrix replacement mismatch');
console.log('playwright wrapper call-site assertions passed');
NODE
# playwright wrapper call-site assertions passed
```

```bash
grep -RIn "test:cloud:playwright\|test:ui:playwright" .github docs packages plugins scripts CLAUDE.md AGENTS.md package.json
# Remaining hits are root migration docs, updated absence assertions, and historical #10200 evidence files.
```

```bash
git diff --check
# no output
```

```bash
bun run --cwd packages/docs test
# 15 pass
# 0 fail
```

Targeted Vitest limitation:

```bash
bun run --cwd packages/scenario-runner test src/scenario-pr-workflow.test.ts
# /opt/homebrew/bin/bash: line 1: vitest: command not found

/Users/shawwalters/eliza/node_modules/.bin/vitest run --config packages/scenario-runner/vitest.config.ts --passWithNoTests packages/scenario-runner/src/scenario-pr-workflow.test.ts
# zsh: no such file or directory: /Users/shawwalters/eliza/node_modules/.bin/vitest

ls -l /Users/shawwalters/eliza/node_modules/.bin/vitest /Users/shawwalters/eliza/node_modules/vitest/vitest.mjs
# /Users/shawwalters/eliza/node_modules/.bin/vitest -> ../vitest/vitest.mjs
# ls: /Users/shawwalters/eliza/node_modules/vitest/vitest.mjs: No such file or directory
```

The local shared install has a broken Vitest shim, so the scenario-runner file could not be executed in this auxiliary worktree. The changed contracts are covered by the static assertions above and should run in CI with a complete install.
