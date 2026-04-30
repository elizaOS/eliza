# Proactive Life-Aware Agent — Implementation Plan

**Date:** 2026-04-23
**Owner:** dutch (Windows dev) + agent team
**Status:** In progress — Phase 1 multi-calendar foundation complete through cloud-managed support; Phase 2 not started

## Handoff notes (2026-04-23)

Work has advanced well past the original handoff. Multi-calendar support now covers local and cloud-managed Google feeds, per-calendar include prefs, merged feed aggregation, settings UI, and action-layer bypass for hidden calendars. Remaining work starts at Phase 2.

**Phase 1 done:**
- App-side calendar discovery, include preferences, merged feed aggregation, settings UI, and calendar-origin labels are implemented in `eliza/apps/app-lifeops`.
- Action-layer calendar reads explicitly bypass the feed toggle so agent actions still see every authorized calendar.
- Cloud-managed Google now exposes a real calendar-list route at `eliza/cloud/app/api/v1/milady/google/calendar/calendars/route.ts`, and the managed app client consumes it via `google-managed-client.ts`.
- The merged default feed no longer assumes `primary` for cloud-managed users when discoverable calendars exist, which fixes secondary calendars such as Quinn being invisible.
- Verification completed:
  - `bun run --cwd eliza/apps/app-lifeops test -- service-mixin-calendar.test.ts`
  - `bunx turbo run typecheck --filter=@elizaos/app-lifeops`
  - `bun run --cwd eliza/cloud check-types`
  - `bun test --preload ./packages/tests/load-env.ts packages/tests/unit/milady-google-multi-account.test.ts packages/tests/unit/milady-google-calendar-calendars-route.test.ts` (from `eliza/cloud`)
  - `bun run build`
  - `bun run desktop:preflight`

**Next up (start here next session):**
- Phase 2: `COMPOSE_BRIEFING`
- Optional follow-up for Phase 1: add a higher-level desktop/UI smoke specifically asserting a secondary cloud-managed calendar renders in the LifeOps month view.

**Landmines / context:**
- `grant.accountEmail` does not exist — use `grant.identity.email` (Record<string, unknown>), guard with `typeof === "string"`. Already applied in `listCalendars`.
- Root cause of the original "Nothing this week" bug was broader than the widget feed: cloud-managed mode had no calendar discovery path, so secondary calendars (for example Quinn / custody) were never queried at all. Fix now spans both app-lifeops and `eliza/cloud`.
- Contracts barrel: `eliza/apps/app-lifeops/src/contracts/index.ts` re-exports from `@elizaos/shared/contracts/lifeops`, so adding to shared contracts file is sufficient.
- Windows dev env. No bash-only scripts.

## Vision

The agent should proactively inform the user about their life. Ideal end state:
- **On desktop app startup:** first-message briefing in chat — "Welcome back. You have Quinn this weekend. 3 emails need replies. Dental at 10am Monday."
- **Every morning on Discord:** unprompted DM with the same kind of briefing.
- **Anywhere you ask:** agent can reason across every calendar, inbox, reminder, and automation the user has authorized — not just the "primary" slice.

## Current State

Audit of 2026-04-23 found the system is ~40% of the way there. All **signals** (calendar, Gmail, reminders, Discord/Telegram connectors, triggers) and **infrastructure** (`sendMessageToTarget`, cron triggers, action plumbing) exist. What's missing is **orchestration**: nothing aggregates signals into a briefing, nothing routes trigger output back out to the user's real channels, and nothing hooks app startup.

Additionally, the calendar widget and feed only query `calendarId: "primary"` — so events on shared/secondary calendars (custody schedule, family calendar) are invisible to the agent. This must be fixed first or every later phase ships blind to real life.

---

## Rules for Agents Working on This Plan

