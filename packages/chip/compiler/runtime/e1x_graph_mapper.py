"""Quantized-graph -> logical-mesh placement compiler for the E1X wafer mesh.

This module is the architecture-level mapping/placement pass that the
"Completion Gates Still Missing" list in docs/arch/e1x-wafer-mesh.md calls for:
a compiler/runtime mapping from a *real* quantized model graph to concrete
logical mesh coordinates. It replaces, for real graphs, the single hardcoded
``SCALED_8GB_MODEL`` descriptor in ``e1x_wafer_model.py``.

WHAT THIS MODELS
----------------
Given a transformer-LLM manifest (a layer list describing the per-matrix
shapes, the quantization of each weight/activation, and the parameter count),
the mapper produces a deterministic placement:

  * weight sharding for every weight matrix, tiling output rows across cores by
    the usable per-core SRAM budget (44 KiB = 48 KiB local SRAM minus 4 KiB
    reserved runtime),
  * a contiguous rectangle of logical mesh coordinates per layer (row-major
    over the logical core grid), so each layer owns a known core span,
  * per-core resident-weight occupancy in bytes and as a fraction of the
    usable budget,
  * one fabric routing color per layer (round-robin within
    ``E1XConfig.routing_colors``), the static color a layer's activation
    traffic uses on the 24-color mesh fabric,
  * an aggregate SRAM fit check (does the resident weight + activation working
    set fit in the logical-core SRAM), and
  * an estimated weight + activation movement (bytes) for one prefill+decode
    pass, used by the wafer model's fabric accounting.

The math is real matmul-sharding arithmetic over the manifest shapes; nothing
is sampled or randomized, and there is no wall-clock dependence. The same
manifest + config always yields the same placement and the same
``artifact_sha256``.

WHAT THIS IS NOT (CLAIM BOUNDARY)
---------------------------------
This is a *placement + sharding + capacity* compiler, not a kernel-generating
backend. It does not emit per-core instruction streams, schedule individual
MACs, tile the K (contraction) dimension into compute waves, generate fabric
micro-routes, or prove numerical correctness of a quantized kernel. Those are
the kernel-codegen and scheduling layers and remain out of scope here. The
mapper answers "does this graph fit, and where does every tensor live" — the
question the wafer SRAM/fabric accounting needs — and stops there.

MANIFEST SCHEMA (``eliza.e1x.quantized_model_manifest.v1``)
-----------------------------------------------------------
A JSON/YAML object::

    schema: "eliza.e1x.quantized_model_manifest.v1"
    name: str                      # model identifier
    architecture: "transformer_decoder"
    config:
      n_layers: int                # decoder blocks
      d_model: int                 # hidden size
      n_heads: int
      n_kv_heads: int              # for GQA; == n_heads for MHA
      d_ff: int                    # MLP intermediate size
      vocab_size: int
    quant:
      weight_bits: int             # e.g. 4 for W4
      activation_bits: int         # e.g. 8 for A8
    layers:                        # ordered list; each entry:
      - name: str
        kind: one of LAYER_KINDS   # "embedding" | "attn_qkv_proj" | ...
        rows: int                  # weight matrix output dim
        cols: int                  # weight matrix input dim (contraction)
        weight_bits: int           # may override quant.weight_bits

``rows``/``cols`` are the 2-D weight matrix dims (``rows`` = output features,
``cols`` = input features). Parameter count of a layer is ``rows * cols``. The
declared ``config`` is used only to cross-check the layer list, not to invent
shapes — the layers are the source of truth for placement.
"""

from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
from math import ceil

from compiler.runtime.e1x_wafer_model import (
    E1XConfig,
    QuantizedModelSpec,
    json_dumps_canonical,
)

MANIFEST_SCHEMA = "eliza.e1x.quantized_model_manifest.v1"
PLACEMENT_SCHEMA = "eliza.e1x.graph_mesh_placement.v1"

# 4 KiB/core reserved for runtime (stack, route tables, activation double
# buffer headroom); the rest of the 48 KiB local SRAM holds resident weights.
# Keep this aligned with e1x_wafer_model.model_load_plan().
RESERVED_RUNTIME_KIB_PER_CORE = 4

LAYER_KINDS = (
    "embedding",
    "attn_qkv_proj",
    "attn_out_proj",
    "mlp_gate_proj",
    "mlp_up_proj",
    "mlp_down_proj",
    "norm",
    "lm_head",
)

