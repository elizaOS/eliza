Alberta continual-RL training, PPO/Brax baselines, and deploy harnesses.

The default text-conditioned training path is Alberta streaming continual
learning:

```bash
uv run python scripts/train_text_conditioned.py --profile hiwonder-ainex --steps 30000
```

For Alberta, `--steps` is the total env-step budget and is split across the
selected task sequence. Use `python -m eliza_robot.rl.alberta.train_robot
--steps-per-task ...` when you need explicit per-task phase budgets.
MuJoCo domain randomization is enabled by default for Alberta training; pass
`--no-domain-rand` only for deterministic debugging.

PPO remains available as an explicit local baseline:

```bash
uv run python scripts/train_text_conditioned.py --profile hiwonder-ainex --backend ppo --steps 30000
```

Run the continual-learning comparison harness with:

```bash
uv run python -m eliza_robot.rl.alberta.benchmark --steps-per-task 16000 --seeds 3
```

Run the obstacle-course continual-learning comparison with:

```bash
uv run python -m eliza_robot.rl.alberta.benchmark \
  --env obstacle_course --steps-per-task 16000 --seeds 3 \
  --out-dir evidence/alberta_obstacle_course
```

Run the real profile-backed Alberta vs PPO checkpoint comparison with:

```bash
uv run python scripts/compare_text_conditioned_backends.py \
  --profile unitree-g1 --tasks stand_up walk_forward turn_left turn_right \
  --steps 30000 --out-root evidence/backend_compare/unitree-g1
```

Prepare the complete full-training launch bundle with:

```bash
uv run python scripts/prepare_end_to_end_full_training.py \
  --out-dir evidence/full_training_preflight
```

That bundle includes local preflight, Nebius Alberta training, PPO comparison,
continual benchmarks, ASIMOV-1 Brax/MJX baseline, and post-training validation
scripts.
