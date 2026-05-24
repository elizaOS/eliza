"""Tests for differentiable EML circuits."""

import chex
import jax
import jax.numpy as jnp
import jax.random as jr

from alberta_framework import (
    BOOLEAN_INPUTS,
    DiffEMLGateSelector,
    DiffEMLLearner,
    EMLTreeLearner,
    EMLTreeState,
    RandomWalkStream,
    boolean_truth_table,
    build_eml_template_bank,
    eml_operator,
    eml_threshold_gate_library,
    evaluate_eml_template_bank,
    mask_from_truth_table,
    run_diffeml_learning_loop,
    run_eml_tree_learning_loop,
    stable_eml_operator,
)


def test_exact_eml_operator_gradients() -> None:
    """Exact EML has the expected partial derivatives for y > 0."""
    grad_x = jax.grad(lambda x: eml_operator(x, jnp.array(2.0)))(jnp.array(1.0))
    grad_y = jax.grad(lambda y: eml_operator(jnp.array(1.0), y))(jnp.array(2.0))

    chex.assert_trees_all_close(grad_x, jnp.exp(jnp.array(1.0)))
    chex.assert_trees_all_close(grad_y, jnp.array(-0.5))


def test_stable_eml_operator_stays_finite() -> None:
    """Stable EML handles unconstrained right inputs without NaNs."""
    x = jnp.array([-20.0, 0.0, 20.0])
    y = jnp.array([-20.0, 0.0, 20.0])
    out = stable_eml_operator(x, y)

    chex.assert_shape(out, (3,))
    chex.assert_tree_all_finite(out)


def test_diffeml_init_shapes_with_input_skip() -> None:
    """DiffEML parameter shapes should reflect layer source banks."""
    learner = DiffEMLLearner(depth=2, width=8)
    state = learner.init(feature_dim=3, key=jr.key(0))

    chex.assert_shape(state.params.left_logits[0], (8, 4))
    chex.assert_shape(state.params.right_logits[0], (8, 4))
    chex.assert_shape(state.params.left_logits[1], (8, 12))
    chex.assert_shape(state.params.right_logits[1], (8, 12))
    chex.assert_shape(state.params.readout_weights, (12,))
    chex.assert_shape(state.params.readout_bias, ())


def test_diffeml_predict_and_hard_predict_are_finite() -> None:
    """Soft and hard-routed predictions should both be finite scalars."""
    learner = DiffEMLLearner(depth=2, width=8)
    state = learner.init(feature_dim=3, key=jr.key(0))
    observation = jnp.array([0.2, -0.1, 0.5], dtype=jnp.float32)

    soft_prediction = learner.predict(state, observation)
    hard_prediction = learner.predict_hard(state, observation)

    chex.assert_shape(soft_prediction, (1,))
    chex.assert_shape(hard_prediction, (1,))
    chex.assert_tree_all_finite(soft_prediction)
    chex.assert_tree_all_finite(hard_prediction)


def test_diffeml_update_reduces_fixed_sample_error() -> None:
    """Repeated updates on one sample should reduce squared error."""
    learner = DiffEMLLearner(
        depth=2,
        width=12,
        step_size=0.01,
        max_grad_norm=5.0,
    )
    state = learner.init(feature_dim=3, key=jr.key(1))
    observation = jnp.array([0.4, -0.2, 0.7], dtype=jnp.float32)
    target = jnp.array([1.5], dtype=jnp.float32)

    initial_error = jnp.abs(target[0] - learner.predict(state, observation)[0])
    for _ in range(100):
        result = learner.update(state, observation, target)
        state = result.state
    final_error = jnp.abs(target[0] - learner.predict(state, observation)[0])

    assert float(final_error) < float(initial_error)


def test_diffeml_selection_probabilities_sum_to_one() -> None:
    """Routing probabilities should be valid categorical relaxations."""
    learner = DiffEMLLearner(depth=2, width=8)
    state = learner.init(feature_dim=3, key=jr.key(0))

    left_probs, right_probs = learner.selection_probabilities(state)

    for probs in (*left_probs, *right_probs):
        chex.assert_trees_all_close(jnp.sum(probs, axis=-1), jnp.ones(probs.shape[0]))


