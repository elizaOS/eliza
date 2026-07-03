# LifeOps/PA real-model benchmark — score history

Durable, append-only series backing #11789. Every row is a **live-model** run
(no proxy, no mock judge) against `develop`, keyed by harness so points stay
comparable within a series. Add a row with `scripts/append-score-history.mjs`
(never hand-edit this file — it is regenerated from `score-history.jsonl`).

## Series: `lifeops-prompt-benchmark`

| date (UTC) | model | slice | n | pass | accuracy | commit | notes |
|---|---|---|---:|---:|---:|---|---|
| 2026-07-03 19:05:55 | gpt-oss-120b | direct variant: capability-coverage(8)+self-care(2) | 10 | 7 | 70.0% | `b2f44a0f5` | PR #12022 seed baseline (model per REVIEW.md; not in report JSON) |

## Series: `lifeops_bench`

| date (UTC) | model | slice | n | pass | accuracy | commit | notes |
|---|---|---|---:|---:|---:|---|---|
| 2026-07-03 19:08:54 | eliza-1-2b | smoke static (5 domains) - hermes adapter, CPU | 5 | 0 | 0.0% | `b40e60275` | PR #12045; 0.000 = gemma tool-syntax vs Hermes-XML confound, not capability |
| 2026-07-03 19:20:00 | eliza-1-4b | smoke static (5 domains) - hermes adapter, CPU | 5 | 0 | 0.0% | `b40e60275` | PR #12045; correct tool+args in gemma-native tool_code, Hermes adapter cannot parse |
| 2026-07-03 19:32:11 | eliza-1-2b | calendar static slice (10) - hermes adapter, CPU | 10 | 0 | 0.0% | `b40e60275` | PR #12045; hermes-adapter confound |
| 2026-07-03 19:35:26 | gemma-4-31b | static, 12/domain x 10 domains - cerebras-direct (native tool-calling) | 120 | 16 | 13.3% | `517ad615d` | clean capability number (no Hermes confound); resolves #11789 residual |

---

Per-run breakdowns (per-task / per-domain) and raw artifacts live in the
committed run files referenced by each row's `source`, and in `score-history.jsonl`.
