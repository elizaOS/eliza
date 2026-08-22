# LifeOps email and calendar lane

Private, redacted ledger for the Gmail, Google Calendar, and Apple Calendar candidate. It contains no provider content, account identifiers, credential values, or private event/message data.

## Live supervised continuation — 2026-08-22

- Preserved candidate `421c15ddfba78e3d1b57b36b107614d252e1b380` and tag remain untouched.
- Initial continuation base: `bccb85b5407fd2b2704fe6fc4bae89ad0d8cf9b3`; latest fetched `origin/develop`: `3fa81c56a29c81236308a080b6d62ba00c2a4675`.
- Current-base worktree: `/Users/nubs/.codex/worktrees/lifeops-current-base-live-qa-20260822/eliza`.
- Current-base branch: `codex/lifeops-current-base-live-qa-20260822`.
- Replayed current-base head before this ledger edit: `25ff4ca308c5efdc1c14a7fc7fc63653b29ddd4d`.
- Preflight tag: `lifeops-current-base-live-qa-preflight-20260822`.
- All eleven preserved commits are exact `=` matches under `git range-diff`; old/new cumulative stable patch ID is `8a9052e3a6bde7650434ca6fa8534d602b14dd25`.
- Exact-source session: UI `http://127.0.0.1:43231/lifeops/connections`, API `127.0.0.1:43232`, isolated scratch state under `/Users/nubs/.codex/reports/lifeops-live-validation/2026-08-22-25ff4ca308-supervised/`.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, and supported model-provider settings are absent by name/presence-only process, project-env, and canonical-vault-audit inspection. No value was read or exposed.
- Git identity is `nubs <nubs@nubs.site>`; authenticated GitHub identity is `NubsCarson`.
- The Apple permission request reached the hash-matched existing EventKit dylib without rebuilding native code. macOS did not return within 10 seconds; the UI showed a retryable timeout while the TCC decision remains the user gate.
- Current-base focused proof: Personal Assistant Gmail adapter attribution plus complete/Unicode-safe model-facing previews, 2 files / 33 tests passed; Inbox attributable interaction blocks, 1 file / 34 tests passed; focused Biome checks clean.
- Fixed two current-base acceptance harness defects without changing provider behavior: production Gmail fixtures now implement the adapter's required message-detail surface, and stale tests no longer demand silent truncation of model-facing Gmail context. Inbox interaction tests now require attributable actions for every returned row rather than silently dropping the sixth.
- Latest upstream overlap is limited to an independent Personal Assistant relative-schedule fix. Reconciliation will preserve that upstream commit after this bounded checkpoint; the other new upstream commits do not touch Gmail, Google Calendar, Apple Calendar, or LifeOps connection paths.
- No Google redirect, provider read, send, calendar mutation, provider deletion, push, PR mutation, merge, or deployment has occurred.

### Current-base and supervised Apple acceptance continuation

- Rebased the twelve-commit LifeOps stack without conflicts onto fetched `origin/develop` at `cc387aaeef`; old/new `git range-diff` reports twelve exact `=` matches and both cumulative stable patch IDs are `461fb2ca8742717df08f5d989e3a108d3ccc8e0e`.
- Current rebased head before the exact-callback UX fix: `2ca396c0d7f4e154d35b4191a12a42ebde152f80`; branch was twelve ahead and zero behind at reconciliation time.
- Post-rebase proof: Personal Assistant Gmail attribution and complete Unicode-safe context, 33 tests passed; Inbox complete interaction choices, 34 tests passed; Google Workspace, Calendar, Inbox, and Native Calendar typechecks passed. Personal Assistant aggregate typecheck remains gated by unbuilt optional-workspace exports, not an in-lane diagnostic.
- Apple EventKit permission is now `full` in the exact-source app. A dedicated disposable calendar, `LifeOps QA 2026-08-22`, was created through Calendar without touching existing calendars.
- Empty seed receipt: 1 selected Apple source, 0 events, 0 duplicates, source `fresh`.
- External-edit seed receipt: 1 selected Apple source, 3 disposable events, 0 duplicates, source `fresh`; coverage includes one all-day event, one local-time DST-boundary event, and one recurring series, with zero attendees.
- Stable identity proof: three unique projection ids and three unique external ids; repeated sync, local-only purge, and re-seed all produced the same redacted identity digest `50aaf43ab7891dac0a9e6c4868c4b0fbb8e79c764ff677ba3c48e57db730f7b4`.
- Local purge receipt: 0 Gmail messages and 3 calendar events removed; provider data was unchanged. Re-seed restored exactly 3 events with no duplicate rows.
- Real Apple recurrence gate: Calendar reports 1 recurring rule in the disposable calendar, but the LifeOps feed reports 0 recurrence rules and no recurring event id. This confirms the preserved macOS EventKit serialization handoff remains required; `window-effects.mm` was not edited.
- Google connect fails closed before provider contact because protected OAuth settings are absent. The current UI exposed the wrong fixed-port callback example (`31437`); the provider validator now derives the exact served callback from the browser request origin. For this session it is `http://127.0.0.1:43231/api/connectors/google/oauth/callback`, with the focused callback tests, typecheck, and Biome clean.
- No Google redirect/provider access, email send, attendee invite, provider deletion, GitHub mutation, merge, signing, or deployment occurred.

