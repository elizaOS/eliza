# Account deletion lifecycle status

Updated: 2026-08-23 (America/Los_Angeles)

## Done

- Isolated worktree: `/Users/nubs/.codex/worktrees/bc7e/eliza`; branch: `codex/account-deletion-lifecycle-23098`.
- Exact starting base: `origin/develop@d54d91ea36d217ad8d1bf2c1d47b7dcd91183111`. Preserved detached snapshot `e58da6bfe0495709dc4844c30e39b32d706e8590`; no reset, clean, push, deploy, or other-worktree mutation.
- Lifecycle-authority checkpoint: `d9061c1e085e8b646ce4af49844ed5e0d34509b9`, tag `account-deletion-lifecycle-authority-20260822`.
- Encrypted-export contract checkpoint: `496d77baefc5ef57cfe6a900be572c374883382b`, tag `account-deletion-encrypted-export-contract-20260822`.
- Generic public UI checkpoint: `c71a5932c886141c618d3c2b1daea5f2c34b6675`, tag `account-deletion-public-ui-20260822`.
- Replayed current-develop contract: `f36c6fd1d37b123f388a0d89ffaed1990be22ec8`, tag `account-deletion-encrypted-export-contract-current-develop-20260822`.
- Exact current-develop export/UI candidate: `98dcb1baacc6b72402fdd855c8957e775cb1d7f2`, tag `account-deletion-export-ui-candidate-20260822`; parent base `origin/develop@a40cc65d3f`.
- Durable saga/cancellation checkpoint: `00e8008de9ea357eef772ec708e4d727e77d3198` (tagged by the following ledger checkpoint as `account-deletion-fenced-saga-20260822`).
- Restart-safe cancellation reconciliation: `5b1e51e7b098449fe38ac991d4af8cc63286e715`.
- Domain-renewal lifecycle fence: `e996bef3b0f6dddff403bca56dc0c766a70b311c`.
- Provisioning dispatch lifecycle fence: `a73f71110420b847549226ea636a36db1bb4f050`.
- Atomic terminal-erasure transaction proof: `dbd69ee075598a97ad4514b62943373a05b27274`.
- Bounded local completion-audit cleanup: `8b4009f72bda8dff2f9fccd77f23a006135a9f73`; tag `account-deletion-local-completion-audit-20260822` points at the following ledger checkpoint.
- Disposable S3-compatible object-purge proof uses the repository's hard-gated loopback suite and local MinIO image `sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e`; tag `account-deletion-local-s3-proof-20260822` points at this evidence ledger checkpoint.
- Authoritative remote-spool fence: `ca0509ad5f7ec161f0d72428296790c801e39b67`; tag `account-deletion-spool-authority-fence-20260822` points at the following ledger checkpoint.
- Resumed local lifecycle QA repaired the auto-top-up webhook test harness at `0633bbd46252edd0b0a023d0769accb1a58246fa` and checkpointed primary lifecycle session/API-key fencing plus the disposable full-stack deletion journey at `a58db77fa004dd09b982625e921dd29dff480e21`; tag `account-deletion-local-lifecycle-qa-20260822` points at the following ledger checkpoint.
- Audited issue #23098, merged fail-closed PR #22854 / `c276ccf007dd8f1e6102b8d5799b5ec6109394ef`, UI-only draft PRs #24253/#24256, applicable repository/package guides, schema ownership, and current migration tail.
- Claimed the Cloud/Security implementation lane on issue #23098: https://github.com/elizaOS/eliza/issues/23098#issuecomment-5378961151.
- Classified all 215 direct user/organization foreign-key edges with a fail-closed digest-pinned runtime policy: 69 external reconciliation, 10 shared transfer, remaining cascade/anonymize; unknown restrictive edges fail tests. Digest: `15534d017ba7c2a8414b4831ded62b8fe6256daca279115c56c48eacf62e0e3a`.
- Published four separate typed operations: agent stop/wake, subscription cancellation, shared-member exit/ownership transfer, and personal account deletion.
- Reconciled the append-only migrations after upstream `0299_synthetic_environment_leases`: `0300_account_deletion_lifecycle_authority`, `0301_account_deletion_phase_receipts`, `0302_account_deletion_exports`, and `0303_account_deletion_canceling_state`; journal idx 283-286. Historical `0276_account_deletion_requests` remains intact.
- Implemented primary-writer organization/user/request locking; one durable request receipt; lifecycle revision; immediate fences for sessions, API keys, auto-top-up, paid work, and account authority; generation-fenced saga phase receipts; separate opaque status and recovery capabilities. Concurrent replays cannot rotate the first committed capabilities.
- Implemented exact confirmation, recent direct Steward auth, origin checks, fail-closed rate limiting, authenticated and public request paths, no-store credential responses, post-session status, recovery-window undo, and Steward deactivation/reactivation reconciliation.
- Shared personal deletion fails with actionable `TRANSFER_REQUIRED` and does not mutate shared tenant authority.
- Implemented the bounded portable export: one repeatable-read/read-only PostgreSQL snapshot, complete runtime FK inventory, deterministic ordering, recursive credential redaction (including camelCase provider fields), 100,000-row per-table preflight, 32 MiB aggregate/source/serialized limits, and fail-closed oversized handling.
- Export objects use AES-256-GCM with request-digest AAD, a recovery-capability-derived key, an opaque digest-only object key, immutable R2 `If-None-Match: *`, ciphertext/content digests, read-back verification, and atomic generation-fenced database completion.
- Lost object-write responses enter `reconciling`; a later generation reads and verifies the existing object before committing and never repeats the put. Confirmed provider absence is the only path back to a build retry.
- Cancellation and expiry schedule an `export_revoke` receipt after a 15-minute safety delay that outlives the five-minute export lease. R2 delete success with a lost response is reconciled by confirmed absence without repeating delete; completion atomically nulls content/size and records only the deletion receipt digest.
- Added final-boundary auto-top-up lifecycle/revision checks before authorization and immediately before Stripe.
- Domain renewals now capture active lifecycle authority before debit and recheck the exact revision immediately before Cloudflare. A revision/state change refunds the debit and returns `lifecycle_fenced` without calling the registrar.
- Provision/resume/wake/restart/upgrade/log/message/snapshot jobs now capture active account authority, perform database-only lifecycle preparation, and recheck the exact revision before dispatching provider work. Stop/suspend/sleep/delete jobs remain authorized cleanup operations.
- Preserved the legacy due-worker `LIFECYCLE_RESERVATION_REQUIRED` fence; irreversible personal erasure is not enabled prematurely.
- Added ordered generation-fenced provider phases, durable before-call markers, immutable idempotency keys, retry classes, leases, canonical-state reconciliation, and transactional terminal erasure with identifier nulling. A lost provider response is inspected before any later mutation; an inspection outage remains reconciling.
- Added a distinct nonterminal `canceling` state. Cancellation keeps organization/user/auth/paid-work fences active and leaves existing sessions and API keys revoked. Only completed `steward_reactivation` and `export_revoke` receipts permit a locked lifecycle-revision increment and terminal `canceled` publication.
- Proved that concurrent expiry workers publish irreversible authority once, cancellation cancels an in-flight phase generation, and its stale provider callback cannot restore or overwrite cancellation authority.
- Cancellation reactivation now resumes after process restarts: a reconciling worker inspects canonical Steward state before mutation, commits an already-active identity without replay, and requires a later generation after confirmed non-effect. The loopback Steward mock now exposes the same GET inspection and true deactivate/reactivate semantics.
- Terminal database erasure is transactionally proven: the personal organization graph is removed before the receipt identifiers are nulled, leaving only the bounded status-token hash and completion digest. A surviving restrictive foreign key rolls back both erasure and identifier nulling.

