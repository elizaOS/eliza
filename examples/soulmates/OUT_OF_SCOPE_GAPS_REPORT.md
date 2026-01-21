# Soulmates Out‑of‑Scope Gaps Report + Implementation Plan

Date: 2026‑01‑19  
Scope: WhatsApp integration, Admin dashboard, Credits, Safety escalation, Nightly matching cadence

This report summarizes current implementation status, gaps, and the concrete work plan to close all remaining gaps identified from `ORI_MASTER_BIBLE.md`.

---

## 1. WhatsApp Integration (Agent Runtime)

### Implemented
- Twilio SMS/WhatsApp send path via `@elizaos/plugin-twilio` and `whatsapp:` prefixes.
- Onboarding forms via `examples/soulmates/soulmates-form.ts`.
- Check‑ins and reminders via `examples/soulmates/notification-service.ts`.
- Scheduling control via `examples/soulmates/flow-orchestrator.ts`.

### Gaps
- **Privacy statement + identity verification** not included in WhatsApp flow.
- **Safety/conduct explicit consent** is not collected.
- **Pause for a month** uses 7‑day default rather than 30 days.
- **Reschedule cap** (3 back‑and‑forth proposals) not enforced.
- `@elizaos/plugin-whatsapp` exists but is not wired (Twilio is used instead).

### Implementation Plan
1. Add **privacy consent** and **safety/conduct consent** fields to the entry form.
2. Add a **verification stage** that issues a code and requires confirmation before continuing.
3. Enforce **30‑day pause** defaults in check‑in logic.
4. Enforce **reschedule cap (3)** and notify admin on limit reached.
5. Keep Twilio as the primary transport; document optional `plugin-whatsapp` wiring.

---

## 2. Admin Dashboard

### Implemented
- Admin UI at `/app/admin` with analytics, allowlist, matches, safety, credits, exports.
- Admin APIs for users, allowlist, analytics, matches, safety, credits, export.

### Gaps
- `/app/admin` UI route is not server‑guarded (APIs are guarded).
- Match update API exists but UI has no controls to use it.
- Export CSV missing for `analytics` and `all`.

### Implementation Plan
1. Add server‑side guard on `/app/admin` route using `requireAdminUser`.
2. Add **match status** and **meeting status** controls in the admin UI.
3. Add CSV export for `analytics` and `all` (or explicitly disable and message).

---

## 3. Credit System

### Implemented
- Credit balance + ledger tables in app DB.
- Stripe Checkout (top‑ups) and webhook credit fulfillment.
- Admin credit adjustments.

### Gaps
- No **spend/debit** logic for premium features.
- App ledger reasons do not include spend reasons.
- Ledger history is not visible in UI.
- Engine ledger exists but is not connected to app ledger.

### Implementation Plan
1. Extend credit ledger reasons to include spend categories:
   - `spend_priority_match`, `spend_priority_schedule`, `spend_filters`, `spend_insight`
2. Add `spendCredits` helper (with idempotent `reference`) to `app/lib/store.ts`.
3. Display ledger history in billing UI.
4. Wire **priority matching** + **priority scheduling** to spend credits in matching cron.

---

## 4. Safety Escalation & Notifications

### Implemented
- `FLAG`/`REPORT` -> level‑2 safety report.
- `RED`/`EMERGENCY` -> level‑3 safety report + admin notification.
- Admin safety UI and API.
- Reminders, feedback prompts, and scheduling escalations in agent runtime.

### Gaps
- No **level‑1 discomfort** report path.
- **No automatic enforcement** (pause/block, cancel meeting) on level‑2/3.
- `transcriptRef` never populated.
- Pre‑meeting safety reminder copy missing.

### Implementation Plan
1. Add **level‑1 safety** action (e.g., “UNCOMFORTABLE”) to record report.
2. When level‑2/3 is created:
   - Pause/Block the reporter and target.
   - Cancel active meetings and matches.
3. Populate `transcriptRef` (placeholder reference in report).
4. Add safety reminder text to T‑24h and T‑2h messages.

---

## 5. Nightly Matching Cadence

### Implemented
- Cron endpoint `/api/cron/matching` exists with locking and batching.

### Gaps
- No scheduler is wired to trigger nightly cadence.

### Implementation Plan
1. Add `vercel.json` for the Next.js app with nightly cron for:
   - `/api/cron/matching`
   - `/api/cron/reminders`
2. Document env secrets required for cron authentication.

---

## Implementation Order

1. WhatsApp flow: privacy + safety consent + verification + pause/reschedule cap
2. Safety enforcement + level‑1 report + reminder copy
3. Admin guard + match update UI
4. Credits: spend logic + ledger UI + cron integration
5. Nightly cron schedule configuration

---

## Status

All gaps above are queued for implementation in the current pass.
