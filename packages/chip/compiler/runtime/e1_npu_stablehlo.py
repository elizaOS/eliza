"""StableHLO subset IR used as the canonical entry surface for the e1 NPU.

The e1 NPU compiler shim only consumes a narrow StableHLO subset that maps to
the bounded tile/opcode envelope of the prototype runtime. The dataclasses in
this module define that subset, the loader parses a checked YAML/JSON
serialisation of it, and the validator enforces the tile-bound contract from
``docs/spec-db/e1-npu-runtime-contract.json`` before any MMIO is touched.

The subset covers the ops we already claim end-to-end smoke coverage for:

* ``stablehlo.dot_general``  -> matmul / batch_matmul (tile-bound)
* ``stablehlo.convolution``  -> im2col + matmul
* ``stablehlo.add``           -> residual / bias-add
* ``stablehlo.mlp``           -> fused MLP smoke (eliza extension)
* ``stablehlo.transformer_block`` -> fused single-head transformer block smoke

Production codegen lives elsewhere (see ``compiler/iree-eliza-npu/``); this
module is the source-of-truth entry IR for the Python lowering/partitioner.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Iterator, Sequence
from dataclasses import dataclass, field
from typing import Any

try:  # PyYAML is part of the chip toolchain (see requirements.txt).
    import yaml as _yaml
except ImportError:  # pragma: no cover - yaml is required by the chip env.
    _yaml = None  # type: ignore[assignment]

SCHEMA = "eliza.e1_npu_stablehlo_subset.v1"

OP_DOT_GENERAL = "stablehlo.dot_general"
OP_CONVOLUTION = "stablehlo.convolution"
OP_ADD = "stablehlo.add"
OP_BATCH_MATMUL = "stablehlo.batch_matmul"
OP_MLP = "stablehlo.mlp"
OP_ATTENTION_QK = "stablehlo.attention_qk"
OP_ATTENTION_AV = "stablehlo.attention_av"
OP_TRANSFORMER_BLOCK = "stablehlo.transformer_block"
OP_BIAS_ADD = "stablehlo.bias_add"
OP_RESIDUAL_ADD = "stablehlo.residual_add"

SUPPORTED_OPS: frozenset[str] = frozenset(
    {
        OP_DOT_GENERAL,
        OP_CONVOLUTION,
        OP_ADD,
        OP_BATCH_MATMUL,
        OP_MLP,
        OP_ATTENTION_QK,
        OP_ATTENTION_AV,
        OP_TRANSFORMER_BLOCK,
        OP_BIAS_ADD,
        OP_RESIDUAL_ADD,
    }
)

SUPPORTED_PRECISIONS: frozenset[str] = frozenset(
    {"int8", "int4", "int2", "fp8_e4m3", "sparse_int4_2_4"}
)

MAX_TILE_M = 3
MAX_TILE_N = 3
MAX_TILE_K = 7


class StableHloParseError(ValueError):
    """Raised when a serialised StableHLO module fails subset parsing."""


class StableHloValidationError(ValueError):
    """Raised when a parsed module violates the e1 NPU subset contract."""


@dataclass(frozen=True)
class TensorType:
    """Shape + dtype descriptor for a StableHLO tensor."""

    shape: tuple[int, ...]
    dtype: str

    def as_dict(self) -> dict[str, Any]:
        return {"shape": list(self.shape), "dtype": self.dtype}


@dataclass(frozen=True)
class StableHloOp:
    """Base class for the StableHLO subset operations."""

    op: str
    name: str
    result_type: TensorType

    def as_dict(self) -> dict[str, Any]:
        return {
            "op": self.op,
            "name": self.name,
            "result_type": self.result_type.as_dict(),
        }


@dataclass(frozen=True)
class DotGeneral(StableHloOp):
    """``stablehlo.dot_general`` restricted to rank-2 ``[M,K] x [K,N]``."""

    lhs_type: TensorType
    rhs_type: TensorType
    precision: str
    op: str = OP_DOT_GENERAL

    def as_dict(self) -> dict[str, Any]:
        base = super().as_dict()
        base.update(
            {
                "lhs_type": self.lhs_type.as_dict(),
                "rhs_type": self.rhs_type.as_dict(),
                "precision": self.precision,
            }
        )
        return base


@dataclass(frozen=True)
class BatchMatmul(StableHloOp):
    """Batched matmul restricted to ``[B,H,M,K] x [B,H,K,N]``."""

    lhs_type: TensorType
    rhs_type: TensorType
    precision: str
    op: str = OP_BATCH_MATMUL

    def as_dict(self) -> dict[str, Any]:
        base = super().as_dict()
        base.update(
            {
                "lhs_type": self.lhs_type.as_dict(),
                "rhs_type": self.rhs_type.as_dict(),
                "precision": self.precision,
            }
        )
        return base


@dataclass(frozen=True)
class Convolution(StableHloOp):
    """NHWC + HWIO 2-D convolution, batch 1, VALID padding, stride/dilation 1."""

    input_type: TensorType
    filter_type: TensorType
    precision: str
    padding: str = "VALID"
    stride: int = 1
    dilation: int = 1
    op: str = OP_CONVOLUTION

    def as_dict(self) -> dict[str, Any]:
        base = super().as_dict()
        base.update(
            {
                "input_type": self.input_type.as_dict(),
                "filter_type": self.filter_type.as_dict(),
                "precision": self.precision,
                "padding": self.padding,
                "stride": self.stride,
                "dilation": self.dilation,
            }
        )
        return base


@dataclass(frozen=True)
class Add(StableHloOp):
    """Elementwise add restricted to identical shapes; INT8 precision."""

    lhs_type: TensorType
    rhs_type: TensorType
    precision: str = "int8"
    op: str = OP_ADD

    def as_dict(self) -> dict[str, Any]:
        base = super().as_dict()
        base.update(
            {
                "lhs_type": self.lhs_type.as_dict(),
                "rhs_type": self.rhs_type.as_dict(),
                "precision": self.precision,
            }
        )
        return base


@dataclass(frozen=True)
class ResidualAdd(StableHloOp):
    """Eliza alias for residual-add semantics (identical to ``Add``)."""

    lhs_type: TensorType
    rhs_type: TensorType
    precision: str = "int8"
    op: str = OP_RESIDUAL_ADD

    def as_dict(self) -> dict[str, Any]:
        base = super().as_dict()
        base.update(
            {
                "lhs_type": self.lhs_type.as_dict(),
                "rhs_type": self.rhs_type.as_dict(),
                "precision": self.precision,
            }
        )
        return base


@dataclass(frozen=True)
class BiasAdd(StableHloOp):
    """Row-broadcast bias add: ``[M,N] + [N]`` with INT8 saturation."""

    input_type: TensorType
    bias_type: TensorType
    precision: str = "int8"
    op: str = OP_BIAS_ADD

    def as_dict(self) -> dict[str, Any]:
        base = super().as_dict()
        base.update(
            {
                "input_type": self.input_type.as_dict(),
                "bias_type": self.bias_type.as_dict(),
                "precision": self.precision,
            }
        )
        return base


@dataclass(frozen=True)
class Mlp(StableHloOp):
    """Two-projection MLP smoke: up_proj -> activation -> down_proj."""

    input_type: TensorType
    up_weight_type: TensorType
    down_weight_type: TensorType
    activation: str
    precision: str = "int8"
    op: str = OP_MLP

    def as_dict(self) -> dict[str, Any]:
        base = super().as_dict()
        base.update(
            {
                "input_type": self.input_type.as_dict(),
                "up_weight_type": self.up_weight_type.as_dict(),
                "down_weight_type": self.down_weight_type.as_dict(),
                "activation": self.activation,
                "precision": self.precision,
            }
        )
        return base


@dataclass(frozen=True)
class AttentionQk(StableHloOp):
    """Q*K^T scores restricted to rank-4 ``[B,H,T,D] x [B,H,T_kv,D]``."""

    query_type: TensorType
    key_type: TensorType
    precision: str = "int8"
    op: str = OP_ATTENTION_QK

    def as_dict(self) -> dict[str, Any]:
        base = super().as_dict()
        base.update(
            {
                "query_type": self.query_type.as_dict(),
                "key_type": self.key_type.as_dict(),
                "precision": self.precision,
            }
        )
        return base


@dataclass(frozen=True)
class AttentionAv(StableHloOp):
    """Attention*Value restricted to rank-4 weights and value tensors."""

    weights_type: TensorType
    value_type: TensorType
    precision: str = "int8"
    op: str = OP_ATTENTION_AV

    def as_dict(self) -> dict[str, Any]:
        base = super().as_dict()
        base.update(
            {
                "weights_type": self.weights_type.as_dict(),
                "value_type": self.value_type.as_dict(),
                "precision": self.precision,
            }
        )
        return base


@dataclass(frozen=True)
class TransformerBlock(StableHloOp):
    """Single-head batch-1 transformer block smoke (prequantised attention)."""

    input_type: TensorType
    attention_weights_type: TensorType
    value_type: TensorType
    output_proj_type: TensorType
    bias_type: TensorType
    mlp_up_type: TensorType
    mlp_down_type: TensorType
    activation: str
    precision: str = "int8"
    op: str = OP_TRANSFORMER_BLOCK

    def as_dict(self) -> dict[str, Any]:
        base = super().as_dict()
        base.update(
            {
                "input_type": self.input_type.as_dict(),
                "attention_weights_type": self.attention_weights_type.as_dict(),
                "value_type": self.value_type.as_dict(),
                "output_proj_type": self.output_proj_type.as_dict(),
                "bias_type": self.bias_type.as_dict(),
                "mlp_up_type": self.mlp_up_type.as_dict(),
                "mlp_down_type": self.mlp_down_type.as_dict(),
                "activation": self.activation,
                "precision": self.precision,
            }
        )
        return base


@dataclass(frozen=True)
class StableHloModule:
    """A linear list of subset ops; ordering matters for partitioner walks."""

    name: str
    ops: tuple[StableHloOp, ...] = field(default_factory=tuple)
    schema: str = SCHEMA

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": self.schema,
            "name": self.name,
            "ops": [op.as_dict() for op in self.ops],
        }

    def __iter__(self) -> Iterator[StableHloOp]:
        return iter(self.ops)

    def __len__(self) -> int:
        return len(self.ops)


@dataclass(frozen=True)
class ValidationIssue:
    """Structured error returned by :func:`validate_module` per failing op."""

    op_name: str
    op_kind: str
    code: str
    message: str

    def as_dict(self) -> dict[str, str]:
        return {
            "op_name": self.op_name,
            "op_kind": self.op_kind,
            "code": self.code,
            "message": self.message,
        }


def parse_module(payload: str | bytes | dict[str, Any]) -> StableHloModule:
    """Parse the YAML / JSON / mapping form of a subset module."""

    data = _coerce_mapping(payload)
    if data.get("schema") != SCHEMA:
        raise StableHloParseError(f"unsupported schema {data.get('schema')!r}")
    name = data.get("name")
    if not isinstance(name, str) or not name:
        raise StableHloParseError("module name must be a non-empty string")
    raw_ops = data.get("ops")
    if not isinstance(raw_ops, list):
        raise StableHloParseError("module 'ops' must be a list")
    return StableHloModule(name=name, ops=tuple(_parse_op(entry) for entry in raw_ops))


def serialize_module(module: StableHloModule) -> dict[str, Any]:
    """Return the JSON-safe mapping form of a subset module."""

    return module.as_dict()


def validate_module(module: StableHloModule) -> list[ValidationIssue]:
    """Return the structured tile/precision violations for the module."""

    issues: list[ValidationIssue] = []
    for op in module.ops:
        issues.extend(validate_op(op))
    return issues


def validate_op(op: StableHloOp) -> list[ValidationIssue]:
    """Return the structured tile/precision violations for a single op."""

    if op.op not in SUPPORTED_OPS:
        return [_issue(op, "UNSUPPORTED_OP", f"op {op.op!r} not in subset")]
    handler = _VALIDATORS.get(type(op))
    if handler is None:
        return [
            _issue(op, "UNSUPPORTED_OP", f"no validator for dataclass {type(op).__name__}")
        ]
    return handler(op)


def _coerce_mapping(payload: str | bytes | dict[str, Any]) -> dict[str, Any]:
    if isinstance(payload, dict):
        return payload
    if isinstance(payload, (str, bytes)):
        text = payload.decode("utf-8") if isinstance(payload, bytes) else payload
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            if _yaml is None:
                raise StableHloParseError(
                    "payload is neither valid JSON nor a YAML-capable runtime"
                ) from None
            try:
                data = _yaml.safe_load(text)
            except _yaml.YAMLError as exc:
                raise StableHloParseError(f"failed to parse payload: {exc}") from exc
        if not isinstance(data, dict):
            raise StableHloParseError("payload must decode to a mapping")
        return data
    raise StableHloParseError(f"unsupported payload type {type(payload).__name__}")


def _parse_op(entry: Any) -> StableHloOp:
    if not isinstance(entry, dict):
        raise StableHloParseError("each op entry must be a mapping")
    kind = entry.get("op")
    if not isinstance(kind, str):
        raise StableHloParseError("op entry missing 'op' field")
    name = entry.get("name")
    if not isinstance(name, str) or not name:
        raise StableHloParseError(f"{kind} op entry missing non-empty 'name'")
    result_type = _parse_tensor_type(entry.get("result_type"), context=f"{kind} result_type")

    if kind == OP_DOT_GENERAL:
        return DotGeneral(
            name=name,
            result_type=result_type,
            lhs_type=_parse_tensor_type(entry.get("lhs_type"), context=f"{kind} lhs_type"),
            rhs_type=_parse_tensor_type(entry.get("rhs_type"), context=f"{kind} rhs_type"),
            precision=_parse_str(entry.get("precision"), context=f"{kind} precision"),
        )
    if kind == OP_BATCH_MATMUL:
        return BatchMatmul(
            name=name,
            result_type=result_type,
            lhs_type=_parse_tensor_type(entry.get("lhs_type"), context=f"{kind} lhs_type"),
            rhs_type=_parse_tensor_type(entry.get("rhs_type"), context=f"{kind} rhs_type"),
            precision=_parse_str(entry.get("precision"), context=f"{kind} precision"),
        )
    if kind == OP_CONVOLUTION:
        return Convolution(
            name=name,
            result_type=result_type,
            input_type=_parse_tensor_type(entry.get("input_type"), context=f"{kind} input_type"),
            filter_type=_parse_tensor_type(entry.get("filter_type"), context=f"{kind} filter_type"),
            precision=_parse_str(entry.get("precision"), context=f"{kind} precision"),
            padding=_parse_str(entry.get("padding", "VALID"), context=f"{kind} padding"),
            stride=_parse_int(entry.get("stride", 1), context=f"{kind} stride"),
            dilation=_parse_int(entry.get("dilation", 1), context=f"{kind} dilation"),
        )
    if kind == OP_ADD:
        return Add(
            name=name,
            result_type=result_type,
            lhs_type=_parse_tensor_type(entry.get("lhs_type"), context=f"{kind} lhs_type"),
            rhs_type=_parse_tensor_type(entry.get("rhs_type"), context=f"{kind} rhs_type"),
            precision=_parse_str(entry.get("precision", "int8"), context=f"{kind} precision"),
        )
    if kind == OP_RESIDUAL_ADD:
        return ResidualAdd(
            name=name,
            result_type=result_type,
            lhs_type=_parse_tensor_type(entry.get("lhs_type"), context=f"{kind} lhs_type"),
            rhs_type=_parse_tensor_type(entry.get("rhs_type"), context=f"{kind} rhs_type"),
            precision=_parse_str(entry.get("precision", "int8"), context=f"{kind} precision"),
        )
    if kind == OP_BIAS_ADD:
        return BiasAdd(
            name=name,
            result_type=result_type,
            input_type=_parse_tensor_type(entry.get("input_type"), context=f"{kind} input_type"),
            bias_type=_parse_tensor_type(entry.get("bias_type"), context=f"{kind} bias_type"),
            precision=_parse_str(entry.get("precision", "int8"), context=f"{kind} precision"),
        )
    if kind == OP_MLP:
        return Mlp(
            name=name,
            result_type=result_type,
            input_type=_parse_tensor_type(entry.get("input_type"), context=f"{kind} input_type"),
            up_weight_type=_parse_tensor_type(
                entry.get("up_weight_type"), context=f"{kind} up_weight_type"
            ),
            down_weight_type=_parse_tensor_type(
                entry.get("down_weight_type"), context=f"{kind} down_weight_type"
            ),
            activation=_parse_str(entry.get("activation"), context=f"{kind} activation"),
            precision=_parse_str(entry.get("precision", "int8"), context=f"{kind} precision"),
        )
    if kind == OP_ATTENTION_QK:
        return AttentionQk(
            name=name,
            result_type=result_type,
            query_type=_parse_tensor_type(entry.get("query_type"), context=f"{kind} query_type"),
            key_type=_parse_tensor_type(entry.get("key_type"), context=f"{kind} key_type"),
            precision=_parse_str(entry.get("precision", "int8"), context=f"{kind} precision"),
        )
    if kind == OP_ATTENTION_AV:
        return AttentionAv(
            name=name,
            result_type=result_type,
            weights_type=_parse_tensor_type(
                entry.get("weights_type"), context=f"{kind} weights_type"
            ),
            value_type=_parse_tensor_type(entry.get("value_type"), context=f"{kind} value_type"),
            precision=_parse_str(entry.get("precision", "int8"), context=f"{kind} precision"),
        )
    if kind == OP_TRANSFORMER_BLOCK:
        return TransformerBlock(
            name=name,
            result_type=result_type,
            input_type=_parse_tensor_type(entry.get("input_type"), context=f"{kind} input_type"),
            attention_weights_type=_parse_tensor_type(
                entry.get("attention_weights_type"), context=f"{kind} attention_weights_type"
            ),
            value_type=_parse_tensor_type(entry.get("value_type"), context=f"{kind} value_type"),
            output_proj_type=_parse_tensor_type(
                entry.get("output_proj_type"), context=f"{kind} output_proj_type"
            ),
            bias_type=_parse_tensor_type(entry.get("bias_type"), context=f"{kind} bias_type"),
            mlp_up_type=_parse_tensor_type(
                entry.get("mlp_up_type"), context=f"{kind} mlp_up_type"
            ),
            mlp_down_type=_parse_tensor_type(
                entry.get("mlp_down_type"), context=f"{kind} mlp_down_type"
            ),
            activation=_parse_str(entry.get("activation"), context=f"{kind} activation"),
            precision=_parse_str(entry.get("precision", "int8"), context=f"{kind} precision"),
        )
    raise StableHloParseError(f"unsupported op {kind!r}")


def _parse_tensor_type(value: Any, *, context: str) -> TensorType:
    if not isinstance(value, dict):
        raise StableHloParseError(f"{context} must be a mapping with shape/dtype")
    shape = value.get("shape")
    dtype = value.get("dtype")
    if not isinstance(shape, list) or not shape:
        raise StableHloParseError(f"{context} requires a non-empty shape list")
    if any(not isinstance(dim, int) or isinstance(dim, bool) or dim <= 0 for dim in shape):
        raise StableHloParseError(f"{context} shape must contain positive integers")
    if not isinstance(dtype, str) or not dtype:
        raise StableHloParseError(f"{context} dtype must be a non-empty string")
    return TensorType(shape=tuple(shape), dtype=dtype)


def _parse_int(value: Any, *, context: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise StableHloParseError(f"{context} must be an integer")
    return value


def _parse_str(value: Any, *, context: str) -> str:
    if not isinstance(value, str) or not value:
        raise StableHloParseError(f"{context} must be a non-empty string")
    return value


def _issue(op: StableHloOp, code: str, message: str) -> ValidationIssue:
    return ValidationIssue(op_name=op.name, op_kind=op.op, code=code, message=message)


def _check_precision(
    op: StableHloOp, precision: str, allowed: Iterable[str]
) -> list[ValidationIssue]:
    allowed_set = frozenset(allowed)
    if precision not in allowed_set:
        return [
            _issue(
                op,
                "UNSUPPORTED_PRECISION",
                f"precision {precision!r} not in {sorted(allowed_set)}",
            )
        ]
    return []


def _check_tile_bounds(op: StableHloOp, m: int, n: int, k: int) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    if not 1 <= m <= MAX_TILE_M:
        issues.append(
            _issue(op, "TILE_M_OUT_OF_RANGE", f"M={m} outside 1..{MAX_TILE_M}")
        )
    if not 1 <= n <= MAX_TILE_N:
        issues.append(
            _issue(op, "TILE_N_OUT_OF_RANGE", f"N={n} outside 1..{MAX_TILE_N}")
        )
    if not 1 <= k <= MAX_TILE_K:
        issues.append(
            _issue(op, "TILE_K_OUT_OF_RANGE", f"K={k} outside 1..{MAX_TILE_K}")
        )
    return issues


def _validate_dot_general(op: DotGeneral) -> list[ValidationIssue]:
    issues = _check_precision(op, op.precision, {"int8", "int4"})
    lhs = op.lhs_type.shape
    rhs = op.rhs_type.shape
    if len(lhs) != 2 or len(rhs) != 2:
        issues.append(_issue(op, "RANK_UNSUPPORTED", "dot_general subset requires rank-2 operands"))
        return issues
    m, k = lhs
    rhs_k, n = rhs
    if k != rhs_k:
        issues.append(
            _issue(op, "SHAPE_MISMATCH", f"K mismatch: lhs={k}, rhs={rhs_k}")
        )
    issues.extend(_check_tile_bounds(op, m, n, k))
    expected_result = (m, n)
    if op.result_type.shape != expected_result:
        issues.append(
            _issue(
                op,
                "RESULT_SHAPE_MISMATCH",
                f"expected result shape {list(expected_result)}, got {list(op.result_type.shape)}",
            )
        )
    return issues


def _validate_batch_matmul(op: BatchMatmul) -> list[ValidationIssue]:
    issues = _check_precision(op, op.precision, {"int8", "int4"})
    lhs = op.lhs_type.shape
    rhs = op.rhs_type.shape
    if len(lhs) != 4 or len(rhs) != 4:
        issues.append(_issue(op, "RANK_UNSUPPORTED", "batch_matmul subset requires rank-4 operands"))
        return issues
    if lhs[:2] != rhs[:2]:
        issues.append(
            _issue(
                op,
                "BATCH_MISMATCH",
                f"batch/head mismatch: lhs={list(lhs[:2])}, rhs={list(rhs[:2])}",
            )
        )
    m, k = lhs[2], lhs[3]
    rhs_k, n = rhs[2], rhs[3]
    if k != rhs_k:
        issues.append(
            _issue(op, "SHAPE_MISMATCH", f"K mismatch: lhs={k}, rhs={rhs_k}")
        )
    issues.extend(_check_tile_bounds(op, m, n, k))
    return issues


def _validate_convolution(op: Convolution) -> list[ValidationIssue]:
    issues = _check_precision(op, op.precision, {"int8", "int4"})
    inp = op.input_type.shape
    flt = op.filter_type.shape
    if len(inp) != 4 or len(flt) != 4:
        issues.append(_issue(op, "RANK_UNSUPPORTED", "convolution subset requires NHWC + HWIO"))
        return issues
    if inp[0] != 1:
        issues.append(_issue(op, "BATCH_UNSUPPORTED", "convolution subset is batch=1 only"))
    if op.padding != "VALID":
        issues.append(_issue(op, "PADDING_UNSUPPORTED", f"padding {op.padding!r} not in {{VALID}}"))
    if op.stride != 1:
        issues.append(_issue(op, "STRIDE_UNSUPPORTED", f"stride {op.stride} not in {{1}}"))
    if op.dilation != 1:
        issues.append(_issue(op, "DILATION_UNSUPPORTED", f"dilation {op.dilation} not in {{1}}"))
    in_channels_input = inp[3]
    in_channels_filter = flt[2]
    if in_channels_input != in_channels_filter:
        issues.append(
            _issue(
                op,
                "CHANNEL_MISMATCH",
                f"input C={in_channels_input} != filter C={in_channels_filter}",
            )
        )
    fh, fw = flt[0], flt[1]
    ih, iw = inp[1], inp[2]
    if fh > ih or fw > iw:
        issues.append(
            _issue(op, "FILTER_TOO_LARGE", "filter must fit inside input under VALID padding")
        )
    k = in_channels_input * fh * fw
    out_channels = flt[3]
    issues.extend(_check_tile_bounds(op, m=1, n=out_channels, k=k))
    return issues


def _validate_elementwise_add(
    op: StableHloOp,
    lhs: TensorType,
    rhs: TensorType,
    precision: str,
) -> list[ValidationIssue]:
    issues = _check_precision(op, precision, {"int8"})
    if lhs.shape != rhs.shape:
        issues.append(
            _issue(
                op,
                "SHAPE_MISMATCH",
                f"add requires equal shapes: lhs={list(lhs.shape)}, rhs={list(rhs.shape)}",
            )
        )
    if lhs.shape != op.result_type.shape:
        issues.append(
            _issue(
                op,
                "RESULT_SHAPE_MISMATCH",
                f"result shape {list(op.result_type.shape)} != {list(lhs.shape)}",
            )
        )
    return issues


def _validate_add(op: Add) -> list[ValidationIssue]:
    return _validate_elementwise_add(op, op.lhs_type, op.rhs_type, op.precision)


def _validate_residual_add(op: ResidualAdd) -> list[ValidationIssue]:
    return _validate_elementwise_add(op, op.lhs_type, op.rhs_type, op.precision)


def _validate_bias_add(op: BiasAdd) -> list[ValidationIssue]:
    issues = _check_precision(op, op.precision, {"int8"})
    inp = op.input_type.shape
    bias = op.bias_type.shape
    if len(inp) != 2:
        issues.append(_issue(op, "RANK_UNSUPPORTED", "bias_add requires rank-2 input"))
    if len(bias) != 1:
        issues.append(_issue(op, "RANK_UNSUPPORTED", "bias_add requires rank-1 bias"))
    if len(inp) == 2 and len(bias) == 1 and bias[0] != inp[1]:
        issues.append(
            _issue(
                op,
                "SHAPE_MISMATCH",
                f"bias width {bias[0]} != input columns {inp[1]}",
            )
        )
    return issues


def _validate_mlp(op: Mlp) -> list[ValidationIssue]:
    issues = _check_precision(op, op.precision, {"int8"})
    if op.activation not in {"relu"}:
        issues.append(
            _issue(op, "ACTIVATION_UNSUPPORTED", f"activation {op.activation!r} not in {{relu}}")
        )
    inp = op.input_type.shape
    up = op.up_weight_type.shape
    down = op.down_weight_type.shape
    if len(inp) != 2 or len(up) != 2 or len(down) != 2:
        issues.append(_issue(op, "RANK_UNSUPPORTED", "mlp subset requires rank-2 tensors"))
        return issues
    m, k = inp
    up_k, hidden = up
    down_k, n = down
    if k != up_k:
        issues.append(
            _issue(op, "SHAPE_MISMATCH", f"up K mismatch: input={k}, weight={up_k}")
        )
    if hidden != down_k:
        issues.append(
            _issue(
                op,
                "SHAPE_MISMATCH",
                f"down K mismatch: hidden={hidden}, weight={down_k}",
            )
        )
    issues.extend(_check_tile_bounds(op, m, hidden, k))
    issues.extend(_check_tile_bounds(op, m, n, hidden))
    return issues


def _validate_attention_qk(op: AttentionQk) -> list[ValidationIssue]:
    issues = _check_precision(op, op.precision, {"int8", "int4"})
    q = op.query_type.shape
    k = op.key_type.shape
    if len(q) != 4 or len(k) != 4:
        issues.append(
            _issue(op, "RANK_UNSUPPORTED", "attention_qk requires rank-4 [B,H,T,D] tensors")
        )
        return issues
    if q[:2] != k[:2]:
        issues.append(_issue(op, "BATCH_MISMATCH", "batch/head dims must match"))
    if q[3] != k[3]:
        issues.append(
            _issue(op, "SHAPE_MISMATCH", f"head_dim mismatch: q={q[3]}, k={k[3]}")
        )
    issues.extend(_check_tile_bounds(op, m=q[2], n=k[2], k=q[3]))
    return issues


def _validate_attention_av(op: AttentionAv) -> list[ValidationIssue]:
    issues = _check_precision(op, op.precision, {"int8", "int4"})
    weights = op.weights_type.shape
    value = op.value_type.shape
    if len(weights) != 4 or len(value) != 4:
        issues.append(
            _issue(op, "RANK_UNSUPPORTED", "attention_av requires rank-4 weights and values")
        )
        return issues
    if weights[:2] != value[:2]:
        issues.append(_issue(op, "BATCH_MISMATCH", "batch/head dims must match"))
    if weights[3] != value[2]:
        issues.append(
            _issue(
                op,
                "SHAPE_MISMATCH",
                f"key_token mismatch: weights[3]={weights[3]} value[2]={value[2]}",
            )
        )
    issues.extend(_check_tile_bounds(op, m=weights[2], n=value[3], k=weights[3]))
    return issues


def _validate_transformer_block(op: TransformerBlock) -> list[ValidationIssue]:
    issues = _check_precision(op, op.precision, {"int8"})
    if op.activation not in {"relu"}:
        issues.append(
            _issue(
                op,
                "ACTIVATION_UNSUPPORTED",
                f"activation {op.activation!r} not in {{relu}}",
            )
        )
    inp = op.input_type.shape
    if len(inp) != 2:
        issues.append(_issue(op, "RANK_UNSUPPORTED", "transformer_block requires rank-2 input"))
        return issues
    m, d = inp
    issues.extend(_check_tile_bounds(op, m, d, d))
    return issues


_VALIDATORS: dict[type[StableHloOp], Any] = {
    DotGeneral: _validate_dot_general,
    BatchMatmul: _validate_batch_matmul,
    Convolution: _validate_convolution,
    Add: _validate_add,
    ResidualAdd: _validate_residual_add,
    BiasAdd: _validate_bias_add,
    Mlp: _validate_mlp,
    AttentionQk: _validate_attention_qk,
    AttentionAv: _validate_attention_av,
    TransformerBlock: _validate_transformer_block,
}


def module_from_ops(name: str, ops: Sequence[StableHloOp]) -> StableHloModule:
    """Helper to build a module while keeping :class:`StableHloModule` frozen."""

    return StableHloModule(name=name, ops=tuple(ops))
