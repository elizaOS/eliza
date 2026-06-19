"""Weight initializers for neural networks.

Implements sparse initialization following Elsayed et al. 2024
("Streaming Deep Reinforcement Learning Finally Works").
"""

import jax
import jax.numpy as jnp
import jax.random as jr
from jax import Array
from jaxtyping import Float


def sparse_init(
    key: Array,
    shape: tuple[int, int],
    sparsity: float = 0.9,
    init_type: str = "uniform",
) -> Float[Array, "fan_out fan_in"]:
    """Create a sparsely initialized weight matrix.

    Applies LeCun-scale initialization and then zeros out a fraction of
    weights per output neuron. This creates sparser gradient flows that
    improve stability in streaming learning settings.

    Reference: Elsayed et al. 2024, sparse_init.py

    Args:
        key: JAX random key
        shape: Weight matrix shape (fan_out, fan_in)
        sparsity: Fraction of input connections to zero out per output neuron
            (default: 0.9 means 90% sparse)
        init_type: Initialization distribution, "uniform" or "normal"
            (default: "uniform" for LeCun uniform)

    Returns:
        Weight matrix of given shape with specified sparsity

    Examples:
    ```python
    import jax.random as jr
    from alberta_framework.core.initializers import sparse_init

    key = jr.key(42)
    weights = sparse_init(key, (128, 10), sparsity=0.9)
    # weights has shape (128, 10), ~90% zeros per row
    ```
    """
    fan_out, fan_in = shape
    num_zeros = int(sparsity * fan_in + 0.5)  # round to nearest int

    # Split key for init and sparsity mask
    init_key, mask_key = jr.split(key)

    # LeCun-scale initialization
    scale = 1.0 / fan_in**0.5
    if init_type == "uniform":
        weights = jr.uniform(init_key, shape, dtype=jnp.float32, minval=-scale, maxval=scale)
    elif init_type == "normal":
        weights = jr.normal(init_key, shape, dtype=jnp.float32) * scale
    else:
        raise ValueError(f"init_type must be 'uniform' or 'normal', got '{init_type}'")

    if num_zeros <= 0:
        return weights
    if num_zeros >= fan_in:
        return jnp.zeros_like(weights)

    # Exact per-row sparsity without per-row random permutations.  `jr.permutation`
    # lowers to a shuffle kernel that can be very slow to compile in large suites.
    scores = jr.uniform(mask_key, shape, dtype=jnp.float32)
    zero_idx = jax.lax.top_k(scores, num_zeros)[1]
    row_idx = jnp.arange(fan_out)[:, None]
    masks = jnp.ones(shape, dtype=jnp.float32).at[row_idx, zero_idx].set(0.0)

    return weights * masks
