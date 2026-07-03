# #10721 — Personal-Assistant live-model trajectory evidence

**Model under test:** `gpt-oss-120b` via Cerebras (OpenAI-compatible endpoint,
`OPENAI_BASE_URL=https://api.cerebras.ai/v1`). No LLM proxy, no mock judge — the
`live-only` scenario lane was used, so every reply and every `responseJudge`
verdict came from the live model. Provider recorded in each report as
`providerName: openai` (the OpenAI plugin pointed at Cerebras).

**Runner:** `packages/scenario-runner/src/cli.ts run
plugins/plugin-personal-assistant/test/scenarios --lane live-only`.

**Scenarios run (representative PA dispatch / triage / approval / reminders):**

| scenario | domain | status | asserted outcome |
| --- | --- | --- | --- |
| inbox-triage-classification-outcome | triage | failed | `responseExcludes` — model leaked a low-priority promo (`ShoeDeals`) into the urgent bucket |
| approval-queue-resolve-outcome | approvals | failed | `responseJudge 0.00` — model claimed it could not locate the pending request |
| email-reply-draft-outcome | PA dispatch | failed | `responseJudge 0.00` — connector error while producing the draft |
| reminder-lifecycle-ack-complete | reminders | failed | `assertResponse` — expected `"attempts":[]` on the ack path |
| reminder-dispatch-capability | reminders | failed | `modelCallOccurred[reminder_dispatch]` — dispatch model-call did not fire in window |

**What I verified by hand:** I opened the exported native trajectory
(`pa-native.jsonl.gz`) and the per-scenario reports. The trajectories contain
real, varied LLM reasoning (planner iterations, tool-call selection, evaluator
FINISH/CONTINUE decisions) — unmistakably a live model, not a deterministic
stub. Independent endpoint proof: `../10721-lifeops-benchmark-history/cerebras-endpoint-proof.txt`.

**Honest read:** every PA scenario in this slice *failed* on `gpt-oss-120b`.
These outcome scenarios were calibrated against the flagship tier with fully
wired connectors; on the smaller Cerebras model with mock connectors the
failures are a mix of genuine model-capability gaps (triage bucket leakage,
approval lookup) and environmental connector limits (mock Google token →
email-draft connector error). This is captured as-is — no cherry-picking. The
value here is a recorded, reviewable live-model trajectory set with real
assertions, not a green board.

**Files:** `0NN-<scenario>.json` (per-scenario report incl. `failedAssertions`
+ `responseText`), `matrix.json`, `pa-native.jsonl.gz`
(`eliza_native_v1` rows), `pa-native.manifest.json`, `run/viewer/index.html`.
