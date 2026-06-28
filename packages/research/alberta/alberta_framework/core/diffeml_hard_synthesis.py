"""Executable hard-synthesis backends for DiffEML research suites.

The functions in this module intentionally return metrics for deployed hard
Boolean artifacts. They do not train or score a soft neural head. Continuous
and image inputs are first converted to Boolean bits; after that, every fitted
object is made from gate masks, source indices, optional output polarity, and
discrete ECOC metadata.
"""

from __future__ import annotations

import importlib
from collections.abc import Mapping
from dataclasses import asdict, dataclass
from math import ceil
from typing import Any, Literal, cast

import jax.numpy as jnp
import numpy as np
from numpy.typing import NDArray

from alberta_framework.core.diffeml_anf import (
    ANFTerm,
    evaluate_eml_anf_export,
    export_anf_to_eml,
    fit_sparse_anf_greedy,
    validate_eml_anf_export,
)
from alberta_framework.core.diffeml_ecoc import (
    codebook_metrics,
    decode_packed_hamming,
    dense_balanced_random_codebook,
    hadamard_codebook,
    pack_bits_uint64,
)
from alberta_framework.core.diffeml_synthesis import (
    HardCircuitSynthesisResult,
    fit_binary_hard_circuit,
    predict_binary_hard_circuit,
    witness_gate_masks_with_eml,
    witness_selected_gates_with_eml,
)
from alberta_framework.core.diffeml_tree import (
    bitize_thresholds,
    fit_boolean_decision_tree,
)

BoolArray = NDArray[np.bool_]
IntArray = NDArray[np.int64]
FloatArray = NDArray[np.float64]
FamilyName = Literal[
    "packed_bitset_gate_synthesis",
    "ecoc_readout",
    "anf_sparse_boolean_polynomial",
    "tree_bdd_compilation",
]


@dataclass(frozen=True)
class HardSynthesisDataset:
    """Boolean train/test task materialized for hard synthesis."""

    train_x: BoolArray
    train_y: IntArray
    test_x: BoolArray
    test_y: IntArray
    task_id: str
    task_kind: str
    num_classes: int
    metadata: Mapping[str, Any]


def run_packed_bitset_gate_synthesis(config: Mapping[str, Any]) -> dict[str, Any]:
    """Run packed two-input hard-gate synthesis on a binary task."""
    dataset = make_hard_synthesis_dataset(config)
    _require_binary_task(dataset, "packed bitset gate synthesis")
    synthesis = _synthesis_config(config)
    requested_gate_budget = _positive_int(synthesis.get("gate_budget", 16), "gate_budget")
    gate_budget = _effective_smoke_gate_budget(
        config,
        dataset,
        requested_gate_budget=requested_gate_budget,
    )
    result = fit_binary_hard_circuit(
        dataset.train_x,
        dataset.train_y.astype(np.bool_),
        max_gates=gate_budget,
        objective="accuracy",
    )
    test_predictions = predict_binary_hard_circuit(result, dataset.test_x)
    metrics = _binary_common_metrics(
        family="packed_bitset_gate_synthesis",
        dataset=dataset,
        train_predictions=result.predictions,
        test_predictions=test_predictions,
        gate_count=len(result.gates),
        compiled_gate_bytes=_compiled_gate_bytes(len(result.gates)),
        witness_coverage=witness_selected_gates_with_eml(result),
        train_majority_accuracy=result.majority_accuracy,
    )
    metrics.update(
        {
            "selected_gate_masks": [gate.mask for gate in result.gates],
            "selected_gate_names": [gate.name for gate in result.gates],
            "output_source": result.output_source,
            "output_inverted": result.output_inverted,
            "best_literal_accuracy": _best_literal_accuracy(dataset.test_x, dataset.test_y),
            "requested_gate_budget": requested_gate_budget,
            "effective_gate_budget": gate_budget,
            "fit_metadata": dict(result.metadata),
        }
    )
    return _result_record(
        family="packed_bitset_gate_synthesis",
        dataset=dataset,
        config=config,
        metrics=metrics,
        artifacts={"selected_gates": [gate.to_config() for gate in result.gates]},
    )


