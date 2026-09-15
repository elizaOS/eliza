# Local planner/action recovery — September 4, 2026

Branch: `nubsstableDONOTDELETE`; starting revision: `d779b11fab4`.
Surface: the existing in-app preview at `http://127.0.0.1:2138`, local
runtime on `31337`, Cerebras `qwen-3.8-27b`. This is sampled acceptance,
not a claim that every action, voice path, deployment or device is correct.

## Confirmed defects and changes

- Browser navigation offered an unavailable `bridge` target; the optional
  target contract and existing workspace provider now expose actual available
  targets. An empty provider omission sentinel is not a target choice.
- A selected navigation child could hide its umbrella page-reading action.
  Candidate budgeting now preserves declared parent/child relationships after
  authorization gates, rather than inferring a tool from the user's text.
- Synthetic Notes candidates could resolve to navigation without the Notes
  data action. Model-selected domains fill missing coverage. An initial broad
  version of this fix over-expanded Calendar; the final version does not add
  every same-context action when a selected candidate already covers it.
- Stage 1's model-generated intent list was discarded on conversion to the
  message plan. It now reaches the planner and evaluator. Compound requests
  receive real model evaluation instead of the single-tool completion gate.
  Structured outcomes are not treated as one-required-tool-call-per-outcome.
- The evaluator now checks outcomes before choosing its decision and requires
  current-turn navigation evidence for an explicit request to open a view.
  A valid trailing CONTINUE envelope after prose is preserved, not promoted
  into a completed reply. NEXT_RECOMMENDED's actual field name is documented.
- Notes now returns the persisted note in the action result. Create/update
  parameter descriptions distinguish complete content from the optional body
  field and require preservation of unedited content. No heuristic rewrites of
  the user's saved text were added.
- Browser success no longer supplies a canned visible prefix alongside the
  required model response.
- Model-authored reply recovery can select supporting current-turn receipt
  IDs instead of needing byte-identical action text. Existing receipt
  resolution rejects invented IDs, previews, noncommitted outcomes and
  rollbacks. The selected proof is carried to final delivery. No result is
  accepted merely because an unrelated tool returned `success: true`.
- Grounding failures propagate to the existing settled-action recovery
  boundary rather than suggesting a completed mutation should be repeated.

## Browser and trajectory evidence

All rows use real typed input through the preview, not mocked UI replies.
Foreground timing comes from `/api/dev/inference-timing`; trajectory duration
can include background work and must not substitute for visible latency.

| Scenario | Observation | Trace / foreground time |
| --- | --- | --- |
| Browser navigate and read | Example Domain loaded visibly; BROWSER read `h1`; generated reply identified the heading | `step-1788564283494-um7jgf`; 16.77 s |
| Open Notes and update body | Visible Notes, title retained, exact `bring a charger` body | `step-1788565499583-33yfsi`; 10.71 s |
| Open Notes and create | Exact title `Notes check 1947`, body `water and charger`, no duplicate title in body | `step-1788565546845-e8vtt5`; 11.13 s |
| Final model-led Notes update | VIEWS/show, evaluator CONTINUE, NOTES/update, evaluator FINISH; exact `charger and water`, title retained | `step-1788565670850-ykc8sy`; 13.56 s |
| Calendar before scope correction | Failed before navigation; provider rejected 145,557 tokens against 131,072 limit, following a 139-tool expansion | `step-1788565709443-2f822d`; FAIL |
| Calendar after scope correction | Visible Calendar month view; VIEWS/show, evaluator NEXT_RECOMMENDED, CALENDAR/search_events; Qwen model QA reported tomorrow at noon | `step-1788565864409-sfjuft`; 12.88 s; 5 planner tools |
| Final Browser navigate and read | Visible Example Domain; two real BROWSER operations and Qwen-authored final heading answer | `step-1788565933192-nahvrw`; 9.84 s |

An earlier Notes turn `step-1788564978158-jrke4k` duplicated its title and
spent 60,068 ms in the final evaluator call, then hit `REPLY_GROUNDING_FAILED`.
Those observations are recorded separately: the trace does not establish why
that individual model call took 60 seconds. Do not label it a confirmed quota
retry, network fault or model reasoning delay without further telemetry.

