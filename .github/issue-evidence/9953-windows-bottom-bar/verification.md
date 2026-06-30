# #9953 — chromeless desktop bottom bar: Windows UI evidence

Issue: #9953 (re-opened — the merged code [#10032 / #10051] lacked the required
visual evidence for the bottom-bar UI; this supplies it).

- **Machine:** Windows 11 Pro (10.0.26200), interactive session
- **Runtime:** Bun 1.4.0 / Node 24.15.0, Playwright chromium 1228
- **Date:** 2026-06-29
- **Harness:** `packages/ui/src/components/shell/__e2e__/run-bottombar-e2e.mjs`
  (`bun run --cwd packages/ui test:bottombar-e2e`) — a new, committed real-browser
  e2e lane.

## What is captured (and why it's faithful)

The harness renders the **real shipped shell composition** — the same React tree
`ChatOverlayShell` → `ShellFoundationMount` (`packages/ui/src/App.tsx`) mounts when
the desktop boots the bottom bar (`?shellMode=chat-overlay`): the `HomePill`
resting bar + the `AssistantOverlay` holding the glass `ChatSurface` composer.
The fixture wraps them in the **identical** bottom-anchored container
`ChatOverlayShell` uses (`pointer-events-none fixed inset-0 flex items-end
justify-center bg-transparent`), with the VISION button wired exactly as App.tsx
wires it (`onVision={controller.captureVision}`). The real `@elizaos/ui`
Tailwind v4 theme + tokens are compiled and injected (dark glass + orange
accent), so the captured pixels carry the shipped brand — not a CDN
approximation. The native Electrobun window's frameless/transparent/bottom-
anchored geometry is owned + unit-tested separately
(`desktop-bottom-bar-config.test.ts`, 13 passing); this evidence covers the
bottom-bar **UI surface** that loads inside it.

## Result — 13/13 assertions PASS

| # | Screenshot | Proves |
|---|---|---|
| 1 | `01-resting-homepill.png` | The resting desktop surface is the chromeless `HomePill` bar (pinned bottom), **not** the full `<App>` dashboard. The open composer is not even mounted. |
| 2 | `02-open-composer.png` | Tapping the bar opens the glass `ChatSurface` composer showing **mic + VISION (eye) + send**, with orange-accent message bubbles (`bg-accent/20`) over a desktop wallpaper. |
| 3 | `03-open-composer-draft.png` | Typing a draft enables send. |
| 4 | `04-vision-active.png` | Tapping the VISION eye fires a real screen-vision turn (`"Take a look at my screen and tell me what you see."`) and pulses the button — the #9953 Phase-1 VISION addition, working. |
| 5 | `05-closed-back-to-bar.png` | Escape returns to the resting chromeless bar. |
| — | `bottombar-walkthrough.webm` | Full resting → open → type → send → vision → close walkthrough. |

Machine-checked acceptance criteria (all asserted in the harness, exit 0):

- **Resting surface is the chromeless bar, not `<App>`** — `shell-chat-surface`
  is absent until the bar is opened.
- **Composer shows mic + VISION + send** — exactly one of each
  (`aria-label`: `Start voice input`, `Show … my screen`, `Send message`).
- **No hardcoded blue** — `is-sky` element count is **0** (the #9953 brand
  violation is gone).
- **Send works** — pressing Enter on a draft sends the turn.
- **VISION works** — tapping the eye fires the screen-vision turn text.
- **No page errors / no console errors.**

## Reproduce

```bash
bun run --cwd packages/ui test:bottombar-e2e
# Windows-with-Bun note: Playwright's CDP pipe transport does not hand-shake
# under Bun on Windows; run the runner under Node there:
#   node packages/ui/src/components/shell/__e2e__/run-bottombar-e2e.mjs
```

## Scope / honest gaps (tracked, not dropped)

- **Default-flip** (criterion #1, "resting surface IS the bar by default"): the
  bottom bar is still opt-in behind `ELIZA_DESKTOP_BOTTOM_BAR=1`. Tracked in
  **#10350**.
- **Fused on-device wake → bar e2e**: only the synthetic wake event is covered;
  the real `libwakeword` runtime emission is tracked in **#10351**.
- **Native Electrobun packaged-window video / before(full-window) screenshot**:
  the bottom-bar **content** is captured here faithfully; the native packaged
  window capture requires a full desktop build and is noted for the desktop
  capture lane. The frameless/transparent/bottom geometry is unit-tested
  (`desktop-bottom-bar-config.test.ts`).
- **Real-LLM trajectory / narrated audio**: N/A for this UI-surface harness (no
  live agent/model is booted); the VISION/send turns are asserted at the
  controller boundary (the exact text dispatched to `send()`).