def test_run_diffeml_learning_loop_shapes() -> None:
    """The scan loop should produce fixed-size metrics."""
    stream = RandomWalkStream(feature_dim=4, drift_rate=0.001)
    learner = DiffEMLLearner(depth=1, width=8, step_size=0.001)

    state, metrics = run_diffeml_learning_loop(
        learner,
        stream,
        num_steps=25,
        key=jr.key(42),
    )

    chex.assert_shape(metrics, (25, 4))
    chex.assert_tree_all_finite(metrics)
    assert int(state.step_count) == 25


def test_eml_threshold_gate_library_depth_two_is_universal() -> None:
    """Depth-2 EML threshold templates should span all 16 binary gates."""
    library = eml_threshold_gate_library(depth=2, eps=0.05)

    assert library.size == 16
    assert library.masks == tuple(range(16))
    chex.assert_shape(library.outputs, (16, 4))
    for mask in range(16):
        chex.assert_trees_all_close(library.outputs[mask], boolean_truth_table(mask))
        assert mask_from_truth_table(library.outputs[mask]) == mask


def test_executable_eml_template_bank_matches_truth_table_library() -> None:
    """Executable templates should hard-evaluate to their gate truth tables."""
    library = eml_threshold_gate_library(depth=2, eps=0.05)
    bank = build_eml_template_bank(depth=2, eps=0.05)

    hard_values = evaluate_eml_template_bank(
        bank,
        BOOLEAN_INPUTS[:, 0],
        BOOLEAN_INPUTS[:, 1],
        eps=0.05,
        threshold_temperature=jnp.array(0.75, dtype=jnp.float32),
        hard=True,
    )
    soft_values = evaluate_eml_template_bank(
        bank,
        BOOLEAN_INPUTS[:, 0],
        BOOLEAN_INPUTS[:, 1],
        eps=0.05,
        threshold_temperature=jnp.array(0.75, dtype=jnp.float32),
        hard=False,
    )

    assert bank.size == library.size
    assert bank.masks == library.masks
    assert bank.names == library.names
    assert all("eml(" in expr or expr in {"0", "1", "A", "B"} for expr in bank.expressions)
    chex.assert_shape(hard_values, (4, 16))
    chex.assert_tree_all_finite(soft_values)
    chex.assert_trees_all_close(hard_values.T, library.outputs)


def test_diffeml_gate_selector_learns_xor_as_hard_eml_gate() -> None:
    """The selector should train soft weights and harden to XOR."""
    learner = DiffEMLGateSelector()
    state = learner.init(jr.key(0))
    result = learner.train_truth_table(state, boolean_truth_table(6), num_steps=50)

    hard_truth_table = learner.predict_hard_truth_table(result.state)
    soft_truth_table = learner.predict_truth_table(result.state)

    chex.assert_trees_all_close(hard_truth_table, boolean_truth_table(6))
    chex.assert_trees_all_close(
        (soft_truth_table >= 0.5).astype(jnp.float32),
        boolean_truth_table(6),
    )
    assert learner.selected_gate_mask(result.state) == 6
    assert "eml(" in learner.selected_gate_expression(result.state)
    assert result.metrics[-1, 5] > 0.99


def test_diffeml_gate_selector_learns_all_binary_gates() -> None:
    """One selector seed per gate should recover every hard Boolean function."""
    learner = DiffEMLGateSelector()
    recovered_masks = []

    for mask in range(16):
        state = learner.init(jr.key(20000 + mask))
        result = learner.train_truth_table(state, boolean_truth_table(mask), num_steps=50)
        recovered_masks.append(learner.selected_gate_mask(result.state))
        hard_truth_table = learner.predict_hard_truth_table(result.state)
        chex.assert_trees_all_close(hard_truth_table, boolean_truth_table(mask))

    assert recovered_masks == list(range(16))


def test_diffeml_gate_selector_predicts_rows() -> None:
    """Hard and soft scalar predictions should follow truth-table row order."""
    learner = DiffEMLGateSelector()
    state = learner.init(jr.key(2))
    result = learner.train_truth_table(state, boolean_truth_table(8), num_steps=50)

    predictions = jnp.concatenate(
        [learner.predict_hard(result.state, row) for row in BOOLEAN_INPUTS]
    )

    chex.assert_trees_all_close(predictions, boolean_truth_table(8))


