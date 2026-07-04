# #12903 runnable TypeScript examples script-contract evidence

Branch slice: normalize script contracts for five runnable TypeScript examples.

## Packages

- `packages/examples/autonomous`
- `packages/examples/chat`
- `packages/examples/convex`
- `packages/examples/mcp`
- `packages/examples/telegram`

## Script contract changes

- Removed `build: bun run typecheck`; these packages do not emit build
  artifacts.
- Kept `typecheck` as the real TypeScript validation command.
- Added read-only `lint:check`.
- Added `format` and read-only `format:check`.

## Verification

Current working tree: `origin/develop` at `e3267dd50c`.

Static guard:

```bash
node - <<'NODE'
const fs = require('fs');
const files = ['packages/examples/autonomous/package.json','packages/examples/chat/package.json','packages/examples/convex/package.json','packages/examples/mcp/package.json','packages/examples/telegram/package.json'];
for (const p of files) {
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
packages/examples/autonomous/package.json: fake build removed; check verbs present
packages/examples/chat/package.json: fake build removed; check verbs present
packages/examples/convex/package.json: fake build removed; check verbs present
packages/examples/mcp/package.json: fake build removed; check verbs present
packages/examples/telegram/package.json: fake build removed; check verbs present
```

Read-only lint and format:

```bash
for pkg in packages/examples/autonomous packages/examples/chat packages/examples/convex packages/examples/mcp packages/examples/telegram; do
  bun run --cwd "$pkg" lint:check
  bun run --cwd "$pkg" format:check
done
```

Result:

```text
packages/examples/autonomous: biome check passed for 6 files; biome format passed for 6 files.
packages/examples/chat: biome check passed for 4 files; biome format passed for 4 files.
packages/examples/convex: biome check passed for 11 files; biome format passed for 11 files.
packages/examples/mcp: biome check passed for 4 files; biome format passed for 4 files.
packages/examples/telegram: biome check passed for 5 files; biome format passed for 5 files.
```

## Local blockers

This auxiliary worktree does not have a valid workspace install.

Tests:

```text
packages/examples/autonomous: Cannot find module '@elizaos/core'
packages/examples/chat: Cannot find module 'dotenv/config'
packages/examples/convex: skipped cleanly because CONVEX_URL is not set
packages/examples/mcp: ENOENT while resolving package '@elizaos/core', then MCP connection closed
packages/examples/telegram: Cannot find module '@elizaos/core'
```

Typecheck with a temporary
`node_modules -> /Users/shawwalters/eliza/node_modules` symlink:

```text
packages/examples/autonomous: TS2688 cannot find type definition file for 'node'
packages/examples/chat: TS2688 cannot find type definition file for 'node'
packages/examples/convex: unresolved workspace/convex modules and node globals
packages/examples/mcp: TS2688 cannot find type definition file for 'node'
packages/examples/telegram: TS2688 cannot find type definition file for 'node'
```

This slice changes only package scripts; it does not change runtime or test code.