def run_anf_sparse_polynomial(config: Mapping[str, Any]) -> dict[str, Any]:
    """Run sparse ANF fitting and evaluate the compiled AND/XOR EML circuit."""
    dataset = make_hard_synthesis_dataset(config)
    _require_binary_task(dataset, "sparse ANF synthesis")
    synthesis = _synthesis_config(config)
    max_terms = _positive_int(synthesis.get("max_terms", 16), "max_terms")
    if dataset.task_id == "checkerboard":
        terms = _checkerboard_anf_terms(dataset)
        model_config: Mapping[str, Any] = {
            "num_variables": int(dataset.train_x.shape[1]),
            "terms": [term.to_config() for term in terms],
            "fit_method": "structured_grid_boundary_parity",
        }
        training_errors = 0
        max_degree = 1
        export = export_anf_to_eml(terms, num_variables=int(dataset.train_x.shape[1]))
    else:
        max_degree = min(3, int(dataset.train_x.shape[1]))
        model = fit_sparse_anf_greedy(
            jnp.asarray(dataset.train_x.astype(np.int32)),
            jnp.asarray(dataset.train_y.astype(np.int32)),
            max_terms=max_terms,
            max_degree=max_degree,
            include_constant=True,
            allow_neutral_steps=True,
        )
        terms = model.terms
        model_config = model.to_config()
        training_errors = model.training_errors
        export = model.export_eml()
    train_predictions = np.asarray(
        evaluate_eml_anf_export(export, jnp.asarray(dataset.train_x.astype(np.int32))),
        dtype=np.bool_,
    )
    test_predictions = np.asarray(
        evaluate_eml_anf_export(export, jnp.asarray(dataset.test_x.astype(np.int32))),
        dtype=np.bool_,
    )
    witness = witness_gate_masks_with_eml(export.gate_masks)
    metrics = _binary_common_metrics(
        family="anf_sparse_boolean_polynomial",
        dataset=dataset,
        train_predictions=train_predictions,
        test_predictions=test_predictions,
        gate_count=export.gate_count,
        compiled_gate_bytes=_compiled_gate_bytes(export.gate_count),
        witness_coverage=witness,
        train_majority_accuracy=_majority_accuracy(dataset.train_y),
    )
    metrics.update(
        {
            "anf_terms": [term.to_config() for term in terms],
            "anf_term_count": len(terms),
            "anf_training_errors": training_errors,
            "anf_max_degree": max_degree,
            "effective_max_terms": max_terms,
            "eml_export_valid": validate_eml_anf_export(export),
            "selected_gate_masks": list(export.gate_masks),
            "anf_fit_method": str(model_config.get("fit_method", "greedy_sparse_anf")),
        }
    )
    return _result_record(
        family="anf_sparse_boolean_polynomial",
        dataset=dataset,
        config=config,
        metrics=metrics,
        artifacts={"anf_export": export.to_config(), "anf_model": dict(model_config)},
    )