- **Follow CLAUDE.md** in repo root. No new abstractions unless they reduce complexity. No fallbacks that mask broken pipelines. Strong types, no `any`. No narrative comments.
- **Commit to the current branch in the current worktree.** No stashes. No branch switching. Small WIP commits are fine.
- **Verify before handoff.** Each phase lists a `Verification` block — all must pass before marking the phase done.
- **Read the CLAUDE.md "Non-Negotiable Architecture Rules."** In particular: dependencies point inward, DTO fields required by default, single source of truth for validation, no business logic in presentation or BFF layers.
- **Windows is the primary dev environment.** Don't introduce bash-only scripts, `/dev/null`, `2>&1` redirects in npm scripts, or POSIX-only paths. If you touch `scripts/`, make the script work in both PowerShell and bash (use Node.js scripts, not shell).
- **Never hard-block the agent from data.** The UI "include in feed" toggle is about *ambient visibility* (widget, briefings). The agent's actions (`LIST_CALENDAR_EVENTS`, `SEARCH_CALENDAR`, etc.) must always read across **all** authorized calendars regardless of toggle state. Hard-blocking on a UI setting is a bug.

---

## Phase 1 — Multi-Calendar Support (Foundation)

**Goal:** User can see and the agent can reason about every Google calendar in their Google account, not just `primary`. User can choose which calendars appear in the sidebar widget and briefings (default: all on).

**Why first:** Every later phase depends on the agent having an accurate picture of the user's schedule. Shipping a briefing that says "nothing this weekend" when the user has Quinn on a shared calendar is worse than no briefing at all.

### 1.1 Backend — discover calendars

- [x] Add `listGoogleCalendars({ accessToken })` to [eliza/apps/app-lifeops/src/lifeops/google-calendar.ts](eliza/apps/app-lifeops/src/lifeops/google-calendar.ts)
- [x] Add contract type `LifeOpsCalendarSummary` (+ List/Set request/response contracts) in [eliza/packages/shared/src/contracts/lifeops.ts](eliza/packages/shared/src/contracts/lifeops.ts)
- [x] `listCalendars` method on `LifeOpsCalendarService` in [eliza/apps/app-lifeops/src/lifeops/service-mixin-calendar.ts](eliza/apps/app-lifeops/src/lifeops/service-mixin-calendar.ts)
- [x] Expose `GET /api/lifeops/calendar/calendars` route in [eliza/apps/app-lifeops/src/routes/lifeops-routes.ts](eliza/apps/app-lifeops/src/routes/lifeops-routes.ts) returning `{ calendars: LifeOpsCalendarSummary[] }`
- [x] Add `getLifeOpsCalendars()` to client in [eliza/packages/app-core/src/api/client-lifeops.ts](eliza/packages/app-core/src/api/client-lifeops.ts)
- [x] Add cloud-managed calendar discovery route in `eliza/cloud/app/api/v1/milady/google/calendar/calendars/route.ts` and wire `googleManagedClient.listCalendars(...)`

### 1.2 Backend — persist per-calendar include state

- [x] Extend the lifeops preferences store (look for existing preferences persistence under `eliza/apps/app-lifeops/src/lifeops/repository.ts`) with a `calendarFeedIncludes: Record<calendarId, boolean>` field. Default `true` for every calendar the user has.
- [x] When a new calendar appears in `calendarList` that isn't in `calendarFeedIncludes`, default it to `true` (opt-out, not opt-in).
- [x] Add `setLifeOpsCalendarIncluded(calendarId, included)` on client + route.

### 1.3 Backend — aggregate feed across included calendars

- [x] Modify `getCalendarFeed` in [eliza/apps/app-lifeops/src/lifeops/service-mixin-calendar.ts](eliza/apps/app-lifeops/src/lifeops/service-mixin-calendar.ts) to:
  - If `calendarId` param is explicitly passed (for direct queries), behave as today — return events for that calendar only.
  - If no `calendarId` passed (widget / briefing default), fetch events across **all calendars where `calendarFeedIncludes[id] === true`**, merge + sort by `startAt`, dedupe by `id`.
- [x] Each event in the merged feed must carry `calendarId` and `calendarSummary` so the UI can show origin.

### 1.4 UI — widget unchanged behavior, settings added

- [x] [eliza/apps/app-lifeops/src/components/chat/widgets/plugins/lifeops-channels.tsx](eliza/apps/app-lifeops/src/components/chat/widgets/plugins/lifeops-channels.tsx) — no change to the fetch call. The backend already aggregates.
- [x] New settings panel section: "Which calendars appear in your feed?" Renders checkbox per `LifeOpsCalendarSummary`, wired to `setLifeOpsCalendarIncluded`. Show Google color dot.
- [x] Settings location: find lifeops settings surface (search for existing lifeops settings UI before creating a new one).

