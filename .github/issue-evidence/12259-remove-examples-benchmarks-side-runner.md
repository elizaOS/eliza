# Issue #12259 - remove examples/benchmarks side-runner

## Change

- Removed the serial `run-examples-benchmarks.mjs` tail from root `lint` and `typecheck`.
- Removed the `lint-test-integrity` tail from root `lint`; root `lint` is now exactly the Turbo lint task.
- Removed the `!@elizaos/example-code` exclusion from root `typecheck` so the Turbo typecheck fan-out preserves coverage for the package that the side-runner previously covered.
- Deleted `packages/scripts/run-examples-benchmarks.mjs` and its self-test.

## Verification

Run on 2026-07-04:

- Static root script assertion:
  - `lint` is `node packages/scripts/run-turbo.mjs run lint`
  - `typecheck` is `NODE_OPTIONS='--max-old-space-size=8192' node packages/scripts/run-turbo.mjs run typecheck --concurrency=8`
- Side-runner package-set comparison against Turbo dry runs:
  - `lint`: side-runner 47, Turbo 254, missing from Turbo 0
  - `typecheck`: side-runner 53, Turbo 254, missing from Turbo 0
- `git grep -n "run-examples-benchmarks" -- package.json packages scripts turbo.json .github/workflows docs` returned no references.
- `git diff --check`
- `git diff --check origin/develop..HEAD`

The Turbo dry runs used a temporary `node_modules` symlink to the main checkout because the auxiliary worktree does not have a local install.

## Evidence notes

Screenshots and recordings are N/A: this is a root CLI/Turbo script cleanup with no user interface.
