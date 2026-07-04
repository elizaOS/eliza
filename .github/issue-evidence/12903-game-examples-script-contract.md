# #12903 game examples script-contract evidence

Branch slice: normalize script contracts for three simple runnable examples.

## Packages

- `packages/examples/game-of-life`
- `packages/examples/text-adventure`
- `packages/examples/tic-tac-toe`

## Script contract changes

- Removed `build: bun run typecheck`; these packages do not emit build
  artifacts.
- Kept `typecheck` as the real TypeScript validation command.
- Added read-only `lint:check`.
- Added `format` and read-only `format:check`.

## Verification

Current working tree: `origin/develop` at `8572de50ec`.

Static guard:

```bash
node - <<'NODE'
const fs = require('fs');
for (const p of ['packages/examples/game-of-life/package.json','packages/examples/text-adventure/package.json','packages/examples/tic-tac-toe/package.json']) {
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
packages/examples/game-of-life/package.json: fake build removed; check verbs present
packages/examples/text-adventure/package.json: fake build removed; check verbs present
packages/examples/tic-tac-toe/package.json: fake build removed; check verbs present
```

Read-only lint and format:

```bash
bun run --cwd packages/examples/game-of-life lint:check
bun run --cwd packages/examples/game-of-life format:check
bun run --cwd packages/examples/text-adventure lint:check
bun run --cwd packages/examples/text-adventure format:check
bun run --cwd packages/examples/tic-tac-toe lint:check
bun run --cwd packages/examples/tic-tac-toe format:check
```

Result:

```text
packages/examples/game-of-life: biome check passed for 3 files; biome format passed for 3 files.
packages/examples/text-adventure: biome check passed for 4 files; biome format passed for 4 files.
packages/examples/tic-tac-toe: biome check passed for 3 files; biome format passed for 3 files.
```

## Local blockers

This auxiliary worktree does not have a valid workspace install.

```text
bun run --cwd packages/examples/game-of-life test
  ENOENT while resolving package '@elizaos/core'

bun run --cwd packages/examples/text-adventure test
  Cannot find module '@clack/prompts'

bun run --cwd packages/examples/tic-tac-toe test
  ENOENT while resolving package '@elizaos/core'

bun run --cwd <each package> typecheck
  error TS2688: Cannot find type definition file for 'node'
```

This slice changes only package scripts; it does not change runtime or test code.
