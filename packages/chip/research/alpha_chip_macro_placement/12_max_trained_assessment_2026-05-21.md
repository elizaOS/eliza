# E1 "max-trained" assessment — 2026-05-21

This is an honest, evidence-backed assessment of how completely the E1 AI-EDA /
ML chip-optimization research has been *trained, tested, verified, and validated*,
and where the ceiling is set by external/irreducible blockers rather than by
effort or compute. It pairs with the run report
`09_runs/2026-05-21_linux_full_training_run.md`.

## Bottom line

Within the evidence the E1 scaffold actually supports today, the trainable
lanes **are trained and verified**. The remaining gaps are **not training
gaps** — they are (a) one irreducible closed-source artifact blocker
(AlphaChip `plc_wrapper_main`), and (b) E1 design-maturity gaps (no real
movable macros, no full chip-top signoff yet) that no amount of model training
can close. "Max trained" is therefore best read as "trained to the limit of
what the current E1 artifacts and lawful public assets allow," not "every
research idea reduced to silicon-grade evidence."

## Per-lane status

| Lane | Trainable now? | State | Ceiling / blocker |
| --- | --- | --- | --- |
| Macro-placement supervised/imitation (Torch + dep-free) | Yes | Trained + verified on CPU; 2340/200/240 split; candidates quarantined | Model is a small MLP; gains only provable via OpenLane replay, which needs real E1 movable macros |
| Macro-placement deterministic baselines (center/grid/repair + CT/SA/Hier-RTLMP/ChipDiffusion proxies) | Yes | 133 candidates, 7 policies | CT/SA/Hier-RTLMP/ChipDiffusion are deterministic *proxies*; real method wrappers need each upstream tool fetched + reviewed |
| Routability/timing/power surrogate (CircuitNet3) | Yes | Trained (bounded 16-case sample); mean-baseline | A real heterogeneous GNN is **unimplemented** (net-new code, out of current scope); scaling to 2004 cases is a knob |
| PD surrogate on E1 labels | Yes | Trained on **real** OpenLane signoff label | Only one real label point (smoke run); needs many seeded runs for generalization |
| Logic-synthesis recipe policy | Yes | Real Yosys/ABC baseline (6 pass / 4 blocked) | RL policy (ABC-RL/MapTune) is a search baseline; needs equivalence-gated replay before any netlist change |
| AlphaChip Circuit Training RL | **No** | Blocked | **Irreducible**: `plc_wrapper_main` is closed-source (maintainer confirmed un-open-sourceable), GCS 403 since Feb 2026, DREAMPlace tarball also 403. No compute fixes this. |
| EDA log-triage / tool agents (RAG) | Yes (read-only) | RAG index + instruction records built | Write-capable actions remain disabled by policy until sandbox review |
| Verification/stimulus optimization | Partial | cocotb dry-run + coverage manifest | Real LLM4DV-backed seed generation pending; counts only after cocotb regression passes |
| NPU/compiler DSE (Timeloop/ZigZag/SCALE-Sim) | Partial | Workload manifest + backend preflight | Optional backends recorded present/blocked; any TOPS/W is a labeled estimate, not signoff |

## Why Nebius compute does not change the ceiling materially

The user authorized Nebius for offboard training. After tracing the run plan
(`required_remote_commands`, 174 entries), the only genuinely GPU-bound lane is
AlphaChip Circuit Training RL (`run_e1_softmacro_training.sh`, TF + Reverb). It
is blocked by the missing `plc_wrapper_main` placement-cost binary regardless
of hardware. Every other training lane in the repo is a small model that runs
acceptably on CPU and was trained here. Spinning up an H200 today would not
produce additional verified E1 evidence; it would only matter once net-new
larger models are implemented (a real CircuitNet GNN, a from-scratch CT cost
function) — which is new scope to be confirmed, not existing work.

A running H200 (`alberta-step2-seed1-tail-private-h200-...`) already exists in
the Nebius project but belongs to a different (RL) initiative and was left
untouched.

## What would actually raise the ceiling (in priority order)

1. **Materialize real E1 movable macros** (SRAM/cache/NPU tiles as LEF/DEF) so
   macro-placement candidates have a real OpenLane replay target. This is the
   single highest-leverage unblock; it converts ~169 quarantined candidates
   from `blocked` to replayable. RTL/PD scope.
2. **Drive `e1_chip_top` to full signoff** (currently launched, in global
   placement) for richer real flow-run labels and PD-surrogate generalization.
3. **Implement a real CircuitNet GNN** predictor (net-new) and scale conversion
   to the full 2004-case corpus — then offboard training on Nebius is justified.
4. **Lawfully source `plc_wrapper_main`** (a private pre-Feb-2026 copy with
   recorded SHA256) — the only path to AlphaChip RL.

## Verification anchors

- `make docs-check` PASS (exit 0), run id `validation`.
- Real OpenLane signoff: `pd/openlane/runs/RUN_2026-05-21_10-19-23/final/metrics.json`.
- All model checkers (`scripts/ai_eda/check_*`) PASS against their artifacts.
- AlphaChip blocker: `docs/toolchain/alphachip-checkpoint-blocker.md`,
  `PASS_BLOCKED_CURRENT`.
