# LifeOps Dashboard UX Review PRD

Date: 2026-04-23

## Scope

This review covers the LifeOps surface at `/apps/lifeops`, including:

- First-run setup gate
- Overview dashboard
- Sleep
- Screen Time
- Social
- Messages
- Mail
- Calendar
- Work / reminders
- Settings / access setup
- Shared LifeOps shell, left section rail, right page chat, top app chrome

Screenshots were captured against the live local UI at `http://127.0.0.1:2138/apps/lifeops` using the running local API. The screenshots include real local account data and should remain local review artifacts unless scrubbed.

Artifacts:

- Desktop contact sheet: `/Users/shawwalters/eliza-workspace/milady/artifacts/lifeops-ux-review-2026-04-23/contact-desktop.png`
- Narrow contact sheet: `/Users/shawwalters/eliza-workspace/milady/artifacts/lifeops-ux-review-2026-04-23/contact-narrow.png`
- Capture report: `/Users/shawwalters/eliza-workspace/milady/artifacts/lifeops-ux-review-2026-04-23/capture-report.json`
- Individual screenshots: `/Users/shawwalters/eliza-workspace/milady/artifacts/lifeops-ux-review-2026-04-23/*.png`

Verified post-fix artifacts:

- Verified capture report: `/Users/shawwalters/eliza-workspace/milady/artifacts/lifeops-ux-review-2026-04-23-verified/capture-report.json`
- Verified narrow contact sheet: `/Users/shawwalters/eliza-workspace/milady/artifacts/lifeops-ux-review-2026-04-23-verified/contact-narrow.png`
- Verified screenshots: `/Users/shawwalters/eliza-workspace/milady/artifacts/lifeops-ux-review-2026-04-23-verified/*.png`

Final narrow verification artifacts:

- Final capture report: `/Users/shawwalters/eliza-workspace/milady/artifacts/lifeops-ux-review-2026-04-23-final/capture-report.json`
- Final desktop capture report: `/Users/shawwalters/eliza-workspace/milady/artifacts/lifeops-ux-review-2026-04-23-final/capture-report-desktop.json`
- Final screenshots: `/Users/shawwalters/eliza-workspace/milady/artifacts/lifeops-ux-review-2026-04-23-final/*.png`

Implementation status since the initial review:

- Narrow/mobile now uses a compact top section picker instead of the fixed left rail.
- Document-level horizontal overflow is gone on the reviewed 390px and 1440px captures.
- Messages and Mail now use a list-first narrow layout instead of rendering the desktop split pane at phone width.
- Calendar narrow now renders as an agenda-style list instead of the desktop time grid.
- Setup no longer clips its action row or horizontally shifts the page body on mobile.
- Social and Screen Time no longer spend narrow space on prominent zero-value tiles by default.
- The largest remaining work is now product and information-density cleanup, not shell breakage.

## Product Goal

LifeOps should be the user's command surface for understanding:

- What the agent can access.
- What the agent is doing now.
- What the agent has already done.
- What the agent is watching.
- What the agent will work on next.
- What needs explicit user approval.
- What personal signals matter today.

The current dashboard is a good start for "life metrics", but it does not yet make agent work visible enough. It reads mostly as a passive dashboard with a generic chat pane. To reach AAA quality, the product model needs to shift from "metrics and inboxes" to "agent operations plus life context".

## Target User Mental Model

The user opens LifeOps to answer these questions in under ten seconds:

1. Is anything urgent?
2. What is my agent doing right now?
3. What did it do since I last checked?
4. What will it do next?
5. What can it see and control?
6. What needs my confirmation?
7. Where am I spending time and attention?
8. What conversations or emails need response?
9. What is my day about?
10. What is not wired yet?

The interface should not show confidence percentages, debug counters, internal implementation details, generic explanatory paragraphs, or zero metrics that mean "source unavailable".

## Current Evidence Summary

Desktop:

- No page had horizontal overflow at 1440 x 1000.
- Overview, Messages, Mail, Calendar, and Settings have intentional internal scroll or list truncation.
- Calendar has many clipped event labels because week view compresses overlapping events.
- Social has clipped message metric labels in small tiles.
- Settings is long and contains several internal/debug-like panels.
- Right chat is always generic and does not show agent activity or access state.

Narrow:

- Initial review: every LifeOps section overflowed horizontally because the fixed left rail stayed expanded on a 390px viewport.
- Current state after implementation: the shell no longer overflows at 390px, and the LifeOps rail collapses into a compact top section picker.
- Messages and Mail are now structurally usable on narrow screens because they open in list-first mode and only show the reader after selection.
- Calendar, Settings, Payments, Reminders, Screen Time, and Social now capture without clipping at 390px.
- Remaining narrow work is visual and product-focused: content pruning, agent visibility, and page-specific compression.

## Core UX Principle

Every visible element must answer one of these questions:

- What is happening?
- What needs me?
- What can the agent access?
- What is the agent going to do?
- What did the agent do?
- What signal changed?

If an element only explains the product, repeats another signal, exposes implementation details, shows a zero because a source is unwired, or decorates without meaning, remove it or move it behind an advanced affordance.

## Information Architecture

Recommended LifeOps sections:

- Overview
- Agent
- Inboxes
- Calendar
- Work
- Sleep
- Screen Time
- Social
- Access

Current sections should map as follows:

- Overview remains first.
- Messages and Mail should stay separate as views, but the overview should summarize both under "Needs response" and "Agent drafts".
- Work should stop being a reminder alias. It should become the user's work and agent task surface.
- Settings should become Access. Advanced setup/debug panels should be hidden by default.
- Agent should be a first-class page or fixed dashboard lane showing doing, done, queued, failed, and needs approval.

## Primary Flows

### Flow 1: Morning Open

The user opens Overview.

Expected experience:

- Top headline states the day posture without overfitting to a single calendar item.
- A visible agent strip shows "now", "next", "done", and "needs approval".
- Calendar, inbox, work, sleep, screen time, and social are compressed into readable modules.
- Empty/unwired sources are shown as source status, not as behavior metrics.
- The user can click any module to drill into the relevant page.

Current gap:

- The overview headline is dominated by one calendar event.
- The same event repeats in Briefing, Timeline, Work, and Calendar.
- There is no meaningful "agent did / is doing / will do" panel.
- The right chat intro is generic and does not explain what the LifeOps agent can see.

### Flow 2: Check Agent Work

The user wants to know what the agent is doing.

Expected experience:

- Agent panel shows current run, recent completed actions, queued work, failed work, and approval queue.
- Each item has a timestamp, source, target, and action type.
- Writes are visually separated from reads.
- Clicking an item opens the relevant detail or transcript.

Current gap:

- No dedicated agent work surface exists in LifeOps.
- Automations are outside the LifeOps mental model.
- The right chat can ask questions, but it does not show an activity log.

### Flow 3: Check Access

The user wants to know what the agent can access.

Expected experience:

- Access page shows accounts and devices as a compact matrix.
- Each source has read/write capability icons, freshness, and action guard state.
- Missing permissions are visible but not verbose.
- Source setup is one click away.

Current gap:

- Settings has useful access data, but it is still mixed with advanced setup surfaces and long-tail connector detail.
- Browser/device setup still needs a tighter default view with advanced controls hidden behind a clearer affordance.
- The page is now structurally stable on narrow screens, but it still reads like setup plus diagnostics instead of a clean access matrix.

### Flow 4: Inbox Triage

The user opens Messages or Mail.

Expected experience:

- Default filter is "Needs response" when there are actionable items.
- User can switch between unread, needs response, drafts, sent by agent, spam/review, and all.
- Bulk operations are available but guarded.
- Reply/draft actions happen through confirmation.
- Page chat is grounded in selected thread.

Current gap:

- The three-pane layout is strong on desktop.
- It lacks first-class "needs response", "agent drafted", "waiting confirmation", "spam", and bulk action affordances.
- Channel counts exist, but they do not directly answer "what should I do?"

### Flow 5: Review Time Habits

The user checks screen time or social behavior.

Expected experience:

- The page shows real time by source and source coverage.
- Phone, browser, desktop app, and web are visually separate.
- Social shows time, sessions, posts/DMs consumed, posts/DMs sent, and source health.
- YouTube and X should use recognizable logos when available.
- Unwired data should appear as access/source status, not as "0m".

Current gap:

- Screen Time visuals are strong.
- Zero-value metrics are now suppressed in the primary narrow view, but source readiness is still not explained clearly enough.
- Social still needs a stronger separation between time, consumption, outbound activity, and source readiness when real data is present.
- Social needs a clearer distinction between time, consumption, outbound activity, and source readiness.

