# Account deletion lifecycle status

Updated: 2026-08-23 (America/Los_Angeles)

## Done

- Preserved the sealed lifecycle candidate `d6131f9c36d3d0528118132caa822211014663dd` and tag `account-deletion-authoritative-backup-fence-20260822` in `/Users/nubs/.codex/worktrees/account-deletion-current-tip-20260822/eliza`.
- Preserved subsequent current-base checkpoints `747ec49edd0c2160bcf7ab60b3820d7bda5fe61c`, `298dcc978d4c6a5cbe26a832521859f475b7821a`, `c6962b872f65eb8a4461e9f1207638976817d079`, and `60441323896c6784c79dea26cbde8ff1ff8460fa` under their dated local tags. No reset, clean, force update, push, deployment, production migration, provider mutation, real deletion, or GitHub mutation occurred.
- Recomposed the 22-commit candidate in `/Users/nubs/.codex/worktrees/account-deletion-current-base-20260823/eliza` on branch `codex/account-deletion-current-base-20260823`. Action-time base is `origin/develop@20e04bd4a2ac63b784a5e23beba29e0d803a49a8`; code head before this ledger commit is `4f4299a5c37935e8259cf54b0f8d6c331a403270`.
- Verified merged #24256 (`a224539647c1f61663a928fc249ea6450625095c`) and #24803 (`e9e441d307e8890478a92b3cc19e4e1cb989943d`) remain ancestors. Their tenant scoping and strict runtime receipt validation are preserved while the unavailable-only presentation is superseded by the authoritative lifecycle.
- Preserved upstream `0310_personal_shared_inbound_media_admission` and appended deletion migrations without renumbering upstream history: `0311_account_deletion_lifecycle_authority` (journal 294), `0312_account_deletion_phase_receipts` (295), `0313_account_deletion_exports` (296), and `0314_account_deletion_canceling_state` (297). Historical `0276_account_deletion_requests` remains intact.
- Removed the candidate's older disposable release-barrier bypass after upstream landed a stronger relation-free catalog proof and atomic `0282`/`0282_01` transaction. Both migration-runner paths are now byte-for-byte identical to `origin/develop`; the stronger runner passes 19/19 focused tests.
- Classified all 221 direct user/organization foreign keys with digest `0eb691838d961f8586824354606f21aaed16a48e43977ea5cb4f707faeea58ba`: 69 external reconciliation, 92 private deletion, 50 retained/anonymized, and 10 shared transfer edges. Unknown restrictive relationships fail closed.
- Regenerated the Cloud API router at 702 mounted routes, 127 shards, and 0 unconverted routes; regeneration leaves no diff.

## Deliberate overlap resolution

The original 17 paths shared with merged #24256/#24803 were reviewed individually:

1. `packages/cloud/api/src/_router.generated.ts` — regenerated from the current route tree.
2. `packages/cloud/api/v1/me/account-deletion/route.test.ts` — retained current primary-tenant scoping and authoritative response tests.
3. `packages/cloud/api/v1/me/account-deletion/route.ts` — retained recent-auth/exact-confirmation and organization-scoped primary receipt lookup.
4. `packages/cloud/shared/src/db/account-deletion-foreign-key-policy.test.ts` — advanced the full-schema ratchet to 221 edges.
5. `packages/cloud/shared/src/db/account-deletion-foreign-key-policy.ts` — preserved fail-closed classification and updated the snapshot digest only.
6. `packages/cloud/shared/src/db/migrations/account-deletion-lifecycle-authority.test.ts` — aligned append-only migration names and retained cancellation/receipt invariants.
7. `packages/cloud/shared/src/db/migrations/meta/_journal.json` — preserved upstream 0310 and appended deletion 0311-0314.
8. `packages/cloud/shared/src/db/repositories/account-deletion-requests.ts` — retained tenant-scoped first-receipt/capability and generation-fencing behavior.
9. `packages/cloud/shared/src/db/repositories/account-deletion-reservation.pglite.test.ts` — retained concurrency, undo, expiry, atomic erasure, and rollback proof.
10. `packages/cloud/shared/src/db/schemas/index.ts` — preserved current schema exports plus deletion receipts/exports.
11. `packages/cloud/shared/src/lib/auth/workers-hono-auth.api-key.test.ts` — retained current auth behavior and lifecycle fence coverage.
12. `packages/cloud/shared/src/lib/auth/workers-hono-auth.ts` — retained current membership/session behavior and API-key lifecycle fencing.
13. `packages/cloud/shared/src/lib/services/account-deletion.ts` — retained authoritative saga/cancellation semantics with current tenant-scoped lookup.
14. `packages/cloud/shared/src/lib/services/auto-top-up.ts` — retained upstream behavior and lifecycle-revision rechecks before Stripe.
15. `packages/cloud/shared/src/lib/services/provisioning-jobs.ts` — retained current provisioning behavior and paid-work lifecycle fence.
16. `packages/ui/src/cloud/account-security/data/account-deletion-client.test.ts` — retained #24803 strict parsing plus canceling/terminal invariants.
17. `packages/ui/src/cloud/account-security/data/account-deletion-client.ts` — retained strict server DTO authority; the client does not infer success.

