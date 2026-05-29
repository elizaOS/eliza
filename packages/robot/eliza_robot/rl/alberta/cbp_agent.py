"""Nonlinear streaming continual-control agent: Stream-AC(lambda) + Continual Backprop.

``AlbertaCBPController`` is the *nonlinear* sibling of
:class:`~eliza_robot.rl.alberta.agent.AlbertaContinualController`. Where the
linear controller learns a linear actor-critic over a **frozen** feature lift,
this controller learns the representation itself with a small MLP and keeps that
representation plastic over a long non-stationary stream using Alberta's
**Continual Backprop** (generate-and-test) mechanism.

It is built from Alberta-Plan ingredients, combined as prescribed for streaming
continual control:

- **Stream-AC(lambda)** (Elsayed et al. 2024, "Streaming Deep Reinforcement
  Learning Finally Works"): an MLP actor and an MLP critic with sparse init,
  parameterless layer norm, LeakyReLU, *parameter-space* eligibility traces, and
  **ObGD** update bounding so a single surprising transition cannot blow away
  learned weights. Every-step updates, no replay buffer, no epochs — the same
  temporal uniformity the linear controller relies on.
- **Continual Backprop** (Dohare et al. 2024): per-hidden-unit utility tracking
  plus periodic re-initialization of persistently low-utility mature units. This
  is the *principled* plasticity-preservation mechanism — it keeps the network
  learnable indefinitely instead of slowly ossifying on a non-stationary stream.

Retention (anti-forgetting). CBP preserves *plasticity* (the ability to keep
learning), not *memory* (protection of old task knowledge) — a shared MLP
trained sequentially still overwrites earlier skills. :class:`RetentionConfig`
adds a memory mechanism on top:

- ``mode="none"`` — single head, shared MLP. Best per-task learner, but forgets.
- ``mode="multihead"`` — a bank of ``n_slots`` per-task output heads over a
  **shared** CBP trunk. The current task is routed to a slot by nearest-prototype
  gating on the observation's task-embedding channel (the same idea the linear
  controller uses for ``sparse_gated`` features, applied to *readout* instead of
  *input*). The shared trunk carries transferable representation + CBP plasticity;
  per-task heads protect each skill's readout so learning task B cannot overwrite
  task A's policy. ``trunk_step_scale`` controls residual trunk drift — the only
  remaining forgetting channel: ``1.0`` = fully plastic trunk, ``<1`` = slow, and
  ``0.0`` = a frozen (CBP-curated) random-feature trunk that retains essentially
  perfectly while still out-capacitying the linear lookup.

Task routing lives in the controller (on the *raw*, un-normalized embedding, so
EMA normalization cannot disturb it); the agent is slot-agnostic and simply
indexes the head bank by the slot it is handed.

Design note — separate actor/critic networks. We use two independent MLPs rather
than a shared trunk. CBP replaces hidden units (resetting incoming weights and
zeroing the unit's *outgoing* weights); with separate networks each replacement
only ever touches one network's own heads, so there is no cross-network
staleness to reconcile.

The controller exposes the same numpy-friendly streaming surface as
``AlbertaContinualController`` (``start`` / ``observe`` / ``act_greedy`` /
``value`` / ``state_dict`` / ``load_state_dict``) so it drops straight into
:mod:`eliza_robot.rl.alberta.loop`, :mod:`eliza_robot.rl.alberta.baselines`, and
the head-to-head benchmark.
"""

from __future__ import annotations

import functools
from dataclasses import dataclass, field

import chex
import jax
import jax.numpy as jnp
import jax.random as jr
import numpy as np
from alberta_framework.core.continual_backprop import ContinualBackpropConfig
from alberta_framework.core.initializers import sparse_init
from alberta_framework.core.normalizers import EMANormalizer, EMANormalizerState
from alberta_framework.core.optimizers import ObGDBounding

# Actor parameter pytree:  (trunk_weights, trunk_biases, mean_w, mean_b, log_sigma)
# Critic parameter pytree: (trunk_weights, trunk_biases, critic_w, critic_b)
# Heads carry a leading slot axis of size ``n_slots`` (1 for the single-head case).
_LN_EPS = 1e-5
_SIGMA_FLOOR = 1e-8