### Flow 6: Calendar and Work Planning

The user checks the day or asks the agent to schedule something.

Expected experience:

- Calendar supports day/week/month, but dense overlapping events stay readable.
- Duplicates are collapsed.
- The agent can propose schedule blocks and show pending changes before writing.
- Work page shows tasks, project focus, reminders, and agent planned work.

Current gap:

- Week view compresses overlapping events into tiny unreadable blocks.
- Duplicate-looking events dominate the current calendar and overview.
- Work currently reads as reminders, not work.

### Flow 7: Mobile/Narrow Check

The user opens LifeOps in a narrow window or mobile shell.

Expected experience:

- Left rail collapses to icons or a top/bottom section switcher.
- Right chat becomes a drawer.
- Main content takes full width.
- No horizontal scrolling is required.

Current gap:

- The structural shell issue is fixed, but narrow layouts still need content pruning and tighter hierarchy on Overview, Calendar, and Access.

## Page And Widget Review

### Shared Shell

Elements:

- Global top app nav
- LifeOps section rail
- Main content area
- Right page chat
- Bottom app nav on narrow view

Assessment:

- Desktop shell is stable and easy to scan.
- Top nav labels can truncate on desktop when combined with the right chat and section rail.
- LifeOps rail dots are decorative unless they map to a real state. They should become meaningful status indicators or be removed.
- Right chat is visually quiet but product-weak. It should become an agent activity/access rail with chat as one mode, or chat should include activity cards above the composer.
- Narrow shell was the largest defect. The rail collapse is now implemented, but the shell still needs a more intentional agent/status story.

Recommendation:

- Desktop: keep the rail but make dots semantic: green live, amber needs setup, red needs approval/error, muted unavailable.
- Narrow: compact section picker is the right pattern; keep it, but trim the labels and align it more tightly with page content.
- Right rail: default to Agent Activity, not a generic empty chat.

### First-Run Setup Gate

Current elements:

- Name input
- Timezone input
- Google Calendar card
- X DMs card
- Skip and Continue buttons
- Generic LifeOps chat

Assessment:

- Useful for first run, but narrow in scope.
- "Tell the agent a bit about you" is not as useful as "Connect what the agent can see."
- Provider cards are too few for the user's LifeOps mental model.
- Continue disabled state is understandable but the disabled explanation takes space.

Recommendation:

- Reframe as "Connect access".
- Show source categories: Calendar, Mail, Messages, Browser/Screen, Social, Tasks.
- Use provider icons and read/write badges.
- Keep skip available.
- Do not show generic chat until setup is dismissed or a setup-specific helper is available.

### Overview Dashboard

Current widgets:

- Greeting/date eyebrow
- Headline
- Refresh icon
- Top metric strip: Sleep, Work, Screen
- Briefing
- Sleep
- Screen Time
- Social
- Timeline
- Messages
- Mail
- Work
- Right chat

Assessment:

- The newspaper grid direction is right.
- The dashboard compresses information well on desktop.
- The headline is too brittle because a single calendar item becomes the page thesis.
- Calendar/reminder data repeats too many times.
- Work widget is misleading because it shows an event/reminder.
- Social tile shows "0 opened / 0 sent", which is low value when the source is unwired or empty.
- Missing most important product layer: agent work state.

Recommendation:

- Add a top "Agent" strip with four cells: Now, Done, Next, Needs approval.
- Replace headline with a daily posture: "One appointment, one overdue reminder, messages waiting."
- Collapse repeated event rows into one grouped calendar summary.
- Rename Timeline to Calendar if it only lists events.
- Replace Work widget with "Focus" or "Agent queue" until true work data exists.
- Hide zero social message counts unless source is live and the zero is meaningful.
- Make overview cards click through, but use icon-only actions with tooltips.

### Sleep

Current widgets:

- Header with refresh
- Status tile
- Last sleep tile
- Bed tile
- Wake tile
- Cycle visualization

Assessment:

- Minimal and visually calm.
- Useful when real data exists.
- "Likely missed" and "0m" are ambiguous without source health.
- The page is too sparse on desktop, with too much empty space and no trend/history.

Recommendation:

- Add a seven-day mini rhythm chart.
- Add source status as icons: device, manual, calendar inferred, app signal.
- Replace "0m" with "No sleep signal" when no real sample exists.
- Keep the cycle visual, but add target and actual markers only when available.

### Screen Time

Current widgets:

- Four top metric tiles: Today, Apps, Web, Phone
- Categories donut and stacked bars
- Devices
- Browsers
- Apps and Sites

Assessment:

- This is the strongest dedicated page.
- Charts and bars fit the problem well.
- "Web 0m" and "Phone 0m" are likely misleading source availability states.
- Apps and Sites is useful but should separate productive work, communication, browser, social, video, and unknown.

Recommendation:

- Add a compact source coverage row at the top.
- Replace missing source zeros with source icons marked unwired.
- Add day/week tabs.
- Add "attention cost" signals: pickups/sessions, longest stretch, after-hours time.
- Add direct drilldown to app/site sessions only after the top view is clean.

### Social

Current widgets:

- Four top metric tiles: Social, YouTube, X, Opened
- Platforms donut and bars
- Devices
- Messages
- Browser
- Surfaces
- Sessions
- Source status chips

Assessment:

- Dedicated Social page is correct.
- It needs stronger visual identity: service logos and platform-specific colors should carry meaning.
- Message counters are too prominent when they are zero.
- Source chips belong at the top as coverage, not at the bottom as a legend.
- "Mac apps / Chrome/Safari / Android apps / iOS apps" is source health, not content.

Recommendation:

- Top row: total social time, YouTube, X, DMs consumed/sent only if live.
- Source row: Mac, browser, iOS, Android, X API/bridge.
- Use a timeline heat strip for sessions.
- Use platform logos for YouTube, X, Discord, Instagram, TikTok, Reddit, etc.
- Separate "time spent", "messages consumed", and "messages sent".
- Hide inactive platforms unless they are connected and zero is meaningful.

### Messages

Current widgets:

- Channel filters
- Search
- Message list
- Reader pane
- Reply button
- Page chat grounded to selected message

Assessment:

- The desktop layout is good.
- It is an inbox, not an agent triage surface yet.
- Needs response, unread, draft waiting, agent sent, and source status are more useful than raw channel counts.
- Reply button is correct, but the user should see when the agent is drafting or waiting for confirmation.
- Narrow layout is now structurally usable with a list-first reader flow, but it still lacks mobile-specific triage states and shortcuts.

Recommendation:

- Add triage filter chips: Needs reply, Unread, Drafted, Sent by agent, All.
- Add bulk affordances only when items are selected.
- Add an "Agent suggestion" drawer or row state for selected messages.
- Move channel filters into a compact menu on narrow screens.
- On narrow, switch to list-first, reader-second navigation.

### Mail

Current widgets:

- Gmail filter chip
- Search
- Email list
- Reader pane
- Reply and Open source buttons
- Page chat grounded to selected email

Assessment:

- Strong foundation for real Gmail review.
- Current UI does not expose the key Gmail capabilities already planned: unresponded, spam review, recommendations, bulk operations, reply drafts, send confirmation.
- Raw email content is readable, but there is no "why this matters" layer.
- Narrow layout is now structurally usable with the same list-first reader flow as Messages.

Recommendation:

- Default to "Needs response" if non-empty.
- Add tabs: Inbox, Needs response, Recommendations, Spam review, Drafts, Sent by agent.
- Add guarded bulk actions: archive, mark read, label, delete, spam.
- Require visible confirmation before send.
- Show source/account badge and freshness in the header.

### Calendar

Current widgets:

- Today button
- Previous/next
- Month heading
- Day/week/month segmented control
- New button
- Week grid with event blocks

Assessment:

- The calendar shape is familiar and useful.
- Dense overlapping events are unreadable in week view.
- Duplicate-looking events pollute both calendar and overview.
- Week grid is too large and sparse for an agent operations dashboard unless it highlights what matters.

Recommendation:

- Add a "Agenda" default for LifeOps; keep Week/Month for calendar work.
- Collapse duplicate events.
- Use "more" stacks for crowded time slots.
- Make selected event details visible without depending only on tiny block labels.
- Add agent scheduling states: proposed, pending write, confirmed.

### Work / Reminders

Current widgets:

- Reminders heading
- Total count
- Urgency chips
- Overdue/soon/today/later buckets
- Reminder rows

Assessment:

