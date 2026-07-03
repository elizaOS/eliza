# Stage 5 — base vs fine-tuned quality (native tool-call / JSON structure)

eliza-1-2b **fine-tuned** on the 2,774-row gpt-5.5 scenario corpus vs the **base** google/gemma-4-E2B, on the held-out test split, structure-adherence per bucket. Run locally on M4 Max / MPS via the (bug-fixed) `native_tool_call_bench.py`.

**Sample is small (n=2/bucket)** — local MPS inference of two ~10GB models is slow and the harness kept getting killed on session cycles; these are directional, not statistically tight. Raw JSON: `base.json`, `ft.json`.

| bucket | n | base structure% | finetuned structure% | Δ |
|---|---|---|---|---|
| planner_json | 2 | 100.0% | 100.0% | +0.0 |
| response | 2 | 100.0% | 100.0% | +0.0 |
| routing_json | 2 | 0.0% | 50.0% | +50.0 |
| tool_call | 2 | 0.0% | 0.0% | +0.0 |
| **overall** | 8 | **50.0%** | **62.5%** | **+12.5** |

base decode 13.79 tok/s, finetuned 10.85 tok/s (MPS).

## Honest read

Overall structure adherence: base 50.0% → finetuned 62.5% (Δ +12.5 pts) on this tiny sample. The fine-tune was on a scenario-heavy mix (55% our gpt-5.5 scenarios + 45% base eliza-1 corpus) for 1 epoch — a light specialization pass, so a modest/mixed delta on n=2 is expected. A statistically meaningful comparison needs the full test split on a GPU (the harness runs fast there; locally it's MPS-bound). The DEPLOYABLE artifact (q4_k_m GGUF, verified generating at 157 tok/s) is the concrete Stage-5 deliverable; this bench is the directional quality check.
