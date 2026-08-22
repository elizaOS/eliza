# Account deletion lifecycle status

Updated: 2026-08-22 (America/Los_Angeles)

## Done

- Isolated worktree: \`/Users/nubs/.codex/worktrees/bc7e/eliza\`; branch: \`codex/account-deletion-lifecycle-23098\`.
- Exact starting base: \`origin/develop@d54d91ea36d217ad8d1bf2c1d47b7dcd91183111\`. Preserved detached snapshot \`e58da6bfe0495709dc4844c30e39b32d706e8590\`; no reset, clean, push, deploy, or other-worktree mutation.
- Audited repository instructions, issue #23098, merged fail-closed PR #22854 / \`c276ccf007dd8f1e6102b8d5799b5ec6109394ef\`, and UI-only draft PRs #24253/#24256.
- Claimed the Cloud/Security implementation lane on issue #23098: https://github.com/elizaOS/eliza/issues/23098#issuecomment-5378961151.
- Classified all 215 direct user/organization foreign-key edges with a fail-closed digest-pinned policy: 69 external reconciliation, 10 shared transfer, remaining cascade/anonymize; unknown restrictive edges fail tests.
- Published four separate typed operations: agent stop/wake, subscription cancellation, shared-member exit/ownership transfer, and personal account deletion.
- Reconciled the append-only migrations after upstream `0304_personal_shared_group_delivery_lease`: `0305_account_deletion_lifecycle_authority`, `0306_account_deletion_phase_receipts`, and `0307_account_deletion_exports`; journal idx 288-290. Historical `0276_account_deletion_requests` remains intact.
- Implemented primary-writer organization/user/request locking; one durable request receipt; lifecycle revision; immediate fences for sessions, API keys, auto-top-up, paid work, and account authority; generation-fenced saga phase receipts; separate opaque status and recovery capabilities.
- Implemented exact-confirmation, recent direct Steward auth, origin checks, fail-closed rate limiting, authenticated and public request paths, post-session status, recovery-window undo, and Steward deactivation/reactivation reconciliation.
- Shared personal deletion fails with actionable \`TRANSFER_REQUIRED\` and does not mutate shared tenant authority.
- Added final-boundary auto-top-up lifecycle/revision checks before authorization and immediately before Stripe.
- Preserved the legacy due-worker \`LIFECYCLE_RESERVATION_REQUIRED\` fence; irreversible purge is not enabled prematurely.

## Doing

- Build a verifiable export receipt and encrypted disposable export artifact, then transition reserved requests into the disclosed recovery state.
- Replace the parked legacy worker with a phase-ordered, leased, reconciliation-first external saga.
- Define provider adapters and discovery receipts for Stripe/subscriptions, Steward, compute/containers, GitHub/repos, connectors/OAuth, voice, domains, primary objects, secondary backups, spools, Vault/key bindings, and other grants.

## Next

1. Add export generation/download capability and recovery-state transition tests.
2. Add shared-member transfer/exit and explicit subscription-cancellation authorities under locks.
3. Implement provider phase reconciliation with crash-before/call/commit and stale-lease tests.
4. Wire lifecycle checks into provisioning, renewal, backup/restore, connectors, voice, domains, and webhook reactivation boundaries.
5. Implement final schema anonymization/erasure and bounded non-identifying completion receipt.
6. Add the generic external deletion page and legal/retention copy using the shared server-authoritative contract.
7. Exercise disposable staging only after exact-source serialization; capture redacted provider/database receipts and verified absence.
8. Produce rollout/rollback/runbook, focused draft PR metadata, and reviewer matrix.

## Reused prior work

- Reused content from #22854: base request receipt, resource-purge helpers, primary-writer erasure foundation, Steward helpers, app/sandbox/voice cleanup hooks, cron entry, and local E2E harness.
- The guard was not reverted. Provider cleanup and database erasure remain fenced until all durable authority and reconciliation phases are present.
- #24253/#24256 remain truthful unavailable-state UI drafts only; this lane supplies the backend/shared/public contract without mutating those branches.

## Tests and evidence

- Shared typecheck: pass.
- Focused auto-top-up state machine: 72/72 pass, including deletion fence and lifecycle-revision race with zero Stripe calls.
- Account deletion service: 10/10 pass.
- Public API route: 6/6 pass.
- Authenticated API route: 3/3 pass.
- Recent-auth policy: 3/3 pass.
- Lifecycle authority: 2/2 pass.
- Four-operation contract: pass.
- Full-schema FK policy: 3/3 pass; pinned digest \`15534d...\` across 215 direct edges.
- Migration authority test: 3/3 pass.
- Real PGlite reservation/undo: 4/4 pass; locked fencing, concurrent receipt reuse, safe undo, and expired-window denial.
- Real PGlite lifecycle integration: 2/2 pass; personal reservation/status and shared transfer-required state.
- API-wide typecheck currently has one unchanged baseline failure at \`packages/cloud/api/v1/voice/session/__tests__/ws-lifecycle.test.ts:1089\` (optional trace ID used where required); account-deletion diagnostics are clean.
- Drizzle generation command is blocked before generation by existing package export failure: \`ERR_PACKAGE_PATH_NOT_EXPORTED: No "exports" main defined in packages/core/node_modules/@elizaos/prompts/package.json\`. Migrations were reviewed, append-only, and independently applied in isolated PGlite.
- Staging mutations/provider calls/production mutations: none.

## Remaining gates

- Export artifact proof, complete provider adapters, final anonymization/erasure, and comprehensive failure/concurrency/security tests.
- Disposable staging source/deploy serialization with the shared staging owner.
- Canonical staging provider credentials and fixtures for actual absence proof.
- Independent Cloud, Security, SRE, Steward, billing, and provider-owner review.
- No production deployment, migration, push, merge, or real-user deletion is authorized.