## Android/shared contract handoff

- Current-develop contract source: `f36c6fd1d37b123f388a0d89ffaed1990be22ec8` (`account-deletion-encrypted-export-contract-current-develop-20260822`). The original pre-replay handoff remains preserved at `496d77baefc5ef57cfe6a900be572c374883382b`.
- Typed contract: `packages/cloud/shared/src/types/account-lifecycle.ts` exports `AccountDeletionAcceptedDto`, `AccountDeletionStatusDto`, status/export enums, next actions, conflict codes, and the four operation contracts.
- `POST /api/v1/me/account-deletion`: recent authenticated session, same-origin mutation, exact JSON `{ "confirmation": "DELETE" }`; returns `202 AccountDeletionAcceptedDto` only for the initial accepted reservation.
- `POST /api/public/account-deletion`: external recently authenticated request path with the same exact confirmation and accepted DTO.
- `GET /api/public/account-deletion`: post-session status via `X-Account-Deletion-Status`; URL parameters are never authority.
- `DELETE /api/public/account-deletion`: recovery undo via separate `X-Account-Deletion-Recovery` and exact JSON `{ "confirmation": "CANCEL DELETION" }`.
- `POST /api/public/account-deletion/export`: recovery export via `X-Account-Deletion-Recovery` and exact JSON `{ "confirmation": "EXPORT MY DATA" }`; returns verified JSON bytes plus `X-Account-Deletion-Export-SHA256` and attachment disposition.
- Clients must retain the two opaque capabilities separately before ordinary logout, never place them in a URL/log/telemetry payload, never infer success from redirects/query parameters, and verify the download SHA-256 before presenting success.
- Stable cancellation DTO rule from `00e8008de9`: `status: "canceling"`, `accessState: "fenced"`, `canCancel: false`, and `nextAction: "wait_for_reconciliation"` are nonterminal. Only `status: "canceled"`, `accessState: "active"`, and `nextAction: "none"` are terminal. Android/web must not infer terminal cancellation from the HTTP mutation response alone; poll the opaque status capability.

