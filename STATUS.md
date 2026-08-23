# Account deletion lifecycle status

Updated: 2026-08-23 (America/Los_Angeles)

## Done

- Preserved sealed candidate `d6131f9c36d3d0528118132caa822211014663dd` and tag `account-deletion-authoritative-backup-fence-20260822` untouched in `/Users/nubs/.codex/worktrees/account-deletion-current-tip-20260822/eliza`.
- Created isolated current-base worktree `/Users/nubs/.codex/worktrees/account-deletion-current-base-20260823/eliza` on branch `codex/account-deletion-current-base-20260823`.
- Rebased the smallest code series onto `origin/develop@f43ecfe0679038579f291e003ef2820678970e06`; code head before this ledger commit is `b243045d62bd5dea37189b737dffce195d47e255`.
- Preserved merged #24256 (`a224539647c1f61663a928fc249ea6450625095c`) tenant-scoped fail-closed behavior and merged #24803 (`e9e441d307e8890478a92b3cc19e4e1cb989943d`) runtime receipt validation, while superseding their unavailable-only state with the authoritative lifecycle.
- Replayed 17 code commits from the sealed candidate and intentionally omitted its 14 historical `STATUS.md`-only commits. Added two current-base compatibility commits: tenant-scoped primary receipt reads plus strict DTO/state validation, and the 219-edge schema ratchet.
- Renumbered the deletion migration tail append-only after upstream `0305`-`0309`: `0310_account_deletion_lifecycle_authority` (journal idx 293), `0311_account_deletion_phase_receipts` (294), `0312_account_deletion_exports` (295), and `0313_account_deletion_canceling_state` (296). Historical `0276_account_deletion_requests` remains intact.
- Reconciled the only final-base conflict in `auto-top-up.ts`: retained upstream Unicode-safe error handling and the deletion lifecycle/revision checks before Stripe.
- Classified all 219 direct user/organization foreign keys with a fail-closed digest (`8a6994f84435d169a0efd2c105b18782e9b3b3dae3fb02e7f63b30addbfb183b`): 69 external reconciliation, 10 shared transfer, 50 retained/anonymized, and 90 private cascade edges. The four current-base additions are `remote_hosts` and `remote_command_envelopes` user/org cascade edges.
- Regenerated the API router at 702 routes / 127 shards / 0 unconverted; regeneration is clean.
- No push, deployment, hosted mutation, production migration, provider call, real deletion, or GitHub mutation was performed.

## Recomposition identity

- `git range-diff c6a8c6a54f..d6131f9c36 origin/develop..b243045d62` maps all 17 code commits: 9 patch-identical and 8 current-base adaptations. The omitted entries are historical ledger-only commits; the two new entries are the explicit #24256/#24803 compatibility and schema-ratchet commits.
- The authoritative spool and backup adapter implementation plus lost-response tests are byte-for-byte identical to `d6131f9c36`:
  - `packages/cloud/shared/src/lib/services/account-deletion-provider-adapters.ts`
  - `packages/cloud/shared/src/lib/services/account-deletion-provider-adapters.test.ts`
- `packages/cloud/api/cron/process-account-deletions/route.ts` is also byte-for-byte identical. Expected deltas in authenticated route/service files are limited to organization-scoped primary receipt lookup and current runtime DTO validation.
- Added-line secret-pattern scan found no private-key, live-token, AWS-key, or password-assignment candidates.

## Shared ownership audit

- Shared staging owner remains separate at `/Users/nubs/Documents/ChatGPT/eliza/work/eliza-shared-agent-staging-owner-current-20260822` (`5be2d8df...` at audit); it owns staging serialization and was not modified.
- Current Shared grounding worktree `/Users/nubs/Documents/ChatGPT/eliza/work/eliza-shared-agent-grounding-current-20260823` (`02eef891...` at audit) and open PR #24779 did not touch account-deletion paths.
- PR #25306, which overlapped `migrate-with-diagnostics.ts` and its release-barrier test, is now closed unmerged. This candidate preserves its own deletion migration-barrier logic; landing review must still compare any successor before composition.
- Security issue #23098 remains open and unassigned. No duplicate PR was opened and no other branch was mutated.

