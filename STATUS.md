# Account deletion lifecycle status

Updated: 2026-08-23 (America/Los_Angeles)

## Done

- Preserved the accepted fail-closed lifecycle/authority lineage, including `d6131f9c36d3d0528118132caa822211014663dd`, tag `account-deletion-authoritative-backup-fence-20260822`, and the clean prior current-base candidate `4148261c5aa4594e45dc5452caf5e42eccbd0cea` in `/Users/nubs/.codex/worktrees/account-deletion-current-base-20260823/eliza`. No reset, clean, overwrite, force update, deployment, production migration, provider mutation, or real deletion occurred.
- Built the publication candidate in the isolated worktree `/Users/nubs/.codex/worktrees/account-deletion-current-base-e1bfbf7-20260823/eliza` on branch `codex/account-deletion-current-base-e1bfbf7-20260823`.
- Fetched action-time `origin/develop@c3f070a5ee1e45204df4a447d4592bc8d0bf416e`. Every upstream advance had zero path overlap with this 24-commit code series, so the rebases completed without conflict. Code head before this ledger commit is `077e11519b38b1f3cb6078ebef0c32a7103641f3`.
- Preserved merged #24256 and #24803: current tenant scoping, strict receipt parsing, canonical SSO sign-out, public-route distrust of query parameters, and canonical redacted evidence snapshots remain intact while the unavailable-only presentation is superseded by the authoritative lifecycle.
- Preserved the deliberate fail-closed fence from #22854 while implementing parent issue #23098 as resumable lifecycle authority rather than reverting the guard.
- Defined four separate operations and authorities: agent stop/wake, subscription cancellation, shared-member exit/ownership transfer, and personal account deletion.
- Implemented atomic first-receipt reservation under user/organization/membership locks, lifecycle revision publication, session/API-key/auto-top-up/renewal/provisioning fencing, recent-auth and exact-confirmation checks, separate opaque status/recovery capabilities, and replay-safe tenant scoping.
- Implemented bounded deterministic encrypted export, conditional object creation, read-back verification, immutable capability/generation fencing, lost-response reconciliation, export expiry cleanup, and fail-closed size/source limits.
- Implemented a leased, generation-fenced provider saga with phase receipts, stable idempotency keys, retry classification, inspection-before-retry, Steward deactivation/reactivation reconciliation, primary object purge, and injected backup/spool authority boundaries. Ambiguous destructive calls remain fenced for canonical inspection and are never blindly repeated.
- Implemented shared-owner transfer invariants: an active successor is required; shared assets and organization billing are preserved; zero-owner transitions fail with actionable `TRANSFER_REQUIRED`.
- Implemented atomic personal-database erasure plus transactional identifier nulling, retaining only a bounded non-identifying completion receipt. Restrictive unknown foreign keys roll back the transaction.
- Classified all 221 direct user/organization foreign keys with digest `0eb691838d961f8586824354606f21aaed16a48e43977ea5cb4f707faeea58ba`: 69 external reconciliation, 92 private deletion, 50 retained/anonymized, and 10 shared-transfer edges. Unknown restrictive relationships fail closed.
- Preserved upstream migration history and appended `0311_account_deletion_lifecycle_authority`, `0312_account_deletion_phase_receipts`, `0313_account_deletion_exports`, and `0314_account_deletion_canceling_state`. Historical account-deletion migration `0276` remains intact. Upstream's stronger atomic migration barrier is used unchanged.
- Regenerated the Cloud router at 702 mounted routes, 127 shards, and 0 unconverted routes; regeneration leaves no diff.

## Recomposition and identity proof

- Prior-base head: `f666c9df0beddace21043c5ffd29f05f0fee4717` on `d2cdce0d56b91eea0898841cbfa01f0d8476cb7b`.
- Current-base code head: `077e11519b38b1f3cb6078ebef0c32a7103641f3` on `c3f070a5ee1e45204df4a447d4592bc8d0bf416e`.
- `git range-diff d2cdce0d56..f666c9df0b c3f070a5ee..077e11519b` maps all 24 code commits one-for-one with `=`.
- Aggregate stable patch identity is exact on both bases: `54c3805e2be12e559f4546e6308842a682b65f59`.
- The 24-commit series scans 447.58 KB with gitleaks and contains no detected secret.
- `git diff --check` passes. Biome checks all 62 changed TypeScript/TSX/JSON files with no findings.

## Tests and evidence

- Installation and build: `bun install --frozen-lockfile` passes; core build passes 60/60 tasks.
- Current-base focused matrix: 292 tests pass and 3 S3 integration cases intentionally skip without disposable object-store authority.
  - Cloud shared lifecycle, repository, migration, concurrency, billing, renewal, provisioning, auth, export, provider, and authority tests: 192/192.
  - Authenticated/public API, CSRF/IDOR/replay, export, redaction, and top-up webhook tests: 23/23.
  - UI DTO/dialog/privacy/public-page tests: 27/27.
  - Mock-backed Cloud browser lifecycle and redacted authority snapshot tests: 2/2.
  - Android policy/typed contract tests: 3/3.
  - Migration release barrier: 19/19.
  - Serialized staging-canary contract/workflow: 12/12.
  - Additional database erasure, rollback, resource purge, and app cleanup tests: 14/14.
