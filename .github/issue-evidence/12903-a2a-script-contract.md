# #12903 A2A example script-contract evidence

Branch slice: normalize `packages/examples/a2a` package scripts.

## Script contract changes

- Removed `build: bun run typecheck`; it emitted no build artifact.
- Kept `typecheck` as the real TypeScript validation command.
- Added read-only `lint:check`.
- Added `format` and read-only `format:check`.

## Verification

Current working tree: `origin/develop` at `9f93cee71f`.

Static guard:

```bash
node - <<'NODE'
const fs = require('fs');
const p = 'packages/examples/a2a/package.json';
const pkg = JSON.parse(fs.readFileSync(p,'utf8'));
const scripts = pkg.scripts || {};
const bad = [];
if ('build' in scripts) bad.push(`build=${scripts.build}`);
if (!scripts.typecheck) bad.push('missing typecheck');
for (const name of ['lint:check','format','format:check']) if (!scripts[name]) bad.push(`missing ${name}`);
if (bad.length) { console.error(bad.join('\n')); process.exit(1); }
console.log('a2a scripts normalized');
NODE
```

Result:

```text
a2a scripts normalized
```

Commands:

```bash
bun run --cwd packages/examples/a2a lint:check
bun run --cwd packages/examples/a2a format:check
```

Result:

```text
biome check passed for 5 files.
biome format passed for 5 files.
```

## Local blockers

This auxiliary worktree does not have a valid local workspace install.

```text
bun run --cwd packages/examples/a2a test
  Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'express' imported from .../packages/examples/a2a/server.ts

bun run --cwd packages/examples/a2a typecheck
  error TS2688: Cannot find type definition file for 'node'
```

The test command was also attempted without leaving any lockfile or dependency
churn in the worktree.