@dataclass(frozen=True)
class RetentionConfig:
    """Anti-forgetting (memory) configuration layered on the CBP controller.

    Attributes:
        mode: ``"none"`` (single shared head) or ``"multihead"`` (per-task heads
            over a shared trunk, routed by prototype gating).
        n_slots: Number of per-task output-head slots. Must exceed the task count
            comfortably so distinct tasks route to distinct slots (collisions
            share a slot and reintroduce interference, exactly as for the linear
            controller's prototypes).
        embed_dim: Size of the task-embedding channel at the **tail** of the raw
            observation, used for gating. ``0`` disables gating (slot 0 always).
        trunk_step_scale: Multiplier on the trunk's gradient step. ``1.0`` keeps
            the trunk fully plastic; ``<1`` slows trunk drift (less forgetting via
            the shared representation); ``0.0`` freezes the trunk to CBP-curated
            random features (near-perfect retention, more capacity than linear).
        trunk_freeze_after: If ``>0``, the trunk learns plastically for this many
            steps and is then consolidated (gradient step forced to 0) so later
            per-task heads build on a stable, well-trained representation without
            overwriting earlier skills — the warmup-then-consolidate strategy that
            resolves the stability/plasticity tradeoff. CBP generate-and-test
            continues regardless, adding fresh random features for novelty.
        proto_seed: PRNG seed for the fixed gating prototypes.
    """

    mode: str = "none"
    n_slots: int = 1
    embed_dim: int = 0
    trunk_step_scale: float = 1.0
    trunk_freeze_after: int = 0
    proto_seed: int = 12345

    @property
    def slots(self) -> int:
        return self.n_slots if self.mode == "multihead" else 1


@dataclass(frozen=True)
class CBPControllerConfig:
    """Hyperparameters for :class:`AlbertaCBPController`.

    Attributes:
        obs_dim: Raw observation dimensionality (MLP input).
        action_dim: Continuous action dimensionality.
        action_low / action_high: Action clipping bounds.
        hidden_sizes: MLP hidden-layer widths for *both* the actor and critic.
        gamma: Discount factor.
        actor_step_size / critic_step_size: AC(lambda) step sizes.
        actor_lamda / critic_lamda: Eligibility-trace decays.
        log_sigma_init: Initial policy log-std (exploration scale).
        learn_log_sigma: When ``False`` (default) the log-std is held at its init.
            A learned log-std tends to collapse exploration during the first task
            on a continual stream, after which later tasks cannot be learned;
            freezing it gives every task the same exploration budget.
        obgd_kappa: ObGD bounding sensitivity; ``None`` disables bounding.
        sparsity: Sparse-init fraction for hidden weights (init and CBP replace).
        leaky_relu_slope: LeakyReLU negative slope.
        use_layer_norm: Parameterless layer norm in the trunk (Stream-AC recipe).
        normalize: Enable EMA observation normalization.
        normalizer_decay: EMA decay for the normalizer.
        cbp: Continual Backprop configuration. Set ``cbp.enabled=False`` for a
            plain Stream-AC ablation (no generate-and-test).
        retention: Anti-forgetting configuration (see :class:`RetentionConfig`).
        seed: PRNG seed for init.
    """

    obs_dim: int
    action_dim: int
    action_low: float = -1.0
    action_high: float = 1.0
    hidden_sizes: tuple[int, ...] = (64,)
    gamma: float = 0.99
    actor_step_size: float = 1e-3
    critic_step_size: float = 3e-3
    actor_lamda: float = 0.8
    critic_lamda: float = 0.8
    log_sigma_init: float = -0.7
    log_sigma_min: float = -5.0
    log_sigma_max: float = 0.5
    learn_log_sigma: bool = False
    obgd_kappa: float | None = 2.0
    sparsity: float = 0.9
    leaky_relu_slope: float = 0.01
    use_layer_norm: bool = True
    normalize: bool = True
    normalizer_decay: float = 0.999
    cbp: ContinualBackpropConfig = field(default_factory=ContinualBackpropConfig)
    retention: RetentionConfig = field(default_factory=RetentionConfig)
    seed: int = 0