## Doing

- Local implementation and audit are parked at a tagged, clean candidate. The bounded encrypted export/download, recovery capability, generic public page, lifecycle authority, cancellation contract, renewal/provisioning fences, atomic terminal database transaction, and primary-read auth fence are checkpointed.
- Default adapters cover Steward, Stripe, domains, backup catalogue objects, compute/containers, GitHub/apps, connector OAuth, voice credentials, primary object storage, Vault bindings, and discovered grants. Remote spool absence can no longer be inferred from local backup rows: the phase requires a canonical `AccountDeletionSpoolAuthority`, passes through the saga idempotency key, and fails closed when unwired.

## Next

1. Reconcile this tagged source with the current `origin/develop` under the shared staging owner's serialization; this branch is intentionally not rebased during the local audit.
2. Android consumes the tagged typed `canceling`/`accessState` contract; no Android files were edited here.
3. The shared staging owner deploys only the approved exact source to an isolated disposable non-production environment, advances migrations `0300`-`0303` through the normal guarded rollout, and captures health plus rollback evidence.
4. Provider owners wire both backup-store authorities and the canonical spool reconciler, then exercise disposable Steward, Stripe, compute/container, GitHub/repo, connector, voice, domain, R2/backup, Vault/key, and grant fixtures, including lost-response reconciliation and verified absence.
5. After staged final-absence evidence, prepare publication/review with Cloud, Security, SRE, Steward, billing, Android, and provider owners. Production deployment, migration, push, merge, and real-user deletion remain unauthorized.

## Reused prior work

- Reused content from #22854: base request receipt, resource-purge helpers, primary-writer erasure foundation, Steward helpers, app/sandbox/voice cleanup hooks, cron entry, and local E2E harness.
- Recovered prior request/export/receipt patterns by content and tests; the deliberate guard was not reverted.
- #24253/#24256 remain truthful unavailable-state UI drafts only; this lane supplies the backend/shared/public contract without mutating those branches.

## Tests and evidence

