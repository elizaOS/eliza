# #11856 — meeting-transcription UI evidence (rendered proof)

Rendered-pixel evidence for the meeting-transcription UI on branch
`feat/meeting-transcription`. Every screenshot below was captured from the
REAL shipped components (`TranscriptsView` / `MeetingJoinBar` /
`LiveMeetingPane` / `TranscriptPlayer` from `packages/ui/src/components/transcripts/`,
and `CalendarSpatialView` from `plugins/plugin-calendar`) rendered in headless
Chromium with the real `@elizaos/ui` Tailwind v4 theme compiled in — not a
mock-up, not the CDN-Tailwind approximation. Each capture was opened and
reviewed by hand; notes per artifact below.

## How produced

```bash
bun packages/ui/src/components/transcripts/__e2e__/run-meetings-e2e.mjs
```

The runner (new, harness-only — no production source touched) esbuild-bundles
`packages/ui/src/components/transcripts/__e2e__/meetings-fixture.tsx`, which
mounts the real components with deterministic seeded data (scenario chosen by
`location.hash`), loads the page in Playwright chromium at desktop
(1280×860 @2x) and mobile (402×874 @2x), drives real keyboard/click input, and
asserts 31 behaviors per viewport (62 total, all green, zero page errors)
before each capture. The only stub is `src/api/client.ts` (so the live pane's
ws subscription can be fed a real `meeting-transcript` event by the harness
instead of opening a socket); the event parser, reducers, and all rendering are
the shipped code. Raw output (same PNGs + the bundled harness page) lives in
`packages/ui/src/components/transcripts/__e2e__/output-meetings/`.

## Artifacts (desktop + mobile pairs, `11856-ui-<viewport>-<nn>-<slug>.png`)

- **01-empty-join-bar** — empty Transcripts view: the Join-a-meeting bar
  (URL input + optional bot name + disabled orange "Join meeting" button) over
  the "No transcripts yet." empty state with its chat recommendations.
  Reviewed: renders correctly on both viewports; on mobile the bar wraps to
  three rows.
- **02-url-invalid** — `https://example.com/not-a-meeting` typed: the "Not a
  recognizable Meet, Teams, or Zoom meeting link." note appears and Join stays
  disabled. Reviewed: note is visible directly under the input.
- **03-url-recognized** — `https://meet.google.com/abc-defg-hij` typed: the
  recognized-platform hint (camera glyph + "Google Meet") appears inside the
  input and the Join button switches to enabled full-orange. Runner also
  asserts submit fires `onJoinMeeting` with the parsed
  `{platform:"google_meet", meetingUrl}` request. Reviewed: hint + enabled
  state clearly visible.
- **04-active-strip** — active-meetings strip under the join bar: an `active`
  Google Meet session (orange LIVE dot, "In meeting") and an
  `awaiting_admission` Zoom session (muted dot, "Waiting to be admitted"),
  each with a Stop button (runner asserts Stop fires `onStopMeeting`). Below,
  the list rows: the recording meeting row carries the orange LIVE marker,
  meeting rows show platform + participant count, the plain voice memo row
  shows neither. Reviewed: all states legible on both viewports.
- **05-live-pane** — the live meeting selected: detail header with title +
  LIVE indicator, "Google Meet" platform badge, participants roster
  (Ada Lovelace, Grace Hopper, Eliza (bot)), then the LiveMeetingPane with 3
  confirmed speaker-labeled segments (testids `live-confirmed-0..2`) and — after
  the harness pushed a real `meeting-transcript` ws event through the pane's
  subscription — the muted pending ASR tail (`live-pending-0`, visibly grayer,
  mid-sentence). Reviewed: pending tail is clearly distinguishable from
  confirmed text; on mobile the pane is auto-scrolled to the bottom (pinned
  behavior working).
- **06-archived-detail** — archived meeting record selected: "Microsoft Teams"
  platform badge (`meeting-detail-platform`), participants roster, and the
  standard TranscriptPlayer (play button + scrubber + time; audio element
  mounted from a real wav data-URI) over the speaker-labeled transcript body
  with the first segment highlighted. No live pane (runner asserts). Reviewed:
  badge/roster/player all present.
- **07-calendar-send-agent** — CalendarSpatialView agenda: the live event shows
  the "● In meeting" badge, the joinable event shows the "Send agent" button
  (runner asserts it dispatches `join:<id>`), the in-flight event shows
  "Sending…", and a plain event shows neither. Reviewed: all four affordance
  states visible in one frame.

## Honest visual findings (fix candidates, not blockers)

1. **Bot-name placeholder truncates** — the fixed `w-40` input clips
   "Bot name (optional)" to "Bot name (optiona" at every viewport
   (`MeetingJoinBar.tsx`). Shorten the placeholder or widen the input.
2. **Focused URL input shows a pale blue ring** — in the 03 captures the
   focused `Input` carries the primitive's default focus ring, which reads
   blue-ish against the dark theme; brand rules say no blue anywhere. This is
   the shared `components/ui/input` focus token, not meetings-specific, but it
   is visible on this surface.
3. **Narrow list rows wrap meta ugly** — at the 288px list width the
   "Microsoft Teams · Jul 1 · 45:00 · 3 participants" meta line wraps into a
   ragged two-line block on desktop (04/05/06 captures). A `whitespace-nowrap`
   + truncate on the meta row would keep it one line.
4. **Live segment `endMs` shows as duration 0:24** — cosmetic-only in the
   fixture (durationMs seeded to the last segment end); noted here so nobody
   mistakes the "0:24" row label for a defect.

## Scope note

This is the UI-layer rendered proof. The real end-to-end bot evidence (live
bot joining an actual meeting, backend logs, trajectory) is captured
separately — see `11856-backend-logs-join.txt` and
`11856-trajectory-join-meeting.json` in this directory.
