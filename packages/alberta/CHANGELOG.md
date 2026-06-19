# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.26.0] - 2026-05-22

### Added

- **GRU recursive perception for PrototypeAgent (Step 8a)** — fixed-weight echo-state
  GRU augments raw observations with learned hidden state before passing to all
  downstream components (OaK, Horde, world model). Glorot-uniform weight init,
  zero hidden init, pure-functional `_gru_step`. Controlled via
  `GRUPerceptionConfig(observation_dim, hidden_dim)` in `PrototypeAgentConfig`.
  12 new tests cover config validation, weight shapes, hidden dynamics, and
  augmented-obs routing. (`alberta_framework/core/prototype_agent.py`,
  `alberta_framework/core/__init__.py`)

- **Step 9 prioritized dreaming** — multi-step imagined rollouts with scored
  candidate selection. `score_dream_candidates` picks the most surprising/useful
  anchor state from `dream_candidate_count` random candidates; rollouts proceed
  for `dream_rollout_horizon` steps under the behavior model. BehaviorModel now
  tracked in `Step9DreamingState` and updated every real step.
  (`alberta_framework/steps/step9.py`)

- **Intelligence Amplification (Step 12) now exported from public API** —
  `ExoCerebellumAgent/Config/State`, `ExoCortexAgent`, `IAAgent/Config/State/
  UpdateResult/ArrayResult`, `RecommendationProtocolConfig/State/Result`,
  `init_recommendation_protocol_state`, and `update_recommendation_protocol`
  are now importable directly from `alberta_framework.core`.
  (`alberta_framework/core/__init__.py`)

### Fixed

- **`PrototypeAgentConfig` now validates `world_model.observation_dim`** when
  `gru_perception` is set, ensuring the world model's observation dimension
  matches `gru_perception.augmented_dim()`. Previously only `oak.observation_dim`
  was validated. (`alberta_framework/core/prototype_agent.py`)

- **`out_of_class_results.json` artifact restored** — reconstructed from the
  completed `out_of_class_SUMMARY.md` (30 seeds, 3 streams; original JSON was
  lost). Step 2 evidence gate now passes.
  (`outputs/step2_canonical/out_of_class_results.json`)

### Tests

- 1901 tests pass (up from 1900); new test `test_world_model_dim_mismatch_raises`
  covers the GRU + world-model dimension validation.

## [0.25.0] - 2026-05-21

### Added

- **CartPole FA Dyna benchmark** (Step 7) — 10-seed 5000-step comparison of
  linear-model Dyna vs real-only DifferentialSARSA on CartPole-v1 continuing.
  Result: ceiling effect — both agents achieve optimal reward=1.000 on all 10
  seeds; linear world model is stable (no degradation) but CartPole is too easy
  to reveal planning benefit. Faster benchmark (JIT-wrapped update functions,
  module-level agent objects) runs in 26 s vs the original 135+ min.
  (`benchmarks/step7_cartpole_dyna.py`, `outputs/step7_cartpole_dyna/`)

- **`NonlinearQHordeActorCriticAgent`** — action-value Horde critic with
  expected-SARSA targets, one control head per action; exported from the
  package. 10-seed variant search shows best variant ties Q at +0.0 improvement
  vs SARSA's +12.0 on catch — action-value critic substitution ruled out as
  Step 4 closure.

- **Step 4 probe suite** — adaptive-ObGD NLHAC at 500 and 1000 steps (both
  regress catch: -1.4 / -6.0 vs Q while SARSA is +6.6 / +13.4); wider (64,64)
  actor/critic NLHAC (catch -2.0 vs SARSA +9.33); rules out three more
  approaches to close the AC-vs-SARSA catch gap.

- **`rlsecd_external_audit.py`** — reproducible script checking availability
  of external `rlsecd` / `chronos-sec` sibling repos; result embedded in
  Step 3 solution gate.

### Fixed

- **Step 7 CartPole benchmark JIT regression** — original `step7_cartpole_dyna.py`
  created new agent/model Python objects per seed, forcing JAX to re-trace the
  planning scan body on every step; rewritten to use module-level agent/model
  objects and explicit `jax.jit(static_argnums=...)` wrappers.

