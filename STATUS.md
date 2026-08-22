# LifeOps email and calendar lane

Private checkpoint for the Gmail, Google Calendar, and Apple Calendar product audit. This file contains no provider content, account identifiers, credentials, or secret values.

## Workspace and checkpoints

- Worktree: `/Users/nubs/.codex/worktrees/a428/eliza`
- Branch: `codex/lifeops-email-calendar-20260822`
- Action-time base: `e40d0ae27296741bf75f663235cb4633d07b9d28` (`origin/develop` when the isolated worktree was created)
- Gmail checkpoint: `6d9e558c23311bbd4ba2f2f4d555c1960f42210e`, tag `lifeops-gmail-sync-receipts-20260822`
- Apple/Calendar checkpoint: `a56941d8b285c2e45031aa7e2a6735ce0d73de37`, tag `lifeops-apple-calendar-provenance-20260822`
- `origin/develop` advanced by one commit after these checkpoints. No rebase, push, merge, deploy, OAuth consent, or provider mutation was performed during the overnight closeout.
- Dirty/shared checkouts were inspected read-only and left untouched.
- `packages/app-core/platforms/electrobun/native/macos/window-effects.mm` has no LifeOps diff.

## Existing implementation and history

- `plugins/plugin-google-workspace` is the canonical account-scoped Google connector: OAuth, protected credential references, Gmail, and Google Calendar provider APIs.
- `plugins/plugin-calendar` owns the unified calendar read model, provider synchronization, selection, mutation gateway, and source health.
- `plugins/plugin-native-calendar` owns the iOS EventKit permission/CRUD bridge and the shared macOS EventKit bridge policy.
- `plugins/plugin-inbox`, `plugins/plugin-personal-assistant`, and `plugins/plugin-scheduling` own the unified inbox, LifeOps composition/confirmation/audit behavior, and scheduled-item architecture respectively.
- The superseded experiment `origin/feat/google-personal-mcp-only` at `cb7a81569b` replaces the local Google connector with an official-MCP control plane; it was not copied or revived.
- `plugins/plugin-personal-assistant/docs/LIFEOPS_LIVE_VALIDATION.md` remains the historical acceptance script and states that real account-backed evidence is outstanding.
- No separate local-only LifeOps/Gmail/Calendar plugin was found. The maintained first-party plugins above are the user-created/product implementation that was preserved and extended.

## Current capability matrix

Legend: deterministic means fixture/static/integration-backed local evidence; real means current provider/device evidence captured in this lane.

| Area | Current implementation | Deterministic | Real | Remaining acceptance boundary |
| --- | --- | --- | --- | --- |
| Google OAuth | PKCE/state plus per-flow OIDC nonce; capability-derived least-privilege scopes; server-side token exchange and canonical credential writer | Yes | No | Account chooser, consent, refresh, revoke, and protected-store read-back on a real account |
| Gmail seed/read | Bounded search/triage seed, paginated provider reads, canonical message/thread projection, attachment metadata | Yes | No | User-facing date/folder selection, resumable seed progress, provider account evidence |
| Gmail incremental sync | Durable History cursor, fixed multi-page `startHistoryId`, label refresh, tombstones, repeated-token guard, typed expired-cursor bounded resync | Yes | No | Scheduled health presentation, restart/provider cursor-expiry evidence |
| Gmail drafts | Local preview or explicit provider-backed unsent draft with draft/message receipt and reply threading headers | Yes | No | Real draft create/read-back; no send was performed |
| Gmail mutations | Immediate confirmation for every execute path; per-message trash receipts; deduped IDs; retryability classification; cache updates only for provider successes; honest partial/failed result | Yes | No | Real disposable send/reply/archive/trash/label acceptance; batch Gmail APIs remain atomic rather than per-message partial |
| Google Calendar | Existing discovery/selection, bounded seed, sync-token replay, 410 resync, recurrence/exception/all-day/timezone/attendee/reminder/cancellation handling, watch renewal and polling fallback | Yes | No | Real disposable calendar flow, reconnect, webhook loss, DST/conflict evidence |
| Apple Calendar iOS | EventKit permissions/CRUD, source provenance, portable UID/occurrence/last-modified/recurrence/reminder serialization, `EKEventStoreChanged` cache invalidation | Yes | No | Built app on simulator/device, permission denied/recovery, external-edit evidence |
| Apple Calendar macOS | Existing native bridge remains owned by the macOS lane | Contract only | No | Implement and validate `plugins/plugin-calendar/docs/MACOS_EVENTKIT_PROVENANCE_CONTRACT.md` without changing its field names |
| Cross-calendar dedup | Exact RFC5545 UID plus original occurrence identity; direct Google is authoritative over Google surfaced through Apple; both provider sources retained; no title/time fuzzy merge or automatic mirroring | Yes | No | macOS serializer parity and real overlap/no-feedback-loop evidence |
| Calendar model context | Complete linked-mail snippets preserved, including surrogate pairs, combining marks, and ZWJ graphemes; no model-facing truncation | Yes | N/A | None for this regression |
| Connection UI | Existing generic connector, Calendar source/health, Inbox, revoke, and selection surfaces | Partial | No | One first-five-minutes Gmail/Google Calendar/Apple Calendar seed-progress/privacy/delete-imported-data flow was not added in the narrowed overnight scope |