### Final current-base refresh and supervised cleanup

- Rebased the thirteen-commit LifeOps implementation/test stack without conflicts onto fetched `origin/develop` at `37f92987eeddd06620ce6ba35c414a6caa56bc19`; pre-ledger head `707166fce42a9ba24f58c355869d9a3c24f2c906` is thirteen ahead and zero behind.
- Old/new `git range-diff` reports thirteen exact `=` matches. Both cumulative stable patch IDs are `02d330b3df2f616c82f307cdc0e8e2cc3d444390`.
- Current focused proof: deterministic LifeOps browser harness 48 scenarios passed; LifeOps connections component 7 tests passed; Inbox 26 files passed / 1 skipped with 226 tests passed / 2 skipped; Google Workspace 29 files and 328 tests passed. Google Workspace, Calendar, Inbox, and Native Calendar typechecks passed; focused Biome checks passed.
- App audit completed 226 of 227 tests. Every LifeOps, Calendar, and Inbox desktop/mobile/iPad layout passed. The only failing test is `test/ui-smoke/all-views-aesthetic-audit.spec.ts` for four pre-existing `builtin-settings` readability findings plus the `plugin-trajectory-logger-gui` iPad assertion; those Settings/trajectory surfaces are outside this lane.
- Apple cleanup is complete. The UI removed exactly 3 local calendar projections and reported that providers were unchanged; the three disposable events and dedicated `LifeOps QA 2026-08-22` calendar were then deleted, and an exact-name inventory check reports the target absent. No existing Apple calendar or event was changed.
- Google OAuth and provider access remain unstarted because the three protected OAuth settings are absent. No Gmail message was read or sent and no Google Calendar event was created, changed, or deleted.

### Publication checkpoint

- Clean current-base candidate `e9527804e3ce239d0505e570ad98f71e70c522e6` was pushed normally to `origin/codex/lifeops-current-base-live-qa-20260822`.
- Draft PR: `https://github.com/elizaOS/eliza/pull/24809`.
- Local annotated tag: `lifeops-current-base-supervised-publication-20260822`. The tag was not pushed.
- The draft PR records the exact focused proof and the protected-Google, native EventKit recurrence, unrelated aggregate app-audit, hosted CI/review, and deployment gates. It was not merged or deployed.
- Root `bun run verify` was attempted at PR head `c64470c50a4865fe79f8de6183504efc3f58ef7e` and stopped at `check:i18n`: seven locale catalogs are each missing roughly 1,100 existing source keys and `en.json` is missing 14 `connectorcard.*` keys. This PR changes none of the reported source/catalog paths or the checker, so the failure is a current-base repository baseline rather than a LifeOps regression; later verify stages did not run.

## Workspace and exact checkpoints