## [0.24.0] - 2026-05-21

### Added

- **PrototypeAgent end-to-end benchmark** — 5-seed CartPole-v1 continuing
  control benchmark proves all 12 integrated steps run correctly; both flat
  DifferentialSARSAAgent and PrototypeAgent achieve mean reward 1.000 (5/5 seeds
  positive) with no NaN weights (`benchmarks/prototype_end_to_end.py`,
  results in `outputs/prototype_end_to_end/`)

### Added (continued)

- **`AdaptiveObGDBounding`** (Elsayed et al. 2024, Appendix B) — ObGD global
  bounding followed by per-weight RMS normalisation; registered in
  `_BOUNDER_REGISTRY` and exported from `alberta_framework`; 3 tests added to
  `tests/test_config_serialization.py`

### Fixed

- **PrototypeAgent dreaming JIT regression** — guarded dreaming scan closure
  was redefined on every `update()` call, causing JAX to retrace the XLA
  computation graph each step (~720 ms/step); extracted to
  `PrototypeAgent._run_dreams()` with `@functools.partial(jax.jit, static_argnums=(0,))`
  reducing to ~8 ms/step (94× speedup)

## [0.23.0] - 2026-05-21

### Added

- **Step 11 OaK curation benchmark** — 10-seed 6-state chain proves utility
  tracking detects and replaces counterproductive options; post-curation
  avg-reward recovers to 0.935 (8/10 seeds ≥ 0.70) from mean 0.70 pre-curation
  (`benchmarks/step11_oak_curation.py`, results in `outputs/step11_oak/`)

- **Step 12 IA augmentation benchmark** — 5-seed demonstration that
  exo-cerebellum MSE ≈ 0 (vs zero-baseline 0.167) and cortex recommendation
  accuracy 60% (>50% random) on 6-state chain
  (`benchmarks/step12_ia_augmentation.py`, results in `outputs/step12_ia/`)

- **Neuron utility tracking** — per-hidden-unit EMA of gradient L2 norm for
  dormant-neuron detection in long-running continual agents
  - `MLPLearner(track_neuron_utility=True, neuron_utility_decay=0.99)` stores
    `MLPLearnerState.neuron_utility: tuple[Array, ...] | None` (one `(h_i,)`
    array per hidden layer, None when disabled)
  - `MLPLearner.dormant_neuron_fraction(state, threshold)` returns the fraction
    of neurons below the utility threshold
  - `MLPLearner.reset_dormant_neurons(state, key, threshold)` re-initialises
    incoming weights, eligibility traces, and optimizer states for dormant
    neurons; zeroes outgoing weights from next layer to prevent signal injection
  - Config roundtrip via `to_config()` / `from_config()` includes new fields
  - 11 tests covering shapes, EMA dynamics, dormancy counts, reset, and serialisation

## [0.22.0] - 2026-05-21

### Added

- **Autostep-for-actor** — per-weight adaptive step-sizes for all actor MLPs
  - `NonlinearHordeActorCriticAgent` actor now uses `Autostep.init_for_shape` /
    `update_from_gradient`; fixed scalar `actor_step_size` removed from config
  - `AverageRewardHordeActorCriticAgent` receives the same upgrade; per-weight
    `AutostepParamState` stored in `AverageRewardHordeActorCriticState`
  - Both agents accept an optional `actor_optimizer: Autostep | None` constructor arg
    (default `Autostep(initial_step_size=0.05)`) and expose `actor_optimizer` property
  - Config roundtrip includes `actor_optimizer` serialisation

