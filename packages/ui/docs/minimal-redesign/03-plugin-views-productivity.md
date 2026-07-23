# Plugin Views — Productivity / LifeOps / Comms / Social (UX + Code + State Inventory)

Repo: `/home/shaw/eliza`. Scope: 16 plugin views (productivity, lifeops, comms, social/game).
Redesign direction judged against: **minimalism** (cut text/borders/cards/badges/inputs/slop; icons+color+whitespace over text), **lighter single look** (move off heavy black bg; orange `#ff8a24` accent, blue `#1d91e8` info, white/black/gray; flat futuristic), **chat-first** (floating chat overlay is the PRIMARY interface on top of every view; views should be glanceable, voice-forward, show only essential info, expose view-dependent actions, surface proactive agent context).

---

## CROSS-CUTTING FINDINGS (apply to most views)

1. **Two competing visual systems, neither light.**
   - Hand-rolled inline `CSSProperties` with a hard-coded near-black `#0a0a0a` background + white-opacity surfaces: Todos (`TodosView.tsx:209`), Goals (`GoalsView.tsx:275`), Health (`HealthView.tsx:169`), Focus (`FocusView.tsx:127`), Inbox (`InboxView.tsx:240`), Documents (`DocumentsView.tsx:220`), Relationships (`RelationshipsView.tsx:291`).
   - Tailwind + `@elizaos/ui` components with explicit `dark:` variants: Social-alpha (`bg-slate-50 dark:bg-slate-800/50` at `LeaderboardTable.tsx:65`).
   - Calendar uses `bg-bg/20` / `bg-white/3` / `ring-white/50` dark tints. Feed has since moved to the unified `FeedView` / `FeedSpatialView` path instead of its legacy dark game-shell chrome.
   - Every one hardcodes `#0a0a0a` / `dark:` and orange `#ff6a00` (note: redesign accent is `#ff8a24`). A single light token set would fix the palette in one place.

2. **Retired terminal twins are gone.** The old comms/companion terminal clones were off-brand blue surfaces; this cleanup removes those duplicate renderer paths from the shipped view set.

3. **Always-on subtitle paragraphs** restate the icon+title in nearly every view: Health `:368`, Inbox `:415`, Documents `:398`, Relationships `:464`, Goals `:453`, Todos `:349`, Phone `:553`, Messages `:496`. All deletable.

4. **Borders + card-per-item + per-row dividers** are the universal heaviness. `cardStyle` border (every view) + per-row `borderBottom`. Worst: Relationships (one bordered card per entity) and Social-alpha (3 levels of card nesting).

5. **Chat hand-off pattern already exists and is correct** in Todos/Goals/Relationships/Inbox/Health (`client.sendChatMessage(...)`) and partially Calendar (`onChatAboutEvent`). Lean into it: delete CRUD UI in favor of chat-driven mutation.

6. **`useAgentElement` instrumentation is consistently present** on meaningful controls in all views EXCEPT Social-alpha (which has zero agent instrumentation — chat cannot drive it). Preserve the descriptors; shrink visible chrome.

7. **Shared boilerplate duplicated 7×**: each inline-styled view re-defines identical `*-view-btn` / `cardStyle` / `containerStyle` / `headerRowStyle` / `h1Style` blocks. One shared light-theme token set kills all of it.

---

## 1. Calendar

- **plugin / view id / file**: `@elizaos/plugin-calendar` / `calendar` (icon `Calendar`, path `/calendar`) / `plugins/plugin-calendar/src/components/CalendarSection.tsx` (1289 L) + `EventEditorDrawer.tsx` (1005 L). Decl: `plugins/plugin-calendar/src/plugin.ts:22-33`.
- **Purpose**: Full Google-Calendar clone — hour-grid day/week, 6-row month, mobile agenda — over the Google+Apple feed.
- **Real or stub?** **Real.** `useCalendarWeek()` → `client.getLifeOpsCalendarFeed` (`hooks/useCalendarWeek.ts:129`); drawer does real CRUD `createLifeOpsCalendarEvent`/`update`/`delete`/`getLifeOpsCalendars` (`EventEditorDrawer.tsx:429,546,590,636`).
- **States**: loading (`:1224`, only when 0 events), error banner (`:1209`), empty = icon-only `CalendarStatusIcon` (`:949`), populated in 3 layouts AgendaView/MonthGrid/TimeGrid (`:1232,1242,1249`); SegmentedControl Day/Week/Month (`:1181`); 2 EventEditorDrawer instances edit+create (`:1258,1275`) each w/ ConfirmDialog delete; month "+N more" popover (`:812`).
- **Visual structure**: header toolbar (prev/today/next + `<h2>` range + SegmentedControl + New); 0 grid help text (good) but drawer has per-field `description` on each input; every grid is a `rounded-2xl` bordered panel; **extreme border noise** — `border-l` per day column + `border-t` per hour line (×17/day) + `divide-y`; today-pill/all-day pills/category dots; ~7 drawer form fields. Evidence: `CalendarSection.tsx:626` `"overflow-hidden rounded-2xl border border-border/12 bg-bg/20"`; `:498` `border-l border-border/12` per column; drawer panel `EventEditorDrawer.tsx:688` (massive `!`-override className).
- **Heaviness/slop**: ~2300 lines reimplementing lane-packing collision layout (`:294-373`), now-indicator, all-day bands, 7-field editor — a desktop app, not a glanceable surface. Hardcoded dark (`bg-bg/20`, `bg-white/3`, `ring-white/50`). Per-hour/per-column line grid is the opposite of whitespace.
- **Minimize**: Default to **AgendaView** (already built, `:920`) — a flat "next up" list. Demote/drop day/week/month grids behind "open full calendar". Kill per-hour/per-column borders; today = orange accent only. **Replace the 1005-line `EventEditorDrawer` with chat** ("move my 3pm to 4") — `onChatAboutEvent` already exists; keep drawer only as power-user fallback. Surface proactive "Next: X in 20m" + conflict warnings (`conflictDetectAction` already ships).
- **Even-simpler**: Grid views are chat-replaceable for the common case. Minimal calendar = agenda strip of today/next + "next event / conflict" line, mutation through chat. Strong merge candidate with Todos+Goals into one "Today/Focus" surface.