- Resumed disposable local audit: Cloud shared deletion/auth/migration/repository/export/saga/provider/resource/fencing matrix 225/225 with 858 assertions; Cloud API deletion routes 12/12; auto-top-up route/webhook 23/23; migration runner/barrier/identity suites 16/16 with 74 assertions; staging-canary guard contracts 12/12; generic UI deletion client/panels 16/16.
- Real local Worker + PGlite + loopback Steward Playwright journey passes 1/1: exact confirmation, immutable distinct status/recovery capabilities, reservation, immediate user/org/API-key/session fence, post-session public status, cross-tenant preservation, cancel-during-provider-work, nonterminal `canceling` DTO, Steward reconciliation, and continued Cloud fence until export/provider cleanup. The runner's release-barrier acknowledgement is accepted only for `NODE_ENV=test`, `CLOUD_E2E=1`, and PGlite/loopback PostgreSQL; remote or production targets fail closed.
- The full-stack journey exposed and fixed a stale-cache authorization defect: session and API-key boundaries now primary-read organization lifecycle authority before returning access. Focused auth proof passes 30/30 with 73 assertions, including rejection of a cached active identity after deletion reservation and production-disabled signed test recent-auth behavior.
- Resumed public-page readiness proof passes the focused desktop/mobile audit 2/2; both exact captures were manually inspected as readable with no visible overflow or layout break. No staging, MinIO, hosted object store, provider, or production state was contacted during this resumed audit.
- Cloud shared, Cloud API, Cloud e2e, and Cloud test-mocks typechecks pass; the Cloud API production Worker build passes in dry-run mode only. Focused Biome, `git diff --check`, and redacted Gitleaks diff scanning pass.
- Bounded exact-head audit: shared contract/migration/repository/saga/export/resource suites 47/47 with 197 assertions; renewal/provisioning boundary suites 69/69 with 324 assertions; cancellation/authority/auto-top-up regression suites 80/80 with 276 assertions; API routes 12/12 with 32 assertions; isolated database integrations 4/4 with 18 assertions; staging-canary guard contracts 12/12 with 75 assertions; UI deletion client/panels 16/16.
- Terminal erasure repository suite now passes 10/10 with 77 assertions, including completed identifier-free receipt retention and restrictive-FK rollback.
- Disposable object-store integration passes 1/1 with 5 assertions against MinIO bound only to `127.0.0.1:59000`: exact organization path-segment and metadata ownership were erased while another tenant and substring-only keys remained. The one-off container and its ephemeral data were removed after the run.
- Remote-spool adapter and saga/service proof passes 20/20 with 62 assertions: missing authority is actionable, confirmed absence is the only completion path, the exact organization and idempotency key cross the purge boundary, and a lost successful response reconciles without a second mutation. Cloud shared and Cloud API typechecks, Worker dry-run, and focused Biome pass.
- Exact-head focused backend/migration proof: 47/47 pass: export 7, lifecycle service 11, real PGlite reservation/concurrency/export fencing 6, full-schema FK policy 3, migration application 3, migration journal 5, public status/request/undo route 6, authenticated route 3, export route 3.
- Saga/cancellation checkpoint proof: 32/32 pass across public route 6, provider saga lost-response/stale-generation 3, lifecycle service 11, migration application 4, and real PGlite reservation/cancellation/expiry concurrency 8; 134 assertions. Cloud shared typecheck and Cloud API typecheck/production Worker dry-run pass.
- Restart-safe cancellation proof: lifecycle/PGlite focused suites 21/21 pass with 103 assertions; Cloud shared, Cloud test-mocks, and Cloud API typechecks pass, including the Worker dry-run bundle.
- Domain renewal boundary proof: 12/12 pass with 37 assertions, including pre-debit deletion fencing and post-debit revision-change refund/no-provider-call; Cloud shared typecheck passes.
- Provisioning boundary proof: 57/57 pass with 287 assertions across the lifecycle fence and complete execute-dispatch success/failure matrix; Cloud shared typecheck passes.
- Correct Vitest UI client command passes 5/5. Direct Bun execution of that Vitest file fails before tests because Bun's compatibility layer lacks `vi.hoisted`; this is a runner mismatch, not a product failure.
- Generic UI/client: 16/16 pass under Vitest, including capability persistence, no query-parameter authority, exact undo/export confirmations, and client-side SHA-256 mismatch rejection.
- Focused Biome check across all changed backend/UI files: pass.
- `git diff --check`: pass. Gitleaks scanned all local commits from `origin/develop` through the audit checkpoint with redaction enabled: no leaks found. No environment, key, credential, evidence, or secret file is changed.
- Cloud shared typecheck: pass.
- Cloud test-mocks typecheck: pass.
- Cloud API typecheck and production Worker dry-run bundle: pass after replaying onto `origin/develop@a40cc65d3f`.
- UI-wide typecheck has one unchanged environment baseline failure at `packages/ui/src/bridge/storage-bridge.ts:53`: missing `@elizaos/capacitor-secure-store` type/module; focused UI tests are clean.
- An initial root-level `bun test` aggregate was invalid for these package-specific suites and produced module/mock/setup failures. Rerunning through the declared Cloud shared, Cloud API isolated, and UI Vitest runners produced the exact green results above; the invalid aggregate is not product evidence.
- Direct Bun execution is not a valid runner for the two Vitest UI files because Bun lacks `vi.hoisted`; the correct Vitest run passes 16/16.
- The repository's coverage-enabled Bun PGlite run passes assertions but its coverage writer can fail with Bun `WriteFailed`; the identical suite passes 6/6 with an explicit disposable no-coverage Bun config.
- The broad app-view audit was stopped after 47 green captures/tests to prioritize the atomic backend handoff. The correct focused Cloud audit was rerun at exact candidate head and passed `/account-deletion` at desktop and mobile: 2/2, no console errors, banned blue, hover violations, or screenshot-quality issues. Both exact-head captures were manually inspected and found readable with no visible overflow/layout break.
- Earlier Drizzle generation was blocked before generation by existing `ERR_PACKAGE_PATH_NOT_EXPORTED` for `packages/core/node_modules/@elizaos/prompts/package.json`; migrations were reviewed append-only and independently applied in isolated PGlite.
- Staging mutations, provider calls, production mutations, real-user/account deletion, push, merge, deploy, and PR/Play state changes: none.

