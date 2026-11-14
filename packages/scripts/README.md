# Repository tooling

`packages/scripts/` is the single home for repository-wide build, test, release,
security, evidence, and development tools. Its private package declares tooling dependencies; root
`package.json` commands invoke its entrypoints. Package-specific scripts remain
in `packages/*/scripts/`; GitHub helpers live in `packages/scripts/github/`.

JavaScript tooling sources use `.ts` and explicit `.ts` imports. Keep required
platform shell and Python tools in these same directories. Published app
artifacts emit runnable `.mjs` files through `emit-script-artifacts.ts`; do not
check generated JavaScript or declaration siblings into script directories.

Run commands from the repository root:

```bash
bun run test:scripts
bun packages/scripts/run-script-tests.ts --inventory
bun packages/scripts/audit-scripts.ts
bun run verify
```

Install builds use Turbo's dependency graph and cache; an existing `dist` file
is not proof of freshness. In [`turbo.json`](../../turbo.json), `typecheck:deps`
tracks source changes without running builds. Typechecks that read generated
declarations declare the producing build explicitly. Source imports outside
Turbo's dependency graph, including peer-only packages, need an explicit
`#typecheck:deps` edge so their changes invalidate cached checks.
The local-inference dependency-hash task covers native inference, computer use,
and UI sources together to break their protocol import cycle. It retains the
group's external dependency hashes; do not restore cyclic `^typecheck:deps` edges.
Typechecks use the `eliza-source` export condition from the root TypeScript config;
package exports own workspace source entrypoints. Keep `paths` only for mappings
that differ from those exports. Emit configs clear inherited source conditions
to retain their generated-declaration boundaries.
Run independent verification commands in separate worktrees: parallel runs in
one checkout can delete `dist` while another process is checking it.

The optional local script test runner discovers tests recursively here and in
`packages/cloud/scripts/`, including untracked files during development. It is not
a CI admission lane; root `test` runs end-to-end checks.
Relative module imports resolve from their source file; operational outputs and
repository configuration resolve from the checkout root. Keep those paths
correct when moving tools between subdirectories.

Main promotion runs complete Quint partitions in the main PR, merge queue and
canonical main Full validation. Other branches skip hosted models; local model
and owning conformance checks remain required before merge. Production effect
consumers also verify the exact-source successful main Full manifest, its current
run attempt and all source-bound rows, while retaining staging tree certification.
The existing manifest and certificate formats are unchanged.

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

Compound package test scripts can opt their Vitest configs into
`compoundVitestEvidence()` from `lib/compound-test-evidence.ts`. The root test
runner supplies a fresh directory scoped to that package's working directory;
each invocation writes a distinct JUnit fragment. The runner reconciles every
fragment and preserves child failures, missing-evidence and all-skipped guards.
Only instrumented Vitest runs contribute testcase counts; every other command's
exit status still gates the package result. No counts are inferred from stdout.

## Release preparation

`bun run build:npm` builds package outputs.

Use `bun run release:candidate --help` for candidate, verification, and publication commands, or the protected `release.yaml` workflow. Direct `release`, `release:next`, and `release:beta` publication shortcuts are retired. Prepare one exact cohort version and public access before pinning the source SHA. Source manifests keep `workspace:*` ranges; only each packed tarball pins them to the exact cohort version, and the source bytes are restored before the next check. The cohort in `release-cohort.json` contains the surviving publishable packages.

The npm workflow skips app stores by default. Set `publish_stores` to `true` to also run configured store lanes after npm and GitHub finalization. A store lane skips its build and upload when required credentials or app identity settings are absent. Invalid credentials and failed builds or uploads still fail that lane.

The protected **Native App Auth Database Migration** workflow performs the
one-time preparation for database-owned native registrations. It reads the
current protected registry and Android bindings, fetches the complete deployed
Pages callback configuration, and verifies the database identity before writing.
An exact app/callback match is required for enabled clients. The transaction
preserves disabled entries and aliases, refuses conflicts, and records an import
receipt. The follow-up verification compares every imported field. The first
database-only release completes the import after schema migration and before
Worker or Pages activation. A completed, versioned, identity-bound marker skips
all legacy inputs on later releases; it does not require historical rows to remain.
Preparation markers receive an exact readback before they are bound once. Remove
the temporary release import phase and legacy environment bindings after both
environments complete cutover. Later reviewed database changes do not use the
manual workflow. Production import
also requires the existing exact-source main Full manifest and tree-bound
staging certification; the importer runs that canonical gate before writing.

The protected **Cloud Catalog Diagnostic** workflow checks only the five Stripe
catalog binding names. It then makes one unauthenticated plans request with a
random diagnostic header. A temporary Wrangler tail filters that header and GET
method. The script emits only HTTP status and recognized catalog failure codes
from the exact plans URL. Tail output stays in bounded memory; Wrangler disk logs
and metrics are disabled. No provider configuration or payment is changed.
Production requires `main`. A 503 without a captured code fails the diagnostic;
it does not prove a missing binding. Compare binding presence and the captured
code before repairing provider configuration.
