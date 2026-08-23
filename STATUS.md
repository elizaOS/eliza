# LifeOps email and calendar lane

Private, redacted ledger for the Gmail, Google Calendar, and Apple Calendar candidate. It contains no provider content, account identifiers, credential values, or private event/message data.

## Current checkpoint — 2026-08-23

- Reconciliation worktree: `/Users/nubs/.codex/worktrees/lifeops-pr24809-reconcile-20260823/eliza`
- Branch: `codex/lifeops-pr24809-reconcile-20260823`
- Preserved reviewed PR head: `48febe9553787c62db7f045287ad9eaef5716eea`
- Preserved local acceptance head: `fa638da16bfbee0637775b293da2b49f60f04ace`, tag `lifeops-google-oauth-authority-audit-20260823`
- Current `origin/develop` merged without conflict: `beeaa92f7f50759ffec1dc2a6014c3d7ec1f28e3`
- Review-fix commit: `fce5adfebe4151dc4949de9b9927c6949d658730`
- Reconciled code head before this ledger update: `640841cbb0bdff015d70ec0c5c6ba0feeacb2707`
- Recoverable publication ref: local annotated tag `lifeops-pr24809-reconciled-20260823`; the original remote branch is updated only by normal fast-forward push and must resolve to the same tagged ledger checkpoint.
- Git author: `nubs <nubs@nubs.site>`
- The macOS native owner file `packages/app-core/platforms/electrobun/native/macos/window-effects.mm` was not edited.

## Drift and review reconciliation

- `git range-diff` proves the 21 LifeOps implementation/test/ledger commits through the published recovery checkpoint are exact `=` patch matches between the preserved local line and PR #24809. The three later local-only commits are protected-provider ledger updates; their current truth is consolidated here.
- The reviewed PR history remains an ancestor of the candidate. Current `develop` also remains an ancestor. No rebase, reset, force-push, or review-history rewrite was used.
- PR #24809 is closed/draft with `CHANGES_REQUESTED`; reviewer `lalalune` closed it after the prior cancelled static-smoke run. The branch can be updated normally, but the PR must not be reopened without reviewer direction.
- GitHub retains the closed PR's displayed head at its closure commit even after the underlying same-repository branch advances. The updated branch preserves every reviewed commit; no replacement PR was opened.
- Closed the four actionable review gaps: authoritative calendar source validation, byte-preserving opaque Gmail continuation tokens, all-or-nothing Gmail seed promotion with its History cursor, and fail-closed Google revocation plus protected credential cleanup with resumable partial-failure handling.
- Added the canonical database/runtime credential-ref deletion contract, in-memory and SQL implementations, and a real PGlite atomic rollback proof.

## Protected Google configuration truth

- Railway CLI authentication and agent-tooling preflight are healthy for the authorized `nubs` account. Prior names-only discovery found the matching Google client configuration in the authorized Eliza infrastructure; no value is recorded here.
- The protected composition remains preserved at `/Users/nubs/.codex/worktrees/lifeops-oauth-current-develop-20260823/eliza`, head `2bf9125bfe2d39b4e7110c450dfea51eafd8dc28`, tag `lifeops-google-client-bound-20260823`.
- That composition stored `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` in the canonical encrypted Vault and persisted only `vault://` references. Protected read-back matched in memory; no plaintext was printed, committed, or written to this ledger.
- Read-only Chrome verification used the `elizalabs.ai` profile and confirmed the signed-in `nubs@elizalabs.ai` account, the `ElizaCloud` project, and one enabled web OAuth client.
- The client contains existing Eliza-hosted callbacks plus localhost port `3000`, but it does not contain the isolated callback `http://127.0.0.1:43231/api/connectors/google/oauth/callback`.
- The Google Cloud client page is preserved as a handoff. Adding that callback and saving changes persistent OAuth access, so the save remains an action-time user-confirmation gate.
- No Google account chooser, consent, password, MFA, OAuth grant, Gmail read/send, or Google Calendar read/write occurred in this reconciliation.

## Capability matrix