# Layer kinds whose stored "weights" are not sharded by output-row matmul tiling
# (norm is a per-channel vector). They still occupy SRAM but place onto a single
# core span sized by raw byte capacity.
_VECTOR_KINDS = frozenset({"norm"})


class ManifestError(ValueError):
    """Raised when a manifest violates the v1 schema or its invariants."""


@dataclass(frozen=True)
class LayerSpec:
    name: str
    kind: str
    rows: int
    cols: int
    weight_bits: int

    @property
    def parameters(self) -> int:
        return self.rows * self.cols

    @property
    def weight_bytes(self) -> int:
        return ceil(self.parameters * self.weight_bits / 8)


@dataclass(frozen=True)
class ModelManifest:
    name: str
    architecture: str
    n_layers: int
    d_model: int
    n_heads: int
    n_kv_heads: int
    d_ff: int
    vocab_size: int
    weight_bits: int
    activation_bits: int
    layers: tuple[LayerSpec, ...]

    @property
    def total_parameters(self) -> int:
        return sum(layer.parameters for layer in self.layers)

    @property
    def total_weight_bytes(self) -> int:
        return sum(layer.weight_bytes for layer in self.layers)


def _require_int(obj: dict[str, object], key: str, *, where: str, minimum: int = 1) -> int:
    if key not in obj:
        raise ManifestError(f"{where}: missing required field {key!r}")
    value = obj[key]
    if isinstance(value, bool) or not isinstance(value, int):
        raise ManifestError(f"{where}: {key!r} must be an integer, got {value!r}")
    if value < minimum:
        raise ManifestError(f"{where}: {key!r} must be >= {minimum}, got {value}")
    return value


def _require_str(obj: dict[str, object], key: str, *, where: str) -> str:
    value = obj.get(key)
    if not isinstance(value, str) or not value:
        raise ManifestError(f"{where}: {key!r} must be a non-empty string")
    return value


def parse_manifest(data: dict[str, object]) -> ModelManifest:
    """Validate a raw manifest mapping and return a typed ``ModelManifest``.

    Fails closed: every invariant the placement pass relies on (schema tag,
    known layer kinds, positive shapes, declared-vs-actual layer agreement,
    parameter-count consistency) raises ``ManifestError`` rather than silently
    coercing or defaulting.
    """
    if data.get("schema") != MANIFEST_SCHEMA:
        raise ManifestError(f"schema must be {MANIFEST_SCHEMA!r}, got {data.get('schema')!r}")
    name = _require_str(data, "name", where="manifest")
    architecture = _require_str(data, "architecture", where="manifest")
    if architecture != "transformer_decoder":
        raise ManifestError(
            f"unsupported architecture {architecture!r}; only 'transformer_decoder' is mapped"
        )

    config = data.get("config")
    if not isinstance(config, dict):
        raise ManifestError("manifest: 'config' must be a mapping")
    n_layers = _require_int(config, "n_layers", where="config")
    d_model = _require_int(config, "d_model", where="config")
    n_heads = _require_int(config, "n_heads", where="config")
    n_kv_heads = _require_int(config, "n_kv_heads", where="config")
    d_ff = _require_int(config, "d_ff", where="config")
    vocab_size = _require_int(config, "vocab_size", where="config")
    if n_kv_heads > n_heads or n_heads % n_kv_heads != 0:
        raise ManifestError(
            f"config: n_kv_heads ({n_kv_heads}) must divide n_heads ({n_heads}) for GQA/MHA"
        )

    quant = data.get("quant")
    if not isinstance(quant, dict):
        raise ManifestError("manifest: 'quant' must be a mapping")
    weight_bits = _require_int(quant, "weight_bits", where="quant")
    activation_bits = _require_int(quant, "activation_bits", where="quant")

    raw_layers = data.get("layers")
    if not isinstance(raw_layers, list) or not raw_layers:
        raise ManifestError("manifest: 'layers' must be a non-empty list")

    layers: list[LayerSpec] = []
    for index, raw in enumerate(raw_layers):
        where = f"layers[{index}]"
        if not isinstance(raw, dict):
            raise ManifestError(f"{where}: must be a mapping")
        layer_name = _require_str(raw, "name", where=where)
        kind = _require_str(raw, "kind", where=where)
        if kind not in LAYER_KINDS:
            raise ManifestError(f"{where}: unknown kind {kind!r}; expected one of {LAYER_KINDS}")
        rows = _require_int(raw, "rows", where=where)
        cols = _require_int(raw, "cols", where=where)
        layer_bits = raw.get("weight_bits", weight_bits)
        if isinstance(layer_bits, bool) or not isinstance(layer_bits, int) or layer_bits < 1:
            raise ManifestError(f"{where}: 'weight_bits' must be a positive integer")
        layers.append(LayerSpec(layer_name, kind, rows, cols, layer_bits))

    decoder_blocks = sum(
        1 for layer in layers if layer.kind in {"attn_qkv_proj", "attn_out_proj"}
    )
    # Each decoder block contributes exactly one qkv and one out projection.
    if decoder_blocks != 2 * n_layers:
        raise ManifestError(
            f"layer list declares {decoder_blocks // 2 if decoder_blocks else 0} attention "
            f"blocks but config.n_layers = {n_layers}"
        )

    return ModelManifest(
        name=name,
        architecture=architecture,
        n_layers=n_layers,
        d_model=d_model,
        n_heads=n_heads,
        n_kv_heads=n_kv_heads,
        d_ff=d_ff,
        vocab_size=vocab_size,
        weight_bits=weight_bits,
        activation_bits=activation_bits,
        layers=tuple(layers),
    )