## 2. Todos

- **plugin / view id / file**: `@elizaos/plugin-todos` / `todos` (icon `ListChecks`) / `plugins/plugin-todos/src/components/todos/TodosView.tsx` (533 L). Decl: `plugins/plugin-todos/src/index.ts:17-26`.
- **Purpose**: Read-only three-lane board (Today/Upcoming/Someday).
- **Real or stub?** **Real, read-only.** `GET /api/lifeops/todos` via `getTodos()` (`:57`). No write path — "Add a todo" → `client.sendChatMessage("Add a todo for me.")` (`:408`). Lanes are presentation-only over `dueDate` (`:118`).
- **States**: loading (`:461`), error+Retry (`:470`), empty (`:496`), populated 3-lane grid (`:521`). No modals/forms/detail/sub-tabs.
- **Visual structure**: `<h1>Todos</h1>` + Refresh + **subtitle** "Three lanes: Today, Upcoming, Someday." (`:349`); per-lane `description` line ×3 (`:131-135`,`:385`); empty-state paragraph (`:503`) → triple-explained. 3 lane `<article>` cards + per-row `borderBottom`; meta string `"Pending · due Jun 3"` (`:357`); 0 inputs. Evidence: `containerStyle` `:202` `background:"var(--background,#0a0a0a)"`; `cardStyle` `:231` white-opacity border.
- **Heaviness/slop**: Lane names stated 3× (subtitle, header, description). "Pending" is the default status, adds nothing. Three empty "Nothing here." lines (`:387`). ~150 lines of inline style constants, hardcoded `#0a0a0a`.
- **Minimize**: Delete subtitle (`:349`), 3 lane descriptions (`:131-135`), "Nothing here." Drop "Pending" — show only due date colored orange when overdue, status as dot/strikethrough. Lighten off `#0a0a0a`, drop card borders + row dividers. Glanceable = **Today lane** only; Upcoming/Someday collapse to counts ("4 upcoming · 9 someday"). complete/snooze → chat. Header line = "3 due today, 1 overdue" colored orange.
- **Even-simpler**: Highly chat-mergeable. Merge with Goals + Calendar agenda into one "what needs my attention now" surface.

## 3. Goals

- **plugin / view id / file**: `@elizaos/plugin-goals` / `goals` (icon `Target`) / `plugins/plugin-goals/src/components/goals/GoalsView.tsx` (704 L). Decl: `plugins/plugin-goals/src/plugin.ts:35-47`.
- **Purpose**: Long-horizon goals grouped by status with cadence/target/review state.
- **Real or stub?** **View real & read-only**: `GET /api/lifeops/goals` (`:77`). NB: plugin's OWNER_ROUTINES/REMINDERS/ALARMS backends are `scaffold_stub` (per plugin CLAUDE.md) but the view only reads goals. "Set a goal" → chat (`:556`).
- **States**: loading (`:621`), error+Retry (`:631`), empty (`:656`), populated status-groups (`:681`), filter-miss sub-empty (`:696`). 4 status-filter chips (`:460`). No modals/forms/detail.
- **Visual structure**: `<h1>Goals</h1>` + Refresh + subtitle (`:453`); empty paragraph (`:662`); 1 card per status group + per-row `borderBottom`; **4 always-rendered status chips** with 26-line injected CSS pill block (`:227-253`); per-row review label + date; at-risk `●` orange dot (`:501`); per-group count. Evidence: `containerStyle` `:267` `#0a0a0a`; `kindBadge`-style chips `:227`; row meta `"Not reviewed · Jun 3, 2026"`.
- **Heaviness/slop**: 4 always-on status toggles (Archived/Paused rarely relevant) + 26-line CSS for pills = over-engineered. **Redundant grouping**: goals grouped into status-titled cards AND filtered by the same status chips (two reps of one dimension). "Not reviewed" is default/uninformative. ~155 lines inline style, hardcoded black.
- **Minimize**: Delete subtitle + redundant status-group headers OR chips (keep one). Lightest = drop the 4-chip filter bar, show only **active** goals; "show archived" → chat. Collapse row meta to signal-only: lead with at-risk `●` (orange), drop "Not reviewed"/date to hover. Header = "2 goals need attention" in orange. Lighten off `#0a0a0a`, drop card/row borders.
- **Even-simpler**: Largely chat-replaceable. Residue = short active-goals list + at-risk highlight. Merge with Todos + Calendar agenda.

## 4. Health

