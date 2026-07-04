# #12903 example fake build/typecheck cleanup evidence

Branch slice: remove package-level fake `typecheck` / `build` scripts from
example packages that do not have package-level TypeScript or build artifacts.

## Packages

- `packages/examples/app/capacitor`
- `packages/examples/app/electron`
- `packages/examples/html`
- `packages/examples/moltbook/bags-claimer`

## Script contract changes

- Removed `typecheck: echo 'No TypeScript config; skipping typecheck'`.
- Removed `build: echo 'No build step configured; skipping build'`.
- Added real read-only `lint:check` and `format:check` scripts.
- Added mutating `format` scripts to pair with the existing mutating `lint`.

The app workspace packages keep their explicit delegated commands such as
`build:frontend` / `build:renderer`; only the fake package-level `build` was
removed.

## Verification

Current working tree: `origin/develop` at `ed24761896`.

Read-only lint, format, and smoke tests:

```bash
bun run --cwd packages/examples/app/capacitor lint:check
bun run --cwd packages/examples/app/capacitor format:check
bun run --cwd packages/examples/app/capacitor test

bun run --cwd packages/examples/app/electron lint:check
bun run --cwd packages/examples/app/electron format:check
bun run --cwd packages/examples/app/electron test

bun run --cwd packages/examples/html lint:check
bun run --cwd packages/examples/html format:check
bun run --cwd packages/examples/html test

bun run --cwd packages/examples/moltbook/bags-claimer lint:check
bun run --cwd packages/examples/moltbook/bags-claimer format:check
```

Results:

```text
packages/examples/app/capacitor:
  biome check passed for 20 files
  biome format passed for 19 files
  test passed: 4 pass, 0 fail

packages/examples/app/electron:
  biome check passed for 22 files
  biome format passed for 21 files
  test passed: 4 pass, 0 fail

packages/examples/html:
  biome check passed for 3 files
  biome format passed for 2 files
  test passed: 3 pass, 0 fail

packages/examples/moltbook/bags-claimer:
  biome check passed for 3 files
  biome format passed for 3 files
```

## Local blocker

`packages/examples/moltbook/bags-claimer` test requires dependencies from a
workspace install. This clean auxiliary worktree has no local `node_modules`,
and a temporary `node_modules -> /Users/shawwalters/eliza/node_modules` symlink
still does not resolve the package dependency:

```bash
bun run --cwd packages/examples/moltbook/bags-claimer test
```

Result:

```text
error: Cannot find module '@solana/web3.js' from '.../packages/examples/moltbook/bags-claimer/claimer.ts'
```

This slice changes only scripts; it does not change Bags Claimer runtime or test
code.
