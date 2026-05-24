"""Fixed nonlinear feature lifts for the Alberta linear control agents.

``ContinuousActorCriticAgent`` (and the discrete actor-critic / SARSA cores) are
*linear* over whatever feature vector they are handed. A fixed random nonlinear
projection gives that linear policy the capacity to represent task-conditioned
behaviour without introducing a backbone that the actor-critic update cannot
train through. This is the standard random-feature trick (Rahimi & Recht 2007):
``phi(x) = tanh(W x + b)`` with ``W, b`` drawn once and frozen.

Because the lift is frozen, it adds no plasticity-loss surface of its own — the
only weights that learn online are the linear actor/critic heads, which is
exactly where the Alberta meta-step / bounding machinery applies.
"""

from __future__ import annotations

from dataclasses import dataclass

import jax
import jax.numpy as jnp
from jax import Array


@dataclass(frozen=True)
class FeatureConfig:
    """Configuration for the observation feature lift.

    Attributes:
        mode: ``"raw"`` passes the observation straight through;
            ``"random_tanh"`` applies a frozen random tanh projection;
            ``"raw_plus_random_tanh"`` concatenates both;
            ``"sparse_gated"`` builds a sparse, task-localized representation
            (see :class:`FeatureMap`) — the continual-learning lift that lets
            different tasks occupy disjoint weights and so resists forgetting.
        random_dim: Width of the random projection (random_tanh modes).
        scale: Std-dev of the projection weights ``W``.
        seed: PRNG seed for the frozen projection.
        embed_dim: Number of trailing observation dims that carry the task
            signal (the embedding / text channel). Required for ``sparse_gated``.
        n_prototypes: Number of fixed prototypes that tile the embedding space
            (``sparse_gated``). Tasks falling near distinct prototypes get
            disjoint feature blocks. Use comfortably more than the task count.
        gate_temperature: Softmax temperature over prototype similarities;
            lower ⇒ sharper (more one-hot) gating ⇒ less cross-task interference.
            Ignored when ``gate_hard`` is set.
        gate_hard: Use a hard one-hot gate (winning prototype only). The active
            block then gets the full, undiluted learning signal — recovering
            single-task capacity — while every other block is exactly zero, so
            distinct tasks share no weights at all (perfect retention).
        proprio_random_dim: Random tanh features built from the proprioceptive
            (non-embedding) channel inside each gated block. 0 ⇒ raw proprio.
    """

    mode: str = "sparse_gated"
    random_dim: int = 256
    scale: float = 1.0
    seed: int = 0
    embed_dim: int = 0
    n_prototypes: int = 64
    gate_temperature: float = 0.1
    gate_hard: bool = True
    proprio_random_dim: int = 128

    def output_dim(self, input_dim: int) -> int:
        if self.mode == "raw":
            return input_dim
        if self.mode == "random_tanh":
            return self.random_dim
        if self.mode == "raw_plus_random_tanh":
            return input_dim + self.random_dim
        if self.mode == "sparse_gated":
            proprio_dim = input_dim - self.embed_dim
            block = 1 + proprio_dim + self.proprio_random_dim
            return self.n_prototypes * block
        raise ValueError(f"unknown feature mode {self.mode!r}")


class FeatureMap:
    """A frozen observation -> feature transform (pure JAX, jit-friendly)."""

    def __init__(self, config: FeatureConfig, input_dim: int):
        self.config = config
        self.input_dim = input_dim
        self.feature_dim = config.output_dim(input_dim)
        key = jax.random.key(config.seed)

        if config.mode in ("random_tanh", "raw_plus_random_tanh"):
            w_key, b_key = jax.random.split(key)
            self._w = config.scale * jax.random.normal(
                w_key, (config.random_dim, input_dim), dtype=jnp.float32
            ) / jnp.sqrt(jnp.asarray(input_dim, dtype=jnp.float32))
            self._b = 2.0 * jnp.pi * jax.random.uniform(b_key, (config.random_dim,), dtype=jnp.float32)
        else:
            self._w = None
            self._b = None

        if config.mode == "sparse_gated":
            if config.embed_dim <= 0 or config.embed_dim >= input_dim:
                raise ValueError("sparse_gated requires 0 < embed_dim < input_dim")
            self._proprio_dim = input_dim - config.embed_dim
            p_key, pw_key, pb_key = jax.random.split(key, 3)
            # Fixed prototypes tiling the embedding space. Drawn from the same
            # standard-normal distribution as the task embeddings so tasks land
            # near distinct prototypes -> distinct (disjoint) gated blocks.
            self._prototypes = jax.random.normal(
                p_key, (config.n_prototypes, config.embed_dim), dtype=jnp.float32
            )
            if config.proprio_random_dim > 0:
                self._pw = config.scale * jax.random.normal(
                    pw_key, (config.proprio_random_dim, self._proprio_dim), dtype=jnp.float32
                ) / jnp.sqrt(jnp.asarray(self._proprio_dim, dtype=jnp.float32))
                self._pb = 2.0 * jnp.pi * jax.random.uniform(
                    pb_key, (config.proprio_random_dim,), dtype=jnp.float32
                )
            else:
                self._pw = None
                self._pb = None

    def __call__(self, observation: Array) -> Array:
        return self._transform(observation)

    def _transform(self, observation: Array) -> Array:
        obs = jnp.asarray(observation, dtype=jnp.float32)
        if self.config.mode == "raw":
            return obs
        if self.config.mode == "sparse_gated":
            return self._sparse_gated(obs)
        lifted = jnp.tanh(self._w @ obs + self._b)
        if self.config.mode == "random_tanh":
            return lifted
        return jnp.concatenate([obs, lifted])

    def _sparse_gated(self, obs: Array) -> Array:
        """Mixture-of-linear-experts gated by a sparse code of the embedding.

        The embedding channel selects (via a sharp softmax over fixed
        prototypes) which prototype block is active; the proprioceptive channel
        fills that block. Distinct tasks ⇒ distinct active blocks ⇒ their linear
        weights do not overlap, so learning one task cannot overwrite another.
        """
        cfg = self.config
        proprio = obs[: self._proprio_dim]
        embed = obs[self._proprio_dim :]
        # Gate over prototype similarities (negative squared distance). A hard
        # one-hot gate gives the winning block the full learning signal and
        # zeroes the rest (no shared weights across tasks); a sharp softmax is
        # the smooth alternative.
        d2 = jnp.sum((self._prototypes - embed[None, :]) ** 2, axis=1)
        if cfg.gate_hard:
            gate = jax.nn.one_hot(jnp.argmin(d2), cfg.n_prototypes, dtype=jnp.float32)
        else:
            gate = jax.nn.softmax(-d2 / cfg.gate_temperature)
        # Per-block proprio features: [bias, proprio, tanh(random proj)].
        parts = [jnp.ones((1,), dtype=jnp.float32), proprio]
        if self._pw is not None:
            parts.append(jnp.tanh(self._pw @ proprio + self._pb))
        block = jnp.concatenate(parts)  # (block_dim,)
        # Outer product gate ⊗ block, flattened: only active block is nonzero.
        return (gate[:, None] * block[None, :]).reshape(-1)