## Remaining gates

- Exact-source serialization is required before hosted testing because this lane deliberately did not fetch/rebase or overwrite concurrent work. The shared staging owner must reconcile the tagged candidate with current `origin/develop`, record the resulting immutable source, and approve the disposable deployment.
- The saga authority and default adapter candidate are committed, but `secondary_backups` requires an injected `AgentBackupObjectStoreRegistry`; without it the adapter returns `BACKUP_STORAGE_AUTHORITY_UNAVAILABLE`. The `spools` phase now always requires an injected canonical `AccountDeletionSpoolAuthority`; without it the adapter returns `BACKUP_SPOOL_AUTHORITY_UNAVAILABLE`, even when local backup rows are absent. The Cloud cron currently injects neither authority, so these are exact fail-closed composition/provider-owner gates.
- The disposable S3-compatible suite is locally proven, but no hosted R2 or secondary-backup provider erasure or absence claim is made.
- The local terminal transaction and full-schema FK classification are green, but complete disposable hosted final absence across PostgreSQL, both object stores/backups, spools, Steward, billing, compute, GitHub, connectors, voice, domains, Vault/keys, and grants remains required.
- Hosted acceptance must seed a disposable personal account plus a two-owner shared organization with an active successor, subscription/auto-top-up, agents/apps/containers, connector and voice credentials, domains, files/media, grants, and objects in both backup stores/spools. It must exercise authenticated app and public-page request, exact reauth/confirmation, post-session status, encrypted export/digest verification, transfer/exit, cancellation during provider work, terminal reactivation, replay/CSRF/IDOR/cross-tenant isolation, stale callbacks, outages, lost responses, restarts, and stale leases.
- The disposable account must then cross recovery expiry and prove transactional identifier nulling plus verified irreversible absence in PostgreSQL, primary object storage/R2, secondary backups/spools, and every provider, retaining only the bounded non-identifying receipt. Full authenticated interaction recording and redacted database/provider receipts remain hosted gates; the anonymous external route has focused desktop/mobile visual proof.
- Hosted evidence must include exact health, migration/rollback records, provider/database phase receipts, redacted logs, and the repository evidence bundle for the immutable disposable source.
- Android must consume and verify the stable nonterminal `canceling` contract before Play-facing acceptance; this lane did not mutate Android or claim Play acceptance.
- Independent Cloud, Security, SRE, Steward, billing, and provider-owner review.
- No production deployment, migration, push, merge, or real-user deletion is authorized.

