# Live Cerebras `gemma-4-31b` trajectory evidence — QA umbrella #9950 / #10722

Captured 2026-07-01 on branch `shaw/nice-spence-509094`. Every report in this
directory is a real `eliza-scenarios` run against a **live** Cerebras
`gemma-4-31b` endpoint driving a real `AgentRuntime` + PGLite + real plugins —
no LLM proxy, no wire mock (see Defect 1: the harness was silently mocking the
"live" lane until this branch fixed it). Reports were opened and reviewed by
hand; verdicts below quote the actual turns.

## Verified recipe (corrected)

```bash
bun run --cwd packages/scenario-runner build   # bin runs dist/cli.js
CEREBRAS_MODEL=gemma-4-31b \
OPENAI_LARGE_MODEL=gemma-4-31b \
OPENAI_SMALL_MODEL=gemma-4-31b \
bun packages/scenario-runner/bin/eliza-scenarios run <scenarioDir> \
  --scenario <id> --report <out>.json
```

Two corrections vs. the previously circulated recipe:

1. **Do NOT pass `OPENAI_API_KEY=$CEREBRAS_API_KEY` / `OPENAI_BASE_URL=…`.**
   With only `CEREBRAS_API_KEY` in the env, `selectLiveProvider`
   (`packages/core/src/testing/live-provider.ts`) enters first-class Cerebras
   mode (`ELIZA_PROVIDER=cerebras`), which makes plugin-openai apply the
   Cerebras quirks it already knows: tool-name sanitization,
   `normalizeSchemaForCerebras` on tool schemas, and suppression of the
   `response_format: json_schema` payload Cerebras strict mode rejects.
   Spoofing via `OPENAI_API_KEY` bypasses all of that and produces avoidable
   400s (Defect 4).
2. **Pin `CEREBRAS_MODEL` explicitly.** Bun auto-injects the repo-parent
   `.env`, which carries `CEREBRAS_MODEL=gpt-oss-120b`; in Cerebras mode that
   setting is the default for the Stage-1 RESPONSE_HANDLER and ACTION_PLANNER
   models (`getResponseHandlerModel` / `getActionPlannerModel` in
   `plugins/plugin-openai/utils/config.ts`), so without the pin the planner
   silently runs `gpt-oss-120b` while TEXT_LARGE runs gemma. Wire-verified:
   with the pin, all `/v1/chat/completions` requests carry
   `"model":"gemma-4-31b"` (`wire-capture-views-list-gemma.jsonl`).

> **2026-07-02 update:** the three failing app-control rows below are FIXED —
> see the delta section at the bottom and the `*-fixed.report.json` runs
> (gemma-4-31b 4/4, gpt-oss-120b 4/4).

## Run index