## Done

- Preserved the existing connector/plugin architecture and isolated all edits from shared/dirty worktrees.
- Added Google OIDC nonce generation, authorization binding, callback validation, and mismatch coverage.
- Added Gmail Drafts capability/scope and provider receipt without conflating drafting with sending.
- Added Gmail History cursor persistence, paginated incremental replay, expiry recovery, tombstones, durable high-water advancement, and database round-trip coverage.
- Added structured Gmail mutation receipts, per-message partial failure for trash, duplicate prevention, retryability, immediate confirmation, and success-only cache mutation.
- Fixed reply-draft threading across legacy and rich Gmail metadata.
- Preserved complete Unicode model context instead of applying a code-unit cap.
- Added iOS EventKit portable identity, recurrence/reminder/source provenance, store-change observation, and Calendar cache invalidation.
- Added exact Google-via-Apple recurrence-instance deduplication evidence and the bounded macOS serialization handoff.
- Created two atomic local commits and two annotated local tags. No external effect occurred.

## Verification evidence

- `plugin-google-workspace` full suite: 29 files, 325 tests passed.
- Google OAuth/Gmail focused suite: 4 files, 15 tests passed.
- `plugin-calendar` full suite: 67 files passed, 2 skipped; 644 tests passed, 4 skipped.
- Calendar Unicode/provenance focused suite: 2 files, 4 tests passed.
- `plugin-native-calendar` full suite: 3 files, 28 tests passed.
- Personal Assistant Gmail focused suite: 1 file, 6 tests passed.
- Personal Assistant repository domain CRUD: 1 file, 3 tests passed.
- Shared connector catalog: 1 file, 11 tests passed.
- Typecheck passed for Shared, Google Workspace, Calendar, and native Calendar.
- Personal Assistant production build passed. Its package-wide typecheck is not a valid green gate in this worktree because unrelated workspace package declaration outputs are absent; the focused compiled suites and production no-check declaration build pass.
- Package lint checks passed for Shared, Google Workspace, Calendar, native Calendar, and Personal Assistant. Personal Assistant emitted only pre-existing informational suggestions in unrelated surrogate tests.
- `xcrun swiftc -frontend -parse` passed for the iOS EventKit bridge.
- `git diff --check` passed and the forbidden macOS owner file has no diff.
- Root `bun run verify` passed repository guide parity, toolchain/i18n/dependency/alias/workspace-resolution checks, then stopped in the global Turbo lane on existing `packages/ui` formatting errors (`login-page.same-origin.test.tsx` and `maps-card.tsx`). This branch has no `packages/ui` diff.

## Doing

- No further feature expansion is active in this overnight checkpoint. The implementation is committed; only the private status checkpoint and local final tag remain.

## Next

- Rebase a review branch onto then-current `origin/develop`, rerun affected and root gates, and prepare a draft PR only when external GitHub work is authorized.
- Route the exact macOS EventKit contract to the macOS owner; do not edit its native file from this lane.
- Run real-provider acceptance only with explicit action-time approval: Google OAuth/account chooser, disposable Gmail/calendar data, Apple permission prompts, packaged macOS, and iOS simulator/device.
- If the broader LifeOps product lane resumes, finish the unified first-five-minutes connection/seed/progress/privacy/disconnect/delete/reconnect UI and visual audits. That work is intentionally outside this narrowed overnight checkpoint.

## Concrete user actions and gates

- No user action is needed for this local checkpoint.
- No real email was sent, archived, labeled, trashed, or deleted. No real calendar event was created, changed, invited, or deleted.
- OAuth consent, password/MFA, Apple permission prompts, provider billing/configuration, push/PR, merge, deployment, and production changes remain explicit future gates.
