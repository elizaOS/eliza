# #12903 example lint-mask cleanup evidence

Branch slice: normalize the script contracts for three `packages/examples/*`
packages that were hiding read-only checks behind `|| true`.

## Packages

- `packages/examples/code`
- `packages/examples/elizagotchi`
- `packages/examples/moltbook`

## Script contract changes

- Removed `|| true` from `lint:check` in all three packages.
- Removed `|| true` from `format:check` in `packages/examples/moltbook`.
- Added `format` / `format:check` to `packages/examples/code` and
  `packages/examples/elizagotchi`.
- Added `clean: rm -rf dist` to `packages/examples/code` and
  `packages/examples/elizagotchi`, which both have real builds that emit
  `dist`.
- Removed the fake `build: bun run typecheck` from
  `packages/examples/moltbook`; it emits no artifact, so `typecheck` remains the
  real command.

## Verification

Current working tree: `origin/develop` at `2b7ce1ede1`.

Static script guard:

```bash
node - <<'NODE'
const fs = require('fs');
for (const p of ['packages/examples/code/package.json','packages/examples/elizagotchi/package.json','packages/examples/moltbook/package.json']) {
  const pkg = JSON.parse(fs.readFileSync(p,'utf8'));
  const bad = Object.entries(pkg.scripts || {}).filter(([,v]) => /\|\|\s*true|echo .*skipping|No build step|No TypeScript/.test(v));
  if (bad.length) {
    console.error(`${p}: ${bad.map(([k,v]) => `${k}=${v}`).join('; ')}`);
    process.exitCode = 1;
  } else {
    console.log(`${p}: no masked/fake success scripts`);
  }
}
NODE
```

Result:

```text
packages/examples/code/package.json: no masked/fake success scripts
packages/examples/elizagotchi/package.json: no masked/fake success scripts
packages/examples/moltbook/package.json: no masked/fake success scripts
```

Read-only lint and format checks:

```bash
bun run --cwd packages/examples/code lint:check
bun run --cwd packages/examples/code format:check
bun run --cwd packages/examples/elizagotchi lint:check
bun run --cwd packages/examples/elizagotchi format:check
bun run --cwd packages/examples/moltbook lint:check
bun run --cwd packages/examples/moltbook format:check
```

Result:

```text
packages/examples/code: biome check passed for 52 files; biome format passed for 51 files.
packages/examples/elizagotchi: biome check passed for 18 files; biome format passed for 17 files.
packages/examples/moltbook: biome check passed for 9 files; biome format passed for 9 files.
```

`packages/examples/code` and `packages/examples/elizagotchi` also print a
non-failing Biome info message because their package-local `biome.json` schema
URL is `2.5.1` while the resolved CLI is `2.5.2`.

Targeted tests:

```bash
bun run --cwd packages/examples/elizagotchi test
```

Result:

```text
2 pass, 0 fail
```

## Local blockers

This auxiliary worktree does not have a valid local install. A temporary
`node_modules -> /Users/shawwalters/eliza/node_modules` symlink was enough to
start `tsgo`/`bun test`, but package resolution remains broken because the
shared install's workspace symlinks point outside this worktree.

Blocked commands and first failures:

```text
bun run --cwd packages/examples/code typecheck
  error TS2688: Cannot find type definition file for 'bun'
  error TS2688: Cannot find type definition file for 'node'

bun run --cwd packages/examples/elizagotchi typecheck
  error TS2688: Cannot find type definition file for 'node'

bun run --cwd packages/examples/moltbook typecheck
  error TS2688: Cannot find type definition file for 'node'

bun run --cwd packages/examples/code test
  ENOENT while resolving package '@elizaos/core'
  Cannot find module '@elizaos/tui'

bun run --cwd packages/examples/moltbook test
  Cannot find module 'dotenv/config'
  Cannot find module '@solana/web3.js'
```

The worktree was checked after these probes and remained clean except for this
slice's package script edits and this evidence file.
