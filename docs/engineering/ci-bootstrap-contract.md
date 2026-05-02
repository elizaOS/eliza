# CI Bootstrap Contract (Source-Present vs Published-Only)

## Incident Summary

On April 13, 2026, multiple required CI jobs failed because workflows mixed two incompatible bootstrap modes:

- **Published-only mode** disables the repo-local `eliza/` workspace.
- **Source-present mode** runs commands that require `eliza/...` paths and `apps/app/electrobun` symlink targets.

Running both modes in the same workflow causes path resolution failures and contract breakage.

## Allowed Modes

### Mode A: Source-Present (default for PR tests)

Use this mode when workflows run tests/builds that reference local repository paths under `eliza/` or `apps/app/electrobun`.

Rules:

- Do not run `scripts/disable-local-eliza-workspace.mjs`.
- Keep local workspace paths available throughout checkout/install/build/test.

### Mode B: Published-Only (explicit opt-in)

Use this mode only for jobs intentionally validating registry-resolved installs with no local `eliza/` workspace.

Rules:

- Enable local workspace disable explicitly.
- Ensure the job does not run commands that require local `eliza/...` filesystem paths.

### CI Rewrite-Only Compatibility

`scripts/disable-local-eliza-workspace.mjs` can run in rewrite-only mode (default), where it rewrites workspace dependency specifiers without renaming `eliza/` away.

- Rewrite-only mode is compatible with source-present command paths.
- Rename-away mode (`ELIZA_DISABLE_LOCAL_UPSTREAMS_RENAME=1`) is not compatible with source-present command paths.

## Required Invariants

- A workflow must choose one bootstrap mode per job.
- Jobs using source-present commands must not disable local `eliza/`.
- Jobs using published-only mode must not call local-source-only scripts/tests.

## Windows Checkout Constraint

Windows CI currently needs checkout filtering for benchmark result artifacts:

- `eliza/packages/benchmarks/benchmark_results/**`

Reason:

- Tracked benchmark artifact paths can exceed Windows checkout path-length limits on hosted runners.
- Until tracked artifacts are cleaned from git history/state, Windows jobs should use sparse checkout exclusions for those paths.

## Guardrail

`scripts/validate-ci-bootstrap-contract.mjs` enforces this contract in CI by failing when workflows mix rename-away disable mode with source-present command markers.
