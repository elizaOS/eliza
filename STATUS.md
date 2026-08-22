# LifeOps email and calendar lane

Private, redacted ledger for the Gmail, Google Calendar, and Apple Calendar candidate. It contains no provider content, account identifiers, credential values, or private event/message data.

## Workspace and exact checkpoints

- Worktree: `/Users/nubs/.codex/worktrees/lifeops-ux-recovery-20260822/eliza`
- Branch: `codex/lifeops-ux-recovery-20260822`
- Reconciliation merge: `2147c2f0ccdc69a97ca3b93b468d56b1641e0494`
- `origin/develop` reconciled at recovery time: `6d5ce29a5e45ba7b0cd6957349f71e5c2a141fc4`
- Preserved Gmail checkpoint: `6d9e558c23311bbd4ba2f2f4d555c1960f42210e`, tag `lifeops-gmail-sync-receipts-20260822`
- Preserved Apple/Calendar checkpoint: `a56941d8b285c2e45031aa7e2a6735ce0d73de37`, tag `lifeops-apple-calendar-provenance-20260822`
- Preserved overnight ledger: `0a325e37d98e11c69461470a4fdadaec024d9e32`, tag `lifeops-overnight-checkpoint-20260822`
- Shared contracts checkpoint: `8f89c8b38d146660e3bb3a176ddb7b305df02188`, tag `lifeops-connection-contracts-20260822`
- Provider-neutral backend checkpoint: `6a112ea122152d656c011f4590463a14c82de5c6`, tag `lifeops-connection-backend-20260822`
- Connection UI implementation head: `044eece51502c8a59fb82a70f16b4ceb75a88717`, tag `lifeops-connection-ui-20260822`
- Clean aggregate starting head for this acceptance pass: `24a49ebc24352a967e8e16bfc6438871f888bccd`
- Exhaustive local/browser recovery checkpoint: `e2454b40fae902124ad5430ede46ab121bf82128`, tag `lifeops-connections-local-qa-20260822`
- The annotated local-QA tag resolves to the implementation head above. This ledger is the immediate follow-on documentation checkpoint.
- `packages/app-core/platforms/electrobun/native/macos/window-effects.mm` is byte-for-byte unchanged by this lane.
- No push, PR mutation, merge, deployment, OAuth consent, native permission prompt, or real provider mutation occurred.

## Ownership slices

| Slice | Commit | Owned result |
| --- | --- | --- |
| Shared contracts | `8f89c8b38d` | Explicit Gmail History health, calendar source/change-delivery health, stable provider provenance, and provider-safe imported-data purge receipts |
| Provider-neutral backend | `6a112ea122` | Durable Gmail/calendar projections, bounded resync and purge paths, source selection, exact-account identity, retries, and partial-failure receipts |
| Connection UI/tests/docs | `044eece515` | Focused first-five-minutes and ongoing-management surface, no-provider browser harness, view registration/bundle, component tests, and contributor documentation |
| Local/browser recovery | `e2454b40fa` | Multi-account isolation, Apple-only seeding, permission/settings recovery, destructive-dialog focus safety, count-aware receipts, and exhaustive deterministic browser scenarios |
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

## Verification evidence

- Final no-provider browser acceptance: 48/48 assertions passed in real headless Chromium.
  - Covered partial source failure, Gmail History health, every Apple permission state, bounded seed/count receipts, retry recovery, provider-safe purge, disconnect/reconnect/no duplicates, drafts versus effects, multi-account isolation, Apple-only seed, capability defaults, injected load/seed/calendar/permission/settings/purge/disconnect/connect failures, zero uncaught page errors, 390px overflow, and 44px touch targets.
  - Redacted temporary captures: `/var/folders/h3/hz68shz96gz0h9lnyctghppc0000gn/T/eliza-lifeops-e2e-tTOShh`
- In-app Browser inspection against the rebuilt isolated fixture confirmed exact second-account seed provenance, exclusion of the first account's hidden calendar, Apple-only `grantId: null`, Cancel-first modal focus/trap/Escape behavior, visible seed-failure recovery, no page errors, and a clean 390x844 layout.
- Focused UI/registration/boundary Vitest: 4 files, 27 tests passed.
- Focused provider-neutral backend/component/boundary Vitest: 6 files, 50 tests passed.
- Calendar package unit lane: 67 files passed, 2 skipped; 645 tests passed, 4 skipped.
- Calendar integration lane through the repository integration config: 2 files, 18 tests passed.
- Personal Assistant production build passed, including the 36.26 kB focused view bundle and declaration emission.
- Focused production connection UI TypeScript check passed with no diagnostics.
- Biome passed all 15 changed TypeScript/TSX/MJS/JSON source files with no fixes.
- Repository CLAUDE/AGENTS parity passed for all 160 tracked pairs.
- App audit passed: 227 tests passed; 224 views reviewed, 211 verified, 0 broken, 0 needs-work, and 13 audit entries left for human eyeballing; final LifeOps desktop/mobile captures were manually inspected separately.
- `git diff --check` passed before the UI commit.
- No test or harness contacted Google, Gmail, Google Calendar, Apple Calendar, OAuth, or a native permission surface.

## Known non-scoped repository baselines

- The package-wide Personal Assistant typecheck continues to report pre-existing diagnostics in unrelated browser, Signal, and legacy Google delegate modules. The focused production connection UI typecheck is green.
- A broad Personal Assistant suite was intentionally stopped after unrelated existing brief/fuzz/connector/anticipation/register failures appeared. The exact owned test selection above is green and is the acceptance gate for this bounded checkpoint.
- These baselines were not expanded into this lane and do not invalidate the focused connection candidate.

## Doing

- No safe local implementation or browser-fixture work remains in the bounded Gmail/Google Calendar/Apple Calendar acceptance scope.

## Next: true external gates only

- Real Google account chooser/consent/MFA, callback, token refresh/revoke, and protected credential-store read-back.
- Explicitly approved disposable Gmail and Google Calendar acceptance; sending mail or changing provider events remains prohibited until that approval.
- Packaged macOS Apple Calendar permission/recovery and macOS owner implementation of the preserved EventKit serialization contract.
- iOS simulator/physical-device EventKit permission, external-edit, recurrence, timezone/DST, and reconnect acceptance.
- Hosted reviewer/CI, draft PR, signing, and deployment gates; no push, PR, merge, signing, or deployment is authorized here.

## Concrete user action now

- None. The local deterministic candidate is complete. The next action is only needed when the user chooses to supervise a real Google chooser/MFA or Apple permission prompt, or authorizes hosted review/deployment work.