- Canonical candidate worktree: `/Users/nubs/.codex/worktrees/lifeops-current-develop-20260822/eliza`
- Branch: `codex/lifeops-current-develop-20260822`
- Final current-base reconciliation: `origin/develop` `c6a8c6a54ff096378244511d4863ec380de9e21c`
- Reconciled implementation head before this ledger update: `70dbbf1f42651574bccead9c72e81a735b59b5e7`
- Preserved source worktree remains clean at `/Users/nubs/.codex/worktrees/lifeops-ux-recovery-20260822/eliza`, branch `codex/lifeops-ux-recovery-20260822`, head `8334e48ccd02df17c199f86478fbe1e95b295809`.
- Preserved Gmail checkpoint: `6d9e558c23311bbd4ba2f2f4d555c1960f42210e`, tag `lifeops-gmail-sync-receipts-20260822`
- Preserved Apple/Calendar checkpoint: `a56941d8b285c2e45031aa7e2a6735ce0d73de37`, tag `lifeops-apple-calendar-provenance-20260822`
- Preserved overnight ledger: `0a325e37d98e11c69461470a4fdadaec024d9e32`, tag `lifeops-overnight-checkpoint-20260822`
- Shared contracts checkpoint: `8f89c8b38d146660e3bb3a176ddb7b305df02188`, tag `lifeops-connection-contracts-20260822`
- Provider-neutral backend checkpoint: `6a112ea122152d656c011f4590463a14c82de5c6`, tag `lifeops-connection-backend-20260822`
- Connection UI implementation head: `044eece51502c8a59fb82a70f16b4ceb75a88717`, tag `lifeops-connection-ui-20260822`
- Clean aggregate starting head for this acceptance pass: `24a49ebc24352a967e8e16bfc6438871f888bccd`
- Exhaustive local/browser recovery checkpoint: `e2454b40fae902124ad5430ede46ab121bf82128`, tag `lifeops-connections-local-qa-20260822`
- Gmail account-isolation recoverability checkpoint before the final rebase: `f3ca6093e776667be7740191050254895b3890fe`, tag `lifeops-gmail-account-isolation-20260822`; its final rebased patch-equivalent commit is `70dbbf1f42651574bccead9c72e81a735b59b5e7`.
- Final current-base commit map, in order: `157f88ce8d`, `273d973085`, `3985913c43`, `91fc92b63e`, `4639652e47`, `94a51275fd`, `4d4102e695`, `f05dec686b`, `f524581bd8`, `70dbbf1f42`.
- `git range-diff` reports eight preserved implementation/ledger commits as exact `=`, the provider-neutral backend as the same LifeOps patch with only upstream Signal-to-iMessage import context, and the account-isolation change as the new tenth commit.
- `packages/app-core/platforms/electrobun/native/macos/window-effects.mm` is byte-for-byte unchanged by this lane.
- No push, PR mutation, merge, deployment, OAuth consent, native permission prompt, or real provider mutation occurred.

## Ownership slices

| Slice | Commit | Owned result |
| --- | --- | --- |
| Shared contracts | `8f89c8b38d` | Explicit Gmail History health, calendar source/change-delivery health, stable provider provenance, and provider-safe imported-data purge receipts |
| Provider-neutral backend | `6a112ea122` | Durable Gmail/calendar projections, bounded resync and purge paths, source selection, exact-account identity, retries, and partial-failure receipts |
| Connection UI/tests/docs | `044eece515` | Focused first-five-minutes and ongoing-management surface, no-provider browser harness, view registration/bundle, component tests, and contributor documentation |
| Local/browser recovery | `e2454b40fa` | Multi-account isolation, Apple-only seeding, permission/settings recovery, destructive-dialog focus safety, count-aware receipts, and exhaustive deterministic browser scenarios |
| Gmail account identity hardening | `70dbbf1f42` | Account-scoped projection, unified-inbox cache, and thread identities while retaining raw provider IDs for confirmed effects; includes real-PGlite multi-account proof |
| macOS native handoff | Existing bounded artifact | `plugins/plugin-calendar/docs/MACOS_EVENTKIT_PROVENANCE_CONTRACT.md`; native implementation remains with the macOS owner |

## Current capability matrix

Legend: deterministic means fixture/unit/integration/local-browser evidence. Real means current provider or physical-device evidence captured in this lane.