- **Nonlinear STOMP / OaK base Q-function** — replaces hard-coded linear weights
  - `STOMPState.base_learner_state: MultiHeadMLPState` replaces `base_q_weights` /
    `base_traces`; the underlying `MultiHeadMLPLearner` has `n_heads = n_total_actions`
  - `STOMPConfig.base_hidden_sizes: tuple[int, ...] = ()` enables nonlinear trunks;
    the empty-tuple default preserves previous linear behaviour exactly
  - Semi-MDP differential Q target (`R_o - r̄·T_o + γ_o·max Q(s')`) computed via
    NaN-masked `MultiHeadMLPLearner.update` — compatible with both linear and MLP paths
  - OaK curation resets the curated option's head (weights, biases, traces, optimizer
    states) inside the `MultiHeadMLPState` rather than zeroing a raw weight slice
  - `STOMPAgent.base_q_values(state, obs)` and `OaKAgent.base_q_values(state, obs)`
    expose Q-value computation through the agent API, used by `ExoCortexAgent.recommend`
    and `PrototypeAgent.act` (both now robot-ready for high-dimensional observations)
  - `feature_to_subtask_specs` in `prototype_agent.py` handles both linear (head-weight
    stack) and nonlinear (first trunk-layer proxy) feature-importance extraction

## [0.21.0] - 2026-05-21

### Added

- **PrototypeAgent** — all 12 Alberta Plan steps in a single continuing agent
  - `PrototypeAgentConfig`: minimal defaults (just `n_primitive_actions` + `observation_dim`)
  - Single `.update()` integrates world model, buffer, OaK, dreaming, Horde, and IA
  - `feature_to_subtask_specs`: automatic subtask extraction from OaK Q-weight importances
  - `run_prototype_scan` / `run_prototype_smoke`: JIT-compiled loop and validity probe
  - 50 tests covering all components and 200-step fineness

## [0.20.0] - 2026-05-21

### Added

- **Steps 11 and 12: OaK and Intelligence Amplification**
  - `OaKAgent`: extends STOMP with utility EMA, curation, and option keyboard (Barreto et al.)
  - `ExoCerebellumAgent` / `ExoCortexAgent` / `IAAgent`: paired cerebellum + cortex
    augmenting a partner agent's observations and action recommendations
  - 32 OaK tests + 30 IA tests

## [0.19.0] - 2026-05-20

### Added

- **Step 10: STOMP temporal abstraction**
  - `STOMPAgent`: subtask-defined options, intra-option differential Q, option outcome models
  - `SubtaskSpec` / `STOMPSpecArrays` / `STOMPState`: JAX-compatible option state
  - 36 tests; seeded benchmark proves STOMP options accelerate control ~10x vs flat
  - `Step10STOMPConfig` production facade

## [0.18.0] - 2026-05-19

### Added

- **Steps 5–9: Average-reward control, world models, and dreaming**
  - `DifferentialTDLearner` / `DifferentialSARSAAgent` / `DifferentialGTDLearner`:
    continuing average-reward prediction and control (Steps 5–6)
  - `AverageRewardHordeLearner` / `AverageRewardHordeActorCriticAgent`:
    nonlinear shared-trunk Horde for differential GVF prediction and actor-critic
  - `OneStepWorldModel` / `ActionConditionedWorldModel`: reward + next-obs prediction (Step 8)
  - `GuardedDreamer` + `RecentObservationBuffer`: error-gated dreaming with real-state anchors (Step 9)
  - `Step7DynaConfig`: real-transition update + fixed `planning_steps` Dyna backups
  - Seeded benchmarks: Step 7 prioritized Dyna improves final-window reward from 0.92 → 1.00;
    six-state chain Dyna wins cumulative reward 8/10 seeds (+41.7%)
  - RiverSwim benchmark (Step 6): 10/10 seeds, 97.5% right-action rate

## [0.17.1] - 2026-04-10

### Added

- **Autostep-for-GTD(λ)** — per Kearney et al. (2019)
  - `AutoTDIDBD` optimizer with per-weight step-size adaptation for TD learning
  - Eligibility traces integrate with Autostep's normalizer and overshoot prevention

### Fixed

- Flax dependency added and version pinned in `pyproject.toml`

## [0.17.0] - 2026-04-05

### Added