## 2026-08-23 current-base backup/spool authority checkpoint

### Done

- Preserved the previously clean lifecycle head `301170f8cd9e44445d1609a5bc7a074cc184b8eb` and its existing tags. The broad 5,134-entry index overlay was the deliberate in-progress merge of upstream `49e937cd3dc5ba0cb5d4252815d09c8a38c7f92a`, not an unclassified user checkout: `MERGE_HEAD` named that exact commit, the index had zero unmerged paths, and the resulting candidate tree differed from the upstream merge parent in only 76 lifecycle-owned paths.
- Committed the semantic recompose and authority slice as merge checkpoint `53d2276c6fb1a31f843ad7b67df396b45818e9a6` with parents `301170f8cd9e44445d1609a5bc7a074cc184b8eb` and `49e937cd3dc5ba0cb5d4252815d09c8a38c7f92a`. Conflict resolutions reused reviewed response-loss/admission-capability content from `5f700fdffffd7505b10f77d6be6a695e3e7b136f` by exact file content where applicable; the fail-closed fence was not reverted.
- Merged the two later, zero-overlap upstream commits normally. Exact current-base source is `5baee99d1bdfc3ab4b402515f648e98ce1afdaab`, tree `40ded85ae448f27459b7cc8c363b156b5e1ab80e`, parents `53d2276c6fb1a31f843ad7b67df396b45818e9a6` and exact `origin/develop@6cc570c8efa9000a163df5b37487898551c64d29`. Local annotated tag: `account-deletion-backup-spool-authority-current-base-20260823`.
- Patch isolation against that exact base is 76 paths with stable patch ID `cc31e3e1177247d6971a580a2f7670a6bc5d7995`. No Android-native path is changed.
- Added a canonical remote-backup deletion authority over the exact immutable `AgentBackupObjectStoreRegistry`. It requires both Cloudflare R2 and Hetzner authorities, enumerates the exact `agent-sandbox-backups/v2/<organization-id>/` prefix on both providers (including orphan objects without catalogue rows), bounds and validates pagination, deletes by exact observed locator, and reconciles an ambiguous/lost response by inspecting before any retry.
- Added a node-local `AccountDeletionSpoolAuthority` composed from the backup worker's exact persistent spool configuration. Every durable operation is classified through its primary-database `backup_operation_id -> catalog_organization_id` reservation before mutation; missing/ambiguous classification, an unavailable/nonpersistent/symlinked StateDirectory, active writers, locks, or unsafe outbox entries fail closed.
- The dedicated backup worker now composes the deletion backup and spool authorities from the same pinned registry and spool config used by publication/janitor work. The disabled worker remains disabled-first and does not initialize provider authority.
- Reordered `spools` before `secondary_backups`, because spool classification needs the authoritative backup catalogue rows; only after provider/spool absence is proven may the local backup graph be removed.
- Corrected the pending spool cleanup boundary to release operation authority exactly once. A completed cleanup already releases its durable lock; a pending/failed cleanup releases in the typed catch and remains retryable.
- Migration relationship is preserved and append-only: `0312_account_deletion_lifecycle_authority`, `0313_account_deletion_phase_receipts`, `0314_account_deletion_exports`, `0315_account_deletion_canceling_state`, and `0316_account_deletion_admission_recovery` follow upstream `0311`; this authority-composition slice adds no migration.

### Tests and evidence