### 1.5 Agent — full-calendar awareness regardless of UI toggle

- [x] Audit every lifeops calendar action in [eliza/apps/app-lifeops/src/actions/](eliza/apps/app-lifeops/src/actions/) — confirm they read across all authorized calendars, not just the feed-included ones.
- [x] If any action defaults to `primary` or to `feed-included` only, fix it: action-layer reads **everything authorized**. Toggle is UI-only.
- [ ] Provider that exposes calendars to the planner: surface list of all calendars with their `includeInFeed` flag so the agent can say "you have this on Quinn calendar (hidden from sidebar, you can toggle that in settings)."

### 1.6 Verification

- [ ] `bun run verify` passes (typecheck + lint).
- [ ] `bun run test` passes — add a unit test that multi-calendar merge returns sorted deduped events.
- [ ] Manually in `bun run dev:desktop`: sidebar Calendar widget now shows events from secondary calendars (Quinn, Family, etc.) when user has Google connected with `calendar.read`.
- [ ] Settings toggle a secondary calendar off → widget stops showing its events. Agent still answers "when's my next Dutch weekend?" correctly (action bypasses toggle).
- [ ] Commit message: `feat(lifeops): multi-calendar feed with per-calendar include toggle`

---

## Phase 2 — `COMPOSE_BRIEFING` Action

**Goal:** A single agent action that returns a structured, human-readable life briefing for the current moment — calendar + inbox + reminders + automations — suitable for display in chat, on desktop startup, or in a Discord DM.

**Why second:** Without this, Phase 3 and 4 each reinvent the same aggregation logic.

### 2.1 Define briefing contract

- [ ] Add `LifeOpsBriefing` type in [eliza/packages/shared/src/contracts/lifeops.ts](eliza/packages/shared/src/contracts/lifeops.ts):
  ```ts
  interface LifeOpsBriefing {
    generatedAt: string;             // ISO
    horizonDays: number;             // e.g. 7
    calendar: {
      today: LifeOpsCalendarEvent[];
      tomorrow: LifeOpsCalendarEvent[];
      thisWeek: LifeOpsCalendarEvent[];
      highlights: string[];          // e.g. "Quinn weekend (Sat-Sun)"
    };
    inbox: {
      needsReply: LifeOpsGmailMessageSummary[];
      unreadImportant: LifeOpsGmailMessageSummary[];
      totalUnread: number;
    };
    reminders: {
      overdue: LifeOpsReminderSummary[];
      dueToday: LifeOpsReminderSummary[];
    };
    automations: {
      upcomingToday: LifeOpsAutomationSummary[];
    };
    narrative: string;               // LLM-composed paragraph
  }
  ```
  - All fields required (per CLAUDE.md DTO rule). Empty arrays for empty categories — never optional arrays.

### 2.2 Implement composer

- [ ] New file: `eliza/apps/app-lifeops/src/lifeops/briefing-composer.ts`
- [ ] Function `composeBriefing(service: LifeOpsService, now: Date, horizonDays = 7): Promise<LifeOpsBriefing>`
- [ ] Calls existing readers in parallel: `getCalendarFeed`, inbox triage, reminders plan, workflows. No new data sources.
- [ ] `highlights` generation — look for patterns: recurring event families (custody weekends by calendar name / event title prefix), multi-day events, events with attendees that match the user's "important contacts" (if such a concept exists; if not, skip and add a follow-up).
- [ ] `narrative` — small LLM call using the runtime's model to turn the structured data into 2-4 sentences. Keep it short. If LLM unavailable, generate a templated narrative from the structured fields (no failure mode).

### 2.3 Expose as an action

- [ ] New action `COMPOSE_BRIEFING` in `eliza/apps/app-lifeops/src/actions/briefing.ts`
  - Registered via the app-lifeops plugin exports
  - Wraps `composeBriefing(...)`, returns the briefing as the action output
  - Similes: `MORNING_BRIEFING`, `LIFE_SUMMARY`, `WHATS_GOING_ON`
- [ ] Provider `briefing_available` at low priority surfacing "if the user asks for a briefing, call COMPOSE_BRIEFING."

