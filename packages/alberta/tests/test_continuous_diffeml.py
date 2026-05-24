"""Tests for continuous DiffEML blocks."""

import inspect

import chex
import jax
import jax.numpy as jnp
import jax.random as jr

from alberta_framework.core import continuous_diffeml
from alberta_framework.core.continuous_diffeml import (
    ContinuousDiffEML,
    ContinuousDiffEMLState,
    SparseContinuousEMLCircuitState,
    approximate_stable_eml_operator,
    compile_sparse_continuous_eml_circuit,
    compiled_sparse_continuous_eml_circuit_forward,
    compiled_sparse_continuous_eml_circuit_forward_approx,
    compiled_sparse_continuous_eml_parameter_count,
    continuous_diffeml_forward,
    continuous_diffeml_loss,
    init_continuous_diffeml_state,
    init_sparse_continuous_eml_circuit_state,
    sparse_continuous_eml_circuit_forward,
    sparse_continuous_eml_circuit_loss,
    sparse_continuous_eml_parameter_count,
    sparse_source_entropy,
    train_continuous_diffeml,
    train_sparse_continuous_eml_circuit,
)


def make_toy_regression() -> tuple[jax.Array, jax.Array]:
    x = jnp.array(
        [
            [-1.0, -1.0],
            [-1.0, 1.0],
            [1.0, -1.0],
            [1.0, 1.0],
        ],
        dtype=jnp.float32,
    )
    y = (x[:, :1] * x[:, 1:2]) + 0.25 * x[:, :1]
    return x, y


def test_continuous_diffeml_init_and_forward_shapes_are_finite() -> None:
    state = init_continuous_diffeml_state(
        jr.key(0),
        input_dim=3,
        output_dim=2,
        hidden_sizes=(5, 4),
    )
    x = jnp.ones((7, 3), dtype=jnp.float32)

    predictions = continuous_diffeml_forward(state.params, x)
    single_prediction = continuous_diffeml_forward(state.params, x[0])

    chex.assert_shape(state.params.layers[0].left_kernel, (3, 5))
    chex.assert_shape(state.params.layers[1].right_kernel, (5, 4))
    chex.assert_shape(state.params.readout_kernel, (4, 2))
    chex.assert_shape(predictions, (7, 2))
    chex.assert_shape(single_prediction, (2,))
    chex.assert_tree_all_finite(predictions)
    chex.assert_tree_all_finite(single_prediction)


def test_continuous_diffeml_outputs_and_grads_are_finite() -> None:
    state = init_continuous_diffeml_state(jr.key(1), input_dim=2, hidden_sizes=(6,))
    x, y = make_toy_regression()

    value, grads = jax.value_and_grad(continuous_diffeml_loss)(state.params, x, y)

    chex.assert_tree_all_finite(value)
    chex.assert_tree_all_finite(grads)
    assert float(value) > 0.0


def test_continuous_diffeml_train_step_decreases_toy_loss() -> None:
    state = init_continuous_diffeml_state(jr.key(2), input_dim=2, hidden_sizes=(12, 12))
    x, y = make_toy_regression()
    initial_loss = continuous_diffeml_loss(state.params, x, y)

    @jax.jit
    def train(state: ContinuousDiffEMLState) -> tuple[ContinuousDiffEMLState, jax.Array]:
        return train_continuous_diffeml(
            state,
            x,
            y,
            steps=150,
            learning_rate=0.01,
            max_grad_norm=5.0,
        )

    state, _ = train(state)

    final_loss = continuous_diffeml_loss(state.params, x, y)
    chex.assert_tree_all_finite(final_loss)
    assert float(final_loss) < 0.5 * float(initial_loss)
    assert int(state.step_count) == 150


def test_continuous_diffeml_wrapper_update_shapes() -> None:
    learner = ContinuousDiffEML(hidden_sizes=(8,), output_dim=1, learning_rate=0.005)
    state = learner.init(input_dim=2, key=jr.key(3))
    x, y = make_toy_regression()

    result = learner.update(state, x, y)

    chex.assert_shape(result.predictions, (4, 1))
    chex.assert_tree_all_finite(result.predictions)
    chex.assert_tree_all_finite(result.loss)
    chex.assert_tree_all_finite(result.grad_norm)


def test_sparse_continuous_eml_circuit_forward_and_entropy_are_finite() -> None:
    state = init_sparse_continuous_eml_circuit_state(
        jr.key(4),
        input_dim=3,
        output_dim=2,
        depth=2,
        width=5,
    )
    x = jnp.ones((6, 3), dtype=jnp.float32)

    soft_predictions = sparse_continuous_eml_circuit_forward(
        state.params,
        x,
        temperature=0.7,
    )
    hard_predictions = sparse_continuous_eml_circuit_forward(
        state.params,
        x,
        hard=True,
    )
    entropy = sparse_source_entropy(state.params, temperature=0.7)

    chex.assert_shape(soft_predictions, (6, 2))
    chex.assert_shape(hard_predictions, (6, 2))
    chex.assert_tree_all_finite(soft_predictions)
    chex.assert_tree_all_finite(hard_predictions)
    chex.assert_tree_all_finite(entropy)
    assert float(entropy) > 0.0