def test_eml_tree_init_shapes() -> None:
    """Fixed-depth EML tree shapes should match leaves and candidates."""
    learner = EMLTreeLearner(depth=2, n_constants=3)
    state = learner.init(feature_dim=2, key=jr.key(0))

    chex.assert_shape(state.params.leaf_logits, (4, 6))
    chex.assert_shape(state.params.constant_params, (3,))
    chex.assert_shape(state.params.output_scale, ())
    chex.assert_shape(state.params.output_bias, ())
    assert learner.n_leaves == 4


def test_eml_tree_predict_hard_and_expression() -> None:
    """Soft and hard EML tree predictions should be inspectable."""
    learner = EMLTreeLearner(depth=2, n_constants=2)
    state = learner.init(feature_dim=1, key=jr.key(0))
    observation = jnp.array([0.25], dtype=jnp.float32)

    soft_prediction = learner.predict(state, observation)
    hard_prediction = learner.predict_hard(state, observation)
    expression = learner.hard_expression(state, feature_dim=1)

    chex.assert_shape(soft_prediction, (1,))
    chex.assert_shape(hard_prediction, (1,))
    chex.assert_tree_all_finite(soft_prediction)
    chex.assert_tree_all_finite(hard_prediction)
    assert expression.startswith("1")
    assert "eml(" in expression


def test_eml_tree_update_reduces_fixed_sample_error() -> None:
    """Repeated updates on a fixed sample should reduce soft-tree error."""
    learner = EMLTreeLearner(
        depth=2,
        n_constants=2,
        step_size=0.01,
        max_grad_norm=5.0,
        output_init_scale=0.1,
    )
    state = learner.init(feature_dim=1, key=jr.key(1))
    observation = jnp.array([0.4], dtype=jnp.float32)
    target = jnp.array([1.4], dtype=jnp.float32)

    initial_error = jnp.abs(target[0] - learner.predict(state, observation)[0])
    for _ in range(100):
        result = learner.update(state, observation, target)
        state = result.state
    final_error = jnp.abs(target[0] - learner.predict(state, observation)[0])

    assert float(final_error) < float(initial_error)


def test_eml_tree_soft_symbolic_probe_reduces_x_plus_one_mse() -> None:
    """A tiny symbolic probe should improve soft MSE and report hard MSE."""
    learner = EMLTreeLearner(
        depth=2,
        n_constants=2,
        step_size=0.01,
        max_grad_norm=5.0,
        output_init_scale=0.1,
    )
    state = learner.init(feature_dim=1, key=jr.key(0))
    xs = jnp.linspace(-0.8, 0.8, 17, dtype=jnp.float32).reshape(-1, 1)
    targets = xs + 1.0

    def mse(tree_state: EMLTreeState, hard: bool = False) -> float:
        predict = learner.predict_hard if hard else learner.predict
        errors = [
            (predict(tree_state, obs)[0] - target[0]) ** 2
            for obs, target in zip(xs, targets)
        ]
        return float(jnp.mean(jnp.array(errors)))

    initial_soft_mse = mse(state)
    for i in range(500):
        idx = i % xs.shape[0]
        state = learner.update(state, xs[idx], targets[idx]).state

    final_soft_mse = mse(state)
    final_hard_mse = mse(state, hard=True)

    assert final_soft_mse < initial_soft_mse
    assert jnp.isfinite(jnp.array(final_hard_mse))


def test_eml_tree_leaf_probabilities_sum_to_one() -> None:
    """Leaf choices should form valid categorical relaxations."""
    learner = EMLTreeLearner(depth=2, n_constants=2)
    state = learner.init(feature_dim=1, key=jr.key(0))

    probs = learner.leaf_selection_probabilities(state)

    chex.assert_shape(probs, (4, 4))
    chex.assert_trees_all_close(jnp.sum(probs, axis=-1), jnp.ones(4))


def test_run_eml_tree_learning_loop_shapes() -> None:
    """The fixed-tree scan loop should produce soft/hard recovery metrics."""
    stream = RandomWalkStream(feature_dim=3, drift_rate=0.001)
    learner = EMLTreeLearner(depth=1, n_constants=1, step_size=0.001)

    state, metrics = run_eml_tree_learning_loop(
        learner,
        stream,
        num_steps=25,
        key=jr.key(42),
    )

    chex.assert_shape(metrics, (25, 5))
    chex.assert_tree_all_finite(metrics)
    assert int(state.step_count) == 25
