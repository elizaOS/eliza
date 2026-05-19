# AI-Driven Physical Design - 2025-2026 Delta to the AlphaChip Packet

This is a delta over the existing AlphaChip research packet at
`research/alpha_chip_macro_placement/`. It does not repeat that packet's
methodology, repo summaries, or experiments. It records what changed in the
ML-for-PD space in 2025-2026 and how that affects the Eliza E1 plan.

References live in `01_sources/source_inventory.yaml`. Entries tagged
`extends_alphachip_packet: true` are the ones explicitly extended here.

## 1. AlphaChip status and the open release

- Google AlphaChip Nature update 2024 (`alphachip_nature_2024`) confirms the
  proxy-cost RL macro placement methodology, with extensions for transfer
  learning across designs.
- The `google-research/circuit_training` repo (`circuit_training_repo`) is
  the open implementation. E1 already builds the Docker image and runs the
  toy training loop (see
  `research/alpha_chip_macro_placement/06_e1_notes/openlane_smoke_baseline_2026-05-19.md`).
- The 2026-05-19 E1 full OpenLane release has 0 hard macros (recorded in
  `openlane_full_release_2026-05-19.md`). AlphaChip is therefore not the
  current limiting factor; AlphaChip becomes relevant when E1 adds hard
  SRAM/cache/NPU/peripheral macros or when an explicit clustering pass
  converts logic regions into soft macros.

Delta for the AlphaChip packet:

1. Treat AlphaChip as a candidate-generation pass, not a signoff pass. This
   is consistent with `research/alpha_chip_macro_placement/00_index.md`'s
   "AlphaChip optimizes proxy wirelength/congestion/density. It is not
   signoff." statement.
2. Replace the per-run AlphaChip-vs-OpenROAD comparison with a structured
   experiment harness that records: routed wire length, congestion, timing,
   DRC, LVS, antenna, and IR drop for both AlphaChip-derived and
   OpenROAD-derived macro placements.

## 2. Independent reproductions and competing approaches

`tilos_macroplacement_repo` (TILOS) is the canonical independent
reproduction. It already lives under `external/MacroPlacement` in the E1
setup. 2025-2026 deltas:

- TILOS pipeline now ships translation utilities between Circuit Training
  protobufs and DEF/Bookshelf, which is exactly what step 6 in
  `00_index.md`'s "Practical pipeline" requires.
- NVIDIA AutoDMP (`autodmp_repo`) combines DREAMPlace with multi-objective
  Bayesian optimization on macro placements. For E1, AutoDMP is the best
  near-term alternative to AlphaChip because it does not require an RL
  training loop and runs in minutes per design.
- ChiPFormer (`chipformer_paper`), MaskPlace (`maskplace_paper`), and
  WirePlanRL (`wireplan_rl_paper`) are RL/ML placement research baselines.
  They are useful for comparison only; none have a maintained production
  pipeline like AlphaChip / AutoDMP.

## 3. ML-driven analysis layers (not placement)

These are pre-route ML predictors that can be inserted as informational
gates inside OpenLane 2 steps without replacing the legacy PD path.

- CircuitNet 2.0 (`circuitnet_2_paper`, `circuitnet_repo`): the PKU
  benchmark and dataset for ML-PD. Pretrained checkpoints exist for
  congestion, IR-drop, and DRC. Direct use case for E1: load a pretrained
  congestion predictor over OpenLane 2's post-placement DEF to flag hotspots
  before global routing.
- PowerNet (`powernet_paper`): CNN-based dynamic IR-drop prediction.
  Complements OpenROAD PSM (`openroad_psm_docs`) by providing a fast
  pre-signoff estimate. Useful when iterating PDN topologies in the live
  E1 config without paying for a full PSM run each time.
- CongestionNet (`congestionnet_paper`), Net^2 (`net2_paper`), PROS
  (`pros_paper`), GNN-based DRC predictors (`drc_predictor_2024`): pre-route
  congestion and DRC prediction. Their value for E1 is detecting hotspots
  before TritonRoute, not replacing TritonRoute.
- ML-CTS (`ml_cts_paper`, `ml_cts_2024_paper`): a post-CTS optimization
  layer for skew/power tradeoff. Optional; TritonCTS already produces a
  clean CTS for the E1 design.

## 4. Synthesis-time ML

OpenABC-D (`openabcd_repo`), LSOracle (`lsoracle_repo`), Mockturtle
(`mockturtle_repo`) and BOOM-Explorer (`boom_explorer_paper`) are the main
academic anchors for ML-driven logic optimization and microarchitecture DSE.
For E1:

- These are research-grade. Treat as roadmap items, not P0 dependencies.
- The current Yosys 0.50+ + abc9 path is already strong enough for the
  Sky130 PD smoke.
- BOOM-Explorer-style microarchitecture sweeps are out of scope at the PD
  layer; if E1 ever needs them, they belong in
  `research/cpu_subsystem_2026/`.

## 5. How AI-PD fits into the E1 evidence model

The E1 PD evidence contract (`pd/signoff/run-manifest.schema.json`) and the
signoff gate (`scripts/check_pd_signoff.py`) are evidence-driven. They want
artifacts: DEF, GDS, timing reports, DRC reports, antenna reports, LVS
reports, PSM IR-drop reports, and tool digests.

ML predictors are not evidence. They are pre-flight signals. The correct
integration pattern is:

1. ML predictor runs after OpenROAD placement (or after Yosys synthesis for
   the very-early-stage ones).
2. Predictor output is logged as `pd_ml_predictor_evidence.json` or similar
   under `docs/pd/`.
3. Predictor output never gates signoff. The legacy DRC/LVS/STA/PSM gates
   continue to be the ground truth.

This way E1 can incorporate ML-PD without making the signoff contract
softer.

## 6. AlphaChip vs AutoDMP vs OpenROAD macro placement for E1

Ranked by practical readiness for E1 today:

1. OpenROAD built-in macro placer + manual hint-based macro placement -
   already part of OpenLane 2, no extra wiring.
2. AutoDMP (`autodmp_repo`) - DREAMPlace + Bayesian optimization, fast,
   self-contained, easy to wrap with the existing Docker pattern.
3. AlphaChip via `circuit_training` - already running in E1 toy mode;
   requires per-design RL training time; biggest payoff when E1 has many
   real macros to place.

Until E1 has real hard macros, the ranking above stays. Once SRAM macros,
NPU buffer macros, and peripheral hard IP land, AlphaChip's relative value
grows.

## 7. Items deliberately out of scope here

- LLM-driven RTL generation (RTLLM, etc.) - out of scope for a PD packet.
- ML-aided HLS - covered briefly in
  `02_analysis/open_eda_flow_state_of_the_art.md` HLS section; the HLS
  decision belongs to the compiler/runtime side, not PD.
- Closed-source commercial ML EDA (Cadence Cerebrus, Synopsys DSO.ai) -
  intentionally excluded by source policy.
