"""Hard-circuit pruning and compaction utilities for DiffEML.

This module works on hardened two-input Boolean circuits, independent of the
relaxed training path.  It treats a DiffEML model as an EML-derived Boolean DAG:
each gate has two source indices and one four-bit truth-table mask.  The pass
detects gates that are constant, exact aliases, exact structural duplicates, or
not reachable from the deployed readout, then returns compact metadata for the
remaining hard circuit.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from math import isfinite
from numbers import Real
from typing import Literal

type HeadMode = Literal["linear", "group_sum", "class_vote", "signed_class_vote"]
type SourceKind = Literal["input", "const", "gate"]
type PruningReason = Literal["kept", "constant", "identity", "duplicate"]
type ExpressionKey = tuple[object, ...]
type HeadWeights = Sequence[Real] | Sequence[Sequence[Real]]


@dataclass(frozen=True)
class GateRef:
    """Reference to an original or compacted gate position."""

    layer: int
    index: int

    def __post_init__(self) -> None:
        """Validate gate coordinates."""
        if self.layer < 0:
            raise ValueError("gate layer must be nonnegative")
        if self.index < 0:
            raise ValueError("gate index must be nonnegative")

    def to_config(self) -> dict[str, int]:
        """Return a JSON-serializable gate reference."""
        return {"layer": self.layer, "index": self.index}


@dataclass(frozen=True)
class SourceRef:
    """Reference to an input, Boolean constant, or gate output."""

    kind: SourceKind
    index: int
    layer: int = -1

    def __post_init__(self) -> None:
        """Validate source coordinates."""
        if self.kind == "input":
            if self.layer != -1 or self.index < 0:
                raise ValueError("input sources use layer=-1 and nonnegative index")
        elif self.kind == "const":
            if self.layer != -1 or self.index not in {0, 1}:
                raise ValueError("const sources use layer=-1 and index 0 or 1")
        elif self.kind == "gate":
            if self.layer < 0 or self.index < 0:
                raise ValueError("gate sources require nonnegative layer and index")
        else:
            raise ValueError(f"unsupported source kind: {self.kind}")

    @classmethod
    def input(cls, index: int) -> SourceRef:
        """Create an input-feature source."""
        return cls(kind="input", index=index)

    @classmethod
    def const(cls, value: bool | int) -> SourceRef:
        """Create a Boolean constant source."""
        return cls(kind="const", index=int(bool(value)))

    @classmethod
    def gate(cls, layer: int, index: int) -> SourceRef:
        """Create a gate-output source."""
        return cls(kind="gate", layer=layer, index=index)

    @property
    def gate_ref(self) -> GateRef:
        """Return this source as a gate reference."""
        if self.kind != "gate":
            raise ValueError("source is not a gate")
        return GateRef(layer=self.layer, index=self.index)

    def to_config(self) -> dict[str, int | str]:
        """Return a JSON-serializable source reference."""
        return {"kind": self.kind, "layer": self.layer, "index": self.index}


@dataclass(frozen=True)
class HardGateLayer:
    """One hardened binary-gate layer.

    Source indices follow the current DiffEML packed-runner convention for each
    layer: ``0..input_dim-1`` are raw input bits, ``input_dim`` is constant
    true, and larger indices reference the previous layer's outputs.
    """

    left: tuple[int, ...]
    right: tuple[int, ...]
    masks: tuple[int, ...]
    name: str = ""

    def __post_init__(self) -> None:
        """Validate layer arity and masks."""
        if len(self.left) != len(self.right) or len(self.left) != len(self.masks):
            raise ValueError("left, right, and masks must have the same length")
        for source in (*self.left, *self.right):
            if source < 0:
                raise ValueError("source indices must be nonnegative")
        for mask in self.masks:
            if mask < 0 or mask > 15:
                raise ValueError("gate masks must be four-bit Boolean masks in [0, 15]")

    @classmethod
    def from_iterables(
        cls,
        left: Iterable[int],
        right: Iterable[int],
        masks: Iterable[int],
        *,
        name: str = "",
    ) -> HardGateLayer:
        """Build a hard layer from array-like iterables."""
        return cls(
            left=tuple(int(value) for value in left),
            right=tuple(int(value) for value in right),
            masks=tuple(int(value) for value in masks),
            name=name,
        )

    @property
    def width(self) -> int:
        """Number of gate outputs in this layer."""
        return len(self.masks)

    def to_config(self) -> dict[str, object]:
        """Return a JSON-serializable layer record."""
        return {
            "name": self.name,
            "left": list(self.left),
            "right": list(self.right),
            "masks": list(self.masks),
        }


@dataclass(frozen=True)
class DuplicateGate:
    """Gate whose exact Boolean expression already exists elsewhere."""

    gate: GateRef
    canonical_source: SourceRef

    def to_config(self) -> dict[str, object]:
        """Return a JSON-serializable duplicate record."""
        return {
            "gate": self.gate.to_config(),
            "canonical_source": self.canonical_source.to_config(),
        }


@dataclass(frozen=True)
class AliasGate:
    """Gate that collapses exactly to a source or Boolean constant."""

    gate: GateRef
    source: SourceRef
    reason: Literal["constant", "identity"]

    def to_config(self) -> dict[str, object]:
        """Return a JSON-serializable alias record."""
        return {
            "gate": self.gate.to_config(),
            "source": self.source.to_config(),
            "reason": self.reason,
        }


@dataclass(frozen=True)
class CompactedGateLayer:
    """One layer of the compacted global-DAG circuit metadata."""

    original_layer: int
    original_indices: tuple[int, ...]
    left_sources: tuple[SourceRef, ...]
    right_sources: tuple[SourceRef, ...]
    masks: tuple[int, ...]
    name: str = ""

    def __post_init__(self) -> None:
        """Validate compacted layer arity."""
        width = len(self.masks)
        if (
            len(self.original_indices) != width
            or len(self.left_sources) != width
            or len(self.right_sources) != width
        ):
            raise ValueError("compacted layer fields must have the same length")
        if self.original_layer < 0:
            raise ValueError("original_layer must be nonnegative")

    @property
    def width(self) -> int:
        """Number of retained gates in this compacted layer."""
        return len(self.masks)

    def to_config(self) -> dict[str, object]:
        """Return a JSON-serializable compacted-layer record."""
        return {
            "name": self.name,
            "original_layer": self.original_layer,
            "original_indices": list(self.original_indices),
            "left_sources": [source.to_config() for source in self.left_sources],
            "right_sources": [source.to_config() for source in self.right_sources],
            "masks": list(self.masks),
        }


@dataclass(frozen=True)
class CircuitPruningStats:
    """Summary counts for a hard-circuit compaction pass."""

    original_gates: int
    compacted_gates: int
    constant_gates: int
    identity_alias_gates: int
    duplicate_gates: int
    unused_unique_gates: int
    unused_readout_features: int
    pruned_gates: int
    gate_compression_ratio: float

    def to_config(self) -> dict[str, float | int]:
        """Return a JSON-serializable stats record."""
        return {
            "original_gates": self.original_gates,
            "compacted_gates": self.compacted_gates,
            "constant_gates": self.constant_gates,
            "identity_alias_gates": self.identity_alias_gates,
            "duplicate_gates": self.duplicate_gates,
            "unused_unique_gates": self.unused_unique_gates,
            "unused_readout_features": self.unused_readout_features,
            "pruned_gates": self.pruned_gates,
            "gate_compression_ratio": self.gate_compression_ratio,
        }


@dataclass(frozen=True)
class CircuitCompactionResult:
    """Hard-circuit pruning result and compacted global-DAG metadata."""

    input_dim: int
    original_layer_widths: tuple[int, ...]
    compacted_layers: tuple[CompactedGateLayer, ...]
    final_feature_sources: tuple[SourceRef | None, ...]
    readout_used_features: tuple[int, ...]
    readout_used_sources: tuple[SourceRef, ...]
    constant_gates: tuple[AliasGate, ...]
    identity_alias_gates: tuple[AliasGate, ...]
    duplicate_gates: tuple[DuplicateGate, ...]
    unused_readout_features: tuple[int, ...]
    unused_unique_gates: tuple[GateRef, ...]
    kept_gates: tuple[GateRef, ...]
    original_to_compact_source: tuple[tuple[GateRef, SourceRef], ...]
    stats: CircuitPruningStats

    def to_config(self) -> dict[str, object]:
        """Return JSON-serializable compaction metadata."""
        return {
            "input_dim": self.input_dim,
            "original_layer_widths": list(self.original_layer_widths),
            "compacted_layers": [layer.to_config() for layer in self.compacted_layers],
            "final_feature_sources": [
                None if source is None else source.to_config()
                for source in self.final_feature_sources
            ],
            "readout_used_features": list(self.readout_used_features),
            "readout_used_sources": [source.to_config() for source in self.readout_used_sources],
            "constant_gates": [gate.to_config() for gate in self.constant_gates],
            "identity_alias_gates": [gate.to_config() for gate in self.identity_alias_gates],
            "duplicate_gates": [gate.to_config() for gate in self.duplicate_gates],
            "unused_readout_features": list(self.unused_readout_features),
            "unused_unique_gates": [gate.to_config() for gate in self.unused_unique_gates],
            "kept_gates": [gate.to_config() for gate in self.kept_gates],
            "original_to_compact_source": [
                {
                    "original": original.to_config(),
                    "compact_source": compact.to_config(),
                }
                for original, compact in self.original_to_compact_source
            ],
            "stats": self.stats.to_config(),
            "source_index_model": "global_dag",
        }


@dataclass(frozen=True)
class _SimplifiedGate:
    expression_key: ExpressionKey
    alias_source: SourceRef | None
    reason: Literal["constant", "identity"] | None


@dataclass(frozen=True)
class _GateInfo:
    gate: GateRef
    mask: int
    left_source: SourceRef
    right_source: SourceRef
    output_source: SourceRef
    expression_key: ExpressionKey
    reason: PruningReason


def used_readout_features(
    *,
    final_width: int,
    head_mode: HeadMode,
    n_classes: int | None = None,
    head_weights: HeadWeights | None = None,
    class_ids: Sequence[int] | None = None,
    tolerance: float = 0.0,
) -> tuple[int, ...]:
    """Return final-layer feature indices consumed by a deployed readout.

    ``linear`` readouts need weights to prove a feature is unused; when weights
    are omitted, all final features are treated as used.  ``group_sum`` uses the
    largest class-aligned prefix.  ``class_vote`` and ``signed_class_vote`` use
    every feature unless ``class_ids`` marks a feature with ``-1``.
    """
    _validate_readout_args(final_width=final_width, n_classes=n_classes, tolerance=tolerance)
    if head_mode == "linear":
        if head_weights is None:
            return tuple(range(final_width))
        if len(head_weights) < final_width:
            raise ValueError("head_weights must contain at least final_width rows")
        return tuple(
            feature_idx
            for feature_idx in range(final_width)
            if _feature_weight_used(head_weights, feature_idx, tolerance)
        )
    if head_mode == "group_sum":
        if n_classes is None:
            raise ValueError("n_classes is required for group_sum readouts")
        usable_width = (final_width // n_classes) * n_classes
        return tuple(range(usable_width))
    if head_mode in {"class_vote", "signed_class_vote"}:
        if class_ids is None:
            return tuple(range(final_width))
        if n_classes is None:
            raise ValueError("n_classes is required when class_ids are provided")
        if len(class_ids) < final_width:
            raise ValueError("class_ids must contain at least final_width entries")
        used = []
        for feature_idx in range(final_width):
            class_id = int(class_ids[feature_idx])
            if class_id < 0:
                continue
            if class_id >= n_classes:
                raise ValueError("class_ids must be in [0, n_classes) or -1 for unused")
            used.append(feature_idx)
        return tuple(used)
    raise ValueError(f"unsupported head_mode: {head_mode}")


def find_unused_readout_features(
    *,
    final_width: int,
    head_mode: HeadMode,
    n_classes: int | None = None,
    head_weights: HeadWeights | None = None,
    class_ids: Sequence[int] | None = None,
    tolerance: float = 0.0,
) -> tuple[int, ...]:
    """Return final-layer features that the deployed readout does not consume."""
    used = set(
        used_readout_features(
            final_width=final_width,
            head_mode=head_mode,
            n_classes=n_classes,
            head_weights=head_weights,
            class_ids=class_ids,
            tolerance=tolerance,
        )
    )
    return tuple(feature_idx for feature_idx in range(final_width) if feature_idx not in used)


def find_constant_gates(
    layers: Sequence[HardGateLayer],
    *,
    input_dim: int,
) -> tuple[AliasGate, ...]:
    """Detect gates that hard-simplify to Boolean constants."""
    return compact_hard_circuit(layers, input_dim=input_dim).constant_gates


def find_duplicate_gates(
    layers: Sequence[HardGateLayer],
    *,
    input_dim: int,
) -> tuple[DuplicateGate, ...]:
    """Detect exact structural duplicates in a hardened Boolean circuit."""
    return compact_hard_circuit(layers, input_dim=input_dim).duplicate_gates


def compact_hard_circuit(
    layers: Sequence[HardGateLayer],
    *,
    input_dim: int,
    head_mode: HeadMode = "linear",
    n_classes: int | None = None,
    head_weights: HeadWeights | None = None,
    class_ids: Sequence[int] | None = None,
    tolerance: float = 0.0,
) -> CircuitCompactionResult:
    """Prune and compact a hardened DiffEML Boolean circuit.

    The returned compacted layers use ``SourceRef`` dependencies rather than the
    current packed runner's previous-layer integer namespace.  That makes the
    result faithful to the minimal hard DAG even when a duplicate in one layer
    aliases an input, a constant, or an earlier gate.
    """
    if input_dim <= 0:
        raise ValueError("input_dim must be positive")
    if not layers:
        raise ValueError("at least one hard gate layer is required")
    _validate_readout_args(final_width=layers[-1].width, n_classes=n_classes, tolerance=tolerance)

    original_widths = tuple(layer.width for layer in layers)
    source_expression: dict[SourceRef, ExpressionKey] = {}
    expression_source: dict[ExpressionKey, SourceRef] = {}
    for input_idx in range(input_dim):
        source = SourceRef.input(input_idx)
        key: ExpressionKey = ("input", input_idx)
        source_expression[source] = key
        expression_source[key] = source
    for const_value in (0, 1):
        source = SourceRef.const(const_value)
        key = ("const", const_value)
        source_expression[source] = key
        expression_source[key] = source

    gate_infos: dict[GateRef, _GateInfo] = {}
    original_outputs_by_layer: list[tuple[SourceRef, ...]] = []
    constant_gates: list[AliasGate] = []
    identity_alias_gates: list[AliasGate] = []
    duplicate_gates: list[DuplicateGate] = []
    unique_gate_refs: list[GateRef] = []

    previous_outputs: tuple[SourceRef, ...] = ()
    for layer_idx, layer in enumerate(layers):
        current_outputs: list[SourceRef] = []
        local_source_limit = input_dim + 1 + len(previous_outputs)
        for gate_idx, (left_idx, right_idx, mask) in enumerate(
            zip(layer.left, layer.right, layer.masks, strict=True)
        ):
            if left_idx >= local_source_limit or right_idx >= local_source_limit:
                raise ValueError(
                    f"layer {layer_idx} source index exceeds local source namespace"
                )
            gate_ref = GateRef(layer=layer_idx, index=gate_idx)
            left_source = _resolve_local_source(left_idx, input_dim, previous_outputs)
            right_source = _resolve_local_source(right_idx, input_dim, previous_outputs)
            left_key = source_expression[left_source]
            right_key = source_expression[right_source]
            simplified = _simplify_gate(mask, left_source, right_source, left_key, right_key)

            if simplified.alias_source is not None:
                output_source = simplified.alias_source
                if simplified.reason == "constant":
                    constant_gates.append(
                        AliasGate(gate=gate_ref, source=output_source, reason="constant")
                    )
                    reason: PruningReason = "constant"
                else:
                    identity_alias_gates.append(
                        AliasGate(gate=gate_ref, source=output_source, reason="identity")
                    )
                    reason = "identity"
            elif simplified.expression_key in expression_source:
                output_source = expression_source[simplified.expression_key]
                duplicate_gates.append(
                    DuplicateGate(gate=gate_ref, canonical_source=output_source)
                )
                reason = "duplicate"
            else:
                output_source = SourceRef.gate(layer_idx, gate_idx)
                source_expression[output_source] = simplified.expression_key
                expression_source[simplified.expression_key] = output_source
                unique_gate_refs.append(gate_ref)
                reason = "kept"

            gate_infos[gate_ref] = _GateInfo(
                gate=gate_ref,
                mask=mask,
                left_source=left_source,
                right_source=right_source,
                output_source=output_source,
                expression_key=simplified.expression_key,
                reason=reason,
            )
            current_outputs.append(output_source)
        original_outputs_by_layer.append(tuple(current_outputs))
        previous_outputs = tuple(current_outputs)

    final_feature_sources = original_outputs_by_layer[-1]
    readout_features = used_readout_features(
        final_width=len(final_feature_sources),
        head_mode=head_mode,
        n_classes=n_classes,
        head_weights=head_weights,
        class_ids=class_ids,
        tolerance=tolerance,
    )
    unused_readout_features = find_unused_readout_features(
        final_width=len(final_feature_sources),
        head_mode=head_mode,
        n_classes=n_classes,
        head_weights=head_weights,
        class_ids=class_ids,
        tolerance=tolerance,
    )
    reachable_original_gates = _reachable_gates_from_sources(
        (final_feature_sources[idx] for idx in readout_features),
        gate_infos,
    )
    unique_gate_set = set(unique_gate_refs)
    unused_unique_gates = tuple(
        gate for gate in unique_gate_refs if gate not in reachable_original_gates
    )

    compacted_layers, original_to_compact = _build_compacted_layers(
        layers,
        gate_infos,
        reachable_original_gates,
    )
    compact_final_sources = tuple(
        _maybe_remap_source_to_compact(source, original_to_compact)
        for source in final_feature_sources
    )
    readout_sources = tuple(
        _remap_source_to_compact(final_feature_sources[idx], original_to_compact)
        for idx in readout_features
    )
    kept_gates = tuple(gate for gate in unique_gate_refs if gate in reachable_original_gates)
    compacted_gate_count = sum(layer.width for layer in compacted_layers)
    original_gate_count = sum(original_widths)
    pruned_gates = original_gate_count - compacted_gate_count
    gate_compression_ratio = (
        float(original_gate_count / compacted_gate_count)
        if compacted_gate_count > 0
        else float("inf")
    )
    stats = CircuitPruningStats(
        original_gates=original_gate_count,
        compacted_gates=compacted_gate_count,
        constant_gates=len(constant_gates),
        identity_alias_gates=len(identity_alias_gates),
        duplicate_gates=len(duplicate_gates),
        unused_unique_gates=len(unique_gate_set - reachable_original_gates),
        unused_readout_features=len(unused_readout_features),
        pruned_gates=pruned_gates,
        gate_compression_ratio=gate_compression_ratio,
    )
    return CircuitCompactionResult(
        input_dim=input_dim,
        original_layer_widths=original_widths,
        compacted_layers=compacted_layers,
        final_feature_sources=compact_final_sources,
        readout_used_features=readout_features,
        readout_used_sources=readout_sources,
        constant_gates=tuple(constant_gates),
        identity_alias_gates=tuple(identity_alias_gates),
        duplicate_gates=tuple(duplicate_gates),
        unused_readout_features=unused_readout_features,
        unused_unique_gates=unused_unique_gates,
        kept_gates=kept_gates,
        original_to_compact_source=tuple(
            sorted(original_to_compact.items(), key=lambda item: (item[0].layer, item[0].index))
        ),
        stats=stats,
    )


def _validate_readout_args(
    *,
    final_width: int,
    n_classes: int | None,
    tolerance: float,
) -> None:
    if final_width < 0:
        raise ValueError("final_width must be nonnegative")
    if n_classes is not None and n_classes <= 0:
        raise ValueError("n_classes must be positive when provided")
    if not isfinite(tolerance) or tolerance < 0.0:
        raise ValueError("tolerance must be finite and nonnegative")


def _feature_weight_used(
    head_weights: HeadWeights,
    feature_idx: int,
    tolerance: float,
) -> bool:
    row = head_weights[feature_idx]
    if isinstance(row, Real):
        return abs(float(row)) > tolerance
    return any(abs(float(value)) > tolerance for value in row)


def _resolve_local_source(
    source_idx: int,
    input_dim: int,
    previous_outputs: Sequence[SourceRef],
) -> SourceRef:
    if source_idx < input_dim:
        return SourceRef.input(source_idx)
    if source_idx == input_dim:
        return SourceRef.const(1)
    previous_idx = source_idx - input_dim - 1
    return previous_outputs[previous_idx]


def _simplify_gate(
    mask: int,
    left_source: SourceRef,
    right_source: SourceRef,
    left_key: ExpressionKey,
    right_key: ExpressionKey,
) -> _SimplifiedGate:
    if mask == 0:
        return _SimplifiedGate(("const", 0), SourceRef.const(0), "constant")
    if mask == 15:
        return _SimplifiedGate(("const", 1), SourceRef.const(1), "constant")
    if mask == 12:
        return _SimplifiedGate(left_key, left_source, "identity")
    if mask == 10:
        return _SimplifiedGate(right_key, right_source, "identity")

    if left_key == right_key:
        return _simplify_unary_from_values(
            _mask_bit(mask, 0, 0),
            _mask_bit(mask, 1, 1),
            left_key,
            left_source,
        )
    if left_source.kind == "const":
        left_value = left_source.index
        return _simplify_unary_from_values(
            _mask_bit(mask, left_value, 0),
            _mask_bit(mask, left_value, 1),
            right_key,
            right_source,
        )
    if right_source.kind == "const":
        right_value = right_source.index
        return _simplify_unary_from_values(
            _mask_bit(mask, 0, right_value),
            _mask_bit(mask, 1, right_value),
            left_key,
            left_source,
        )
    if mask == 3:
        return _SimplifiedGate(("not", left_key), None, None)
    if mask == 5:
        return _SimplifiedGate(("not", right_key), None, None)

    if _is_commutative_mask(mask) and repr(right_key) < repr(left_key):
        left_key, right_key = right_key, left_key
    return _SimplifiedGate(("gate", mask, left_key, right_key), None, None)


def _simplify_unary_from_values(
    value_when_false: int,
    value_when_true: int,
    child_key: ExpressionKey,
    child_source: SourceRef,
) -> _SimplifiedGate:
    if value_when_false == 0 and value_when_true == 0:
        return _SimplifiedGate(("const", 0), SourceRef.const(0), "constant")
    if value_when_false == 1 and value_when_true == 1:
        return _SimplifiedGate(("const", 1), SourceRef.const(1), "constant")
    if value_when_false == 0 and value_when_true == 1:
        return _SimplifiedGate(child_key, child_source, "identity")
    return _SimplifiedGate(("not", child_key), None, None)


def _mask_bit(mask: int, left: int, right: int) -> int:
    return (mask >> (2 * left + right)) & 1


def _is_commutative_mask(mask: int) -> bool:
    return _mask_bit(mask, 0, 1) == _mask_bit(mask, 1, 0)


def _reachable_gates_from_sources(
    sources: Iterable[SourceRef],
    gate_infos: dict[GateRef, _GateInfo],
) -> set[GateRef]:
    reachable: set[GateRef] = set()

    def visit_source(source: SourceRef) -> None:
        if source.kind != "gate":
            return
        gate_ref = source.gate_ref
        if gate_ref in reachable:
            return
        reachable.add(gate_ref)
        info = gate_infos[gate_ref]
        visit_source(info.left_source)
        visit_source(info.right_source)

    for source in sources:
        visit_source(source)
    return reachable


def _build_compacted_layers(
    layers: Sequence[HardGateLayer],
    gate_infos: dict[GateRef, _GateInfo],
    reachable_original_gates: set[GateRef],
) -> tuple[tuple[CompactedGateLayer, ...], dict[GateRef, SourceRef]]:
    original_to_compact: dict[GateRef, SourceRef] = {}
    compacted_layers: list[CompactedGateLayer] = []
    for layer_idx, layer in enumerate(layers):
        original_indices: list[int] = []
        left_sources: list[SourceRef] = []
        right_sources: list[SourceRef] = []
        masks: list[int] = []
        for gate_idx in range(layer.width):
            original_ref = GateRef(layer_idx, gate_idx)
            if original_ref not in reachable_original_gates:
                continue
            info = gate_infos[original_ref]
            compact_ref = SourceRef.gate(layer_idx, len(masks))
            original_to_compact[original_ref] = compact_ref
            original_indices.append(gate_idx)
            left_sources.append(_remap_source_to_compact(info.left_source, original_to_compact))
            right_sources.append(_remap_source_to_compact(info.right_source, original_to_compact))
            masks.append(info.mask)
        compacted_layers.append(
            CompactedGateLayer(
                original_layer=layer_idx,
                original_indices=tuple(original_indices),
                left_sources=tuple(left_sources),
                right_sources=tuple(right_sources),
                masks=tuple(masks),
                name=layer.name,
            )
        )
    return tuple(compacted_layers), original_to_compact


def _remap_source_to_compact(
    source: SourceRef,
    original_to_compact: dict[GateRef, SourceRef],
) -> SourceRef:
    if source.kind != "gate":
        return source
    return original_to_compact[source.gate_ref]


def _maybe_remap_source_to_compact(
    source: SourceRef,
    original_to_compact: dict[GateRef, SourceRef],
) -> SourceRef | None:
    if source.kind != "gate":
        return source
    return original_to_compact.get(source.gate_ref)


__all__ = [
    "AliasGate",
    "CircuitCompactionResult",
    "CircuitPruningStats",
    "CompactedGateLayer",
    "DuplicateGate",
    "GateRef",
    "HardGateLayer",
    "HeadMode",
    "SourceRef",
    "compact_hard_circuit",
    "find_constant_gates",
    "find_duplicate_gates",
    "find_unused_readout_features",
    "used_readout_features",
]
