# LifeOps Access UX Review

## Scope

This writeup covers the LifeOps setup/access surface after the earlier cleanup requests:

- Remove the macOS permission checklist from Settings.
- Remove the X post-writing UI and keep only connection state plus actions.
- Remove stretch reminder setup from Settings.
- Keep all visible information real, live, and sourced from the existing hooks or API responses.
- Reduce headers, explanatory copy, repeated labels, and diagnostic panels that make setup feel like an internal console.

The captured setup screenshot showed a single Access page containing account setup, device data, browser companion setup, messaging connectors, sleep and schedule diagnostics, capability diagnostics, and X connection state. The biggest issue is not that any one block is impossible to understand. The issue is that the page mixes user-facing sources with implementation details, which makes the user scan too much text before learning what is connected.

## Target Model

The Access page should behave like a source-health console:

- Each row is a real data source or external account.
- Each row answers "connected, blocked, loading, or unavailable."
- Each row exposes the next action only when an action is useful.
- Details are hidden behind disclosure controls when they are real but secondary.
- Debugging and derived LifeOps state stay on their domain pages.

This follows a common pattern in Apple Settings, Google Account connected-apps/security pages, Slack and Notion integration settings, Linear's integrations pages, and GitHub account settings: the primary page is a status list with compact actions; implementation details, permissions, scopes, and diagnostics live one click deeper.

## Screenshot Description: Current Setup Page

The current setup screenshot begins with an `Access` heading and two full-width actions: `Run setup again` and `Disable LifeOps`. The page then shows `Accounts`, a large `Device Data` card, two Google account sections for User and Agent, a `Your Browser` panel, a `Messaging` heading with five connector rows, then Sleep and schedule, Capabilities, and X panels.

What is really there:

- `Access`: page-level controls for the LifeOps app.
- `Run setup again`: reopens the onboarding/setup gate.
- `Disable LifeOps`: turns off the LifeOps app integration.
- `Device Data`: platform-level mobile or desktop device-signal availability.
- `User Google`: owner-side Google OAuth connection, calendar feed selection, and GitHub owner connection.
- `Agent Google`: agent-side Google OAuth connection, calendar feed selection, and GitHub agent connection.
- `Your Browser`: browser companion install, pairing, settings, and profile status.
- `Messaging`: Signal, Discord, WhatsApp, Telegram, and iMessage connector status.
- `Sleep and schedule`: derived sleep model state and manual sleep overrides.
- `Capabilities`: internal capability health.
- `X`: owner and agent X OAuth status.

What is weak:

- The page asks the user to understand internal categories: capabilities, sleep model, browser companion packages, manual pairing, scopes, and calendar-feed side effects.
- It repeats labels. For example, Google appears under User/Agent, then GitHub appears inside each side, then there is a separate Messaging heading.
- It exposes empty setup controls. Telegram displayed a phone input even when the user had not chosen to connect it.
- It makes Settings look like a debug tool. Sleep, schedule, and capability health are useful, but they are not setup primitives.
- It uses too much explanatory copy on the primary path. Text should appear when the state is degraded, blocked, or expanded.

## Element Review

### Access Header

What it does:

- Names the page and hosts page-level actions.
- `Run setup again` is a recovery path for users who skipped onboarding or need to reconnect multiple sources.
- `Disable LifeOps` is the irreversible app-level off switch.

Why it should be there:

- The user needs a stable page-level control for setup recovery and disabling.
- It is the only place where `Disable LifeOps` belongs because it affects the whole app, not one source.

Does it need to be there:

- Yes, but it should stay compact. It should not explain LifeOps again because the user already chose the LifeOps app.

Alternative approaches:

- A kebab menu could hide `Run setup again` and `Disable LifeOps`, but this makes destructive controls less discoverable.
- A bottom sticky action area would waste space and compete with mobile navigation.

External patterns:

- Apple Settings keeps destructive app toggles close to the app settings page.
- Google Account pages keep security/recovery actions visible but visually separated from connected app rows.

Responsive constraints:

- On narrow screens, the two buttons stack full width so text never truncates inside fixed-width controls.
- On wider screens, they can sit to the right of the page title.

### Device Data

What it does:

- Shows whether device signals are available in the current runtime.
- On native mobile it can request or refresh permissions.
- On desktop or web it shows the runtime class, such as Web or Desktop.

Why it should be there:

- Device signals feed sleep, screen time, presence, and context.
- The status is real and comes from native permission APIs when available.

Does it need to be there:

- Yes, as a source row. It should not show the old macOS permission checklist because that checklist was generic and redundant.

Alternative approaches:

- Move device permissions into global Eliza Settings. This is clean for platform permissions, but LifeOps still needs a source health row so users know whether device data is available to LifeOps.

External patterns:

- Apple Privacy settings show permission classes as rows with status, not explanatory setup cards.
- Android Digital Wellbeing and Screen Time surface device access as an app-level dependency, then put the permission-specific details deeper.

Responsive constraints:

- The row must tolerate no action buttons, one action, or multiple native actions.
- It should not leave a large empty content area when the platform has nothing to request.

### User Google

What it does:

- Shows the owner-side Google account identity.
- Lets the user connect, reconnect, add, or disconnect Google.
- Lets the user choose cloud-managed or local mode.
- Shows connected account grants and calendar feed inclusion when expanded.

Why it should be there:

- Google is the main source for calendar and Gmail.
- Owner-side Google is distinct from agent-side Google because the account permissions and automation identity differ.

Does it need to be there:

- Yes. It is one of the core LifeOps sources.

Alternative approaches:

- Combine User and Agent into one `Google` block with tabs. That is cleaner on desktop but worse on mobile because the user would need to switch context to compare owner and agent.
- Show only one Google row and infer agent access from the owner account. That hides an important authority boundary.

External patterns:

- Google Account's third-party access view separates account identity, app authorization, and permission scope.
- Slack integration settings show connected identity and workspace-specific action buttons in the same row.

Responsive constraints:

- The mode segmented control must wrap below the identity on mobile.
- The identity must truncate safely because Google names and emails can be long.
- Calendar feed selection should be behind a disclosure because it is useful but secondary.

### Agent Google

What it does:

- Shows the agent-side Google account or cloud-agent availability.
- Uses the same connect/add/disconnect pattern as User Google.
- Keeps agent authority visually separate from owner authority.

Why it should be there:

- Agent actions may need a separate identity from the user's own Google account.
- Users need to understand whether LifeOps will act as them or through an agent-owned account.

Does it need to be there:

- Yes, if agent automation can use a distinct Google account.

Alternative approaches:

- Hide Agent Google until the user enables agent-side automation. This reduces first-run complexity but risks confusing users when an automation later fails due to missing agent permissions.

External patterns:

- GitHub and Slack distinguish user tokens from app/bot tokens because they act with different authority.
- Notion integrations separate personal account identity from workspace integration access.

Responsive constraints:

- It should use the same row grammar as User Google so users compare status quickly.
- It should not duplicate explanatory text already implied by the row title and status badge.

### GitHub Rows

What they do:

- Show owner and agent GitHub connection identity.
- Provide connect, reconnect, or disconnect actions.

Why they should be there:

- GitHub is an account source used by LifeOps for developer workflows.
- It belongs close to User/Agent account identity because it follows the same authority split.

Does it need to be there:

- Yes, while LifeOps exposes GitHub-based workflows.

Alternative approaches:

- Make GitHub a separate top-level row. This is clearer if GitHub becomes a major data source. For now, it is lighter as a sub-row under User/Agent authority.

External patterns:

- GitHub's own OAuth app settings list app identity, scope, and revoke action, with details secondary.
- Linear and Slack show integration connection state with one primary action.

Responsive constraints:

- The identity must truncate.
- Action buttons wrap so long labels never collide with the identity.

### Browser Profiles

What it does:

- Shows browser companion status.
- Lets users refresh status.
- Lets users expand into connected profiles, install actions, manual pairing, and advanced rules.

Why it should be there:

- Browser context is essential for Discord DMs, screen context, and owner-side web activity.
- Browser setup is complicated enough to require details, but those details should not be primary page content.

Does it need to be there:

- Yes, but only the status row needs to be visible by default. Install/build/manual pairing details are secondary.

Alternative approaches:

- Move browser companion setup into global Settings and show only a read-only status in LifeOps. That is clean long-term, but LifeOps still needs an immediate repair path when Discord or browser-derived context is blocked.
- Use a modal wizard for install and pairing. This would be more polished but adds modal complexity and requires state persistence for partially complete installs.

External patterns:

- Chrome Extension settings hide site access and incognito details behind extension-specific pages.
- Slack and Notion keep integration install details behind a `Manage` or expanded details page.

Responsive constraints:

- The visible row should not include install instructions.
- Expanded browser profile details should remain one column on mobile.
- Long local paths must truncate and never stretch the page.

### Signal

What it does:

- Shows Signal linked, pairing, or disconnected state.
- Starts QR pairing when not connected.
- Shows the linked phone number only after connection.

Why it should be there:

- Signal is a direct messaging source.
- QR pairing is the real connection flow, so the QR surface is justified only during pairing.

Does it need to be there:

- Yes, if Signal is supported.

Alternative approaches:

- Hide Signal until its service is available. That reduces noise but makes users wonder why a supported source is absent.

External patterns:

- WhatsApp Web, Signal Desktop, and Telegram Desktop all use a compact status row that expands into QR/code state only during pairing.

Responsive constraints:

- QR images need fixed dimensions so they do not resize the page unpredictably.
- Buttons should remain reachable below the QR on narrow screens.

### Discord

What it does:

- Shows whether LifeOps can see Discord DMs.
- Uses browser access state to guide the next action: connect browser, open Discord, open DMs, or log in.
- Shows visible DM labels only when the DM inbox is visible.

Why it should be there:

- Discord is not just an OAuth connector. It depends on real browser or desktop browser state.
- The most useful status is whether the DM inbox is visible, not whether a backend connector flag exists.

Does it need to be there:

- Yes, because the social page depends on Discord browser capture.

Alternative approaches:

- Put Discord entirely under the Social page. This is semantically clean, but setup failures would be harder to repair from Access.
- Use a browser-only `Social capture` row instead of a Discord row. This is scalable if multiple websites share the same capture system, but the user expects Discord-specific status.

External patterns:

- Slack and Discord app settings emphasize workspace/account connection state first, then channel or DM access second.
- Chrome permission UIs separate extension pairing from site access, which maps well to the current `Your Browser` plus `Discord` split.

Responsive constraints:

- The status label may be long when it includes a next action. It must truncate in the row and keep the action button on the next line if needed.
- Browser access diagnostics should only appear when DMs are not visible.

### WhatsApp

What it does:

- Shows WhatsApp Business Cloud API configuration state.
- Opens setup guidance or refreshes status.
- Shows phone number ID when configured.

Why it should be there:

- WhatsApp is a messaging source, but its setup is API/config driven rather than user OAuth.

Does it need to be there:

- Yes, if WhatsApp is a supported connector. It should not show long inbound/outbound webhook explanations on the primary page.

Alternative approaches:

- Move WhatsApp to a developer/admin settings section. That may be better if the target user is not expected to configure Business Cloud API credentials.

External patterns:

- Meta Business settings expose phone number ID, webhook health, and action buttons but keep setup docs linked out.

Responsive constraints:

- Phone number ID is long and must wrap or truncate.
- The setup guide button should be the only primary call to action when disconnected.

### Telegram

What it does:

- Shows Telegram connection/auth state.
- Starts login only after the user clicks Connect.
- Shows phone/code/password fields only during the active login flow.

Why it should be there:

- Telegram is a messaging source, but the phone number field is sensitive and visually heavy.
- A blank phone input should not be visible until the user intentionally starts the flow.

Does it need to be there:

- Yes, but the field-level flow should be progressive.

Alternative approaches:

- Use a modal login wizard. This would be cleaner if Telegram auth grows more steps.
- Put Telegram login in a separate detail page. That is more scalable but adds navigation overhead for a short flow.

External patterns:

- Telegram Desktop and WhatsApp Web start with one connect action, then reveal QR/code entry only while pairing.
- Google and Slack OAuth flows do not show credential-like inputs until the user begins authentication.

Responsive constraints:

- Phone/code/password fields and action buttons must wrap vertically on mobile.
- The status row should remain compact before Connect is clicked.

### iMessage

What it does:

- Shows iMessage bridge availability.
- Offers local Mac setup actions when possible.
- Shows degraded send path and full disk access controls only when relevant.

Why it should be there:

- iMessage is a high-value local-first source, but its backend availability is platform-dependent.

Does it need to be there:

- Yes, because users need to know whether the local bridge is available.

Alternative approaches:

- Move detailed BlueBubbles/imsg setup to a platform-specific settings page and leave only a status row in Access.
- Use a wizard for Mac setup. That is better long-term but unnecessary for the current cleanup.

External patterns:

- Apple Continuity, Messages forwarding, and device handoff settings show device availability as concise rows, with error details only when blocked.

Responsive constraints:

- Setup buttons must wrap.
- Diagnostics should be shown only when they are actionable.
- Local file paths and implementation labels should not appear unless expanded or needed for troubleshooting.

### X

What it does:

- Shows owner and agent X connection state.
- Provides connect/reconnect actions.
- Shows pending auth link and errors when present.

Why it should be there:

- X is an account source. The user asked to remove post writing and keep only connection/status.

Does it need to be there:

- Yes, while X is a supported account connector. The composer does not belong in Settings.

Alternative approaches:

- Move X into Social setup. That is reasonable if X is only used by the Social page.
- Keep it in Access as an account source. This is better while setup is centralized.

External patterns:

- Twitter/X developer and OAuth app settings show connected identity and revoke/reconnect actions, not posting UI.
- Slack and Notion integration pages keep content creation out of integration settings.

Responsive constraints:

- Owner and Agent boxes should stack on mobile and sit side-by-side on wider screens.
- Scope/provider badges are not needed on the primary surface.

### Removed Sleep And Capability Panels

What they did:

- Sleep and schedule showed derived sleep state, awake probability, baselines, manual overrides, rule firings, and observations.
- Capabilities showed internal capability health.

Why they were removed from Access:

- They are not connection sources.
- They are dense derived data, better suited to the Sleep page or developer diagnostics.
- Showing them in setup made Access feel unreliable because loading diagnostics appeared before the user had any connected sources.

Where they should live:

- Sleep history, cycles, baselines, sources, rule firings, and manual overrides belong on the Sleep page.
- Capability health should either become an internal diagnostics detail or a compact source health summary only when it blocks user-facing features.

Alternative approaches:

- Keep one `Diagnostics` disclosure on Access. This is defensible for debug builds but should not be default production UX.

External patterns:

- Apple Health and Screen Time put models, history, and charts on their domain pages, not in account setup.
- Linear and GitHub status pages expose service health separately from integration setup.

Responsive constraints:

- Removing these panels reduces vertical scroll and keeps Access usable in the current split workspace with bottom navigation and optional chat pane.

## Dashboard And Other Section Guidance

The same source-health principle should extend beyond setup:

- Dashboard should start with live outcomes: today, next event, unread urgent threads, sleep state, screen time anomaly, reminders due. It should not explain LifeOps.
- Sleep should show history first: timeline, episodes, cycles, wake/bed trends, contributing evidence, and all observations. Raw rules should be expandable.
- Social should present browser/app/screen-time capture as a pipeline: source availability, last capture, account/session, and visible conversations. It should not rely on placeholder social data.
- Messages and email should be threaded. The primary object should be a conversation or email chain, not individual messages.
- Calendar should support direct manipulation: click to inspect, right-click/context menu to edit, duplicate, delete, convert to reminder, or open source calendar. The editor modal must close reliably.
- Reminders can be integrated into Calendar if they are time-bound. Use a distinct color/key and a filter. Untimed reminders need a lightweight list or agenda lane.

## Responsive System

Breakpoints:

- Mobile: one column. Source rows stack; controls wrap below identities; no fixed two-column subpanels.
- Tablet: account rows can become two columns if both columns have stable minimum widths.
- Desktop: the page can use two columns for comparable sources, but details should remain collapsed by default.
- Split workspace/chat: the page must still fit when the chat pane is open and the content width is closer to tablet than desktop.

Rules:

- No primary surface should depend on a long paragraph.
- Status labels must truncate, not resize buttons.
- Long account identities, handles, local paths, phone IDs, calendar IDs, and browser profile labels must truncate or wrap inside the row.
- Empty states should be compact and action-oriented.
- Error text should appear only where it affects the source.

## Implementation Decisions

Implemented high-confidence changes:

- Access no longer renders Sleep and schedule or Capabilities panels.
- Browser companion setup is collapsed behind `Browser profiles`; the visible row shows real status and refresh.
- Google User and Agent were restyled as compact account rows with status badges, identity, mode, actions, and collapsed calendar feed controls.
- The redundant `Accounts` and `Messaging` headings were removed.
- Messaging connectors now render as compact source rows.
- Telegram no longer shows a phone input until the user clicks Connect.
- Telegram test-send verification UI was removed from the primary setup surface.
- WhatsApp and iMessage primary copy was reduced to real status and actions.
- X was reduced to connection/status and actions, with scope/provider badges removed from the primary surface.

Remaining recommended work:

- Add a first-screen dashboard redesign around live outcome cards and source health.
- Move sleep diagnostics into a richer Sleep history page.
- Convert messages and mail into thread-first views.
- Add calendar event context menus and repair the event editor close path.
- Decide whether Reminders belongs as a Calendar lane, a separate section, or both.