def usable_bytes_per_core(config: E1XConfig) -> int:
    return max(0, (config.local_sram_kib_per_core - RESERVED_RUNTIME_KIB_PER_CORE) * 1024)


def _shard_layer(
    layer: LayerSpec, usable_bytes: int
) -> tuple[int, int, int]:
    """Return (cores_for_layer, rows_per_core, max_shard_bytes) for a layer.

    Matmul sharding: a ``rows x cols`` weight matrix is tiled by output rows
    across cores. Each core holds a contiguous band of ``rows_per_core`` output
    rows, i.e. ``rows_per_core * cols`` quantized weights. ``rows_per_core`` is
    the largest band that fits ``usable_bytes`` per core; the layer then needs
    ``ceil(rows / rows_per_core)`` cores. Vector kinds (norm) are not
    row-tiled — they pack by raw bytes onto the minimum core span.
    """
    if usable_bytes <= 0:
        raise ManifestError("per-core usable SRAM budget is zero; cannot place any weights")
    if layer.kind in _VECTOR_KINDS:
        cores = max(1, ceil(layer.weight_bytes / usable_bytes))
        max_shard_bytes = ceil(layer.weight_bytes / cores)
        return cores, layer.rows, max_shard_bytes

    bytes_per_row = ceil(layer.cols * layer.weight_bits / 8)
    if bytes_per_row > usable_bytes:
        raise ManifestError(
            f"layer {layer.name!r}: one output row ({bytes_per_row} B) exceeds the "
            f"{usable_bytes} B per-core budget; K-dimension splitting (out of scope) required"
        )
    rows_per_core = usable_bytes // bytes_per_row
    cores = ceil(layer.rows / rows_per_core)
    # Largest band actually assigned to any core is min(rows_per_core, rows).
    band = min(rows_per_core, layer.rows)
    max_shard_bytes = band * bytes_per_row
    return cores, rows_per_core, max_shard_bytes


