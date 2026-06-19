Text-conditioned multi-task robot training.

Default local entrypoint:

```bash
uv run python scripts/train_text_conditioned.py --profile hiwonder-ainex --steps 30000
```

That command trains the Alberta streaming continual-learning controller and
writes a `regime="alberta_streaming"` checkpoint. Use `--backend ppo` only when
you explicitly want the Stable-Baselines3 PPO smoke baseline.
For Alberta, `--steps` is the total env-step budget and is split across the
selected task sequence.
MuJoCo domain randomization is enabled by default for Alberta training; pass
`--no-domain-rand` only for deterministic debugging.

The installable `eliza-robot-train` module uses mode-specific output defaults:
Alberta writes to `checkpoints/alberta_text_conditioned`, `--smoke` writes to
`checkpoints/text_conditioned_smoke`, `--full` writes to
`checkpoints/asimov_1_brax_mjx_baseline`, and `--dry-run` writes to
`checkpoints/text_conditioned_dry_run` unless `--out` is provided.