Later moving-base overlap was limited to `migrate-with-diagnostics.ts` and its release-barrier test. The final candidate deliberately takes upstream's stronger implementation unchanged. Subsequent upstream advances through `20e04bd4a2` had zero deletion-path overlap.

## Recomposition identity

- `git range-diff f5e20f2616..account-deletion-f5e20f2-recomposition-20260823 20e04bd4a2..4f4299a5c3` maps 21 carried commits patch-identically except the migration-runner commit whose obsolete bypass is canceled by the explicit 22nd commit. Net migration-runner content equals upstream.
- Core deletion service, encrypted export, provider adapters/tests, authenticated route, UI DTO parser, and `packages/cloud/api/cron/process-account-deletions/route.ts` are byte-for-byte identical to the proven `account-deletion-f5e20f2-recomposition-20260823` checkpoint.
- Gitleaks scanned all 22 commits with redaction and found no leaks. `git diff --check` and targeted Biome checks across all 67 changed TypeScript/TSX/JSON files pass.

## Shared and staging authority

- Shared remains the sole release/staging owner; this lane did not deploy or alter its worktrees.
- Shared reported Steward staging healthy on reviewed commit `e5f84b782972568027460bec042d1b25a1df3265`, Railway deployment `a7676319-b4c7-4794-aa10-5b4746b90a44`, and image digest `sha256:190bc081a74149a0b3e6fbe6d214f3fbc0b7a472d86da6cd2a3e7bb02a886738`. `/ready` is 200 with 94 image/database migrations through `0113_personal_tenant_account_lifecycle` and passing migration/RLS checks.
- That Steward evidence is the only approved hosted dependency for future deletion acceptance. The deletion Cloud candidate itself has not been deployed, and its 0311-0314 migrations have not been applied to a hosted database.

## Tests and evidence

- Install/build: `bun install --frozen-lockfile` passes; core build passes 60/60 tasks.
- Full affected local matrix before the last zero-overlap mechanical replays: 383 passing tests and 17 external-authority skips across lifecycle, repository, migrations, billing/top-up, renewal, provisioning, auth/session/API-key fencing, API routes, scripts, export, provider saga/purge, UI, Android policy contract, and PostgreSQL/S3 integration harnesses.
- Exact final-base proportional rerun: 92/92 lifecycle/API/migration/repository/provider tests pass with 3 intentional S3-authority skips; 11/11 UI dialog/parser/public-page tests pass; migration barrier passes 19/19; mock-backed Cloud E2E passes 1/1 for authenticated request, lifecycle fencing, post-revocation status, cancellation/reactivation, replay, and cross-tenant isolation.
- External integration harnesses remain honest: 14 PostgreSQL cases skip without an isolated disposable PostgreSQL/Hyperdrive target; 3 S3 cases skip without a disposable object-store authority. No hosted absence claim is made from these skips.
- Affected typechecks all pass on the current series: Cloud shared, Cloud API plus Worker dry-run, UI, Cloud E2E, and Cloud test-mocks.
- Cloud API package lint passes. Package-wide Cloud-shared and UI lint stop only on upstream-identical surrogate-safety formatting/import files; the 67-file candidate diff is clean.
- Full app audit: 223/227 pass. The four failures are the unrelated `plugin-cloud-gui` lifecycle-slot timeout across four viewports; the final aesthetic report is `broken=0`, `needs-work=0`.
- Dedicated Cloud audit: account-deletion desktop and mobile both pass; overall 96/101 pass with one skip. Unrelated failures are `cloud-agents` desktop/mobile missing `Smoke Agent` and `auth-bridge` desktop/mobile redirecting to `/chat` rather than `/`.
- Root `bun run verify` passes guide/Biome-version checks then stops at the existing i18n baseline: more than 1,100 fallback translations are absent per non-English locale and five unrelated English `connectorcard.*` keys are missing. The deletion diff changes one already-existing English privacy sentence and introduces no locale key.