### 2.4 HTTP route (for Phase 3)

- [ ] `GET /api/lifeops/briefing?horizonDays=7` → returns `LifeOpsBriefing` JSON.
- [ ] Client method `getLifeOpsBriefing(horizonDays?: number)` in client-lifeops.ts.

### 2.5 Verification

- [ ] Unit test: `composeBriefing` with a fixture grant returns expected sections. Cover: no events, events today, events across multiple calendars, overdue reminders, 0 unread.
- [ ] Integration: in chat, say "give me my briefing" — agent invokes `COMPOSE_BRIEFING` and renders the narrative + structured sections.
- [ ] The briefing correctly reflects events from the multi-calendar feed (validates Phase 1 integration).
- [ ] Commit: `feat(lifeops): add COMPOSE_BRIEFING action and briefing composer`

---

## Phase 3 — Desktop Startup Briefing

**Goal:** When the desktop app opens (cold start or after a long sleep), the first visible chat message is an agent-authored briefing. Non-intrusive — it reads like the agent said "welcome back" naturally.

**Why third:** Fastest high-impact win. Single client-side hook; no scheduler plumbing.

### 3.1 Define startup trigger contract

- [ ] In [apps/app/src/main.tsx](apps/app/src/main.tsx) (or the actual desktop shell init — verify which file handles `APP_READY_EVENT`), add a post-ready hook that:
  - Reads the last briefing timestamp from local state (so we don't re-greet every time the window refocuses).
  - If `now - lastBriefingAt > 6 hours` OR `never`, fire the briefing.
  - Otherwise skip silently.
- [ ] Local state key: `milady.lifeops.lastBriefingAt` in whatever local-state system the desktop already uses (check existing patterns first — do not add a new persistence layer).

### 3.2 Wire briefing into chat

- [ ] On trigger, call `client.getLifeOpsBriefing()`.
- [ ] Inject the resulting briefing as an **agent-authored message** at the top of the active chat session.
  - Must appear as a proper message in the transcript, not a one-off toast. User can respond to it ("tell me more about Quinn weekend") and the agent has context.
  - Decide: append to current conversation or start a new "morning" session? Recommend: append — context continuity matters.
- [ ] Rendering: use the same message renderer as agent chat. If the narrative + structured data is too long, render the narrative as text and the structured data as a collapsible "Details" section.

### 3.3 Opt-out

- [ ] Settings toggle: "Show a briefing when I open the app" (default: on).
- [ ] Stored in lifeops preferences store.

### 3.4 Verification

- [ ] Cold open desktop: briefing appears as first message.
- [ ] Close, reopen within 6 hours: no new briefing (silent skip).
- [ ] Close, reopen after 6 hours: new briefing.
- [ ] Toggle off in settings: no briefing on open.
- [ ] User types response to briefing: agent continues conversation with briefing context available.
- [ ] Commit: `feat(desktop): proactive briefing on app startup`

---

## Phase 4 — Scheduled Morning Briefing to Discord (and Beyond)

**Goal:** Every morning at a user-configured time, the agent sends the briefing as a DM on the user's preferred connector (Discord first, Telegram and iMessage pattern-matching later).

**Why last:** Requires the most plumbing — hooking the trigger runtime's output to an outbound connector dispatcher. Don't do this before Phase 2, or each scheduled fire will redo aggregation.

### 4.1 Proactive dispatcher service

- [ ] New service: `eliza/packages/agent/src/services/proactive-dispatcher.ts`
- [ ] Interface:
  ```ts
  interface ProactiveDispatchRequest {
    connector: "discord" | "telegram" | "imessage" | "desktop";
    target: string;         // platform-specific: discord user id, telegram chat id, etc.
    content: { text: string; structuredJson?: unknown };
    idempotencyKey: string; // so re-fires don't double-message
  }
  ```
- [ ] Resolves the target connector plugin, calls its `sendDM` (or equivalent) action, records delivery in an audit log.
- [ ] Never silently swallows failures — if delivery fails, log + surface to the agent (so next turn the agent knows it didn't land).

### 4.2 Trigger → dispatcher plumbing

- [ ] Audit [eliza/packages/agent/src/triggers/runtime.ts](eliza/packages/agent/src/triggers/runtime.ts) — currently fires into autonomy room. Extend the trigger definition to allow a `dispatchTo: ProactiveDispatchRequest["connector"]` hint.
- [ ] When a trigger fires with a `dispatchTo`, the runtime:
  1. Invokes the action specified by the trigger (e.g. `COMPOSE_BRIEFING`)
  2. Pipes the result through `ProactiveDispatcher.dispatch(...)` instead of routing to the autonomy room
- [ ] Do NOT remove autonomy-room routing — that's still the right behavior for introspection triggers. This adds a second output path.

### 4.3 User configuration

- [ ] Settings UI: "Morning briefing — where and when?"
  - Enabled toggle
  - Time-of-day picker (local time; store in UTC with user's IANA tz)
  - Connector picker (Discord / Telegram / Desktop push — only show connectors the user has authorized)
  - Weekday selection (weekdays only? every day?)
- [ ] Persisted in lifeops preferences; on save, upsert the corresponding cron trigger via the existing trigger API.

### 4.4 Connector-target resolution

- [ ] Each connector (Discord, Telegram) needs to expose "who is the owner/primary user target?"
- [ ] Add `getOwnerTarget(): Promise<string | null>` to connector plugin interface. Returns the DM target id.
- [ ] For Discord, this is the user's Discord ID. For Telegram, the chat id. iMessage: phone or email.
- [ ] If no owner target is set, settings UI for that connector shows "Pair your account" first — same flow as `/telegram:access` skill.

### 4.5 Verification

- [ ] End-to-end test: configure briefing at T+2 minutes, Discord, owner target set. Wait. Receive DM.
- [ ] DM is readable (narrative on top, details clean), matches what `/api/lifeops/briefing` returned at fire time.
- [ ] Connector down or target invalid → agent sees a failure record and can tell the user about it on next turn ("I tried to DM you this morning but Discord rejected it — can you check the pairing?").
- [ ] Idempotency: two near-simultaneous fires of the same trigger don't cause a double-DM.
- [ ] Commit: `feat(agent): proactive dispatcher + scheduled Discord briefing`

---

## Cross-cutting Concerns

### Privacy

- [ ] The briefing narrative is LLM-composed from real user data. Do NOT log full briefings anywhere except the user-facing transcript and the structured delivery audit.
- [ ] Apply the existing privacy filter (`eliza/apps/app-training/src/core/privacy-filter.ts`) before any briefing content lands in a trajectory.

### Timezone

- [ ] Every place we compare "now" to event times: use `Intl.DateTimeFormat().resolvedOptions().timeZone` on client, persist user IANA tz server-side in lifeops preferences. Never trust `new Date()` arithmetic across a day boundary without an explicit tz.

### Tests

- [ ] Every new service/action gets a unit test. Multi-calendar merge, briefing composer, dispatcher retry.
- [ ] One end-to-end test per phase landing in `eliza/apps/app-lifeops/test/` (look at the existing `.real.test.ts` pattern).

### Docs

- [ ] Update user-facing docs at `docs/apps/` — briefing overview, how to configure morning DM, how multi-calendar settings work.
- [ ] No README churn. No CLAUDE.md edits.

---

## Out of Scope (For Now)

Explicitly NOT part of this plan — log as follow-up issues only:

- Non-Google calendar providers (Apple, Outlook). The contract should be provider-agnostic so this is additive later.
- Sleep/wake OS signals on desktop (screen lock, app backgrounding) as briefing triggers. Worth doing, but Phase 5.
- Evening / end-of-day recap briefings. Same infrastructure, different prompt.
- Automations that *act* on the briefing ("schedule Quinn's pickup reminder automatically"). Later.
- Mobile briefing surfaces. Desktop + Discord/Telegram first.

---

## Handoff Notes

- If you are an agent picking this up: read the audit section, read `CLAUDE.md` and `AGENTS.md` in repo root, and pick the earliest unchecked phase. Don't skip ahead.
- If you hit a block (missing capability, weird Windows-only issue, unclear contract), leave a `<!-- BLOCK: ... -->` comment in this file and push. Don't silently abandon.
- Every phase ends with a commit. Don't bundle phases into one commit — we want clean history.
