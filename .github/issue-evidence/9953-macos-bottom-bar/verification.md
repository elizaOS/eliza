# #9953 — macOS bottom-bar evidence + default flip (#10350)

Closes the re-open's two missing pieces that are reachable on a Mac host:

1. **Default flip (#10350 / #9953 acceptance criterion #1):** the chromeless
   bottom bar is now the **default** resting desktop surface (removed the
   `ELIZA_DESKTOP_BOTTOM_BAR=1` opt-in gate; the opt-out kill switch is
   `ELIZA_DESKTOP_BOTTOM_BAR=0`). Proven by `desktop-bottom-bar-config.test.ts`
   (**13/13**): `shouldStartBottomBar({}) === true`, and
   `resolveDesktopShellWindowPresentation({})` now reports
   `mode: "bottom-bar", titleBarStyle: "hidden"` on win32 + darwin by default,
   and the legacy `mode: "default"` only when opted out with `=0`.

2. **macOS UI-surface evidence** — same `test:bottombar-e2e` harness the accepted
   Windows evidence (#10352) used, run on **macOS** (host: darwin/arm64,
   Node/Playwright chromium). It renders the **real shipped composition**
   (`ChatOverlayShell` → `ShellFoundationMount`: `HomePill` + `AssistantOverlay` +
   glass `ChatSurface`) with the real `@elizaos/ui` Tailwind v4 theme compiled +
   injected, and machine-checks the #9953 acceptance criteria — **13/13 pass**:

   - `01-resting-homepill.png` — resting surface is the chromeless `HomePill`
     bar (the open composer is not even mounted until opened) → **not `<App>`**.
   - `02-open-composer.png` / `03-open-composer-draft.png` — open composer shows
     exactly **mic + VISION (eye) + send**, dark glass, orange accent, **no blue**
     (the `is-sky` brand violation count = 0).
   - `04-vision-active.png` — tapping the eye fires a **real screen-vision turn**
     ("Take a look at my screen" dispatched to `send()`).
   - `05-closed-back-to-bar.png` — Escape returns to the resting bar.
   - `bottombar-walkthrough.webm` — the full resting → open → type → vision →
     close walkthrough.
   - No page errors, no console errors.

## Scope / honesty

- This is the bottom-bar **UI surface** + the **default-flip decision** (the two
  re-open items reachable headlessly on macOS). The native Electrobun packaged
  window geometry (frameless / transparent / bottom-anchored) is owned + unit
  tested by `desktop-bottom-bar-config.test.ts`; a from-source packaged desktop
  build was not produced here.
- Real-LLM trajectory / narrated audio are **N/A** for this UI-surface harness
  (the VISION/send turns are asserted at the controller boundary — the exact text
  dispatched to `send()`), matching the accepted #10352 Windows scope.
- The **fused on-device wake** end-to-end (real `libwakeword` emitting
  `eliza:fused-wake`, vs. today's synthetic event + the wired bridge) remains the
  one deep native follow-up, tracked as **#10351** — the native `libwakeword`
  runtime ships in the artifact bundle (not present under `install:light`), so the
  real-runtime integration belongs to that dedicated issue.
