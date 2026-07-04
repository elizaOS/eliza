# #12903 REST API example script-contract evidence

Branch slice: normalize script contracts for the three REST API examples.

## Packages

- `packages/examples/rest-api/elysia`
- `packages/examples/rest-api/express`
- `packages/examples/rest-api/hono`

## Script contract changes

- Removed `build: bun run typecheck` from all three packages. These packages do
  not emit build artifacts; `typecheck` remains the real TypeScript validation
  command.
- Added read-only `lint:check`.
- Added `format` and read-only `format:check`.

## Verification

Current working tree: `origin/develop` at `75bb9c3411`.

Static guard:

```bash
node - <<'NODE'
const fs = require('fs');
for (const p of ['packages/examples/rest-api/elysia/package.json','packages/examples/rest-api/express/package.json','packages/examples/rest-api/hono/package.json']) {
  const pkg = JSON.parse(fs.readFileSync(p,'utf8'));
  const scripts = pkg.scripts || {};
  const bad = [];
  if ('build' in scripts) bad.push(`build=${scripts.build}`);
  if (!scripts.typecheck) bad.push('missing typecheck');
  for (const name of ['lint:check','format','format:check']) if (!scripts[name]) bad.push(`missing ${name}`);
  if (bad.length) { console.error(`${p}: ${bad.join('; ')}`); process.exitCode = 1; }
  else console.log(`${p}: fake build removed; check verbs present`);
}
NODE
```

Result:

```text
packages/examples/rest-api/elysia/package.json: fake build removed; check verbs present
packages/examples/rest-api/express/package.json: fake build removed; check verbs present
packages/examples/rest-api/hono/package.json: fake build removed; check verbs present
```

Read-only lint and format:

```bash
bun run --cwd packages/examples/rest-api/elysia lint:check
bun run --cwd packages/examples/rest-api/elysia format:check
bun run --cwd packages/examples/rest-api/express lint:check
bun run --cwd packages/examples/rest-api/express format:check
bun run --cwd packages/examples/rest-api/hono lint:check
bun run --cwd packages/examples/rest-api/hono format:check
```

Result:

```text
packages/examples/rest-api/elysia: biome check passed for 4 files; biome format passed for 4 files.
packages/examples/rest-api/express: biome check passed for 4 files; biome format passed for 4 files.
packages/examples/rest-api/hono: biome check passed for 4 files; biome format passed for 4 files.
```

## Local blockers

This clean auxiliary worktree does not have a local workspace install. A
temporary `node_modules -> /Users/shawwalters/eliza/node_modules` symlink starts
the commands, but dependency resolution remains broken.

Blocked commands and first failures:

```text
bun run --cwd packages/examples/rest-api/elysia typecheck
bun run --cwd packages/examples/rest-api/express typecheck
bun run --cwd packages/examples/rest-api/hono typecheck
  error TS2688: Cannot find type definition file for 'node'

bun run --cwd packages/examples/rest-api/elysia test
bun run --cwd packages/examples/rest-api/express test
bun run --cwd packages/examples/rest-api/hono test
  ENOENT while resolving package '@elizaos/core'
```

This slice changes only package scripts; it does not change REST API runtime or
test code.
