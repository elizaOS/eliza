# Test collection status

The collection-time import errors that previously forced a long `--ignore`
list are **resolved**. `uv run pytest tests/ --co` now collects the entire
tree with **zero errors**. What was done (2026-05-28):

- **Removed dead test modules** that imported a never-created
  `eliza_robot.runtime` package and the removed
  `train_bridge_policy` / `serve_policy` / `build_from_trace` subsystem
  (they never ran): `tests/bridge/test_e2e.py`,
  `tests/bridge/test_openpi_http_e2e.py`,
  `tests/bridge/test_bridge_policy_pipeline.py`.
- **Guarded cross-package integration tests** with
  `pytest.importorskip("elizaos_plugin_ainex")` so they skip cleanly when the
  separate AiNex plugin package is not installed in the robot venv:
  `tests/bridge/test_ainex_agent_integration.py`,
  `tests/bridge/test_execution_service.py`.
- **Pruned the deleted `wave_env` env** from
  `tests/sim/mujoco/test_compositional_env.py` (kept the live `CompositionalEnv`
  tests; waving moved to `rl/skills/composite_skill.py`).

The other modules the old version of this doc listed
(`test_joystick_env`, `test_target_env`, `test_arm_control`, `test_train`,
asimov, perception) already collected — the stale list pre-dated several fixes.
Some tests still **skip** at runtime when an optional artifact is absent (e.g.
the `mujoco_locomotion_v13_flat_feet` walking checkpoint, or an OpenGL display);
that is intended skip behavior, not a collection error.

Just run the suite normally:

```bash
uv run pytest tests/        # or: bun run --cwd packages/robot test:py
```

## Tests this work added (all green)

- `tests/test_profiles.py` — 39 tests covering all 4 supported profiles
  (load, DoF, joint limits, head camera, MuJoCo MJCF compile, deployment
  profile/assets root overrides).
- `tests/rl/test_profile_env.py` — 14 tests for the unified profile-driven
  env (reset, step, action_dim, truncation, unknown profile).
- `tests/rl/test_unified_training_cli.py` — 12 tests for both training CLI
  dry-run entry points, default Alberta backend, installable console-script
  metadata, and profile action/output dimensions, including total-step budget
  splitting for Alberta.
- `tests/rl/alberta/test_policy_adapter.py` — 8 tests for Alberta checkpoint
  loading, full-body action padding, and ASIMOV policy-loop validation
  checkpoint format, plus one-step robot-trainer manifest reproducibility and
  inference-loop profile mismatch protection, domain-randomization defaults,
  and step-budget validation.
- `tests/rl/alberta/test_benchmark_harness.py` — 2 tests for the Alberta
  continual-learning matrix/retention path and the benchmark evidence
  artifact contract (`continual_benchmark.{json,md,png}`).
- `tests/rl/alberta/test_checkpoint_validator.py` — 5 tests for production
  Alberta checkpoint validation, including profile/output-dimension checks,
  step-budget enforcement, domain-randomization enforcement, inference, and CLI
  behavior.
- `tests/rl/alberta/test_vendoring_validator.py` — 2 tests for vendored
  Alberta provenance, robot uv source mapping, lockfile source, import path,
  and CLI behavior.
- `tests/rl/test_learning_signal.py` — 16 tests (gameable-reward
  regression suite + domain-randomization round-trip).
- `tests/bridge/test_policy_start_e2e.py` — 3 tests booting a real bridge
  against the AINEX_RUN_RL payload shape and server-side Alberta checkpoint
  execution.
- `tests/asimov_1/test_eval_text_policy_asimov.py` — 5 tests for ASIMOV MJX
  evaluator routing and trained-checkpoint manifest/profile/output-dimension
  enforcement.
- `tests/rl/test_backend_comparison.py` — 1 test for the packaged
  Alberta-vs-PPO robot-env comparison artifact.
- `tests/rl/test_full_training_preflight.py` — 1 test for the generated
  H200/Nebius launch preflight bundle and executable script contracts.

Total new tests: **105**.
