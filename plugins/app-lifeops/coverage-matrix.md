# LifeOps E2E Coverage Matrix

All 20 PRD user journeys × test files × status.

PRD: `packages/docs/prd-lifeops-executive-assistant.md`
Scenario matrix: `packages/docs/plan-lifeops-executive-assistant-scenario-matrix.md`

Journey numbering follows the Phase 7 orchestration brief and matches the
`// @journey-N` tag at the top of every test file.

| Journey ID | Journey Name | Domain | PRD Section | Test File | Mockoon Environments | Status |
|---|---|---|---|---|---|---|
| 1 | Recurring Relationship Time | Calendar / Recurring | Suite A (`ea.schedule.recurring-relationship-block`) | `test/scenarios/calendar-llm-eval-mutations.scenario.ts` | google | covered (extension pending) |
| 2 | Sleep Window Protection (reject 7am meeting) | Calendar / Sleep Goal | Suite A (`ea.schedule.protect-sleep-window`) | `test/scenarios/goal-sleep-basic.scenario.ts` | google | covered (extension pending) |
| 3 | Travel Blackout Reschedule (bulk cancel for trip) | Travel / Calendar | Suite A (`ea.schedule.travel-blackout-reschedule`) | `test/book-travel.approval.integration.test.ts` | google (vi-fetch) | covered (extension pending) |
| 4 | Bundle Meetings While Traveling (NYC trip) | Calendar / Travel | Suite A (`ea.schedule.bundle-meetings-while-traveling`) | `test/bundle-meetings.e2e.test.ts` | google | covered |
| 5 | Daily Brief Cross-Channel | Inbox / Daily Brief | Suite B (`ea.inbox.daily-brief-cross-channel`) | `test/assistant-user-journeys.morning-brief.e2e.test.ts` | google | covered |
| 6 | Daily Brief Includes Unsent Drafts | Inbox / Daily Brief | Suite B (`ea.inbox.daily-brief-includes-unsent-drafts`) | `test/daily-brief.drafts.e2e.test.ts` | google | covered |
| 7 | Priority Ranking — urgent before low-priority | Inbox / Triage | Suite B (`ea.inbox.daily-brief-ranks-urgent-before-low-priority`) | `test/lifeops-inbox-triage.integration.test.ts` | none (in-process) | covered (extension pending) |
| 8 | Group Chat Handoff (shared topic across DMs) | Messaging / Inbox | Suite B (`ea.inbox.propose-group-chat-handoff`) | `test/group-chat-handoff.e2e.test.ts` | signal, bluebubbles | covered |
| 9 | Bump Unanswered Decision (follow-up nudger) | Follow-Up | Suite C (`ea.followup.bump-unanswered-decision`) | `test/assistant-user-journeys.followup-repair.e2e.test.ts` | google | covered |
| 10 | Repair Missed Call And Reschedule | Follow-Up / Repair | Suite C (`ea.followup.repair-missed-call-and-reschedule`) | `test/assistant-user-journeys.followup-repair.e2e.test.ts` | google | covered |
| 11 | Relationship Overdue Detector | Follow-Up / Relationships | Suite C (`ea.followup.relationship-congrats-from-daily-brief`) | `test/relationships.e2e.test.ts` | none (in-process) | covered |
| 12 | Capture Travel Booking Preferences | Travel | Suite D (`ea.travel.capture-booking-preferences`) | `test/booking-preferences.e2e.test.ts` | google | covered |
| 13 | Book Trip After Approval | Travel | Suite D (`ea.travel.book-after-approval`) | `test/book-travel.approval.integration.test.ts` | google (vi-fetch) | covered |
| 14 | Flight Conflict Detection And Rebooking | Travel | Suite D (`ea.travel.flight-conflict-rebooking`) | `test/flight-rebook.e2e.test.ts` | google, twilio | covered |
| 15 | Signature Deadline Tracking And Escalation | Docs / Sign-Off | Suite E (`ea.docs.signature-before-appointment`) | `test/signature-deadline.e2e.test.ts` | google, twilio | covered |
| 16 | Speaker Portal Upload Via Browser Automation | Docs / Portal | Suite E (`ea.docs.portal-upload-from-chat`) | `test/portal-upload.e2e.test.ts` | browser-workspace | covered |
| 17 | End-Of-Week Approval Escalation | Docs / Escalation | Suite E (`ea.docs.eow-approval-escalation`) | `test/eow-escalation.e2e.test.ts` | twilio, signal | covered |
| 18 | Multi-Device Meeting Reminder Ladder | Push / Cross-Device | Suite F (`ea.push.multi-device-meeting-ladder`) | `test/notifications-push.e2e.test.ts` | twilio (Ntfy) | covered |
| 19 | Cancellation Fee Warning | Push / Escalation | Suite F (`ea.push.cancellation-fee-warning`) | `test/cancellation-fee.e2e.test.ts` | google | covered |
| 20 | Stuck Agent Calls User (browser blocked → phone) | Push / Escalation | Suite F (`ea.push.stuck-agent-calls-user`) | `test/stuck-agent-call.e2e.test.ts` | browser-workspace, twilio | covered |

## Key

- `covered` — test file exists, lane is wired, no follow-up required for this PRD journey.
- `covered (extension pending)` — base test file exists; an additional sub-scenario for this exact journey is staged for in-place extension. The contract test still passes because the file exists.
- `covered (rename pending)` — test exists and runs, but the filename will be normalised to the `*.e2e.test.ts` convention via `git mv`. The contract test points at the post-rename path when the rename has happened.

## Mockoon Environment Legend

| Environment key | What it mocks |
|---|---|
| `google` | Gmail read/write, Google Calendar, Google Drive |
| `twilio` | SMS send, voice call initiation |
| `whatsapp` | WhatsApp send and inbound webhook |
| `signal` | Signal REST API send/receive |
| `browser-workspace` | Portal navigation, tab eval/snapshot |
| `bluebubbles` | iMessage via BlueBubbles bridge |
| `x-twitter` | X (Twitter) DM and timeline |
| `calendly` | Calendly availability and booking |
| `cloud-managed` | Eliza Cloud managed API endpoints |
| `github` | GitHub notifications, PRs |