- **Replacing traces** — `TraceMode.REPLACING` on `MultiHeadMLPLearner`
  - Replaces stale trace magnitude on re-visit rather than accumulating
  - Configurable per-head alongside `TraceMode.ACCUMULATING`
  - Trace-bounding integration: replaced traces scaled by ObGD bounding factor

## [0.16.0] - 2026-03-15

### Added

- **SARSA agent (Step 4a)** — on-policy control via Horde architecture
  - `SARSAAgent`: wraps `HordeLearner` with epsilon-greedy action selection and SARSA target computation
  - `SARSAConfig`: configuration for n_actions, gamma, epsilon schedule
  - `SARSAState`, `SARSAUpdateResult`: immutable state and result types
  - `run_sarsa_episode`: Python loop for episodic Gymnasium environments
  - `run_sarsa_continuing`: continuing mode with pseudo-boundary handling (daemon-style)
  - `run_sarsa_from_arrays`: JIT-compiled `jax.lax.scan` for pre-collected data (security-gym)
  - Gumbel trick tie-breaking for uniform action selection among equal Q-values
  - Linear epsilon decay schedule (configurable start, end, decay steps)
  - Optional prediction demons coexist with control demons in the same Horde
  - Config serialization via `to_config()` / `from_config()` roundtrip
  - 30 new tests covering init, action selection, update logic, epsilon decay, bounding, serialization, and scan loop
  - Example: `examples/The Alberta Plan/Step4/sarsa_cartpole.py`
  - Documentation: `docs/guide/sarsa-control.md`

- **Trunk trace guard** — validation preventing `gamma * lamda > 0` on `MultiHeadMLPLearner` with hidden layers
  - VJP backward pass folds error into trunk cotangent before trace accumulation; only correct when traces reset each step
  - Linear baseline (`hidden_sizes=()`) allows any gamma/lamda
  - `HordeLearner` enforces trunk gamma=0 by design (per-head trace decay only)
  - Expanded docstrings on `MultiHeadMLPLearner` and `HordeLearner` explaining the constraint

## [0.10.0] - 2026-02-27

### Added

- **Hybrid optimizer (`head_optimizer`)** — separate optimizer for trunk vs head layers on `MLPLearner` and `MultiHeadMLPLearner`
  - `MLPLearner(head_optimizer=...)`: output layer uses `head_optimizer`, hidden layers use `optimizer`
  - `MultiHeadMLPLearner(head_optimizer=...)`: all prediction heads use `head_optimizer`, trunk uses `optimizer`
  - Enables stable LMS+ObGD for non-convex hidden layers with adaptive Autostep for the linear output head
  - Backwards compatible: `head_optimizer=None` (default) keeps all layers on the same optimizer
  - 10 new tests (6 MLPLearner, 4 MultiHeadMLPLearner)

## [0.9.0] - 2026-02-22

### Added

- **Agent lifecycle tracking** — `step_count`, `birth_timestamp`, `uptime_s` on all learner states
  - `LearnerState`, `MLPLearnerState`, `TDLearnerState`: new fields with backward-compatible defaults
  - `MultiHeadMLPState`: added `birth_timestamp` and `uptime_s` (already had `step_count`)
  - `step_count` incremented inside `update()` (JAX-traced, safe in `jax.lax.scan`)
  - `birth_timestamp` set at `init()`, immutable across updates
  - `uptime_s` accumulated after each `jax.lax.scan` completes in all learning loops
  - All learning loop functions stamp uptime: `run_learning_loop` (simple + tracking), `run_learning_loop_batched`, `run_mlp_learning_loop` (simple + tracking), `run_mlp_learning_loop_batched`, `run_td_learning_loop`, `run_multi_head_learning_loop`, `run_multi_head_learning_loop_batched`, `learn_from_trajectory`
- `agent_age_s(state)` — wall-clock seconds since agent birth
- `agent_uptime_s(state)` — cumulative active seconds inside learning loops
- 28 new lifecycle tracking tests across all learner types

## [0.8.1] - 2026-02-21

### Added

