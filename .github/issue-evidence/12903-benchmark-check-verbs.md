# #12903 benchmark check-verb evidence

Branch slice: normalize check verbs for four benchmark packages.

## Packages

- `packages/benchmarks/eliza-1`
- `packages/benchmarks/personality-bench`
- `packages/benchmarks/three-agent-dialogue`
- `packages/benchmarks/vision-language`

## Script contract changes

- Added read-only `lint:check`.
- Added `format` and read-only `format:check`.
- Converted `eliza-1` and `vision-language` `lint` scripts from read-only
  `biome check .` to the repository convention:
  `biome check --write --unsafe .`.
- Left benchmark run/test/typecheck semantics unchanged.

## Verification

Current working tree: `origin/develop` at `df54daf798`.

Static guard:

```bash
node - <<'NODE'
const fs = require('fs');
for (const p of ['packages/benchmarks/eliza-1/package.json','packages/benchmarks/personality-bench/package.json','packages/benchmarks/three-agent-dialogue/package.json','packages/benchmarks/vision-language/package.json']) {
  const pkg = JSON.parse(fs.readFileSync(p,'utf8'));
  const scripts = pkg.scripts || {};
  const bad = [];
  for (const name of ['lint','lint:check','format','format:check','typecheck','test']) if (!scripts[name]) bad.push(`missing ${name}`);
  if (!/--write/.test(scripts.lint)) bad.push(`lint is not mutating: ${scripts.lint}`);
  if (/--write/.test(scripts['lint:check'])) bad.push(`lint:check is mutating: ${scripts['lint:check']}`);
  if (bad.length) { console.error(`${p}: ${bad.join('; ')}`); process.exitCode = 1; }
  else console.log(`${p}: script check verbs normalized`);
}
NODE
```

Result:

```text
packages/benchmarks/eliza-1/package.json: script check verbs normalized
packages/benchmarks/personality-bench/package.json: script check verbs normalized
packages/benchmarks/three-agent-dialogue/package.json: script check verbs normalized
packages/benchmarks/vision-language/package.json: script check verbs normalized
```

Read-only lint and format:

```bash
for pkg in packages/benchmarks/eliza-1 packages/benchmarks/personality-bench packages/benchmarks/three-agent-dialogue packages/benchmarks/vision-language; do
  bun run --cwd "$pkg" lint:check
  bun run --cwd "$pkg" format:check
done
```

Result:

```text
packages/benchmarks/eliza-1: biome check passed for 42 files; biome format passed for 42 files.
packages/benchmarks/personality-bench: biome check exited 0 for 29 files with 4 existing optional-chain warnings; biome format passed for 29 files.
packages/benchmarks/three-agent-dialogue: biome check passed for 15 files; biome format passed for 15 files.
packages/benchmarks/vision-language: biome check passed for 22 files; biome format passed for 22 files.
```

## Local blockers

Tests were attempted but this auxiliary worktree has no valid local install:

```text
packages/benchmarks/eliza-1 test:
  vitest: command not found

packages/benchmarks/personality-bench test:
  Cannot find package 'vitest' imported from root vitest.config.ts

packages/benchmarks/three-agent-dialogue test:
  Cannot find package 'vitest' imported from package vitest.config.ts

packages/benchmarks/vision-language test:
  vitest: command not found
```

Full `bun install` / `bun run verify` were not run here because the filesystem
has only a few GiB free.
