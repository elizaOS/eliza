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
