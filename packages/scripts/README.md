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

Use `bun run release:candidate --help` for candidate, verification, and publication commands, or the protected `release.yaml` workflow. Direct `release`, `release:next`, and `release:beta` publication shortcuts are retired. Prepare one exact cohort version and public access before pinning the source SHA. Source manifests keep `workspace:*` ranges; only each packed tarball pins them to the exact cohort version, and the source bytes are restored before the next check. The cohort in `release-cohort.json` contains the surviving publishable packages. Npm channels `latest`, `next`, and `beta` remain distinct from desktop channels.

The protected **Mobile App Auth Registration Admin** workflow has a read-only
`inventory` operation for Alpha Phone recovery. It reports only presence of the
three known mobile-auth Worker secret bindings and aggregate registration counts
for the fixed environment-specific Alpha callback. It does not require a registry
value, so it can diagnose a missing registry. Production runs require `main`.
The database connection must match both protected database identity hash variables;
all registration queries run in the same read-only transaction. Existing `diagnose`
and `repair` behavior is unchanged. A present Worker registry is not permission to
replace it: preserve every existing client and Android certificate when repairing
configuration. This inventory neither reveals nor changes those values.

For a new platform-owned native client, `plan-provision` accepts a fixed new
`intended_app_id`, a public `display_name`, and an exact
`https://cloud.eliza.app/auth/<product>/callback`. It validates the protected
primary app and database identity, then seals an additional-client candidate and
the original registry to the reviewed GitHub environment key. The prospective
plan has `requiresCreation: true`; it does not prove that the new app exists.
The configured protected creation organization and owner are mandatory and own
the new registration. They must be active, and the owner must be an undeleted
owner or admin in that organization. The primary app remains a validated namespace
baseline; its owner does not select or constrain the configured creation owner.

For an operator-authorized product under the primary app's platform authority,
use the explicit `plan-provision-primary` and `provision-primary` operations.
These select only the protected primary app's fully validated organization and
creator, in the same database snapshot. Configured-authority operations never
fall back to this mode. The sealed plan reports `authorityMode`, and its creation
hash binds that mode, so plan and provision must use the same authority selection.
Neither mode aliases the primary app UUID or adopts an existing callback claim.

Review the candidate, non-target, app-binding, and creation hashes. Run the matching
`provision-registry` or `provision-primary` with those hashes and the same UUID, name, and callback while
the original source registry is still installed. This operation creates only
the admitted registration under the repair transaction's shared lock. An exact
valid retry leaves rows and keys unchanged. It never publishes a Worker binding.
Only after it verifies the new row may the operator install the sealed candidate
in the normal GitHub environment secret and run `publish-registry`. Keep source
secret changes exclusive during this sequence; GitHub secret updates have no
compare-and-swap check. Never install a prospective candidate before provisioning:
a concurrent release can publish the normal source registry.

These operations currently require the reviewed production key and `main`.
Staging remains unavailable until its protected registry, primary app, database
identity pins, and encryption key are configured and reviewed. Empty or malformed
source registries fail closed; these operations do not initialize them.

The protected **Cloud Catalog Diagnostic** workflow checks only the five Stripe
catalog binding names. It then makes one unauthenticated plans request with a
random diagnostic header. A temporary Wrangler tail filters that header and GET
method. The script emits only HTTP status and recognized catalog failure codes
from the exact plans URL. Tail output stays in bounded memory; Wrangler disk logs
and metrics are disabled. No provider configuration or payment is changed.
Production requires `main`. A 503 without a captured code fails the diagnostic;
it does not prove a missing binding. Compare binding presence and the captured
code before repairing provider configuration.

Its `compare-primary` operation selects only the protected primary app UUID and
reports booleans for app approval, organization/owner validity, and whether the
protected creation organization and owner match that existing app. It shares the
inventory's database identity guard and read-only transaction. It does not select
another organization, reveal identifiers, activate records, or change ownership.