| Area | Current candidate | Deterministic proof | Real-provider status | Remaining gate |
| --- | --- | --- | --- | --- |
| Google connection | Account-aware OAuth, explicit scopes/capabilities, protected credentials, reconnect and revoke | Yes | Configuration discovered and protected binding preserved; grant not started | Save exact isolated callback, then chooser/consent/MFA |
| Gmail seed and sync | Bounded 7/30/90 seed, opaque page tokens, durable History cursor, expired-cursor resync, account-scoped identity | Yes | Not exercised against provider in this checkpoint | Disposable self-account seed and incremental sync |
| Gmail effects | Draft is distinct from send; confirmed send/manage actions return provider receipts | Yes | No live send or mailbox mutation | Fresh action-time confirmation for disposable self-mail |
| Google Calendar | Account/calendar selection, bounded seed, sync token recovery, recurrence/timezone/provenance, confirmed mutations | Yes | Not exercised against provider in this checkpoint | Disposable calendar and explicitly confirmed effects |
| Apple Calendar | EventKit permission/source selection, bounded seed, provenance and Google-through-Apple dedup | Yes | Prior Full Access and disposable read/seed evidence preserved | Native recurrence/exception serializer parity and packaged recheck |
| Disconnect/purge/reconnect | Provider revoke precedes watch cleanup, Vault purge, ref deletion and account deletion; partial cleanup resumes without double revoke | Yes | Not exercised against provider | Disposable revoke/reconnect acceptance |
| Failure receipts | Partial seed never promotes; retry/rate/cursor failures remain explicit; audit counts are de-duplicated and truthful | Yes | No live quota/revocation fault injection | Supervised provider failure acceptance |
| UI and accessibility | One LifeOps connections surface with selection, seed progress/counts, health, retries, confirmations and recovery | Yes, from preserved browser/app evidence | Exact-source provider flow not resumed here | Callback save, isolated restart, chooser boundary, packaged/device review |

## Verification evidence

- Core connector storage: 1 focused file, 14 tests passed.
- Google Workspace review proof: 2 files, 12 tests passed.
- Calendar authoritative seed proof: 1 file, 5 tests passed.
- Personal Assistant Gmail seed proof: 1 file, 17 tests passed.
- Real PGlite Gmail account isolation and atomic seed/cursor proof: 1 file, 4 tests passed.
- Typechecks passed for Core, SQL, Google Workspace, Calendar, and Personal Assistant after the final `develop` merge.
- Biome passed on all 18 review-fix files; `git diff --check` passed.
- Repository guide parity passed for all 161 tracked CLAUDE.md/AGENTS.md pairs. Root `bun run verify` was attempted and stopped before code checks at `check:biome-version` because this recovery worktree's sparse checkout omits `packages/auth/package.json`; this is a checkout-materialization gate, not a LifeOps diagnostic.
- The focused tests use deterministic fixtures or local PGlite only. They are not represented as real-provider acceptance.

## Done

- Preserved both divergent checkpoints and proved the published LifeOps patch identity.
- Merged action-time current `origin/develop` normally without losing reviewed commits.
- Fixed and tested every actionable code-review finding in the Gmail/Calendar lane.
- Kept provider mutation, native macOS ownership, deployment, and merge boundaries intact.
- Reconfirmed the correct `elizalabs.ai` Chrome profile and exact missing callback without reading or revealing secret material.

## Doing

- Keep the candidate clean and recoverable, publish only by normal fast-forward branch update, and retain the closed PR/reviewer history.
- Hold Google OAuth before the persistent callback save and subsequent account chooser/consent/MFA boundaries.

## Next

1. User confirms the exact Google Cloud callback edit. Add `http://127.0.0.1:43231/api/connectors/google/oauth/callback` to the existing web client and click **Save**.
2. Restart the isolated LifeOps runtime so the preserved Vault references hydrate, verify readiness by names/status only, and open `http://127.0.0.1:43231/lifeops/connections`.
3. Drive Google connect to the account chooser. The user chooses `nubs@elizalabs.ai` and completes any consent/password/MFA prompt.
4. With fresh action-time confirmation, run only disposable self-mail and dedicated disposable-calendar acceptance, then verify incremental sync, dedup, revoke/reconnect and cleanup receipts.
5. Route the preserved EventKit recurrence/exception serialization contract to the macOS owner; then run packaged macOS and iOS permission/provider acceptance.
6. Obtain reviewer/hosted CI acceptance. Do not merge or deploy from this lane.

## Concrete user action now

In the Chrome profile named **elizalabs.ai**, use the preserved tab titled **Client ID for Web application – Google Auth Platform – ElizaCloud**. Confirm here that I may add exactly `http://127.0.0.1:43231/api/connectors/google/oauth/callback` under **Authorized redirect URIs** and click **Save**, or make that one edit yourself and reply **callback saved**. Do not paste any client value, secret, or MFA code into chat.
