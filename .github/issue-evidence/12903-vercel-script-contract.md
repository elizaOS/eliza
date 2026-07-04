# #12903 Vercel example script-contract evidence

Branch slice: normalize the Vercel Edge example package scripts.

## Package

- `packages/examples/vercel`

## Script contract changes

- Removed `build: tsc --noEmit`; it emitted no build artifact and duplicated
  the existing `typecheck` command.
- Removed the `|| echo ... skipping` test wrapper. `test-client.ts` already
  handles a missing local endpoint and exits 0 with instructions, so the wrapper
  only hid real command failures.
- Added `format` and read-only `format:check`.

## Verification

Current working tree: `origin/develop` at `9f93cee71f`.

Static guard:

```bash
node - <<'NODE'
const fs = require('fs');
const p = 'packages/examples/vercel/package.json';
const pkg = JSON.parse(fs.readFileSync(p,'utf8'));
const scripts = pkg.scripts || {};
const bad = [];
if ('build' in scripts) bad.push(`build=${scripts.build}`);
for (const [name, body] of Object.entries(scripts)) if (/\|\|\s*true|\|\|\s*echo|echo .*skipping|tsc\s+--noEmit/.test(body)) bad.push(`${name}=${body}`);
for (const name of ['lint:check','format','format:check','typecheck','test']) if (!scripts[name]) bad.push(`missing ${name}`);
if (bad.length) { console.error(bad.join('\n')); process.exit(1); }
console.log('vercel scripts normalized');
NODE
```

Result:

```text
vercel scripts normalized
```

Commands:

```bash
bun run --cwd packages/examples/vercel lint:check
bun run --cwd packages/examples/vercel format:check
bun run --cwd packages/examples/vercel test
```

Result:

```text
biome check passed for 6 files.
biome format passed for 6 files.
test-client.ts exited 0 through its built-in no-server path:
  Server not available at http://localhost:3000
  Tests skipped (no server running)
```

## Local blocker

`typecheck` was attempted with a temporary
`node_modules -> /Users/shawwalters/eliza/node_modules` symlink. Dependency
resolution remains broken in this auxiliary worktree:

```text
bun run --cwd packages/examples/vercel typecheck
  error TS2688: Cannot find type definition file for 'node'
```

This slice changes only package scripts; it does not change Vercel runtime code.