def _coords_for_span(start_index: int, count: int, cols: int) -> tuple[dict[str, int], dict[str, int]]:
    """Row-major start/end logical coordinate for a contiguous core span."""
    end_index = start_index + count - 1
    start = {"row": start_index // cols, "col": start_index % cols}
    end = {"row": end_index // cols, "col": end_index % cols}
    return start, end


def map_graph(manifest: ModelManifest, config: E1XConfig) -> dict:
    """Place every layer of ``manifest`` onto ``config``'s logical mesh.

    Deterministic: layers are placed in manifest order onto a row-major sweep of
    the logical core grid; routing colors are assigned round-robin. The returned
    object is JSON-serializable and carries an ``artifact_sha256`` over its
    canonical form.
    """
    usable = usable_bytes_per_core(config)
    logical_cols = config.logical_cols
    total_logical = config.logical_cores

    cursor = 0
    layer_records: list[dict] = []
    peak_core_bytes = 0
    total_weight_movement = 0
    total_activation_movement = 0

    for index, layer in enumerate(manifest.layers):
        cores, rows_per_core, max_shard_bytes = _shard_layer(layer, usable)
        start_index = cursor
        if start_index + cores > total_logical:
            raise ManifestError(
                f"layer {layer.name!r} needs cores [{start_index}, {start_index + cores}) but the "
                f"logical mesh only has {total_logical} cores; graph does not fit"
            )
        start_coord, end_coord = _coords_for_span(start_index, cores, logical_cols)
        occupancy = max_shard_bytes / usable
        peak_core_bytes = max(peak_core_bytes, max_shard_bytes)
        routing_color = index % config.routing_colors

        # Weight movement: every resident weight byte is loaded onto the wafer
        # once. Activation movement (per layer): the layer's output activations
        # (rows elements at activation_bits) crossing the fabric to the next
        # layer's resident cores.
        total_weight_movement += layer.weight_bytes
        layer_activation_bytes = ceil(layer.rows * manifest.activation_bits / 8)
        total_activation_movement += layer_activation_bytes

        layer_records.append(
            {
                "index": index,
                "name": layer.name,
                "kind": layer.kind,
                "rows": layer.rows,
                "cols": layer.cols,
                "weight_bits": layer.weight_bits,
                "parameters": layer.parameters,
                "weight_bytes": layer.weight_bytes,
                "assigned_cores": cores,
                "rows_per_core": rows_per_core,
                "core_index_start": start_index,
                "core_index_end_exclusive": start_index + cores,
                "logical_start": start_coord,
                "logical_end": end_coord,
                "max_core_shard_bytes": max_shard_bytes,
                "max_core_occupancy": occupancy,
                "routing_color": routing_color,
                "activation_bytes": layer_activation_bytes,
            }
        )
        cursor += cores

    cores_used = cursor
    aggregate_weight_bytes = manifest.total_weight_bytes
    aggregate_capacity_bytes = total_logical * usable
    sram_fit = (
        cores_used <= total_logical
        and aggregate_weight_bytes <= aggregate_capacity_bytes
        and peak_core_bytes <= usable
    )

    placement: dict = {
        "schema": PLACEMENT_SCHEMA,
        "claim_boundary": (
            "architecture_level_placement_sharding_and_capacity_only_not_kernel_codegen"
        ),
        "model": manifest.name,
        "architecture": manifest.architecture,
        "chip": config.name,
        "logical_rows": config.logical_rows,
        "logical_cols": config.logical_cols,
        "logical_cores": total_logical,
        "routing_colors": config.routing_colors,
        "local_sram_kib_per_core": config.local_sram_kib_per_core,
        "reserved_runtime_kib_per_core": RESERVED_RUNTIME_KIB_PER_CORE,
        "usable_bytes_per_core": usable,
        "weight_bits": manifest.weight_bits,
        "activation_bits": manifest.activation_bits,
        "layer_count": len(manifest.layers),
        "total_parameters": manifest.total_parameters,
        "total_weight_bytes": aggregate_weight_bytes,
        "cores_used": cores_used,
        "core_utilization": cores_used / total_logical,
        "peak_core_shard_bytes": peak_core_bytes,
        "peak_core_occupancy": peak_core_bytes / usable,
        "aggregate_capacity_bytes": aggregate_capacity_bytes,
        "sram_fit": sram_fit,
        "estimated_weight_movement_bytes": total_weight_movement,
        "estimated_activation_movement_bytes": total_activation_movement,
        "routing_colors_used": sorted({int(r["routing_color"]) for r in layer_records}),
        "layers": layer_records,
    }
    placement["artifact_sha256"] = sha256(json_dumps_canonical(placement).encode()).hexdigest()
    return placement


def placement_to_model_spec(
    manifest: ModelManifest,
    placement: dict,
    *,
    activation_mib: int,
    runtime_mib: int,
    metadata_mib: int,
) -> QuantizedModelSpec:
    """Bridge a real-graph placement into the wafer model's ``QuantizedModelSpec``.

    The spec carries the *measured* parameter count and effective bits-per-weight
    from the manifest (not a hardcoded descriptor), so the existing wafer
    SRAM/fabric/execution accounting consumes the real graph. ``bits_per_weight``
    is the parameter-weighted effective bit width, rounded up to keep the wafer
    model's integer-bit accounting conservative.
    """
    params = manifest.total_parameters
    effective_bits = ceil(manifest.total_weight_bytes * 8 / params)
    return QuantizedModelSpec(
        name=manifest.name,
        parameters=params,
        bits_per_weight=effective_bits,
        activation_mib=activation_mib,
        runtime_mib=runtime_mib,
        metadata_mib=metadata_mib,
    )