- **bsuite benchmark integration** — bridges framework to bsuite for standardized RL diagnostics
  - `ContinuingWrapper`: converts episodic envs to continuing streams (Alberta Plan Step 6)
  - `AlbertaAgent`: bridges bsuite `Agent` ABC to `MultiHeadMLPLearner` with Q-learning
  - Three agent factories: Autostep+ObGD, LMS+ObGD, Adam (haiku/optax external baseline)
  - Hyperparameter configs with standard `(64, 64)` and bottleneck `(16, 16)` variants
  - `run_single.py` / `run_sweep.py` CLIs with `--continual-sequence` and `--use-scythe` flags
  - Analysis module: result loading, comparison plots, representation analysis, summary tables
  - Representation utility logging: per-weight step-sizes, trunk trace magnitudes, per-head metrics
  - 22 tests covering wrapper, agents, factories, representation logging, and integration

### Dependencies

- Added `[bsuite]` optional dependency group (dm-env, optax, dm-haiku, plotnine)

## [0.8.0] - 2026-02-16

### Added

- **`MultiHeadMLPLearner`** — shared-trunk MLP with multiple prediction heads for multi-task continual learning
  - VJP-based gradient computation with accumulated cotangents (single backward pass through trunk)
  - NaN target masking for selective head activation (inactive heads skip gradient updates)
  - Composable: accepts any `Optimizer`, optional `Bounder`, optional `Normalizer`
  - Eligibility traces managed per-head and per-trunk-layer
- `MultiHeadMLPState`, `MultiHeadMLPUpdateResult`, `MultiHeadLearningResult`, `BatchedMultiHeadResult` types
- `run_multi_head_learning_loop()` — `jax.lax.scan` over observation/target arrays with NaN masking
- `run_multi_head_learning_loop_batched()` — `jax.vmap` over initialization keys for multi-seed parallelization
- `multi_head_metrics_to_dicts()` — convert array metrics to per-head dicts for online use

## [0.7.3] - 2026-02-09

### Added

- `MLPLearner(use_layer_norm=False)` — toggle parameterless LayerNorm for ablation studies (default `True`, backwards-compatible)

## [0.7.2] - 2026-02-08

### Fixed

- IDBD operation ordering now matches Sutton 1992 Figure 2: meta-update first, then NEW alpha for weight and trace updates

### Changed (Breaking)

- Autostep rewritten to match Mahmood et al. 2012 Table 1 exactly:
  - `v_i` now tracks meta-gradient magnitude `|δ*x*h|` (was primary gradient `|δ*x|`)
  - `v_i` uses self-regulated EMA (Eq. 4), not `max(|grad|, v*τ)`
  - Overshoot prevention via `M = max(Σ α_i*x_i², 1)` (Eq. 6-7)
  - Trace decay includes `x²`: `h_i = h_i*(1 - α_i*x_i²) + α_i*δ*x_i`
  - Normalizers and traces initialized to 0 (was 1 and 0)
  - Normalization only applies to meta-update, not to weight/trace updates
- `Autostep(normalizer_decay=...)` renamed to `Autostep(tau=...)`, default changed from 0.99 to 10000.0
- `AutostepState.normalizer_decay` renamed to `AutostepState.tau`
- `AutostepParamState.normalizer_decay` renamed to `AutostepParamState.tau`

### Added

- `Autostep.update_from_gradient()` now accepts optional `error` parameter for full paper algorithm in MLP path
- `Optimizer.update_from_gradient()` base signature accepts optional `error` parameter

## [0.7.1] - 2026-02-07

### Added

- **`AGCBounding`** — Adaptive Gradient Clipping (Brock et al. 2021) as a `Bounder` ABC, per-unit clipping scaled by weight norm
- `_unitwise_norm()` helper for unit-wise L2 norm computation (1D: abs, 2D+: norm over fan-in axes)

## [0.7.0] - 2026-02-07

### Changed (Breaking)