- Reminder grouping is clear.
- Naming this section "Work" is wrong unless it shows actual work/project/agent tasks.
- Counts are not valuable by themselves; urgency and next action are valuable.
- The page does not answer what the agent is working on.

Recommendation:

- Rename this page or split it:
  - Work: project focus, tasks, agent work queue, blockers.
  - Reminders: personal nudges and habits.
- Add action state to rows: scheduled, sent, snoozed, completed, failed.
- Add "why this exists" only behind a details affordance.

### Settings / Access

Current widgets:

- Setup header buttons
- GitHub availability warning
- Device Data card
- User and Agent Google cards
- GitHub rows
- Messaging connectors
- Browser access status
- Schedule inspection
- X account
- Stretch reminder
- Permissions

Assessment:

- This page contains the most important access information, but it is too verbose and too mixed.
- It includes product setup, source health, internal diagnostics, posting controls, reminder tooling, and OS permissions in one long scroll.
- Some labels are low value: "1/6", "0/6", repeated token mode explanation, "No cloud agent", and long browser setup paragraphs.
- It is the right place for "what the agent can access", but not in this form.

Recommendation:

- Rename to Access.
- Top: access matrix with sources as rows and read/write/last sync/guard as columns.
- Middle: account cards for Google, GitHub, X, messaging.
- Bottom: device/OS permissions.
- Hide schedule inspection, X post composer, stretch reminder tooling, and debug details under Advanced.
- Use icons and logos instead of repeated text labels where possible.

### Right Page Chat

Current elements:

- Generic empty message
- Composer
- Placeholder changes when an event/message is selected

Assessment:

- It is clean but low value.
- It should be the main place where the user understands the agent's current access and work.
- The generic "hey, i'm here" message does not fit LifeOps.

Recommendation:

- Replace generic empty state with LifeOps agent status:
  - Watching: Gmail, calendar, messages, screen time, social.
  - Doing now: current run or "idle".
  - Done recently: last 3 completed actions.
  - Next: next scheduled check or automation.
  - Needs approval: pending sends/writes.
- Composer remains available.
- When the user selects a message/event/reminder, the right rail should switch to context actions for that item.

## Responsive Requirements

### Desktop

- Keep the LifeOps rail.
- Keep the right rail if viewport is wide enough.
- Main dashboard should remain readable at 1280px.
- No horizontal overflow.

### Tablet / Narrow Desktop

- Collapse the LifeOps rail to icons or a section select.
- Make right chat a drawer.
- Main content must be at least 320px wide.
- Inboxes should become list/detail route states.

### Mobile

- No fixed left LifeOps rail.
- No always-on right chat.
- Section navigation belongs in a bottom sheet or segmented row.
- Dashboard cards should be single column or masonry with stable widths.
- Calendar defaults to agenda.

Implementation status:

- The fixed left rail is gone on narrow layouts and replaced with a compact top section picker.
- The shared shell already hides the right chat behind a drawer on narrow screens.
- Messages and Mail now behave as list/detail route states on narrow screens.
- Calendar still needs an agenda-first narrow mode.

## Data And State Model

LifeOps needs a shared "agent operations" DTO for UI consumption. This should be returned by the application layer, not computed in presentation.

Recommended DTO:

```ts
interface LifeOpsAgentOperations {
  now: LifeOpsAgentWorkItem | null;
  recent: LifeOpsAgentWorkItem[];
  queued: LifeOpsAgentWorkItem[];
  scheduled: LifeOpsAgentWorkItem[];
  approvals: LifeOpsApprovalItem[];
  access: LifeOpsAccessSource[];
  freshness: LifeOpsSourceFreshness[];
}
```

Work item fields:

- `id`
- `kind`
- `title`
- `source`
- `targetLabel`
- `status`
- `startedAt`
- `completedAt`
- `nextRunAt`
- `requiresApproval`
- `detailRoute`

Access source fields:

- `id`
- `label`
- `icon`
- `readState`
- `writeState`
- `lastSyncedAt`
- `freshnessState`
- `guardState`
- `setupRoute`

This DTO should power Overview, Agent, Access, and right rail status. The client should not derive agent status from raw connector data.

## Visual System Requirements

