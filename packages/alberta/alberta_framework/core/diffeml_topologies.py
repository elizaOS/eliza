"""Topology specifications and gate-budget accounting for DiffEML.

The image demo can already instantiate several concrete wirings in
``diffeml_image.make_wiring``.  This module is deliberately narrower: it
describes topology candidates and computes exact resource counts before a
runner exists for every candidate.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import ceil, gcd
from typing import Any, Literal, cast

GateMode = Literal["eml_template", "eml_threshold", "truth_table"]
HeadMode = Literal["linear", "group_sum", "class_vote", "signed_class_vote"]


@dataclass(frozen=True)
class TopologyLayerSpec:
    """One binary-gate layer in a DiffEML topology plan."""

    name: str
    width: int
    kind: str
    fixed_gate_mask: int | None = None
    spatial_grid: tuple[int, int] | None = None
    metadata: dict[str, Any] | None = None

    def __post_init__(self) -> None:
        """Validate layer dimensions."""
        if self.width <= 0:
            raise ValueError("layer width must be positive")
        if self.spatial_grid is not None and (
            self.spatial_grid[0] <= 0 or self.spatial_grid[1] <= 0
        ):
            raise ValueError("spatial grid dimensions must be positive")

    @property
    def is_fixed_gate(self) -> bool:
        """Whether this layer uses a fixed Boolean operation at every node."""
        return self.fixed_gate_mask is not None

    def to_config(self) -> dict[str, Any]:
        """Return a JSON-serializable layer config."""
        return {
            "name": self.name,
            "width": self.width,
            "kind": self.kind,
            "fixed_gate_mask": self.fixed_gate_mask,
            "spatial_grid": list(self.spatial_grid) if self.spatial_grid is not None else None,
            "metadata": dict(self.metadata) if self.metadata is not None else {},
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> TopologyLayerSpec:
        """Create a layer spec from ``to_config`` output."""
        grid = config.get("spatial_grid")
        spatial_grid = None if grid is None else (int(grid[0]), int(grid[1]))
        return cls(
            name=str(config["name"]),
            width=int(config["width"]),
            kind=str(config["kind"]),
            fixed_gate_mask=(
                None if config.get("fixed_gate_mask") is None else int(config["fixed_gate_mask"])
            ),
            spatial_grid=spatial_grid,
            metadata=dict(config.get("metadata", {})),
        )


@dataclass(frozen=True)
class TopologyAccounting:
    """Exact counts for a DiffEML topology at the planning level."""

    layer_count: int
    total_nodes: int
    trainable_gate_nodes: int
    fixed_gate_nodes: int
    trainable_node_parameters: int
    head_parameters: int
    deployed_readout_bytes: int
    source_index_bytes: int
    deployed_wiring_bytes: int
    deployed_gate_mask_bytes: int
    deployed_circuit_bytes: int
    total_trainable_parameters: int
    packed_gate_word_ops_per_batch: int
    packed_source_word_reads_per_batch: int
    packed_feature_word_writes_per_batch: int
    final_feature_columns: int

    def to_config(self) -> dict[str, int]:
        """Return a JSON-serializable accounting record."""
        return {
            "layer_count": self.layer_count,
            "total_nodes": self.total_nodes,
            "trainable_gate_nodes": self.trainable_gate_nodes,
            "fixed_gate_nodes": self.fixed_gate_nodes,
            "trainable_node_parameters": self.trainable_node_parameters,
            "head_parameters": self.head_parameters,
            "deployed_readout_bytes": self.deployed_readout_bytes,
            "source_index_bytes": self.source_index_bytes,
            "deployed_wiring_bytes": self.deployed_wiring_bytes,
            "deployed_gate_mask_bytes": self.deployed_gate_mask_bytes,
            "deployed_circuit_bytes": self.deployed_circuit_bytes,
            "total_trainable_parameters": self.total_trainable_parameters,
            "packed_gate_word_ops_per_batch": self.packed_gate_word_ops_per_batch,
            "packed_source_word_reads_per_batch": self.packed_source_word_reads_per_batch,
            "packed_feature_word_writes_per_batch": self.packed_feature_word_writes_per_batch,
            "final_feature_columns": self.final_feature_columns,
        }


@dataclass(frozen=True)
class PackedInferenceCounts:
    """Packed hard-inference counts for a concrete example count."""

    examples: int
    examples_per_word: int
    word_batches: int
    gate_word_ops: int
    source_word_reads: int
    feature_word_writes: int
    input_pack_columns: int
    final_unpack_columns: int
    head_parameters_read: int
    deployed_readout_bytes_read: int

    def to_config(self) -> dict[str, int]:
        """Return a JSON-serializable packed-inference accounting record."""
        return {
            "examples": self.examples,
            "examples_per_word": self.examples_per_word,
            "word_batches": self.word_batches,
            "gate_word_ops": self.gate_word_ops,
            "source_word_reads": self.source_word_reads,
            "feature_word_writes": self.feature_word_writes,
            "input_pack_columns": self.input_pack_columns,
            "final_unpack_columns": self.final_unpack_columns,
            "head_parameters_read": self.head_parameters_read,
            "deployed_readout_bytes_read": self.deployed_readout_bytes_read,
        }


@dataclass(frozen=True)
class TopologySpec:
    """A serializable DiffEML topology and its accounting context."""

    name: str
    family: str
    input_dim: int
    n_classes: int
    gate_mode: GateMode
    library_size: int
    head_mode: HeadMode
    layers: tuple[TopologyLayerSpec, ...]
    packed_word_bits: int = 64
    metadata: dict[str, Any] | None = None

    def __post_init__(self) -> None:
        """Validate topology dimensions."""
        if self.input_dim <= 0:
            raise ValueError("input_dim must be positive")
        if self.n_classes <= 0:
            raise ValueError("n_classes must be positive")
        if self.library_size <= 0:
            raise ValueError("library_size must be positive")
        if self.packed_word_bits <= 0:
            raise ValueError("packed_word_bits must be positive")
        if not self.layers:
            raise ValueError("topology must contain at least one layer")

    @property
    def final_width(self) -> int:
        """Width of the last circuit layer consumed by the classifier head."""
        return self.layers[-1].width

    def accounting(self) -> TopologyAccounting:
        """Compute exact gate, parameter, and packed-inference counts."""
        total_nodes = sum(layer.width for layer in self.layers)
        fixed_gate_nodes = sum(layer.width for layer in self.layers if layer.is_fixed_gate)
        trainable_gate_nodes = total_nodes - fixed_gate_nodes
        trainable_node_parameters = trainable_gate_nodes * node_parameters_per_trainable_gate(
            self.gate_mode,
            self.library_size,
        )
        head_parameters = head_parameter_count(
            final_width=self.final_width,
            n_classes=self.n_classes,
            head_mode=self.head_mode,
        )
        deployed_readout_bytes = deployed_readout_byte_count(
            final_width=self.final_width,
            n_classes=self.n_classes,
            head_mode=self.head_mode,
        )
        source_index_bytes = source_index_byte_count(
            input_dim=self.input_dim,
            max_layer_width=max(layer.width for layer in self.layers),
        )
        deployed_wiring_bytes = sum(
            deployed_layer_wiring_byte_count(
                layer=layer,
                source_index_bytes=source_index_bytes,
            )
            for layer in self.layers
        )
        deployed_gate_mask_bytes = total_nodes
        return TopologyAccounting(
            layer_count=len(self.layers),
            total_nodes=total_nodes,
            trainable_gate_nodes=trainable_gate_nodes,
            fixed_gate_nodes=fixed_gate_nodes,
            trainable_node_parameters=trainable_node_parameters,
            head_parameters=head_parameters,
            deployed_readout_bytes=deployed_readout_bytes,
            source_index_bytes=source_index_bytes,
            deployed_wiring_bytes=deployed_wiring_bytes,
            deployed_gate_mask_bytes=deployed_gate_mask_bytes,
            deployed_circuit_bytes=(
                deployed_wiring_bytes + deployed_gate_mask_bytes + deployed_readout_bytes
            ),
            total_trainable_parameters=trainable_node_parameters + head_parameters,
            packed_gate_word_ops_per_batch=total_nodes,
            packed_source_word_reads_per_batch=2 * total_nodes,
            packed_feature_word_writes_per_batch=total_nodes,
            final_feature_columns=self.final_width,
        )

    def packed_inference_counts(self, examples: int) -> PackedInferenceCounts:
        """Return packed hard-inference counts for ``examples`` rows."""
        if examples <= 0:
            raise ValueError("examples must be positive")
        accounting = self.accounting()
        word_batches = ceil(examples / self.packed_word_bits)
        return PackedInferenceCounts(
            examples=examples,
            examples_per_word=self.packed_word_bits,
            word_batches=word_batches,
            gate_word_ops=accounting.packed_gate_word_ops_per_batch * word_batches,
            source_word_reads=accounting.packed_source_word_reads_per_batch * word_batches,
            feature_word_writes=accounting.packed_feature_word_writes_per_batch * word_batches,
            input_pack_columns=self.input_dim * word_batches,
            final_unpack_columns=self.final_width * word_batches,
            head_parameters_read=accounting.head_parameters,
            deployed_readout_bytes_read=accounting.deployed_readout_bytes,
        )

    def to_config(self) -> dict[str, Any]:
        """Return a JSON-serializable topology config."""
        return {
            "name": self.name,
            "family": self.family,
            "input_dim": self.input_dim,
            "n_classes": self.n_classes,
            "gate_mode": self.gate_mode,
            "library_size": self.library_size,
            "head_mode": self.head_mode,
            "packed_word_bits": self.packed_word_bits,
            "layers": [layer.to_config() for layer in self.layers],
            "metadata": dict(self.metadata) if self.metadata is not None else {},
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> TopologySpec:
        """Create a topology spec from ``to_config`` output."""
        return cls(
            name=str(config["name"]),
            family=str(config["family"]),
            input_dim=int(config["input_dim"]),
            n_classes=int(config["n_classes"]),
            gate_mode=_as_gate_mode(str(config["gate_mode"])),
            library_size=int(config["library_size"]),
            head_mode=_as_head_mode(str(config["head_mode"])),
            packed_word_bits=int(config.get("packed_word_bits", 64)),
            layers=tuple(TopologyLayerSpec.from_config(layer) for layer in config["layers"]),
            metadata=dict(config.get("metadata", {})),
        )


@dataclass(frozen=True)
class GateBudgetComparison:
    """Comparison against a reference DiffLogic-style binary-gate budget."""

    candidate_name: str
    candidate_nodes: int
    reference_nodes: int
    node_ratio: float
    remaining_reference_nodes: int

    def to_config(self) -> dict[str, int | float | str]:
        """Return a JSON-serializable comparison record."""
        return {
            "candidate_name": self.candidate_name,
            "candidate_nodes": self.candidate_nodes,
            "reference_nodes": self.reference_nodes,
            "node_ratio": self.node_ratio,
            "remaining_reference_nodes": self.remaining_reference_nodes,
        }


def node_parameters_per_trainable_gate(gate_mode: GateMode, library_size: int) -> int:
    """Return trainable selector parameters per non-fixed node."""
    if library_size <= 0:
        raise ValueError("library_size must be positive")
    if gate_mode in {"eml_template", "truth_table"}:
        return library_size
    if gate_mode == "eml_threshold":
        return 2
    raise ValueError(f"unsupported gate_mode: {gate_mode}")


def head_parameter_count(*, final_width: int, n_classes: int, head_mode: HeadMode) -> int:
    """Return classifier-head parameter count."""
    if final_width <= 0:
        raise ValueError("final_width must be positive")
    if n_classes <= 0:
        raise ValueError("n_classes must be positive")
    if head_mode == "group_sum":
        return 0
    if head_mode == "class_vote":
        return final_width * n_classes
    if head_mode == "signed_class_vote":
        return final_width * n_classes * 2
    if head_mode == "linear":
        return final_width * n_classes + n_classes
    raise ValueError(f"unsupported head_mode: {head_mode}")


def deployed_readout_byte_count(*, final_width: int, n_classes: int, head_mode: HeadMode) -> int:
    """Return deployable readout metadata bytes for packed inference."""
    if final_width <= 0:
        raise ValueError("final_width must be positive")
    if n_classes <= 0:
        raise ValueError("n_classes must be positive")
    if head_mode == "group_sum":
        return 0
    if head_mode == "class_vote":
        class_index_bits = max(1, (max(n_classes, 2) - 1).bit_length())
        return (final_width * class_index_bits + 7) // 8
    if head_mode == "signed_class_vote":
        class_index_bits = max(1, (max(n_classes, 2) - 1).bit_length())
        return (final_width * (class_index_bits + 1) + 7) // 8
    if head_mode == "linear":
        weight_bytes = final_width * n_classes
        scale_bytes = 4 * n_classes
        bias_bytes = 4 * n_classes
        return weight_bytes + scale_bytes + bias_bytes
    raise ValueError(f"unsupported head_mode: {head_mode}")


def source_index_byte_count(*, input_dim: int, max_layer_width: int) -> int:
    """Return source-index width for explicit two-source wiring arrays."""
    if input_dim <= 0:
        raise ValueError("input_dim must be positive")
    if max_layer_width <= 0:
        raise ValueError("max_layer_width must be positive")
    return _byte_count_for_value(input_dim + max_layer_width)


def deployed_layer_wiring_byte_count(
    *,
    layer: TopologyLayerSpec,
    source_index_bytes: int,
) -> int:
    """Return deployable wiring bytes for one layer under its storage rule."""
    if source_index_bytes <= 0:
        raise ValueError("source_index_bytes must be positive")
    metadata = layer.metadata or {}
    compressed_bytes = metadata.get("wiring_storage_bytes")
    if compressed_bytes is not None:
        return int(compressed_bytes)
    return layer.width * 2 * source_index_bytes


def compare_gate_budget(spec: TopologySpec, *, reference_nodes: int) -> GateBudgetComparison:
    """Compare ``spec`` to a reference binary-gate budget."""
    if reference_nodes <= 0:
        raise ValueError("reference_nodes must be positive")
    candidate_nodes = spec.accounting().total_nodes
    return GateBudgetComparison(
        candidate_name=spec.name,
        candidate_nodes=candidate_nodes,
        reference_nodes=reference_nodes,
        node_ratio=candidate_nodes / reference_nodes,
        remaining_reference_nodes=reference_nodes - candidate_nodes,
    )


def difflogic_random_topology_spec(
    *,
    name: str,
    input_dim: int,
    n_classes: int,
    width: int,
    layers: int,
    gate_mode: GateMode,
    library_size: int,
    head_mode: HeadMode = "linear",
) -> TopologySpec:
    """Return the current DiffLogic-style random sparse DiffEML plan."""
    if layers <= 0:
        raise ValueError("layers must be positive")
    return TopologySpec(
        name=name,
        family="random_sparse",
        input_dim=input_dim,
        n_classes=n_classes,
        gate_mode=gate_mode,
        library_size=library_size,
        head_mode=head_mode,
        layers=tuple(
            TopologyLayerSpec(name=f"random_{idx}", width=width, kind="random_sparse")
            for idx in range(layers)
        ),
        metadata={"runner_wiring_mode": "random"},
    )


def butterfly_topology_spec(
    *,
    name: str,
    input_dim: int,
    n_classes: int,
    width: int,
    layers: int,
    gate_mode: GateMode,
    library_size: int,
    benes: bool = False,
    permuted: bool = False,
    head_mode: HeadMode = "linear",
) -> TopologySpec:
    """Return a butterfly or Benes fixed-pattern sparse topology plan."""
    if layers <= 0:
        raise ValueError("layers must be positive")
    family = "benes" if benes else "butterfly"
    if permuted:
        family = f"permuted_{family}"
    return TopologySpec(
        name=name,
        family=family,
        input_dim=input_dim,
        n_classes=n_classes,
        gate_mode=gate_mode,
        library_size=library_size,
        head_mode=head_mode,
        layers=tuple(
            TopologyLayerSpec(name=f"{family}_{idx}", width=width, kind=family)
            for idx in range(layers)
        ),
        metadata={"runner_wiring_mode": family},
    )


def affine_expander_topology_spec(
    *,
    name: str,
    input_dim: int,
    n_classes: int,
    width: int,
    layers: int,
    gate_mode: GateMode,
    library_size: int,
    head_mode: HeadMode = "class_vote",
) -> TopologySpec:
    """Return a deterministic degree-2 affine-expander topology plan.

    Each layer can be regenerated from four modular-affine coefficients instead
    of storing two explicit source-index arrays. This keeps the hard circuit a
    pure two-input Boolean-gate network while replacing random wiring with a
    reproducible sparse expander schedule.
    """
    if width <= 0:
        raise ValueError("width must be positive")
    if layers <= 0:
        raise ValueError("layers must be positive")
    descriptor_int_bytes = _byte_count_for_value(max(input_dim, width))
    descriptor_bytes = 4 * descriptor_int_bytes
    topology_layers: list[TopologyLayerSpec] = []
    for layer_idx in range(layers):
        modulus = input_dim if layer_idx == 0 else width
        left_multiplier = _coprime_at_least(2 * layer_idx + 1, modulus)
        right_multiplier = _coprime_at_least(2 * layer_idx + 3, modulus)
        topology_layers.append(
            TopologyLayerSpec(
                name=f"affine_expander_{layer_idx}",
                width=width,
                kind="affine_expander",
                metadata={
                    "layer": layer_idx,
                    "source": "input" if layer_idx == 0 else "previous_layer",
                    "modulus": modulus,
                    "left_multiplier": left_multiplier,
                    "left_offset": (layer_idx * 17 + 1) % modulus,
                    "right_multiplier": right_multiplier,
                    "right_offset": (layer_idx * 31 + 7) % modulus,
                    "wiring_storage_mode": "affine_mod_descriptor",
                    "wiring_storage_bytes": descriptor_bytes,
                },
            )
        )
    return TopologySpec(
        name=name,
        family="affine_expander",
        input_dim=input_dim,
        n_classes=n_classes,
        gate_mode=gate_mode,
        library_size=library_size,
        head_mode=head_mode,
        layers=tuple(topology_layers),
        metadata={
            "runner_wiring_mode": "affine_expander",
            "deterministic_wiring": True,
            "degree": 2,
            "descriptor": "left/right modular-affine source rules per layer",
        },
    )


def butterfly_class_bank_topology_spec(
    *,
    name: str,
    input_dim: int,
    n_classes: int,
    width: int,
    mixer_layers: int,
    class_bank_layers: int,
    gate_mode: GateMode,
    library_size: int,
    head_mode: HeadMode = "group_sum",
) -> TopologySpec:
    """Return a deterministic butterfly mixer followed by class-bank gates.

    The topology first performs global butterfly-style communication, then
    restricts later gates to class-aligned banks so a ``group_sum`` readout is a
    Boolean vote count rather than a learned dense mixer.
    """
    if width <= 0:
        raise ValueError("width must be positive")
    if mixer_layers < 0:
        raise ValueError("mixer_layers must be non-negative")
    if class_bank_layers <= 0:
        raise ValueError("class_bank_layers must be positive")
    if mixer_layers + class_bank_layers <= 0:
        raise ValueError("topology must contain at least one layer")
    strides = _butterfly_strides(width)
    stride_bytes = _byte_count_for_value(max(strides))
    bank_width = ceil(width / n_classes)
    topology_layers: list[TopologyLayerSpec] = []
    for layer_idx in range(mixer_layers):
        stride = strides[layer_idx % len(strides)]
        topology_layers.append(
            TopologyLayerSpec(
                name=f"butterfly_mixer_{layer_idx}",
                width=width,
                kind="butterfly_mixer",
                metadata={
                    "stage": "global_mixer",
                    "stride": stride,
                    "class_bank": False,
                    "wiring_storage_mode": "implicit_butterfly_stride",
                    "wiring_storage_bytes": stride_bytes,
                },
            )
        )
    for bank_idx in range(class_bank_layers):
        stride = _bank_butterfly_stride(bank_width, bank_idx)
        topology_layers.append(
            TopologyLayerSpec(
                name=f"class_bank_butterfly_{bank_idx}",
                width=width,
                kind="class_bank_butterfly",
                metadata={
                    "stage": "class_bank",
                    "stride": stride,
                    "class_bank": True,
                    "bank_width": bank_width,
                    "wiring_storage_mode": "implicit_bank_butterfly_stride",
                    "wiring_storage_bytes": stride_bytes,
                },
            )
        )
    return TopologySpec(
        name=name,
        family="butterfly_class_bank",
        input_dim=input_dim,
        n_classes=n_classes,
        gate_mode=gate_mode,
        library_size=library_size,
        head_mode=head_mode,
        layers=tuple(topology_layers),
        metadata={
            "runner_wiring_mode": "butterfly_class_bank",
            "deterministic_wiring": True,
            "mixer_layers": mixer_layers,
            "class_bank_layers": class_bank_layers,
            "bank_width": bank_width,
            "butterfly_strides": list(strides),
            "descriptor": "global butterfly mixer, then class-local butterfly banks",
        },
    )


def class_bank_random_topology_spec(
    *,
    name: str,
    input_dim: int,
    n_classes: int,
    width: int,
    layers: int,
    gate_mode: GateMode,
    library_size: int,
    class_bank_layers: int = 2,
    head_mode: HeadMode = "group_sum",
) -> TopologySpec:
    """Return a random mixer with final class-specific Boolean banks."""
    if layers <= 0:
        raise ValueError("layers must be positive")
    if n_classes <= 0:
        raise ValueError("n_classes must be positive")
    if class_bank_layers <= 0:
        raise ValueError("class_bank_layers must be positive")
    if class_bank_layers > layers:
        raise ValueError("class_bank_layers must be <= layers")
    generic_layers = layers - class_bank_layers
    topology_layers: list[TopologyLayerSpec] = []
    for idx in range(generic_layers):
        topology_layers.append(
            TopologyLayerSpec(
                name=f"generic_random_{idx}",
                width=width,
                kind="random_sparse",
                metadata={"class_bank": False},
            )
        )
    for idx in range(class_bank_layers):
        topology_layers.append(
            TopologyLayerSpec(
                name=f"class_bank_{idx}",
                width=width,
                kind="class_bank_random",
                metadata={"class_bank": True, "bank_width": max(1, width // n_classes)},
            )
        )
    return TopologySpec(
        name=name,
        family="class_bank_random",
        input_dim=input_dim,
        n_classes=n_classes,
        gate_mode=gate_mode,
        library_size=library_size,
        head_mode=head_mode,
        layers=tuple(topology_layers),
        metadata={
            "runner_wiring_mode": "class_bank_random",
            "generic_layers": generic_layers,
            "class_bank_layers": class_bank_layers,
        },
    )


def local_tree_hierarchy_topology_spec(
    *,
    name: str,
    input_dim: int,
    n_classes: int,
    width: int,
    stage_depths: tuple[int, ...],
    gate_mode: GateMode,
    library_size: int,
    local_patch_size: int = 3,
    or_gate_mask: int = 14,
    head_mode: HeadMode = "linear",
) -> TopologySpec:
    """Return the existing local-tree hierarchy plan with fixed OR pooling."""
    if not stage_depths:
        raise ValueError("stage_depths must be non-empty")
    if any(depth <= 0 for depth in stage_depths):
        raise ValueError("all stage depths must be positive")
    layers: list[TopologyLayerSpec] = []
    for stage_idx, stage_depth in enumerate(stage_depths):
        for tree_idx in range(stage_depth):
            layers.append(
                TopologyLayerSpec(
                    name=f"stage{stage_idx}_tree{tree_idx}",
                    width=width,
                    kind="local_tree",
                    metadata={"stage": stage_idx, "tree_depth_index": tree_idx},
                )
            )
        if stage_idx < len(stage_depths) - 1:
            layers.append(
                TopologyLayerSpec(
                    name=f"stage{stage_idx}_or_pool",
                    width=width,
                    kind="or_pool",
                    fixed_gate_mask=or_gate_mask,
                    metadata={"stage": stage_idx},
                )
            )
    return TopologySpec(
        name=name,
        family="local_tree_hierarchy",
        input_dim=input_dim,
        n_classes=n_classes,
        gate_mode=gate_mode,
        library_size=library_size,
        head_mode=head_mode,
        layers=tuple(layers),
        metadata={
            "runner_wiring_mode": "local_tree_hierarchy",
            "local_patch_size": local_patch_size,
            "stage_depths": list(stage_depths),
            "or_gate_mask": or_gate_mask,
        },
    )


def continuous_eml_block_topology_spec(
    *,
    name: str,
    input_dim: int,
    n_classes: int,
    width: int,
    blocks: int,
    depth_per_block: int,
    gate_mode: GateMode,
    library_size: int,
    residual: bool = True,
    head_mode: HeadMode = "linear",
) -> TopologySpec:
    """Return a plan for continuous EML blocks before hardening.

    This is a candidate family rather than a current image-runner wiring mode:
    each block keeps a fixed gate budget while allowing dense differentiable
    EML mixing inside the block during training, then hardens to the same
    two-input gate count for packed inference.
    """
    if blocks <= 0:
        raise ValueError("blocks must be positive")
    if depth_per_block <= 0:
        raise ValueError("depth_per_block must be positive")
    layers = []
    for block_idx in range(blocks):
        for depth_idx in range(depth_per_block):
            layers.append(
                TopologyLayerSpec(
                    name=f"block{block_idx}_eml{depth_idx}",
                    width=width,
                    kind="continuous_eml_block",
                    metadata={
                        "block": block_idx,
                        "depth_index": depth_idx,
                        "residual": residual,
                    },
                )
            )
    return TopologySpec(
        name=name,
        family="continuous_eml_blocks",
        input_dim=input_dim,
        n_classes=n_classes,
        gate_mode=gate_mode,
        library_size=library_size,
        head_mode=head_mode,
        layers=tuple(layers),
        metadata={
            "blocks": blocks,
            "depth_per_block": depth_per_block,
            "residual": residual,
            "runner_wiring_mode": "future_continuous_eml_blocks",
        },
    )


def conv_tree_stage_topology_spec(
    *,
    name: str,
    input_dim: int,
    n_classes: int,
    image_shape: tuple[int, int, int],
    channels_per_stage: tuple[int, ...],
    tree_depths: tuple[int, ...],
    gate_mode: GateMode,
    library_size: int,
    or_gate_mask: int = 14,
    head_mode: HeadMode = "linear",
) -> TopologySpec:
    """Return a variable-width Conv/Tree-style spatial-stage topology plan."""
    if len(channels_per_stage) != len(tree_depths):
        raise ValueError("channels_per_stage and tree_depths must have equal length")
    if not channels_per_stage:
        raise ValueError("at least one spatial stage is required")
    if any(channels <= 0 for channels in channels_per_stage):
        raise ValueError("all stage channel counts must be positive")
    if any(depth <= 0 for depth in tree_depths):
        raise ValueError("all tree depths must be positive")
    height, width, _channels = image_shape
    if height <= 0 or width <= 0:
        raise ValueError("image height and width must be positive")

    layers: list[TopologyLayerSpec] = []
    for stage_idx, (stage_channels, stage_depth) in enumerate(
        zip(channels_per_stage, tree_depths, strict=True)
    ):
        grid = _stage_grid(height, width, stage_idx)
        layer_width = grid[0] * grid[1] * stage_channels
        for tree_idx in range(stage_depth):
            layers.append(
                TopologyLayerSpec(
                    name=f"stage{stage_idx}_conv_tree{tree_idx}",
                    width=layer_width,
                    kind="conv_tree",
                    spatial_grid=grid,
                    metadata={
                        "stage": stage_idx,
                        "tree_depth_index": tree_idx,
                        "channels": stage_channels,
                    },
                )
            )
        if stage_idx < len(channels_per_stage) - 1:
            pooled_grid = _stage_grid(height, width, stage_idx + 1)
            pooled_width = pooled_grid[0] * pooled_grid[1] * channels_per_stage[stage_idx + 1]
            layers.append(
                TopologyLayerSpec(
                    name=f"stage{stage_idx}_or_pool",
                    width=pooled_width,
                    kind="or_pool",
                    fixed_gate_mask=or_gate_mask,
                    spatial_grid=pooled_grid,
                    metadata={"stage": stage_idx, "channels": channels_per_stage[stage_idx + 1]},
                )
            )
    return TopologySpec(
        name=name,
        family="conv_tree_spatial_stages",
        input_dim=input_dim,
        n_classes=n_classes,
        gate_mode=gate_mode,
        library_size=library_size,
        head_mode=head_mode,
        layers=tuple(layers),
        metadata={
            "image_shape": list(image_shape),
            "channels_per_stage": list(channels_per_stage),
            "tree_depths": list(tree_depths),
            "or_gate_mask": or_gate_mask,
            "runner_wiring_mode": "future_conv_tree_spatial_stages",
        },
    )


def candidate_topology_specs(
    *,
    input_dim: int,
    n_classes: int,
    library_size: int,
    gate_mode: GateMode = "eml_threshold",
) -> tuple[TopologySpec, ...]:
    """Return a small deterministic candidate set for topology planning."""
    return (
        difflogic_random_topology_spec(
            name="random_sparse_w2048_l6",
            input_dim=input_dim,
            n_classes=n_classes,
            width=2048,
            layers=6,
            gate_mode=gate_mode,
            library_size=library_size,
        ),
        butterfly_topology_spec(
            name="permuted_benes_w2048_l6",
            input_dim=input_dim,
            n_classes=n_classes,
            width=2048,
            layers=6,
            gate_mode=gate_mode,
            library_size=library_size,
            benes=True,
            permuted=True,
        ),
        affine_expander_topology_spec(
            name="affine_expander_w2048_l6",
            input_dim=input_dim,
            n_classes=n_classes,
            width=2048,
            layers=6,
            gate_mode=gate_mode,
            library_size=library_size,
            head_mode="class_vote",
        ),
        butterfly_class_bank_topology_spec(
            name="butterfly_class_bank_w2048_l6",
            input_dim=input_dim,
            n_classes=n_classes,
            width=2048,
            mixer_layers=5,
            class_bank_layers=1,
            gate_mode=gate_mode,
            library_size=library_size,
            head_mode="group_sum",
        ),
        class_bank_random_topology_spec(
            name="class_bank_group_sum_w2048_l6",
            input_dim=input_dim,
            n_classes=n_classes,
            width=2048,
            layers=6,
            gate_mode=gate_mode,
            library_size=library_size,
            head_mode="group_sum",
        ),
        local_tree_hierarchy_topology_spec(
            name="local_tree_2222_w1024",
            input_dim=input_dim,
            n_classes=n_classes,
            width=1024,
            stage_depths=(2, 2, 2, 2),
            gate_mode=gate_mode,
            library_size=library_size,
        ),
        continuous_eml_block_topology_spec(
            name="continuous_blocks_w1536_b3_d2",
            input_dim=input_dim,
            n_classes=n_classes,
            width=1536,
            blocks=3,
            depth_per_block=2,
            gate_mode=gate_mode,
            library_size=library_size,
        ),
        conv_tree_stage_topology_spec(
            name="conv_tree_c8_16_32_d2_2_1",
            input_dim=input_dim,
            n_classes=n_classes,
            image_shape=(32, 32, 3),
            channels_per_stage=(8, 16, 32),
            tree_depths=(2, 2, 1),
            gate_mode=gate_mode,
            library_size=library_size,
        ),
    )


def _stage_grid(height: int, width: int, stage_idx: int) -> tuple[int, int]:
    stride = 2**stage_idx
    return ceil(height / stride), ceil(width / stride)


def _byte_count_for_value(value: int) -> int:
    if value <= 0:
        raise ValueError("value must be positive")
    if value <= 2**8:
        return 1
    if value <= 2**16:
        return 2
    return 4


def _butterfly_strides(width: int) -> tuple[int, ...]:
    if width <= 0:
        raise ValueError("width must be positive")
    strides: list[int] = []
    stride = 1
    while stride < width:
        strides.append(stride)
        stride *= 2
    return tuple(strides) if strides else (1,)


def _bank_butterfly_stride(bank_width: int, layer_idx: int) -> int:
    if bank_width <= 0:
        raise ValueError("bank_width must be positive")
    if layer_idx < 0:
        raise ValueError("layer_idx must be non-negative")
    strides = _butterfly_strides(bank_width)
    return strides[layer_idx % len(strides)]


def _coprime_at_least(candidate: int, modulus: int) -> int:
    if modulus <= 0:
        raise ValueError("modulus must be positive")
    value = max(1, candidate)
    while gcd(value, modulus) != 1:
        value += 1
    return value


def _as_gate_mode(value: str) -> GateMode:
    if value in {"eml_template", "eml_threshold", "truth_table"}:
        return cast(GateMode, value)
    raise ValueError(f"unsupported gate_mode: {value}")


def _as_head_mode(value: str) -> HeadMode:
    if value in {"linear", "group_sum", "class_vote", "signed_class_vote"}:
        return cast(HeadMode, value)
    raise ValueError(f"unsupported head_mode: {value}")