- **plugin / view id / file**: `@elizaos/plugin-health` / `health` (icon `Heart`, path `/health`) / `plugins/plugin-health/src/components/health/HealthView.tsx` (671 L). Decl: `plugins/plugin-health/src/index.ts:77`.
- **Purpose**: Glanceable sleep + circadian + rolling-baseline readout over a 7/14/30-day window.
- **Real or stub?** **Real.** 3 parallel GETs `/api/lifeops/sleep/history`, `/regularity`, `/baseline` (`:52-65`,`:531`); backed by `routes/sleep.ts`.
- **States**: loading (`:560`), error+Retry (`:575`), empty/disconnected (`:608`), populated (`:633`). Window-range fieldset (7/14/30) + Refresh persistent. No sub-tabs/modals/forms/detail.
- **Visual structure**: `HealthHeader` `<h1>Health</h1>` (`:341`) + always-on subtitle (`:367`); +2 help paragraphs in empty state (`:620`); **5 bordered cards** populated (LatestNight/Regularity/Baseline `:428-498` + Window summary `:649`); **20 label/value StatRow pairs** (6+5+4+4); 0 badges; 4 buttons (3 range + Refresh) + Retry; 1 fieldset. Evidence: `cardStyle` `:191` `border:"1px solid…"`; `containerStyle` `:169` `#0a0a0a`; subtitle `:368`.
- **Heaviness/slop**: 20 label/value stat rows = a spreadsheet, not a glance ("Source/Type/Confidence 87%/Samples 14/SRI/Bedtime spread/Wake spread" = diagnostic detail nobody glances at). 4-5 bordered cards. Always-on subtitle. Dark-first. Window-summary duplicates the other cards.
- **Minimize**: Collapse to ONE hero stat — last night's **duration** (huge `7h 42m`) + a colored regularity dot (orange irregular / blue regular). Bedtime/wake = one sub-line `23:10 → 06:52`. Delete Window-summary + Baseline cards from default (chat on demand). Kill borders/card bg; stat rows → icon+value chips. Drop subtitle. Regularity = single color, not the `REGULARITY_LABELS` text map (`:401`). Empty state → orange "Connect a source" CTA that calls `client.sendChatMessage` (Inbox does this at `:519`; Health currently just tells user to ask, weaker, `:625`). Proactive banner "You slept 1h less than baseline" instead of raw SRI.
- **Even-simpler**: Strong chat-first collapse. One big "last night" number + regularity color + 7-day strip; everything else is a chat question. 3 cards/20 rows are over-built.

## 5. Focus

- **plugin / view id / file**: `@elizaos/plugin-blocker` / `focus` (icon `ShieldOff`, path `/focus`) / `plugins/plugin-blocker/src/components/focus/FocusView.tsx` (557 L). Decl: `plugins/plugin-blocker/src/plugin.ts:42`.
- **Purpose**: Show whether a website/app block is active; let user release it.
- **Real or stub?** **Real fetch, stub-ish backend.** `GET /api/website-blocker` (`:50,380`) + `client.stopWebsiteBlock()` (`:60,400`). Per CLAUDE.md the `WebsiteBlockerService` still references plugin-lifeops. **Carries a DEAD back-compat path** (`schedule`/`activeSession` props → `OverrideView`, `:304-327,419`) retained "for back-compat with the original prop-driven stub" (`:19-23`).
- **States**: **6** — loading (`:423`), error+Retry (`:432`), unavailable (`:457`), permission (`:474`), active w/ chips+Release (`:504`), empty (`:549`). Plus the dead 7th `OverrideView` path (`:304`).
- **Visual structure**: `FocusHeader` `<h1>Focus</h1>` + Refresh; **up to 4 dim paragraphs** in permission state (`:480-497`); 1 card/state; N blocked-website **chips** (`:527`, bordered pills); Refresh + conditional Release. Evidence: `cardStyle` `:148`; `chipStyle` `:173`; permission block `:480-497`; `containerStyle` `:127` dark.
- **Heaviness/slop**: Dead `OverrideView`+`ScheduleList`+`ActiveSessionCard` back-compat (`:249-327`, props `:44-47`) = ~80 lines unreachable by the live path → **legacy removal target**. 6 states for a binary on/off concept; unavailable+permission+empty are 3 near-identical "not blocking" cards differing only in paragraph text. Permission state alone = 4 stacked sentences. Chip wall when many sites blocked. Dark bg.
- **Minimize**: Delete the entire override path (`:24-48,249-327,368,414-421`). Reduce to ONE giant shield: orange `ShieldOff` when active ("Blocking N sites · ends 16:00" + Release), gray when idle ("Not focusing"). Collapse unavailable/permission/empty into one idle state w/ orange CTA → `client.sendChatMessage("enable website blocking")` (replaces the 4 paragraphs). Blocked sites = count + color, list on tap/chat. Kill borders/card bg.
- **Even-simpler**: Lightest = a single status pill ("Focusing · 2 sites" / "Off") + one Release action — arguably mergeable into the chat overlay's own status area. Barely needs to be a full page (one boolean + one button).

## 6. Inbox