- Removed `NormalizedLinearLearner`, `NormalizedMLPLearner` — use `LinearLearner(normalizer=...)` and `MLPLearner(normalizer=...)` instead
- Removed `run_normalized_learning_loop`, `run_normalized_learning_loop_batched`, `run_mlp_normalized_learning_loop`, `run_mlp_normalized_learning_loop_batched` — unified into `run_learning_loop` and `run_mlp_learning_loop` (detect normalization from learner)
- Removed `NormalizedLearnerState`, `NormalizedMLPLearnerState`, `NormalizedMLPUpdateResult`, `BatchedNormalizedResult`, `BatchedMLPNormalizedResult`, `MLPObGDState` types
- `MLPLearner` no longer accepts `kappa` parameter — use `bounder=ObGDBounding(kappa=2.0)` instead

### Added

- `Bounder` ABC and `ObGDBounding` for decoupled update bounding (composable with any optimizer)
- `AutostepParamState` for per-parameter Autostep optimization (arbitrary array shapes)
- `Optimizer.init_for_shape()` and `Optimizer.update_from_gradient()` for shape-agnostic optimization (LMS, Autostep)
- `MLPLearner` now accepts composable `optimizer`, `bounder`, and `normalizer` parameters
- `LinearLearner` now accepts optional `bounder` and `normalizer` parameters
- Unified learning loops: 4 functions instead of 8 (linear + MLP, each with single + batched)

### Fixed

- mypy override errors — base class `init_for_shape`/`update_from_gradient` use `Any` since return type varies by subclass

## [0.6.1] - 2026-02-07

- Version bump only

## [0.6.0] - 2026-02-07

### Changed (Breaking)

- Replaced `OnlineNormalizer`, `NormalizerState`, `create_normalizer_state` with `Normalizer` ABC hierarchy

### Added

- `Normalizer` ABC with generic `StateT` constraint, following the `Optimizer[StateT]` pattern
- `EMANormalizer` — exponential moving average normalization (renamed from `OnlineNormalizer`, corrected docstrings)
- `WelfordNormalizer` — true Welford's algorithm with Bessel's correction for stationary distributions
- `EMANormalizerState`, `WelfordNormalizerState`, `AnyNormalizerState` types
- `NormalizedLinearLearner` now accepts any `Normalizer` subclass
- `NormalizedMLPLearner` — wraps `MLPLearner` with online normalization (EMA or Welford)
- `NormalizedMLPLearnerState`, `NormalizedMLPUpdateResult`, `BatchedMLPNormalizedResult` types
- `run_mlp_normalized_learning_loop()` with optional `NormalizerTrackingConfig`
- `run_mlp_normalized_learning_loop_batched()` for vmap-based multi-seed normalized MLP training

## [0.5.3] - 2026-02-06

### Added

- `run_mlp_learning_loop_batched()` for vmap-based multi-seed MLP training with `BatchedMLPResult` return type

## [0.5.2] - 2026-02-06

### Fixed

- Resolved mypy type error in `MLPLearner` z_sum computation — replaced `sum()` over JAX arrays with explicit `jnp.array(0.0)` accumulator

## [0.5.0] - 2026-02-06

### Added

- **ObGD Optimizer**: Observation-bounded Gradient Descent for overshooting prevention (Elsayed et al. 2024). Dynamically bounds effective step-size based on error magnitude and trace norms. Works as a linear optimizer (`ObGD`) and within the MLP learner.
- **MLPLearner**: Multi-layer perceptron with ObGD optimizer for nonlinear function approximation in the streaming setting. Architecture: `Input -> [Dense -> LayerNorm -> LeakyReLU] x N -> Dense(1)`. Configurable depth via `hidden_sizes` tuple.
- **Sparse Initialization**: `sparse_init()` function implementing LeCun-scale initialization with per-neuron sparsity (default 90%), following Elsayed et al. 2024.
- **`run_mlp_learning_loop()`**: JIT-compiled MLP training via `jax.lax.scan`, same pattern as existing linear learning loops.
- **MLP Types**: `MLPParams`, `MLPObGDState`, `MLPLearnerState`, `MLPUpdateResult` chex dataclasses.
- **ObGD Types**: `ObGDState` chex dataclass with `create_obgd_state()` factory.
- **Step 2 Example**: `linear_vs_mlp_comparison.py` comparing LinearLearner+Autostep vs MLPLearner+ObGD on RandomWalk, AbruptChange, and DynamicScaleShift streams.