| Area | Candidate behavior | Deterministic | Real | Remaining gate |
| --- | --- | --- | --- | --- |
| Google connection | Account-aware connector status; explicit identity scopes and separately selectable Gmail read/draft/send/manage plus Calendar read/write capabilities; least-effect defaults | Yes | No | Real chooser, consent/MFA if requested, callback, protected-token read-back, refresh, and revoke |
| Account/calendar selection | Active Google account selector; per-source Google and Apple Calendar selection with stable provider/account/calendar provenance | Yes | No | Real multi-account and device-calendar inventory |
| Bounded seeding | Owner chooses 7, 30, or 90 days; progress phases and final message/event/source/duplicate counts are visible | Yes | No | Real bounded provider counts using disposable data |
| Gmail ongoing sync | History cursor presence/mode, cache count, last sync, resync reason, retryable partial failures, and explicit refresh | Yes | No | Real restart, expired History cursor, revocation, and quota recovery |
| Calendar ongoing sync | Per-source freshness, polling/channel health, last success, retryable partial failures, and source-preserving refresh | Yes | No | Real token expiry, webhook loss, EventKit store change, DST, recurrence, and conflicts |
| Drafts and mutations | UI explains that drafting never sends and proposing never creates; send/manage/calendar-write capabilities default off; effect paths require fresh confirmation and provider receipts | Yes | No | Explicitly approved disposable provider acceptance; no real send or event mutation was run |
| Apple permissions | EventKit purpose, granted/denied/restricted/unavailable states, request path, and System Settings recovery | Yes | No | Packaged macOS plus simulator/physical-device permission acceptance |
| Provenance and dedup | Exact provider/account/calendar/external/recurrence identities; Google surfaced through Apple remains read-once/write-once; no title/time fuzzy merge | Yes | No | Real overlap case and macOS serializer parity |
| Disconnect/purge/reconnect | Disconnect preserves imported projection; purge is separately confirmed and returns `providerMutation: false`; reconnect clears stale grants and reuses stable identities without duplicate counts | Yes | No | Real revoke/reconnect plus disposable imported-data verification |
| Responsive/accessibility | Desktop and 390px mobile layouts, no horizontal overflow, 44px mobile buttons, semantic dialogs/controls, visible errors, reduced-motion handling | Yes | No | VoiceOver, Dynamic Type, packaged-app keyboard/focus, and physical touch review |

## Done

- Recovered and preserved the existing implementation rather than replacing it.
- Reconciled the preserved three-commit checkpoint chain onto the then-current `origin/develop` in an isolated worktree.
- Split the recovery diff into tagged contracts, backend, and UI checkpoints.
- Added one focused `/lifeops/connections` surface without duplicating Inbox, Calendar, Auth login, or shared general connector UI.
- Added explicit OAuth scope/capability explanation and safe read/draft defaults.
- Added Google account and cross-provider calendar selection, bounded seed range, progress, counts, cursor/source health, partial failure, retry, and denied-permission recovery.
- Added separate disconnect and imported-data purge confirmations with honest non-provider-mutation receipts.
- Added provenance/dedup explanation and deterministic disconnect/reconnect/no-duplicate acceptance.
- Added a real-Chromium no-provider harness on isolated port 41873 with temporary state/evidence outside the repository.
- Corrected cross-account calendar selection so changing the active Google account cannot seed a hidden calendar from another account.
- Enabled bounded Apple-only calendar seeding with a truthful null Google grant and an explicit no-Gmail request.
- Converted Apple permission and System Settings launch failures into visible, retryable UI states without unhandled browser errors.
- Hardened destructive confirmation dialogs with Cancel-first focus, a keyboard focus trap, Escape cancellation, prior-focus restoration, and exact-account/provider titles.
- Added count-aware source and duplicate-delivery receipt grammar.
- Physically inspected final desktop initial, Apple-only seeded, disconnected, and 390px mobile captures.
- Documented the exact supervised live-provider acceptance sequence in `plugins/plugin-personal-assistant/docs/LIFEOPS_LIVE_VALIDATION.md`.
- Preserved the macOS EventKit provenance contract and left the owned native bridge unchanged.
- Reconciled all preserved LifeOps commits onto current `origin/develop` without conflict and proved patch identity with `git range-diff`.
- Corrected a real multi-account Gmail collision: identical provider message/thread IDs from different Google accounts now remain distinct in durable projections and unified Inbox caches, while provider mutation references remain raw and usable.
- Tightened the legacy/rich Gmail mapper union so the package-wide Personal Assistant typecheck is clean on the current compiler.
- Inspected canonical credential locations by presence only. No Google OAuth environment configuration or canonical default provider state was discoverable; no token, credential, provider message, or event value was read or printed.

## Verification evidence