- **plugin / view id / file**: `@elizaos/plugin-inbox` / `inbox` (icon `Inbox`, "Cross-channel inbox triage", path `/inbox`) / `plugins/plugin-inbox/src/components/inbox/InboxView.tsx` (689 L). Decl: `plugins/plugin-inbox/src/plugin.ts:13`.
- **Purpose**: Unified cross-channel triage queue (email/X/Discord/Telegram/Signal/iMessage/WhatsApp/SMS).
- **Real or stub?** **Real fetch, PA-owned data.** `GET /api/lifeops/inbox?channels=` (`:78,541`); maps wire→flat `InboxItem` at boundary (`:111`). Route owned by plugin-personal-assistant (partly stub). Connect-a-channel → `client.sendChatMessage` (`:519`).
- **States**: loading (`:587`), error+Retry (`:597`), empty (`:631`, forks "no channels" + connect vs "inbox zero"), populated grouped-by-channel (`:672`). Channel-filter chip row persistent. No modals/detail — **rows are inert** (tapping does nothing).
- **Visual structure**: `InboxHeader` `<h1>Inbox</h1>` + Refresh; always-on subtitle (`:414`); **1 bordered card per channel group** (up to 8, `:479`); **every row `borderBottom`** (`:294-302`); per-group count badge (`:488`); unread `●` orange dot (`:460`); per-row channel-label meta tag (`:472`); Refresh + **8 channel-filter chips** (`:421-447`). Evidence: `rowStyle` `:294` borderBottom; 8-chip row `:436`; subtitle `:415`; container dark `:240`.
- **Heaviness/slop**: **8 always-visible channel chips** shown even when 1-2 channels connected and in empty/loading — biggest offender. Double nesting: bordered card per channel + per-row borderBottom. Per-group count + per-row channel meta = redundant (channel is already the group header). Always-on subtitle. Dark bg.
- **Minimize**: Flatten to ONE chronological list, no per-channel cards (drop `ChannelGroup` `:479,624`). Channel = small colored icon at row's left edge (replaces group card + meta tag). Hide channel chips by default (filter via chat "show only email", already agent-routable); if kept, render only **connected** channels (computed at `:550,620` but unused for pruning). Delete borders/bg/row dividers; unread orange dot is the only separator. Make rows actionable (reply/snooze/archive → chat). Top of list = agent triage suggestion ("3 need a reply, I drafted 2"). Drop subtitle + per-group count badge.
- **Even-simpler**: Mergeable — unread-count + top-3 preview could live inside the chat overlay; full list one tap away. Lightest = flat unread list with channel-color icons + chat-driven actions.

## 7. Contacts