@chex.dataclass(frozen=True)
class CBPAgentState:
    """Immutable JAX state for the Stream-AC + CBP agent.

    Head params (``mean_w``/``mean_b``/``log_sigma``/``critic_w``/``critic_b``)
    carry a leading slot axis of size ``n_slots``.
    """

    # actor params + traces
    a_weights: tuple[chex.Array, ...]
    a_biases: tuple[chex.Array, ...]
    mean_w: chex.Array  # (n_slots, action_dim, H)
    mean_b: chex.Array  # (n_slots, action_dim)
    log_sigma: chex.Array  # (n_slots, action_dim)
    a_trace: tuple  # mirrors (a_weights, a_biases, mean_w, mean_b, log_sigma)
    # critic params + traces
    c_weights: tuple[chex.Array, ...]
    c_biases: tuple[chex.Array, ...]
    critic_w: chex.Array  # (n_slots, H)
    critic_b: chex.Array  # (n_slots,)
    c_trace: tuple  # mirrors (c_weights, c_biases, critic_w, critic_b)
    # CBP bookkeeping (per hidden layer)
    a_util: tuple[chex.Array, ...]
    a_age: tuple[chex.Array, ...]
    a_accum: chex.Array
    c_util: tuple[chex.Array, ...]
    c_age: tuple[chex.Array, ...]
    c_accum: chex.Array
    # streaming bookkeeping
    last_obs: chex.Array
    last_action: chex.Array
    last_slot: chex.Array
    rng_key: chex.Array
    step_count: chex.Array


def _layer_norm(z: jnp.ndarray) -> jnp.ndarray:
    mean = jnp.mean(z)
    var = jnp.var(z)
    return (z - mean) / jnp.sqrt(var + _LN_EPS)


def _trunk_forward(
    weights: tuple[jnp.ndarray, ...],
    biases: tuple[jnp.ndarray, ...],
    x: jnp.ndarray,
    slope: float,
    use_ln: bool,
) -> tuple[jnp.ndarray, tuple[jnp.ndarray, ...]]:
    """Return (last_hidden, per_layer_post_activations)."""
    acts: list[jnp.ndarray] = []
    h = x
    for w, b in zip(weights, biases, strict=True):
        z = w @ h + b
        if use_ln:
            z = _layer_norm(z)
        h = jnp.where(z >= 0, z, slope * z)
        acts.append(h)
    return h, tuple(acts)


def _actor_params(s: CBPAgentState) -> tuple:
    return (s.a_weights, s.a_biases, s.mean_w, s.mean_b, s.log_sigma)


def _critic_params(s: CBPAgentState) -> tuple:
    return (s.c_weights, s.c_biases, s.critic_w, s.critic_b)


