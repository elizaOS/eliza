"""Entity slot domain randomization noise for sim-to-real transfer.

Bridges the gap between perfect GT entity slots in simulation and noisy
real-world perception outputs. Applied per-step during training when
enable_entity_slots is True.

Noise model per field:
- Position (3): Gaussian ~N(0, 0.05) in normalized [-1,1] space (~0.25m real)
- Velocity (3): Gaussian ~N(0, 0.15) — real is noisy finite-diff vs GT
- Size (3): Gaussian ~N(0, 0.05) — real estimated from bounding box
- Confidence: replaced with U(0.3, 1.0) — sim always 1.0, real varies
- Recency: replaced with U(0.0, 0.2) — sim always 0.0, real has latency
- Bearing (2): Gaussian ~N(0, 0.03) — derived from noisy position
- Type one-hot (6): untouched — classification is reliable

All noise is JAX-compatible and JIT-compilable.
"""

from __future__ import annotations

import jax
import jax.numpy as jp

from eliza_robot.perception.entity_slots.slot_config import (
    BEARING_OFFSET,
    CONFIDENCE_OFFSET,
    NUM_ENTITY_SLOTS,
    NUM_ENTITY_TYPES,
    POSITION_OFFSET,
    RECENCY_OFFSET,
    SIZE_OFFSET,
    SLOT_DIM,
    TOTAL_ENTITY_DIMS,
    TYPE_OFFSET,
    VELOCITY_OFFSET,
)


def apply_entity_slot_noise(
    entity_slots: jax.Array,
    rng: jax.Array,
    position_std: float = 0.05,
    velocity_std: float = 0.15,
    size_std: float = 0.05,
    bearing_std: float = 0.03,
    confidence_range: tuple[float, float] = (0.3, 1.0),
    recency_range: tuple[float, float] = (0.0, 0.2),
    dropout_prob: float = 0.05,
) -> jax.Array:
    """Apply domain randomization noise to entity slots.

    Args:
        entity_slots: Flat (152,) entity slot tensor from sim_entity_slots_jax.
        rng: JAX PRNG key.
        position_std: Std of Gaussian noise on normalized position.
        velocity_std: Std of Gaussian noise on normalized velocity.
        size_std: Std of Gaussian noise on normalized size.
        bearing_std: Std of Gaussian noise on bearing sin/cos.
        confidence_range: Uniform range to replace GT confidence=1.0.
        recency_range: Uniform range to replace GT recency=0.0.
        dropout_prob: Probability of zeroing out an entire slot (missed detection).

    Returns:
        Noised (152,) entity slot tensor.
    """
    slots = entity_slots.reshape(NUM_ENTITY_SLOTS, SLOT_DIM)

    # Detect which slots are occupied (non-zero type one-hot)
    slot_active = jp.any(slots[:, TYPE_OFFSET:TYPE_OFFSET + NUM_ENTITY_TYPES] > 0.5, axis=1)

    def noise_single_slot(carry, x):
        rng = carry
        slot, active = x
        rng, pos_rng, vel_rng, sz_rng, bear_rng, conf_rng, rec_rng, drop_rng = (
            jax.random.split(rng, 8)
        )

        # Position noise
        pos_noise = position_std * jax.random.normal(pos_rng, (3,))
        slot = slot.at[POSITION_OFFSET:POSITION_OFFSET + 3].add(pos_noise)
        slot = slot.at[POSITION_OFFSET:POSITION_OFFSET + 3].set(
            jp.clip(slot[POSITION_OFFSET:POSITION_OFFSET + 3], -1.0, 1.0)
        )

        # Velocity noise (larger — biggest sim-to-real gap)
        vel_noise = velocity_std * jax.random.normal(vel_rng, (3,))
        slot = slot.at[VELOCITY_OFFSET:VELOCITY_OFFSET + 3].add(vel_noise)
        slot = slot.at[VELOCITY_OFFSET:VELOCITY_OFFSET + 3].set(
            jp.clip(slot[VELOCITY_OFFSET:VELOCITY_OFFSET + 3], -1.0, 1.0)
        )

        # Size noise
        sz_noise = size_std * jax.random.normal(sz_rng, (3,))
        slot = slot.at[SIZE_OFFSET:SIZE_OFFSET + 3].add(sz_noise)
        slot = slot.at[SIZE_OFFSET:SIZE_OFFSET + 3].set(
            jp.clip(slot[SIZE_OFFSET:SIZE_OFFSET + 3], 0.0, 1.0)
        )

        # Bearing noise
        bear_noise = bearing_std * jax.random.normal(bear_rng, (2,))
        slot = slot.at[BEARING_OFFSET:BEARING_OFFSET + 2].add(bear_noise)

        # Confidence: replace GT 1.0 with random value
        conf = jax.random.uniform(
            conf_rng, minval=confidence_range[0], maxval=confidence_range[1]
        )
        slot = slot.at[CONFIDENCE_OFFSET].set(conf)

        # Recency: replace GT 0.0 with small random latency
        rec = jax.random.uniform(
            rec_rng, minval=recency_range[0], maxval=recency_range[1]
        )
        slot = slot.at[RECENCY_OFFSET].set(rec)

        # Slot dropout: zero out entire slot with small probability
        drop = jax.random.bernoulli(drop_rng, dropout_prob)
        slot = jp.where(drop & active, jp.zeros(SLOT_DIM), slot)

        # Only apply noise to active slots
        slot = jp.where(active, slot, jp.zeros(SLOT_DIM))

        return rng, slot

    _, noised_slots = jax.lax.scan(
        noise_single_slot, rng, (slots, slot_active)
    )

    return noised_slots.flatten()
