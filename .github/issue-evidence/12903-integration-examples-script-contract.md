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

Current working tree: `github/develop` at `c1f211d534`.

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

Typecheck:

```bash
bun run --cwd plugins/plugin-xai build
bun run --cwd plugins/plugin-x build
for pkg in packages/examples/cloudflare packages/examples/farcaster packages/examples/twitter-xai; do
  bun run --cwd "$pkg" typecheck
done
```

```text
packages/examples/cloudflare: passed
packages/examples/farcaster: passed
packages/examples/twitter-xai: passed after building @elizaos/plugin-xai and @elizaos/plugin-x
```

Tests:

```bash
for pkg in packages/examples/cloudflare packages/examples/farcaster packages/examples/twitter-xai; do
  timeout 60s bun run --cwd "$pkg" test
done
```

```text
packages/examples/cloudflare: skipped cleanly because no worker was running at http://localhost:8787
packages/examples/farcaster: 2 tests passed
packages/examples/twitter-xai: 6 tests passed
```

Full `bun run verify` was not rerun for this package-metadata-only slice.
