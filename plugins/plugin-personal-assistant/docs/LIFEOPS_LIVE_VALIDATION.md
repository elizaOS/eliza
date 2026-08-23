# LifeOps live owner and connector-agent validation matrix (#8833)

The static LifeOps split (personal-assistant + per-domain plugins) is done and
the 10 split views were audited `good` on desktop + mobile (see issue #8833
comments). What remains is **live, account-backed validation** across owner-side
and agent-side connector grants, native devices, and OAuth/provider state — work
that cannot be proven in unit tests because it depends on real credentials and
devices. Runtime actor roles are OWNER/ADMIN/USER/GUEST; `agent` here names a
connector grant side, not an actor role.

This document is the durable QA matrix for that pass: the prerequisites, the
exact states to exercise per connector, the expected behavior, and the
skip rules when credentials/devices are absent. Fill the **Result** columns in a
copy under the local scratch dir `reports/lifeops-live-validation/<session>/`
(gitignored — evidence is never committed to the repo) and attach the redacted
screenshots / logs **inline in the PR/issue** per
[`CONTRIBUTING.md`](../../../CONTRIBUTING.md) (MP4 video, JPG screenshots, logs in
a `<details>` block).

## How to run a live session

```bash
# 1. Provide working credentials in .env (see "Env vars" per connector below),
#    then confirm readiness on the credential dashboard (values masked to last-4):
bun run lifeops:hitl                    # scripts/lifeops/hitl-credential-dashboard.mjs
# 2. Boot the local app (Eliza API on :31337, dashboard on :2138):
bun run dev
# 3. Open the dashboard and complete first-run onboarding as the OWNER:
open http://localhost:2138
# 4. Prove the connection UI with deterministic, no-provider fixtures before
#    opening any OAuth or native-permission prompt:
bun run --cwd plugins/plugin-personal-assistant test:connections:e2e
# 5. Drive the supervised provider matrix below. There is intentionally no
#    aggregate live-lane command: every OAuth, TCC, send, and calendar-write
#    boundary is an action-time user gate.
# 6. Capture the populated views: open the /lifeops-live-test view, then
bun run --cwd packages/app audit:app    # desktop + mobile screenshots per view
bun run test:e2e:record                 # recorded walkthrough for the PR video
# 7. Drive each view/action below as OWNER, then repeat as a non-owner USER
#    using the agent-side connector identity. Stage all artifacts under
#    reports/lifeops-live-validation/<session>/ and attach them inline on the
#    PR/issue per CONTRIBUTING.md.
```

The HITL runner tracks this lane as the `lifeops-live` group
(`node scripts/hitl/run-hitl.mjs --groups=lifeops-live` — see
`docs/testing/hitl-probes.md`). That command produces the review plan; it
does not contact providers or replace the supervised matrix below. The lane is
intentionally outside the golden-path default because it requires real
credentials and devices.

> **Agent responses require a working model provider.** If the model keys in
> `.env` are empty/expired (a `401` on first model call), the agent will not
> generate replies and connector actions that route through the planner cannot
> be exercised. Set a live `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` (or a local
> inference endpoint) before a live session. This is the single most common
> blocker — confirm a model round-trips before validating connectors.

## Supervised mail and calendar acceptance

Run this section only from a reviewed candidate whose exact commit is recorded
in the session report. Use a disposable Gmail thread and disposable Google and
Apple calendars. Never capture tokens, message bodies, attendee addresses, or
private event text. Every chooser, consent, MFA, native permission, send,
archive/trash/label operation, or external calendar write is an action-time
user gate; stop immediately before it and name the exact pending effect.

### Google connection and bounded seed

1. Open `/lifeops/connections` and capture the disconnected desktop and mobile
   states. Confirm Apple-only seeding remains available when an Apple calendar
   is selected.
2. Under **OAuth access requested**, leave only **Read and search Gmail**,
   **Create drafts**, and **Read Google Calendar** selected. Confirm Gmail send,
   mailbox management, and Calendar write remain off.
