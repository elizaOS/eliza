# Issue #12259 - examples/benchmarks side-runner list mode

## Change

- Added `--list` and `--list=json` to `packages/scripts/run-examples-benchmarks.mjs`.
- Added `packages/scripts/run-examples-benchmarks.self-test.mjs` to prove list mode honors workspace membership, examples/benchmarks scope, workspace negations, and target script presence without running package scripts.

## Verification

Run on 2026-07-04:

- `node --check packages/scripts/run-examples-benchmarks.mjs`
- `node --check packages/scripts/run-examples-benchmarks.self-test.mjs`
- `node packages/scripts/run-examples-benchmarks.self-test.mjs`
- `node packages/scripts/run-examples-benchmarks.mjs lint --list=json`
- `node packages/scripts/run-examples-benchmarks.mjs typecheck --list=json`

Real repo list counts:

- `lint`: 47 examples/benchmarks packages
- `typecheck`: 53 examples/benchmarks packages

Dry-run comparison using `node packages/scripts/run-turbo.mjs ... --dry=json` with a temporary `node_modules` symlink:

- `lint`: side-runner 47, Turbo 254, missing from Turbo 0
- `typecheck`: side-runner 53, Turbo 253, missing from Turbo 1
- Missing typecheck package: `@elizaos/example-code`

That missing typecheck package is caused by the current root `typecheck` body excluding `@elizaos/example-code` from the Turbo run while the side-runner still includes it. The follow-up side-runner deletion must handle this package before removing the side-runner.

## Evidence notes

Screenshots and recordings are N/A: this is a root CLI/script introspection change with no user interface.
