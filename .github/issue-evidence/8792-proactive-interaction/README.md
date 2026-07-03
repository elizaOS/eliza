# Evidence — proactive interaction suggestions live e2e (#11387, follow-up to #8792)

Branch `test/11387-proactive-suggestions-e2e`. Captured 2026-07-02 against the
REAL ui-smoke live stack (`playwright-ui-live-stack.ts`, `LOG_LEVEL=debug`) and
a LIVE local LLM (llama.cpp `llama-server`, **eliza-1-4b** Q4 on CPU) through
the existing `local-llama-cpp` live-provider seam — the same model serves the
runtime chat turns and the TEXT_SMALL proactive judge. No proxy, no mock, no
injected frames.

The producing spec is checked in:
`packages/app/test/ui-smoke/proactive-suggestions-live.spec.ts` (LIVE_ONLY —
self-skips in the keyless lane). One run drives:

real palette view-switch → `POST /api/views/:id/navigate {source:"user"}`
→ `VIEW_SWITCHED` → decider debounce → live judge → governance gate
→ `routeAutonomyTextToUser` (persisted memory) → WS `proactive-message`
→ rendered `data-proactive-suggestion="true"` bubble → dismiss / rate-limit /
accept ("Do it" → real agent turn) / Settings Off kill-switch.

## Artifacts

- `screenshots/` — full-page captures from the live run, in phase order:
  `01-chat-anchored` (real anchor turn answered by the live model),
  `02-suggestion-rendered` (governed bubble + Suggestion chip + "Do it" +
  dismiss), `03-suggestion-mobile` (the SAME live suggestion at 390×844),
  `04-rate-limit-no-second-bubble`, `05-after-dismiss`,
  `06-second-suggestion`, `07-accept-sent` ("Yes, let's do it." user turn),
  `08-accept-agent-replied` (live agent answers the accepted offer),
  `09-setting-off` (real Capabilities segmented control), `10-off-no-suggestion`.
- `walkthrough.webm` — E2E_RECORD=1 video of the whole flow.
- `logs/backend-proactive.log` — structured backend log slice
  (`[proactive-interaction] suggestion admitted/suppressed` with gate reasons,
  `[ViewsRoutes] Navigate…`, `[OpenAI] Using TEXT_SMALL…`, notification-rail
  delivery) from the `LOG_LEVEL=debug` stack run.
- `logs/frontend-console.log` / `logs/frontend-network.log` — browser console
  and `/api/views|interactions|config|character` request/response log incl.
  the captured WS `proactive-message` frames.
- `judge-trajectory/` — the REAL live-LLM decider trajectory from the verbose
  llama-server log: complete judge request (the agent's real character system
  prompt + the #8792 judge instruction) and the model's JSON decision with
  token-level timings. Includes the notify-rail probe (default persona) and
  the chat-rail decisions (steered persona).
- `run-summary.json` — domain artifacts: the persisted `proactive-interaction`
  memories read back through the real conversations API, surfaces exercised,
  and the model-generated offer texts.
- `run-log.txt` — the Playwright run output (green).

## Hand-review verdicts

(filled from the actual artifacts — see per-file notes below)

## Real product finding

With the default persona the live judge labels helpful view offers
`urgency: "low"` and `parseProactiveJudgeDecisionOutput` maps low urgency to
the notification rail, so chat bubbles rarely surface — the probe in
`logs/backend-proactive.log` shows `suggestion admitted
(surface=task-coordinator, delivery=notify)` landing on the notification
service. The judge's system prompt is the agent character (user-tunable), so
the spec applies a chat-forward persona through the real `PUT /api/character`
before the chat-rail phases. Judge output stays model-generated end to end.

## N/A rows

- **audit:app loop** — N/A for suggestion states: the audit harness walks
  static views with no live agent pushing governed `proactive-message` frames,
  so the bubble can never exist in its captures (same justification as the
  merged #11425 bundle). The live-run screenshots above are the rendered proof.
- **Per-platform native capture** — N/A: browser-rendered UI + server pipeline
  + a Playwright spec; no native/mobile surface changed. Mobile rendering is
  covered by the 390×844 viewport capture of the live suggestion.
- **Audio/narrated walkthrough** — N/A: no voice/TTS/STT surface touched.
