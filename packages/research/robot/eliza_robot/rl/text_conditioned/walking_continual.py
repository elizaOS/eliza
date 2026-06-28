"""Continual learning of text-command walking skills over a walking policy.

This is where Alberta's continual-learning retention meets the bipedal walker.
A trained Brax-PPO joystick policy (the *teacher*) already follows any velocity
command. We then teach a *student* the text-command skills **one at a time**
(walk forward, then turn, then backward, ...) by behaviour cloning, and ask:
does learning a new command overwrite the earlier ones?

Two students, identical except for the retention mechanism (the exact finding
from the joint_reach tournament, transferred to walking):

- ``mode="finetune"`` — one shared output head over a plastic trunk, retrained on
  each command in turn. Catastrophically forgets earlier commands.
- ``mode="multihead"`` — per-command output heads over a trunk that is learned on
  the first command and then **consolidated** (frozen). Each command's skill is
  protected in its own head, so learning a new command cannot overwrite an old
  one — retention with BWT ~ 0.

Performance on a command = how well the student reproduces the teacher's
command-conditioned actions (negative mean-squared action error), which is a
faithful proxy for "still follows that command". From the command x phase matrix
we compute the standard ACC / BWT / Forgetting (see
:mod:`eliza_robot.rl.alberta.metrics`). The student can also be rolled out in the
env to *show* it following each text command.

Commands are discrete and known, so routing to a head slot is exact (the command
index) — no prototype gating needed, unlike the RL controller.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

import jax
import jax.numpy as jnp
import jax.random as jr
import numpy as np
from alberta_framework.core.initializers import sparse_init

_LN_EPS = 1e-5

# A teacher maps a batch of observations + a single command vector to actions.
TeacherFn = Callable[[np.ndarray, np.ndarray], np.ndarray]


@dataclass(frozen=True)
class BCStudentConfig:
    obs_dim: int
    action_dim: int
    n_commands: int
    mode: str = "multihead"  # "multihead" (retain) | "finetune" (forget)
    hidden_sizes: tuple[int, ...] = (256, 256)
    lr: float = 1e-3
    sparsity: float = 0.9
    leaky_relu_slope: float = 0.01
    use_layer_norm: bool = True
    # multihead: consolidate (freeze) the trunk after the first command is learned
    # so later per-command heads build on a stable representation. finetune keeps
    # the trunk plastic throughout (which is what makes it forget).
    freeze_trunk_after_first: bool = True
    seed: int = 0


def _layer_norm(z: jnp.ndarray) -> jnp.ndarray:
    return (z - jnp.mean(z)) / jnp.sqrt(jnp.var(z) + _LN_EPS)


def _trunk_forward(weights, biases, x, slope, use_ln):
    h = x
    for w, b in zip(weights, biases, strict=True):
        z = w @ h + b
        if use_ln:
            z = _layer_norm(z)
        h = jnp.where(z >= 0, z, slope * z)
    return h


class BCStudent:
    """Behaviour-cloning student with optional per-command output heads."""

    def __init__(self, config: BCStudentConfig):
        self.cfg = config
        key = jr.key(config.seed)
        sizes = (config.obs_dim, *config.hidden_sizes)
        ws, bs = [], []
        for i in range(len(config.hidden_sizes)):
            key, sub = jr.split(key)
            ws.append(sparse_init(sub, (sizes[i + 1], sizes[i]), config.sparsity))
            bs.append(jnp.zeros((sizes[i + 1],), dtype=jnp.float32))
        self._w = tuple(ws)
        self._b = tuple(bs)
        h = config.hidden_sizes[-1]
        n = config.n_commands if config.mode == "multihead" else 1
        # zero-init heads (a fresh head outputs 0 until trained)
        self._hw = jnp.zeros((n, config.action_dim, h), dtype=jnp.float32)
        self._hb = jnp.zeros((n, config.action_dim), dtype=jnp.float32)
        self._slope = config.leaky_relu_slope
        self._use_ln = config.use_layer_norm

    def _head_index(self, command_idx: int) -> int:
        return command_idx if self.cfg.mode == "multihead" else 0

    # -- forward / act ---------------------------------------------------------

    def act(self, obs: np.ndarray, command_idx: int) -> np.ndarray:
        k = self._head_index(command_idx)
        phi = _trunk_forward(self._w, self._b, jnp.asarray(obs, jnp.float32), self._slope, self._use_ln)
        a = self._hw[k] @ phi + self._hb[k]
        return np.asarray(a, dtype=np.float32)

    # -- training --------------------------------------------------------------

    def _loss(self, w, b, hw_k, hb_k, obs_b, act_b):
        def per(o, a):
            phi = _trunk_forward(w, b, o, self._slope, self._use_ln)
            pred = hw_k @ phi + hb_k
            return jnp.mean((pred - a) ** 2)

        return jnp.mean(jax.vmap(per)(obs_b, act_b))

    def fit_command(
        self,
        obs: np.ndarray,
        actions: np.ndarray,
        command_idx: int,
        *,
        update_trunk: bool,
        epochs: int = 30,
        batch_size: int = 256,
        seed: int = 0,
    ) -> float:
        """Behaviour-clone one command's skill into its head (and, if
        ``update_trunk``, the shared trunk). Returns the final epoch's mean loss."""
        k = self._head_index(command_idx)
        obs = jnp.asarray(obs, jnp.float32)
        actions = jnp.asarray(actions, jnp.float32)
        lr = self.cfg.lr
        rng = np.random.default_rng(seed)
        n = obs.shape[0]

        grad_fn = jax.jit(jax.value_and_grad(self._loss, argnums=(0, 1, 2, 3)))
        w, b, hw_k, hb_k = self._w, self._b, self._hw[k], self._hb[k]
        last = 0.0
        for _ in range(epochs):
            perm = rng.permutation(n)
            for s in range(0, n, batch_size):
                idx = perm[s : s + batch_size]
                loss, (gw, gb, ghw, ghb) = grad_fn(w, b, hw_k, hb_k, obs[idx], actions[idx])
                hw_k = hw_k - lr * ghw
                hb_k = hb_k - lr * ghb
                if update_trunk:
                    w = tuple(wi - lr * gi for wi, gi in zip(w, gw, strict=True))
                    b = tuple(bi - lr * gi for bi, gi in zip(b, gb, strict=True))
                last = float(loss)
        if update_trunk:
            self._w, self._b = w, b
        self._hw = self._hw.at[k].set(hw_k)
        self._hb = self._hb.at[k].set(hb_k)
        return last

    def action_mse(self, obs: np.ndarray, actions: np.ndarray, command_idx: int) -> float:
        """Mean squared action error vs the teacher for a command (eval)."""
        k = self._head_index(command_idx)
        loss = self._loss(self._w, self._b, self._hw[k], self._hb[k],
                          jnp.asarray(obs, jnp.float32), jnp.asarray(actions, jnp.float32))
        return float(loss)


