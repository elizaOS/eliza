# Evidence — proactive interaction suggestions live e2e (#11387, follow-up to #8792)

Captured **2026-07-03** against the **real ui-smoke live stack**
(`packages/app-core/scripts/playwright-ui-live-stack.ts`, `LOG_LEVEL=debug`) and
a **live local LLM** (llama.cpp `llama-server`, **eliza-1-4b** Q4 on CPU, port
18811) through the existing `local-llama-cpp` live-provider seam — the same model
serves the runtime chat turns and the `TEXT_SMALL` proactive judge. No proxy, no
mock, no injected frames.

The whole shipped pipeline runs for real:

```
real user view switch  (client reportUserViewSwitch POST, source:"user")
  → POST /api/views/:id/navigate                         [views-routes]
    → emitEvent(VIEW_SWITCHED, { initiatedBy:"user" })    [views-routes]
      → decider debounce + LIVE small-model judge         [proactive-interaction-decider]
        → governance gate (settle / cooldown / cap)       [ProactiveInteractionGate]
          → routeAutonomyTextToUser (persist + WS)        [server-helpers-swarm]
            → WS proactive-message                        [ws]
              → rendered data-proactive-suggestion="true" [chat-message.tsx]
                → "Do it" accept + dismiss affordances
```

## What the live run produced

- The live judge **discriminates by surface** (backend `[proactive-interaction]`):
  - switch to **wallet** → `suggestion admitted (surface=wallet, delivery=chat)`;
    the model generated the offer **"Want to see your latest balances?"**
    (`{"comment":"…","delivery":"chat","confidence":0.9,"urgency":"medium"}`).
  - switch to **settings** → `suggestion suppressed (surface=settings,
    reason=judge: nothing helpful to offer)`
    (`{"comment":null,"delivery":"null","urgency":"low"}`).
- The offer was broadcast over WS as a `proactive-message`, persisted as an
  assistant memory with `source:"proactive-interaction"`, and **rendered in the
  chat transcript as a distinct Suggestion bubble** (`data-proactive-suggestion="true"`)
  with a **"Do it"** accept button and a **dismiss** (×) button — see
  `screenshots/02-suggestion-rendered.png`.
- The **"Do it"** accept path was exercised (bubble cleared, implied turn sent).

## Driving gesture (honest note)

The switch is driven by the client's real `reportUserViewSwitch` fetch — the exact
`POST /api/views/:id/navigate {source:"user"}` that the command palette, a home
tile tap, and a `/views <id>` slash command all fire. The command-palette **dialog
does not mount in the ui-smoke app shell** (Ctrl/⌘-K / its CustomEvent open no
dialog here), so the spec drives the same server-observable user report the palette
would, rather than the palette UI itself. Everything downstream of that POST —
event, decider, live judge, gate, WS, render — is the real shipped path.

## Required harness fix (committed with this evidence)

`playwright-ui-live-stack.ts`'s UI proxy used a plain `fetch()` to the API and hit
the undici keep-alive race (`UND_ERR_SOCKET: other side closed` → `TypeError:
fetch failed`) under the app's concurrent boot fan-out. That degraded the boot:
`/api/plugins` "hung" (12 s → socket close), the view plugins never registered, the
WS showed **"Reconnecting…"**, and the shell overlays (incl. CommandPalette) never
mounted. Fixed with a bounded retry (`fetchApiWithRetry`). Before: `/api/plugins`
HTTP 000 in 12 s, flooding proxy errors. After: HTTP 200 in 0.77 s, zero proxy
errors, wallet/calendar/todos/inbox views registered.

## Artifacts

- `screenshots/`
  - `01-chat-ready.png` — chat surface ready (live stack, real conversation).
  - `02-suggestion-rendered.png` — the governed **Suggestion** bubble with the
    live-model offer + **Do it** + dismiss.
  - `03-suggestion-mobile.png` — the SAME live suggestion at 390×844.
  - `04-accept-sent.png` — after **Do it** (bubble cleared).
- `logs/backend-proactive.log` — structured `[proactive-interaction] …` decider
  lines (admit for wallet, `nothing helpful` for settings, debounce/settle) plus
  `[ViewsRoutes] Navigate…` and `[OpenAI] Using TEXT_SMALL model: eliza-1-4b`.
- `logs/frontend-network.log` — browser `/api/(views|character|config|conversations)`
  request/response log.
- `judge-trajectory/wallet-judge.jsonl` — the REAL live-LLM decider round-trip for
  the wallet switch: full request (agent character system prompt + the #8792 judge
  instruction) and the model's JSON decision with token timings.
- `judge-trajectory/settings-judge-none.json` — the live judge declining to offer
  on a non-actionable surface (the "stay silent" gate working).
- `run-summary.json` — domain artifacts: the WS `proactive-message` frame, the
  persisted `proactive-interaction` memory read back through the conversations API,
  and the rendered bubble count.

## N/A rows

- **Walkthrough video** — N/A: the passing run's Playwright video was not retained
  by the harness on this host; the phase-ordered full-page screenshots above are
  the rendered proof (desktop + mobile + accept), plus the WS frame and backend
  decider logs showing the live code path firing.
- **audit:app loop** — N/A for the suggestion state: the audit harness walks static
  views with no live agent pushing governed `proactive-message` frames, so the
  bubble can never exist in its captures (same justification as the merged #11425
  bundle). The live-run screenshots are the rendered proof.
- **Per-platform native capture** — N/A: browser-rendered UI + server pipeline; no
  native/mobile surface changed. Mobile rendering is covered by the 390×844 capture.
- **Audio/narrated walkthrough** — N/A: no voice/TTS/STT surface touched.