## Tests and evidence

- Pinned install: pass (`bun install --frozen-lockfile`, 6,893 packages).
- Current-base core build: 60/60 tasks pass.
- Current-base typechecks: Cloud shared, Cloud API (including Worker dry-run), Cloud e2e, Cloud test-mocks, and UI pass.
- Current-base post-conflict rerun: 122/122 pass across auto-top-up (72), full-schema FK policy (3), lifecycle service (13), backup/spool provider authority (9), PGlite reservation/undo/atomic erasure (11), and migration release barrier (14).
- Focused lifecycle matrix on the same recomposed series before the final non-deletion upstream rebase: saga 3/3, encrypted export 7/7, resource purge 5/5, lifecycle authority 2/2, domain renewal 1/1, provisioning fence 3/3, migration authority 4/4, authenticated API 5/5, public request API 6/6, public export API 3/3, UI DTO parser 8/8, cancellation dialog 1/1, public deletion page 2/2, and Android policy contract 3/3 (59 assertions).
- Full app visual audit: 223/227 captures pass. Four unrelated baseline failures remain: `plugin-cloud-gui` never mounts an active lifecycle slot in four viewports; the audit also reports the unchanged settings index missing its declared `Settings` semantic header. No deletion-owned file controls either failure.
- Dedicated Cloud visual audit: account-deletion desktop and mobile both pass; 96/101 overall pass with one skipped. Unrelated baseline failures are `cloud-agents` desktop/mobile missing fixture `Smoke Agent`, and `auth-bridge` desktop/mobile redirecting to `/chat` instead of `/`.
- App-core aggregate typecheck remains blocked by unrelated current-base failures: agent recent-conversation optional timestamps, stale server-security test arities, and missing native Capacitor package declarations/unknown bridge responses. The deletion policy contract itself passes 3/3.
- `git diff --check` and targeted Biome checks pass.

## Doing

- Local current-base recomposition is complete. Keep the worktree clean and parked at the local authority-fence tag; do not expand architecture or mutate hosted state.

## Next / external gates

1. Shared staging owner must select the exact local tag and serialize an isolated non-production deployment; this lane must not dispatch a competing Cloud release.
2. SRE/Cloud must provide disposable database and object-store fixtures plus canonical injected backup/spool authorities. Absence must be proved from both stores and every provider boundary; missing authority remains `BACKUP_SPOOL_AUTHORITY_UNAVAILABLE`.
3. Run the disposable hosted acceptance matrix: authenticated and public request, export/download, cancel/reactivation, shared-owner transfer/exit, provider failure/lost-response reconciliation, recovery expiry, final database erasure, post-session status, and verified absence. Never repeat an uncertain destructive provider call; reconcile by inspection.
4. Resolve or baseline the unrelated app/cloud audit failures before repository-wide visual closure.
5. Obtain Cloud, Security, SRE, Steward, billing, compute, storage/backup, connector, voice, domain, Vault/key, and GitHub/repository owner review.
6. Only after hosted receipts and review: prepare publication/rollback metadata and Android contract handoff. No production deploy, migration, push, merge, real-user deletion, or Google Play acceptance claim is authorized here.

## Stable server contract

- Authenticated request/status: `GET|POST /api/v1/me/account-deletion` with recent-auth, exact `DELETE` confirmation, origin protection, tenant-scoped primary receipt lookup, and 202 acceptance only after atomic reservation.
- Public request/status/cancel: `POST /api/public/account-deletion`, `/status`, and `/cancel`, using distinct opaque status/recovery capabilities; credentials are never query-parameter proof.
- Export: `/api/public/account-deletion/export` uses the status capability and generation-fenced encrypted receipt/download contract.
- Cancellation is nonterminal `canceling` while provider reactivation reconciles: `accessState=fenced`, `canCancel=false`, `nextAction=wait_for_reconciliation`. Only terminal `canceled` restores `accessState=active`, `canCancel=false`, `nextAction=none`; sessions and API keys remain revoked and require fresh authentication.