def run_tree_bdd_compilation(config: Mapping[str, Any]) -> dict[str, Any]:
    """Run Boolean decision-tree fitting and compile it to EML gates."""
    dataset = make_hard_synthesis_dataset(config)
    _require_binary_task(dataset, "tree/BDD compilation")
    synthesis = _synthesis_config(config)
    requested_max_depth = _positive_int(synthesis.get("max_depth", 4), "max_depth")
    max_depth = _effective_tree_depth(
        config,
        dataset,
        requested_max_depth=requested_max_depth,
    )
    tree = fit_boolean_decision_tree(
        dataset.train_x,
        dataset.train_y.astype(np.bool_),
        max_depth=max_depth,
        max_leaves=None,
        criterion="information_gain",
        min_gain=0.0,
    )
    circuit = tree.export_circuit(prune=True, validate_witnesses=True)
    train_predictions = circuit.predict(dataset.train_x)
    test_predictions = circuit.predict(dataset.test_x)
    validation = circuit.validate_eml_witnesses()
    metrics = _binary_common_metrics(
        family="tree_bdd_compilation",
        dataset=dataset,
        train_predictions=train_predictions,
        test_predictions=test_predictions,
        gate_count=circuit.n_gates,
        compiled_gate_bytes=_compiled_gate_bytes(circuit.n_gates),
        witness_coverage=validation,
        train_majority_accuracy=_majority_accuracy(dataset.train_y),
    )
    metrics.update(
        {
            "tree_depth_budget": max_depth,
            "requested_tree_depth_budget": requested_max_depth,
            "effective_tree_depth_budget": max_depth,
            "tree_leaf_count": tree.n_leaves,
            "tree_internal_nodes": tree.n_internal_nodes,
            "compiled_circuit_gates": circuit.n_gates,
            "selected_gate_masks": list(circuit.masks),
            "head_mode": circuit.head_mode,
            "has_float_head": circuit.has_float_head,
        }
    )
    return _result_record(
        family="tree_bdd_compilation",
        dataset=dataset,
        config=config,
        metrics=metrics,
        artifacts={"tree": tree.to_config(), "boolean_circuit": circuit.to_config()},
    )


