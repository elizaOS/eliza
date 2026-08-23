# Account deletion lifecycle status

Updated: 2026-08-23 (America/Los_Angeles)

## Done

- Preserved the accepted fail-closed lifecycle/authority lineage, including `d6131f9c36d3d0528118132caa822211014663dd`, tag `account-deletion-authoritative-backup-fence-20260822`, and the clean prior current-base candidate `4148261c5aa4594e45dc5452caf5e42eccbd0cea` in `/Users/nubs/.codex/worktrees/account-deletion-current-base-20260823/eliza`. No reset, clean, overwrite, force update, deployment, production migration, provider mutation, or real deletion occurred.
- Built the publication candidate in the isolated worktree `/Users/nubs/.codex/worktrees/account-deletion-current-base-e1bfbf7-20260823/eliza` on branch `codex/account-deletion-current-base-e1bfbf7-20260823`.
- Fetched action-time `origin/develop@0f9911498ab9bea0b2d4c369f39b0382563b99ae`. The final upstream advances (33 commits to `db58d18887`, then 7 commits to `0f9911498a`) had zero path overlap with the deletion patch and were composed with normal non-FF merges at `7005e17f2d` and `e477f7e5c8`; no rebase, reset, clean, or force update was used. The exact deletion code checkpoint is `0470865a57b87dd2ef33bbc0c9cecc0e0f462bef`; the exact composed head before this ledger commit is `e477f7e5c8f53c243cf5ef9495bf087e24aca429`.
- Preserved merged #24256 and #24803: current tenant scoping, strict receipt parsing, canonical SSO sign-out, public-route distrust of query parameters, and canonical redacted evidence snapshots remain intact while the unavailable-only presentation is superseded by the authoritative lifecycle.
- Preserved the deliberate fail-closed fence from #22854 while implementing parent issue #23098 as resumable lifecycle authority rather than reverting the guard.
- Defined four separate operations and authorities: agent stop/wake, subscription cancellation, shared-member exit/ownership transfer, and personal account deletion.
- Implemented atomic first-receipt reservation under user/organization/membership locks, lifecycle revision publication, session/API-key/auto-top-up/renewal/provisioning fencing, recent-auth and exact-confirmation checks, separate opaque status/recovery capabilities, and replay-safe tenant scoping. A client-generated 32-byte admission capability is persisted before POST, stored only as a SHA-256 hash, and deterministically re-delivers the first status/recovery capabilities after a committed response is lost without repeating Steward or provider work.
- Implemented bounded deterministic encrypted export, conditional object creation, read-back verification, immutable capability/generation fencing, lost-response reconciliation, export expiry cleanup, and fail-closed size/source limits.
- Implemented a leased, generation-fenced provider saga with phase receipts, stable idempotency keys, retry classification, inspection-before-retry, Steward deactivation/reactivation reconciliation, primary object purge, and injected backup/spool authority boundaries. Ambiguous destructive calls remain fenced for canonical inspection and are never blindly repeated.
- Implemented shared-owner transfer invariants: an active successor is required; shared assets and organization billing are preserved; zero-owner transitions fail with actionable `TRANSFER_REQUIRED`.
- Implemented atomic personal-database erasure plus transactional identifier nulling, retaining only a bounded non-identifying completion receipt. Restrictive unknown foreign keys roll back the transaction.
- Classified all 222 direct user/organization foreign keys with digest `43b16eaa3187570ae57fe448226ed719ebbf161e9ea7fe465ed97f4199eb0280`: 70 external reconciliation, 92 private deletion, 50 retained/anonymized, and 10 shared-transfer edges. The current-base `agent_sandbox_replacement_attempts.organization_id` edge is explicitly reconciled by compute authority; ambiguous replacement effects fail closed, and terminal tenant-linked attempt rows are erased only inside final atomic database erasure. Unknown restrictive relationships still roll back the transaction.
- Preserved upstream migration history through `0311_personal_shared_group_participants` and appended `0312_account_deletion_lifecycle_authority`, `0313_account_deletion_phase_receipts`, `0314_account_deletion_exports`, `0315_account_deletion_canceling_state`, and `0316_account_deletion_admission_recovery`. Historical account-deletion migration `0276` remains intact. Upstream's stronger atomic migration barrier is used unchanged.
- Regenerated the Cloud router at 702 mounted routes, 127 shards, and 0 unconverted routes; regeneration leaves no diff.