3. Click **Continue to Google**, then stop. The user completes the Google
   account chooser, consent, password, and MFA prompts. Record only the account
   alias used for the disposable test, never an address or token in durable
   evidence.
4. After callback, confirm the chosen account is displayed, the expected
   calendars are discoverable, and the granted capabilities match step 2.
5. Select only the disposable Google calendar plus any disposable Apple
   calendar, choose **7 days**, and click **Seed selected context**. Confirm the
   progress phases complete and the receipt reports Gmail messages, calendar
   events, source count, and duplicate count. It must not send mail, invite
   attendees, or write either provider.
6. Confirm Gmail shows a History cursor status and last-success timestamp.
   Confirm each calendar source shows independent freshness and update mode.
7. In Gmail and Google Calendar directly, create one new disposable message or
   event as the user. Return to Eliza and click **Refresh health**. Verify only
   the incremental item appears and the seed totals do not duplicate.
8. For a second Google account, repeat connection with another disposable
   account. Switch **Active Google account**, seed, and verify the request and
   receipt include that account's Google calendars plus selected Apple
   calendars, never hidden calendars from the other Google grant.

### Disposable acceptance corpus and receipts

Prepare these records before the supervised session. Use redacted aliases in
durable evidence and never record account addresses, message bodies, attendee
addresses, tokens, or private calendar titles.

| Fixture | Contents | Cleanup boundary |
|---|---|---|
| Gmail self-thread | One self-addressed thread, one draft, and one dedicated test label. Reply/forward/archive/trash remain separate opt-in effects. | Delete or restore only after the corresponding provider receipt is recorded and the user confirms cleanup. |
| Google calendar | One disposable calendar containing a timed event, all-day event, weekly recurrence, one recurrence exception, and one timezone/DST event. | Delete only the disposable calendar after read-back and reconnect/dedup checks. |
| Apple calendar | One disposable local calendar with the equivalent timed, all-day, recurrence/exception, timezone, reminder, and attendee shapes. | Delete only the disposable calendar after EventKit read-back. |
| Overlap | Surface the disposable Google calendar through Apple Calendar while the direct Google grant remains connected. | Remove the Apple account/calendar view only after proving one logical event, both provenances, and no feedback write. |

Record these exact receipt fields in the redacted scratch report:

- Gmail seed: `grantId` alias, `rangeDays`, `messageCount`, `pageCount`,
  `historyCursorPresent`, and `seededAt`.
- Gmail health: `state`, `cursorStatus`, `historyCursorPresent`,
  `fullResyncReason`, `cachedMessageCount`, and `syncedAt`.
- Calendar seed: `timeMin`, `timeMax`, `feedState`, `selectedSourceCount`,
  `eventCount`, `duplicateEventCount`, and `seededAt`.
- Local purge: deleted message/event/sync-state counts, `providerMutation:
  false`, and purge timestamp.
- Provider effects, only when separately authorized: provider operation,
  provider object/message id or opaque receipt id, committed timestamp,
  per-item success/failure, and read-back result. A draft receipt never counts
  as a send receipt, and an Eliza proposal never counts as an event write.

The exact manual gates are:

1. Stop before **Continue to Google**. The user chooses the disposable Google
   account and approves the displayed scopes; password and MFA remain entirely
   user-operated.
2. Stop before **Request permission**. The user accepts or denies the Apple
   EventKit TCC prompt, then returns to Eliza for health refresh.
3. Stop before every final send, reply, forward, label/archive/trash, calendar
   create/update/invite/delete, local purge, disconnect, revoke, and disposable
   provider cleanup confirmation. Authorization for one gate does not carry to
   the next effect.

### Gmail drafts versus effects

1. Ask Eliza to prepare a self-addressed reply draft. Verify the review surface
   and provider draft receipt; no message may be sent.
2. If send acceptance is explicitly authorized, enable **Send approved email**,
   review the exact recipient/subject/body, and stop at the final confirmation.
   The user authorizes that one disposable send. Verify the provider receipt and
   Sent state, then confirm incremental History sync imports it once.