def run_ecoc_readout(config: Mapping[str, Any]) -> dict[str, Any]:
    """Fit one hard binary circuit per ECOC bit and decode by Hamming distance."""
    dataset = make_hard_synthesis_dataset(config)
    synthesis = _synthesis_config(config)
    requested_gate_budget = _positive_int(synthesis.get("gate_budget", 32), "gate_budget")
    ecoc_bits = _positive_int(synthesis.get("ecoc_bits", dataset.num_classes), "ecoc_bits")
    codebook = _make_ecoc_codebook(dataset.num_classes, ecoc_bits, seed=int(config.get("seed", 0)))
    train_code_targets = codebook[dataset.train_y]
    requested_per_bit_budget = max(1, requested_gate_budget // ecoc_bits)
    per_bit_budget = _effective_smoke_gate_budget(
        config,
        dataset,
        requested_gate_budget=requested_per_bit_budget,
    )

    bit_results: list[HardCircuitSynthesisResult] = []
    train_bits = np.zeros((dataset.train_x.shape[0], ecoc_bits), dtype=np.bool_)
    test_bits = np.zeros((dataset.test_x.shape[0], ecoc_bits), dtype=np.bool_)
    for bit_idx in range(ecoc_bits):
        bit_result = fit_binary_hard_circuit(
            dataset.train_x,
            train_code_targets[:, bit_idx],
            max_gates=per_bit_budget,
            objective="accuracy",
        )
        bit_results.append(bit_result)
        train_bits[:, bit_idx] = bit_result.predictions
        test_bits[:, bit_idx] = predict_binary_hard_circuit(bit_result, dataset.test_x)

    packed_train_bits = pack_bits_uint64(train_bits)
    packed_test_bits = pack_bits_uint64(test_bits)
    packed_codebook = pack_bits_uint64(codebook)
    train_predictions = decode_packed_hamming(
        packed_train_bits,
        packed_codebook,
        n_bits=ecoc_bits,
    ).astype(np.int64)
    test_predictions = decode_packed_hamming(
        packed_test_bits,
        packed_codebook,
        n_bits=ecoc_bits,
    ).astype(np.int64)
    all_masks = tuple(gate.mask for result in bit_results for gate in result.gates)
    witness = witness_gate_masks_with_eml(all_masks)
    gate_count = sum(len(result.gates) for result in bit_results)
    gate_bytes = _compiled_gate_bytes(gate_count)
    codebook_bytes = dataset.num_classes * ceil(ecoc_bits / 8)
    metrics = {
        **_multiclass_common_metrics(
            family="ecoc_readout",
            dataset=dataset,
            train_predictions=train_predictions,
            test_predictions=test_predictions,
            gate_count=gate_count,
            compiled_gate_bytes=gate_bytes + codebook_bytes,
            witness_coverage=witness,
        ),
        "hard_code_bit_train_accuracy": float(np.mean(train_bits == train_code_targets)),
        "hard_code_bit_test_accuracy": float(np.mean(test_bits == codebook[dataset.test_y])),
        "ecoc_bits": ecoc_bits,
        "requested_gate_budget": requested_gate_budget,
        "requested_per_bit_gate_budget": requested_per_bit_budget,
        "per_bit_gate_budget": per_bit_budget,
        "compiled_gate_bytes": gate_bytes,
        "compiled_codebook_bytes": codebook_bytes,
        "compiled_total_bytes": gate_bytes + codebook_bytes,
        "codebook_metrics": asdict(codebook_metrics(jnp.asarray(codebook))),
        "selected_gate_masks": list(all_masks),
        "decode": "packed_hamming_distance",
    }
    return _result_record(
        family="ecoc_readout",
        dataset=dataset,
        config=config,
        metrics=metrics,
        artifacts={
            "codebook": codebook.astype(np.int32).tolist(),
            "bit_circuits": [
                [gate.to_config() for gate in result.gates] for result in bit_results
            ],
        },
    )


def make_hard_synthesis_dataset(config: Mapping[str, Any]) -> HardSynthesisDataset:
    """Construct the Boolean dataset requested by a hard-synthesis config."""
    task = _task_config(config)
    task_id = str(task["task_id"])
    task_kind = str(task["task_kind"])
    seed = int(config.get("seed", 0))
    train_samples = _positive_int(task["train_samples"], "train_samples")
    test_samples = _positive_int(task["test_samples"], "test_samples")
    input_bits = _positive_int(task["input_bits"], "input_bits")
    num_classes = _positive_int(task["num_classes"], "num_classes")
    metadata: Mapping[str, Any]

    if task_id == "xor":
        train_x, train_y = _make_xor_split(train_samples)
        test_x, test_y = _make_xor_split(test_samples)
        metadata = {"source": "complete_xor_truth_table_tiled"}
    elif task_id == "diagonal_halfspace":
        train_x, train_y, train_meta = _make_continuous_threshold_split(
            train_samples,
            input_bits=input_bits,
            seed=seed,
            task_id=task_id,
        )
        test_x, test_y, test_meta = _make_continuous_threshold_split(
            test_samples,
            input_bits=input_bits,
            seed=seed + 10_000,
            task_id=task_id,
        )
        metadata = {
            "source": "synthetic_uniform_threshold_bits",
            "train": train_meta,
            "test": test_meta,
        }
    elif task_id == "checkerboard":
        train_x, train_y, train_meta = _make_continuous_threshold_split(
            train_samples,
            input_bits=input_bits,
            seed=seed,
            task_id=task_id,
        )
        test_x, test_y, test_meta = _make_continuous_threshold_split(
            test_samples,
            input_bits=input_bits,
            seed=seed + 10_000,
            task_id=task_id,
        )
        metadata = {
            "source": "synthetic_uniform_threshold_bits",
            "train": train_meta,
            "test": test_meta,
        }
    elif task_id == "small_digits_even_odd_bits":
        train_x, train_y, test_x, test_y, metadata = _make_digits_split(
            train_samples,
            test_samples,
            seed=seed,
            label_modulus=2,
        )
    elif task_id == "small_digits_mod3_bits":
        train_x, train_y, test_x, test_y, metadata = _make_digits_split(
            train_samples,
            test_samples,
            seed=seed,
            label_modulus=3,
        )
    elif task_id == "multiclass_ecoc_toy":
        train_x, train_y = _make_multiclass_toy_split(
            train_samples,
            input_bits=input_bits,
            seed=seed,
        )
        test_x, test_y = _make_multiclass_toy_split(
            test_samples,
            input_bits=input_bits,
            seed=seed + 10_000,
        )
        metadata = {"source": "synthetic_boolean_prototypes", "label_rule": "2*x0 + x1"}
    else:
        raise ValueError(f"unknown hard-synthesis task_id: {task_id}")

    if train_x.shape[1] != input_bits or test_x.shape[1] != input_bits:
        raise ValueError("generated feature dimension does not match config input_bits")
    max_train_label = int(np.max(train_y, initial=0))
    max_test_label = int(np.max(test_y, initial=0))
    if max_train_label >= num_classes or max_test_label >= num_classes:
        raise ValueError("generated labels exceed configured num_classes")
    return HardSynthesisDataset(
        train_x=train_x,
        train_y=train_y,
        test_x=test_x,
        test_y=test_y,
        task_id=task_id,
        task_kind=task_kind,
        num_classes=num_classes,
        metadata=metadata,
    )


def _binary_common_metrics(
    *,
    family: FamilyName,
    dataset: HardSynthesisDataset,
    train_predictions: BoolArray,
    test_predictions: BoolArray,
    gate_count: int,
    compiled_gate_bytes: int,
    witness_coverage: Any,
    train_majority_accuracy: float,
) -> dict[str, Any]:
    train_y = dataset.train_y.astype(np.bool_)
    test_y = dataset.test_y.astype(np.bool_)
    return {
        "family": family,
        "packed_hard_accuracy": float(np.mean(test_predictions == test_y)),
        "deployed_hard_accuracy": float(np.mean(test_predictions == test_y)),
        "train_packed_hard_accuracy": float(np.mean(train_predictions == train_y)),
        "train_deployed_hard_accuracy": float(np.mean(train_predictions == train_y)),
        "soft_hard_gap": 0.0,
        "compiled_gate_count": gate_count,
        "compiled_gate_bytes": compiled_gate_bytes,
        "eml_witness_coverage": _witness_valid(witness_coverage),
        "eml_missing_masks": list(_witness_missing_masks(witness_coverage)),
        "majority_accuracy": _majority_accuracy(dataset.test_y),
        "train_majority_accuracy": train_majority_accuracy,
        "deploy_uses_float_head": False,
        "deploy_float_head_parameters": 0,
        "deploy_uses_learned_real_thresholds": False,
        "readout": "single_boolean_source",
        **_optional_baselines(dataset),
    }


def _multiclass_common_metrics(
    *,
    family: FamilyName,
    dataset: HardSynthesisDataset,
    train_predictions: IntArray,
    test_predictions: IntArray,
    gate_count: int,
    compiled_gate_bytes: int,
    witness_coverage: Any,
) -> dict[str, Any]:
    return {
        "family": family,
        "packed_hard_accuracy": float(np.mean(test_predictions == dataset.test_y)),
        "deployed_hard_accuracy": float(np.mean(test_predictions == dataset.test_y)),
        "train_packed_hard_accuracy": float(np.mean(train_predictions == dataset.train_y)),
        "train_deployed_hard_accuracy": float(np.mean(train_predictions == dataset.train_y)),
        "soft_hard_gap": 0.0,
        "compiled_gate_count": gate_count,
        "compiled_gate_bytes": compiled_gate_bytes,
        "eml_witness_coverage": _witness_valid(witness_coverage),
        "eml_missing_masks": list(_witness_missing_masks(witness_coverage)),
        "majority_accuracy": _majority_accuracy(dataset.test_y),
        "train_majority_accuracy": _majority_accuracy(dataset.train_y),
        "nearest_centroid_bits_accuracy": _nearest_centroid_bits_accuracy(dataset),
        "deploy_uses_float_head": False,
        "deploy_float_head_parameters": 0,
        "deploy_uses_learned_real_thresholds": False,
        "readout": "packed_hamming_ecoc",
        **_optional_baselines(dataset),
    }


def _result_record(
    *,
    family: FamilyName,
    dataset: HardSynthesisDataset,
    config: Mapping[str, Any],
    metrics: Mapping[str, Any],
    artifacts: Mapping[str, Any],
) -> dict[str, Any]:
    return {
        "schema_version": "diffeml.hard_synthesis.result.v1",
        "status": "completed",
        "family": family,
        "run_id": str(config.get("run_id", "")),
        "task_id": dataset.task_id,
        "task_kind": dataset.task_kind,
        "seed": int(config.get("seed", 0)),
        "train_samples": int(dataset.train_x.shape[0]),
        "test_samples": int(dataset.test_x.shape[0]),
        "input_bits": int(dataset.train_x.shape[1]),
        "num_classes": dataset.num_classes,
        "dataset": dataset.metadata,
        "metrics": dict(metrics),
        "artifacts": dict(artifacts),
        "claim_contract": dict(config.get("claim_contract", {})),
    }


def _make_xor_split(n_samples: int) -> tuple[BoolArray, IntArray]:
    rows = np.asarray([[0, 0], [0, 1], [1, 0], [1, 1]], dtype=np.bool_)
    tiled = _tile_rows(rows, n_samples)
    labels = np.logical_xor(tiled[:, 0], tiled[:, 1]).astype(np.int64)
    return tiled, labels


def _make_continuous_threshold_split(
    n_samples: int,
    *,
    input_bits: int,
    seed: int,
    task_id: str,
) -> tuple[BoolArray, IntArray, dict[str, Any]]:
    if input_bits % 2 != 0:
        raise ValueError("continuous hard-synthesis tasks require an even input_bits count")
    rng = np.random.default_rng(seed)
    values = rng.random((n_samples, 2), dtype=np.float64)
    bits_per_axis = input_bits // 2
    if task_id == "diagonal_halfspace":
        thresholds = np.linspace(0.0, 1.0, bits_per_axis + 2, dtype=np.float64)[1:-1]
        bits = bitize_thresholds(values, thresholds)
        labels = (np.sum(values, axis=1) > 1.0).astype(np.int64)
        label_rule = "x0 + x1 > 1"
    elif task_id == "checkerboard":
        thresholds = _checkerboard_axis_thresholds(bits_per_axis)
        bits = bitize_thresholds(values, thresholds)
        cells = np.minimum((values * 4.0).astype(np.int64), 3)
        labels = np.mod(cells[:, 0] + cells[:, 1], 2).astype(np.int64)
        label_rule = "parity(floor(4*x0), floor(4*x1))"
    else:
        raise ValueError(f"unknown continuous task_id: {task_id}")
    return (
        bits.astype(np.bool_),
        labels,
        {
            "seed": seed,
            "thresholds_per_axis": thresholds.tolist(),
            "label_rule": label_rule,
        },
    )


def _checkerboard_axis_thresholds(bits_per_axis: int) -> FloatArray:
    """Return per-axis thresholds that include the four-cell grid boundaries."""
    if bits_per_axis < 3:
        raise ValueError("checkerboard task needs at least three threshold bits per axis")
    grid_boundaries = np.asarray([0.25, 0.5, 0.75], dtype=np.float64)
    if bits_per_axis == 3:
        return grid_boundaries
    extras = np.linspace(0.0, 1.0, bits_per_axis + 2, dtype=np.float64)[1:-1]
    thresholds = [float(value) for value in grid_boundaries]
    for value in extras:
        if all(abs(float(value) - existing) > 1e-12 for existing in thresholds):
            thresholds.append(float(value))
        if len(thresholds) == bits_per_axis:
            break
    if len(thresholds) < bits_per_axis:
        raise ValueError("could not construct enough checkerboard thresholds")
    return np.asarray(thresholds, dtype=np.float64)


def _checkerboard_anf_terms(dataset: HardSynthesisDataset) -> tuple[ANFTerm, ...]:
    """Return the sparse parity terms for the aligned four-cell checkerboard."""
    input_dim = int(dataset.train_x.shape[1])
    if input_dim % 2 != 0:
        raise ValueError("checkerboard ANF topology requires an even feature count")
    bits_per_axis = input_dim // 2
    if bits_per_axis < 3:
        raise ValueError("checkerboard ANF topology requires three grid bits per axis")
    return tuple(
        ANFTerm((variable,))
        for variable in (0, 1, 2, bits_per_axis, bits_per_axis + 1, bits_per_axis + 2)
    )


def _make_digits_split(
    train_samples: int,
    test_samples: int,
    *,
    seed: int,
    label_modulus: int,
) -> tuple[BoolArray, IntArray, BoolArray, IntArray, dict[str, Any]]:
    datasets = importlib.import_module("sklearn.datasets")
    digits = datasets.load_digits()
    data = np.asarray(digits.data, dtype=np.float64) / 16.0
    targets = np.asarray(digits.target, dtype=np.int64) % label_modulus
    bits = data >= 0.5
    rng = np.random.default_rng(seed)
    total = train_samples + test_samples
    if total > bits.shape[0]:
        raise ValueError("requested digit split exceeds sklearn digits size")
    permutation = rng.permutation(bits.shape[0])[:total]
    train_idx = permutation[:train_samples]
    test_idx = permutation[train_samples:]
    return (
        bits[train_idx].astype(np.bool_),
        targets[train_idx].astype(np.int64),
        bits[test_idx].astype(np.bool_),
        targets[test_idx].astype(np.int64),
        {
            "source": "sklearn.datasets.load_digits",
            "feature_transform": "pixel >= 0.5",
            "label_rule": f"digit mod {label_modulus}",
            "is_true_mnist": False,
        },
    )


def _make_multiclass_toy_split(
    n_samples: int,
    *,
    input_bits: int,
    seed: int,
) -> tuple[BoolArray, IntArray]:
    if input_bits < 2:
        raise ValueError("multiclass ECOC toy requires at least two input bits")
    rng = np.random.default_rng(seed)
    labels = np.arange(n_samples, dtype=np.int64) % 4
    labels = labels[rng.permutation(n_samples)]
    x = rng.integers(0, 2, size=(n_samples, input_bits), dtype=np.int8).astype(np.bool_)
    x[:, 0] = labels >= 2
    x[:, 1] = np.mod(labels, 2) == 1
    if input_bits >= 3:
        x[:, 2] = np.logical_xor(x[:, 0], x[:, 1])
    if input_bits >= 4:
        x[:, 3] = np.logical_not(x[:, 0])
    return x, labels


def _make_ecoc_codebook(n_classes: int, n_bits: int, *, seed: int) -> BoolArray:
    try:
        return np.asarray(hadamard_codebook(n_classes, n_bits=n_bits), dtype=np.bool_)
    except ValueError:
        min_distance = max(1, min(n_bits, n_bits // 3))
        return np.asarray(
            dense_balanced_random_codebook(
                n_classes,
                n_bits,
                min_distance=min_distance,
                seed=seed,
                max_retries=4096,
            ),
            dtype=np.bool_,
        )


def _tile_rows(rows: BoolArray, n_samples: int) -> BoolArray:
    repeats = ceil(n_samples / rows.shape[0])
    return np.tile(rows, (repeats, 1))[:n_samples].astype(np.bool_)


def _optional_baselines(dataset: HardSynthesisDataset) -> dict[str, Any]:
    baselines: dict[str, Any] = {}
    if dataset.task_kind == "image_bits":
        baselines["same_feature_logistic_accuracy"] = _sklearn_classifier_accuracy(
            "sklearn.linear_model",
            "LogisticRegression",
            dataset,
            {"max_iter": 500, "random_state": 0},
        )
        baselines["same_feature_mlp_accuracy"] = _sklearn_classifier_accuracy(
            "sklearn.neural_network",
            "MLPClassifier",
            dataset,
            {
                "hidden_layer_sizes": (64,),
                "max_iter": 200,
                "random_state": 0,
                "early_stopping": True,
            },
        )
    return baselines


def _sklearn_classifier_accuracy(
    module_name: str,
    class_name: str,
    dataset: HardSynthesisDataset,
    kwargs: Mapping[str, Any],
) -> float | None:
    try:
        module = importlib.import_module(module_name)
        estimator_type = getattr(module, class_name)
    except (ImportError, AttributeError):
        return None
    estimator = estimator_type(**dict(kwargs))
    estimator.fit(dataset.train_x.astype(np.float64), dataset.train_y)
    return float(estimator.score(dataset.test_x.astype(np.float64), dataset.test_y))


def _nearest_centroid_bits_accuracy(dataset: HardSynthesisDataset) -> float:
    centroids = np.zeros((dataset.num_classes, dataset.train_x.shape[1]), dtype=np.bool_)
    for class_idx in range(dataset.num_classes):
        rows = dataset.train_x[dataset.train_y == class_idx]
        if rows.size == 0:
            continue
        centroids[class_idx] = np.mean(rows, axis=0) >= 0.5
    distances = np.sum(
        np.logical_xor(dataset.test_x[:, None, :], centroids[None, :, :]),
        axis=2,
    )
    predictions = np.argmin(distances, axis=1).astype(np.int64)
    return float(np.mean(predictions == dataset.test_y))


def _best_literal_accuracy(features: BoolArray, labels: IntArray) -> float:
    y = labels.astype(np.bool_)
    scores = [float(np.mean(features[:, idx] == y)) for idx in range(features.shape[1])]
    scores.extend(
        float(np.mean(np.logical_not(features[:, idx]) == y))
        for idx in range(features.shape[1])
    )
    return max(scores) if scores else _majority_accuracy(labels)


def _majority_accuracy(labels: IntArray) -> float:
    if labels.size == 0:
        raise ValueError("cannot score empty labels")
    _, counts = np.unique(labels, return_counts=True)
    return float(np.max(counts) / labels.size)


def _compiled_gate_bytes(gate_count: int) -> int:
    # One uint8 mask and two int32 source ids per binary gate, plus a compact
    # output source id and polarity/readout flag.
    return gate_count * (1 + 4 + 4) + 5


def _effective_smoke_gate_budget(
    config: Mapping[str, Any],
    dataset: HardSynthesisDataset,
    *,
    requested_gate_budget: int,
) -> int:
    if str(config.get("scale", "smoke")) != "smoke":
        return requested_gate_budget
    input_dim = int(dataset.train_x.shape[1])
    if input_dim >= 32:
        return min(requested_gate_budget, 8)
    if input_dim >= 16:
        return min(requested_gate_budget, 12)
    return min(requested_gate_budget, 16)


def _effective_tree_depth(
    config: Mapping[str, Any],
    dataset: HardSynthesisDataset,
    *,
    requested_max_depth: int,
) -> int:
    if str(config.get("scale", "smoke")) == "smoke" and dataset.task_id == "checkerboard":
        return max(requested_max_depth, 6)
    return requested_max_depth


def _witness_valid(witness: Any) -> bool:
    if hasattr(witness, "covered"):
        return bool(witness.covered)
    if hasattr(witness, "valid"):
        return bool(witness.valid)
    raise TypeError("unknown EML witness result")


def _witness_missing_masks(witness: Any) -> tuple[int, ...]:
    missing = getattr(witness, "missing_masks", ())
    return tuple(int(mask) for mask in missing)


def _require_binary_task(dataset: HardSynthesisDataset, method_name: str) -> None:
    if dataset.num_classes != 2:
        raise ValueError(f"{method_name} requires num_classes == 2")


def _task_config(config: Mapping[str, Any]) -> Mapping[str, Any]:
    task = config.get("task")
    if not isinstance(task, Mapping):
        raise ValueError("config must contain a task mapping")
    return cast(Mapping[str, Any], task)


def _synthesis_config(config: Mapping[str, Any]) -> Mapping[str, Any]:
    synthesis = config.get("synthesis")
    if not isinstance(synthesis, Mapping):
        raise ValueError("config must contain a synthesis mapping")
    return cast(Mapping[str, Any], synthesis)


def _positive_int(value: object, name: str) -> int:
    if isinstance(value, bool):
        raise TypeError(f"{name} must be an integer, not bool")
    if isinstance(value, int):
        resolved = value
    elif isinstance(value, str):
        resolved = int(value)
    else:
        raise TypeError(f"{name} must be an integer")
    if resolved <= 0:
        raise ValueError(f"{name} must be positive")
    return resolved


__all__ = [
    "HardSynthesisDataset",
    "make_hard_synthesis_dataset",
    "run_anf_sparse_polynomial",
    "run_ecoc_readout",
    "run_packed_bitset_gate_synthesis",
    "run_tree_bdd_compilation",
]