- `git diff --check` passed before both source commits; there are no unresolved paths. Sixteen affected source/test files transpile successfully with Bun `--no-bundle --target=bun` syntax checks. The disposable syntax output is `/tmp/account-deletion-syntax-check` (448 KiB) and may be reclaimed without touching repository evidence.
- Current-range redacted Gitleaks passed at `5baee99d1bdfc3ab4b402515f648e98ce1afdaab`: 23 commits and approximately 401.68 KiB scanned, no leaks found.
- The focused five-file Bun test run did not execute an assertion because this worktree has no root `node_modules` and package-local workspace links resolve into the missing root install. Module loading failed for `@aws-sdk/client-s3`, `drizzle-orm`, and transitive `handlebars`. Root Biome and package TypeScript executables are likewise unavailable. Per the disk/no-install gate, dependencies were not installed and no green focused-test or typecheck claim is made for this exact source.
- Earlier focused lifecycle, PGlite, provider-saga, UI, MinIO, and security receipts above remain historical evidence for their exact older checkpoint only. They are not represented as same-SHA hosted proof for this recompose.
- No staging, hosted database, object store, spool, external provider, production, or real-account mutation occurred. No push or PR mutation occurred in this slice.

### Doing

- Source composition is complete and parked at the exact local tag. The remaining runtime seam is serialization: the Cloudflare due worker cannot own the node-local spool filesystem. Shared must run the backup/spool phases through the dedicated backup-host composition (or an independently reviewed durable transport) and must never inject a generic blob binding or a fabricated absence response.
- Draft-PR handoff for issue #23098 is source-ready but not publication-ready until the exact dependency-backed focused tests/typechecks run, Shared confirms the serialized execution source, and independent reviewers approve the authority boundary.

### Next: Shared disposable staging checklist

1. Restore the pinned workspace dependencies without duplicating artifacts, then run the five focused authority/adapter/composition suites, Cloud shared typecheck, focused Biome, migration journal/application tests, and `git diff --check` against exact source `5baee99d1bdfc3ab4b402515f648e98ce1afdaab`.
2. Shared, as the exclusive release writer, stages only that reviewed source (or records a new exact composition SHA) in an isolated disposable nonproduction environment. Apply migrations `0312`-`0316` through the guarded migration path and capture health, migration, and rollback receipts; do not start a competing Cloudflare/Railway deployment.
3. Configure one exact Cloudflare R2 primary authority and one exact Hetzner secondary authority in the canonical `AgentBackupObjectStoreRegistry`. The dedicated backup host must mount the same exact persistent, non-temporary spool StateDirectory used by its worker and expose the composed `accountDeletionAuthorities` to the deletion saga through a reviewed durable boundary. Missing authority remains actionable failure, never absence.
4. Seed only a disposable personal tenant plus a two-owner shared tenant: catalogue-backed objects and orphan exact-prefix objects in both stores; another tenant and substring-lookalike prefixes; sealed/unpublished and published spools; protected and terminal outbox/candidate intents; subscription/auto-top-up, agents/apps/containers, connector/voice credentials, domains, files/media, Vault/key bindings, and grants.
5. Prove shared exit requires an active successor and preserves shared billing/assets. For personal deletion, exercise app and public request, exact reauth/confirmation, durable recovery-package acknowledgement before fencing, post-session status, export/digest verification, cancellation/reactivation, recovery expiry, and provider failure/resume.
6. Inject a lost response after each provider object deletion and spool cleanup. On restart, inspect canonical state first; never repeat an ambiguous purge. Prove stale generations/callbacks cannot mutate the new lifecycle revision, active locks/in-flight writes/unmounted StateDirectory/unknown journal classification all fail closed, and `spools` completes before the backup catalogue graph is erased.
7. Verify exact final absence: the target prefix is empty in R2 and Hetzner; no target durable spool operation or cleanup outbox/candidate remains on the mounted authority; the other tenant remains byte-for-byte present; PostgreSQL identifiers and tenant rows are transactionally erased/nullified with only the bounded anonymous receipt retained; primary blob storage, Steward, billing, compute, GitHub, connectors, voice, domains, Vault/keys, and discovered grants are absent.
8. Capture exact health, database/provider phase receipts, redacted logs, source/digest provenance, rollback steps, and independent Cloud, Security, SRE, Steward, billing, backup/spool, and provider-owner review. Production, real-user deletion, merge, and release remain separate approval gates.