- Use platform logos for Google, Gmail, Calendar, X, YouTube, Discord, Telegram, Signal, iMessage, WhatsApp, Chrome, Safari, iOS, Android, macOS.
- Use icon-only buttons for refresh, open, reply, archive, label, mark read, approve, deny, and inspect, with tooltips.
- Use color as status, not decoration:
  - Green: live/healthy/done.
  - Amber: needs setup/partial/waiting.
  - Red: failed/needs approval/blocked.
  - Blue/cyan/violet: category or source identity only.
- Do not show confidence percentages.
- Do not show raw internal counts unless they directly support action.
- Avoid paragraphs in dashboard panels.
- Use charts for time distribution, daily rhythm, social platform split, and source coverage.
- Keep cards at 8px radius or less unless existing design tokens require otherwise.

## AAA Quality Plan

### Phase 1: Release Blockers

1. Fix narrow layout.
   - Done: collapse LifeOps rail below a breakpoint.
   - Done: shared shell already hides right chat behind a drawer below a breakpoint.
   - Done at 390px and 1440px for the reviewed sweep; 768px and 1024px still need to be added to deterministic verification.

2. Add agent operations visibility.
   - Add Overview strip: Now, Done, Next, Needs approval.
   - Add right rail activity state.
   - Add Access source status to Overview.

3. Remove low-value visible data.
   - Remove decorative dots or make them source status.
   - Hide zero metrics when the source is unavailable.
   - Remove account quota badges from default Settings/Access.
   - Move internal diagnostics to Advanced.

### Phase 2: Page-Specific Quality

1. Overview:
   - Deduplicate repeated calendar/reminder rows.
   - Replace brittle headline.
   - Make Work represent work or rename it.

2. Screen Time and Social:
   - Add source coverage row.
   - Add logos.
   - Separate missing data from zero behavior.
   - Add day/week switch.

3. Mail and Messages:
   - Done: list-first mobile flow for narrow view.
   - Remaining: add needs-response and agent-draft filters.
   - Remaining: add confirmation states for sends.
   - Remaining: add bulk actions behind selection.

4. Calendar:
   - Default to agenda on narrow view.
   - Collapse duplicates.
   - Improve crowded event rendering.

5. Access:
   - Build compact access matrix.
   - Hide long explanatory text.
   - Convert text buttons to icon buttons where the meaning is obvious.

### Phase 3: Verification And Polish

1. Add a deterministic screenshot suite for all LifeOps sections.
2. Add DOM checks for horizontal overflow and unintended text clipping.
3. Add fixture states:
   - No sources connected.
   - Fully connected.
   - Partial sources.
   - Pending approvals.
   - Active agent work.
   - Inbox with needs-response.
   - Social/screen time with phone, browser, and app data.
4. Review with real local data, but do not commit unsanitized screenshots.
5. Run visual review in desktop and narrow sizes before release.

## Acceptance Criteria

- At 390px width, every LifeOps page is usable without horizontal scrolling.
- At desktop width, every LifeOps page fits without unintended clipping.
- Every dashboard widget answers an action, access, agent-work, or life-signal question.
- Overview shows what the agent is doing, did, will do, and needs approval for.
- Access page shows what the agent can read/write and what is stale or missing.
- Mail and Messages expose needs-response and draft/confirmation states.
- Calendar crowded slots remain readable or route to a detail list.
- Social distinguishes time spent, messages consumed, messages sent, and source readiness.
- Missing data sources never appear as behavior zeros.
- Generic explanatory paragraphs are removed from dashboard and default access views.
- Screenshot and DOM overflow checks pass for every LifeOps section.

## Open Decisions

- Should Work be renamed to Reminders, or should a true Work page be built and Reminders stay separate?
- Should Agent be a top-level LifeOps section, or should the right rail carry all agent activity?
- Which screen-time sources are authoritative for phone: iOS Screen Time export, Android app usage stats, mobile app bridge, or manual imports?
- Which social platforms should be first-class after X and YouTube?
- Should the dashboard show real email/social sender names by default, or hide sensitive content behind hover/detail?

## Critical Recommendation

Do not ship the current narrow LifeOps layout. It visibly loses content on every page. The fastest path to AAA is:

1. Fix responsive shell behavior.
2. Add agent operations and access state as first-class data.
3. Remove low-value zeros, counts, explanations, and diagnostics from default views.
4. Convert existing good widgets into a dashboard that is explicitly about the agent's work and the user's current life state.
