# #11856 — Live-LLM trajectory: JOIN_MEETING (plugin-meetings)

**Verdict (hand-reviewed): PASS — a real live model routed the natural request to the real `JOIN_MEETING` handler, and the MeetingService performed a genuine browser join attempt (real Chromium launched, real Google Meet guest page reached).**

## What ran

- Scenario: `plugins/plugin-meetings/test/scenarios/live-join-meeting.scenario.ts` (`live-only` lane)
- Command:
  ```
  OPENAI_API_KEY=$CEREBRAS_API_KEY OPENAI_BASE_URL=https://api.cerebras.ai/v1 \
  OPENAI_LARGE_MODEL=gpt-oss-120b OPENAI_SMALL_MODEL=gpt-oss-120b \
  bun --conditions=eliza-source packages/scenario-runner/bin/eliza-scenarios run \
    plugins/plugin-meetings/test/scenarios \
    --report .github/issue-evidence/11856-trajectory-join-meeting.json \
    --run-dir .github/issue-evidence/11856-trajectory-join-meeting-run
  ```
- Model: **live Cerebras `gpt-oss-120b`** via the OpenAI provider plugin (`provider: openai` in the report). No proxy, no mock (`SCENARIO_USE_LLM_PROXY` unset).
- Result: `1 passed, 0 failed, 0 skipped` — both final checks green
  (`selectedAction JOIN_MEETING` → "selected JOIN_MEETING"; `actionCalled JOIN_MEETING minCount 1` → "JOIN_MEETING called 1x").

## Artifacts

- `11856-trajectory-join-meeting.json` — scenario report (turns, captured actions, final checks)
- `11856-trajectory-join-meeting-run/` — run-dir: `matrix.json`, `viewer/index.html`, and the raw trajectory
  `trajectories/546ac3ab-.../tj-615b495964aa9f.json`
- `11856-backend-logs-join.txt` — structured backend logs (`[MeetingService]`, `[MeetingLaunch]`, `[InputDriver]`, `[GoogleMeetJoin]`)

## What the trajectory shows (opened and read by hand)

User turn: `"Please join this meeting and take notes: https://meet.google.com/abc-defg-hij"`

1. **Triage (messageHandler)** — live model output:
   ```json
   {"processMessage":"RESPOND","thought":"","plan":{"contexts":["general"],"reply":"On it.","simple":false,"requiresTool":true,"candidateActions":["JOIN_MEETING_AND_TAKE_NOTES"]}}
   ```
2. **Planner iteration 1** (`modelType: ACTION_PLANNER`, `toolChoice: required`, 20,625 prompt tokens) — the model's tool call, verbatim:
   ```
   toolCalls = [{'name': 'JOIN_MEETING', 'args': {}}]   finishReason = tool-calls
   ```
   (empty args is correct: the URL is resolved from the message text by the action's `resolveMeetingUrl`.)
3. **Tool execution** — the real handler ran and the real `MeetingService.requestJoin` succeeded:
   ```
   {"name": "JOIN_MEETING", "result": {"success": true, "text": "Joining the Google Meet meeting abc-defg-hij as \"ScenarioAgent Notetaker\"... (transcript 901eb0cb-22fd-462d-8fab-be9fc1cfb294)", "data": {"sessionId": "60375528-...", "transcriptId": "901eb0cb-..."}}}
   ```
4. **Evaluation** — `{"success":true,"decision":"FINISH","thought":"JOIN_MEETING tool executed, meeting joined and transcript started..."}`
5. **Planner iteration 2** — `REPLY` with the final user-facing text captured in the report.

Metrics: 2 planner iterations, 1 tool call, 0 tool failures, 44,405 total prompt tokens, final decision FINISH.

## Backend proof the service did the real thing

From `11856-backend-logs-join.txt`:
```
[MeetingService] meeting transcript record created (recording) (transcriptId=901eb0cb-..., sessionId=60375528-...)
[MeetingService] meeting join requested (sessionId=60375528-..., platform=google_meet, nativeMeetingId=abc-defg-hij, botName=ScenarioAgent Notetaker)
[InputDriver] using humanized Playwright input
[MeetingLaunch] launching Chromium (executablePath=.../Google Chrome for Testing.app/..., headless=false)
[MeetingService] session status (sessionId=60375528-..., status=joining)
[GoogleMeetJoin] locating name input
```
A real Chromium was launched and the bot reached Google Meet's guest name-input page for the (fake) meeting id — an honest end of the road for a nonexistent meeting. No leaked Chrome processes after the run (`pgrep "Chrome for Testing"` empty).

## Defects observed (real, minor)

1. **Slow abort on shutdown**: `[scenario-runner] cleanup step timed out after 5000ms: runtime.stop()`. `MeetingService.stop()` aborts active sessions (`session.abort.abort()`) and awaits `session.done`, but the Google Meet join sequence kept executing Playwright steps after the abort (`[GoogleMeetJoin] locating name input` logged *after* shutdown began) — the join flow does not check the abort signal between browser steps / does not force-close the browser on abort, so a graceful stop can hang past 5s mid-join. Fix item: observe `AbortSignal` between join steps (or wire it into Playwright ops / `browser.close()` on abort).
2. Cosmetic: `[pricing] no price entry — cost_usd defaulted to 0` for `gpt-oss-120b` via the OpenAI-compatible route (expected for a non-catalog model; noting for completeness).

Not defects: `JOIN_MEETING` args `{}` (URL intentionally parsed from message text), `[MeetingLaunch]` using the Playwright "Chrome for Testing" build (its resolver's fallback when no channel Chrome is pinned).
