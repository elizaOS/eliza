# Nebius launch — text-conditioned AiNex PPO

Local smoke training is the loop-correctness gate. Real training happens
on a Nebius H100/H200 host so we can ride the MJX-Brax fast path (8192
parallel envs) and hit 100M-150M env steps in 1-3 wall-clock hours per
the MuJoCo Playground research survey.

## Phase 1 — bring up the host

```bash
# from your laptop
hcloud server create --name ainex-ppo --type cx52 --image ubuntu-24.04 \
    --location nbg1 --ssh-key <your-key>
ssh root@<host-ip>
apt update && apt install -y python3.11 python3.11-venv git build-essential
git clone https://github.com/lalalune/elizaos.git
cd elizaos/packages/robot
python3.11 -m venv .venv && source .venv/bin/activate
pip install -e . jax[cuda12_pip] brax mujoco-mjx mujoco_playground
pip install sentence-transformers stable-baselines3 scikit-learn
```

## Phase 2 — sanity check the smoke loop

```bash
# Same script as local — verifies the env + encoder + checkpoint format
# work on the cloud host before burning GPU time on the full run.
JAX_PLATFORMS=cpu python -m eliza_robot.rl.text_conditioned.train \
    --smoke --steps 5000 --out /tmp/smoke
ls /tmp/smoke   # policy.zip + manifest.json should exist
```

## Phase 3 — full MJX-Brax PPO

The full trainer reuses `eliza_robot/sim/mujoco/train.py` with two
modifications:
  - swap `Joystick` env → `TextConditionedMjxEnv` (forks the same env,
    adds the task-embedding obs channel)
  - sample a curriculum task per episode reset

The `TextConditionedMjxEnv` implementation is staged but commented out
in `eliza_robot/rl/text_conditioned/env.py` (search "MJX-Brax path");
finish the env subclass before invoking.

```bash
# 100M env steps, 8192 parallel envs, ~1 hour on H100
python -m eliza_robot.sim.mujoco.train \
    --task text_conditioned \
    --curriculum-tier 1 \
    --num-timesteps 100000000 \
    --num-envs 8192 \
    --policy-network 512,256,128 \
    --output checkpoints/text_conditioned_tier1
```

## Phase 4 — pull the checkpoint home

```bash
rsync -a root@<host-ip>:checkpoints/text_conditioned_tier1/ ./checkpoints/text_conditioned_tier1/
ls checkpoints/text_conditioned_tier1/    # policy_brax.pkl + manifest.json
```

## Phase 5 — drive sim+real with the trained policy

```bash
# Single-target: just sim
python scripts/evidence_actions_sweep.py --policy-checkpoint checkpoints/text_conditioned_tier1

# Dual-target: sim AND real together, with ArUco anchoring
python scripts/evidence_sim_real_co_execution.py \
    --host 192.168.1.218 --port 9090 --obsbot-device 4 \
    --use-rl true --tasks stand_up,walk_forward,turn_left,turn_right \
    --anchor true
```

## Cost estimate

| Phase | GPU | Wall-clock | Notes |
| --- | --- | --- | --- |
| Phase 3 (Tier 1, 100M)  | H100×1 | 60-90 min  | ~$3 |
| Phase 3 (Tier 1+2, 150M) | H100×1 | 2-3 hours  | ~$8 |
| Phase 3 (full 300M)      | H200×1 | 4-6 hours  | ~$20 |

Memory: ~9-12 GB peak. Local 16 GB RTX 5080 can do Phase 3 in ~2-3×
wall-clock if you'd rather stay local. The smoke trainer doesn't need
GPU at all (~5 minutes on CPU for 30k env steps).