## Recomposition and identity proof

- Prior-base head: `f666c9df0beddace21043c5ffd29f05f0fee4717` on `d2cdce0d56b91eea0898841cbfa01f0d8476cb7b`.
- Current-base composition head: `e477f7e5c8f53c243cf5ef9495bf087e24aca429` with deletion code checkpoint `0470865a57b87dd2ef33bbc0c9cecc0e0f462bef` on `0f9911498ab9bea0b2d4c369f39b0382563b99ae`.
- `git range-diff d2cdce0d56..f666c9df0b c3f070a5ee..077e11519b` maps all 24 code commits one-for-one with `=`.
- The accepted 24-commit lifecycle series retains aggregate stable patch identity `54c3805e2be12e559f4546e6308842a682b65f59`; the current complete 30-commit candidate diff against `0f9911498a` has stable patch ID `91a0fe455f19d83a5066af0a4658f9196613ba20`.
- The 24-commit series scans 447.58 KB with gitleaks and contains no detected secret.
- `git diff --check` passes. Biome checks all 62 changed TypeScript/TSX/JSON files with no findings.

## Tests and evidence

- Installation and build: `bun install --frozen-lockfile` passes; core build passes 60/60 tasks.
- Full affected matrix on the immediately preceding zero-overlap base: 300 tests pass and 3 S3 integration cases intentionally skip without disposable object-store authority.
  - Cloud shared lifecycle, repository, migration, concurrency, billing, renewal, provisioning, auth, export, provider, and authority tests: 192/192.
  - Authenticated/public API, CSRF/IDOR/replay, export, redaction, and top-up webhook tests: 23/23.
  - UI DTO/dialog/privacy/public-page tests: 27/27.
  - Mock-backed Cloud browser lifecycle and redacted authority snapshot tests: 2/2.
  - Android policy/typed contract tests: 3/3.
  - Migration release barrier: 19/19.
  - Serialized staging-canary contract/workflow: 12/12.
  - Additional database erasure, rollback, resource purge, and app cleanup tests: 14/14.
- After the final deletion-adjacent zero-overlap merge to `db58d18887`, 91 high-risk tests pass across migration-chain application, PGlite reservation/concurrency/atomic erasure, full-schema FK classification, compute/backup/spool fail-closed adapters, lifecycle service, authenticated/public replay routes, browser capability persistence, auto-top-up, Stripe webhook, domain renewal, provisioning, and typed four-operation contracts. The subsequent seven commits through `0f9911498a` touch only app/core/shared tests and shortcut handling, with no deletion-path overlap. Backend and API tests were isolated per process; one deliberate Bun invocation of a Vitest file was discarded and rerun correctly as 10/10 through the UI package runner.
- Typechecks pass for Cloud shared, Cloud API, UI, and Cloud E2E. Cloud API typecheck includes a successful Wrangler Worker dry-run; it did not deploy. Owner-scoped Biome lint passes for app-core, Cloud shared, Cloud API, and UI; warnings are confined to untouched upstream tests.
- Dedicated Cloud visual audit: both account-deletion desktop and mobile cases pass. Aggregate result is 96 passed, 1 skipped, 4 unrelated baseline failures (`cloud-agents` fixture and `auth-bridge` redirect behavior), with `broken=0` and `needs-work=0`.
- Full app visual capture: 226/227 tests pass. The single aggregate strict failure records two generic `builtin-settings` overlay collisions at mobile and iPad portrait; the account-deletion dialog/public page and shared Cloud plugin surface pass all audited viewports. This is upstream shell/layout debt, not a deletion-owned route or component failure.
- Root `bun run verify` passes guide parity, version, i18n, dependency, alias-read, publish-graph, and workspace-resolution gates, then stops in untouched `@elizaos/capacitor-gateway` because the local SwiftLint runtime cannot load `sourcekitdInProc.framework`. Owner paths lint and typecheck cleanly; `git diff --check`, guide parity, and a redacted gitleaks stdin scan pass.
- No hosted final-absence claim is made. Local deterministic and mock-backed evidence is not presented as proof of real provider erasure.

