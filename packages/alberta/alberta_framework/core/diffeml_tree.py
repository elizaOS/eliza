"""Boolean decision trees compiled to hard DiffEML-compatible circuits.

This module is intentionally separate from the differentiable DiffEML learners.
It provides a pure NumPy hard baseline: fit a greedy Boolean decision tree,
optionally prune redundant leaves, then compile positive tree paths into a
NOT/AND/OR Boolean circuit whose gate masks are witnessed by the existing EML
threshold-template library.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from math import isfinite, log2
from typing import Literal, Self

import numpy as np
from numpy.typing import ArrayLike, NDArray

from alberta_framework.core.diffeml import DiffEMLGateLibrary, eml_threshold_gate_library

Criterion = Literal["information_gain", "entropy", "gini"]
SourceIndexModel = Literal["global_dag"]
HeadMode = Literal["boolean_source"]
Path = tuple[tuple[int, bool], ...]

MASK_NOT_A = 3
MASK_AND = 8
MASK_OR = 14
NOT_AND_OR_MASKS = frozenset({MASK_NOT_A, MASK_AND, MASK_OR})


@dataclass(frozen=True)
class BooleanDecisionTreeNode:
    """One node in a binary decision tree over Boolean features.

    Internal nodes test ``x[feature_index]`` and send false values to
    ``false_child`` and true values to ``true_child``. Leaves store the majority
    prediction at that node.
    """

    prediction: bool
    n_samples: int
    positives: int
    impurity: float
    depth: int
    feature_index: int | None = None
    false_child: BooleanDecisionTreeNode | None = None
    true_child: BooleanDecisionTreeNode | None = None
    gain: float = 0.0

    def __post_init__(self) -> None:
        """Validate local tree-node metadata."""
        if self.n_samples < 0:
            raise ValueError("n_samples must be nonnegative")
        if self.positives < 0 or self.positives > self.n_samples:
            raise ValueError("positives must be in [0, n_samples]")
        if self.depth < 0:
            raise ValueError("depth must be nonnegative")
        has_children = self.false_child is not None or self.true_child is not None
        if self.feature_index is None and has_children:
            raise ValueError("internal nodes require feature_index")
        if self.feature_index is not None:
            if self.feature_index < 0:
                raise ValueError("feature_index must be nonnegative")
            if self.false_child is None or self.true_child is None:
                raise ValueError("internal nodes require both children")
        if self.impurity < -1e-12:
            raise ValueError("impurity must be nonnegative")
        if not isfinite(self.gain):
            raise ValueError("gain must be finite")

    @property
    def is_leaf(self) -> bool:
        """Whether this node is a leaf."""
        return self.feature_index is None

    @property
    def n_leaves(self) -> int:
        """Number of leaves in this subtree."""
        if self.is_leaf:
            return 1
        false_child, true_child = self._children()
        return false_child.n_leaves + true_child.n_leaves

    @property
    def n_internal_nodes(self) -> int:
        """Number of internal split nodes in this subtree."""
        if self.is_leaf:
            return 0
        false_child, true_child = self._children()
        return 1 + false_child.n_internal_nodes + true_child.n_internal_nodes

    def predict_one(self, features: Sequence[bool]) -> bool:
        """Predict one Boolean label from one Boolean feature vector."""
        if self.is_leaf:
            return self.prediction
        if self.feature_index is None:
            raise ValueError("internal node missing feature_index")
        false_child, true_child = self._children()
        if features[self.feature_index]:
            return true_child.predict_one(features)
        return false_child.predict_one(features)

    def prune_redundant_leaves(self) -> BooleanDecisionTreeNode:
        """Collapse internal nodes whose children are redundant leaves."""
        if self.is_leaf:
            return self
        false_child, true_child = self._children()
        pruned_false = false_child.prune_redundant_leaves()
        pruned_true = true_child.prune_redundant_leaves()
        if (
            pruned_false.is_leaf
            and pruned_true.is_leaf
            and pruned_false.prediction == pruned_true.prediction
        ):
            return BooleanDecisionTreeNode(
                prediction=pruned_false.prediction,
                n_samples=self.n_samples,
                positives=self.positives,
                impurity=self.impurity,
                depth=self.depth,
            )
        if pruned_false == pruned_true:
            return pruned_false
        return BooleanDecisionTreeNode(
            prediction=self.prediction,
            n_samples=self.n_samples,
            positives=self.positives,
            impurity=self.impurity,
            depth=self.depth,
            feature_index=self.feature_index,
            false_child=pruned_false,
            true_child=pruned_true,
            gain=self.gain,
        )

    def iter_leaf_paths(self, path: Path = ()) -> Iterable[tuple[Path, bool]]:
        """Yield ``(path, prediction)`` pairs for every leaf in this subtree."""
        if self.is_leaf:
            yield path, self.prediction
            return
        if self.feature_index is None:
            raise ValueError("internal node missing feature_index")
        false_child, true_child = self._children()
        yield from false_child.iter_leaf_paths(path + ((self.feature_index, False),))
        yield from true_child.iter_leaf_paths(path + ((self.feature_index, True),))

    def to_config(self) -> dict[str, object]:
        """Return a JSON-serializable tree-node config."""
        if self.is_leaf:
            return {
                "prediction": self.prediction,
                "n_samples": self.n_samples,
                "positives": self.positives,
                "impurity": self.impurity,
                "depth": self.depth,
                "leaf": True,
            }
        false_child, true_child = self._children()
        return {
            "prediction": self.prediction,
            "n_samples": self.n_samples,
            "positives": self.positives,
            "impurity": self.impurity,
            "depth": self.depth,
            "leaf": False,
            "feature_index": self.feature_index,
            "gain": self.gain,
            "false_child": false_child.to_config(),
            "true_child": true_child.to_config(),
        }

    def _children(self) -> tuple[BooleanDecisionTreeNode, BooleanDecisionTreeNode]:
        if self.false_child is None or self.true_child is None:
            raise ValueError("internal node requires both children")
        return self.false_child, self.true_child


@dataclass(frozen=True)
class EMLWitnessValidation:
    """Validation result for circuit masks against an EML gate library."""

    valid: bool
    required_masks: tuple[int, ...]
    available_masks: tuple[int, ...]
    missing_masks: tuple[int, ...]
    gate_expressions: tuple[str, ...]

    def to_config(self) -> dict[str, object]:
        """Return a JSON-serializable validation record."""
        return {
            "valid": self.valid,
            "required_masks": list(self.required_masks),
            "available_masks": list(self.available_masks),
            "missing_masks": list(self.missing_masks),
            "gate_expressions": list(self.gate_expressions),
        }


@dataclass(frozen=True)
class BooleanCircuit:
    """A Boolean circuit with global-DAG source indices.

    Source namespace:
    ``0..input_dim-1`` are raw input bits, ``input_dim`` is the constant true
    source, and gate ``i`` writes source ``input_dim + 1 + i``.
    """

    input_dim: int
    left_sources: tuple[int, ...]
    right_sources: tuple[int, ...]
    masks: tuple[int, ...]
    output_source: int
    gate_names: tuple[str, ...]
    eml_expressions: tuple[str, ...]
    source_index_model: SourceIndexModel = "global_dag"
    head_mode: HeadMode = "boolean_source"

    def __post_init__(self) -> None:
        """Validate circuit arity, masks, and source references."""
        if self.input_dim <= 0:
            raise ValueError("input_dim must be positive")
        n_gates = len(self.masks)
        if len(self.left_sources) != n_gates or len(self.right_sources) != n_gates:
            raise ValueError("left_sources, right_sources, and masks must have same length")
        if len(self.gate_names) != n_gates or len(self.eml_expressions) != n_gates:
            raise ValueError("gate metadata length must match masks")
        for gate_idx, (left, right, mask) in enumerate(
            zip(self.left_sources, self.right_sources, self.masks, strict=True)
        ):
            source_limit = self.input_dim + 1 + gate_idx
            if left < 0 or right < 0 or left >= source_limit or right >= source_limit:
                raise ValueError("gate source indices must reference inputs or earlier gates")
            if mask not in NOT_AND_OR_MASKS:
                raise ValueError("Boolean tree export only supports NOT/AND/OR masks")
        if self.output_source < 0 or self.output_source >= self.input_dim + 1 + n_gates:
            raise ValueError("output_source is outside the circuit source namespace")

    @property
    def n_gates(self) -> int:
        """Number of Boolean gates in this circuit."""
        return len(self.masks)

    @property
    def const_true_source(self) -> int:
        """Source index for the Boolean constant true."""
        return self.input_dim

    @property
    def has_float_head(self) -> bool:
        """Whether this hard circuit uses a learned float readout head."""
        return False

    @property
    def source_indices(self) -> NDArray[np.int64]:
        """Return source pairs as an ``(n_gates, 2)`` integer array."""
        if self.n_gates == 0:
            return np.empty((0, 2), dtype=np.int64)
        return np.column_stack(
            (
                np.asarray(self.left_sources, dtype=np.int64),
                np.asarray(self.right_sources, dtype=np.int64),
            )
        )

    @property
    def gate_masks(self) -> NDArray[np.int64]:
        """Return gate masks as an integer array."""
        return np.asarray(self.masks, dtype=np.int64)

    def predict(self, features: ArrayLike) -> NDArray[np.bool_]:
        """Evaluate the hard Boolean circuit on a Boolean feature matrix."""
        return evaluate_boolean_circuit(self, features)

    def evaluate(self, features: ArrayLike) -> NDArray[np.bool_]:
        """Evaluate the hard Boolean circuit on a Boolean feature matrix."""
        return self.predict(features)

    def validate_eml_witnesses(
        self,
        library: DiffEMLGateLibrary | None = None,
    ) -> EMLWitnessValidation:
        """Validate that every gate mask has an EML-threshold witness."""
        return validate_eml_witnesses(self, library=library)

    def to_config(self) -> dict[str, object]:
        """Return JSON-serializable hard-circuit metadata."""
        return {
            "input_dim": self.input_dim,
            "left_sources": list(self.left_sources),
            "right_sources": list(self.right_sources),
            "source_indices": self.source_indices.tolist(),
            "masks": list(self.masks),
            "output_source": self.output_source,
            "gate_names": list(self.gate_names),
            "eml_expressions": list(self.eml_expressions),
            "source_index_model": self.source_index_model,
            "head_mode": self.head_mode,
            "has_float_head": self.has_float_head,
        }


@dataclass(frozen=True)
class _SplitCandidate:
    feature_index: int
    gain: float
    false_indices: NDArray[np.int64]
    true_indices: NDArray[np.int64]


class BooleanDecisionTree:
    """Deterministic greedy decision tree over Boolean feature matrices.

    Splits are selected by maximum information gain or Gini reduction, with
    feature-index tie breaking. Zero-gain splits are allowed by default so that
    parity-like functions such as XOR can be represented when depth permits.
    Set ``min_gain`` to a positive value to disable that behavior.
    """

    def __init__(
        self,
        *,
        max_depth: int = 3,
        max_leaves: int | None = None,
        criterion: Criterion = "information_gain",
        min_samples_split: int = 2,
        min_gain: float = 0.0,
    ) -> None:
        """Initialize a Boolean decision-tree learner."""
        if max_depth < 0:
            raise ValueError("max_depth must be nonnegative")
        if max_leaves is not None and max_leaves < 1:
            raise ValueError("max_leaves must be at least 1")
        if criterion not in {"information_gain", "entropy", "gini"}:
            raise ValueError("criterion must be 'information_gain', 'entropy', or 'gini'")
        if min_samples_split < 2:
            raise ValueError("min_samples_split must be at least 2")
        if not isfinite(min_gain) or min_gain < 0.0:
            raise ValueError("min_gain must be finite and nonnegative")
        self.max_depth = max_depth
        self.max_leaves = max_leaves
        self.criterion = criterion
        self.min_samples_split = min_samples_split
        self.min_gain = min_gain
        self.root_: BooleanDecisionTreeNode | None = None
        self.input_dim_: int | None = None
        self._leaf_count = 0

    @property
    def root(self) -> BooleanDecisionTreeNode:
        """Fitted root node."""
        if self.root_ is None:
            raise ValueError("tree has not been fit")
        return self.root_

    @property
    def input_dim(self) -> int:
        """Number of Boolean input features."""
        if self.input_dim_ is None:
            raise ValueError("tree has not been fit")
        return self.input_dim_

    @property
    def n_leaves(self) -> int:
        """Number of leaves in the fitted tree."""
        return self.root.n_leaves

    @property
    def n_internal_nodes(self) -> int:
        """Number of internal split nodes in the fitted tree."""
        return self.root.n_internal_nodes

    def fit(self, features: ArrayLike, labels: ArrayLike) -> Self:
        """Fit the greedy Boolean decision tree."""
        x = _as_boolean_matrix(features)
        y = _as_boolean_vector(labels, expected_length=x.shape[0])
        if x.shape[0] == 0:
            raise ValueError("cannot fit an empty dataset")
        self.input_dim_ = int(x.shape[1])
        self._leaf_count = 1
        indices = np.arange(x.shape[0], dtype=np.int64)
        self.root_ = self._build_node(x, y, indices, depth=0)
        return self

    def predict(self, features: ArrayLike) -> NDArray[np.bool_]:
        """Predict Boolean labels for a Boolean feature matrix."""
        x = _as_boolean_matrix(features)
        if x.shape[1] != self.input_dim:
            raise ValueError("feature dimension does not match fitted tree")
        predictions = [self.root.predict_one(row.tolist()) for row in x]
        return np.asarray(predictions, dtype=np.bool_)

    def predict_int(self, features: ArrayLike) -> NDArray[np.int64]:
        """Predict labels as ``0``/``1`` integers."""
        return self.predict(features).astype(np.int64)

    def score(self, features: ArrayLike, labels: ArrayLike) -> float:
        """Return hard classification accuracy."""
        y = _as_boolean_vector(labels)
        predictions = self.predict(features)
        if predictions.shape != y.shape:
            raise ValueError("labels length does not match predictions")
        return float(np.mean(predictions == y))

    def prune(self) -> Self:
        """Prune redundant leaves in place and return ``self``."""
        self.root_ = self.root.prune_redundant_leaves()
        return self

    def compressed(self) -> BooleanDecisionTree:
        """Return a copy with redundant leaves pruned."""
        tree = BooleanDecisionTree(
            max_depth=self.max_depth,
            max_leaves=self.max_leaves,
            criterion=self.criterion,
            min_samples_split=self.min_samples_split,
            min_gain=self.min_gain,
        )
        tree.input_dim_ = self.input_dim
        tree.root_ = self.root.prune_redundant_leaves()
        tree._leaf_count = tree.root_.n_leaves
        return tree

    def compress(self) -> BooleanDecisionTree:
        """Return a copy with redundant leaves pruned."""
        return self.compressed()

    def export_circuit(
        self,
        *,
        prune: bool = True,
        library: DiffEMLGateLibrary | None = None,
        validate_witnesses: bool = True,
    ) -> BooleanCircuit:
        """Compile the fitted tree into a hard NOT/AND/OR Boolean circuit."""
        return export_tree_to_boolean_circuit(
            self,
            prune=prune,
            library=library,
            validate_witnesses=validate_witnesses,
        )

    def to_boolean_circuit(
        self,
        *,
        prune: bool = True,
        library: DiffEMLGateLibrary | None = None,
        validate_witnesses: bool = True,
    ) -> BooleanCircuit:
        """Compile the fitted tree into a hard NOT/AND/OR Boolean circuit."""
        return self.export_circuit(
            prune=prune,
            library=library,
            validate_witnesses=validate_witnesses,
        )

    def to_config(self) -> dict[str, object]:
        """Return a JSON-serializable fitted-tree config."""
        return {
            "max_depth": self.max_depth,
            "max_leaves": self.max_leaves,
            "criterion": self.criterion,
            "min_samples_split": self.min_samples_split,
            "min_gain": self.min_gain,
            "input_dim": self.input_dim_,
            "root": None if self.root_ is None else self.root_.to_config(),
        }

    def _build_node(
        self,
        x: NDArray[np.bool_],
        y: NDArray[np.bool_],
        indices: NDArray[np.int64],
        *,
        depth: int,
    ) -> BooleanDecisionTreeNode:
        labels = y[indices]
        positives = int(np.count_nonzero(labels))
        prediction = _majority_label(labels)
        impurity = _impurity(labels, self.criterion)
        leaf = BooleanDecisionTreeNode(
            prediction=prediction,
            n_samples=int(indices.size),
            positives=positives,
            impurity=impurity,
            depth=depth,
        )
        if self._should_stop(labels, depth):
            return leaf

        split = _best_split(x, y, indices, self.criterion)
        if split is None or split.gain + 1e-12 < self.min_gain:
            return leaf
        if self.max_leaves is not None and self._leaf_count >= self.max_leaves:
            return leaf

        self._leaf_count += 1
        false_child = self._build_node(x, y, split.false_indices, depth=depth + 1)
        true_child = self._build_node(x, y, split.true_indices, depth=depth + 1)
        return BooleanDecisionTreeNode(
            prediction=prediction,
            n_samples=int(indices.size),
            positives=positives,
            impurity=impurity,
            depth=depth,
            feature_index=split.feature_index,
            false_child=false_child,
            true_child=true_child,
            gain=split.gain,
        )

    def _should_stop(self, labels: NDArray[np.bool_], depth: int) -> bool:
        if depth >= self.max_depth:
            return True
        if labels.size < self.min_samples_split:
            return True
        if np.all(labels == labels[0]):
            return True
        return False


BooleanDecisionTreeClassifier = BooleanDecisionTree


def fit_boolean_decision_tree(
    features: ArrayLike,
    labels: ArrayLike,
    *,
    max_depth: int = 3,
    max_leaves: int | None = None,
    criterion: Criterion = "information_gain",
    min_samples_split: int = 2,
    min_gain: float = 0.0,
) -> BooleanDecisionTree:
    """Fit and return a :class:`BooleanDecisionTree`."""
    return BooleanDecisionTree(
        max_depth=max_depth,
        max_leaves=max_leaves,
        criterion=criterion,
        min_samples_split=min_samples_split,
        min_gain=min_gain,
    ).fit(features, labels)


def prune_redundant_leaves(
    tree_or_node: BooleanDecisionTree | BooleanDecisionTreeNode,
) -> BooleanDecisionTree | BooleanDecisionTreeNode:
    """Prune redundant leaves from a tree or node."""
    if isinstance(tree_or_node, BooleanDecisionTree):
        return tree_or_node.compressed()
    return tree_or_node.prune_redundant_leaves()


def export_tree_to_boolean_circuit(
    tree_or_node: BooleanDecisionTree | BooleanDecisionTreeNode,
    *,
    input_dim: int | None = None,
    prune: bool = True,
    library: DiffEMLGateLibrary | None = None,
    validate_witnesses: bool = True,
) -> BooleanCircuit:
    """Compile a Boolean decision tree into a NOT/AND/OR hard circuit.

    The circuit implements an OR-of-ANDs over all positive leaves. Each positive
    leaf contributes one conjunction of the literals on the path from root to
    leaf. Negative leaves do not contribute terms.
    """
    if isinstance(tree_or_node, BooleanDecisionTree):
        root = tree_or_node.root
        resolved_input_dim = tree_or_node.input_dim
    else:
        if input_dim is None:
            raise ValueError("input_dim is required when exporting a bare node")
        root = tree_or_node
        resolved_input_dim = input_dim
    if prune:
        root = root.prune_redundant_leaves()

    resolved_library = library if library is not None else eml_threshold_gate_library()
    builder = _CircuitBuilder(resolved_input_dim, resolved_library)
    positive_paths = [path for path, prediction in root.iter_leaf_paths() if prediction]

    if not positive_paths:
        output_source = builder.false_source()
    elif any(len(path) == 0 for path in positive_paths):
        output_source = builder.const_true_source
    else:
        term_sources = [builder.path_term(path) for path in positive_paths]
        output_source = builder.or_sources(term_sources)

    circuit = builder.build(output_source)
    if validate_witnesses:
        validation = circuit.validate_eml_witnesses(resolved_library)
        if not validation.valid:
            raise ValueError(f"missing EML witnesses for masks {validation.missing_masks}")
    return circuit


compile_tree_to_boolean_circuit = export_tree_to_boolean_circuit


def evaluate_boolean_circuit(
    circuit: BooleanCircuit,
    features: ArrayLike,
) -> NDArray[np.bool_]:
    """Evaluate a global-DAG Boolean circuit on Boolean input rows."""
    x = _as_boolean_matrix(features)
    if x.shape[1] != circuit.input_dim:
        raise ValueError("feature dimension does not match circuit")

    sources = np.zeros((x.shape[0], circuit.input_dim + 1 + circuit.n_gates), dtype=np.bool_)
    sources[:, : circuit.input_dim] = x
    sources[:, circuit.const_true_source] = True
    for gate_idx, (left, right, mask) in enumerate(
        zip(circuit.left_sources, circuit.right_sources, circuit.masks, strict=True)
    ):
        left_bits = sources[:, left].astype(np.int64)
        right_bits = sources[:, right].astype(np.int64)
        row_indices = 2 * left_bits + right_bits
        gate_output = ((mask >> row_indices) & 1).astype(np.bool_)
        sources[:, circuit.input_dim + 1 + gate_idx] = gate_output
    return sources[:, circuit.output_source].copy()


def validate_eml_witnesses(
    circuit: BooleanCircuit,
    library: DiffEMLGateLibrary | None = None,
) -> EMLWitnessValidation:
    """Check that all circuit masks are present in an EML gate library."""
    resolved_library = library if library is not None else eml_threshold_gate_library()
    expression_by_mask = {
        int(mask): expression
        for mask, expression in zip(
            resolved_library.masks,
            resolved_library.expressions,
            strict=True,
        )
    }
    required_masks = tuple(sorted(set(circuit.masks)))
    missing_masks = tuple(mask for mask in required_masks if mask not in expression_by_mask)
    gate_expressions = tuple(expression_by_mask.get(mask, "") for mask in circuit.masks)
    return EMLWitnessValidation(
        valid=not missing_masks,
        required_masks=required_masks,
        available_masks=tuple(int(mask) for mask in resolved_library.masks),
        missing_masks=missing_masks,
        gate_expressions=gate_expressions,
    )


def bitize_thresholds(values: ArrayLike, thresholds: ArrayLike) -> NDArray[np.bool_]:
    """Convert real-valued features to Boolean threshold bits.

    For a scalar threshold, the output has the same shape as the input. For a
    one-dimensional threshold list, every input feature is compared with every
    threshold and the trailing feature/threshold axes are flattened.
    """
    value_array = np.asarray(values, dtype=np.float64)
    if value_array.ndim == 1:
        value_array = value_array.reshape(-1, 1)
    if value_array.ndim != 2:
        raise ValueError("values must be a 1D or 2D array")

    threshold_array = np.asarray(thresholds, dtype=np.float64)
    if threshold_array.ndim == 0:
        return (value_array >= float(threshold_array)).astype(np.bool_)
    if threshold_array.ndim == 1:
        bits = value_array[:, :, None] >= threshold_array[None, None, :]
        return bits.reshape(value_array.shape[0], -1).astype(np.bool_)
    if threshold_array.ndim == 2:
        if threshold_array.shape[0] != value_array.shape[1]:
            raise ValueError("2D thresholds must have one row per input feature")
        bits_by_feature = [
            value_array[:, feature_idx, None] >= threshold_array[feature_idx][None, :]
            for feature_idx in range(value_array.shape[1])
        ]
        return np.concatenate(bits_by_feature, axis=1).astype(np.bool_)
    raise ValueError("thresholds must be scalar, 1D, or 2D")


threshold_bits = bitize_thresholds


class _CircuitBuilder:
    def __init__(self, input_dim: int, library: DiffEMLGateLibrary) -> None:
        if input_dim <= 0:
            raise ValueError("input_dim must be positive")
        self.input_dim = input_dim
        self.const_true_source = input_dim
        self._expression_by_mask = {
            int(mask): expression
            for mask, expression in zip(library.masks, library.expressions, strict=True)
        }
        missing_masks = tuple(
            mask for mask in NOT_AND_OR_MASKS if mask not in self._expression_by_mask
        )
        if missing_masks:
            raise ValueError(f"EML library is missing NOT/AND/OR masks {missing_masks}")
        self._left_sources: list[int] = []
        self._right_sources: list[int] = []
        self._masks: list[int] = []
        self._gate_names: list[str] = []
        self._eml_expressions: list[str] = []
        self._not_cache: dict[int, int] = {}
        self._false_source: int | None = None

    def build(self, output_source: int) -> BooleanCircuit:
        return BooleanCircuit(
            input_dim=self.input_dim,
            left_sources=tuple(self._left_sources),
            right_sources=tuple(self._right_sources),
            masks=tuple(self._masks),
            output_source=output_source,
            gate_names=tuple(self._gate_names),
            eml_expressions=tuple(self._eml_expressions),
        )

    def false_source(self) -> int:
        if self._false_source is None:
            self._false_source = self.not_source(self.const_true_source)
        return self._false_source

    def not_source(self, source: int) -> int:
        if source in self._not_cache:
            return self._not_cache[source]
        output = self._add_gate(MASK_NOT_A, source, self.const_true_source, "NOT")
        self._not_cache[source] = output
        return output

    def and_sources(self, sources: Sequence[int]) -> int:
        active_sources = [source for source in sources if source != self.const_true_source]
        if not active_sources:
            return self.const_true_source
        output = active_sources[0]
        for source in active_sources[1:]:
            output = self._add_gate(MASK_AND, output, source, "AND")
        return output

    def or_sources(self, sources: Sequence[int]) -> int:
        if not sources:
            return self.false_source()
        output = sources[0]
        for source in sources[1:]:
            output = self._add_gate(MASK_OR, output, source, "OR")
        return output

    def path_term(self, path: Path) -> int:
        literals = [
            feature_idx if branch_value else self.not_source(feature_idx)
            for feature_idx, branch_value in path
        ]
        return self.and_sources(literals)

    def _add_gate(self, mask: int, left: int, right: int, name: str) -> int:
        source_limit = self.input_dim + 1 + len(self._masks)
        if left < 0 or right < 0 or left >= source_limit or right >= source_limit:
            raise ValueError("gate source indices must reference inputs or earlier gates")
        if mask not in NOT_AND_OR_MASKS:
            raise ValueError("Boolean tree compiler only emits NOT/AND/OR gates")
        self._left_sources.append(left)
        self._right_sources.append(right)
        self._masks.append(mask)
        self._gate_names.append(name)
        self._eml_expressions.append(self._expression_by_mask[mask])
        return self.input_dim + 1 + len(self._masks) - 1


def _as_boolean_matrix(features: ArrayLike) -> NDArray[np.bool_]:
    array = np.asarray(features)
    if array.ndim == 1:
        array = array.reshape(1, -1)
    if array.ndim != 2:
        raise ValueError("features must be a 1D or 2D array")
    if array.shape[1] == 0:
        raise ValueError("features must contain at least one column")
    if not np.all((array == 0) | (array == 1)):
        raise ValueError("features must be Boolean or 0/1 valued")
    return array.astype(np.bool_, copy=False)


def _as_boolean_vector(
    labels: ArrayLike,
    *,
    expected_length: int | None = None,
) -> NDArray[np.bool_]:
    array = np.asarray(labels)
    if array.ndim == 2 and 1 in array.shape:
        array = array.reshape(-1)
    if array.ndim != 1:
        raise ValueError("labels must be a 1D array")
    if expected_length is not None and array.shape[0] != expected_length:
        raise ValueError("labels length must match features")
    if not np.all((array == 0) | (array == 1)):
        raise ValueError("labels must be Boolean or 0/1 valued")
    return array.astype(np.bool_, copy=False)


def _majority_label(labels: NDArray[np.bool_]) -> bool:
    positives = int(np.count_nonzero(labels))
    return positives * 2 >= int(labels.size)


def _impurity(labels: NDArray[np.bool_], criterion: Criterion) -> float:
    if labels.size == 0:
        return 0.0
    p_true = float(np.mean(labels))
    if criterion == "gini":
        return 2.0 * p_true * (1.0 - p_true)
    if p_true <= 0.0 or p_true >= 1.0:
        return 0.0
    return -(p_true * log2(p_true) + (1.0 - p_true) * log2(1.0 - p_true))


def _best_split(
    x: NDArray[np.bool_],
    y: NDArray[np.bool_],
    indices: NDArray[np.int64],
    criterion: Criterion,
) -> _SplitCandidate | None:
    parent_impurity = _impurity(y[indices], criterion)
    best: _SplitCandidate | None = None
    n_samples = float(indices.size)
    for feature_idx in range(x.shape[1]):
        feature_values = x[indices, feature_idx]
        false_indices = indices[~feature_values]
        true_indices = indices[feature_values]
        if false_indices.size == 0 or true_indices.size == 0:
            continue
        false_weight = false_indices.size / n_samples
        true_weight = true_indices.size / n_samples
        gain = parent_impurity - (
            false_weight * _impurity(y[false_indices], criterion)
            + true_weight * _impurity(y[true_indices], criterion)
        )
        if best is None or gain > best.gain + 1e-12:
            best = _SplitCandidate(
                feature_index=feature_idx,
                gain=max(0.0, float(gain)),
                false_indices=false_indices,
                true_indices=true_indices,
            )
    return best