class _CBPStreamAC:
    """Pure-functional Stream-AC(lambda) + CBP agent (numpy-free, JIT-friendly).

    Slot-agnostic: every forward/update takes an explicit head-slot index; task
    routing is the controller's responsibility.
    """

    def __init__(self, config: CBPControllerConfig):
        self._cfg = config
        self._bounder = ObGDBounding(kappa=config.obgd_kappa) if config.obgd_kappa else None
        self._slots = config.retention.slots
        self._trunk_scale = config.retention.trunk_step_scale
        self._freeze_after = config.retention.trunk_freeze_after

    # -- forward ---------------------------------------------------------------

    def _phi(self, weights, biases, x):
        return _trunk_forward(
            weights, biases, x, self._cfg.leaky_relu_slope, self._cfg.use_layer_norm
        )

    def _mean(self, a_params: tuple, x: jnp.ndarray, slot: jnp.ndarray) -> jnp.ndarray:
        weights, biases, mean_w, mean_b, _log_sigma = a_params
        phi, _ = self._phi(weights, biases, x)
        return mean_w[slot] @ phi + mean_b[slot]

    def _log_prob(self, a_params: tuple, x: jnp.ndarray, action: jnp.ndarray, slot: jnp.ndarray) -> jnp.ndarray:
        weights, biases, mean_w, mean_b, log_sigma = a_params
        phi, _ = self._phi(weights, biases, x)
        mean = mean_w[slot] @ phi + mean_b[slot]
        var = jnp.exp(2.0 * log_sigma[slot]) + _SIGMA_FLOOR
        return jnp.sum(-0.5 * jnp.log(2.0 * jnp.pi * var) - 0.5 * (action - mean) ** 2 / var)

    def _value(self, c_params: tuple, x: jnp.ndarray, slot: jnp.ndarray) -> jnp.ndarray:
        weights, biases, critic_w, critic_b = c_params
        phi, _ = self._phi(weights, biases, x)
        return jnp.dot(critic_w[slot], phi) + critic_b[slot]

    # -- init ------------------------------------------------------------------

    def init(self, key: jnp.ndarray) -> CBPAgentState:
        cfg = self._cfg
        sizes = (cfg.obs_dim, *cfg.hidden_sizes)
        n_layers = len(cfg.hidden_sizes)
        k_slots = self._slots

        def _init_trunk(k):
            ws, bs = [], []
            for i in range(n_layers):
                k, sub = jr.split(k)
                ws.append(sparse_init(sub, (sizes[i + 1], sizes[i]), cfg.sparsity))
                bs.append(jnp.zeros((sizes[i + 1],), dtype=jnp.float32))
            return tuple(ws), tuple(bs), k

        ka, kc = jr.split(key)
        a_w, a_b, _ = _init_trunk(ka)
        c_w, c_b, _ = _init_trunk(kc)
        h_last = cfg.hidden_sizes[-1] if cfg.hidden_sizes else cfg.obs_dim

        mean_w = jnp.zeros((k_slots, cfg.action_dim, h_last), dtype=jnp.float32)
        mean_b = jnp.zeros((k_slots, cfg.action_dim), dtype=jnp.float32)
        log_sigma = jnp.full((k_slots, cfg.action_dim), cfg.log_sigma_init, dtype=jnp.float32)
        critic_w = jnp.zeros((k_slots, h_last), dtype=jnp.float32)
        critic_b = jnp.zeros((k_slots,), dtype=jnp.float32)

        a_params = (a_w, a_b, mean_w, mean_b, log_sigma)
        c_params = (c_w, c_b, critic_w, critic_b)
        util = tuple(jnp.zeros(h, dtype=jnp.float32) for h in cfg.hidden_sizes)
        age = tuple(jnp.zeros(h, dtype=jnp.int32) for h in cfg.hidden_sizes)
        accum = jnp.zeros(max(n_layers, 1), dtype=jnp.float32)[:n_layers]

        return CBPAgentState(  # type: ignore[call-arg]
            a_weights=a_w,
            a_biases=a_b,
            mean_w=mean_w,
            mean_b=mean_b,
            log_sigma=log_sigma,
            a_trace=jax.tree.map(jnp.zeros_like, a_params),
            c_weights=c_w,
            c_biases=c_b,
            critic_w=critic_w,
            critic_b=critic_b,
            c_trace=jax.tree.map(jnp.zeros_like, c_params),
            a_util=util,
            a_age=age,
            a_accum=accum,
            c_util=util,
            c_age=age,
            c_accum=accum,
            last_obs=jnp.zeros((cfg.obs_dim,), dtype=jnp.float32),
            last_action=jnp.zeros((cfg.action_dim,), dtype=jnp.float32),
            last_slot=jnp.array(0, dtype=jnp.int32),
            rng_key=key,
            step_count=jnp.array(0, dtype=jnp.int32),
        )

    # -- action ----------------------------------------------------------------

    @functools.partial(jax.jit, static_argnums=(0,))
    def sample_action(self, state: CBPAgentState, x: jnp.ndarray, slot: jnp.ndarray) -> tuple:
        key, sub = jr.split(state.rng_key)
        mean = self._mean(_actor_params(state), x, slot)
        sigma = jnp.exp(state.log_sigma[slot])
        action = mean + sigma * jr.normal(sub, mean.shape, dtype=jnp.float32)
        action = jnp.clip(action, self._cfg.action_low, self._cfg.action_high)
        return action, key

    @functools.partial(jax.jit, static_argnums=(0,))
    def greedy_action(self, state: CBPAgentState, x: jnp.ndarray, slot: jnp.ndarray) -> jnp.ndarray:
        mean = self._mean(_actor_params(state), x, slot)
        return jnp.clip(mean, self._cfg.action_low, self._cfg.action_high)

    @functools.partial(jax.jit, static_argnums=(0,))
    def value_of(self, state: CBPAgentState, x: jnp.ndarray, slot: jnp.ndarray) -> jnp.ndarray:
        return self._value(_critic_params(state), x, slot)

    @functools.partial(jax.jit, static_argnums=(0,))
    def start(self, state: CBPAgentState, x: jnp.ndarray, slot: jnp.ndarray) -> tuple:
        # Zero eligibility traces on an episode boundary (reset = teleport).
        zeroed = state.replace(
            a_trace=jax.tree.map(jnp.zeros_like, state.a_trace),
            c_trace=jax.tree.map(jnp.zeros_like, state.c_trace),
        )
        action, key = self.sample_action(zeroed, x, slot)
        return (
            zeroed.replace(last_obs=x, last_action=action, last_slot=slot, rng_key=key),
            action,
        )

    # -- CBP -------------------------------------------------------------------

    def _outgoing_norms(
        self,
        weights: tuple[jnp.ndarray, ...],
        head: jnp.ndarray,
    ) -> tuple[jnp.ndarray, ...]:
        """Per-unit sum of |outgoing weights| for each hidden layer.

        For layer ``li`` the outgoing matrix is layer ``li+1``'s weight; for the
        last hidden layer it is the head bank summed over *all* slots (a unit
        useful to any task should be kept), reshaped to ``(-1, H_last)``.
        """
        n = len(weights)
        head2d = head.reshape(-1, head.shape[-1])
        norms: list[jnp.ndarray] = []
        for li in range(n):
            out_mat = weights[li + 1] if li + 1 < n else head2d
            norms.append(jnp.sum(jnp.abs(out_mat), axis=0))
        return tuple(norms)

    def _cbp_step(
        self,
        weights: tuple[jnp.ndarray, ...],
        biases: tuple[jnp.ndarray, ...],
        head: jnp.ndarray,
        acts: tuple[jnp.ndarray, ...],
        util: tuple[jnp.ndarray, ...],
        age: tuple[jnp.ndarray, ...],
        accum: jnp.ndarray,
        key: jnp.ndarray,
    ) -> tuple:
        """One generate-and-test step. Returns updated (weights, biases, head,
        util, age, accum, key, replaced_any)."""
        cfg = self._cfg
        cbp = cfg.cbp
        decay = cbp.decay_rate
        out_norms = self._outgoing_norms(weights, head)

        new_w = list(weights)
        new_b = list(biases)
        new_head = head
        new_util, new_age = [], []
        new_accum = accum
        replaced_any = jnp.array(False)

        for li in range(len(weights)):
            contribution = jnp.abs(acts[li]) * out_norms[li]
            u = decay * util[li] + (1.0 - decay) * contribution
            a = age[li] + 1

            # schedule: accumulate fractional replacement budget
            acc = accum[li] + cbp.replacement_rate * u.shape[0]
            do_replace = jnp.logical_and(jnp.asarray(cbp.enabled), acc >= 1.0)
            new_accum = new_accum.at[li].set(jnp.where(do_replace, acc - 1.0, acc))

            # lowest-utility mature unit
            mature = a >= cbp.maturity_threshold
            masked = jnp.where(mature, u, jnp.inf)
            idx = jnp.argmin(masked)
            do_replace = jnp.logical_and(do_replace, jnp.any(mature))

            key, ksub = jr.split(key)
            fresh_row = sparse_init(ksub, (1, new_w[li].shape[1]), cfg.sparsity)[0]
            cand_w = new_w[li].at[idx].set(fresh_row)
            cand_b = new_b[li].at[idx].set(0.0)
            cand_u = u.at[idx].set(0.0)
            cand_a = a.at[idx].set(0)

            new_w[li] = jnp.where(do_replace, cand_w, new_w[li])
            new_b[li] = jnp.where(do_replace, cand_b, new_b[li])
            u = jnp.where(do_replace, cand_u, u)
            a = jnp.where(do_replace, cand_a, a)

            # zero the replaced unit's outgoing weights (grow back in). The head
            # bank's column ``idx`` is the last axis for both (slots, A, H) and
            # (slots, H) shapes, so ``..., idx`` handles either.
            if li + 1 < len(weights):
                cand_out = jnp.where(do_replace, new_w[li + 1].at[:, idx].set(0.0), new_w[li + 1])
                new_w[li + 1] = cand_out
            else:
                cand_head = jnp.where(do_replace, new_head.at[..., idx].set(0.0), new_head)
                new_head = cand_head

            replaced_any = jnp.logical_or(replaced_any, do_replace)
            new_util.append(u)
            new_age.append(a)

        return (
            tuple(new_w),
            tuple(new_b),
            new_head,
            tuple(new_util),
            tuple(new_age),
            new_accum,
            key,
            replaced_any,
        )

    # -- update ----------------------------------------------------------------

    def _scale_trunk(self, steps: tuple, step_count: jnp.ndarray) -> tuple:
        """Scale the trunk (weights/biases) portion of a step pytree; heads
        unchanged. ``steps`` is ``(weights, biases, *heads)``.

        The effective scale is ``trunk_step_scale`` until ``trunk_freeze_after``
        steps have elapsed (when set), after which the trunk is consolidated
        (scale 0)."""
        scale = jnp.asarray(self._trunk_scale, dtype=jnp.float32)
        if self._freeze_after > 0:
            frozen = step_count >= self._freeze_after
            scale = jnp.where(frozen, 0.0, scale)
        w_steps = jax.tree.map(lambda s: scale * s, steps[0])
        b_steps = jax.tree.map(lambda s: scale * s, steps[1])
        return (w_steps, b_steps, *steps[2:])

    @functools.partial(jax.jit, static_argnums=(0,))
    def update(
        self,
        state: CBPAgentState,
        reward: jnp.ndarray,
        next_obs: jnp.ndarray,
        discount: jnp.ndarray,
        slot_next: jnp.ndarray,
    ) -> tuple:
        cfg = self._cfg
        prev_obs = state.last_obs
        action = state.last_action
        slot_prev = state.last_slot
        a_params = _actor_params(state)
        c_params = _critic_params(state)

        value = self._value(c_params, prev_obs, slot_prev)
        next_value = self._value(c_params, next_obs, slot_next)
        td_error = reward + discount * next_value - value

        # gradients (score function / value semi-gradient); routed to slot_prev's
        # head only, so other slots' head params get zero gradient.
        actor_grad = jax.grad(self._log_prob)(a_params, prev_obs, action, slot_prev)
        critic_grad = jax.grad(self._value)(c_params, prev_obs, slot_prev)
        if not cfg.learn_log_sigma:
            actor_grad = (*actor_grad[:4], jnp.zeros_like(actor_grad[4]))

        actor_decay = discount * cfg.actor_lamda
        critic_decay = discount * cfg.critic_lamda
        a_trace = jax.tree.map(lambda e, g: actor_decay * e + g, state.a_trace, actor_grad)
        c_trace = jax.tree.map(lambda e, g: critic_decay * e + g, state.c_trace, critic_grad)

        a_steps = jax.tree.map(lambda tr: cfg.actor_step_size * td_error * tr, a_trace)
        c_steps = jax.tree.map(lambda tr: cfg.critic_step_size * td_error * tr, c_trace)
        # Stabilize the shared trunk (the only cross-task forgetting channel).
        a_steps = self._scale_trunk(a_steps, state.step_count)
        c_steps = self._scale_trunk(c_steps, state.step_count)

        if self._bounder is not None:
            a_leaves, a_def = jax.tree.flatten(a_steps)
            a_bounded, _ = self._bounder.bound(tuple(a_leaves), td_error, ())
            a_steps = jax.tree.unflatten(a_def, list(a_bounded))
            c_leaves, c_def = jax.tree.flatten(c_steps)
            c_bounded, _ = self._bounder.bound(tuple(c_leaves), td_error, ())
            c_steps = jax.tree.unflatten(c_def, list(c_bounded))

        new_a = jax.tree.map(lambda p, s: p + s, a_params, a_steps)
        new_c = jax.tree.map(lambda p, s: p + s, c_params, c_steps)
        a_w, a_b, mean_w, mean_b, log_sigma = new_a
        log_sigma = jnp.clip(log_sigma, cfg.log_sigma_min, cfg.log_sigma_max)
        c_w, c_b, critic_w, critic_b = new_c

        # eligibility traces are zeroed across an episode boundary
        carry = discount != 0.0
        a_trace = jax.tree.map(lambda t: jnp.where(carry, t, jnp.zeros_like(t)), a_trace)
        c_trace = jax.tree.map(lambda t: jnp.where(carry, t, jnp.zeros_like(t)), c_trace)

        # Continual Backprop generate-and-test on the (post-update) trunks.
        _, a_acts = _trunk_forward(a_w, a_b, prev_obs, cfg.leaky_relu_slope, cfg.use_layer_norm)
        _, c_acts = _trunk_forward(c_w, c_b, prev_obs, cfg.leaky_relu_slope, cfg.use_layer_norm)
        key = state.rng_key
        (a_w, a_b, mean_w, a_util, a_age, a_accum, key, a_repl) = self._cbp_step(
            a_w, a_b, mean_w, a_acts, state.a_util, state.a_age, state.a_accum, key
        )
        (c_w, c_b, critic_w, c_util, c_age, c_accum, key, c_repl) = self._cbp_step(
            c_w, c_b, critic_w, c_acts, state.c_util, state.c_age, state.c_accum, key
        )
        # On the rare step that a unit is replaced, drop that network's in-flight
        # eligibility (stale credit for a now-reinitialized unit is meaningless).
        a_trace = jax.tree.map(lambda t: jnp.where(a_repl, jnp.zeros_like(t), t), a_trace)
        c_trace = jax.tree.map(lambda t: jnp.where(c_repl, jnp.zeros_like(t), t), c_trace)

        updated = state.replace(
            a_weights=a_w,
            a_biases=a_b,
            mean_w=mean_w,
            mean_b=mean_b,
            log_sigma=log_sigma,
            a_trace=a_trace,
            c_weights=c_w,
            c_biases=c_b,
            critic_w=critic_w,
            critic_b=critic_b,
            c_trace=c_trace,
            a_util=a_util,
            a_age=a_age,
            a_accum=a_accum,
            c_util=c_util,
            c_age=c_age,
            c_accum=c_accum,
            step_count=state.step_count + 1,
        )
        next_action, key2 = self.sample_action(updated.replace(rng_key=key), next_obs, slot_next)
        new_state = updated.replace(
            last_obs=next_obs, last_action=next_action, last_slot=slot_next, rng_key=key2
        )
        return new_state, next_action, td_error


