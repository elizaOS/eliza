# Repository tooling

`packages/scripts/` is the single home for repository-wide build, test, release,
security, evidence, and development tools. It has no package manifest; root
`package.json` commands invoke its entrypoints. Package-specific scripts remain
in `packages/*/scripts/`; GitHub helpers live in `packages/scripts/github/`.

Run commands from the repository root:

```bash
bun run test:scripts
node packages/scripts/run-script-tests.ts --inventory
node packages/scripts/audit-scripts.ts
bun run verify
```

Install builds use Turbo's dependency graph and cache; an existing `dist` file
is not proof of freshness. In [`turbo.json`](../../turbo.json), `typecheck:deps`
tracks source changes without running builds. Typechecks that read generated
declarations declare the producing build explicitly. Source imports outside
Turbo's dependency graph, including peer-only packages, need an explicit
`#typecheck:deps` edge so their changes invalidate cached checks.
Run independent verification commands in separate worktrees: parallel runs in
one checkout can delete `dist` while another process is checking it.

The script test runner discovers tests recursively here and in
`packages/cloud/scripts/`, including untracked files during development.
Relative module imports resolve from their source file; operational outputs and
repository configuration resolve from the checkout root. Keep those paths
correct when moving tools between subdirectories.

## Generated test output

Audit and test artifacts belong in the ignored repository-root `test-results/`,
never under a package. Use `testOutputPath` from `lib/test-output.ts` so paths
do not depend on the command's working directory. Each Playwright lane owns a
separate leaf under `test-results/app/`; audits use `test-results/aesthetic-audit/`
and `test-results/aesthetic-audit-cloud/`. Device bundles use
`test-results/device-e2e/`; Cloud and core Playwright use `test-results/cloud-e2e/`
and `test-results/core/`. Explicit output overrides remain supported.

Playwright clears its own output before a run. Keep shared input fixtures and
manual captures outside that leaf. Producer changes must update the named
inventory in `packages/testing/evidence/ingest.ts` and CI artifact uploads.
Unit tests use temporary directories and clean them up; durable screenshots
and recordings belong to explicit capture runs.

## Release preparation

Use `bun run release:candidate --help` for candidate, verification, and publication commands, or the protected `release.yaml` workflow. Direct `release`, `release:next`, and `release:beta` publication shortcuts are retired. Prepare one exact cohort version, public access, and published dependency ranges before pinning the source SHA; the workflow does not rewrite manifests while publishing. The cohort in `release-cohort.json` contains the surviving publishable packages. Npm channels `latest`, `next`, and `beta` remain distinct from desktop channels.