## Stable server contract

- Authenticated request/status: `GET|POST /api/v1/me/account-deletion`. POST requires recent authentication, exact `DELETE` confirmation, same-origin protection, tenant-scoped identity, and returns 202 only after atomic reservation/fencing.
- Public request/status/cancel: `POST /api/public/account-deletion`, `/status`, and `/cancel`. Status and recovery use distinct opaque capabilities; no query parameter is proof of identity or success.
- Export: `POST /api/public/account-deletion/export` requires exact confirmation and the immutable capability/generation. It writes bounded deterministic AES-GCM bytes conditionally, verifies read-back, and reconciles provider success with a lost response before any retry.
- Cancellation is nonterminal `canceling` during provider reactivation: `accessState=fenced`, `canCancel=false`, `nextAction=wait_for_reconciliation`. Only terminal `canceled` restores `accessState=active`, `canCancel=false`, `nextAction=none`; revoked sessions/API keys are never resurrected.
- Shared organization exit returns actionable `TRANSFER_REQUIRED` until an active successor owner is explicitly selected. It never deletes shared assets, cancels organization billing, or permits zero owners.

## Draft PR candidate

- Proposed title: `feat(cloud): complete authoritative account deletion lifecycle`
- Proposed link: `Addresses #23098` until disposable hosted final-absence evidence is attached; do not claim closure from local tests.
- Reviewer matrix: Cloud/API and database owners; Security; SRE/release; Steward; billing/Stripe; compute/container; storage/R2/backup/spool; GitHub/repository; connector OAuth; voice; domains; Vault/key authority; Android contract owner.
- Evidence attachment must include the exact local tag/source, migration and rollback receipts, redacted provider phase receipts, isolated database identity, public/in-app request recordings, export/cancel/reconciliation evidence, and verified final absence. Evidence does not belong in this repository.

## Doing

- The commit carrying this ledger is the final local seal and is parked at its annotated action-time tag. No hosted mutation is in flight.

## Next / exact external gates

1. Shared must select the exact final tag and serialize an isolated non-production Cloud deployment against its already-pinned Steward staging authority. This lane must not dispatch a competing release.
2. Cloud/SRE must provide an isolated disposable PostgreSQL database plus exact Hyperdrive/database-identity receipts. Apply 0311-0314 only there and rerun all 14 PostgreSQL integration cases.
3. Storage owners must provide disposable primary R2/S3 and secondary backup/spool authority credentials. Run the three object-store cases and prove absence by authoritative listing/inspection. A lost mutation response must reconcile; never repeat an uncertain purge.
4. Provider owners must supply reviewed disposable fixtures/authority for Stripe, compute/containers, GitHub/repos, connector OAuth/tokens, voice credentials, domains, Vault/key bindings, and any other classified grants.
5. Run the single serialized hosted canary with disposable users/data only: app API and public page request, export/download, cancel/reactivation, shared transfer/exit, injected provider outage/lost response and resume, recovery expiry, final database/object/provider erasure, post-session status, and cross-tenant preservation.
6. Obtain Cloud, Security, SRE, Steward, billing, compute, storage, connector, voice, domain, Vault, GitHub, and Android contract reviews. Publication, production deploy/migration, real-user deletion, push/merge, and Google Play acceptance remain outside this authorization.

## Rollout and rollback

- Rollout: Shared pins the final tag, verifies database identity and migration plan read-only, deploys one isolated candidate, applies migrations to the disposable database, enables only the serialized canary worker, and captures identifier-free phase receipts.
- Rollback before irreversible authority: stop the canary worker/scheduler, retain reservations and phase evidence, deploy the prior source through Shared, and leave lifecycle fences fail-closed. Do not downgrade or delete migration records.
- Rollback after any ambiguous provider call: keep the request fenced and reconcile the provider by canonical inspection. Do not rerun mutation, erase evidence, restore access, or claim cancellation/completion until the authoritative receipt converges.
