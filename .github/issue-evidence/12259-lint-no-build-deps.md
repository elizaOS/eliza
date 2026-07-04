# Issue #12259 - Lint tasks no longer force builds

PR scope:

- Removed generic `dependsOn` build prerequisites from the `lint` Turbo task.
- Removed the same generic build prerequisites from the `lint:check` Turbo
  task.
- Left `typecheck` build prerequisites unchanged.

Local verification on 2026-07-04:

```bash
node -e "const fs=require('fs'); const t=JSON.parse(fs.readFileSync('turbo.json','utf8')).tasks; if ('dependsOn' in t.lint || 'dependsOn' in t['lint:check']) process.exit(1); if (!Array.isArray(t.typecheck.dependsOn)) process.exit(1);"

node -e "JSON.parse(require('fs').readFileSync('turbo.json','utf8'));"

git diff --check origin/develop..HEAD
```

Turbo dry-run:

```bash
ln -s /Users/shawwalters/eliza/node_modules node_modules
node packages/scripts/run-turbo.mjs run lint:check --dry=json --filter=./packages/core
rm node_modules
```

The dry-run completed and emitted a `lint:check` plan without any build task
dependency injected by the generic lint task.

Screenshots/recordings: N/A, Turbo config only; no UI changed.