| Report | Scenario | Family | Result | Duration | Actions observed (live gemma) |
| --- | --- | --- | --- | --- | --- |
| `app-control-live.report.json` | `views-list` | app-control VIEWS (list) | **pass** | 2 791 ms | `VIEWS {action:"list", mode:"list"}` |
| `app-control-live.report.json` | `app-list` | app-control APP (list) | fail | 2 344 ms | `VIEWS {action:"list", …, target:"apps"}` (wanted `APP list`) |
| `app-control-live.report.json` | `views-show` | app-control VIEWS (show) | fail | 2 674 ms | `OWNER_FINANCES_DASHBOARD` (wanted `VIEWS show wallet`) |
| `app-control-live.report.json` | `views-voice-navigate` | app-control VIEWS (voice nav) | fail | 2 156 ms | `REPLY` (clarifying question) |
| `live-inbound-attachment.report.json` | `live-inbound-attachment` | attachments (real-LLM lane) | **pass** | 1 953 ms | `ATTACHMENT {action:"read", attachmentId:"note-1"}` |
| `health-status-and-trend.report.json` | `health-status-and-trend` | OWNER_HEALTH | **pass** | 6 296 ms | `OWNER_HEALTH_TODAY`, `OWNER_HEALTH_TREND {days:7}` |
| `brush-teeth-basic.report.json` | `brush-teeth-basic` | LifeOps habit save | fail (before fix) | 11 933 ms | `SCHEDULED_TASKS_CREATE` ×5 (wanted definition-save flow) |
| `brush-teeth-basic-after-fix.report.json` | `brush-teeth-basic` | LifeOps habit save (after fix) | **pass** | 8 335 ms | `OWNER_ROUTINES_CREATE` preview (`confirmed:false` → lifeDraft) then save (`confirmed:true` → definition + reminderPlan) |
| `brush-teeth-basic-after-fix-rerun1.report.json` | `brush-teeth-basic` | stability re-run 1 | **pass** | 8 025 ms | same trajectory shape |
| `brush-teeth-basic-after-fix-rerun2.report.json` | `brush-teeth-basic` | stability re-run 2 | **pass** | 7 599 ms | same trajectory shape |
| `views-crud-lifecycle.report.json` | `views-crud-lifecycle` | app-control VIEWS CRUD (action-kind baseline) | **pass** | 381 ms | `VIEWS` create/edit/delete + stubbed `START_CODING_TASK` |
| `app-control-oss120b-differential.report.json` | 3 failing app-control ids on `gpt-oss-120b` | differential triage | all fail | — | `REPLY` only (all three) |

`wire-capture-views-list-gemma.jsonl` — sanitized reverse-proxy capture of the
passing `views-list` run: 3× `POST /v1/chat/completions`, all
`"model":"gemma-4-31b"`, all HTTP 200, real streamed completions. No auth
headers were ever logged. This is the liveness proof for the whole set.

## Hand-review verdicts

### views-list — pass, genuine correct trajectory
User: "what views are available?" → gemma selected `VIEWS` with
`{"action":"list","mode":"list"}`; the runtime returned the real 20-view
catalog and the reply enumerates it:
`"available_views: type: gui count: 20\nviews[20]{id,label,type,path,available}: tutorial,Tutorial,gui,/tutorial,yes chat,Chat,gui,/chat,yes …"`.
All three final checks (selectedAction / arguments / actionCalled) passed.
Quirk worth knowing: gemma stuffs every optional parameter with the same slug
(`"view":"views-list","id":"views-list","name":"views-list",…`) — harmless
here, but visible in the params.