### Notes

- ObGD defaults to `gamma=0, lamda=0` for supervised learning (traces = current observation). Nonzero values enable eligibility traces for future RL use (Steps 3-4).
- MLP implementation is self-contained (no Flax/Haiku dependency). Uses `jax.grad` for backpropagation and parameterless layer normalization.
- The `Optimizer` generic constraint now includes `ObGDState`, so `ObGD` can be used with `LinearLearner` as well.

## [0.4.0] - 2026-02-04

### Added

- TD-IDBD optimizer for temporal-difference learning with per-weight adaptive step-sizes and eligibility traces (Kearney et al., 2019)
- AutoTDIDBD optimizer with AutoStep-style normalization for improved stability
- `TDLinearLearner` class for linear value function approximation in TD learning
- `run_td_learning_loop()` for JIT-compiled TD learning via `jax.lax.scan`
- TD state types: `TDIDBDState`, `AutoTDIDBDState`, `TDLearnerState`, `TDTimeStep`
- `TDStream` protocol for TD experience streams

## [0.3.2] - 2026-02-03

### Fixed

- Relaxed test tolerance in batched vs sequential comparison tests (`rtol=1e-5`) to account for floating-point differences between vmap and sequential execution paths
- Added `ignore = ["F722"]` to ruff config for jaxtyping shape annotation syntax that ruff doesn't understand
- Removed unused `PRNGKeyArray` import from `core/types.py`

## [0.3.0] - 2026-02-03

### Added

- Migrated all state types from NamedTuple to `@chex.dataclass(frozen=True)` for DeepMind-style JAX compatibility
- jaxtyping shape annotations for compile-time type safety (`Float[Array, " feature_dim"]`, `PRNGKeyArray`, etc.)
- Updated test suite to use chex assertions (`chex.assert_shape`, `chex.assert_tree_all_finite`, `chex.assert_trees_all_close`)

### Dependencies

- Added `chex>=0.1.86` and `jaxtyping>=0.2.28` as required dependencies
- Added `beartype>=0.18.0` as optional dev dependency for runtime type checking

## [0.2.2] - 2026-02-02

### Fixed

- mypy type errors in `run_learning_loop_batched` and `run_normalized_learning_loop_batched` functions
- Added `typing.cast` to properly handle conditional return type unpacking in batched learning loops

## [0.1.0] - 2026-01-19

### Added

- **Core Optimizers**: LMS (baseline), IDBD (Sutton 1992), and Autostep (Mahmood et al. 2012) with per-weight adaptive step-sizes
- **Linear Learners**: `LinearLearner` and `NormalizedLinearLearner` with pluggable optimizers
- **Scan-based Learning Loops**: JIT-compiled training with `jax.lax.scan` for efficiency
- **Online Normalization**: Streaming feature normalization with exponential moving averages
- **Experience Streams**: `RandomWalkStream`, `AbruptChangeStream`, `CyclicStream`, `SuttonExperiment1Stream`
- **Gymnasium Integration**: Trajectory collection and learning from Gymnasium RL environments
- **Step-Size Tracking**: Optional per-weight step-size history recording for meta-adaptation analysis
- **Multi-Seed Experiments**: `run_multi_seed_experiment` with optional parallelization via joblib
- **Statistical Analysis**: Pairwise comparisons, confidence intervals, effect sizes (requires scipy)
- **Publication Visualization**: Learning curves, bar charts, heatmaps with matplotlib
- **Export Utilities**: CSV, JSON, LaTeX, and Markdown table generation
- **Documentation**: MkDocs-based documentation with auto-generated API reference

### Notes

- Requires Python 3.13+
- Implements Step 1 of the Alberta Plan: demonstrating that IDBD/Autostep can match or beat hand-tuned LMS
- All state uses immutable NamedTuples for JAX compatibility
- Follows temporal uniformity principle: every component updates at every time step