3. Repeat separately for reply and forward. A draft receipt is never accepted
   as a send receipt.
4. If mailbox-mutation acceptance is explicitly authorized, enable **Manage
   labels and mailbox state** and test one disposable label, archive, and trash
   operation. Stop before each final confirmation. Verify success and failure
   receipts independently and retry only failed items.

### Google Calendar read and optional writes

1. In a disposable Google calendar, create externally: a timed event, an
   all-day event, a recurrence with one exception, and a timezone/DST case.
   Refresh Eliza and verify identities, instances, cancellation state, timezone,
   reminders, and attendees are preserved without fuzzy title/time merging.
2. Ask Eliza to propose an event. Confirm the proposal does not create it.
3. If Calendar writes are explicitly authorized, enable **Change Google
   Calendar** and stop at each final create/update/invite/delete confirmation.
   Verify a provider receipt and read-back after every effect. Use only the
   disposable calendar and test attendee.
4. Revoke the test grant in Google, then refresh Eliza. Verify a recoverable
   disconnected/expired state rather than cached success. Reconnect the same
   account and verify stable identities prevent duplicates.

### Apple Calendar and overlap

1. Use a packaged macOS build and an iOS simulator or physical device. Open
   `/lifeops/connections`; at **Request permission**, stop and let the user
   accept or deny the native EventKit prompt.
2. For denial, verify **Permission denied** and **Open System Settings**. The
   user changes Calendar permission in System Settings, returns to Eliza, and
   clicks **Refresh health**. Verify the state becomes **Full access**. Also
   record restricted, limited, not-determined, and not-applicable states where
   the target supports them.
3. Select only a disposable Apple calendar, choose **7 days**, and seed without
   any Google grant. Verify the receipt says one source and contains no Gmail
   import.
4. Create and edit disposable timed, all-day, recurring/exception, timezone,
   reminder, and attendee events in Apple Calendar. Verify EventKit store-change
   delivery or polling recovery imports each change once.
5. Surface the disposable Google calendar through Apple Calendar while the
   direct Google grant remains connected. Verify both provenances are visible,
   each logical event is read once, and no write is sent back twice.
6. If Apple writes are explicitly authorized, stop at each final
   create/update/delete confirmation and verify the EventKit receipt plus native
   read-back.

### Local lifecycle and recovery

1. Open each purge dialog and verify its title names the exact Google account or
   Apple provider. Cancel with Escape and confirm no receipt appears.
2. Confirm **Purge imported Google data** or **Purge imported Apple data** only
   when authorized. Verify `providerMutation: false`, then check the disposable
   provider data still exists.
3. Disconnect Google without purging. Verify future Google sync stops while
   Apple-only seed remains available and imported Google context remains until
   separately purged.
4. Reconnect the same account, reseed the same range, and verify counts and
   canonical identities do not duplicate.
5. Exercise offline/reconnect, expired History and Calendar cursors, quota/rate
   limits, partial seed, app restart between phases, and failed permission or
   System Settings launches. Every failure must remain visible, retain healthy
   cached sources, re-enable safe retry, and emit no fabricated success receipt.

## OWNER vs USER permission matrix (run for every connector/action)

For each owner-only action surface, exercise and record evidence for:

| # | State | Expected |
|---|---|---|
| 1 | Unauthenticated connector | Clear "not connected" affordance; no silent failure |
| 2 | OWNER authenticated + authorized | Action succeeds; typed `DispatchResult` returned |
| 3 | USER authenticated, not owner-authorized | Denied with a clear permission error (`roleGate`) |
| 4 | Expired / revoked grant | Explicit, recoverable re-auth prompt |
| 5 | Missing required scope | Explicit scope error; no partial mutation |
| 6 | Multiple grants (owner-side must win) | Owner-side grant selected for owner-only ops |
| 7 | Planned-tool execution path | `roleGate` enforced |
| 8 | Direct handler invocation path | Handler-level owner check matches `roleGate` |
| 9 | UI-triggered path from the view | Same outcome as 7/8 |