## Verification

- Core planner/response/evaluator regression group: 417 tests passed.
- Callback voice rendering, voice provenance and side-effect claim groups:
  244 tests passed. These are code tests, not microphone/speaker acceptance.
- Effect receipts and audience admission: 25 tests passed.
- Browser action/provider: 30 tests passed; BrowserService: 22 passed.
- Notes action: 16 tests passed.
- App-control view switching/ownership: 201 tests passed.
- Core, Browser, Notes and App-control typechecks passed during this pass.
- Changed-file Biome checks and `git diff --check` passed.

These are focused suites. The broader Stage 1 suite still has five previously
reproduced baseline failures (three live-lookup fallback cases, one platform
reply reference, one deterministic-selection fixture). Full monorepo/i18n
verification is not certified green.

## Remaining acceptance gates

1. **Latency: HOLD.** Recent successful compound turns still took 10–17 s.
   Multiple model stages and action execution are measured; the isolated
   60-second evaluator spike still needs provider-attempt telemetry.
2. **Voice: HOLD.** No physical microphone, speaker, Bluetooth, end-of-turn or
   Pixel voice acceptance was performed in this text-only pass.
3. **VPS/Pixel: HOLD.** This checkpoint is local source and local browser proof.
   No deployment, phone build or device installation is included.
4. **Exhaustiveness: HOLD.** Legacy routing/fallback paths still exist in the
   repository. These tested turns use the real model/planner/actions; this is
   not a repository-wide no-hardcoded-response certification.
5. **Provider correctness:** receipt IDs enforce current-turn committed proof,
   but model reasoning and selection still require behavioral QA. The tests
   do not prove that a model can never make an incorrect claim.
6. **Protocol efficiency:** the final successful Browser turn still recovered
   an evaluator tool-call-shaped response by returning to the real planner.
   It did not leak that syntax to chat, but this extra planning adds latency.

## Temporary QA notes

Only these three notes were created in this pass for compound-action checks;
their final content is retained here so scoped cleanup is reversible by
recreation. Pre-existing notes/events are not cleanup targets.
The three listed notes were subsequently removed through the Notes capability
API, by exact IDs, with successful deletion receipts. This cleanup is API
verification, not proof of model-driven delete behavior.

| Title | Body | ID |
| --- | --- | --- |
| Compound QA 1921 | charger, water, and headphones | `note-23a477fa-e138-426b-8390-24515482b5d3` |
| Local Acceptance 1936 | bring a charger | `note-55a7ac3f-344a-43cd-a6d6-32cae030bcc5` |
| Notes check 1947 | charger and water | `note-804e0f13-ed21-4b60-b0ad-207ca1a8fceb` |

## Follow-up: Browser "go home" regression (20:45–21:04 EDT)

Starting revision: `dde5ca69603` on the same protected branch and local stack.
These changes have not been deployed to VPS or Pixel. Tests below were typed
in the user's existing preview with voice off. No saved notes or calendar
events were created, edited, or deleted in this follow-up.

### Root causes addressed

- Original trace `step-1788569091476-fshhs5` selected BROWSER with an invented
  `https://go.home` URL. Its later reply-synthesis output was raw VIEWS tool
  markup, not a user reply. A core fallback substituted the literal
  `The requested action completed.` and finished without verifying the intent.
  That literal originated in `f30c39fc34f` (August 19). It is now removed.
- Single declared intents now receive the existing real evaluator, not just
  compound intents. Invalid required-reply output goes through evaluation and
  authorized replanning, never fabricated completion or execution of an
  unsolicited synthesis tool call. A synthesis-only caller without an action
  catalog receives `POST_TOOL_REPLY_INCOMPLETE` if evaluation cannot finish.
- Removed the second, literal UI-label check: it rejected a valid model reply
  saying "main chat" because the navigation receipt label was "Home". Existing
  reply-safety checks and the evaluator remain. Already-delivered verified
  action callbacks are not rewritten into duplicate replies.