class AlbertaCBPController:
    """Online streaming nonlinear continual-RL controller (Stream-AC + CBP).

    Drop-in alternative to :class:`AlbertaContinualController` with the same
    streaming interface, but a *learned* MLP representation kept plastic by
    Continual Backprop, and an optional per-task multi-head readout (routed by
    prototype gating on the raw task-embedding channel) for anti-forgetting.
    """

    def __init__(self, config: CBPControllerConfig):
        self.config = config
        self._agent = _CBPStreamAC(config)
        self._normalizer = EMANormalizer(decay=config.normalizer_decay) if config.normalize else None
        key = jax.random.key(config.seed)
        self._state = self._agent.init(key)
        self._norm_state: EMANormalizerState | None = (
            self._normalizer.init(config.obs_dim) if self._normalizer is not None else None
        )
        self._steps = 0

        # Task routing (controller-owned, on the raw un-normalized embedding so
        # EMA normalization cannot disturb it). Fixed random prototypes, matching
        # the linear controller's sparse_gated convention.
        ret = config.retention
        self._n_slots = ret.slots
        self._embed_dim = ret.embed_dim
        if self._n_slots > 1 and self._embed_dim > 0:
            rng = np.random.default_rng(ret.proto_seed)
            self._proto = rng.standard_normal((self._n_slots, self._embed_dim)).astype(np.float32)
        else:
            self._proto = None

    def slot_of(self, observation: np.ndarray) -> int:
        """Route a raw observation to its head slot via nearest prototype."""
        if self._proto is None:
            return 0
        emb = np.asarray(observation, dtype=np.float32)[-self._embed_dim :]
        d2 = np.sum((self._proto - emb) ** 2, axis=1)
        return int(np.argmin(d2))

    def _obs(self, observation: np.ndarray, *, update_norm: bool) -> jnp.ndarray:
        obs = jnp.asarray(observation, dtype=jnp.float32)
        if self._normalizer is not None:
            assert self._norm_state is not None
            if update_norm:
                obs, self._norm_state = self._normalizer.normalize(self._norm_state, obs)
            else:
                obs = self._normalizer.normalize_only(self._norm_state, obs)
        return obs

    def start(self, observation: np.ndarray) -> np.ndarray:
        slot = jnp.asarray(self.slot_of(observation), dtype=jnp.int32)
        x = self._obs(observation, update_norm=True)
        self._state, action = self._agent.start(self._state, x, slot)
        return np.asarray(action, dtype=np.float32)

    def observe(
        self,
        reward: float,
        next_observation: np.ndarray,
        *,
        terminated: bool = False,
        truncated: bool = False,
    ) -> np.ndarray:
        slot = jnp.asarray(self.slot_of(next_observation), dtype=jnp.int32)
        x = self._obs(next_observation, update_norm=True)
        discount = 0.0 if terminated else self.config.gamma
        self._state, action, _td = self._agent.update(
            self._state,
            jnp.asarray(reward, dtype=jnp.float32),
            x,
            jnp.asarray(discount, dtype=jnp.float32),
            slot,
        )
        self._steps += 1
        return np.asarray(action, dtype=np.float32)

    def act_greedy(self, observation: np.ndarray) -> np.ndarray:
        slot = jnp.asarray(self.slot_of(observation), dtype=jnp.int32)
        x = self._obs(observation, update_norm=False)
        return np.asarray(self._agent.greedy_action(self._state, x, slot), dtype=np.float32)

    def value(self, observation: np.ndarray) -> float:
        slot = jnp.asarray(self.slot_of(observation), dtype=jnp.int32)
        x = self._obs(observation, update_norm=False)
        return float(self._agent.value_of(self._state, x, slot))

    @property
    def steps(self) -> int:
        return self._steps

    def state_dict(self) -> dict:
        s = self._state
        snap: dict = {
            "a_weights": [np.asarray(w) for w in s.a_weights],
            "a_biases": [np.asarray(b) for b in s.a_biases],
            "mean_w": np.asarray(s.mean_w),
            "mean_b": np.asarray(s.mean_b),
            "log_sigma": np.asarray(s.log_sigma),
            "c_weights": [np.asarray(w) for w in s.c_weights],
            "c_biases": [np.asarray(b) for b in s.c_biases],
            "critic_w": np.asarray(s.critic_w),
            "critic_b": np.asarray(s.critic_b),
            "a_util": [np.asarray(u) for u in s.a_util],
            "a_age": [np.asarray(a) for a in s.a_age],
            "c_util": [np.asarray(u) for u in s.c_util],
            "c_age": [np.asarray(a) for a in s.c_age],
            "steps": np.asarray(self._steps),
        }
        if self._norm_state is not None:
            snap["norm_mean"] = np.asarray(self._norm_state.mean)
            snap["norm_var"] = np.asarray(self._norm_state.var)
            snap["norm_count"] = np.asarray(self._norm_state.sample_count)
        return snap

    def load_state_dict(self, snap: dict) -> None:
        s = self._state
        self._state = s.replace(
            a_weights=tuple(jnp.asarray(w, dtype=jnp.float32) for w in snap["a_weights"]),
            a_biases=tuple(jnp.asarray(b, dtype=jnp.float32) for b in snap["a_biases"]),
            mean_w=jnp.asarray(snap["mean_w"], dtype=jnp.float32),
            mean_b=jnp.asarray(snap["mean_b"], dtype=jnp.float32),
            log_sigma=jnp.asarray(snap["log_sigma"], dtype=jnp.float32),
            c_weights=tuple(jnp.asarray(w, dtype=jnp.float32) for w in snap["c_weights"]),
            c_biases=tuple(jnp.asarray(b, dtype=jnp.float32) for b in snap["c_biases"]),
            critic_w=jnp.asarray(snap["critic_w"], dtype=jnp.float32),
            critic_b=jnp.asarray(snap["critic_b"], dtype=jnp.float32),
            a_util=tuple(jnp.asarray(u, dtype=jnp.float32) for u in snap["a_util"]),
            a_age=tuple(jnp.asarray(a, dtype=jnp.int32) for a in snap["a_age"]),
            c_util=tuple(jnp.asarray(u, dtype=jnp.float32) for u in snap["c_util"]),
            c_age=tuple(jnp.asarray(a, dtype=jnp.int32) for a in snap["c_age"]),
        )
        if self._norm_state is not None and "norm_mean" in snap:
            self._norm_state = self._norm_state.replace(
                mean=jnp.asarray(snap["norm_mean"], dtype=jnp.float32),
                var=jnp.asarray(snap["norm_var"], dtype=jnp.float32),
                sample_count=jnp.asarray(snap["norm_count"], dtype=jnp.float32),
            )
        self._steps = int(snap.get("steps", self._steps))
