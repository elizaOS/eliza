# `_validator/` — smoke-test checkpoint

Tiny Brax/JAX policy checkpoint copied verbatim from the SSD source tree
(`ainex-robot-code/checkpoints/mujoco_test/`). It exists to give CI a
deterministic checkpoint to load without provisioning object storage.

- `config.json` (1.5 KB) — env + policy config dumped by training.
- `final_params` (1.5 MB) — Brax policy weights (orbax `final_params` file).
- `metrics.json` (2 KB) — training-time metric snapshot.

Total: 1.5 MB. Well below the 5 MB per-file commit ceiling enforced by
`scripts/check-no-large-binaries.sh`.

## Usage in tests

```python
from eliza_robot.rl import checkpoint_root
from eliza_robot.sim.mujoco.inference import load_policy

ckpt = checkpoint_root() / "_validator"
inference_fn, config = load_policy(str(ckpt))
```

Override the root with `ELIZA_ROBOT_CHECKPOINT_DIR=/path/to/checkpoints`
to point at a Nebius-mounted volume or your own training output. The
`_validator/` directory is the only checkpoint kept in git; everything
else in `checkpoints/` is gitignored.
