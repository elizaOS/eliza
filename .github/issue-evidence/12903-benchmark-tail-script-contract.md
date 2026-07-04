# #12903 benchmark tail script-contract evidence

Branch slice: normalize the remaining benchmark package script contracts.

## Packages

- `packages/benchmarks/eliza-1`
- `packages/benchmarks/eliza-1/vision-cua-e2e`
- `packages/benchmarks/entity-voice-bench`
- `packages/benchmarks/gauntlet/sdk/typescript`
- `packages/benchmarks/interrupt-bench`
- `packages/benchmarks/lifeops-quality`
- `packages/benchmarks/personality-bench`
- `packages/benchmarks/recall-bench`
- `packages/benchmarks/solana/solana-gym-env/docs/trajectory-viewer`
- `packages/benchmarks/solana/solana-gym-env/voyager/skill_runner`
- `packages/benchmarks/terminal-bench/tasks/npm-conflict-resolution/client/task-deps`
- `packages/benchmarks/three-agent-dialogue`
- `packages/benchmarks/vision-language`

## Script contract changes

- Added read-only `lint:check` where a package already had `lint`.
- Added `format` and read-only `format:check` to each package.
- Removed `build: bun run typecheck` from the Solana skill runner because it
  only ran TypeScript validation and did not emit artifacts.
- Kept existing test, typecheck, bench, and real artifact-emitting build scripts.
- Scoped `entity-voice-bench` and `interrupt-bench` format scripts to
  `package.json` because full-package Biome format currently reports
  pre-existing source/corpus formatting drift outside this script-only change.

## Verification

Current working tree: `origin/develop` at `df54daf798`.

Diff hygiene:

```bash
git diff --check
```

Result: passed.

Static script guard over the 13 edited `package.json` files:

```bash
node --input-type=module <<'NODE'
// Parses every edited package.json, rejects fake/masked scripts, requires
// lint:check when lint exists, requires format + format:check, and rejects
// build scripts that only run typecheck.
NODE
```

Result:

```text
packages/benchmarks/eliza-1/package.json: ok
packages/benchmarks/eliza-1/vision-cua-e2e/package.json: ok
packages/benchmarks/entity-voice-bench/package.json: ok
packages/benchmarks/gauntlet/sdk/typescript/package.json: ok
packages/benchmarks/interrupt-bench/package.json: ok
packages/benchmarks/lifeops-quality/package.json: ok
packages/benchmarks/personality-bench/package.json: ok
packages/benchmarks/recall-bench/package.json: ok
packages/benchmarks/solana/solana-gym-env/docs/trajectory-viewer/package.json: ok
packages/benchmarks/solana/solana-gym-env/voyager/skill_runner/package.json: ok
packages/benchmarks/terminal-bench/tasks/npm-conflict-resolution/client/task-deps/package.json: ok
packages/benchmarks/three-agent-dialogue/package.json: ok
packages/benchmarks/vision-language/package.json: ok
```

Benchmark-scope residual audit:

```bash
node --input-type=module ./script-contract-audit.mjs # inline equivalent
```

Result:

```text
benchmark issues=0
```

Read-only package checks:

```bash
for pkg in <13 edited benchmark packages>; do
  bun run --cwd "$pkg" format:check
  # where present:
  bun run --cwd "$pkg" lint:check
done
```

Result: passed for every edited package. `personality-bench lint:check`
completed with exit code 0 and four pre-existing Biome optional-chain warnings.

Focused tests/typechecks:

```text
packages/benchmarks/vision-language test: passed, 3 files / 46 tests.
packages/benchmarks/three-agent-dialogue test: 2 files passed, 21 tests passed,
  1 skipped, 2 failed because the sparse auxiliary worktree cannot resolve
  @elizaos/plugin-groq.
packages/benchmarks/eliza-1 test: 6 tests passed, one suite failed because the
  sparse auxiliary worktree cannot resolve @elizaos/core.
packages/benchmarks/eliza-1/vision-cua-e2e test: failed before tests because the
  sparse auxiliary worktree cannot resolve @elizaos/plugin-computeruse.
packages/benchmarks/solana/solana-gym-env/voyager/skill_runner typecheck:
  blocked because the sparse auxiliary worktree has no nested install for
  @solana/web3.js.
packages/benchmarks/solana/solana-gym-env/voyager/skill_runner test:
  blocked because vitest.config.ts is not present in this sparse checkout.
```

Full `bun install` / root `bun run verify` were not run in this auxiliary
worktree; it reuses an external `node_modules` symlink and intentionally avoids
mutating the main checkout.