- Final current-base no-provider browser acceptance: 48/48 assertions passed in real headless Chromium.
  - Covered partial source failure, Gmail History health, every Apple permission state, bounded seed/count receipts, retry recovery, provider-safe purge, disconnect/reconnect/no duplicates, drafts versus effects, multi-account isolation, Apple-only seed, capability defaults, injected load/seed/calendar/permission/settings/purge/disconnect/connect failures, zero uncaught page errors, 390px overflow, and 44px touch targets.
  - Final exact-head redacted temporary captures: `/var/folders/h3/hz68shz96gz0h9lnyctghppc0000gn/T/eliza-lifeops-e2e-AXvMRC`
- Direct capture inspection confirmed account/calendar/scope selection, 7/30/90-day bounds, seed counts, cursor/source health, Apple denied/fresh states, local purge receipts, disconnected state, provider-safe dedup copy, and a clean 390px mobile layout.
- Focused current-base UI/registration/Gmail boundary Vitest: 6 files, 43 tests passed.
- Real local PGlite account-isolation integration: 1 file, 2 tests passed.
- Inbox package lane: 26 files passed, 1 skipped; 225 tests passed, 2 skipped.
- Google Workspace package lane: 29 files, 326 tests passed.
- Calendar package unit lane: 67 files passed, 2 skipped; 645 tests passed, 4 skipped.
- Calendar deterministic integration lane through the repository integration config: 3 files, 24 tests passed.
- Native Calendar bridge lane: 3 files, 28 tests passed.
- Personal Assistant, Inbox, Google Workspace, Calendar, and native Calendar typechecks, Biome checks, and production builds passed.
- Personal Assistant production build passed, including the 36.26 kB focused view bundle and declaration emission.
- Inbox built a 10.29 kB view bundle; Calendar built a 25.81 kB view bundle.
- Repository CLAUDE/AGENTS parity passed for all 161 tracked pairs.
- App audit passed: 227 tests passed; 224 views reviewed, 211 verified, 0 broken, 0 needs-work, and 13 audit entries left for human eyeballing; final LifeOps desktop/mobile captures were manually inspected separately.
- `git diff --check` passed before each scoped commit.
- No test or harness contacted Google, Gmail, Google Calendar, Apple Calendar, OAuth, or a native permission surface.

## Known non-scoped repository baselines

- The six-scenario deterministic LifeOps scheduling spine is not usable as acceptance on this base: all six failed on shared runtime/fixture drift, including an expired mock Google grant, missing deterministic evaluator fixtures, missing delivery observations, and scheduled-task quarantine. The run was stopped only after all six scenarios had completed and emitted its checkpoint summary. This is separate from the green Gmail/Calendar connector fixture suites above.
- Gmail and Calendar corpus scenarios are intentionally `live-only` and credential-gated; the scenario runner correctly excludes them from `pr-deterministic`. They remain part of supervised provider acceptance, not local proof.

## Doing

- Keep draft PR `#24809` unmerged while the external/provider gates below remain open.
- Resume supervised Google acceptance only after the protected OAuth settings are installed; pause for the user's chooser/consent/password/MFA action.

## Next: true external gates only

- Provision `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and isolated `GOOGLE_REDIRECT_URI` through a protected route; then user completes account chooser/consent/password/MFA for `nubs@nubs.site` at the action-time grant boundary.
- User-supervised Google chooser/consent/password/MFA, followed by explicitly confirmed disposable self-mail and dedicated Google Calendar effects and cleanup only of session-created artifacts.
- Token/cursor expiry, offline/reconnect, partial failure, dedupe, disconnect/purge/reconnect, and exact receipt acceptance.
- macOS owner implementation and review of the preserved EventKit recurrence/exception serialization contract, followed by packaged exact-head Apple recurrence acceptance.
- iOS simulator/physical-device EventKit permission, external-edit, recurrence, timezone/DST, and reconnect acceptance.
- macOS owner correction of EventKit recurrence/exception serialization and packaged validation; this lane's Apple disposable data is already cleaned up.
- Hosted CI/reviewer acceptance and any later signing or deployment authorization. Merge, signing, and deployment remain prohibited.

## Concrete user action now

- Provide `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` through the canonical protected settings route and set `GOOGLE_REDIRECT_URI` exactly to `http://127.0.0.1:43231/api/connectors/google/oauth/callback`. Then click **Continue to Google** at `http://127.0.0.1:43231/lifeops/connections` and perform the account chooser/consent/MFA clicks when prompted. Do not paste any secret into chat.
