# #12903 connector example script/test evidence

Branch slice: normalize script contracts for connector-style examples that had
fake builds or empty-test pass flags.

## Packages

- `packages/examples/bluesky`
- `packages/examples/discord`
- `packages/examples/lp-manager`

## Script contract changes

- `packages/examples/bluesky`
  - Removed `--passWithNoTests` from `test`.
  - Removed artifact-free `build: bun run typecheck`.
  - Added `format` and read-only `format:check`.
- `packages/examples/discord`
  - Replaced `vitest run --passWithNoTests` with a real `bun test smoke.test.js`.
  - Added `smoke.test.js` covering package scripts and Discord agent wiring.
  - Removed artifact-free `build: bun run typecheck`.
  - Added `format` and read-only `format:check`.
- `packages/examples/lp-manager`
  - Replaced `bun test --pass-with-no-tests` with a real
    `bun test smoke.test.js`.
  - Added `smoke.test.js` covering package scripts and LP monitoring wiring.
  - Removed artifact-free `build: bun run typecheck`.
  - Added `lint:check`, `format`, and read-only `format:check`.

## Verification

Current working tree: `origin/develop` at `222307ddb8`.

Static guard:

```bash
node - <<'NODE'
const fs = require('fs');
for (const p of ['packages/examples/bluesky/package.json','packages/examples/discord/package.json','packages/examples/lp-manager/package.json']) {
  const pkg = JSON.parse(fs.readFileSync(p,'utf8'));
  const scripts = pkg.scripts || {};
  const text = JSON.stringify(scripts);
  const bad = [];
  if ('build' in scripts) bad.push(`build=${scripts.build}`);
  if (!scripts.typecheck) bad.push('missing typecheck');
  for (const name of ['lint:check','format','format:check','test']) if (!scripts[name]) bad.push(`missing ${name}`);
  if (/passWithNoTests|pass-with-no-tests|bun run typecheck/.test(text)) bad.push(`masked/fake script remains: ${text}`);
  if (bad.length) { console.error(`${p}: ${bad.join('; ')}`); process.exitCode = 1; }
  else console.log(`${p}: connector example scripts normalized`);
}
NODE
```

Result:

```text
packages/examples/bluesky/package.json: connector example scripts normalized
packages/examples/discord/package.json: connector example scripts normalized
packages/examples/lp-manager/package.json: connector example scripts normalized
```

Read-only lint and format:

```bash
for pkg in packages/examples/bluesky packages/examples/discord packages/examples/lp-manager; do
  bun run --cwd "$pkg" lint:check
  bun run --cwd "$pkg" format:check
done
```

Result:

```text
packages/examples/bluesky: biome check passed for 6 files; biome format passed for 6 files.
packages/examples/discord: biome check passed for 6 files; biome format passed for 6 files.
packages/examples/lp-manager: biome check passed for 9 files; biome format passed for 9 files.
```

Smoke tests:

```bash
bun run --cwd packages/examples/discord test
bun run --cwd packages/examples/lp-manager test
```

Result:

```text
packages/examples/discord: 2 pass, 0 fail
packages/examples/lp-manager: 2 pass, 0 fail
```

## Local blockers

This auxiliary worktree has no valid local install.

```text
packages/examples/bluesky test:
  vitest: command not found

packages/examples/bluesky typecheck:
packages/examples/discord typecheck:
packages/examples/lp-manager typecheck:
  error TS2688: Cannot find type definition file for 'node'
```

Full `bun install` / `bun run verify` were not run here because the filesystem
has only a few GiB free.