- VIEWS and BROWSER contracts explicitly distinguish app Home (`chat`) from
  website navigation. No regex intent router or canned navigation reply added.
- The OpenAI-compatible Cerebras adapter dropped `responseSchema` unless the
  caller also specified `responseFormat`. The existing JSON-mode lane now
  honors schema-only calls; core retains schema validation. The real HTTP
  wire-format test verifies `response_format: {type: "json_object"}`.
- Live Notes recency QA exposed a separate data omission: list results discarded
  stored IDs and timestamps. Results now retain the existing service's full
  note records. Tool descriptions distinguish topic filters from recency;
  no new storage, sorting heuristic, or alternate notes service was added.

### Fresh visible evidence

| Scenario | Result | Trace / foreground time |
| --- | --- | --- |
| Home before duplicate-label fix | Correct destination but unnecessary reply rewrites | `step-1788569529578-43jx6b`; 13.30 s |
| Home after duplicate-label fix | Visible scenery/home, preserved chat and focused composer | `step-1788569693673-ilr1go`; 5.80 s |
| Notes before timestamp fix | Opened Notes, but could not establish most-recent note | `step-1788569860522-o78v06`; 8.18 s; lookup FAIL |
| Notes after timestamp fix | NOTES/list without a fake recency filter; model selected `Live refresh verified.` from the real updatedAt value, also checked against state API | `step-1788570058308-p35jop`; 5.98 s |
| Calendar open and lookup | Visible Calendar; verified Qwen model QA event September 5 at noon EDT | `step-1788570074303-2m6hfm`; 23.01 s; speed FAIL |
| Browser open and read | Visible example.com destination; BROWSER navigate then snapshot; generated answer `Example Domain` | `step-1788570159188-7a8mnd`; 8.90 s excluding queue wait |
| Exact `go home` from Browser, final build | VIEWS/show/chat; real evaluator FINISH; visible forest Home and intact chat/input focus | `step-1788570196816-bs44jj`; 6.44 s |

The final Notes, Calendar, Browser, and Home evaluator outputs were JSON,
not leaked tool markup. These are samples, not an exhaustive correctness claim.

### Latency finding that remains open

Calendar's text arrived after 23.01 s, but its trajectory did not complete until
84.77 s. The following Browser request visibly waited before its own trajectory
started. Calendar's foreground included an 8.43 s action (7.96 s text-model
span) and a 7.44 s planner evaluator. A separate post-turn evaluator produced
fact/preference/relationship/identity/success results before terminalization.
`generateChatResponse` awaits `drainRoomPostDeliveryTasks` after publishing the
ready reply; the tracked RUN_ENDED barrier includes that post-turn evaluator.
This establishes a completion/queue-delay path, not the provider-side reason
for the individual slow model calls. Do not treat foreground timing as complete
user-perceived latency. Do not disable room-state ordering to hide this delay.

### Verification for this follow-up

- Core planner, evaluator, reply recovery, failure suppression, candidate
  surface, and user-facing-text group: **457 tests passed**.
- OpenAI provider: **438 tests passed** in 31 files, including the real
  loopback HTTP wire-format assertion; package build and typecheck passed.
- App-control view switching/ownership: **211 passed**; current-view provider:
  **11 passed**. Browser action/provider: **30 passed**.
- Notes: **95 tests passed**, including timestamp/identity retention and
  real temporary-store CRUD. Two UI suites failed to collect because existing
  UI imports could not resolve `@elizaos/core/errors`; full Notes suite is HOLD.
- Core, OpenAI, App-control, Browser, and Notes typechecks passed. Changed-file
  Biome and whitespace checks passed.
- Root `bun run verify` passed guide parity and Biome-version checks, then
  failed the existing missing-i18n-key gate (including 13 missing English keys).
  Full repository verification is not green.

**Still HOLD:** end-to-end latency and post-turn queue delay; physical voice,
silence/end-of-turn/audio playback; VPS; Pixel; repository-wide elimination of
legacy hardcoded fallbacks. The existing local preview is left at `/chat` for
user testing. No claim of universal/perfect behavior is warranted.
