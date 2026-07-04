# #12903 integration examples script-contract evidence

Branch slice: normalize script contracts for three integration examples.

## Packages

- `packages/examples/cloudflare`
- `packages/examples/farcaster`
- `packages/examples/twitter-xai`

## Script contract changes

- Removed `build: bun run typecheck`; these packages do not emit build
  artifacts.
- Kept `typecheck` as the real TypeScript validation command.
- Added `format` and read-only `format:check`.
- Kept existing read-only `lint:check`.

## Verification

Current working tree: `origin/develop` at `c1f211d534`.

Static guard:

```bash
node - <<'NODE'
const fs = require('fs');
for (const p of ['packages/examples/cloudflare/package.json','packages/examples/farcaster/package.json','packages/examples/twitter-xai/package.json']) {
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
packages/examples/cloudflare/package.json: fake build removed; check verbs present
packages/examples/farcaster/package.json: fake build removed; check verbs present
packages/examples/twitter-xai/package.json: fake build removed; check verbs present
```

Read-only lint and format:

```bash
for pkg in packages/examples/cloudflare packages/examples/farcaster packages/examples/twitter-xai; do
  bun run --cwd "$pkg" lint:check
  bun run --cwd "$pkg" format:check
done
```

Result:

```text
packages/examples/cloudflare: biome check passed for 4 files; biome format passed for 4 files.
packages/examples/farcaster: biome check passed for 5 files; biome format passed for 5 files.
packages/examples/twitter-xai: biome check passed for 5 files; biome format passed for 5 files.
```

## Runtime/test probes

```text
packages/examples/cloudflare test:
  Worker not available at http://localhost:8787
  Skipping integration tests (worker must be running)

packages/examples/farcaster test:
  Cannot find module '@elizaos/core'

packages/examples/twitter-xai test:
  Cannot find module '@elizaos/core'
```

Typecheck with a temporary
`node_modules -> /Users/shawwalters/eliza/node_modules` symlink:

```text
packages/examples/cloudflare:
  TS2688 cannot find type definition file for '@cloudflare/workers-types'

packages/examples/farcaster:
  TS2688 cannot find type definition file for 'node'

packages/examples/twitter-xai:
  TS2688 cannot find type definition file for 'node'
```

This auxiliary worktree has about 4 GiB free and no valid local install, so full
`bun install` / `bun run verify` were not run here.