def test_sparse_continuous_eml_circuit_training_decreases_toy_loss() -> None:
    state = init_sparse_continuous_eml_circuit_state(
        jr.key(5),
        input_dim=2,
        output_dim=1,
        depth=2,
        width=10,
    )
    x, y = make_toy_regression()
    initial_loss = sparse_continuous_eml_circuit_loss(state.params, x, y)

    @jax.jit
    def train(
        state: SparseContinuousEMLCircuitState,
    ) -> tuple[SparseContinuousEMLCircuitState, jax.Array]:
        return train_sparse_continuous_eml_circuit(
            state,
            x,
            y,
            steps=200,
            learning_rate=0.01,
            final_temperature=0.5,
            max_grad_norm=5.0,
        )

    state, metrics = train(state)
    final_loss = sparse_continuous_eml_circuit_loss(state.params, x, y)

    chex.assert_shape(metrics, (200, 4))
    chex.assert_tree_all_finite(metrics)
    chex.assert_tree_all_finite(final_loss)
    assert float(final_loss) < 0.75 * float(initial_loss)
    assert int(state.step_count) == 200


def test_sparse_continuous_eml_straight_through_hard_loss_has_gradients() -> None:
    state = init_sparse_continuous_eml_circuit_state(
        jr.key(8),
        input_dim=2,
        output_dim=1,
        depth=2,
        width=8,
    )
    x, y = make_toy_regression()

    value, grads = jax.value_and_grad(sparse_continuous_eml_circuit_loss)(
        state.params,
        x,
        y,
        temperature=0.5,
        hard_loss_weight=0.5,
    )

    chex.assert_tree_all_finite(value)
    chex.assert_tree_all_finite(grads)
    assert float(value) > 0.0


def test_compiled_sparse_continuous_eml_matches_hard_forward_and_compresses() -> None:
    state = init_sparse_continuous_eml_circuit_state(
        jr.key(6),
        input_dim=4,
        output_dim=3,
        depth=3,
        width=6,
    )
    x = jnp.reshape(jnp.linspace(-1.0, 1.0, 20, dtype=jnp.float32), (5, 4))
    compiled = compile_sparse_continuous_eml_circuit(state.params, input_dim=4)

    hard_logits = sparse_continuous_eml_circuit_forward(state.params, x, hard=True)
    compiled_logits = compiled_sparse_continuous_eml_circuit_forward(compiled, x)

    chex.assert_trees_all_close(compiled_logits, hard_logits, atol=1e-6)
    assert compiled_sparse_continuous_eml_parameter_count(compiled) < (
        sparse_continuous_eml_parameter_count(state.params)
    )


def test_approximate_compiled_sparse_continuous_eml_is_finite() -> None:
    state = init_sparse_continuous_eml_circuit_state(
        jr.key(7),
        input_dim=4,
        output_dim=3,
        depth=2,
        width=8,
    )
    x = jnp.reshape(jnp.linspace(-1.0, 1.0, 20, dtype=jnp.float32), (5, 4))
    compiled = compile_sparse_continuous_eml_circuit(state.params, input_dim=4)

    exact_logits = compiled_sparse_continuous_eml_circuit_forward(compiled, x)
    lut_logits = compiled_sparse_continuous_eml_circuit_forward_approx(
        compiled,
        x,
        approximation="lut",
    )
    poly_logits = compiled_sparse_continuous_eml_circuit_forward_approx(
        compiled,
        x,
        approximation="poly",
    )
    lut_fast_tanh_logits = compiled_sparse_continuous_eml_circuit_forward_approx(
        compiled,
        x,
        approximation="lut",
        approximate_tanh=True,
    )

    chex.assert_shape(lut_logits, exact_logits.shape)
    chex.assert_shape(poly_logits, exact_logits.shape)
    chex.assert_shape(lut_fast_tanh_logits, exact_logits.shape)
    chex.assert_tree_all_finite(lut_logits)
    chex.assert_tree_all_finite(poly_logits)
    chex.assert_tree_all_finite(lut_fast_tanh_logits)
    assert float(jnp.mean(jnp.abs(lut_logits - exact_logits))) < 0.05


def test_approximate_stable_eml_operator_is_finite() -> None:
    x = jnp.linspace(-2.0, 2.0, 17, dtype=jnp.float32)
    y = jnp.linspace(-2.0, 2.0, 17, dtype=jnp.float32)

    lut = approximate_stable_eml_operator(x, y, approximation="lut")
    poly = approximate_stable_eml_operator(x, y, approximation="poly")

    chex.assert_tree_all_finite(lut)
    chex.assert_tree_all_finite(poly)
    assert float(jnp.max(jnp.abs(lut - poly))) > 0.0


def test_continuous_diffeml_has_no_truth_table_dependency() -> None:
    source = inspect.getsource(continuous_diffeml)

    assert "eml_threshold_gate_library" not in source
    assert "boolean_truth_table" not in source
    assert "BOOLEAN_INPUTS" not in source
    assert "DiffEMLGateSelector" not in source
