# Repository tooling

`packages/scripts/` is the single home for repository-wide build, test, release,
security, evidence, and development tools. It has no package manifest; root
`package.json` commands invoke its entrypoints. Package-specific scripts remain
with their owning packages, and GitHub-specific helpers remain in `.github/scripts/`.

Run commands from the repository root:

```bash
bun run test:scripts
node packages/scripts/run-script-tests.mjs --inventory
node packages/scripts/audit-scripts.mjs
bun run verify
```

The script test runner discovers tests recursively here and in
`packages/cloud/scripts/`, including untracked files during development.
Relative module imports resolve from their source file; operational outputs and
repository configuration resolve from the checkout root. Keep those paths
correct when moving tools between subdirectories.

## Generated test output

Audit and test artifacts belong in the ignored repository-root `test-results/`,
never under a package. Use `testOutputPath` from `lib/test-output.mjs` so paths
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
