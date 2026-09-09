# Local developer workspace

This opt-in technical surface wraps the existing Eliza app with a developer
inspector. It extends the shared interface described in `../../../PRODUCT.md`;
it does not establish a separate visual system.

## Entry, exit, and shared state

The host enables the workspace only in a development build on a loopback host
with `?devtools=1`. The inspector's **Close** link navigates to the current path
with `?devtools=0`. Keep this gate at the host entry point.

The app and inspector share one `AppProvider`, active conversation, and
`sendChatText` path. The inspector composer therefore controls the real app;
it does not create a second agent or conversation. It uses the canonical stop
handler and restores an unsent draft on failure. Changing agent authority
remounts the panel, clearing its local inspection state.

## Structure and theme

- `DeveloperWorkspace.tsx` owns the shell, composer, settings, recorded trace,
  and expandable wire evidence. `useDeveloperTrajectories.ts` owns polling and
  selection. `../../styles/developer-workspace.css` owns structural layout.
- At widths of 1280px and above, the app remains visible on the left and the
  inspector occupies 480px on the right; at 1536px it grows to 560px. The app
  pane contains its layout and paint, keeping its chrome inside its bounds.
- Below 1280px, **App / Inspector** buttons select the visible pane, initially
  Inspector. Both panes remain mounted. Switching panes does not itself pause
  telemetry; the explicit pause control and document visibility govern that.
- The shell occupies `100dvh`. The inspector header and composer stay outside
  its scrolling content region, keeping prompt and stop controls reachable.
- Colors and typography inherit the active app theme: `bg-bg`, `bg-card`,
  `text-txt`, `text-txt-strong`, `text-muted`, `text-warn`, and `border-border`.
  Reuse `Button`, `Textarea`, and `SemanticForm`; preserve the existing type,
  spacing, radius, and focus conventions instead of adding a local palette.

## Accessibility and controls

The console and pane navigation have accessible names. Pane and section
buttons expose selection with `aria-pressed`; the prompt and selects have
labels. Buttons, selects, disclosure summaries, and the Close link have a 44px
minimum target height. Native disclosures expose stages and full evidence;
the labeled JSON region is keyboard-focusable for scrolling. Loading uses
`role="status"` and failures use `role="alert"`.

Enter submits, Shift+Enter inserts a newline, and IME composition does not
submit. Sending requires a nonempty prompt and a ready agent. During a send,
the composer presents the shared Stop control. Preserve visible focus and
textual state labels when extending these controls.

## Data boundaries

Owner role gates protect the inspector and settings UI. Existing
`ModelConfigurationPanel` and `AddAccountDialog` provide the Cerebras model and
key controls using this instance's server-side credentials and routing. The
configured route is informational: fallback routing can still apply, so the
recorded call identifies the provider actually used. These controls modify
the existing instance configuration.

Polling reads 50 agent-history summaries per page, then detail with
`includePayloads: false` for one selected run when its revision changes. It
runs every second while chat is busy and every five seconds while idle,
without concurrent polls. Pause, hidden documents, and cleanup stop reads;
401/403 responses stop automatic retries for that polling effect. Other
failures remain visible and retry. The default selection follows a
`client_chat` run for the current room on the current page; explicit selection
can inspect other rooms and sources in agent history.

Full prompts, tools, results, and context load only after evidence expansion,
and refresh if the expanded run's revision changes. This JSON may contain
private conversation content and is not prompt-truncated. It can be scoped to
a recorded semantic stage or the entire run. Keep the explicit disclosure and
privacy notice; do not put these payloads into routine summary polling.

## Telemetry limits and evidence

Calls distinguish **Foreground**, **Post-turn evaluation**, and **Background
memory**. Background runs are separate records and may finish after the reply;
message IDs support manual correlation. Run duration may include evaluation,
and overlapping stage spans must not be added together. HTTP attempts, queue
time, and provider first-token timing are not measured here.

Missing usage stays unknown: foreground input is **Unknown** when no input
counts are recorded, and a partial sum carries **(partial)** and `+`. Missing
per-call values display a dash; estimated usage carries `≈`. A configured
model, empty history, or an unavailable telemetry endpoint is not proof of a
successful call.

The scoped finish review disposition was **ship after four resolved findings**.
Local visual evidence is recorded in
`/Users/nubs/Documents/ChatGPT/test/eliza-developer-view-20260909/`:
`desktop.png`, `desktop-settings.png`, `mobile.png`, `mobile-app.png`,
`unavailable-unknown-fixture.png`, and `layout.json`. The layout receipt reports
1440px desktop and 390px mobile document widths matching their viewports.
The unavailable/unknown screenshot is a synthetic fixture. Reasoning-setting writes were exercised through the live panel (none → low →
none), with both shared selectors and the effective server configuration read
back. Key enrollment was not exercised; the existing credential was retained.
Settings saves wait for a changed runtime start time before displaying Saved.
These artifacts do not establish a deployed release.