- Typechecks pass for Cloud shared, Cloud API, UI, Cloud E2E, and Cloud test-mocks. Cloud API typecheck includes a successful Wrangler Worker dry-run; it did not deploy.
- Dedicated Cloud visual audit: both account-deletion desktop and mobile cases pass. Aggregate result is 96 passed, 1 skipped, 4 unrelated baseline failures (`cloud-agents` fixture and `auth-bridge` redirect behavior), with `broken=0` and `needs-work=0`.
- Full app visual capture: 226/227 tests pass. The single aggregate strict failure records two generic Settings-list overlay collisions (`API Keys` at mobile portrait and `Plugin Grants` at iPad portrait); the account-deletion dialog/public page and shared Cloud plugin surface pass all audited viewports. This is upstream shell/layout debt, not a deletion-owned route or component failure.
- Root `bun run verify` passes guide parity, version, i18n, dependency, alias-read, and workspace-resolution gates, then stops in upstream-only `@elizaos/ui` lint with four formatting/import errors in `account-table-model.safe-sort.test.ts`, `account-table-model.ts`, and `reset-time.ts` plus five SSO cookie warnings. None of those paths are in this series; the candidate diff is clean.
- No hosted final-absence claim is made. Local deterministic and mock-backed evidence is not presented as proof of real provider erasure.

## Stable server contract

- Authenticated request/status: `GET|POST /api/v1/me/account-deletion`. POST requires recent direct authentication, exact `DELETE` confirmation, same-origin protection, and tenant-scoped identity. It returns 202 only after the atomic reservation/fence commits.
- Public request/status/cancel: `POST /api/public/account-deletion`, `/status`, and `/cancel`. Status and recovery use distinct opaque headers; query parameters are never identity or success proof.
- Export: `POST /api/public/account-deletion/export` requires exact confirmation and immutable capability/generation. It returns only read-back-verified encrypted bytes with no-store and digest headers.
- Cancellation is explicitly nonterminal while provider reactivation reconciles: `status=canceling`, `accessState=fenced`, `canCancel=false`, `nextAction=wait_for_reconciliation`. Only terminal `status=canceled` has `accessState=active`, `canCancel=false`, `nextAction=none`. Revoked sessions and API keys are never resurrected.
- Shared exit returns `TRANSFER_REQUIRED` until an active successor owner is selected and the transfer/revoke transition commits.

## Shared and hosted authority

- Shared remains the sole Cloudflare/Railway release and staging writer. This lane did not query credentials, deploy, alter a project/environment, apply a hosted migration, or start a competing release.
- Shared reported Steward staging healthy on exact reviewed commit `e5f84b782972568027460bec042d1b25a1df3265`, Railway deployment `a7676319-b4c7-4794-aa10-5b4746b90a44`, and image digest `sha256:190bc081a74149a0b3e6fbe6d214f3fbc0b7a472d86da6cd2a3e7bb02a886738`. `/ready=200` with 94 image/database migrations through `0113_personal_tenant_account_lifecycle` and passing migration/RLS checks.
- That exact Shared report is dependency authority only. The deletion candidate and migrations `0311`-`0314` have not been deployed or applied to any hosted database.

## Doing

- Draft PR #25738 is published at `https://github.com/elizaOS/eliza/pull/25738` from the clean current-base branch. It remains draft pending inline visual artifacts, serialized disposable hosted proof, and the reviewer matrix. No deployment or hosted provider operation was part of publication.

## Next / exact external gates

1. Shared selects the exact reviewed PR head and serializes one isolated non-production Cloud candidate against its pinned Steward staging authority. This lane must not dispatch a competing Cloudflare/Railway release.
2. Cloud/SRE provides an isolated disposable PostgreSQL database plus exact Hyperdrive/database-identity receipts. Apply `0311`-`0314` only there and run the external PostgreSQL/concurrency matrix.
3. Storage owners provide disposable primary R2/S3 and secondary backup/spool authorities. Run the three skipped object-store cases and prove absence by authoritative listing/inspection. Reconcile lost responses; never repeat an uncertain purge.
4. Provider owners supply reviewed disposable fixtures for Stripe, compute/containers, GitHub/repos, connector OAuth/tokens, voice credentials, domains, Vault/key bindings, and every remaining classified grant.
5. Run one serialized hosted canary with disposable users/data only: authenticated and public requests, export/download, cancellation/reactivation, shared transfer/exit, injected outage/lost response and resume, recovery expiry, final database/object/provider erasure, post-session status, and cross-tenant preservation.
6. Obtain Cloud, Security, SRE, Steward, billing, compute, storage, connector, voice, domain, Vault, GitHub, and Android contract reviews. Production deployment/migration, real-user deletion, merge, and store acceptance remain separately gated.

## Rollout and rollback

- Rollout: Shared pins the reviewed commit, verifies database identity and migration plan read-only, deploys one isolated candidate, applies migrations to the disposable database, enables only the serialized canary worker, and captures identifier-free phase receipts.
- Rollback before irreversible authority: stop the canary worker/scheduler, retain reservations and phase evidence, deploy the prior source through Shared, and leave lifecycle fences fail-closed. Do not downgrade or delete migration records.
- Rollback after any ambiguous provider call: keep the request fenced and reconcile by canonical provider inspection. Do not rerun a mutation, erase evidence, restore access, or claim cancellation/completion until the authoritative receipt converges.

## Draft PR review package

- Draft PR: #25738, `feat(cloud): complete authoritative account deletion lifecycle`.
- Initial publication head: `010b1a5cb57f794a3263a06a24d7798fa225111e`; the final ledger-only follow-up is the branch tip and PR evidence marker authority.
- Link as `Addresses #23098`; do not claim closure until disposable hosted final-absence evidence is attached.
- Reviewer matrix: Cloud/API/database, Security, SRE/release, Steward, billing/Stripe, compute/container, storage/R2/backup/spool, GitHub/repository, connector OAuth, voice, domains, Vault/key authority, and Android contract owners.
- Required hosted evidence: exact source and database identity, migration/rollback receipts, redacted provider phase receipts, public/in-app request recordings, export/cancel/reconciliation evidence, and verified final absence. Evidence is attached to the issue/PR, not committed to the repository.