Expected invariants (all paths): owner-only actions deny non-owner execution;
approval-required outbound actions route through `PgApprovalQueue` (never send
silently); connector calls return typed `DispatchResult` data (never a bare
boolean or a swallowed error).

## Connector families

Legend for **Result**: `pass` · `fail` · `blocked (no creds)` · `n/a`.

| Connector | Owner actions | Env vars / prerequisites | Result (OWNER) | Result (agent-side connector) |
|---|---|---|---|---|
| Google Calendar | `CALENDAR` (list/create/update/delete/availability, conflict detect) | OWNER + AGENT Google accounts w/ Calendar scope; OAuth grant | | |
| Gmail / Inbox | `INBOX` (read/search/label/archive; outbound draft→approval) | Gmail scope on same accounts; billing corpus for finances | | |
| Telegram | status/read/send-or-draft | OWNER + AGENT bot/user identities | | |
| Discord | status/read/send-or-draft | OWNER + AGENT identities | | |
| WhatsApp | status/read/send | `ELIZA_WHATSAPP_ACCESS_TOKEN`, `ELIZA_WHATSAPP_PHONE_NUMBER_ID` | | |
| iMessage | status/read/send | macOS + `ELIZA_IMESSAGE_BACKEND` | | |
| X | status/read/post | OWNER + AGENT identities | | |
| Slack | status/read/send | workspace tokens (if deployed) | | |
| Phone / SMS / Voice | `VOICE_CALL` (outbound call/SMS, approval) | Twilio test number + recipient allowlist | | |
| Health | `OWNER_HEALTH` (sync, permission, error paths) | Apple Health/HealthKit, Google Fit/Health Connect, Fitbit/Oura/Strava/Withings | | |
| Screen-time / Focus | `OWNER_SCREENTIME`, `BLOCK` (macOS-only) | macOS hosts/SelfControl admin; iOS Family Controls; Android Usage Access | | |
| Finances | `OWNER_FINANCES` (subscription detect, import, approval) | Gmail billing corpus / CSV fixture / Plaid or PayPal sandbox | | |
| Documents | `OWNER_DOCUMENTS` (search/review/signature) | document store + signature provider | | |

## Split views (each on desktop + mobile)

View-rendering + aesthetics already audited `good` (issue #8833 comment). For
the **live-data** pass, record empty / loading / error / populated states, plus
refresh/retry and "agent-created data shows up in the view":

`/calendar` · `/scheduling` (reminders) · `/goals` · `/inbox` · `/health` ·
`/focus` (blocker) · `/finances` · `/documents` · `/relationships` ·
`/phone` (+ `/phone/tui`). Confirm any remaining `#lifeops` deep links/aliases
in `packages/app` still resolve.

## Skip behavior for absent credentials

Live tests must skip (not fail) when their credentials/devices are absent, so a
minimal checkout stays green:

- Connector live tests are gated behind their env var(s) — e.g. an `it.skipIf`
  on the access token / sandbox key; skipped runs log the missing prerequisite.
- The LifeOps prompt benchmark now lives in the standalone benchmarks repo
  (https://github.com/elizaOS/benchmarks) and runs there, not in this package.
- Native-device flows (HealthKit, Family Controls, SMS default-role) require a
  real device/simulator and are out of scope for headless CI.

## Acceptance (per #8833)

- [ ] Every connector family has OWNER and AGENT evidence (or `blocked` w/ reason).
- [ ] Every owner-only action denies non-owner via planned-tool, direct-handler, and UI paths.
- [ ] Every split view checked desktop + mobile across empty/loading/error/populated.
- [ ] OAuth / native-permission failures are explicit and recoverable.
- [ ] Live connector failures return typed results (no silent success).
- [ ] Approval-gated outbound flows validated end to end.
- [ ] This matrix records exactly which accounts, devices, scopes, env vars, and sandboxes were used.
- [ ] Any discovered bug has a linked issue/PR before the issue is closed.
