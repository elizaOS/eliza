# Vendored: Alberta Framework

This is a vendored copy of the **Alberta Framework** — a JAX implementation of
[The Alberta Plan for AI Research](https://arxiv.org/abs/2208.11173) (Sutton,
Bowling, Pilarski 2022): continual learning with meta-learned step-sizes.

- **Upstream:** https://github.com/lalalune/alberta
- **Vendored at commit:** `2ac35333efae45cf969ce02ec1f2703476fed6c2`
- **License:** Apache-2.0 (see `LICENSE`)

## Why vendored

`eliza-robot` (`packages/robot`) uses the Alberta continual-RL control subset to
train robot policies that learn a sequence of tasks **without catastrophic
forgetting**, and benchmarks it head-to-head against standard RL (PPO). The
framework is imported in-process from the robot's Python 3.12 environment.

## Local modifications vs upstream

Kept intentionally minimal so upstream can be re-synced:

1. `alberta_framework/__init__.py` — the trailing `benchmarks` compatibility
   shim is wrapped in `try/except ModuleNotFoundError`. The repo-root
   `benchmarks/` tree is not vendored, and the unconditional import aborted
   every `alberta_framework.*` import.
2. `pyproject.toml` — `requires-python` relaxed `>=3.13` → `>=3.12`, and the
   numpy floor `>=2.0` → `>=1.26`. The continual-RL subset only uses PEP 695
   syntax (Python 3.12+) and no numpy-2-only APIs, so it runs in the robot's
   `numpy<2` / brax / mujoco environment with zero dependency downgrades.

Not vendored: upstream repo metadata and non-runtime trees such as `.github/`,
`benchmarks/`, `docs/`, `examples/`, `outputs/`, and `scripts/`.

## Continual-RL subset used by the robot package

`alberta_framework.core`: `sarsa`, `actor_critic`, `average_reward`,
`optimizers`, `learners`, `normalizers`, `types`, `upgd`, `continual_backprop`;
plus `alberta_framework.streams`. The full 12-step / `diffeml_*` / prototype
modules are present but not required by the robot integration.
