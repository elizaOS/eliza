# #10935 — live real-LLM attachment evidence (Cerebras), scenario + smoke lanes

Executed 2026-07-02 on branch `feat/ui-mobile-gap-burndown` @ develop
`5471346e7a6`, with a live **Cerebras** key as the only provider key in the env
(`OPENAI_API_KEY`/`XAI_API_KEY`/`ANTHROPIC_API_KEY`/`GROQ_API_KEY` explicitly
emptied). Provider resolution verified by hand before the run:
`selectLiveProvider()` returned the OpenAI-compat plugin pointed at
`https://api.cerebras.ai/v1` with a `csk-…` key (core's first-class Cerebras
mode; the report's `providerName: "openai"` is the plugin family label, not
OpenAI-the-service). Scenario model: `gemma-4-31b` (Cerebras default text
model in this mode); smoke text model: `gpt-oss-120b`; smoke vision model:
`gemma-4-31b`.

Note: #10935 was closed on 2026-07-02 on the strength of a live Discord-agent
capture. This bundle adds the artifact set the issue text itself asked for —
the scenario-runner report + run viewer + native jsonl from the committed lane,
run against this tree, reviewed by hand — so the closure stands on the repo's
own evidence format too.

## 1. Scenario lane — `live-inbound-attachment` (real AgentRuntime, live model)

```
CEREBRAS_MODEL=gpt-oss-120b OPENAI_API_KEY= XAI_API_KEY= ANTHROPIC_API_KEY= GROQ_API_KEY= \
bun packages/scenario-runner/bin/eliza-scenarios run packages/scenario-runner/test/scenarios \
  --scenario live-inbound-attachment --lane live-only \
  --report …/live-inbound-attachment-report.json --run-dir …/run --export-native …
```

Result: **1 passed / 0 failed** in 3141 ms (`scenario-run-stdout.log`,
`live-inbound-attachment-report.json`).

**Trajectory hand-review** (`run/trajectories/546ac3ab…/tj-ea7245872394b9.json`,
status `finished`, 7 stages, 9 709 prompt / 211 completion tokens — real usage
numbers from the live API, incl. 7 424 provider-cache-read tokens):

- stage 0 `messageHandler`: the live model routed the user turn
  ("Read the attached note and tell me the key details.") to
  `{"processMessage":"RESPOND", …"requiresTool":true,"candidateActions":["ATTACHMENT_READ"]}` —
  no generic reply, the attachment path was chosen by the model.
- stage 3 `tool`: the REAL `ATTACHMENT` action executed
  (`{"action":"read","attachmentId":"note-1"}`) and extracted the note text
  from the base64 data-URI attachment:
  `"The project kickoff is Tuesday at 10am in room 4."`.
- stage 4 `evaluation`: live-model FINISH decision quoting every key detail
  (event / Tuesday / 10 am / room 4).
- Final user-visible reply (report `responseText`):
  “The note says: 'Project kickoff is Tuesday at 10 am in room 4.'” — passes
  both the `responseIncludesAny` gate and the `responseJudge` rubric
  (judge score ≥ 0.6 required; see report).

No proxy, no fixture: `SCENARIO_USE_LLM_PROXY` unset, lane `live-only`, and the
usage/cache token counts are provider-reported values a mock never emits.

- `run/viewer/index.html` — run viewer (open in a browser).
- `live-inbound-attachment-native.jsonl` + `.manifest.json` — 4
  `eliza_native_v1` rows exported from the trajectory (passed=4).

## 2. Smoke lane — `test:real-llm:attachment` (direct provider proof)

`bun run --cwd packages/scenario-runner test:real-llm:attachment` with only the
Cerebras key (`smoke-run-cerebras.log`, re-run and verified live this session):

- text/document attachment: reply `"Tuesday"` → **PASS**
  (gpt-oss-120b; usage total 149 tokens, 43 reasoning).
- vision attachment: reply `"Wooden boardwalk"` → **PASS**
  (gemma-4-31b, image inlined as data URI; usage total 295 tokens, 260 image
  tokens — provider-computed image tokens = real vision ingestion).

The smoke script gained a Cerebras provider entry this session (harness knob in
`packages/scenario-runner/scripts/real-llm-attachment-smoke.mjs`): Cerebras is
the repo's first-class live-eval provider but the lane previously skipped with
"no provider key" on Cerebras-only hosts (exactly the #10935 blocker comment).
Two real-world fixes rode along: the Wikimedia `/thumb/640px-…` URL variant
started returning HTTP 400 (would have silently broken the vision leg for every
provider), and Cerebras rejects remote image URLs (needs data URIs) — both
documented in the script.

Key hygiene: evidence tree swept for `csk-` — no matches.