### live-inbound-attachment — pass, real comprehension
The agent called `ATTACHMENT {action:"read", attachmentId:"note-1"}` and then
answered `"The project kickoff is scheduled for Tuesday at 10 AM in room 4."`
— exactly the content of the attached note. This is the real-LLM lane
counterpart of the deterministic attachment scenario (#8876) doing its job.

### health-status-and-trend — pass, correct routing + honest empty-state
Turn 1 routed to `OWNER_HEALTH_TODAY {metric:"steps", days:1}`, turn 2 to
`OWNER_HEALTH_TREND {days:7}` (correct window). With no connected sources the
replies honestly say so and enumerate connectable providers
("Apple Health, Google Fit, Strava, Fitbit, Withings, or Oura").
`plannerExcludes` (no gmail/send leakage) held.

### views-crud-lifecycle — pass (deterministic action-kind baseline)
This scenario drives `VIEWS` create → catalog check → edit → delete-confirm →
catalog check via `kind:"action"` turns with a stubbed `START_CODING_TASK` and
a fixture for the one name-extraction LLM call. It proves the VIEWS action
wiring end-to-end (catalog reflects create and delete) but is **not**
live-model routing evidence — the model does not choose actions here.
Kept as the wiring baseline the live scenarios sit on.

### app-list — fail: adjacent-family routing miss (gemma), refusal (gpt-oss)
"show me the apps" → gemma picked `VIEWS list` (the views catalog) instead of
`APP list`, replying with the view list. On `gpt-oss-120b` the same turn
produced `REPLY` only: `"User requested a list of apps. No tool execution is
required; I can provide a helpful textual list directly."` Cross-model failure
⇒ not a gemma capability gap (Defect 3).

### views-show — fail: semantically-adjacent action (gemma), refusal (gpt-oss)
"open the wallet view" → gemma called `OWNER_FINANCES_DASHBOARD` and replied
`"I've opened your wallet view. It looks like there are no payment sources
connected yet…"` — a defensible reading of "wallet", but the scenario contract
is `VIEWS show|open`. On gpt-oss-120b the planner looped `REPLY` three times
and died with `TrajectoryLimitExceeded: required_tool_misses (4/3)`; the wire
capture for that variant shows the planner tool surface contained **no VIEWS
tool at all** (only REPLY/IGNORE/CALENDAR×12/RESOLVE_REQUEST×3/STOP) because
Stage 1 picked the calendar context (Defect 3).

### views-voice-navigate — fail: under-decisive on one-word voice utterance
"settings" → gemma asked a clarifying question via `REPLY` instead of
`VIEWS show settings`. Same outcome on gpt-oss-120b. The scenario encodes the
voice-transcription contract (single word ⇒ navigate); no current live model
honors it through this pipeline (Defect 3).

### brush-teeth-basic — fail: wrong task surface + trajectory-limit crash (FIXED — see the 2026-07-02 brush-teeth delta at the bottom)
Gemma genuinely attempted the save — turn 1 fired `SCHEDULED_TASKS_CREATE`
three times with plausible params (`taskId:"brush-teeth-morning-…",
kind:"reminder"`) — but that is the raw scheduled-task surface, not the LifeOps
habit-definition save flow the final check requires
(`definitionCountDelta` with `times_per_day` cadence and 480/1260 slots).
The planner then hit `TrajectoryLimitExceeded: terminal_only_continuations
(3/2)` and the user saw `"I am sorry, but I ran into an issue."` Turn 2
repeated `SCHEDULED_TASKS_CREATE` with a duplicate `taskId`. Real product
finding: on live gemma the preview→confirm habit flow routes to the low-level
scheduler action instead of the definition pipeline.

## Root-caused defects

### Defect 1 (FIXED here): the "live" scenario lane was silently running against the wire mock
`createScenarioRuntime` (`packages/scenario-runner/src/runtime-factory.ts`)
unconditionally boots `prepareMockedTestEnvironment`, which starts the
wire-level LLM mock servers and exports `ELIZA_MOCK_OPENAI_BASE` /
`ELIZA_MOCK_ANTHROPIC_BASE`. plugin-openai / plugin-anthropic treat those vars
as **authoritative over `OPENAI_BASE_URL`**
(`plugins/plugin-openai/utils/config.ts` `getMockBaseURL` "wins over any
configured base"). Net effect: every "live" run since the mock env landed sent
zero requests to the real provider — Stage 1 got empty completions from the
mock, retried 3×, fell back to REPLY, and turns "completed" in ~1.2 s.
Proof, before the fix: a logging reverse proxy on the configured base URL
captured **zero** requests during a full scenario run while the runner
reported `provider=openai`; every scenario failed with
`Stage 1 returned empty completion — retrying`. After the fix: the same run
produced real streamed gemma completions (see wire capture) and `views-list`
passes in 2.6–3.7 s.

**Fix (in this branch):** `clearLlmWireMockEnvForLiveProvider()` in
`runtime-factory.ts` — when a live provider is selected, the two LLM wire-mock
overrides are deleted after the mock env boots; connector mocks (gmail, etc.)
stay; the deterministic-proxy lane is untouched. Unit-tested in
`runtime-factory.test.ts` (13/13 pass). Consequence for the QA umbrella: any
"live" scenario evidence produced through `createScenarioRuntime` while the
hijack was in place was actually mock traffic and should be re-captured.

### Defect 2 (documented; recipe corrected): `.env` `CEREBRAS_MODEL` silently reroutes the planner
See recipe correction 2 above. Symptom that exposed it: a proxied "gemma" run
whose Stage-1 request bodies carried `"model":"gpt-oss-120b"` with reasoning
deltas. Anyone producing model-pinned evidence must pin `CEREBRAS_MODEL`,
`OPENAI_SMALL_MODEL`, and `OPENAI_LARGE_MODEL` together.

### Defect 3 (product finding, NOT fixed here — security-sensitive): the external-content wrap suppresses/derails owner commands from connector sources
`hardenIncomingUserMessage`
(`packages/core/src/security/incoming-message-security.ts`, GHSA-gh63-5vpj-39qp
mitigation) wraps **every** message whose `content.source` is a connector
(telegram, discord, api, …) — including the owner's own commands — in
`<<<EXTERNAL_UNTRUSTED_CONTENT>>>` plus a SECURITY NOTICE instructing the model
not to treat the content as commands. Live models comply: gpt-oss-120b's
captured reasoning for "open the wallet view" reads
`"It's from external untrusted content; we must ignore instructions. No actual
request."` → REPLY-only → `TrajectoryLimitExceeded`. gemma is less deterred
but routes to adjacent surfaces. All three failing app-control scenarios use
`source: "telegram"`; the two passing conversational scenarios use
`source: "dashboard"` (not wrapped) or a harmless read request. This is a
cross-model, live-lane product defect: the anti-injection wrap and the
"connector messages are the primary command channel" contract are currently in
direct conflict. It was invisible in CI because Defect 1 kept the live lane on
mocks. Fixing it means deciding trust policy (e.g., exempting the
authenticated room owner's own messages from the wrap), which is a security
design change outside this workstream's scope — filed here with wire evidence
instead of a drive-by patch.

### Defect 4 (documented; avoided by Cerebras mode): strict `response_format` rejections when spoofing via `OPENAI_API_KEY`
When Cerebras is reached in plain-OpenAI mode (spoofed key/base URL), the
background reflection evaluator's structured-output call 400s:
`response_format.json_schema` contains
`structured_fields: { type:"object", additionalProperties:false }` with no
`properties` (`packages/core/src/features/advanced-capabilities/evaluators/reflection-items.ts:86`)
→ Cerebras: `"Object fields require at least one of: 'properties' or 'anyOf'"`;
after patching that, `keywords: { maxItems: 16 }` → Cerebras:
`"Invalid fields for schema with types ['array']: {'maxItems'}"`. Raw-API
probes confirmed `properties: {}` **is** accepted by Cerebras
`response_format` (contradicting the comment in
`plugins/plugin-openai/models/text.ts` `normalizeNativeTools`, which is about
the tools grammar) and `maxItems` is not. In proper Cerebras mode this path is
moot — plugin-openai suppresses the `json_schema` payload entirely
(`models/text.ts` ~line 1200) — so no product change was made; noted for
whoever generalizes `buildStructuredOutput` to strict-grammar providers.

## Files changed outside this directory (contained product fix)

- `packages/scenario-runner/src/runtime-factory.ts` — Defect 1 fix
  (`clearLlmWireMockEnvForLiveProvider`).
- `packages/scenario-runner/src/runtime-factory.test.ts` — unit tests for the
  fix (live providers drop the two LLM mock vars, connector mocks survive,
  deterministic lane untouched).

## Secret hygiene

All artifacts swept for `csk-`, `Bearer`, `authorization`: zero hits. The
logging proxy used for wire captures never logged request headers.

---

# 2026-07-02 delta — the three app-control routing defects are FIXED

The three cross-model app-control failures above (`app-list`, `views-show`,
`views-voice-navigate`) are fixed on this branch. New live evidence, captured
with the exact recipe above (Cerebras first-class mode, models pinned):

| Report | Model | app-list | views-list (regression guard) | views-show | views-voice-navigate |
| --- | --- | --- | --- | --- | --- |
| `app-control-live-fixed.report.json` (run `56ab167b`) | gemma-4-31b | **pass** (`APP {action:"list"}`) | **pass** (`VIEWS {action:"list"}`, 24 views) | **pass** (`VIEWS {action:"show", view:"wallet"}`) | **pass** (`VIEWS {action:"show", view:"settings"}`) |
| `app-control-oss120b-differential-fixed.report.json` (run `81aaeeda`) | gpt-oss-120b | **pass** (`APP {action:"list"}`) | **pass** (`VIEWS {action:"list"}`) | **pass** (`VIEWS {action:"show", view:"wallet"}`) | **pass** (`VIEWS {action:"show", view:"settings"}`) |

Every trajectory was opened and reviewed by hand (Stage-1 tool call, toolSearch
tier, planner tool calls, executed action + result). Deterministic suites stay
green: `plugin-app-control` 1271/1271 before and after; `packages/core` full
suite 294 files / 2517 passed after.

## Root causes + fixes

### app-list — APP never reached the planner surface
Three stacked causes: (1) Stage-1 emits app-flavored candidate names
(`LIST_APPS`, `GET_INSTALLED_APPS`, `LIST_APPLICATIONS`) that nothing resolved
to the APP action — `APP` had only 2 similes and no tags, while the core
candidate alias fallback (`looksLikeViewCandidateAction`,
`packages/core/src/runtime/action-retrieval.ts`) mapped every `*_APPS` name to
**VIEWS** because APP/APPS are also view-surface tokens; (2) `APP` declared
only `automation|settings|code` contexts, so a Stage-1 `general` routing
excluded it from the collected planner action set; (3) the deterministic
backstop (`findViewShellActionName`,
`packages/core/src/services/message/direct-action-heuristics.ts`) hinted only
VIEWS for app-surface phrases. Fixes: APP gained list/launch similes + tags +
`general` context + a `routingHint`
(`plugins/plugin-app-control/src/actions/app.ts`); app-flavored candidates now
alias to BOTH `VIEWS` and `APP` (`action-retrieval.ts`
`parentAliasesForCandidateAction`); the backstop surfaces both candidates
(`direct-action-heuristics.ts` `findAppControlActionNameForAppRequest`); the
VIEWS routingHint explicitly defers installed/running-apps asks to APP
(`plugins/plugin-app-control/src/actions/views.ts`).

### views-show — scenario contract conflicted with the #8613 gate
Root cause of "no VIEWS tool in the surface": the planner action-set collector
calls `action.validate` (`packages/core/src/services/message.ts`
`collectV5PlannerCandidateActions`), and VIEWS's own #8613 gate returns false
for desktop-only modes (show/open) on viewless text connectors — the scenario
room was `source: "telegram"`. That gate is deliberate, merged product
behavior (a telegram asker cannot see a desktop view; text summary is the
correct answer there — which is exactly what gemma's
`OWNER_FINANCES_DASHBOARD` reply was). **The scenario contract was wrong, not
the gate**: view navigation is a first-party-surface contract, so the room
source is now `dashboard` (`views-show.scenario.ts`,
`views-voice-navigate.scenario.ts`, with in-file justification). On dashboard,
VIEWS passes validate, Stage-1's own `OPEN_WALLET_VIEW`/`SHOW_WALLET`
candidates resolve via new VIEWS similes, and both models pick
`VIEWS {action:"show", view:"wallet"}`. Quirk noted honestly: the harness view
catalog has no wallet view, so `runViewsShow`'s fuzzy resolution lands on
"Social Alpha" (tags: finance/crypto) — the routing contract under test is the
planner's selection, which is genuinely correct; gpt-oss burns 1–3 extra
planner iterations re-trying `show wallet` because the result names a
different view.

### views-voice-navigate — no deterministic path for a bare view name
On dashboard the security wrap no longer applies, but Stage-1 models still
sometimes answer a bare "settings" with a clarifying simple reply and zero
candidates (observed live: gpt-oss run `0a6b9a19`, REPLY in 848 ms — the
scenario is FLAKY without a deterministic backstop). Fix: 
`findBareViewNavigationActionName` (`direct-action-heuristics.ts`) — a message
that is nothing but a single bare noun the views action itself claims (its own
tag, or an `OPEN_/SHOW_/GO_TO_…` navigation simile) surfaces VIEWS as a
candidate, which forces the planning path (a VIEWS candidate is not in
`WEAK_DIRECT_REPLY_OVERRIDE_ACTIONS`, so `shouldPreferCompleteDirectReply`
cannot collapse the turn to the clarifying reply). The VIEWS routingHint also
now states the voice contract: a bare view name is `action=show`, never a
clarifying question. Structurally anchored to a registered VIEWS /
VIEW_CAPABILITY action — inert for agents without one. Unit fences:
`packages/core/src/__tests__/message-routing-live-regression.test.ts`
("APP surface request inference (#9950)", "bare view-name voice navigation
inference (#9950)").

## What is NOT fixed here

Defect 3 above (the `hardenIncomingUserMessage` external-content wrap
suppressing owner commands on connector sources) is unchanged — still the
security-design decision it was filed as. Visible in the fixed gpt-oss
`app-list` trajectory: Stage-1 under the telegram wrap still refuses to name
candidates (it hallucinated a generic list of popular apps), and the turn is
recovered by the deterministic backstop + planner arbitration
(`APP {action:"list"}` → honest "no apps installed" reply). The `app-list`
scenario intentionally stays on `source: "telegram"` — an app list is a text
answer and must work from a connector.

---

# 2026-07-02 delta — brush-teeth-basic (LifeOps habit save) is FIXED

`brush-teeth-basic` now passes live on Cerebras `gemma-4-31b` (exact recipe
above; Cerebras first-class mode, `CEREBRAS_MODEL`/`OPENAI_*_MODEL` pinned),
3/3 consecutive runs: `brush-teeth-basic-after-fix.report.json` (8 335 ms) +
`-rerun1` (8 025 ms) + `-rerun2` (7 599 ms). The passing trajectory, reviewed
by hand:

- Turn 1 "Help me brush my teeth at 8 am and 9 pm every day." →
  `OWNER_ROUTINES_CREATE {action:"create", kind:"definition",
  title:"Brush Teeth", confirmed:false, intent:"Help me brush my teeth at 8 am
  and 9 pm every day."}` → preview result (`data: deferred, lifeDraft,
  preview`), reply: `"I can save this as a habit named "Brush Teeth" for
  8 am and 9 pm every day. Just let me know if that looks right…"`.
- Turn 2 "Yes, save that brushing routine." → `OWNER_ROUTINES_CREATE
  {action:"create", kind:"definition", title:"Brush Teeth", confirmed:true}` →
  real save (`data: definition, reminderPlan, performance`), reply:
  `"I've saved your brushing routine for 8 am and 9 pm every day."`.
- Final check `definitionCountDelta` **passed**: `1 matching definition(s) for
  "Brush teeth"` — `times_per_day` cadence, slots 480 + 1260, reminder plan
  present (validated by the checker, not by the reply text).

## Root causes (three stacked, found by walking the planner tool surface in
## `--export-native` trajectories) + fixes

1. **OWNER_ROUTINES was never exposed to the planner.** Stage-1 tags the ask
   `contexts:["productivity"]` and invents candidate names
   (`TASKS_CREATE_RECURRING_TASK`); the tier narrow
   (`packages/core/src/runtime/action-tiering.ts`) only keeps parents matching
   a Stage-1 candidate or scoring ≥ 0.97, and the +0.3 selected-context boost
   went to `SCHEDULED_TASKS` (declares `productivity`) but not to the
   owner-life umbrellas (`general|tasks|todos|calendar|health` only). The
   Stage-2 surface was literally `SCHEDULED_TASKS* + CALENDAR_CREATE_EVENT +
   terminals` — no description could route to an unexposed tool. Fix (PA):
   `OWNER_OPERATION_CONTEXTS` now includes `productivity`
   (`src/actions/life.ts`), OWNER_ROUTINES claims habit phrasing in
   description/similes/examples (`CREATE_HABIT`, `RECURRING_TASK`, …,
   `src/actions/owner-surfaces.ts`), and `SCHEDULED_TASKS` de-claims habit
   creation in its description/routingHint + a per-virtual override on
   `SCHEDULED_TASKS_CREATE` (`src/actions/scheduled-task.ts`,
   `src/plugin.ts`); its create trigger failures now teach the redirect
   ("call OWNER_ROUTINES action=create") so an in-turn misroute self-repairs
   instead of burning every continuation (the original ×5 retry loop).
2. **The planner-supplied `kind` union rerouted the save into the goals
   store.** With OWNER_ROUTINES exposed, gemma sometimes set `kind:"goal"` and
   the "habit" saved as a goal — `definitionCountDelta` saw nothing. The
   backing store is structural per umbrella, so `kind` is now pinned (enum of
   exactly the umbrella's kind, handler ignores overrides) on all
   `makeOwnerLifeAction` umbrellas (`src/actions/owner-surfaces.ts`).
3. **The preview→confirm handshake had no cross-turn transport on the planner
   path.** Turn 2 re-ran create as a *fresh preview* while the reply text
   claimed "saved" (result data was `deferred, lifeDraft, preview` — a false
   success). The deferred `lifeDraft` rides on ActionResult.data, which is
   never persisted into next-turn state on this path (`action_result`
   memories are only written by POST/MESSAGE). The create flow already
   honored `details.confirmed`; the umbrellas now expose a first-class
   `confirmed` boolean ("set true ONLY when the owner is confirming a
   previously previewed save") and `runLifeOperationHandler` folds
   `params.confirmed` into `createConfirmed` (`src/actions/life.ts`). Live
   gemma sets it correctly on the confirm turn (all 3 runs).

Also fixed in passing: `SCHEDULED_TASKS_CREATE` retried with the same
planner-invented `taskId` is now idempotent — the id is recorded as
`metadata.plannerTaskId` and an ACTIVE task with the same requested id is
returned (`deduplicated: true`) instead of stacking a sibling
(`src/actions/scheduled-task.ts`; the observed turn-2 duplicate-taskId retry).
The `definitionCountDelta` failure detail now lists stored definition titles
(`packages/scenario-runner/src/final-checks/index.ts`) — that diagnostic is
what exposed root causes 2 and 3.

Scenario phrasing note: `responseIncludesAny` on the preview turn gained the
alias `"brush your teeth"` (`brush-teeth-basic.scenario.ts` + `.json`,
`brush-teeth-repeat-confirm.scenario.ts`) — every correctly-routed live reply
says "brush your teeth at 8 am and 9 pm"; the check asserts engagement, not
one canned wording. The `definitionCountDelta` contract is unchanged.

Deterministic suites after the change: plugin-personal-assistant vitest
974 tests → 968 passed / 2 skipped with the SAME 4 pre-existing failures as
before the change (all in `src/lifeops/connectors/_helpers.test.ts` +
`connector-dispatch` — unrelated concurrent work on this shared branch; see
the delta note in the PR), plus 4 new tests green in
`test/scheduled-task-trigger-boundary.test.ts`; scenario-runner 218/218;
plugin typecheck clean. Generated action docs regenerated
(`packages/prompts` build → `plugins.generated.json` + core `action-docs`).
