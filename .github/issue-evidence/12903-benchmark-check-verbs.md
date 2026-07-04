# #12903 benchmark lint-mutability evidence

Branch slice: finish benchmark check-script normalization after adjacent
benchmark-script slices landed on `develop`.

## Packages

- `packages/benchmarks/eliza-1`
- `packages/benchmarks/vision-language`

## Script contract changes

- Converted `eliza-1` and `vision-language` `lint` scripts from read-only
  `biome check .` to the repository convention:
  `biome check --write --unsafe .`.
- Kept `lint:check` read-only and left benchmark run/test/typecheck semantics
  unchanged.

## Verification

Commands run from a full workspace checkout on 2026-07-04:

```bash
git diff --check github/develop...HEAD
node - <<'NODE'
const fs = require('fs');
for (const p of ['packages/benchmarks/eliza-1/package.json','packages/benchmarks/vision-language/package.json']) {
  const pkg = JSON.parse(fs.readFileSync(p,'utf8'));
  const scripts = pkg.scripts || {};
  const bad = [];
  if (!/--write/.test(scripts.lint)) bad.push(`lint is not mutating: ${scripts.lint}`);
  if (/--write/.test(scripts['lint:check'])) bad.push(`lint:check is mutating: ${scripts['lint:check']}`);
  for (const name of ['lint','lint:check','format','format:check','typecheck','test']) {
    if (!scripts[name]) bad.push(`missing ${name}`);
  }
  if (bad.length) { console.error(`${p}: ${bad.join('; ')}`); process.exitCode = 1; }
  else console.log(`${p}: lint mutability normalized`);
}
NODE
bun run --cwd packages/benchmarks/eliza-1 lint:check
bun run --cwd packages/benchmarks/eliza-1 format:check
bun run --cwd packages/benchmarks/vision-language lint:check
bun run --cwd packages/benchmarks/vision-language format:check
bun run --cwd packages/benchmarks/eliza-1 typecheck
bun run --cwd packages/benchmarks/vision-language typecheck
timeout 120s bun run --cwd packages/benchmarks/eliza-1 test
timeout 120s bun run --cwd packages/benchmarks/vision-language test
```

Result:

```text
packages/benchmarks/eliza-1/package.json: lint mutability normalized
packages/benchmarks/vision-language/package.json: lint mutability normalized
packages/benchmarks/eliza-1: biome check passed for 42 files; biome format passed for 42 files.
packages/benchmarks/vision-language: biome check passed for 22 files; biome format passed for 22 files.
packages/benchmarks/eliza-1: typecheck passed; 2 test files and 31 tests passed.
packages/benchmarks/vision-language: typecheck passed; 3 test files and 46 tests passed.
```

Full `bun run verify` was not rerun for this package-metadata-only slice.
