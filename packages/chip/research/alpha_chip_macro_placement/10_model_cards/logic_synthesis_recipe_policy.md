# Model card — logic-synthesis recipe policy baseline

- **Task:** search/score Yosys + ABC synthesis recipes for E1 RTL blocks
  (area/depth) before placement.
- **Code:** `scripts/ai_eda/generate_e1_synthesis_recipe_corpus.py`,
  `run_logic_synthesis_policy_baseline.py`,
  `check_logic_synthesis_policy_baseline.py`.
- **Method:** deterministic recipe corpus + real Yosys/ABC execution (not a
  learned policy yet). ABC-RL / MapTune-style RL is the next step and is gated
  behind OpenABC-D leakage review + E1 equivalence replay.
- **Data:** E1 RTL (DMA, NPU) recipe corpus (2 targets, 5 recipes this run);
  OpenABC-D quarantined as public pretraining only.
- **Result (2026-05-21):** 6 recipes passed, 4 blocked (ABC mapping timeouts
  under the interactive limit), 0 failed.
- **Claim boundary:** recipe corpus + baseline only; no PPA, equivalence, or
  release claim. No synthesis candidate reaches PD without RTL
  lint/elaboration + Yosys synth + equivalence/formal + OpenLane replay.
- **Known limits:** search baseline, not RL; ABC mapping recipes time out and
  need longer budgets on a batch host.