- **plugin / view id / file**: `@elizaos/plugin-contacts` / `contacts` (icon `Users`, "Android address book — read-only contact lookup") / `plugins/plugin-contacts/src/components/ContactsAppView.tsx` (1455 L). Decl: `plugins/plugin-contacts/src/plugin.ts:21`.
- **Purpose**: Full-screen Android address-book overlay — search, browse, detail, create, import vCard.
- **Real or stub?** **Real.** `@elizaos/capacitor-contacts`: `requestPermissions`/`listContacts`/`createContact`/`importVCard` (`:116-124,178,206`); non-native short-circuits to empty (`:102`).
- **States**: `Mode = "list"|"detail"|"new"` (`:53,95`). list: loading (`:406`), first-run empty w/ SVG motif + import CTA (`:414`), no-match (`:437`), populated `<ul>` (`:447`). detail read-only panel (`:603`). new create-form (`:753`). error banner any-mode (`:350`).
- **Visual structure**: 1 sticky header w/ back + dynamic `<h1>` (`:270`); empty-state body paragraph (`:426); read-only explainer note (`:654`) "Editing existing contacts is unavailable on this device."; detail field-groups are bordered cards (`:736` `"rounded-xl border border-border/30 bg-bg-accent/40 px-4 py-3"`); ~5 border families (header `:270`, search `:330`, list `divide-y` `:448`); starred `Star` badge (`:584,617`); ~8+ buttons; search + 3 create inputs (`:822,845,866`) + hidden file input. **56-line hand-drawn `AddressBookMotif` SVG** (`:462-519`) for one empty state.
- **Heaviness/slop**: Decorative `AddressBookMotif` slop. Detail wraps phones/emails in bordered uppercase-labeled cards (`ContactFieldGroup` `:724`). Apologetic read-only note (`:654`). 10+ verbose `useAgentElement` `description` strings read like prose comments.
- **Minimize**: Delete `AddressBookMotif` (`:462-519`) — empty = one `Users` icon + one line + import action. Flatten detail: drop `ContactFieldGroup` cards/borders/uppercase labels; render avatar + name + flat icon+value rows (Phone/Mail icon = label) + inline call/text icons. Remove read-only note. Starred = orange `Star` (today amber `:586`); call = orange glyph, text = blue `#1d91e8`. New/import as the 2 agent-exposed actions; replace the 3-field form (`:753-904`) with chat intent ("add Jane, 555-1234").
- **Even-simpler**: Weakest standalone view (read-only lookup, no mutation depth). Should **merge into one Comms surface** (see Messages). Create/import → chat wholesale.

## 8. Phone

- **plugin / view id / file**: `@elizaos/plugin-phone` / `phone` (icon `Phone`, "Android dialer and recent-calls log") / `plugins/plugin-phone/src/components/PhoneAppView.tsx` (1281 L). Decl: `plugins/plugin-phone/src/plugin.ts:30`.
- **Purpose**: Full-screen dialer (number pad + place-call) + recent-calls log.
- **Real or stub?** **Real.** `@elizaos/capacitor-phone`: `requestPermissions`/`listRecentCalls`/`placeCall` (`:358-366,424`). Cross-view seed `consumePendingPhoneNumber()` (`:380`).
- **States**: `PhoneTab = "dialer"|"recent"` (`:61,337`). dialer: `<output>` display (`:623`), inline call-error (`:643`), 12-key pad + +/call/backspace. recent: error (`:724`), loading (`:729`), empty w/ icon + 2 CTAs (`:736`), populated `<ul>` (`:775`). Lazy-load guard (`:349,389`).
- **Visual structure**: header `<h1>Phone</h1>` + **subtitle** "Dialer and recent calls" (`:553`, redundant w/ tabs below); recent-empty paragraph (`:745`, long/apologetic permission explainer); recent rows = surfaced buttons (`:211`); 12 bordered dial keys (`:170`); call-type icon chips (`:218`); **~22 buttons**; 0 GUI inputs. Evidence: shell `:533`; header `:536`; dial key `:170` w/ inline border style; `defaultOverlayContext()` hardcodes `uiTheme:"light"` (`:68`).
- **Heaviness/slop**: Subtitle "Dialer and recent calls" duplicates the two tabs. Empty state = icon + heading + permission paragraph + 2 redundant buttons. Inline `onMouseEnter`/`Leave` hover hack on call button (`:685-690`).
- **Minimize**: Delete subtitle (`:553`). Collapse empty state to faint icon + "No recent calls."; permission as one inline pill only when denied; drop redundant Dialer/Refresh buttons. Call-type = color only (outgoing orange, incoming green, missed red; no text label). Borderless light dialpad, orange call button only; replace inline hover hack with design-system hover. Proactive: foreground who-to-call-now (missed call to return / scheduled call); push keypad behind one tap; "call Mom" via chat is primary.
- **Even-simpler**: Dialpad is the only unique thing and the least voice-forward element. Recent-calls is just a filtered comms log. **Fold into unified Comms** as a "calls" filter + behind-one-tap keypad.

## 9. Messages

- **plugin / view id / file**: `@elizaos/plugin-messages` / `messages` (icon `MessageSquare`, "SMS conversations via the Android Messages bridge") / `plugins/plugin-messages/src/components/MessagesAppView.tsx` (1202 L). Decl: `plugins/plugin-messages/src/plugin.ts:7`.
- **Purpose**: SMS inbox (thread list) + conversation pane + composer, over Android Messages bridge, w/ default-SMS-role flow.
- **Real or stub?** **Real.** `@elizaos/capacitor-messages`+`capacitor-system`: `getStatus`/`requestPermissions`/`listMessages`/`sendSms`/`requestRole({role:"sms"})` (`:286-296,369,385`); threads derived client-side `buildThreads()` (`:326`); seed `consumePendingMessageRecipient()` (`:315`).
- **States**: `showComposer` toggles thread-list vs composer (`:276,587`). thread-list: loading (`:594`), empty w/ SVG motif + stat chips + CTA (`:598`), populated w/ stats header + thread buttons (`:656`). composer: conversation bubbles (`:738`) or "Start a text" placeholder (`:780`); plus "Select a conversation" placeholder (`:829`). SMS-role banner (`:534`). error/notice banner (`:572`).
- **Visual structure**: sticky header `<h1>` + subtitle (`:496`); **second in-list header block** (`:658-694`) w/ icon tile + `<h2>Messages</h2>` + **3 StatChips**; 4+ explanatory paragraphs (empty `:609`, role banner `:540`, compose placeholder `:789`, select-conv `:838`); SMS-role banner full bordered panel (`:534`); `StatChip` component (`:78-104`) used 5× ("N threads/N unread/timestamp/Default SMS app"); per-thread timestamp pill (`:181`) + unread badge (`:192`); ~6 border families; address `Input` (`:722`) + body `Textarea` (`:802`). **33-line `ChatBubblesMotif` SVG** (`:106-140`). Evidence: thread row `:166` `border-b border-border/16`; StatChip `:89` pill; notice `:576`.
- **Heaviness/slop**: 1202 lines; populated list carries a **redundant second header** (icon tile + `<h2>` re-saying "Messages" + 3 StatChips) = single heaviest cuttable block. `StatChip` badge factory for counts that don't need badges. Decorative `ChatBubblesMotif`. Two separate "nothing selected" placeholders (`:780`,`:829`) each w/ icon+heading+paragraph. SMS-role banner = heavyweight bordered explainer. Header subtitle dup'd role state. Hand-rolled hover on empty CTA (`:645`).
- **Minimize**: Delete in-list stats header (`:658-694`). Delete `StatChip` (`:78-104`) + all 5 uses (unread already = per-thread orange badge `:192`). Delete `ChatBubblesMotif` (`:106-140`). Merge the 2 empty placeholders into one, strip paragraphs. Collapse SMS-role banner to a single inline pill ("Set default SMS"), shown only when not held. Drop header subtitle → small orange `ShieldCheck` icon. Sent/received bubbles already accent vs surface (`:749`) — recolor sent orange, drop timestamp pill bg. Thread row = avatar + name + snippet + time + unread dot (already mostly there). Composer overlaps the floating chat — sending SMS should be a chat intent ("text Sam: running late"), making the dedicated textarea redundant.
- **Even-simpler**: **Natural anchor for a single unified Comms surface.** Threads/calls/contacts are the same primitive (person + history + action). A merged Comms view = one searchable list of people/threads (SMS + calls interleaved) → tap → timeline w/ inline call/text/email; all composing/dialing/lookup pushed into chat.

## 10. Companion

- **plugin / view id / file**: `@elizaos/plugin-companion` / `companion` (icon `Bot`, "VRM avatar companion") / `plugins/plugin-companion/src/components/companion/CompanionView.tsx` (419 L). Decl: `plugins/plugin-companion/src/plugin.ts:16`.
- **Purpose**: 3D VRM avatar overlay — just the avatar scene + emote picker.
- **Real or stub?** **Real.** Hosts `CompanionSceneHost` (Three.js VRM engine) + `EmotePicker`. Already deliberately minimal — header comment (`:12-17`): "the companion now shows just the avatar — no header / nav bar … chat/voice happen in the global floating pill … character + settings live in the main app's own tabs."
- **States**: scene loading vs `avatarReady` (`:22`, `useCompanionSceneStatus`); emote picker open/closed (`EmotePicker`).
- **Visual structure**: avatar scene fills the view (`pointerEvents:"none"` overlay). One top-left **status chip cluster** (`:41-72`): `StatusChip` (ready/loading) + 3 `CompanionChip`s ("N emotes", "N/M catalog", "overlay relay") in a blurred translucent pill. Evidence: chip cluster `:41-59` (`border:"1px solid var(--border)"`, `backdropFilter:"blur(12px)"`, `boxShadow`).
- **Heaviness/slop**: The GUI view is already very light and on-direction (avatar + chat in the floating pill — exactly the redesign). The only slop is the **top-left status chip cluster** (`:41-72`): "N emotes / N/M catalog / overlay relay" are devtools-flavored info nobody needs at a glance.
- **Minimize**: Keep the bare avatar + floating-pill chat (the model for the whole redesign). Reduce the status cluster to a single small `ready`/`loading` dot (orange loading → success when ready); drop "N emotes / catalog / overlay relay" chips (`:63-71`). Emote picker is fine as the one view-dependent action.
- **Even-simpler**: Already near-minimal; the avatar IS the view. Could drop the status chips entirely (the avatar appearing is its own "ready" signal). Not mergeable/removable — it's the companion identity surface.

## 11. LifeOps (Personal Assistant)

- **plugin / view id / file**: `@elizaos/plugin-personal-assistant` / `lifeops` (icon `Sparkles`, "Personal assistant workspace for briefs, approvals, schedule repair") / `plugins/plugin-personal-assistant/src/components/LifeOpsPageView.tsx` (149 L). Decl: `plugins/plugin-personal-assistant/src/plugin.ts:753`.
- **Purpose**: Supposed assistant workspace for briefs / approvals / schedule repair / owner ops.
- **Real or stub?** **PURE STUB / SCAFFOLD.** This is a hardcoded placeholder, NOT real. The `<h1>` literally reads `"LifeOpsPageView"` (`:65`). Everything is static fake copy: `PANEL_COPY`/`WORKSPACE_CARDS`/`OPERATING_CHECKS` are hardcoded string arrays (`:6-51`). The input is a dead `draft` useState that goes nowhere (`:55,96-105`). "Refresh view" just `setActivePanel("brief")` (`:74`). The 3 panel buttons only swap a copy string (`:81-94`). `data-testid="lifeops-dynamic-view-fallback"` (`:61`) — it's the fallback render. Note: PA's own CLAUDE.md says "**No views — the domain views moved to per-domain plugins**" — so this file is leftover scaffold that contradicts the documented state.
- **States**: activePanel brief/approvals/schedule (swaps `PANEL_COPY` text only). No loading/error/empty/data — there is no data fetch at all.
- **Visual structure**: 1 outer `rounded-lg border border-border bg-card p-6` section (`:60`); `<h1>LifeOpsPageView</h1>` (`:65`) + descriptive paragraph (`:66-69`) + "Refresh view" button (`:71`); 3 panel buttons (`:81`); panel copy paragraph (`:94`); 1 dead input (`:98`); **6 `WORKSPACE_CARDS` bordered divs** each w/ `<strong>` title + muted detail paragraph (`:107-117`, `"rounded-md border border-border p-3"`); 1 "Operating checks" sub-section (`:119`) w/ 5-item bulleted list of prose (`:45-51`). Essentially all text and borders, no real data, no icons.
- **Heaviness/slop**: This is the single worst slop offender in the set — a 100% fake scaffold. 11 hardcoded descriptive strings, 6 fake cards, a dead input, dead buttons, a `<h1>` printing the component name. It violates the redesign on every axis (all text, all borders, no icons, no data, no chat integration) AND contradicts PA's documented "no views" state.
- **Minimize**: **Delete the entire fake body.** LifeOps should either (a) be removed as a view (PA CLAUDE.md says domain views moved to per-domain plugins — Todos/Inbox/Goals/Health/Calendar/Documents/Blocker/Relationships already exist), or (b) become a real glanceable **daily brief** surface backed by the existing `BRIEF` action + `lifeops`/`pendingPrompts` providers (`/api/lifeops/overview`): a single proactive summary ("3 approvals waiting, 1 conflict at 2pm, morning brief ready") with each line tappable into chat. No cards, no descriptions, no dead input.
- **Even-simpler**: **Strong removal candidate.** It's a stub that duplicates the per-domain plugins. If kept, it should be the agent's proactive "what needs you now" digest (chat-first), not a static workspace. The dead `draft` input and 6 fake cards should not exist.

## 12. Documents

- **plugin / view id / file**: `@elizaos/plugin-documents` / `documents` (icon `FileText`, "Browse and search the document store") / `plugins/plugin-documents/src/components/documents/DocumentsView.tsx` (679 L). Decl: `plugins/plugin-documents/src/plugin.ts:110`.
- **Purpose**: Read-only browser + semantic search over the agent's document store.
- **Real or stub?** **Real.** 3 GETs via `fetchers` seam (`:88-98`): `/api/documents?limit=100&offset=0`, `/api/documents/stats`, `/api/documents/search?q=`. Real `PresentedDocument` fields. Refresh + search agent-instrumented (`:319,351`).
- **States**: 4 load states (`:504`): loading (`:589`), error+Retry (`:598`), empty (`:623`), populated (`:638`). Nested 4-state search machine (`:509`): idle/searching (`:660`)/error (`:664`)/results (`:669`). No modals/detail/sub-tabs.
- **Visual structure**: `DocumentsHeader` `<h1>Documents</h1>` + Refresh (`:383`); subtitle (`:398`) + empty paragraph (`:629`); up to 3 cards (stats + search-result + list); `cardStyle` border (`:245`) + per-row `borderBottom` (`:280`); 0 badges; 3 buttons (Refresh/Search/Retry); 1 search input; 2 `<ul>`. **Title appears twice** — `<h1>` (`:395`) AND list-card `<h2>Documents</h2>` (`:438`). Evidence: `containerStyle` `:212` `#0a0a0a`; `cardStyle` `:242`; `rowStyle` `:274` borderBottom.
- **Heaviness/slop**: Hardcoded `#0a0a0a`. "Documents" title duplicated (h1 + h2). Filler subtitle. List inside a bordered card w/ redundant heading + row dividers = 3 layers of separation for a flat list. Stats compete as a separate text row.
- **Minimize**: Drop subtitle (`:398`). Remove duplicate `<h2>` (`:438`); render `<ul>` flat, no card/border. Fold stats into header as small dim count beside the title. Per-row borders → whitespace. Lighten off `#0a0a0a`. Search input+button redundant (Enter searches `:371`) — drop button, or route search via chat ("search my docs for X", already agent-instrumented).
- **Even-simpler**: Legitimately glanceable, should stay, but heavily chat-replaceable: drop the search input+button, reduce to a glance list (filename · type · date) + counts in header; search via floating chat.

## 13. Relationships

- **plugin / view id / file**: `@elizaos/plugin-relationships` / `relationships` (icon `Users`) / `plugins/plugin-relationships/src/components/relationships/RelationshipsView.tsx` (711 L). Decl: `plugins/plugin-relationships/src/plugin.ts:35`.
- **Purpose**: Read-only viewer of the entity/relationship knowledge graph.
- **Real or stub?** **View real; data largely STUBBED.** Fetches `/api/lifeops/entities` + `/relationships` (`:105`), joins to nodes (`:155`). BUT the plugin's `ENTITY` action + `ENTITY_GRAPH` provider are explicit stubs (per CLAUDE.md "Action and provider handlers are stubs") and the routes are served by personal-assistant. In a fresh agent it renders **empty**. Add-person → chat (`:548`).
- **States**: 4 load states (`:543`): loading (`:623`), error+Retry (`:633`), empty (`:662`), populated (`:692`); filter-miss sub-empty (`:702`). kind-filter chips persistent (`activeKinds` `:562`). No modals/detail/forms.
- **Visual structure**: `RelationshipsHeader` `<h1>Relationships</h1>` + Refresh (`:449`); subtitle (`:464`) + empty paragraph (`:671`); **one bordered card per entity** (`EntityCard` `:510`, unbounded — 50 people = 50 stacked cards); per-edge `borderBottom` (`:345`); 1 uppercase orange `kindBadge` per card (`:370,521`); filter chip per entity kind (`:486`). Evidence: `cardStyle` `:313`; `kindBadgeStyle` `:370` orange uppercase; `containerStyle` `:283` `#0a0a0a`; `edgeRowStyle` `:345`.
- **Heaviness/slop**: "One bordered card per entity" doesn't scale → wall of nested boxes (card → header → orange uppercase badge → identity → bordered edge rows). Dark bg. Filler subtitle. Orange badge stamped on every card (orange should be accent, not per-row). Kind-filter chips render for ALL kinds even at zero count → dead toggles. 2-sentence empty copy.
- **Minimize**: Replace per-entity cards with a flat list: name (bold) · kind (small dim, not orange badge) · identity · edge count. Drop card border/bg. Demote `kindBadge` to dim gray or small icon (reserve orange for active filter). Collapse each entity's edges behind a count ("4 relationships"), expand on demand. Drop subtitle; one-line empty + existing "Add someone" chat CTA. Render kind chips only for kinds with entities, or filter via chat. Lighten off `#0a0a0a`.
- **Even-simpler**: Data layer is a stub today → strong chat-first candidate. Add-person already → chat; filtering agent-addressable. Minimal = glance list of names the agent knows; "who is X / how do I know Y / add Z" in chat. **Overlaps conceptually with contacts** — confirm it isn't duplicating a contacts surface.

## 14. Feed

- **plugin / view id / file**: `@elizaos/plugin-feed` / `feed` (icon `Gamepad2`, "Feed prediction market operator dashboard") / `plugins/plugin-feed/src/components/FeedView.tsx` + `FeedSpatialView.tsx`. Decl: `plugins/plugin-feed/src/index.ts:6`.
- **Purpose**: Operator dashboard to spectate-and-steer an autonomous agent trading the Feed prediction-market game.
- **Real or stub?** **Real, most data-dense.** `loadDashboard` fires **10 parallel client calls** (`:213-235`): status/summary/goals/trades/markets/team dashboard/team conversations/chat/wallet/balance; polls 12s (`:272`). Toggle-autonomy + suggested-prompt buttons agent-instrumented (`:197,113`) → `controlAppRun`/`sendAppRunMessage`.
- **States**: no-run → `WaitingForSession` hero w/ 4 idle stat chips (`:325`); populated → full dashboard. loading/sending/statusMessage → "Refreshing…/Ready" footer (`:611`). Parameterized by `variant` (detail/live/running `:180`) + `focus` (all/chat/dashboard `:186`). No modals; "detail panels" are `SurfaceSection` blocks.
- **Visual structure**: Historical note: the old Feed chrome used a 34vh dark image hero, stat strip, and multiple card sections. Current code uses `FeedView` as the GUI data wrapper and `FeedSpatialView` as the shared presentational surface.
- **Heaviness/slop**: Dense operator/game surface, not a glance view. 34vh dark image hero contradicts "lighter feel" hardest. 4 sections w/ 12+ subtitled cards >> essential. 3 status badges + "N active runs" = clutter. Steering via preset prompts (chat is for this). 10 fetches / 12s poll / 3 variants / 2 focus modes = heavy by nature.
- **Minimize** (within operator role): Replace 34vh image hero w/ a slim title + status-pill bar. Collapse 4 sections into the stat strip (Agent/Portfolio/Markets/Wallet) + one expandable detail. Cut 3 status badges to one health dot. Remove preset suggested-prompt buttons → floating chat. Drop the "Refreshing…/Ready" footer (`:616`).
- **Even-simpler**: **FLAG — does not belong in a productivity/lifeops assistant.** Crypto prediction-market GAME operator surface (autonomous trading/PnL/wallets, `Gamepad2`). Almost entirely chat-replaceable ("how's my Feed agent / pause it / what markets are live"). Recommend excluding it from the default lifeops view set; keep only for users who install the Feed game.

---

## SUMMARY TABLES

### Real vs Stub
| View | Status |
|---|---|
| Calendar | **Real** (full CRUD) |
| Todos | **Real**, read-only (writes → chat) |
| Goals | **Real**, read-only; sibling routines/reminders/alarms backends are scaffold_stub |
| Health | **Real** |
| Focus | **Real** fetch; backend stub-ish (references plugin-lifeops); carries a DEAD back-compat override path |
| Inbox | **Real** fetch; PA-owned data partly stub |
| Contacts | **Real** (native bridge) |
| Phone | **Real** (native bridge) |
| Messages | **Real** (native bridge) |
| Companion | **Real** (Three.js VRM) |
| **LifeOps** | **PURE STUB** — hardcoded fake copy, dead input/buttons, `<h1>LifeOpsPageView</h1>` |
| Documents | **Real** |
| **Relationships** | View real but **data layer stubbed** (renders empty in fresh agent) |
| Feed | **Real** (10 fetches) |

### Worst slop offenders (ranked)
1. **LifeOps** — 100% fake scaffold; all text/borders/dead controls; contradicts PA's documented "no views".
2. **Feed** — 34vh dark image hero, 4 sections / 12+ cards, 3 status badges, preset-prompt steering.
3. **Comms trio (Contacts/Phone/Messages)** — large GUI files with 2 decorative SVG motifs, redundant headers (Messages has THREE), and heavy permission prose.
4. **Calendar** — ~2300 lines reimplementing a desktop calendar; per-hour/per-column line grid; 1005-line CRUD drawer.
5. **Inbox** — 8 always-on channel chips + double-nested cards.
6. **Goals** — redundant status grouping AND status chips; 26-line CSS for filter pills.

### Highest-impact simplifications
- **Single light token set** replacing the 7× duplicated inline `#0a0a0a` dark themes. One change, lightens everything.
- **Delete the LifeOps stub** (or rebuild as a chat-first daily brief from the existing `BRIEF`/`lifeops`/`pendingPrompts` providers).
- **Keep retired renderer cleanup complete**; do not reintroduce blue terminal twins.
- **Calendar → AgendaView default + chat-driven editing**, deleting the 1005-line `EventEditorDrawer`.
- **Replace per-item bordered cards with flat lists** (Relationships, Inbox channel groups, Health stat cards).
- **Convert status/type to color** (todo overdue, call direction, goal at-risk, regularity, unread) instead of text labels + badges.
- **Delete all always-on subtitles** (8 views) and decorative SVG motifs (2).
### Mergeable / removable / replaceable-by-chat
- **MERGE Contacts + Phone + Messages → one unified Comms surface** (people/threads list, tap→timeline, inline call/text, keypad behind one tap, composing/dialing/lookup via chat). Highest-value merge.
- **MERGE Todos + Goals + Calendar-agenda → one "Today / what-needs-me-now" surface** (chat-driven mutation).
- **REMOVE LifeOps stub** — duplicates the per-domain plugins; rebuild only as a proactive brief if anything.
- **REMOVE Feed from the default productivity view set** — crypto/game operator surface, wallet-gated, out of scope; keep opt-in for those games only. It is nearly fully chat-replaceable.
- **Relationships** — strong chat-first candidate (data stubbed today); confirm it isn't duplicating Contacts.
- **Focus** — could collapse to a single status pill in the chat overlay's status area (one boolean + one button); barely needs to be a full page.
- **Documents** — keep (legit glanceable) but drop the search input/button in favor of chat search.
- **Companion** — keep as-is (it's the redesign model); only trim the top-left status chip cluster.
