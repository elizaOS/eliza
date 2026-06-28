"""Fast, deterministic continual-learning benchmark env for robot control.

``JointReachEnv`` is a joint-space posture-servo task — the low-level control
problem every robot skill ultimately reduces to: drive the joints to a target
configuration. It is deliberately physics-light (a damped double integrator per
joint, pure numpy) so a full continual-learning sweep — many tasks, many seeds,
two learners — runs in seconds-to-minutes on CPU, instead of the hours the full
MuJoCo humanoid would need. The Alberta integration is *also* wired into the
real ``TextConditionedProfileEnv`` (see ``train_robot.py``); this env exists so
the head-to-head forgetting comparison is fast, reproducible, and unambiguous.

Continual-learning design
-------------------------
Each *task* is a distinct target joint posture. Crucially the target is **not**
in the observation — it is identifiable only from a per-task **embedding
channel** (a frozen random vector, the analogue of the real env's text/PCA
embedding). So a single policy *can* solve every task (the capacity exists: read
the embedding, drive to the implied target), and the only way to do well across
a task stream is to *remember* each embedding->target association. Train on task
B alone and a naive learner overwrites the weights that encoded task A — that is
catastrophic forgetting, and it is exactly what this env measures.

Reward is ``exp(-k * ||q - q_target||^2)`` per step (in ``[0, 1]``) minus a small
control penalty, so an episode return is a clean, bounded skill score that is
directly comparable across tasks and learners.
"""

from __future__ import annotations

from dataclasses import dataclass

import gymnasium as gym
import numpy as np


@dataclass(frozen=True)
class JointReachConfig:
    n_joints: int = 6
    embed_dim: int = 16
    episode_steps: int = 60
    dt: float = 0.1
    action_scale: float = 1.0
    joint_limit: float = 1.5
    control_penalty: float = 0.01
    embed_seed: int = 12345


class JointReachEnv(gym.Env):
    """Task-conditioned joint-space posture servo.

    Observation::
        [q(n_joints), qd(n_joints), task_embedding(embed_dim)]
    Action::
        [-1, +1] per-joint acceleration command (scaled by ``action_scale``).

    The active task (and thus the hidden target posture + its embedding) is
    chosen at ``reset``. Pin a single task for sequential continual-learning
    phases via ``task_pool=[task_id]`` or ``set_task(task_id)``.
    """

    metadata = {"render_modes": []}

    def __init__(
        self,
        n_tasks: int,
        config: JointReachConfig | None = None,
        *,
        task_pool: list[int] | None = None,
        seed: int = 0,
    ) -> None:
        super().__init__()
        self.config = config or JointReachConfig()
        self.n_tasks = n_tasks
        self.task_pool = list(task_pool) if task_pool is not None else list(range(n_tasks))

        cfg = self.config
        # Frozen per-task targets + embeddings. A fixed generator keyed by
        # embed_seed makes the whole task suite reproducible across runs and
        # across the two learners (so the comparison is apples-to-apples).
        gen = np.random.default_rng(cfg.embed_seed)
        self._targets = gen.uniform(
            -0.8 * cfg.joint_limit, 0.8 * cfg.joint_limit, size=(n_tasks, cfg.n_joints)
        ).astype(np.float32)
        # Well-separated, unit-variance-per-component embeddings. They must have
        # magnitude comparable to the proprioceptive channel (q in +/-limit) or
        # the task signal gets washed out inside the policy's feature lift and
        # the agent cannot tell the tasks apart — which would confound capacity
        # with forgetting. Standard-normal components (norm ~ sqrt(embed_dim))
        # keep tasks linearly separable so the comparison isolates *forgetting*.
        self._embeddings = gen.standard_normal((n_tasks, cfg.embed_dim)).astype(np.float32)

        obs_dim = 2 * cfg.n_joints + cfg.embed_dim
        self.observation_space = gym.spaces.Box(-np.inf, np.inf, (obs_dim,), np.float32)
        self.action_space = gym.spaces.Box(-1.0, 1.0, (cfg.n_joints,), np.float32)

        self._q = np.zeros(cfg.n_joints, dtype=np.float32)
        self._qd = np.zeros(cfg.n_joints, dtype=np.float32)
        self._task = self.task_pool[0]
        self._step = 0
        self._forced_task: int | None = None

    def set_task(self, task_id: int) -> None:
        """Force a specific task on every subsequent reset (eval / phase pin)."""
        self._forced_task = task_id

    def clear_forced_task(self) -> None:
        self._forced_task = None

    @property
    def target(self) -> np.ndarray:
        return self._targets[self._task]

    def reset(self, *, seed: int | None = None, options: dict | None = None):
        super().reset(seed=seed)
        cfg = self.config
        if self._forced_task is not None:
            self._task = self._forced_task
        else:
            self._task = int(self.task_pool[self.np_random.integers(len(self.task_pool))])
        # Start from a small random posture so the policy must actively servo.
        self._q = self.np_random.uniform(-0.3, 0.3, size=cfg.n_joints).astype(np.float32)
        self._qd = np.zeros(cfg.n_joints, dtype=np.float32)
        self._step = 0
        return self._obs(), {"task_id": self._task}

    def step(self, action: np.ndarray):
        cfg = self.config
        a = np.clip(np.asarray(action, dtype=np.float32), -1.0, 1.0)
        # First-order (position-velocity) joint control: the action commands a
        # joint velocity directly. This is the realistic robot joint-servo model
        # and keeps credit assignment tractable — the policy can drive q toward
        # the target without fighting second-order momentum.
        self._qd = cfg.action_scale * a
        self._q = np.clip(
            self._q + self._qd * cfg.dt, -cfg.joint_limit, cfg.joint_limit
        ).astype(np.float32)
        self._step += 1

        dist = float(np.linalg.norm(self._q - self._targets[self._task]))
        # Bounded reward in (0, 1]: a clear gradient everywhere yet a stable
        # value target (~1/(1-gamma)), so the linear critic does not diverge.
        # An episode return near episode_steps means the policy parks the joints
        # on the (hidden, embedding-implied) target and holds.
        reward = float(np.exp(-dist)) - cfg.control_penalty * float(np.dot(a, a))

        truncated = self._step >= cfg.episode_steps
        return self._obs(), reward, False, truncated, {"task_id": self._task, "dist": dist}

    def _obs(self) -> np.ndarray:
        return np.concatenate([self._q, self._qd, self._embeddings[self._task]]).astype(np.float32)


def make_joint_reach_env(
    n_tasks: int,
    config: JointReachConfig | None = None,
    *,
    task_pool: list[int] | None = None,
    seed: int = 0,
) -> JointReachEnv:
    return JointReachEnv(n_tasks, config, task_pool=task_pool, seed=seed)