## Stable server contract

- Authenticated request/status: `GET|POST /api/v1/me/account-deletion`. The stable POST body is `{ confirmation: "DELETE", admissionCredential: <43-character base64url> }`. Initial admission requires recent direct authentication, exact confirmation, same-origin protection, and tenant-scoped identity. It returns 202 only after the atomic reservation/fence commits; retry with the same admission capability may recover that committed response after session revocation without another provider call.
- Public request/status/cancel: `POST /api/public/account-deletion`, `/status`, and `/cancel`. Status and recovery use distinct opaque headers; query parameters are never identity or success proof.
- Export: `POST /api/public/account-deletion/export` requires exact confirmation and immutable capability/generation. It returns only read-back-verified encrypted bytes with no-store and digest headers.
- Cancellation is explicitly nonterminal while provider reactivation and export revocation reconcile: `status=canceling`, `accessState=fenced`, `canCancel=false`, `nextAction=wait_for_reconciliation`. The recovery capability remains valid for idempotent retry while canceling. Only terminal `status=canceled` has `accessState=active`, `canCancel=false`, `nextAction=none`, at which point recovery/admission hashes are cleared. Revoked sessions and API keys are never resurrected.
- Shared exit returns `TRANSFER_REQUIRED` until an active successor owner is selected and the transfer/revoke transition commits.

## Shared and hosted authority

- Shared remains the sole Cloudflare/Railway release and staging writer. This lane did not query credentials, deploy, alter a project/environment, apply a hosted migration, or start a competing release.
- Shared reported Steward staging healthy on exact reviewed commit `e5f84b782972568027460bec042d1b25a1df3265`, Railway deployment `a7676319-b4c7-4794-aa10-5b4746b90a44`, and image digest `sha256:190bc081a74149a0b3e6fbe6d214f3fbc0b7a472d86da6cd2a3e7bb02a886738`. `/ready=200` with 94 image/database migrations through `0113_personal_tenant_account_lifecycle` and passing migration/RLS checks.
- That exact Shared report is dependency authority only. The deletion candidate and account-deletion migrations `0276` and `0312`-`0316` have not been deployed or applied to any hosted database by this lane.

## Doing

- Draft PR #25738 is published at `https://github.com/elizaOS/eliza/pull/25738`. Maintainer P0 review identified the first-response-loss orphaning risk; code checkpoint `0470865a57` resolves it with hash-only admission recovery and no repeated provider mutation. The PR remains draft pending the ledger/push update, serialized disposable hosted proof, and independent review. No deployment or hosted provider operation was part of this work.

## Next / exact external gates

1. Shared selects the exact reviewed PR head and serializes one isolated non-production Cloud candidate against its pinned Steward staging authority. This lane must not dispatch a competing Cloudflare/Railway release.
2. Cloud/SRE provides an isolated disposable PostgreSQL database plus exact Hyperdrive/database-identity receipts. From the hosted ledger currently reported at `0113_personal_tenant_account_lifecycle`, Shared must plan and apply the complete intervening migration chain through current `0316`; account-deletion-specific checkpoints are existing `0276` plus current `0312`-`0316`. Verify journal/image/database identity before and after, then run the external PostgreSQL/concurrency matrix.
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
- Initial publication head: `010b1a5cb57f794a3263a06a24d7798fa225111e`; response-loss fix head: `0470865a57b87dd2ef33bbc0c9cecc0e0f462bef`; the final ledger-only follow-up is the branch tip and PR evidence marker authority.
- Link as `Addresses #23098`; do not claim closure until disposable hosted final-absence evidence is attached.
- Reviewer matrix: Cloud/API/database, Security, SRE/release, Steward, billing/Stripe, compute/container, storage/R2/backup/spool, GitHub/repository, connector OAuth, voice, domains, Vault/key authority, and Android contract owners.
- Required hosted evidence: exact source and database identity, migration/rollback receipts, redacted provider phase receipts, public/in-app request recordings, export/cancel/reconciliation evidence, and verified final absence. Evidence is attached to the issue/PR, not committed to the repository.