@dataclass
class ContinualBCResult:
    mode: str
    commands: list[str]
    # perf[i][j] = performance (negative action MSE) on command j after training phase i
    perf_matrix: list[list[float]]
    acc: float
    bwt: float
    forgetting: float


def run_continual_bc(
    student_cfg: BCStudentConfig,
    commands: list[str],
    train_data: dict[str, tuple[np.ndarray, np.ndarray]],
    eval_data: dict[str, tuple[np.ndarray, np.ndarray]],
) -> ContinualBCResult:
    """Train a BC student on ``commands`` sequentially; after each phase evaluate
    on ALL commands to build the perf matrix, then compute ACC/BWT/Forgetting.

    ``train_data``/``eval_data`` map command name -> (obs, teacher_actions).
    Performance is negative action MSE (higher = better imitation = still
    following that command)."""
    from eliza_robot.rl.alberta.metrics import compute_continual_metrics

    student = BCStudent(student_cfg)
    T = len(commands)
    perf = np.zeros((T, T), dtype=np.float64)
    for i, cmd in enumerate(commands):
        obs, acts = train_data[cmd]
        # trunk learns on the first command, then is consolidated (multihead);
        # finetune keeps updating the trunk every phase (-> forgets).
        update_trunk = (
            (i == 0) if (student_cfg.mode == "multihead" and student_cfg.freeze_trunk_after_first)
            else (student_cfg.mode == "finetune")
        )
        student.fit_command(obs, acts, i, update_trunk=update_trunk, seed=i)
        for j in range(T):
            eo, ea = eval_data[commands[j]]
            perf[i, j] = -student.action_mse(eo, ea, j)

    m = compute_continual_metrics(perf)
    return ContinualBCResult(
        mode=student_cfg.mode,
        commands=list(commands),
        perf_matrix=perf.tolist(),
        acc=m.acc,
        bwt=m.bwt,
        forgetting=m.forgetting,
    )
