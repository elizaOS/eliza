"""TEST ORACLE — NOT PRODUCTION CODEGEN.

This module is the Python reference for descriptor / scratchpad / opcode
behavior used by the elizanpu IREE dialect verifiers and the C runtime.
Production codegen lives in `compiler/iree-eliza-npu/` and lowers
StableHLO / linalg / ExecuTorch graphs through MLIR. Do NOT extend the
single-op smoke API in this file for real compilation work; extend the
elizanpu dialect instead. See `docs/toolchain/iree-eliza-npu.md` for the
production lowering contract.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import isqrt
from typing import Any

from e1_npu_runtime import (
    E1NpuRuntime,
    golden_dot4_fp8_e4m3,
    golden_dot16_s2,
    golden_gemm_s4,
    golden_gemm_s8,
    golden_sdot4_s4_2_4,
)

SUPPORTED_SCHEMA = "eliza.e1_npu_matmul_smoke.v1"
SUPPORTED_BATCH_MATMUL_SCHEMA = "eliza.e1_npu_batch_matmul_smoke.v1"
SUPPORTED_SPARSE_INT4_MATMUL_SCHEMA = "eliza.e1_npu_sparse_int4_matmul_smoke.v1"
SUPPORTED_GROUP_SCALED_INT4_MATMUL_SCHEMA = "eliza.e1_npu_group_scaled_int4_matmul_smoke.v1"
SUPPORTED_INT2_MATMUL_SCHEMA = "eliza.e1_npu_int2_matmul_smoke.v1"
SUPPORTED_FP8_MATMUL_SCHEMA = "eliza.e1_npu_fp8_matmul_smoke.v1"
SUPPORTED_FP16_MATMUL_SCHEMA = "eliza.e1_npu_fp16_matmul_smoke.v1"
SUPPORTED_BF16_MATMUL_SCHEMA = "eliza.e1_npu_bf16_matmul_smoke.v1"
SUPPORTED_CONV2D_SCHEMA = "eliza.e1_npu_conv2d_smoke.v1"
SUPPORTED_DEPTHWISE_CONV2D_SCHEMA = "eliza.e1_npu_depthwise_conv2d_smoke.v1"
SUPPORTED_GROUPED_CONV2D_SCHEMA = "eliza.e1_npu_grouped_conv2d_smoke.v1"
SUPPORTED_ATTENTION_SCHEMA = "eliza.e1_npu_attention_smoke.v1"
SUPPORTED_DECODE_ATTENTION_SCHEMA = "eliza.e1_npu_decode_attention_smoke.v1"
SUPPORTED_ATTENTION_QK_SCHEMA = "eliza.e1_npu_attention_qk_smoke.v1"
SUPPORTED_ATTENTION_SOFTMAX_SCHEMA = "eliza.e1_npu_attention_softmax_smoke.v1"
SUPPORTED_ATTENTION_AV_SCHEMA = "eliza.e1_npu_attention_av_smoke.v1"
SUPPORTED_KV_CACHE_UPDATE_SCHEMA = "eliza.e1_npu_kv_cache_update_smoke.v1"
SUPPORTED_QKV_PROJECTION_SCHEMA = "eliza.e1_npu_qkv_projection_smoke.v1"
SUPPORTED_MLP_SCHEMA = "eliza.e1_npu_mlp_smoke.v1"
SUPPORTED_SWIGLU_SCHEMA = "eliza.e1_npu_swiglu_smoke.v1"
SUPPORTED_SILU_SCHEMA = "eliza.e1_npu_silu_smoke.v1"
SUPPORTED_GELU_SCHEMA = "eliza.e1_npu_gelu_smoke.v1"
SUPPORTED_RESIDUAL_ADD_SCHEMA = "eliza.e1_npu_residual_add_smoke.v1"
SUPPORTED_BIAS_ADD_SCHEMA = "eliza.e1_npu_bias_add_smoke.v1"
SUPPORTED_TRANSFORMER_BLOCK_SCHEMA = "eliza.e1_npu_transformer_block_smoke.v1"
SUPPORTED_MODERN_DECODER_BLOCK_SCHEMA = "eliza.e1_npu_modern_decoder_block_smoke.v1"
SUPPORTED_ROPE_SCHEMA = "eliza.e1_npu_rope_smoke.v1"
SUPPORTED_RMSNORM_SCHEMA = "eliza.e1_npu_rmsnorm_smoke.v1"
SUPPORTED_MATMUL_OPS = {
    "stablehlo.dot_general",
    "stablehlo.dot",
    "stablehlo.batch_matmul",
    "tflite.fully_connected",
    "tflite.batch_matmul",
    "tflite.matmul",
}
SUPPORTED_BATCH_MATMUL_OPS = {
    "stablehlo.batch_matmul",
    "tflite.batch_matmul",
    "eliza.batch_matmul",
}
SUPPORTED_SPARSE_INT4_MATMUL_OPS = SUPPORTED_MATMUL_OPS | {
    "eliza.sparse_2_4_matmul",
    "eliza.sparse_int4_matmul",
}
SUPPORTED_GROUP_SCALED_INT4_MATMUL_OPS = SUPPORTED_MATMUL_OPS | {
    "eliza.group_scaled_int4_matmul",
    "eliza.awq_int4_matmul",
}
SUPPORTED_INT2_MATMUL_OPS = SUPPORTED_MATMUL_OPS | {"eliza.int2_matmul", "eliza.bitnet_matmul"}
SUPPORTED_FP8_MATMUL_OPS = SUPPORTED_MATMUL_OPS | {"eliza.fp8_matmul"}
SUPPORTED_FP16_MATMUL_OPS = SUPPORTED_MATMUL_OPS | {"eliza.fp16_matmul"}
SUPPORTED_BF16_MATMUL_OPS = SUPPORTED_MATMUL_OPS | {"eliza.bf16_matmul"}
SUPPORTED_CONV2D_OPS = {
    "stablehlo.convolution",
    "tflite.conv_2d",
}
SUPPORTED_DEPTHWISE_CONV2D_OPS = {
    "stablehlo.depthwise_convolution",
    "tflite.depthwise_conv_2d",
    "eliza.depthwise_conv2d",
}
SUPPORTED_GROUPED_CONV2D_OPS = {
    "stablehlo.convolution",
    "tflite.conv_2d",
    "eliza.grouped_conv2d",
}
SUPPORTED_ATTENTION_OPS = {
    "eliza.attention",
    "stablehlo.attention",
    "tflite.attention",
}
SUPPORTED_DECODE_ATTENTION_OPS = {
    "eliza.decode_attention",
    "stablehlo.decode_attention",
    "tflite.decode_attention",
}
SUPPORTED_ATTENTION_QK_OPS = {
    "stablehlo.attention_qk",
    "stablehlo.dot_general",
    "tflite.batch_matmul",
    "eliza.attention_qk",
}
SUPPORTED_ATTENTION_SOFTMAX_OPS = {
    "stablehlo.softmax",
    "tflite.softmax",
    "eliza.attention_softmax",
}
SUPPORTED_ATTENTION_AV_OPS = {
    "stablehlo.attention_av",
    "stablehlo.dot_general",
    "tflite.batch_matmul",
    "eliza.attention_av",
}
SUPPORTED_KV_CACHE_UPDATE_OPS = {
    "eliza.kv_cache_update",
    "stablehlo.kv_cache_update",
    "tflite.kv_cache_update",
}
SUPPORTED_QKV_PROJECTION_OPS = {
    "eliza.qkv_projection",
    "stablehlo.qkv_projection",
    "tflite.qkv_projection",
}
SUPPORTED_MLP_OPS = {
    "stablehlo.mlp",
    "tflite.mlp",
    "eliza.transformer_mlp",
}
SUPPORTED_SWIGLU_OPS = {
    "stablehlo.swiglu",
    "tflite.swiglu",
    "eliza.swiglu",
    "eliza.gated_mlp",
}
SUPPORTED_SILU_OPS = {
    "stablehlo.silu",
    "tflite.silu",
    "eliza.silu",
    "eliza.approx_silu",
}
SUPPORTED_GELU_OPS = {
    "stablehlo.gelu",
    "tflite.gelu",
    "eliza.gelu",
    "eliza.quick_gelu",
}
SUPPORTED_RESIDUAL_ADD_OPS = {
    "stablehlo.add",
    "stablehlo.residual_add",
    "tflite.add",
    "eliza.residual_add",
}
SUPPORTED_BIAS_ADD_OPS = {
    "stablehlo.add",
    "stablehlo.bias_add",
    "tflite.add",
    "eliza.bias_add",
}
SUPPORTED_TRANSFORMER_BLOCK_OPS = {
    "eliza.transformer_block",
    "stablehlo.transformer_block",
    "tflite.transformer_block",
}
SUPPORTED_MODERN_DECODER_BLOCK_OPS = {
    "eliza.decoder_block",
    "stablehlo.decoder_block",
    "tflite.decoder_block",
}
SUPPORTED_ROPE_OPS = {
    "eliza.rope",
    "stablehlo.rope",
    "tflite.rope",
}
SUPPORTED_RMSNORM_OPS = {
    "eliza.rms_norm",
    "stablehlo.rms_norm",
    "tflite.rms_norm",
}
MAX_TILE_M = 3
MAX_TILE_N = 3
MAX_TILE_K = 7
TRANSFORMER_BLOCK_CLAIM_BOUNDARY = "single_head_transformer_block_smoke_only_not_softmax_norm_multihead_or_production_compiler_backend"
MODERN_DECODER_BLOCK_CLAIM_BOUNDARY = "modern_decoder_block_single_head_exp2_softmax_smoke_only_not_multihead_kv_cache_or_production_compiler_backend"


class NpuLoweringError(ValueError):
    """Raised when a smoke graph cannot be mapped to the current e1 NPU ABI."""


@dataclass(frozen=True)
class LoweredMatmulResult:
    schema: str
    source_dialect: str
    source_op: str
    precision: str
    abi_opcode: int
    result: list[list[int]]
    golden: list[list[int]]
    cpu_fallback: bool
    tile_count: int
    tile_shape_limit: dict[str, int]
    tiled_dispatch: bool
    split_k: bool
    host_accumulates_partials: bool
    claim_boundary: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": self.schema,
            "source_dialect": self.source_dialect,
            "source_op": self.source_op,
            "precision": self.precision,
            "abi_opcode": self.abi_opcode,
            "result": self.result,
            "golden": self.golden,
            "cpu_fallback": self.cpu_fallback,
            "tile_count": self.tile_count,
            "tile_shape_limit": self.tile_shape_limit,
            "tiled_dispatch": self.tiled_dispatch,
            "split_k": self.split_k,
            "host_accumulates_partials": self.host_accumulates_partials,
            "claim_boundary": self.claim_boundary,
        }


@dataclass(frozen=True)
class LoweredBatchMatmulResult:
    schema: str
    source_dialect: str
    source_op: str
    precision: str
    result: list[list[list[list[int]]]]
    golden: list[list[list[list[int]]]]
    matmuls: list[list[LoweredMatmulResult]]
    input_shape: list[int]
    output_shape: list[int]
    total_tile_count: int
    cpu_fallback: bool
    host_iterates_batch_heads: bool
    claim_boundary: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": self.schema,
            "source_dialect": self.source_dialect,
            "source_op": self.source_op,
            "precision": self.precision,
            "result": self.result,
            "golden": self.golden,
            "matmuls": [[matmul.as_dict() for matmul in batch] for batch in self.matmuls],
            "input_shape": self.input_shape,
            "output_shape": self.output_shape,
            "total_tile_count": self.total_tile_count,
            "cpu_fallback": self.cpu_fallback,
            "host_iterates_batch_heads": self.host_iterates_batch_heads,
            "claim_boundary": self.claim_boundary,
        }


@dataclass(frozen=True)
class LoweredQkvProjectionResult:
    schema: str
    source_dialect: str
    source_op: str
    precision: str
    packed_accumulator: list[list[int]]
    q_accumulator: list[list[int]]
    k_accumulator: list[list[int]]
    v_accumulator: list[list[int]]
    q_requantized: list[list[int]]
    k_requantized: list[list[int]]
    v_requantized: list[list[int]]
    projection_shift: int
    packed_matmul: LoweredMatmulResult
    total_tile_count: int
    cpu_fallback: bool
    host_slices_packed_qkv: bool
    host_requantizes_qkv: bool
    claim_boundary: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": self.schema,
            "source_dialect": self.source_dialect,
            "source_op": self.source_op,
            "precision": self.precision,
            "packed_accumulator": self.packed_accumulator,
            "q_accumulator": self.q_accumulator,
            "k_accumulator": self.k_accumulator,
            "v_accumulator": self.v_accumulator,
            "q_requantized": self.q_requantized,
            "k_requantized": self.k_requantized,
            "v_requantized": self.v_requantized,
            "projection_shift": self.projection_shift,
            "packed_matmul": self.packed_matmul.as_dict(),
            "total_tile_count": self.total_tile_count,
            "cpu_fallback": self.cpu_fallback,
            "host_slices_packed_qkv": self.host_slices_packed_qkv,
            "host_requantizes_qkv": self.host_requantizes_qkv,
            "claim_boundary": self.claim_boundary,
        }


@dataclass(frozen=True)
class LoweredSparseInt4MatmulResult:
    schema: str
    source_dialect: str
    source_op: str
    precision: str
    abi_opcode: int
    result: list[list[int]]
    golden: list[list[int]]
    input_shape: list[int]
    output_shape: list[int]
    sparse_block_count: int
    sdot4_count: int
    padded_k: int
    cpu_fallback: bool
    host_pads_k_to_sparse_blocks: bool
    host_uses_2_4_metadata: bool
    claim_boundary: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": self.schema,
            "source_dialect": self.source_dialect,
            "source_op": self.source_op,
            "precision": self.precision,
            "abi_opcode": self.abi_opcode,
            "result": self.result,
            "golden": self.golden,
            "input_shape": self.input_shape,
            "output_shape": self.output_shape,
            "sparse_block_count": self.sparse_block_count,
            "sdot4_count": self.sdot4_count,
            "padded_k": self.padded_k,
            "cpu_fallback": self.cpu_fallback,
            "host_pads_k_to_sparse_blocks": self.host_pads_k_to_sparse_blocks,
            "host_uses_2_4_metadata": self.host_uses_2_4_metadata,
            "claim_boundary": self.claim_boundary,
        }


@dataclass(frozen=True)
class LoweredGroupScaledInt4MatmulResult:
    schema: str
    source_dialect: str
    source_op: str
    precision: str
    result_q8_8: list[list[int]]
    golden_q8_8: list[list[int]]
    group_dot_products: list[list[list[int]]]
    input_shape: list[int]
    output_shape: list[int]
    group_size: int
    group_count: int
    scalar_mul_count: int
    scalar_add_count: int
    cpu_fallback: bool
    host_applies_group_scales: bool
    host_uses_q8_8_scales: bool
    claim_boundary: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": self.schema,
            "source_dialect": self.source_dialect,
            "source_op": self.source_op,
            "precision": self.precision,
            "result_q8_8": self.result_q8_8,
            "golden_q8_8": self.golden_q8_8,
            "group_dot_products": self.group_dot_products,
            "input_shape": self.input_shape,
            "output_shape": self.output_shape,
            "group_size": self.group_size,
            "group_count": self.group_count,
            "scalar_mul_count": self.scalar_mul_count,
            "scalar_add_count": self.scalar_add_count,
            "cpu_fallback": self.cpu_fallback,
            "host_applies_group_scales": self.host_applies_group_scales,
            "host_uses_q8_8_scales": self.host_uses_q8_8_scales,
            "claim_boundary": self.claim_boundary,
        }


@dataclass(frozen=True)
class LoweredInt2MatmulResult:
    schema: str
    source_dialect: str
    source_op: str
    precision: str
    abi_opcode: int
    result: list[list[int]]
    golden: list[list[int]]
    input_shape: list[int]
    output_shape: list[int]
    dot16_count: int
    padded_k: int
    cpu_fallback: bool
    host_pads_k_to_dot16: bool
    claim_boundary: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": self.schema,
            "source_dialect": self.source_dialect,
            "source_op": self.source_op,
            "precision": self.precision,
            "abi_opcode": self.abi_opcode,
            "result": self.result,
            "golden": self.golden,
            "input_shape": self.input_shape,
            "output_shape": self.output_shape,
            "dot16_count": self.dot16_count,
            "padded_k": self.padded_k,
            "cpu_fallback": self.cpu_fallback,
            "host_pads_k_to_dot16": self.host_pads_k_to_dot16,
            "claim_boundary": self.claim_boundary,
        }


@dataclass(frozen=True)
class LoweredFp8MatmulResult:
    schema: str
    source_dialect: str
    source_op: str
    precision: str
    abi_opcode: int
    result_q8_8: list[list[int]]
    golden_q8_8: list[list[int]]
    input_shape: list[int]
    output_shape: list[int]
    dot4_count: int
    padded_k: int
    cpu_fallback: bool
    host_pads_k_to_dot4: bool
    claim_boundary: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": self.schema,
            "source_dialect": self.source_dialect,
            "source_op": self.source_op,
            "precision": self.precision,
            "abi_opcode": self.abi_opcode,
            "result_q8_8": self.result_q8_8,
            "golden_q8_8": self.golden_q8_8,
            "input_shape": self.input_shape,
            "output_shape": self.output_shape,
            "dot4_count": self.dot4_count,
            "padded_k": self.padded_k,
            "cpu_fallback": self.cpu_fallback,
            "host_pads_k_to_dot4": self.host_pads_k_to_dot4,
            "claim_boundary": self.claim_boundary,
        }


@dataclass(frozen=True)
class LoweredFloat16MatmulResult:
    schema: str
    source_dialect: str
    source_op: str
    precision: str
    result_q8_8: list[list[int]]
    golden_q8_8: list[list[int]]
    lhs_q8_8: list[list[int]]
    rhs_q8_8: list[list[int]]
    input_shape: list[int]
    output_shape: list[int]
    scalar_mul_count: int
    scalar_add_count: int
    cpu_fallback: bool
    host_converts_float16_to_q8_8: bool
    host_requantizes_products: bool
    claim_boundary: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": self.schema,
            "source_dialect": self.source_dialect,
            "source_op": self.source_op,
            "precision": self.precision,
            "result_q8_8": self.result_q8_8,
            "golden_q8_8": self.golden_q8_8,
            "lhs_q8_8": self.lhs_q8_8,
            "rhs_q8_8": self.rhs_q8_8,
            "input_shape": self.input_shape,
            "output_shape": self.output_shape,
            "scalar_mul_count": self.scalar_mul_count,
            "scalar_add_count": self.scalar_add_count,
            "cpu_fallback": self.cpu_fallback,
            "host_converts_float16_to_q8_8": self.host_converts_float16_to_q8_8,
            "host_requantizes_products": self.host_requantizes_products,
            "claim_boundary": self.claim_boundary,
        }


@dataclass(frozen=True)
class LoweredConv2dResult:
    schema: str
    source_dialect: str
    source_op: str
    precision: str
    output: list[list[list[list[int]]]]
    golden: list[list[list[list[int]]]]
    output_shape: list[int]
    im2col_shape: list[int]
    filter_matrix_shape: list[int]
    matmul: LoweredMatmulResult
    cpu_fallback: bool
    host_materializes_im2col: bool
    claim_boundary: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": self.schema,
            "source_dialect": self.source_dialect,
            "source_op": self.source_op,
            "precision": self.precision,
            "output": self.output,
            "golden": self.golden,
            "output_shape": self.output_shape,
            "im2col_shape": self.im2col_shape,
            "filter_matrix_shape": self.filter_matrix_shape,
            "matmul": self.matmul.as_dict(),
            "cpu_fallback": self.cpu_fallback,
            "host_materializes_im2col": self.host_materializes_im2col,
            "claim_boundary": self.claim_boundary,
        }


@dataclass(frozen=True)
class LoweredDepthwiseConv2dResult:
    schema: str
    source_dialect: str
    source_op: str
    precision: str
    output: list[list[list[list[int]]]]
    golden: list[list[list[list[int]]]]
    output_shape: list[int]
    input_channels: int
    channel_multiplier: int
    scalar_mul_count: int
    scalar_add_count: int
    cpu_fallback: bool
    host_uses_direct_depthwise_loops: bool
    host_materializes_im2col: bool
    claim_boundary: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": self.schema,
            "source_dialect": self.source_dialect,
            "source_op": self.source_op,
            "precision": self.precision,
            "output": self.output,
            "golden": self.golden,
            "output_shape": self.output_shape,
            "input_channels": self.input_channels,
            "channel_multiplier": self.channel_multiplier,
            "scalar_mul_count": self.scalar_mul_count,
            "scalar_add_count": self.scalar_add_count,
            "cpu_fallback": self.cpu_fallback,
            "host_uses_direct_depthwise_loops": self.host_uses_direct_depthwise_loops,
            "host_materializes_im2col": self.host_materializes_im2col,
            "claim_boundary": self.claim_boundary,
        }


@dataclass(frozen=True)
class LoweredGroupedConv2dResult:
    schema: str
    source_dialect: str
    source_op: str
    precision: str
    output: list[list[list[list[int]]]]
    golden: list[list[list[list[int]]]]
    output_shape: list[int]
    groups: int
    input_channels_per_group: int
    output_channels_per_group: int
    scalar_mul_count: int
    scalar_add_count: int
    cpu_fallback: bool
    host_uses_direct_grouped_loops: bool
    host_materializes_im2col: bool
    claim_boundary: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": self.schema,
            "source_dialect": self.source_dialect,
            "source_op": self.source_op,
            "precision": self.precision,
            "output": self.output,
            "golden": self.golden,
            "output_shape": self.output_shape,
            "groups": self.groups,
            "input_channels_per_group": self.input_channels_per_group,
            "output_channels_per_group": self.output_channels_per_group,
            "scalar_mul_count": self.scalar_mul_count,
            "scalar_add_count": self.scalar_add_count,
            "cpu_fallback": self.cpu_fallback,
            "host_uses_direct_grouped_loops": self.host_uses_direct_grouped_loops,
            "host_materializes_im2col": self.host_materializes_im2col,
            "claim_boundary": self.claim_boundary,
        }


@dataclass(frozen=True)
class LoweredAttentionQkResult:
    schema: str
    source_dialect: str
    source_op: str
    precision: str
    scores: list[list[list[list[int]]]]
    golden: list[list[list[list[int]]]]
    score_shape: list[int]
    head_count: int
    head_dim: int
    matmuls: list[LoweredMatmulResult]
    total_tile_count: int
    cpu_fallback: bool
    host_transposes_keys: bool
    host_iterates_heads: bool
    claim_boundary: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": self.schema,
            "source_dialect": self.source_dialect,
            "source_op": self.source_op,
            "precision": self.precision,
            "scores": self.scores,
            "golden": self.golden,
            "score_shape": self.score_shape,
            "head_count": self.head_count,
            "head_dim": self.head_dim,
            "matmuls": [matmul.as_dict() for matmul in self.matmuls],
            "total_tile_count": self.total_tile_count,
            "cpu_fallback": self.cpu_fallback,
            "host_transposes_keys": self.host_transposes_keys,
            "host_iterates_heads": self.host_iterates_heads,
            "claim_boundary": self.claim_boundary,
        }


@dataclass(frozen=True)
class LoweredAttentionSoftmaxResult:
    schema: str
    source_dialect: str
    source_op: str
    precision: str
    logits: list[list[list[list[int]]]]
    mask: list[list[list[list[bool]]]]
    weights_q0_8: list[list[list[list[int]]]]
    row_max: list[list[list[int]]]
    exp_q0_8: list[list[list[list[int]]]]
    row_sum_exp: list[list[list[int]]]
    scalar_max_count: int
    scalar_sub_count: int
    scalar_exp_count: int
    scalar_add_count: int
    cpu_fallback: bool
    host_applies_mask: bool
    host_divides_by_row_sum: bool
    claim_boundary: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": self.schema,
            "source_dialect": self.source_dialect,
            "source_op": self.source_op,
            "precision": self.precision,
            "logits": self.logits,
            "mask": self.mask,
            "weights_q0_8": self.weights_q0_8,
            "row_max": self.row_max,
            "exp_q0_8": self.exp_q0_8,
            "row_sum_exp": self.row_sum_exp,
            "scalar_max_count": self.scalar_max_count,
            "scalar_sub_count": self.scalar_sub_count,
            "scalar_exp_count": self.scalar_exp_count,
            "scalar_add_count": self.scalar_add_count,
            "cpu_fallback": self.cpu_fallback,
            "host_applies_mask": self.host_applies_mask,
            "host_divides_by_row_sum": self.host_divides_by_row_sum,
            "claim_boundary": self.claim_boundary,
        }


@dataclass(frozen=True)
class LoweredAttentionAvResult:
    schema: str
    source_dialect: str
    source_op: str
    precision: str
    context: list[list[list[list[int]]]]
    golden: list[list[list[list[int]]]]
    context_shape: list[int]
    head_count: int
    value_dim: int
    matmuls: list[LoweredMatmulResult]
    total_tile_count: int
    cpu_fallback: bool
    host_iterates_heads: bool
    requires_prequantized_attention: bool
    claim_boundary: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": self.schema,
            "source_dialect": self.source_dialect,
            "source_op": self.source_op,
            "precision": self.precision,
            "context": self.context,
            "golden": self.golden,
            "context_shape": self.context_shape,
            "head_count": self.head_count,
            "value_dim": self.value_dim,
            "matmuls": [matmul.as_dict() for matmul in self.matmuls],
            "total_tile_count": self.total_tile_count,
            "cpu_fallback": self.cpu_fallback,
            "host_iterates_heads": self.host_iterates_heads,
            "requires_prequantized_attention": self.requires_prequantized_attention,
            "claim_boundary": self.claim_boundary,
        }


@dataclass(frozen=True)
class LoweredAttentionResult:
    schema: str
    source_dialect: str
    source_op: str
    precision: str
    qk_scores: LoweredAttentionQkResult
    qk_logits_s8: list[list[list[list[int]]]]
    attention_mask: list[list[list[list[bool]]]]
    attention_softmax: LoweredAttentionSoftmaxResult
    attention_weights_s8: list[list[list[list[int]]]]
    attention_av: LoweredAttentionAvResult
    context_requantized: list[list[list[list[int]]]]
    head_count: int
    total_tile_count: int
    scalar_add_count: int
    cpu_fallback: bool
    computes_qk_scores: bool
    computes_attention_softmax: bool
    requires_prequantized_attention: bool
    host_generates_causal_mask: bool
    host_generates_sliding_window_mask: bool
    host_requantizes_qk_scores: bool
    host_requantizes_attention_weights: bool
    host_requantizes_context: bool
    claim_boundary: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": self.schema,
            "source_dialect": self.source_dialect,
            "source_op": self.source_op,
            "precision": self.precision,
            "qk_scores": self.qk_scores.as_dict(),
            "qk_logits_s8": self.qk_logits_s8,
            "attention_mask": self.attention_mask,
            "attention_softmax": self.attention_softmax.as_dict(),
            "attention_weights_s8": self.attention_weights_s8,
            "attention_av": self.attention_av.as_dict(),
            "context_requantized": self.context_requantized,
            "head_count": self.head_count,
            "total_tile_count": self.total_tile_count,
            "scalar_add_count": self.scalar_add_count,
            "cpu_fallback": self.cpu_fallback,
            "computes_qk_scores": self.computes_qk_scores,
            "computes_attention_softmax": self.computes_attention_softmax,
            "requires_prequantized_attention": self.requires_prequantized_attention,
            "host_generates_causal_mask": self.host_generates_causal_mask,
            "host_generates_sliding_window_mask": self.host_generates_sliding_window_mask,
            "host_requantizes_qk_scores": self.host_requantizes_qk_scores,
            "host_requantizes_attention_weights": self.host_requantizes_attention_weights,
            "host_requantizes_context": self.host_requantizes_context,
            "claim_boundary": self.claim_boundary,
        }


@dataclass(frozen=True)
class LoweredKvCacheUpdateResult:
    schema: str
    source_dialect: str
    source_op: str
    precision: str
    updated_key_cache: list[list[list[list[int]]]]
    updated_value_cache: list[list[list[list[int]]]]
    cache_lengths: list[list[int]]
    appended_tokens: int
    head_count: int
    head_dim: int
    value_dim: int
    scalar_copy_count: int
    cpu_fallback: bool
    host_preserves_existing_cache: bool
    host_tracks_cache_lengths: bool
    claim_boundary: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": self.schema,
            "source_dialect": self.source_dialect,
            "source_op": self.source_op,
            "precision": self.precision,
            "updated_key_cache": self.updated_key_cache,
            "updated_value_cache": self.updated_value_cache,
            "cache_lengths": self.cache_lengths,
            "appended_tokens": self.appended_tokens,
            "head_count": self.head_count,
            "head_dim": self.head_dim,
            "value_dim": self.value_dim,
            "scalar_copy_count": self.scalar_copy_count,
            "cpu_fallback": self.cpu_fallback,
            "host_preserves_existing_cache": self.host_preserves_existing_cache,
            "host_tracks_cache_lengths": self.host_tracks_cache_lengths,
            "claim_boundary": self.claim_boundary,
        }


@dataclass(frozen=True)
class LoweredDecodeAttentionResult:
    schema: str
    source_dialect: str
    source_op: str
    precision: str
    kv_cache_update: LoweredKvCacheUpdateResult
    attention: LoweredAttentionResult
    attention_key_cache_view: list[list[list[list[int]]]]
    attention_value_cache_view: list[list[list[list[int]]]]
    attention_mask: list[list[list[list[bool]]]]
    updated_cache_lengths: list[list[int]]
    max_attention_cache_length: int
    total_tile_count: int
    scalar_add_count: int
    cpu_fallback: bool
    updates_kv_cache: bool
    computes_attention_over_cache: bool
    host_materializes_cache_view: bool
    host_applies_decode_cache_window: bool
    decode_cache_window: int | None
    claim_boundary: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": self.schema,
            "source_dialect": self.source_dialect,
            "source_op": self.source_op,
            "precision": self.precision,
            "kv_cache_update": self.kv_cache_update.as_dict(),
            "attention": self.attention.as_dict(),
            "attention_key_cache_view": self.attention_key_cache_view,
            "attention_value_cache_view": self.attention_value_cache_view,
            "attention_mask": self.attention_mask,
            "updated_cache_lengths": self.updated_cache_lengths,
            "max_attention_cache_length": self.max_attention_cache_length,
            "total_tile_count": self.total_tile_count,
            "scalar_add_count": self.scalar_add_count,
            "cpu_fallback": self.cpu_fallback,
            "updates_kv_cache": self.updates_kv_cache,
            "computes_attention_over_cache": self.computes_attention_over_cache,
            "host_materializes_cache_view": self.host_materializes_cache_view,
            "host_applies_decode_cache_window": self.host_applies_decode_cache_window,
            "decode_cache_window": self.decode_cache_window,
            "claim_boundary": self.claim_boundary,
        }


@dataclass(frozen=True)
class LoweredMlpResult:
    schema: str
    source_dialect: str
    source_op: str
    precision: str
    activation: str
    output: list[list[int]]
    golden: list[list[int]]
    hidden_accumulator: list[list[int]]
    hidden_requantized: list[list[int]]
    hidden_activated: list[list[int]]
    requant_shift: int
    up_matmul: LoweredMatmulResult
    down_matmul: LoweredMatmulResult
    total_tile_count: int
    cpu_fallback: bool
    host_requantizes_hidden: bool
    activation_opcode: str
    claim_boundary: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": self.schema,
            "source_dialect": self.source_dialect,
            "source_op": self.source_op,
            "precision": self.precision,
            "activation": self.activation,
            "output": self.output,
            "golden": self.golden,
            "hidden_accumulator": self.hidden_accumulator,
            "hidden_requantized": self.hidden_requantized,
            "hidden_activated": self.hidden_activated,
            "requant_shift": self.requant_shift,
            "up_matmul": self.up_matmul.as_dict(),
            "down_matmul": self.down_matmul.as_dict(),
            "total_tile_count": self.total_tile_count,
            "cpu_fallback": self.cpu_fallback,
            "host_requantizes_hidden": self.host_requantizes_hidden,
            "activation_opcode": self.activation_opcode,
            "claim_boundary": self.claim_boundary,
        }


@dataclass(frozen=True)
class LoweredSwiGLUResult:
    schema: str
    source_dialect: str
    source_op: str
    precision: str
    activation: str
    output: list[list[int]]
    golden: list[list[int]]
    up_accumulator: list[list[int]]
    gate_accumulator: list[list[int]]
    up_requantized: list[list[int]]
    gate_requantized: list[list[int]]
    gate_activated: list[list[int]]
    gated_hidden: list[list[int]]
    requant_shift: int
    gate_shift: int
    up_matmul: LoweredMatmulResult
    gate_matmul: LoweredMatmulResult
    gate_activation_result: LoweredSiluResult | None
    down_matmul: LoweredMatmulResult
    total_tile_count: int
    scalar_mul_count: int
    cpu_fallback: bool
    host_requantizes_hidden: bool
    host_applies_gate_shift_and_saturation: bool
    claim_boundary: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": self.schema,
            "source_dialect": self.source_dialect,
            "source_op": self.source_op,
            "precision": self.precision,
            "activation": self.activation,
            "output": self.output,
            "golden": self.golden,
            "up_accumulator": self.up_accumulator,
            "gate_accumulator": self.gate_accumulator,
            "up_requantized": self.up_requantized,
            "gate_requantized": self.gate_requantized,
            "gate_activated": self.gate_activated,
            "gated_hidden": self.gated_hidden,
            "requant_shift": self.requant_shift,
            "gate_shift": self.gate_shift,
            "up_matmul": self.up_matmul.as_dict(),
            "gate_matmul": self.gate_matmul.as_dict(),
            "gate_activation_result": (
                None
                if self.gate_activation_result is None
                else self.gate_activation_result.as_dict()
            ),
            "down_matmul": self.down_matmul.as_dict(),
            "total_tile_count": self.total_tile_count,
            "scalar_mul_count": self.scalar_mul_count,
            "cpu_fallback": self.cpu_fallback,
            "host_requantizes_hidden": self.host_requantizes_hidden,
            "host_applies_gate_shift_and_saturation": self.host_applies_gate_shift_and_saturation,
            "claim_boundary": self.claim_boundary,
        }


@dataclass(frozen=True)
class LoweredSiluResult:
    schema: str
    source_dialect: str
    source_op: str
    precision: str
    input: list[list[int]]
    sigmoid_q0_8: list[list[int]]
    output: list[list[int]]
    golden: list[list[int]]
    shape: list[int]
    element_count: int
    scalar_exp2_count: int
    scalar_sub_count: int
    scalar_mul_count: int
    cpu_fallback: bool
    host_applies_shift_and_saturation: bool
    approximation: str
    claim_boundary: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": self.schema,
            "source_dialect": self.source_dialect,
            "source_op": self.source_op,
            "precision": self.precision,
            "input": self.input,
            "sigmoid_q0_8": self.sigmoid_q0_8,
            "output": self.output,
            "golden": self.golden,
            "shape": self.shape,
            "element_count": self.element_count,
            "scalar_exp2_count": self.scalar_exp2_count,
            "scalar_sub_count": self.scalar_sub_count,
            "scalar_mul_count": self.scalar_mul_count,
            "cpu_fallback": self.cpu_fallback,
            "host_applies_shift_and_saturation": self.host_applies_shift_and_saturation,
            "approximation": self.approximation,
            "claim_boundary": self.claim_boundary,
        }


@dataclass(frozen=True)
class LoweredGeluResult:
    schema: str
    source_dialect: str
    source_op: str
    precision: str
    input: list[list[int]]
    scaled_input: list[list[int]]
    sigmoid_q0_8: list[list[int]]
    output: list[list[int]]
    golden: list[list[int]]
    shape: list[int]
    element_count: int
    scalar_scale_mul_count: int
    scalar_exp2_count: int
    scalar_sub_count: int
    scalar_gate_mul_count: int
    cpu_fallback: bool
    host_applies_shift_and_saturation: bool
    approximation: str
    claim_boundary: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": self.schema,
            "source_dialect": self.source_dialect,
            "source_op": self.source_op,
            "precision": self.precision,
            "input": self.input,
            "scaled_input": self.scaled_input,
            "sigmoid_q0_8": self.sigmoid_q0_8,
            "output": self.output,
            "golden": self.golden,
            "shape": self.shape,
            "element_count": self.element_count,
            "scalar_scale_mul_count": self.scalar_scale_mul_count,
            "scalar_exp2_count": self.scalar_exp2_count,
            "scalar_sub_count": self.scalar_sub_count,
            "scalar_gate_mul_count": self.scalar_gate_mul_count,
            "cpu_fallback": self.cpu_fallback,
            "host_applies_shift_and_saturation": self.host_applies_shift_and_saturation,
            "approximation": self.approximation,
            "claim_boundary": self.claim_boundary,
        }


@dataclass(frozen=True)
class LoweredResidualAddResult:
    schema: str
    source_dialect: str
    source_op: str
    precision: str
    result: list[list[int]]
    golden: list[list[int]]
    shape: list[int]
    element_count: int
    scalar_add_count: int
    cpu_fallback: bool
    host_saturates_int8: bool
    claim_boundary: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": self.schema,
            "source_dialect": self.source_dialect,
            "source_op": self.source_op,
            "precision": self.precision,
            "result": self.result,
            "golden": self.golden,
            "shape": self.shape,
            "element_count": self.element_count,
            "scalar_add_count": self.scalar_add_count,
            "cpu_fallback": self.cpu_fallback,
            "host_saturates_int8": self.host_saturates_int8,
            "claim_boundary": self.claim_boundary,
        }


@dataclass(frozen=True)
class LoweredBiasAddResult:
    schema: str
    source_dialect: str
    source_op: str
    precision: str
    result: list[list[int]]
    golden: list[list[int]]
    input_shape: list[int]
    bias_shape: list[int]
    element_count: int
    scalar_add_count: int
    cpu_fallback: bool
    host_broadcasts_bias: bool
    host_saturates_int8: bool
    claim_boundary: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": self.schema,
            "source_dialect": self.source_dialect,
            "source_op": self.source_op,
            "precision": self.precision,
            "result": self.result,
            "golden": self.golden,
            "input_shape": self.input_shape,
            "bias_shape": self.bias_shape,
            "element_count": self.element_count,
            "scalar_add_count": self.scalar_add_count,
            "cpu_fallback": self.cpu_fallback,
            "host_broadcasts_bias": self.host_broadcasts_bias,
            "host_saturates_int8": self.host_saturates_int8,
            "claim_boundary": self.claim_boundary,
        }


@dataclass(frozen=True)
class LoweredRopeResult:
    schema: str
    source_dialect: str
    source_op: str
    precision: str
    output: list[list[int]]
    golden: list[list[int]]
    input_shape: list[int]
    trig_shape: list[int]
    scale_shift: int
    scalar_mul_count: int
    scalar_add_count: int
    cpu_fallback: bool
    host_applies_shift_and_saturation: bool
    claim_boundary: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": self.schema,
            "source_dialect": self.source_dialect,
            "source_op": self.source_op,
            "precision": self.precision,
            "output": self.output,
            "golden": self.golden,
            "input_shape": self.input_shape,
            "trig_shape": self.trig_shape,
            "scale_shift": self.scale_shift,
            "scalar_mul_count": self.scalar_mul_count,
            "scalar_add_count": self.scalar_add_count,
            "cpu_fallback": self.cpu_fallback,
            "host_applies_shift_and_saturation": self.host_applies_shift_and_saturation,
            "claim_boundary": self.claim_boundary,
        }


@dataclass(frozen=True)
class LoweredRmsNormResult:
    schema: str
    source_dialect: str
    source_op: str
    precision: str
    output: list[list[int]]
    golden: list[list[int]]
    input_shape: list[int]
    weight_shape: list[int]
    row_sum_squares: list[int]
    row_rms: list[int]
    row_inv_rms_q: list[int]
    inv_rms_shift: int
    output_shift: int
    scalar_mul_count: int
    scalar_add_count: int
    cpu_fallback: bool
    host_computes_reciprocal_rms: bool
    host_applies_shift_and_saturation: bool
    claim_boundary: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": self.schema,
            "source_dialect": self.source_dialect,
            "source_op": self.source_op,
            "precision": self.precision,
            "output": self.output,
            "golden": self.golden,
            "input_shape": self.input_shape,
            "weight_shape": self.weight_shape,
            "row_sum_squares": self.row_sum_squares,
            "row_rms": self.row_rms,
            "row_inv_rms_q": self.row_inv_rms_q,
            "inv_rms_shift": self.inv_rms_shift,
            "output_shift": self.output_shift,
            "scalar_mul_count": self.scalar_mul_count,
            "scalar_add_count": self.scalar_add_count,
            "cpu_fallback": self.cpu_fallback,
            "host_computes_reciprocal_rms": self.host_computes_reciprocal_rms,
            "host_applies_shift_and_saturation": self.host_applies_shift_and_saturation,
            "claim_boundary": self.claim_boundary,
        }


@dataclass(frozen=True)
class LoweredTransformerBlockResult:
    schema: str
    source_dialect: str
    source_op: str
    precision: str
    output: list[list[int]]
    attention_context: list[list[int]]
    attention_projected: list[list[int]]
    post_attention_residual: list[list[int]]
    mlp_output: list[list[int]]
    attention_av: LoweredAttentionAvResult
    attention_bias: LoweredBiasAddResult
    attention_residual: LoweredResidualAddResult
    mlp: LoweredMlpResult
    output_residual: LoweredResidualAddResult
    total_tile_count: int
    scalar_add_count: int
    cpu_fallback: bool
    requires_prequantized_attention: bool
    claim_boundary: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": self.schema,
            "source_dialect": self.source_dialect,
            "source_op": self.source_op,
            "precision": self.precision,
            "output": self.output,
            "attention_context": self.attention_context,
            "attention_projected": self.attention_projected,
            "post_attention_residual": self.post_attention_residual,
            "mlp_output": self.mlp_output,
            "attention_av": self.attention_av.as_dict(),
            "attention_bias": self.attention_bias.as_dict(),
            "attention_residual": self.attention_residual.as_dict(),
            "mlp": self.mlp.as_dict(),
            "output_residual": self.output_residual.as_dict(),
            "total_tile_count": self.total_tile_count,
            "scalar_add_count": self.scalar_add_count,
            "cpu_fallback": self.cpu_fallback,
            "requires_prequantized_attention": self.requires_prequantized_attention,
            "claim_boundary": self.claim_boundary,
        }


@dataclass(frozen=True)
class LoweredModernDecoderBlockResult:
    schema: str
    source_dialect: str
    source_op: str
    precision: str
    output: list[list[int]]
    norm1: LoweredRmsNormResult
    q_projection: LoweredMatmulResult | None
    k_projection: LoweredMatmulResult | None
    v_projection: LoweredMatmulResult | None
    qkv_projection: LoweredQkvProjectionResult | None
    q_requantized: list[list[int]]
    k_requantized: list[list[int]]
    v_requantized: list[list[int]]
    q_rope: LoweredRopeResult
    k_rope: LoweredRopeResult
    qk_scores: LoweredAttentionQkResult
    qk_logits_s8: list[list[list[list[int]]]]
    attention_softmax: LoweredAttentionSoftmaxResult
    attention_weights_s8: list[list[list[list[int]]]]
    attention_av: LoweredAttentionAvResult
    attention_context_requantized: list[list[int]]
    attention_bias: LoweredBiasAddResult
    attention_residual: LoweredResidualAddResult
    norm2: LoweredRmsNormResult
    swiglu: LoweredSwiGLUResult
    output_residual: LoweredResidualAddResult
    total_tile_count: int
    scalar_add_count: int
    scalar_mul_count: int
    cpu_fallback: bool
    computes_qk_scores: bool
    computes_attention_softmax: bool
    requires_prequantized_attention: bool
    host_generates_causal_mask: bool
    host_generates_sliding_window_mask: bool
    host_slices_packed_qkv: bool
    host_requantizes_qkv: bool
    host_requantizes_qk_scores: bool
    host_requantizes_attention_weights: bool
    claim_boundary: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": self.schema,
            "source_dialect": self.source_dialect,
            "source_op": self.source_op,
            "precision": self.precision,
            "output": self.output,
            "norm1": self.norm1.as_dict(),
            "q_projection": None if self.q_projection is None else self.q_projection.as_dict(),
            "k_projection": None if self.k_projection is None else self.k_projection.as_dict(),
            "v_projection": None if self.v_projection is None else self.v_projection.as_dict(),
            "qkv_projection": None
            if self.qkv_projection is None
            else self.qkv_projection.as_dict(),
            "q_requantized": self.q_requantized,
            "k_requantized": self.k_requantized,
            "v_requantized": self.v_requantized,
            "q_rope": self.q_rope.as_dict(),
            "k_rope": self.k_rope.as_dict(),
            "qk_scores": self.qk_scores.as_dict(),
            "qk_logits_s8": self.qk_logits_s8,
            "attention_softmax": self.attention_softmax.as_dict(),
            "attention_weights_s8": self.attention_weights_s8,
            "attention_av": self.attention_av.as_dict(),
            "attention_context_requantized": self.attention_context_requantized,
            "attention_bias": self.attention_bias.as_dict(),
            "attention_residual": self.attention_residual.as_dict(),
            "norm2": self.norm2.as_dict(),
            "swiglu": self.swiglu.as_dict(),
            "output_residual": self.output_residual.as_dict(),
            "total_tile_count": self.total_tile_count,
            "scalar_add_count": self.scalar_add_count,
            "scalar_mul_count": self.scalar_mul_count,
            "cpu_fallback": self.cpu_fallback,
            "computes_qk_scores": self.computes_qk_scores,
            "computes_attention_softmax": self.computes_attention_softmax,
            "requires_prequantized_attention": self.requires_prequantized_attention,
            "host_generates_causal_mask": self.host_generates_causal_mask,
            "host_generates_sliding_window_mask": self.host_generates_sliding_window_mask,
            "host_slices_packed_qkv": self.host_slices_packed_qkv,
            "host_requantizes_qkv": self.host_requantizes_qkv,
            "host_requantizes_qk_scores": self.host_requantizes_qk_scores,
            "host_requantizes_attention_weights": self.host_requantizes_attention_weights,
            "claim_boundary": self.claim_boundary,
        }


@dataclass(frozen=True)
class LoweredStableHloModuleResult:
    schema: str
    source_dialect: str
    module_name: str
    op_count: int
    dispatch_order: tuple[str, ...]
    lowering_graphs: tuple[dict[str, Any], ...]
    lowering_plans: tuple[dict[str, Any], ...]
    lowered_ops: tuple[Any, ...]
    runtime_apis: tuple[str, ...]
    cpu_fallback: bool
    all_npu_dispatch: bool
    claim_boundary: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": self.schema,
            "source_dialect": self.source_dialect,
            "module_name": self.module_name,
            "op_count": self.op_count,
            "dispatch_order": list(self.dispatch_order),
            "lowering_graphs": list(self.lowering_graphs),
            "lowering_plans": list(self.lowering_plans),
            "lowered_ops": [_lowered_result_as_dict(op) for op in self.lowered_ops],
            "runtime_apis": list(self.runtime_apis),
            "cpu_fallback": self.cpu_fallback,
            "all_npu_dispatch": self.all_npu_dispatch,
            "claim_boundary": self.claim_boundary,
        }


def lower_matmul_smoke(runtime: E1NpuRuntime, graph: dict[str, Any]) -> LoweredMatmulResult:
    """Lower one tiny matmul-like op to the current MMIO GEMM ABI.

    This is deliberately a smoke-path adapter, not a graph compiler. It accepts
    one statically shaped matmul record and dispatches to the bounded GEMM_S8 or
    GEMM_S4 runtime path. M/N/K dimensions may be split into multiple hardware
    tile commands. The NPU performs every tile MAC; host code only stitches
    complete output tiles and accumulates int32 partial outputs across split-K
    chunks.
    """

    if graph.get("schema") != SUPPORTED_SCHEMA:
        raise NpuLoweringError(f"unsupported graph schema {graph.get('schema')!r}")
    source_op = str(graph.get("op", ""))
    if source_op not in SUPPORTED_MATMUL_OPS:
        raise NpuLoweringError(f"unsupported matmul source op {source_op!r}")
    precision = str(graph.get("precision", "")).lower()
    if precision not in {"int8", "int4"}:
        raise NpuLoweringError(f"unsupported matmul precision {precision!r}")

    lhs = _matrix(graph.get("lhs"), "lhs")
    rhs = _matrix(graph.get("rhs"), "rhs")
    _validate_matmul_shape(lhs, rhs)

    if precision == "int8":
        _validate_range(lhs, -128, 127, "lhs")
        _validate_range(rhs, -128, 127, "rhs")
        golden = golden_gemm_s8(lhs, rhs)
        opcode = runtime.OP_GEMM_S8
        result, tile_count = _dispatch_tiled(runtime.gemm_s8, lhs, rhs)
    else:
        _validate_range(lhs, -8, 7, "lhs")
        _validate_range(rhs, -8, 7, "rhs")
        golden = golden_gemm_s4(lhs, rhs)
        opcode = runtime.OP_GEMM_S4
        result, tile_count = _dispatch_tiled(runtime.gemm_s4, lhs, rhs)

    return LoweredMatmulResult(
        schema="eliza.e1_npu_lowered_matmul_result.v1",
        source_dialect=str(graph.get("dialect", "unknown")),
        source_op=source_op,
        precision=precision,
        abi_opcode=opcode,
        result=result,
        golden=golden,
        cpu_fallback=False,
        tile_count=tile_count,
        tile_shape_limit={"m": MAX_TILE_M, "n": MAX_TILE_N, "k": MAX_TILE_K},
        tiled_dispatch=tile_count > 1,
        split_k=len(lhs[0]) > MAX_TILE_K,
        host_accumulates_partials=len(lhs[0]) > MAX_TILE_K,
        claim_boundary="single_matmul_tiled_smoke_only_not_production_compiler_backend",
    )


def lower_batch_matmul_smoke(
    runtime: E1NpuRuntime, graph: dict[str, Any]
) -> LoweredBatchMatmulResult:
    """Lower a bounded rank-4 batch/head matmul by reusing GEMM tiles."""

    if graph.get("schema") != SUPPORTED_BATCH_MATMUL_SCHEMA:
        raise NpuLoweringError(f"unsupported graph schema {graph.get('schema')!r}")
    source_op = str(graph.get("op", ""))
    if source_op not in SUPPORTED_BATCH_MATMUL_OPS:
        raise NpuLoweringError(f"unsupported batch_matmul source op {source_op!r}")
    precision = str(graph.get("precision", "")).lower()
    if precision not in {"int8", "int4"}:
        raise NpuLoweringError(f"unsupported batch_matmul precision {precision!r}")

    lhs = _tensor4(graph.get("lhs"), "lhs")
    rhs = _tensor4(graph.get("rhs"), "rhs")
    _validate_batch_matmul_shape(lhs, rhs)

    result: list[list[list[list[int]]]] = []
    golden: list[list[list[list[int]]]] = []
    matmuls: list[list[LoweredMatmulResult]] = []
    total_tile_count = 0
    for batch_index, (lhs_batch, rhs_batch) in enumerate(zip(lhs, rhs, strict=True)):
        result_batch: list[list[list[int]]] = []
        golden_batch: list[list[list[int]]] = []
        matmul_batch: list[LoweredMatmulResult] = []
        for head_index, (lhs_head, rhs_head) in enumerate(zip(lhs_batch, rhs_batch, strict=True)):
            matmul = lower_matmul_smoke(
                runtime,
                {
                    "schema": SUPPORTED_SCHEMA,
                    "dialect": str(graph.get("dialect", "unknown")),
                    "op": "stablehlo.dot_general",
                    "precision": precision,
                    "lhs": lhs_head,
                    "rhs": rhs_head,
                },
            )
            result_batch.append(matmul.result)
            golden_batch.append(matmul.golden)
            matmul_batch.append(matmul)
            total_tile_count += matmul.tile_count
            if matmul.cpu_fallback:
                raise NpuLoweringError(
                    f"batch_matmul slice [{batch_index}][{head_index}] used CPU fallback"
                )
        result.append(result_batch)
        golden.append(golden_batch)
        matmuls.append(matmul_batch)

    batch = len(lhs)
    heads = len(lhs[0])
    m = len(lhs[0][0])
    k = len(lhs[0][0][0])
    n = len(rhs[0][0][0])
    return LoweredBatchMatmulResult(
        schema="eliza.e1_npu_lowered_batch_matmul_result.v1",
        source_dialect=str(graph.get("dialect", "unknown")),
        source_op=source_op,
        precision=precision,
        result=result,
        golden=golden,
        matmuls=matmuls,
        input_shape=[batch, heads, m, k, n],
        output_shape=[batch, heads, m, n],
        total_tile_count=total_tile_count,
        cpu_fallback=False,
        host_iterates_batch_heads=True,
        claim_boundary=(
            "batch_matmul_reuses_tiled_matmul_smoke_only_not_tensor_batch_gemm_or_"
            "production_compiler_backend"
        ),
    )


def lower_qkv_projection_smoke(
    runtime: E1NpuRuntime, graph: dict[str, Any]
) -> LoweredQkvProjectionResult:
    """Lower a tiny packed QKV projection through one packed GEMM."""

    if graph.get("schema") != SUPPORTED_QKV_PROJECTION_SCHEMA:
        raise NpuLoweringError(f"unsupported graph schema {graph.get('schema')!r}")
    source_op = str(graph.get("op", ""))
    if source_op not in SUPPORTED_QKV_PROJECTION_OPS:
        raise NpuLoweringError(f"unsupported qkv_projection source op {source_op!r}")
    precision = str(graph.get("precision", "")).lower()
    if precision != "int8":
        raise NpuLoweringError(f"unsupported qkv_projection precision {precision!r}")

    inputs = _matrix(graph.get("input"), "input")
    packed_weight = _matrix(graph.get("packed_weight"), "packed_weight")
    _validate_qkv_projection_shape(inputs, packed_weight)
    projection_shift = _nonnegative_int(graph.get("projection_shift", 0), "projection_shift")
    if projection_shift > 31:
        raise NpuLoweringError("qkv_projection shift must be in 0..31")
    _validate_range(inputs, -128, 127, "input")
    _validate_range(packed_weight, -128, 127, "packed_weight")

    dialect = graph.get("dialect", "unknown")
    packed_matmul = lower_matmul_smoke(
        runtime,
        {
            "schema": SUPPORTED_SCHEMA,
            "dialect": dialect,
            "op": "stablehlo.dot_general",
            "precision": "int8",
            "lhs": inputs,
            "rhs": packed_weight,
        },
    )
    hidden_width = len(packed_weight[0]) // 3
    q_accumulator = _slice_columns(packed_matmul.result, 0, hidden_width)
    k_accumulator = _slice_columns(packed_matmul.result, hidden_width, hidden_width * 2)
    v_accumulator = _slice_columns(packed_matmul.result, hidden_width * 2, hidden_width * 3)

    return LoweredQkvProjectionResult(
        schema="eliza.e1_npu_lowered_qkv_projection_result.v1",
        source_dialect=str(dialect),
        source_op=source_op,
        precision=precision,
        packed_accumulator=packed_matmul.result,
        q_accumulator=q_accumulator,
        k_accumulator=k_accumulator,
        v_accumulator=v_accumulator,
        q_requantized=_requantize_s8_matrix(q_accumulator, projection_shift),
        k_requantized=_requantize_s8_matrix(k_accumulator, projection_shift),
        v_requantized=_requantize_s8_matrix(v_accumulator, projection_shift),
        projection_shift=projection_shift,
        packed_matmul=packed_matmul,
        total_tile_count=packed_matmul.tile_count,
        cpu_fallback=False,
        host_slices_packed_qkv=True,
        host_requantizes_qkv=True,
        claim_boundary=(
            "qkv_projection_packed_gemm_smoke_only_not_fused_attention_or_production_compiler_backend"
        ),
    )


def lower_sparse_int4_matmul_smoke(
    runtime: E1NpuRuntime, graph: dict[str, Any]
) -> LoweredSparseInt4MatmulResult:
    """Lower a tiny 2:4 sparse INT4 weight matmul through SDOT4_S4_2_4 commands."""

    if graph.get("schema") != SUPPORTED_SPARSE_INT4_MATMUL_SCHEMA:
        raise NpuLoweringError(f"unsupported graph schema {graph.get('schema')!r}")
    source_op = str(graph.get("op", ""))
    if source_op not in SUPPORTED_SPARSE_INT4_MATMUL_OPS:
        raise NpuLoweringError(f"unsupported sparse_int4_matmul source op {source_op!r}")
    precision = str(graph.get("precision", "")).lower()
    if precision not in {"int4", "sparse_int4", "s4_2_4"}:
        raise NpuLoweringError(f"unsupported sparse_int4_matmul precision {precision!r}")

    lhs = _matrix(graph.get("lhs"), "lhs")
    rhs_nonzero = _tensor3(graph.get("rhs_nonzero"), "rhs_nonzero")
    rhs_positions = _tensor3(graph.get("rhs_positions"), "rhs_positions")
    _validate_sparse_int4_matmul_shape(lhs, rhs_nonzero, rhs_positions)
    _validate_range(lhs, -8, 7, "lhs")
    _validate_tensor3_range(rhs_nonzero, -8, 7, "rhs_nonzero")
    _validate_tensor3_range(rhs_positions, 0, 3, "rhs_positions")

    result: list[list[int]] = []
    golden: list[list[int]] = []
    sdot4_count = 0
    output_cols = len(rhs_nonzero[0])
    for lhs_row in lhs:
        result_row: list[int] = []
        golden_row: list[int] = []
        for col_index in range(output_cols):
            acc = 0
            golden_acc = 0
            for block_index, block in enumerate(rhs_nonzero):
                dense_values = lhs_row[block_index * 8 : block_index * 8 + 8]
                if len(dense_values) < 8:
                    dense_values = dense_values + [0] * (8 - len(dense_values))
                nonzero_weights = block[col_index]
                positions = rhs_positions[block_index][col_index]
                acc = _s32(
                    runtime.add(acc, runtime.sdot4_s4_2_4(nonzero_weights, dense_values, positions))
                )
                golden_acc = _s32(
                    golden_acc + golden_sdot4_s4_2_4(nonzero_weights, dense_values, positions)
                )
                sdot4_count += 1
            result_row.append(acc)
            golden_row.append(golden_acc)
        result.append(result_row)
        golden.append(golden_row)

    padded_k = len(rhs_nonzero) * 8
    return LoweredSparseInt4MatmulResult(
        schema="eliza.e1_npu_lowered_sparse_int4_matmul_result.v1",
        source_dialect=str(graph.get("dialect", "unknown")),
        source_op=source_op,
        precision="sparse_int4_2_4",
        abi_opcode=runtime.OP_SDOT4_S4_2_4,
        result=result,
        golden=golden,
        input_shape=[len(lhs), len(lhs[0]), output_cols],
        output_shape=[len(lhs), output_cols],
        sparse_block_count=len(rhs_nonzero),
        sdot4_count=sdot4_count,
        padded_k=padded_k,
        cpu_fallback=False,
        host_pads_k_to_sparse_blocks=padded_k != len(lhs[0]),
        host_uses_2_4_metadata=True,
        claim_boundary="sparse_int4_2_4_matmul_sdot4_smoke_only_not_sparse_tensor_gemm_or_production_compiler_backend",
    )


def lower_group_scaled_int4_matmul_smoke(
    runtime: E1NpuRuntime, graph: dict[str, Any]
) -> LoweredGroupScaledInt4MatmulResult:
    """Lower tiny group-scaled INT4 weights through scalar MUL/ADD commands."""

    if graph.get("schema") != SUPPORTED_GROUP_SCALED_INT4_MATMUL_SCHEMA:
        raise NpuLoweringError(f"unsupported graph schema {graph.get('schema')!r}")
    source_op = str(graph.get("op", ""))
    if source_op not in SUPPORTED_GROUP_SCALED_INT4_MATMUL_OPS:
        raise NpuLoweringError(f"unsupported group_scaled_int4_matmul source op {source_op!r}")
    precision = str(graph.get("precision", "")).lower()
    if precision not in {"int4_group_scaled", "group_scaled_int4", "w4a8_gs"}:
        raise NpuLoweringError(f"unsupported group_scaled_int4_matmul precision {precision!r}")

    lhs = _matrix(graph.get("lhs"), "lhs")
    rhs = _matrix(graph.get("rhs"), "rhs")
    scales_q8_8 = _matrix(graph.get("scales_q8_8"), "scales_q8_8")
    group_size = _positive_int(graph.get("group_size", 32), "group_size")
    _validate_matmul_shape(lhs, rhs)
    _validate_group_scaled_int4_matmul_shape(lhs, rhs, scales_q8_8, group_size)
    _validate_range(lhs, -128, 127, "lhs")
    _validate_range(rhs, -8, 7, "rhs")
    _validate_range(scales_q8_8, -32768, 32767, "scales_q8_8")

    output_cols = len(rhs[0])
    group_count = (len(rhs) + group_size - 1) // group_size
    result: list[list[int]] = []
    golden: list[list[int]] = []
    group_dot_products: list[list[list[int]]] = []
    scalar_mul_count = 0
    scalar_add_count = 0
    for lhs_row in lhs:
        result_row: list[int] = []
        golden_row: list[int] = []
        row_group_dots: list[list[int]] = []
        for col_index in range(output_cols):
            acc = 0
            golden_acc = 0
            col_group_dots: list[int] = []
            for group_index in range(group_count):
                start = group_index * group_size
                stop = min(start + group_size, len(rhs))
                group_dot = 0
                for k_index in range(start, stop):
                    group_dot = _s32(
                        runtime.add(
                            group_dot,
                            runtime.mul_lo(lhs_row[k_index], rhs[k_index][col_index]),
                        )
                    )
                    scalar_mul_count += 1
                    scalar_add_count += 1
                scaled_group = _s32(runtime.mul_lo(group_dot, scales_q8_8[group_index][col_index]))
                acc = _s32(runtime.add(acc, scaled_group))
                golden_acc = _s32(golden_acc + group_dot * scales_q8_8[group_index][col_index])
                col_group_dots.append(group_dot)
                scalar_mul_count += 1
                scalar_add_count += 1
            result_row.append(acc)
            golden_row.append(golden_acc)
            row_group_dots.append(col_group_dots)
        result.append(result_row)
        golden.append(golden_row)
        group_dot_products.append(row_group_dots)

    return LoweredGroupScaledInt4MatmulResult(
        schema="eliza.e1_npu_lowered_group_scaled_int4_matmul_result.v1",
        source_dialect=str(graph.get("dialect", "unknown")),
        source_op=source_op,
        precision="int4_group_scaled",
        result_q8_8=result,
        golden_q8_8=golden,
        group_dot_products=group_dot_products,
        input_shape=[len(lhs), len(lhs[0]), output_cols],
        output_shape=[len(lhs), output_cols],
        group_size=group_size,
        group_count=group_count,
        scalar_mul_count=scalar_mul_count,
        scalar_add_count=scalar_add_count,
        cpu_fallback=False,
        host_applies_group_scales=True,
        host_uses_q8_8_scales=True,
        claim_boundary=(
            "group_scaled_int4_matmul_q8_8_scalar_smoke_only_not_gemm_s4_gs_or_production_compiler_backend"
        ),
    )


def lower_int2_matmul_smoke(
    runtime: E1NpuRuntime, graph: dict[str, Any]
) -> LoweredInt2MatmulResult:
    """Lower a tiny INT2 matmul through scalar DOT16_S2 commands."""

    if graph.get("schema") != SUPPORTED_INT2_MATMUL_SCHEMA:
        raise NpuLoweringError(f"unsupported graph schema {graph.get('schema')!r}")
    source_op = str(graph.get("op", ""))
    if source_op not in SUPPORTED_INT2_MATMUL_OPS:
        raise NpuLoweringError(f"unsupported int2_matmul source op {source_op!r}")
    precision = str(graph.get("precision", "")).lower()
    if precision not in {"int2", "s2", "bitnet_int2"}:
        raise NpuLoweringError(f"unsupported int2_matmul precision {precision!r}")

    lhs = _matrix(graph.get("lhs"), "lhs")
    rhs = _matrix(graph.get("rhs"), "rhs")
    _validate_matmul_shape(lhs, rhs)
    _validate_range(lhs, -2, 1, "lhs")
    _validate_range(rhs, -2, 1, "rhs")

    result: list[list[int]] = []
    golden: list[list[int]] = []
    dot16_count = 0
    for lhs_row in lhs:
        result_row: list[int] = []
        golden_row: list[int] = []
        for col_index in range(len(rhs[0])):
            acc = 0
            golden_acc = 0
            for k_base in range(0, len(rhs), 16):
                a_chunk = lhs_row[k_base : k_base + 16]
                b_chunk = [
                    rhs[k_index][col_index] for k_index in range(k_base, min(k_base + 16, len(rhs)))
                ]
                if len(a_chunk) < 16:
                    a_chunk = a_chunk + [0] * (16 - len(a_chunk))
                    b_chunk = b_chunk + [0] * (16 - len(b_chunk))
                acc = _s32(runtime.dot16_s2(a_chunk, b_chunk, acc))
                golden_acc = _s32(golden_dot16_s2(a_chunk, b_chunk, golden_acc))
                dot16_count += 1
            result_row.append(acc)
            golden_row.append(golden_acc)
        result.append(result_row)
        golden.append(golden_row)

    padded_k = ((len(rhs) + 15) // 16) * 16
    return LoweredInt2MatmulResult(
        schema="eliza.e1_npu_lowered_int2_matmul_result.v1",
        source_dialect=str(graph.get("dialect", "unknown")),
        source_op=source_op,
        precision="int2",
        abi_opcode=runtime.OP_DOT16_S2,
        result=result,
        golden=golden,
        input_shape=[len(lhs), len(lhs[0]), len(rhs[0])],
        output_shape=[len(lhs), len(rhs[0])],
        dot16_count=dot16_count,
        padded_k=padded_k,
        cpu_fallback=False,
        host_pads_k_to_dot16=padded_k != len(rhs),
        claim_boundary="int2_matmul_dot16_smoke_only_not_tensor_int2_gemm_or_production_compiler_backend",
    )


def lower_fp8_matmul_smoke(runtime: E1NpuRuntime, graph: dict[str, Any]) -> LoweredFp8MatmulResult:
    """Lower a tiny FP8 E4M3 matmul through scalar DOT4_FP8_E4M3 commands."""

    if graph.get("schema") != SUPPORTED_FP8_MATMUL_SCHEMA:
        raise NpuLoweringError(f"unsupported graph schema {graph.get('schema')!r}")
    source_op = str(graph.get("op", ""))
    if source_op not in SUPPORTED_FP8_MATMUL_OPS:
        raise NpuLoweringError(f"unsupported fp8_matmul source op {source_op!r}")
    precision = str(graph.get("precision", "")).lower()
    if precision not in {"fp8", "fp8_e4m3"}:
        raise NpuLoweringError(f"unsupported fp8_matmul precision {precision!r}")

    lhs = _matrix(graph.get("lhs"), "lhs")
    rhs = _matrix(graph.get("rhs"), "rhs")
    _validate_matmul_shape(lhs, rhs)
    _validate_range(lhs, 0, 0xFF, "lhs")
    _validate_range(rhs, 0, 0xFF, "rhs")

    result: list[list[int]] = []
    golden: list[list[int]] = []
    dot4_count = 0
    for lhs_row in lhs:
        result_row: list[int] = []
        golden_row: list[int] = []
        for col_index in range(len(rhs[0])):
            acc = 0
            golden_acc = 0
            for k_base in range(0, len(rhs), 4):
                a_chunk = lhs_row[k_base : k_base + 4]
                b_chunk = [
                    rhs[k_index][col_index] for k_index in range(k_base, min(k_base + 4, len(rhs)))
                ]
                if len(a_chunk) < 4:
                    a_chunk = a_chunk + [0] * (4 - len(a_chunk))
                    b_chunk = b_chunk + [0] * (4 - len(b_chunk))
                acc = _s32(runtime.dot4_fp8_e4m3(a_chunk, b_chunk, acc))
                golden_acc = _s32(golden_dot4_fp8_e4m3(a_chunk, b_chunk, golden_acc))
                dot4_count += 1
            result_row.append(acc)
            golden_row.append(golden_acc)
        result.append(result_row)
        golden.append(golden_row)

    padded_k = ((len(rhs) + 3) // 4) * 4
    return LoweredFp8MatmulResult(
        schema="eliza.e1_npu_lowered_fp8_matmul_result.v1",
        source_dialect=str(graph.get("dialect", "unknown")),
        source_op=source_op,
        precision="fp8_e4m3",
        abi_opcode=runtime.OP_DOT4_FP8_E4M3,
        result_q8_8=result,
        golden_q8_8=golden,
        input_shape=[len(lhs), len(lhs[0]), len(rhs[0])],
        output_shape=[len(lhs), len(rhs[0])],
        dot4_count=dot4_count,
        padded_k=padded_k,
        cpu_fallback=False,
        host_pads_k_to_dot4=padded_k != len(rhs),
        claim_boundary="fp8_e4m3_matmul_dot4_smoke_only_not_tensor_fp8_gemm_or_production_compiler_backend",
    )


def _round_shift_signed(value: int, shift: int) -> int:
    if shift < 0:
        return _s32(value << -shift)
    if shift == 0:
        return _s32(value)
    rounding = 1 << (shift - 1)
    if value < 0:
        return -((-value + rounding) >> shift)
    return (value + rounding) >> shift


def _scale_int_by_power2(value: int, exponent: int) -> int:
    if exponent >= 0:
        return value << exponent
    return _round_shift_signed(value, -exponent)


def _fp16_bits_to_q8_8(value: int, name: str) -> int:
    sign = -1 if value & 0x8000 else 1
    exponent = (value >> 10) & 0x1F
    fraction = value & 0x3FF
    if exponent == 0:
        if fraction == 0:
            return 0
        raise NpuLoweringError(f"{name} FP16 subnormal values are not supported")
    if exponent == 0x1F:
        raise NpuLoweringError(f"{name} FP16 NaN/Inf values are not supported")
    q8_8 = sign * _scale_int_by_power2(1024 + fraction, exponent - 17)
    if not -32768 <= q8_8 <= 32767:
        raise NpuLoweringError(f"{name} FP16 value outside signed Q8.8 range")
    return q8_8


def _bf16_bits_to_q8_8(value: int, name: str) -> int:
    sign = -1 if value & 0x8000 else 1
    exponent = (value >> 7) & 0xFF
    fraction = value & 0x7F
    if exponent == 0:
        if fraction == 0:
            return 0
        raise NpuLoweringError(f"{name} BF16 subnormal values are not supported")
    if exponent == 0xFF:
        raise NpuLoweringError(f"{name} BF16 NaN/Inf values are not supported")
    q8_8 = sign * _scale_int_by_power2(128 + fraction, exponent - 126)
    if not -32768 <= q8_8 <= 32767:
        raise NpuLoweringError(f"{name} BF16 value outside signed Q8.8 range")
    return q8_8


def lower_fp16_matmul_smoke(
    runtime: E1NpuRuntime, graph: dict[str, Any]
) -> LoweredFloat16MatmulResult:
    """Lower a tiny raw FP16 matmul through scalar Q8.8 MUL/ADD commands."""

    return _lower_float16_matmul_smoke(
        runtime=runtime,
        graph=graph,
        schema=SUPPORTED_FP16_MATMUL_SCHEMA,
        supported_ops=SUPPORTED_FP16_MATMUL_OPS,
        precision_names={"fp16", "float16"},
        precision="fp16",
        converter=_fp16_bits_to_q8_8,
        result_schema="eliza.e1_npu_lowered_fp16_matmul_result.v1",
        claim_boundary=(
            "fp16_matmul_q8_8_scalar_smoke_only_not_tensor_fp16_gemm_or_production_compiler_backend"
        ),
    )


def lower_bf16_matmul_smoke(
    runtime: E1NpuRuntime, graph: dict[str, Any]
) -> LoweredFloat16MatmulResult:
    """Lower a tiny raw BF16 matmul through scalar Q8.8 MUL/ADD commands."""

    return _lower_float16_matmul_smoke(
        runtime=runtime,
        graph=graph,
        schema=SUPPORTED_BF16_MATMUL_SCHEMA,
        supported_ops=SUPPORTED_BF16_MATMUL_OPS,
        precision_names={"bf16", "bfloat16"},
        precision="bf16",
        converter=_bf16_bits_to_q8_8,
        result_schema="eliza.e1_npu_lowered_bf16_matmul_result.v1",
        claim_boundary=(
            "bf16_matmul_q8_8_scalar_smoke_only_not_tensor_bf16_gemm_or_production_compiler_backend"
        ),
    )


def _lower_float16_matmul_smoke(
    *,
    runtime: E1NpuRuntime,
    graph: dict[str, Any],
    schema: str,
    supported_ops: set[str],
    precision_names: set[str],
    precision: str,
    converter: Any,
    result_schema: str,
    claim_boundary: str,
) -> LoweredFloat16MatmulResult:
    if graph.get("schema") != schema:
        raise NpuLoweringError(f"unsupported graph schema {graph.get('schema')!r}")
    source_op = str(graph.get("op", ""))
    if source_op not in supported_ops:
        raise NpuLoweringError(f"unsupported {precision}_matmul source op {source_op!r}")
    graph_precision = str(graph.get("precision", "")).lower()
    if graph_precision not in precision_names:
        raise NpuLoweringError(f"unsupported {precision}_matmul precision {graph_precision!r}")

    lhs_raw = _matrix(graph.get("lhs"), "lhs")
    rhs_raw = _matrix(graph.get("rhs"), "rhs")
    _validate_matmul_shape(lhs_raw, rhs_raw)
    _validate_range(lhs_raw, 0, 0xFFFF, "lhs")
    _validate_range(rhs_raw, 0, 0xFFFF, "rhs")
    lhs_q8_8 = [[converter(value, "lhs") for value in row] for row in lhs_raw]
    rhs_q8_8 = [[converter(value, "rhs") for value in row] for row in rhs_raw]

    result: list[list[int]] = []
    golden: list[list[int]] = []
    scalar_mul_count = 0
    scalar_add_count = 0
    for lhs_row in lhs_q8_8:
        result_row: list[int] = []
        golden_row: list[int] = []
        for col_index in range(len(rhs_q8_8[0])):
            acc = 0
            golden_acc = 0
            for k_index, lhs_value in enumerate(lhs_row):
                rhs_value = rhs_q8_8[k_index][col_index]
                product_q16_16 = _s32(runtime.mul_lo(lhs_value, rhs_value))
                product_q8_8 = _round_shift_signed(product_q16_16, 8)
                acc = _s32(runtime.add(acc, product_q8_8))
                golden_acc = _s32(golden_acc + _round_shift_signed(lhs_value * rhs_value, 8))
                scalar_mul_count += 1
                scalar_add_count += 1
            result_row.append(acc)
            golden_row.append(golden_acc)
        result.append(result_row)
        golden.append(golden_row)

    return LoweredFloat16MatmulResult(
        schema=result_schema,
        source_dialect=str(graph.get("dialect", "unknown")),
        source_op=source_op,
        precision=precision,
        result_q8_8=result,
        golden_q8_8=golden,
        lhs_q8_8=lhs_q8_8,
        rhs_q8_8=rhs_q8_8,
        input_shape=[len(lhs_raw), len(lhs_raw[0]), len(rhs_raw[0])],
        output_shape=[len(lhs_raw), len(rhs_raw[0])],
        scalar_mul_count=scalar_mul_count,
        scalar_add_count=scalar_add_count,
        cpu_fallback=False,
        host_converts_float16_to_q8_8=True,
        host_requantizes_products=True,
        claim_boundary=claim_boundary,
    )


def lower_transformer_block_smoke(
    runtime: E1NpuRuntime, graph: dict[str, Any]
) -> LoweredTransformerBlockResult:
    """Compose a tiny transformer block from current NPU-backed smoke primitives."""

    if graph.get("schema") != SUPPORTED_TRANSFORMER_BLOCK_SCHEMA:
        raise NpuLoweringError(f"unsupported graph schema {graph.get('schema')!r}")
    source_op = str(graph.get("op", ""))
    if source_op not in SUPPORTED_TRANSFORMER_BLOCK_OPS:
        raise NpuLoweringError(f"unsupported transformer_block source op {source_op!r}")
    precision = str(graph.get("precision", "")).lower()
    if precision != "int8":
        raise NpuLoweringError(f"unsupported transformer_block precision {precision!r}")

    inputs = _matrix(graph.get("input"), "input")
    attention = _tensor4(graph.get("attention"), "attention")
    value = _tensor4(graph.get("value"), "value")
    attention_bias = _vector(graph.get("attention_bias"), "attention_bias")
    up_weight = _matrix(graph.get("mlp_up_weight"), "mlp_up_weight")
    down_weight = _matrix(graph.get("mlp_down_weight"), "mlp_down_weight")
    requant_shift = _nonnegative_int(graph.get("requant_shift", 0), "requant_shift")
    _validate_transformer_block_shape(
        inputs,
        attention,
        value,
        attention_bias,
        up_weight,
        down_weight,
        runtime,
    )
    if requant_shift > 31:
        raise NpuLoweringError("requant_shift must be in 0..31")
    _validate_range(inputs, -128, 127, "input")
    _validate_tensor_range(attention, -128, 127, "attention")
    _validate_tensor_range(value, -128, 127, "value")
    _validate_vector_range(attention_bias, -128, 127, "attention_bias")
    _validate_range(up_weight, -128, 127, "mlp_up_weight")
    _validate_range(down_weight, -128, 127, "mlp_down_weight")

    dialect = graph.get("dialect", "unknown")
    attention_av = lower_attention_av_smoke(
        runtime,
        {
            "schema": SUPPORTED_ATTENTION_AV_SCHEMA,
            "dialect": dialect,
            "op": "eliza.attention_av",
            "precision": "int8",
            "attention": attention,
            "value": value,
        },
    )
    attention_context = attention_av.context[0][0]
    attention_bias_result = lower_bias_add_smoke(
        runtime,
        {
            "schema": SUPPORTED_BIAS_ADD_SCHEMA,
            "dialect": dialect,
            "op": "eliza.bias_add",
            "precision": "int8",
            "input": attention_context,
            "bias": attention_bias,
        },
    )
    attention_residual = lower_residual_add_smoke(
        runtime,
        {
            "schema": SUPPORTED_RESIDUAL_ADD_SCHEMA,
            "dialect": dialect,
            "op": "eliza.residual_add",
            "precision": "int8",
            "lhs": inputs,
            "rhs": attention_bias_result.result,
        },
    )
    mlp = lower_mlp_smoke(
        runtime,
        {
            "schema": SUPPORTED_MLP_SCHEMA,
            "dialect": dialect,
            "op": "eliza.transformer_mlp",
            "precision": "int8",
            "activation": "relu",
            "requant_shift": requant_shift,
            "input": attention_residual.result,
            "up_weight": up_weight,
            "down_weight": down_weight,
        },
    )
    output_residual = lower_residual_add_smoke(
        runtime,
        {
            "schema": SUPPORTED_RESIDUAL_ADD_SCHEMA,
            "dialect": dialect,
            "op": "eliza.residual_add",
            "precision": "int8",
            "lhs": attention_residual.result,
            "rhs": mlp.output,
        },
    )

    return LoweredTransformerBlockResult(
        schema="eliza.e1_npu_lowered_transformer_block_result.v1",
        source_dialect=str(dialect),
        source_op=source_op,
        precision=precision,
        output=output_residual.result,
        attention_context=attention_context,
        attention_projected=attention_bias_result.result,
        post_attention_residual=attention_residual.result,
        mlp_output=mlp.output,
        attention_av=attention_av,
        attention_bias=attention_bias_result,
        attention_residual=attention_residual,
        mlp=mlp,
        output_residual=output_residual,
        total_tile_count=attention_av.total_tile_count + mlp.total_tile_count,
        scalar_add_count=(
            attention_bias_result.scalar_add_count
            + attention_residual.scalar_add_count
            + output_residual.scalar_add_count
        ),
        cpu_fallback=False,
        requires_prequantized_attention=True,
        claim_boundary=TRANSFORMER_BLOCK_CLAIM_BOUNDARY,
    )


def lower_modern_decoder_block_smoke(
    runtime: E1NpuRuntime, graph: dict[str, Any]
) -> LoweredModernDecoderBlockResult:
    """Compose a tiny modern decoder block from current NPU-backed primitives."""

    if graph.get("schema") != SUPPORTED_MODERN_DECODER_BLOCK_SCHEMA:
        raise NpuLoweringError(f"unsupported graph schema {graph.get('schema')!r}")
    source_op = str(graph.get("op", ""))
    if source_op not in SUPPORTED_MODERN_DECODER_BLOCK_OPS:
        raise NpuLoweringError(f"unsupported modern_decoder_block source op {source_op!r}")
    precision = str(graph.get("precision", "")).lower()
    if precision != "int8":
        raise NpuLoweringError(f"unsupported modern_decoder_block precision {precision!r}")

    inputs = _matrix(graph.get("input"), "input")
    norm1_weight = _vector(graph.get("norm1_weight"), "norm1_weight")
    norm2_weight = _vector(graph.get("norm2_weight"), "norm2_weight")
    q_weight = _matrix(graph.get("q_weight"), "q_weight")
    k_weight = _matrix(graph.get("k_weight"), "k_weight")
    v_weight = _matrix(graph.get("v_weight"), "v_weight")
    packed_qkv_weight = (
        _matrix(graph.get("packed_qkv_weight"), "packed_qkv_weight")
        if graph.get("packed_qkv_weight") is not None
        else None
    )
    attention_mask = (
        _bool_tensor4(graph.get("attention_mask"), "attention_mask")
        if graph.get("attention_mask") is not None
        else None
    )
    attention_mask_mode = str(graph.get("attention_mask_mode", "full")).lower()
    if attention_mask_mode not in {"full", "causal", "sliding_window"}:
        raise NpuLoweringError(
            f"unsupported modern_decoder_block attention_mask_mode {attention_mask_mode!r}"
        )
    attention_mask_window = _positive_int(
        graph.get("attention_mask_window", 1), "attention_mask_window"
    )
    attention_bias = _vector(graph.get("attention_bias"), "attention_bias")
    cos = _vector(graph.get("cos"), "cos")
    sin = _vector(graph.get("sin"), "sin")
    swiglu_up_weight = _matrix(graph.get("swiglu_up_weight"), "swiglu_up_weight")
    swiglu_gate_weight = _matrix(graph.get("swiglu_gate_weight"), "swiglu_gate_weight")
    swiglu_down_weight = _matrix(graph.get("swiglu_down_weight"), "swiglu_down_weight")
    swiglu_activation = str(graph.get("swiglu_activation", "linear_gate")).lower()
    if swiglu_activation not in {"linear_gate", "swiglu", "silu", "swiglu_silu"}:
        raise NpuLoweringError(
            f"unsupported modern_decoder_block swiglu_activation {swiglu_activation!r}"
        )
    projection_shift = _nonnegative_int(graph.get("projection_shift", 0), "projection_shift")
    qk_score_shift = _nonnegative_int(graph.get("qk_score_shift", 7), "qk_score_shift")
    attention_weight_shift = _nonnegative_int(
        graph.get("attention_weight_shift", 1), "attention_weight_shift"
    )
    attention_context_shift = _nonnegative_int(
        graph.get("attention_context_shift", 7), "attention_context_shift"
    )
    rms_inv_shift = _nonnegative_int(graph.get("rms_inv_shift", 8), "rms_inv_shift")
    rms_output_shift = _nonnegative_int(graph.get("rms_output_shift", 8), "rms_output_shift")
    rms_epsilon = _nonnegative_int(graph.get("rms_epsilon", 1), "rms_epsilon")
    rope_scale_shift = _nonnegative_int(graph.get("rope_scale_shift", 7), "rope_scale_shift")
    swiglu_requant_shift = _nonnegative_int(
        graph.get("swiglu_requant_shift", 0), "swiglu_requant_shift"
    )
    swiglu_gate_shift = _nonnegative_int(graph.get("swiglu_gate_shift", 0), "swiglu_gate_shift")

    _validate_modern_decoder_block_shape(
        inputs,
        norm1_weight,
        norm2_weight,
        q_weight,
        k_weight,
        v_weight,
        attention_mask,
        attention_bias,
        cos,
        sin,
        swiglu_up_weight,
        swiglu_gate_weight,
        swiglu_down_weight,
    )
    if (
        projection_shift > 31
        or qk_score_shift > 31
        or attention_weight_shift > 31
        or attention_context_shift > 31
        or rms_inv_shift > 31
        or rms_output_shift > 31
        or rope_scale_shift > 31
        or swiglu_requant_shift > 31
        or swiglu_gate_shift > 31
    ):
        raise NpuLoweringError("modern_decoder_block shifts must be in 0..31")
    _validate_range(inputs, -128, 127, "input")
    _validate_vector_range(norm1_weight, -128, 127, "norm1_weight")
    _validate_vector_range(norm2_weight, -128, 127, "norm2_weight")
    _validate_range(q_weight, -128, 127, "q_weight")
    _validate_range(k_weight, -128, 127, "k_weight")
    _validate_range(v_weight, -128, 127, "v_weight")
    if packed_qkv_weight is not None:
        _validate_qkv_projection_shape(inputs, packed_qkv_weight)
        _validate_range(packed_qkv_weight, -128, 127, "packed_qkv_weight")
    _validate_vector_range(attention_bias, -128, 127, "attention_bias")
    _validate_vector_range(cos, -128, 127, "cos")
    _validate_vector_range(sin, -128, 127, "sin")
    _validate_range(swiglu_up_weight, -128, 127, "swiglu_up_weight")
    _validate_range(swiglu_gate_weight, -128, 127, "swiglu_gate_weight")
    _validate_range(swiglu_down_weight, -128, 127, "swiglu_down_weight")

    dialect = graph.get("dialect", "unknown")
    norm1 = lower_rmsnorm_smoke(
        runtime,
        {
            "schema": SUPPORTED_RMSNORM_SCHEMA,
            "dialect": dialect,
            "op": "eliza.rms_norm",
            "precision": "int8",
            "epsilon": rms_epsilon,
            "inv_rms_shift": rms_inv_shift,
            "output_shift": rms_output_shift,
            "input": inputs,
            "weight": norm1_weight,
        },
    )
    q_projection: LoweredMatmulResult | None = None
    k_projection: LoweredMatmulResult | None = None
    v_projection: LoweredMatmulResult | None = None
    qkv_projection: LoweredQkvProjectionResult | None = None
    if packed_qkv_weight is None:
        q_projection = lower_matmul_smoke(
            runtime,
            {
                "schema": SUPPORTED_SCHEMA,
                "dialect": dialect,
                "op": "stablehlo.dot_general",
                "precision": "int8",
                "lhs": norm1.output,
                "rhs": q_weight,
            },
        )
        k_projection = lower_matmul_smoke(
            runtime,
            {
                "schema": SUPPORTED_SCHEMA,
                "dialect": dialect,
                "op": "stablehlo.dot_general",
                "precision": "int8",
                "lhs": norm1.output,
                "rhs": k_weight,
            },
        )
        v_projection = lower_matmul_smoke(
            runtime,
            {
                "schema": SUPPORTED_SCHEMA,
                "dialect": dialect,
                "op": "stablehlo.dot_general",
                "precision": "int8",
                "lhs": norm1.output,
                "rhs": v_weight,
            },
        )
        q_requantized = _requantize_s8_matrix(q_projection.result, projection_shift)
        k_requantized = _requantize_s8_matrix(k_projection.result, projection_shift)
        v_requantized = _requantize_s8_matrix(v_projection.result, projection_shift)
        qkv_tile_count = q_projection.tile_count + k_projection.tile_count + v_projection.tile_count
        host_slices_packed_qkv = False
    else:
        qkv_projection = lower_qkv_projection_smoke(
            runtime,
            {
                "schema": SUPPORTED_QKV_PROJECTION_SCHEMA,
                "dialect": dialect,
                "op": "eliza.qkv_projection",
                "precision": "int8",
                "projection_shift": projection_shift,
                "input": norm1.output,
                "packed_weight": packed_qkv_weight,
            },
        )
        q_requantized = qkv_projection.q_requantized
        k_requantized = qkv_projection.k_requantized
        v_requantized = qkv_projection.v_requantized
        qkv_tile_count = qkv_projection.total_tile_count
        host_slices_packed_qkv = True
    q_rope = lower_rope_smoke(
        runtime,
        {
            "schema": SUPPORTED_ROPE_SCHEMA,
            "dialect": dialect,
            "op": "eliza.rope",
            "precision": "int8",
            "scale_shift": rope_scale_shift,
            "input": q_requantized,
            "cos": cos,
            "sin": sin,
        },
    )
    k_rope = lower_rope_smoke(
        runtime,
        {
            "schema": SUPPORTED_ROPE_SCHEMA,
            "dialect": dialect,
            "op": "eliza.rope",
            "precision": "int8",
            "scale_shift": rope_scale_shift,
            "input": k_requantized,
            "cos": cos,
            "sin": sin,
        },
    )
    qk_scores = lower_attention_qk_smoke(
        runtime,
        {
            "schema": SUPPORTED_ATTENTION_QK_SCHEMA,
            "dialect": dialect,
            "op": "eliza.attention_qk",
            "precision": "int8",
            "query": [[q_rope.output]],
            "key": [[k_rope.output]],
        },
    )
    qk_logits_s8 = _requantize_s8_tensor4(qk_scores.scores, qk_score_shift)
    if attention_mask is None:
        if attention_mask_mode == "causal":
            attention_mask = _causal_attention_mask([[q_rope.output]], [[k_rope.output]])
            host_generates_causal_mask = True
            host_generates_sliding_window_mask = False
        elif attention_mask_mode == "sliding_window":
            attention_mask = _sliding_window_attention_mask(
                [[q_rope.output]], [[k_rope.output]], attention_mask_window
            )
            host_generates_causal_mask = False
            host_generates_sliding_window_mask = True
        else:
            attention_mask = [
                [[[True for _ in row] for row in head] for head in batch] for batch in qk_logits_s8
            ]
            host_generates_causal_mask = False
            host_generates_sliding_window_mask = False
    else:
        host_generates_causal_mask = False
        host_generates_sliding_window_mask = False
    _validate_attention_softmax_shape(qk_logits_s8, attention_mask)
    attention_softmax = lower_attention_softmax_smoke(
        runtime,
        {
            "schema": SUPPORTED_ATTENTION_SOFTMAX_SCHEMA,
            "dialect": dialect,
            "op": "eliza.attention_softmax",
            "precision": "int8",
            "logits": qk_logits_s8,
            "mask": attention_mask,
        },
    )
    attention_weights_s8 = _requantize_attention_weights_s8(
        attention_softmax.weights_q0_8, attention_weight_shift
    )
    attention_av = lower_attention_av_smoke(
        runtime,
        {
            "schema": SUPPORTED_ATTENTION_AV_SCHEMA,
            "dialect": dialect,
            "op": "eliza.attention_av",
            "precision": "int8",
            "attention": attention_weights_s8,
            "value": [[v_requantized]],
        },
    )
    attention_context_requantized = _requantize_s8_matrix(
        attention_av.context[0][0], attention_context_shift
    )
    attention_bias_result = lower_bias_add_smoke(
        runtime,
        {
            "schema": SUPPORTED_BIAS_ADD_SCHEMA,
            "dialect": dialect,
            "op": "eliza.bias_add",
            "precision": "int8",
            "input": attention_context_requantized,
            "bias": attention_bias,
        },
    )
    attention_residual = lower_residual_add_smoke(
        runtime,
        {
            "schema": SUPPORTED_RESIDUAL_ADD_SCHEMA,
            "dialect": dialect,
            "op": "eliza.residual_add",
            "precision": "int8",
            "lhs": inputs,
            "rhs": attention_bias_result.result,
        },
    )
    norm2 = lower_rmsnorm_smoke(
        runtime,
        {
            "schema": SUPPORTED_RMSNORM_SCHEMA,
            "dialect": dialect,
            "op": "eliza.rms_norm",
            "precision": "int8",
            "epsilon": rms_epsilon,
            "inv_rms_shift": rms_inv_shift,
            "output_shift": rms_output_shift,
            "input": attention_residual.result,
            "weight": norm2_weight,
        },
    )
    swiglu = lower_swiglu_smoke(
        runtime,
        {
            "schema": SUPPORTED_SWIGLU_SCHEMA,
            "dialect": dialect,
            "op": "eliza.swiglu",
            "precision": "int8",
            "activation": swiglu_activation,
            "requant_shift": swiglu_requant_shift,
            "gate_shift": swiglu_gate_shift,
            "input": norm2.output,
            "up_weight": swiglu_up_weight,
            "gate_weight": swiglu_gate_weight,
            "down_weight": swiglu_down_weight,
        },
    )
    output_residual = lower_residual_add_smoke(
        runtime,
        {
            "schema": SUPPORTED_RESIDUAL_ADD_SCHEMA,
            "dialect": dialect,
            "op": "eliza.residual_add",
            "precision": "int8",
            "lhs": attention_residual.result,
            "rhs": swiglu.output,
        },
    )
    scalar_add_count = (
        norm1.scalar_add_count
        + q_rope.scalar_add_count
        + k_rope.scalar_add_count
        + attention_bias_result.scalar_add_count
        + attention_residual.scalar_add_count
        + norm2.scalar_add_count
        + output_residual.scalar_add_count
    )
    scalar_mul_count = (
        norm1.scalar_mul_count
        + q_rope.scalar_mul_count
        + k_rope.scalar_mul_count
        + norm2.scalar_mul_count
        + swiglu.scalar_mul_count
    )
    return LoweredModernDecoderBlockResult(
        schema="eliza.e1_npu_lowered_modern_decoder_block_result.v1",
        source_dialect=str(dialect),
        source_op=source_op,
        precision=precision,
        output=output_residual.result,
        norm1=norm1,
        q_projection=q_projection,
        k_projection=k_projection,
        v_projection=v_projection,
        qkv_projection=qkv_projection,
        q_requantized=q_requantized,
        k_requantized=k_requantized,
        v_requantized=v_requantized,
        q_rope=q_rope,
        k_rope=k_rope,
        qk_scores=qk_scores,
        qk_logits_s8=qk_logits_s8,
        attention_softmax=attention_softmax,
        attention_weights_s8=attention_weights_s8,
        attention_av=attention_av,
        attention_context_requantized=attention_context_requantized,
        attention_bias=attention_bias_result,
        attention_residual=attention_residual,
        norm2=norm2,
        swiglu=swiglu,
        output_residual=output_residual,
        total_tile_count=(
            qkv_tile_count
            + qk_scores.total_tile_count
            + attention_av.total_tile_count
            + swiglu.total_tile_count
        ),
        scalar_add_count=scalar_add_count,
        scalar_mul_count=scalar_mul_count,
        cpu_fallback=False,
        computes_qk_scores=True,
        computes_attention_softmax=True,
        requires_prequantized_attention=False,
        host_generates_causal_mask=host_generates_causal_mask,
        host_generates_sliding_window_mask=host_generates_sliding_window_mask,
        host_slices_packed_qkv=host_slices_packed_qkv,
        host_requantizes_qkv=True,
        host_requantizes_qk_scores=True,
        host_requantizes_attention_weights=True,
        claim_boundary=MODERN_DECODER_BLOCK_CLAIM_BOUNDARY,
    )


def lower_bias_add_smoke(runtime: E1NpuRuntime, graph: dict[str, Any]) -> LoweredBiasAddResult:
    """Lower a tiny row-wise bias add to scalar NPU ADD commands."""

    if graph.get("schema") != SUPPORTED_BIAS_ADD_SCHEMA:
        raise NpuLoweringError(f"unsupported graph schema {graph.get('schema')!r}")
    source_op = str(graph.get("op", ""))
    if source_op not in SUPPORTED_BIAS_ADD_OPS:
        raise NpuLoweringError(f"unsupported bias_add source op {source_op!r}")
    precision = str(graph.get("precision", "")).lower()
    if precision != "int8":
        raise NpuLoweringError(f"unsupported bias_add precision {precision!r}")

    inputs = _matrix(graph.get("input"), "input")
    bias = _vector(graph.get("bias"), "bias")
    if len(bias) != len(inputs[0]):
        raise NpuLoweringError(
            f"bias_add width mismatch: input N={len(inputs[0])}, bias N={len(bias)}"
        )
    _validate_range(inputs, -128, 127, "input")
    _validate_vector_range(bias, -128, 127, "bias")

    result: list[list[int]] = []
    for row in inputs:
        result_row: list[int] = []
        for value, bias_value in zip(row, bias, strict=True):
            result_row.append(_clamp_s8(_s32(runtime.add(value, bias_value))))
        result.append(result_row)
    golden = [
        [_clamp_s8(value + bias_value) for value, bias_value in zip(row, bias, strict=True)]
        for row in inputs
    ]

    return LoweredBiasAddResult(
        schema="eliza.e1_npu_lowered_bias_add_result.v1",
        source_dialect=str(graph.get("dialect", "unknown")),
        source_op=source_op,
        precision=precision,
        result=result,
        golden=golden,
        input_shape=[len(inputs), len(inputs[0])],
        bias_shape=[len(bias)],
        element_count=len(inputs) * len(inputs[0]),
        scalar_add_count=len(inputs) * len(inputs[0]),
        cpu_fallback=False,
        host_broadcasts_bias=True,
        host_saturates_int8=True,
        claim_boundary="bias_add_s8_scalar_broadcast_smoke_only_not_vector_or_production_compiler_backend",
    )


def lower_rope_smoke(runtime: E1NpuRuntime, graph: dict[str, Any]) -> LoweredRopeResult:
    """Lower tiny rotary-position embedding to scalar NPU MUL/SUB/ADD commands."""

    if graph.get("schema") != SUPPORTED_ROPE_SCHEMA:
        raise NpuLoweringError(f"unsupported graph schema {graph.get('schema')!r}")
    source_op = str(graph.get("op", ""))
    if source_op not in SUPPORTED_ROPE_OPS:
        raise NpuLoweringError(f"unsupported rope source op {source_op!r}")
    precision = str(graph.get("precision", "")).lower()
    if precision != "int8":
        raise NpuLoweringError(f"unsupported rope precision {precision!r}")

    inputs = _matrix(graph.get("input"), "input")
    cos = _vector(graph.get("cos"), "cos")
    sin = _vector(graph.get("sin"), "sin")
    scale_shift = _nonnegative_int(graph.get("scale_shift", 7), "scale_shift")
    _validate_rope_shape(inputs, cos, sin)
    _validate_range(inputs, -128, 127, "input")
    _validate_vector_range(cos, -128, 127, "cos")
    _validate_vector_range(sin, -128, 127, "sin")

    output: list[list[int]] = []
    for row in inputs:
        output_row: list[int] = []
        for pair_index in range(len(cos)):
            even = row[pair_index * 2]
            odd = row[pair_index * 2 + 1]
            cos_value = cos[pair_index]
            sin_value = sin[pair_index]
            even_cos = _s32(runtime.mul_lo(even, cos_value))
            odd_sin = _s32(runtime.mul_lo(odd, sin_value))
            even_sin = _s32(runtime.mul_lo(even, sin_value))
            odd_cos = _s32(runtime.mul_lo(odd, cos_value))
            rotated_even = _s32(runtime.sub(even_cos, odd_sin))
            rotated_odd = _s32(runtime.add(even_sin, odd_cos))
            output_row.append(_clamp_s8(rotated_even >> scale_shift))
            output_row.append(_clamp_s8(rotated_odd >> scale_shift))
        output.append(output_row)

    golden = _golden_rope(inputs, cos, sin, scale_shift)
    pair_count = len(inputs) * len(cos)
    return LoweredRopeResult(
        schema="eliza.e1_npu_lowered_rope_result.v1",
        source_dialect=str(graph.get("dialect", "unknown")),
        source_op=source_op,
        precision=precision,
        output=output,
        golden=golden,
        input_shape=[len(inputs), len(inputs[0])],
        trig_shape=[len(cos)],
        scale_shift=scale_shift,
        scalar_mul_count=pair_count * 4,
        scalar_add_count=pair_count * 2,
        cpu_fallback=False,
        host_applies_shift_and_saturation=True,
        claim_boundary="rope_s8_scalar_smoke_only_not_vector_or_production_compiler_backend",
    )


def lower_rmsnorm_smoke(runtime: E1NpuRuntime, graph: dict[str, Any]) -> LoweredRmsNormResult:
    """Lower tiny RMSNorm to scalar NPU square, add, and scale-multiply commands."""

    if graph.get("schema") != SUPPORTED_RMSNORM_SCHEMA:
        raise NpuLoweringError(f"unsupported graph schema {graph.get('schema')!r}")
    source_op = str(graph.get("op", ""))
    if source_op not in SUPPORTED_RMSNORM_OPS:
        raise NpuLoweringError(f"unsupported rmsnorm source op {source_op!r}")
    precision = str(graph.get("precision", "")).lower()
    if precision != "int8":
        raise NpuLoweringError(f"unsupported rmsnorm precision {precision!r}")

    inputs = _matrix(graph.get("input"), "input")
    weight = _vector(graph.get("weight"), "weight")
    inv_rms_shift = _nonnegative_int(graph.get("inv_rms_shift", 8), "inv_rms_shift")
    output_shift = _nonnegative_int(graph.get("output_shift", 8), "output_shift")
    epsilon = _nonnegative_int(graph.get("epsilon", 1), "epsilon")
    _validate_rmsnorm_shape(inputs, weight)
    _validate_range(inputs, -128, 127, "input")
    _validate_vector_range(weight, -128, 127, "weight")

    output: list[list[int]] = []
    row_sum_squares: list[int] = []
    row_rms: list[int] = []
    row_inv_rms_q: list[int] = []
    for row in inputs:
        sum_squares = 0
        for value in row:
            square = _s32(runtime.mul_lo(value, value))
            sum_squares = _s32(runtime.add(sum_squares, square))
        mean_square = (sum_squares + len(row) - 1) // len(row)
        rms = max(1, isqrt(mean_square + epsilon))
        inv_rms_q = (1 << inv_rms_shift) // rms
        output_row: list[int] = []
        for value, weight_value in zip(row, weight, strict=True):
            weighted = _s32(runtime.mul_lo(value, weight_value))
            scaled = _s32(runtime.mul_lo(weighted, inv_rms_q))
            output_row.append(_clamp_s8(scaled >> output_shift))
        output.append(output_row)
        row_sum_squares.append(sum_squares)
        row_rms.append(rms)
        row_inv_rms_q.append(inv_rms_q)

    golden, golden_sum_squares, golden_rms, golden_inv = _golden_rmsnorm(
        inputs, weight, inv_rms_shift, output_shift, epsilon
    )
    if (
        row_sum_squares != golden_sum_squares
        or row_rms != golden_rms
        or row_inv_rms_q != golden_inv
    ):
        raise AssertionError("RMSNorm smoke internal golden mismatch")
    element_count = len(inputs) * len(inputs[0])
    return LoweredRmsNormResult(
        schema="eliza.e1_npu_lowered_rmsnorm_result.v1",
        source_dialect=str(graph.get("dialect", "unknown")),
        source_op=source_op,
        precision=precision,
        output=output,
        golden=golden,
        input_shape=[len(inputs), len(inputs[0])],
        weight_shape=[len(weight)],
        row_sum_squares=row_sum_squares,
        row_rms=row_rms,
        row_inv_rms_q=row_inv_rms_q,
        inv_rms_shift=inv_rms_shift,
        output_shift=output_shift,
        scalar_mul_count=element_count * 3,
        scalar_add_count=element_count,
        cpu_fallback=False,
        host_computes_reciprocal_rms=True,
        host_applies_shift_and_saturation=True,
        claim_boundary="rmsnorm_s8_scalar_smoke_only_not_vector_or_production_compiler_backend",
    )


def lower_residual_add_smoke(
    runtime: E1NpuRuntime, graph: dict[str, Any]
) -> LoweredResidualAddResult:
    """Lower a tiny residual add to scalar NPU ADD commands with int8 saturation."""

    if graph.get("schema") != SUPPORTED_RESIDUAL_ADD_SCHEMA:
        raise NpuLoweringError(f"unsupported graph schema {graph.get('schema')!r}")
    source_op = str(graph.get("op", ""))
    if source_op not in SUPPORTED_RESIDUAL_ADD_OPS:
        raise NpuLoweringError(f"unsupported residual_add source op {source_op!r}")
    precision = str(graph.get("precision", "")).lower()
    if precision != "int8":
        raise NpuLoweringError(f"unsupported residual_add precision {precision!r}")

    lhs = _matrix(graph.get("lhs"), "lhs")
    rhs = _matrix(graph.get("rhs"), "rhs")
    _validate_same_shape(lhs, rhs, "residual_add")
    _validate_range(lhs, -128, 127, "lhs")
    _validate_range(rhs, -128, 127, "rhs")

    result: list[list[int]] = []
    for lhs_row, rhs_row in zip(lhs, rhs, strict=True):
        result_row: list[int] = []
        for lhs_value, rhs_value in zip(lhs_row, rhs_row, strict=True):
            result_row.append(_clamp_s8(_s32(runtime.add(lhs_value, rhs_value))))
        result.append(result_row)
    golden = [
        [
            _clamp_s8(lhs_value + rhs_value)
            for lhs_value, rhs_value in zip(lhs_row, rhs_row, strict=True)
        ]
        for lhs_row, rhs_row in zip(lhs, rhs, strict=True)
    ]

    return LoweredResidualAddResult(
        schema="eliza.e1_npu_lowered_residual_add_result.v1",
        source_dialect=str(graph.get("dialect", "unknown")),
        source_op=source_op,
        precision=precision,
        result=result,
        golden=golden,
        shape=[len(lhs), len(lhs[0])],
        element_count=len(lhs) * len(lhs[0]),
        scalar_add_count=len(lhs) * len(lhs[0]),
        cpu_fallback=False,
        host_saturates_int8=True,
        claim_boundary="residual_add_s8_scalar_smoke_only_not_vector_or_production_compiler_backend",
    )


def lower_mlp_smoke(runtime: E1NpuRuntime, graph: dict[str, Any]) -> LoweredMlpResult:
    """Lower a tiny transformer MLP block through GEMM, VRELU, GEMM."""

    if graph.get("schema") != SUPPORTED_MLP_SCHEMA:
        raise NpuLoweringError(f"unsupported graph schema {graph.get('schema')!r}")
    source_op = str(graph.get("op", ""))
    if source_op not in SUPPORTED_MLP_OPS:
        raise NpuLoweringError(f"unsupported mlp source op {source_op!r}")
    precision = str(graph.get("precision", "")).lower()
    if precision != "int8":
        raise NpuLoweringError(f"unsupported mlp precision {precision!r}")
    activation = str(graph.get("activation", "relu")).lower()
    if activation != "relu":
        raise NpuLoweringError(f"unsupported mlp activation {activation!r}")

    inputs = _matrix(graph.get("input"), "input")
    up_weight = _matrix(graph.get("up_weight"), "up_weight")
    down_weight = _matrix(graph.get("down_weight"), "down_weight")
    _validate_mlp_shape(inputs, up_weight, down_weight, runtime)
    requant_shift = _nonnegative_int(graph.get("requant_shift", 0), "requant_shift")
    if requant_shift > 31:
        raise NpuLoweringError("requant_shift must be in 0..31")
    _validate_range(inputs, -128, 127, "input")
    _validate_range(up_weight, -128, 127, "up_weight")
    _validate_range(down_weight, -128, 127, "down_weight")

    up_matmul = lower_matmul_smoke(
        runtime,
        {
            "schema": SUPPORTED_SCHEMA,
            "dialect": graph.get("dialect", "unknown"),
            "op": "stablehlo.dot_general",
            "precision": "int8",
            "lhs": inputs,
            "rhs": up_weight,
        },
    )
    hidden_requantized = _requantize_s8_matrix(up_matmul.result, requant_shift)
    hidden_activated = _reshape_matrix(
        runtime.vrelu_s8(_flatten_matrix(hidden_requantized)),
        len(hidden_requantized),
        len(hidden_requantized[0]),
    )
    down_matmul = lower_matmul_smoke(
        runtime,
        {
            "schema": SUPPORTED_SCHEMA,
            "dialect": graph.get("dialect", "unknown"),
            "op": "stablehlo.dot_general",
            "precision": "int8",
            "lhs": hidden_activated,
            "rhs": down_weight,
        },
    )

    return LoweredMlpResult(
        schema="eliza.e1_npu_lowered_mlp_result.v1",
        source_dialect=str(graph.get("dialect", "unknown")),
        source_op=source_op,
        precision=precision,
        activation=activation,
        output=down_matmul.result,
        golden=down_matmul.golden,
        hidden_accumulator=up_matmul.result,
        hidden_requantized=hidden_requantized,
        hidden_activated=hidden_activated,
        requant_shift=requant_shift,
        up_matmul=up_matmul,
        down_matmul=down_matmul,
        total_tile_count=up_matmul.tile_count + down_matmul.tile_count,
        cpu_fallback=False,
        host_requantizes_hidden=True,
        activation_opcode="VRELU_S8",
        claim_boundary="transformer_mlp_relu_smoke_only_not_gelu_or_production_compiler_backend",
    )


def lower_swiglu_smoke(runtime: E1NpuRuntime, graph: dict[str, Any]) -> LoweredSwiGLUResult:
    """Lower a tiny gated transformer MLP through GEMM, optional SiLU, scalar MUL, GEMM."""

    if graph.get("schema") != SUPPORTED_SWIGLU_SCHEMA:
        raise NpuLoweringError(f"unsupported graph schema {graph.get('schema')!r}")
    source_op = str(graph.get("op", ""))
    if source_op not in SUPPORTED_SWIGLU_OPS:
        raise NpuLoweringError(f"unsupported swiglu source op {source_op!r}")
    precision = str(graph.get("precision", "")).lower()
    if precision != "int8":
        raise NpuLoweringError(f"unsupported swiglu precision {precision!r}")
    activation = str(graph.get("activation", "linear_gate")).lower()
    if activation not in {"linear_gate", "swiglu", "silu", "swiglu_silu"}:
        raise NpuLoweringError(f"unsupported swiglu activation {activation!r}")

    inputs = _matrix(graph.get("input"), "input")
    up_weight = _matrix(graph.get("up_weight"), "up_weight")
    gate_weight = _matrix(graph.get("gate_weight"), "gate_weight")
    down_weight = _matrix(graph.get("down_weight"), "down_weight")
    _validate_swiglu_shape(inputs, up_weight, gate_weight, down_weight)
    requant_shift = _nonnegative_int(graph.get("requant_shift", 0), "requant_shift")
    gate_shift = _nonnegative_int(graph.get("gate_shift", 7), "gate_shift")
    if requant_shift > 31 or gate_shift > 31:
        raise NpuLoweringError("swiglu shifts must be in 0..31")
    _validate_range(inputs, -128, 127, "input")
    _validate_range(up_weight, -128, 127, "up_weight")
    _validate_range(gate_weight, -128, 127, "gate_weight")
    _validate_range(down_weight, -128, 127, "down_weight")

    dialect = graph.get("dialect", "unknown")
    up_matmul = lower_matmul_smoke(
        runtime,
        {
            "schema": SUPPORTED_SCHEMA,
            "dialect": dialect,
            "op": "stablehlo.dot_general",
            "precision": "int8",
            "lhs": inputs,
            "rhs": up_weight,
        },
    )
    gate_matmul = lower_matmul_smoke(
        runtime,
        {
            "schema": SUPPORTED_SCHEMA,
            "dialect": dialect,
            "op": "stablehlo.dot_general",
            "precision": "int8",
            "lhs": inputs,
            "rhs": gate_weight,
        },
    )
    up_requantized = _requantize_s8_matrix(up_matmul.result, requant_shift)
    gate_requantized = _requantize_s8_matrix(gate_matmul.result, requant_shift)
    gate_activation_result: LoweredSiluResult | None = None
    if activation in {"silu", "swiglu_silu"}:
        gate_activation_result = lower_silu_smoke(
            runtime,
            {
                "schema": SUPPORTED_SILU_SCHEMA,
                "dialect": dialect,
                "op": "eliza.silu",
                "precision": "int8",
                "input": gate_requantized,
            },
        )
        gate_activated = gate_activation_result.output
        claim_boundary = (
            "swiglu_s8_silu_gate_smoke_only_not_fused_vector_swiglu_or_production_compiler_backend"
        )
    else:
        gate_activated = gate_requantized
        claim_boundary = "swiglu_s8_scalar_gate_smoke_only_not_silu_or_production_compiler_backend"
    gated_hidden: list[list[int]] = []
    for up_row, gate_row in zip(up_requantized, gate_activated, strict=True):
        gated_row: list[int] = []
        for up_value, gate_value in zip(up_row, gate_row, strict=True):
            gated_row.append(_clamp_s8(_s32(runtime.mul_lo(up_value, gate_value)) >> gate_shift))
        gated_hidden.append(gated_row)

    down_matmul = lower_matmul_smoke(
        runtime,
        {
            "schema": SUPPORTED_SCHEMA,
            "dialect": dialect,
            "op": "stablehlo.dot_general",
            "precision": "int8",
            "lhs": gated_hidden,
            "rhs": down_weight,
        },
    )
    golden_hidden = _golden_swiglu_hidden(up_requantized, gate_activated, gate_shift)
    if gated_hidden != golden_hidden:
        raise AssertionError("SwiGLU smoke internal golden mismatch")
    return LoweredSwiGLUResult(
        schema="eliza.e1_npu_lowered_swiglu_result.v1",
        source_dialect=str(dialect),
        source_op=source_op,
        precision=precision,
        activation=activation,
        output=down_matmul.result,
        golden=down_matmul.golden,
        up_accumulator=up_matmul.result,
        gate_accumulator=gate_matmul.result,
        up_requantized=up_requantized,
        gate_requantized=gate_requantized,
        gate_activated=gate_activated,
        gated_hidden=gated_hidden,
        requant_shift=requant_shift,
        gate_shift=gate_shift,
        up_matmul=up_matmul,
        gate_matmul=gate_matmul,
        gate_activation_result=gate_activation_result,
        down_matmul=down_matmul,
        total_tile_count=up_matmul.tile_count + gate_matmul.tile_count + down_matmul.tile_count,
        scalar_mul_count=len(inputs) * len(up_weight[0]),
        cpu_fallback=False,
        host_requantizes_hidden=True,
        host_applies_gate_shift_and_saturation=True,
        claim_boundary=claim_boundary,
    )


def lower_silu_smoke(runtime: E1NpuRuntime, graph: dict[str, Any]) -> LoweredSiluResult:
    """Lower a tiny int8 SiLU approximation through scalar EXP2, SUB, and MUL."""

    if graph.get("schema") != SUPPORTED_SILU_SCHEMA:
        raise NpuLoweringError(f"unsupported graph schema {graph.get('schema')!r}")
    source_op = str(graph.get("op", ""))
    if source_op not in SUPPORTED_SILU_OPS:
        raise NpuLoweringError(f"unsupported silu source op {source_op!r}")
    precision = str(graph.get("precision", "")).lower()
    if precision != "int8":
        raise NpuLoweringError(f"unsupported silu precision {precision!r}")
    approximation = str(graph.get("approximation", "exp2_q0_8_piecewise")).lower()
    if approximation != "exp2_q0_8_piecewise":
        raise NpuLoweringError(f"unsupported silu approximation {approximation!r}")

    inputs = _matrix(graph.get("input"), "input")
    _validate_range(inputs, -128, 127, "input")
    output: list[list[int]] = []
    sigmoid_rows: list[list[int]] = []
    exp2_count = 0
    sub_count = 0
    mul_count = 0
    for row in inputs:
        output_row: list[int] = []
        sigmoid_row: list[int] = []
        for value in row:
            activated, sigmoid, used_sub = _silu_s8_scalar_approx(runtime, value)
            output_row.append(activated)
            sigmoid_row.append(sigmoid)
            exp2_count += 1
            sub_count += 1 if used_sub else 0
            mul_count += 1
        output.append(output_row)
        sigmoid_rows.append(sigmoid_row)
    golden = _golden_silu_s8_approx(inputs)

    return LoweredSiluResult(
        schema="eliza.e1_npu_lowered_silu_result.v1",
        source_dialect=str(graph.get("dialect", "unknown")),
        source_op=source_op,
        precision=precision,
        input=inputs,
        sigmoid_q0_8=sigmoid_rows,
        output=output,
        golden=golden,
        shape=[len(inputs), len(inputs[0])],
        element_count=len(inputs) * len(inputs[0]),
        scalar_exp2_count=exp2_count,
        scalar_sub_count=sub_count,
        scalar_mul_count=mul_count,
        cpu_fallback=False,
        host_applies_shift_and_saturation=True,
        approximation=approximation,
        claim_boundary="silu_s8_exp2_piecewise_smoke_only_not_exact_sigmoid_or_vector_activation",
    )


def lower_gelu_smoke(runtime: E1NpuRuntime, graph: dict[str, Any]) -> LoweredGeluResult:
    """Lower a tiny int8 QuickGELU approximation through scalar NPU arithmetic."""

    if graph.get("schema") != SUPPORTED_GELU_SCHEMA:
        raise NpuLoweringError(f"unsupported graph schema {graph.get('schema')!r}")
    source_op = str(graph.get("op", ""))
    if source_op not in SUPPORTED_GELU_OPS:
        raise NpuLoweringError(f"unsupported gelu source op {source_op!r}")
    precision = str(graph.get("precision", "")).lower()
    if precision != "int8":
        raise NpuLoweringError(f"unsupported gelu precision {precision!r}")
    approximation = str(graph.get("approximation", "quick_gelu_exp2_q0_8")).lower()
    if approximation != "quick_gelu_exp2_q0_8":
        raise NpuLoweringError(f"unsupported gelu approximation {approximation!r}")

    inputs = _matrix(graph.get("input"), "input")
    _validate_range(inputs, -128, 127, "input")
    output: list[list[int]] = []
    scaled_rows: list[list[int]] = []
    sigmoid_rows: list[list[int]] = []
    sub_count = 0
    for row in inputs:
        output_row: list[int] = []
        scaled_row: list[int] = []
        sigmoid_row: list[int] = []
        for value in row:
            activated, scaled, sigmoid, used_sub = _quick_gelu_s8_scalar_approx(runtime, value)
            output_row.append(activated)
            scaled_row.append(scaled)
            sigmoid_row.append(sigmoid)
            sub_count += 1 if used_sub else 0
        output.append(output_row)
        scaled_rows.append(scaled_row)
        sigmoid_rows.append(sigmoid_row)
    golden = _golden_quick_gelu_s8_approx(inputs)
    element_count = len(inputs) * len(inputs[0])

    return LoweredGeluResult(
        schema="eliza.e1_npu_lowered_gelu_result.v1",
        source_dialect=str(graph.get("dialect", "unknown")),
        source_op=source_op,
        precision=precision,
        input=inputs,
        scaled_input=scaled_rows,
        sigmoid_q0_8=sigmoid_rows,
        output=output,
        golden=golden,
        shape=[len(inputs), len(inputs[0])],
        element_count=element_count,
        scalar_scale_mul_count=element_count,
        scalar_exp2_count=element_count,
        scalar_sub_count=sub_count,
        scalar_gate_mul_count=element_count,
        cpu_fallback=False,
        host_applies_shift_and_saturation=True,
        approximation=approximation,
        claim_boundary="gelu_s8_quick_exp2_piecewise_smoke_only_not_exact_gelu_or_vector_activation",
    )


def lower_attention_softmax_smoke(
    runtime: E1NpuRuntime, graph: dict[str, Any]
) -> LoweredAttentionSoftmaxResult:
    """Lower tiny attention softmax records to scalar max/sub/exp/sum commands."""

    if graph.get("schema") != SUPPORTED_ATTENTION_SOFTMAX_SCHEMA:
        raise NpuLoweringError(f"unsupported graph schema {graph.get('schema')!r}")
    source_op = str(graph.get("op", ""))
    if source_op not in SUPPORTED_ATTENTION_SOFTMAX_OPS:
        raise NpuLoweringError(f"unsupported attention_softmax source op {source_op!r}")
    precision = str(graph.get("precision", "")).lower()
    if precision != "int8":
        raise NpuLoweringError(f"unsupported attention_softmax precision {precision!r}")

    logits = _tensor4(graph.get("logits"), "logits")
    if graph.get("mask") is None:
        mask = [[[[True for _ in row] for row in head] for head in batch] for batch in logits]
    else:
        mask = _bool_tensor4(graph.get("mask"), "mask")
    _validate_attention_softmax_shape(logits, mask)
    _validate_tensor_range(logits, -128, 127, "logits")

    weights: list[list[list[list[int]]]] = []
    exp_rows: list[list[list[list[int]]]] = []
    row_max: list[list[list[int]]] = []
    row_sum_exp: list[list[list[int]]] = []
    scalar_max_count = 0
    scalar_sub_count = 0
    scalar_exp_count = 0
    scalar_add_count = 0

    for batch_logits, batch_mask in zip(logits, mask, strict=True):
        batch_weights: list[list[list[int]]] = []
        batch_exp: list[list[list[int]]] = []
        batch_max: list[list[int]] = []
        batch_sum: list[list[int]] = []
        for head_logits, head_mask in zip(batch_logits, batch_mask, strict=True):
            head_weights: list[list[int]] = []
            head_exp: list[list[int]] = []
            head_max: list[int] = []
            head_sum: list[int] = []
            for row_logits, row_mask in zip(head_logits, head_mask, strict=True):
                active_values = [
                    value for value, active in zip(row_logits, row_mask, strict=True) if active
                ]
                current_max = active_values[0]
                for value in active_values[1:]:
                    current_max = _s32(runtime.max_u32(current_max + 128, value + 128)) - 128
                    scalar_max_count += 1
                if current_max - min(active_values) > 128:
                    raise NpuLoweringError(
                        "attention_softmax row logit spread must fit EXP2_NEG_Q0_8 delta range"
                    )
                exp_row: list[int] = []
                sum_exp = 0
                for value, active in zip(row_logits, row_mask, strict=True):
                    if not active:
                        exp_row.append(0)
                        continue
                    delta = _s32(runtime.sub(value, current_max))
                    scalar_sub_count += 1
                    exp_value = runtime.exp2_neg_q0_8(delta)
                    scalar_exp_count += 1
                    sum_exp = _s32(runtime.add(sum_exp, exp_value))
                    scalar_add_count += 1
                    exp_row.append(exp_value)
                weight_row = [(value * 256 + (sum_exp // 2)) // sum_exp for value in exp_row]
                head_weights.append(weight_row)
                head_exp.append(exp_row)
                head_max.append(current_max)
                head_sum.append(sum_exp)
            batch_weights.append(head_weights)
            batch_exp.append(head_exp)
            batch_max.append(head_max)
            batch_sum.append(head_sum)
        weights.append(batch_weights)
        exp_rows.append(batch_exp)
        row_max.append(batch_max)
        row_sum_exp.append(batch_sum)

    golden_weights, golden_max, golden_exp, golden_sum = _golden_attention_softmax(logits, mask)
    if (
        weights != golden_weights
        or row_max != golden_max
        or exp_rows != golden_exp
        or row_sum_exp != golden_sum
    ):
        raise AssertionError("attention_softmax smoke internal golden mismatch")
    return LoweredAttentionSoftmaxResult(
        schema="eliza.e1_npu_lowered_attention_softmax_result.v1",
        source_dialect=str(graph.get("dialect", "unknown")),
        source_op=source_op,
        precision=precision,
        logits=logits,
        mask=mask,
        weights_q0_8=weights,
        row_max=row_max,
        exp_q0_8=exp_rows,
        row_sum_exp=row_sum_exp,
        scalar_max_count=scalar_max_count,
        scalar_sub_count=scalar_sub_count,
        scalar_exp_count=scalar_exp_count,
        scalar_add_count=scalar_add_count,
        cpu_fallback=False,
        host_applies_mask=True,
        host_divides_by_row_sum=True,
        claim_boundary="attention_softmax_exp2_q0_8_smoke_only_not_production_softmax_or_fused_attention",
    )


def lower_attention_av_smoke(
    runtime: E1NpuRuntime, graph: dict[str, Any]
) -> LoweredAttentionAvResult:
    """Lower tiny attention-value context records into per-head GEMM commands."""

    if graph.get("schema") != SUPPORTED_ATTENTION_AV_SCHEMA:
        raise NpuLoweringError(f"unsupported graph schema {graph.get('schema')!r}")
    source_op = str(graph.get("op", ""))
    if source_op not in SUPPORTED_ATTENTION_AV_OPS:
        raise NpuLoweringError(f"unsupported attention_av source op {source_op!r}")
    precision = str(graph.get("precision", "")).lower()
    if precision not in {"int8", "int4"}:
        raise NpuLoweringError(f"unsupported attention_av precision {precision!r}")

    attention = _tensor4(graph.get("attention"), "attention")
    value = _tensor4(graph.get("value"), "value")
    _validate_attention_av_shape(attention, value)
    if precision == "int8":
        _validate_tensor_range(attention, -128, 127, "attention")
        _validate_tensor_range(value, -128, 127, "value")
    else:
        _validate_tensor_range(attention, -8, 7, "attention")
        _validate_tensor_range(value, -8, 7, "value")

    batch = len(attention)
    heads = len(attention[0])
    query_tokens = len(attention[0][0])
    value_dim = len(value[0][0][0])
    context: list[list[list[list[int]]]] = []
    golden: list[list[list[list[int]]]] = []
    matmuls: list[LoweredMatmulResult] = []
    for batch_index in range(batch):
        batch_context: list[list[list[int]]] = []
        batch_golden: list[list[list[int]]] = []
        for head_index in range(heads):
            matmul = lower_matmul_smoke(
                runtime,
                {
                    "schema": SUPPORTED_SCHEMA,
                    "dialect": graph.get("dialect", "unknown"),
                    "op": "stablehlo.dot_general",
                    "precision": precision,
                    "lhs": attention[batch_index][head_index],
                    "rhs": value[batch_index][head_index],
                },
            )
            matmuls.append(matmul)
            batch_context.append(matmul.result)
            batch_golden.append(matmul.golden)
        context.append(batch_context)
        golden.append(batch_golden)

    return LoweredAttentionAvResult(
        schema="eliza.e1_npu_lowered_attention_av_result.v1",
        source_dialect=str(graph.get("dialect", "unknown")),
        source_op=source_op,
        precision=precision,
        context=context,
        golden=golden,
        context_shape=[batch, heads, query_tokens, value_dim],
        head_count=heads,
        value_dim=value_dim,
        matmuls=matmuls,
        total_tile_count=sum(matmul.tile_count for matmul in matmuls),
        cpu_fallback=False,
        host_iterates_heads=True,
        requires_prequantized_attention=True,
        claim_boundary="attention_av_context_smoke_only_not_softmax_or_production_compiler_backend",
    )


def _default_attention_mask(
    query: list[list[list[list[int]]]], key: list[list[list[list[int]]]]
) -> list[list[list[list[bool]]]]:
    _validate_attention_qk_shape(query, key)
    return [
        [
            [[True for _ in range(len(key_head))] for _ in range(len(query_head))]
            for query_head, key_head in zip(batch_query, batch_key, strict=True)
        ]
        for batch_query, batch_key in zip(query, key, strict=True)
    ]


def _causal_attention_mask(
    query: list[list[list[list[int]]]], key: list[list[list[list[int]]]]
) -> list[list[list[list[bool]]]]:
    _validate_attention_qk_shape(query, key)
    mask: list[list[list[list[bool]]]] = []
    for batch_query, batch_key in zip(query, key, strict=True):
        batch_mask: list[list[list[bool]]] = []
        for query_head, key_head in zip(batch_query, batch_key, strict=True):
            query_tokens = len(query_head)
            key_tokens = len(key_head)
            if query_tokens > key_tokens:
                raise NpuLoweringError("causal attention mask requires query_tokens <= key_tokens")
            key_offset = key_tokens - query_tokens
            batch_mask.append(
                [
                    [key_index <= key_offset + query_index for key_index in range(key_tokens)]
                    for query_index in range(query_tokens)
                ]
            )
        mask.append(batch_mask)
    return mask


def _sliding_window_attention_mask(
    query: list[list[list[list[int]]]], key: list[list[list[list[int]]]], window: int
) -> list[list[list[list[bool]]]]:
    if window <= 0:
        raise NpuLoweringError("sliding_window attention mask requires a positive window")
    _validate_attention_qk_shape(query, key)
    mask: list[list[list[list[bool]]]] = []
    for batch_query, batch_key in zip(query, key, strict=True):
        batch_mask: list[list[list[bool]]] = []
        for query_head, key_head in zip(batch_query, batch_key, strict=True):
            query_tokens = len(query_head)
            key_tokens = len(key_head)
            if query_tokens > key_tokens:
                raise NpuLoweringError(
                    "sliding_window attention mask requires query_tokens <= key_tokens"
                )
            key_offset = key_tokens - query_tokens
            batch_mask.append(
                [
                    [
                        key_offset + query_index - window < key_index <= key_offset + query_index
                        for key_index in range(key_tokens)
                    ]
                    for query_index in range(query_tokens)
                ]
            )
        mask.append(batch_mask)
    return mask


def _zero_attention_logits(
    query: list[list[list[list[int]]]], key: list[list[list[list[int]]]]
) -> list[list[list[list[int]]]]:
    _validate_attention_qk_shape(query, key)
    return [
        [
            [[0 for _ in range(len(key_head))] for _ in range(len(query_head))]
            for query_head, key_head in zip(batch_query, batch_key, strict=True)
        ]
        for batch_query, batch_key in zip(query, key, strict=True)
    ]


def lower_attention_smoke(runtime: E1NpuRuntime, graph: dict[str, Any]) -> LoweredAttentionResult:
    """Compose multi-head QK, approximate softmax, and AV smoke lowerings."""

    if graph.get("schema") != SUPPORTED_ATTENTION_SCHEMA:
        raise NpuLoweringError(f"unsupported graph schema {graph.get('schema')!r}")
    source_op = str(graph.get("op", ""))
    if source_op not in SUPPORTED_ATTENTION_OPS:
        raise NpuLoweringError(f"unsupported attention source op {source_op!r}")
    precision = str(graph.get("precision", "")).lower()
    if precision != "int8":
        raise NpuLoweringError(f"unsupported attention precision {precision!r}")

    query = _tensor4(graph.get("query"), "query")
    key = _tensor4(graph.get("key"), "key")
    value = _tensor4(graph.get("value"), "value")
    mask_mode = str(graph.get("mask_mode", "full")).lower()
    if mask_mode not in {"full", "causal", "sliding_window"}:
        raise NpuLoweringError(f"unsupported attention mask_mode {mask_mode!r}")
    mask_window = _positive_int(graph.get("mask_window", 1), "mask_window")
    if graph.get("mask") is not None:
        mask = _bool_tensor4(graph.get("mask"), "mask")
        host_generates_causal_mask = False
        host_generates_sliding_window_mask = False
    elif mask_mode == "causal":
        mask = _causal_attention_mask(query, key)
        host_generates_causal_mask = True
        host_generates_sliding_window_mask = False
    elif mask_mode == "sliding_window":
        mask = _sliding_window_attention_mask(query, key, mask_window)
        host_generates_causal_mask = False
        host_generates_sliding_window_mask = True
    else:
        mask = _default_attention_mask(query, key)
        host_generates_causal_mask = False
        host_generates_sliding_window_mask = False
    qk_score_shift = _nonnegative_int(graph.get("qk_score_shift", 0), "qk_score_shift")
    attention_weight_shift = _nonnegative_int(
        graph.get("attention_weight_shift", 1), "attention_weight_shift"
    )
    context_shift = _nonnegative_int(graph.get("context_shift", 0), "context_shift")
    if qk_score_shift > 31 or attention_weight_shift > 31 or context_shift > 31:
        raise NpuLoweringError("attention shifts must be in 0..31")
    _validate_attention_qk_shape(query, key)
    _validate_attention_softmax_shape(_zero_attention_logits(query, key), mask)
    _validate_attention_av_shape(mask_to_int8(mask), value)

    qk_scores = lower_attention_qk_smoke(
        runtime,
        {
            "schema": SUPPORTED_ATTENTION_QK_SCHEMA,
            "dialect": graph.get("dialect", "unknown"),
            "op": "eliza.attention_qk",
            "precision": "int8",
            "query": query,
            "key": key,
        },
    )
    qk_logits_s8 = _requantize_s8_tensor4(qk_scores.scores, qk_score_shift)
    _validate_attention_softmax_shape(qk_logits_s8, mask)
    attention_softmax = lower_attention_softmax_smoke(
        runtime,
        {
            "schema": SUPPORTED_ATTENTION_SOFTMAX_SCHEMA,
            "dialect": graph.get("dialect", "unknown"),
            "op": "eliza.attention_softmax",
            "precision": "int8",
            "logits": qk_logits_s8,
            "mask": mask,
        },
    )
    attention_weights_s8 = _requantize_attention_weights_s8(
        attention_softmax.weights_q0_8, attention_weight_shift
    )
    attention_av = lower_attention_av_smoke(
        runtime,
        {
            "schema": SUPPORTED_ATTENTION_AV_SCHEMA,
            "dialect": graph.get("dialect", "unknown"),
            "op": "eliza.attention_av",
            "precision": "int8",
            "attention": attention_weights_s8,
            "value": value,
        },
    )
    context_requantized = _requantize_s8_tensor4(attention_av.context, context_shift)
    return LoweredAttentionResult(
        schema="eliza.e1_npu_lowered_attention_result.v1",
        source_dialect=str(graph.get("dialect", "unknown")),
        source_op=source_op,
        precision=precision,
        qk_scores=qk_scores,
        qk_logits_s8=qk_logits_s8,
        attention_mask=mask,
        attention_softmax=attention_softmax,
        attention_weights_s8=attention_weights_s8,
        attention_av=attention_av,
        context_requantized=context_requantized,
        head_count=len(query[0]),
        total_tile_count=qk_scores.total_tile_count + attention_av.total_tile_count,
        scalar_add_count=attention_softmax.scalar_add_count,
        cpu_fallback=False,
        computes_qk_scores=True,
        computes_attention_softmax=True,
        requires_prequantized_attention=False,
        host_generates_causal_mask=host_generates_causal_mask,
        host_generates_sliding_window_mask=host_generates_sliding_window_mask,
        host_requantizes_qk_scores=True,
        host_requantizes_attention_weights=True,
        host_requantizes_context=True,
        claim_boundary="multihead_attention_qk_exp2_softmax_av_smoke_only_not_fused_flash_attention_or_production_compiler_backend",
    )


def _materialize_attention_cache_view(
    key_cache: list[list[list[list[int]]]],
    value_cache: list[list[list[list[int]]]],
    cache_lengths: list[list[int]],
    query_tokens: int,
    cache_window: int | None = None,
) -> tuple[
    list[list[list[list[int]]]],
    list[list[list[list[int]]]],
    list[list[list[list[bool]]]],
]:
    max_observed_length = max(length for batch in cache_lengths for length in batch)
    max_length = (
        max_observed_length if cache_window is None else min(max_observed_length, cache_window)
    )
    if max_length < 1:
        raise NpuLoweringError("decode_attention requires non-empty updated cache")
    key_view: list[list[list[list[int]]]] = []
    value_view: list[list[list[list[int]]]] = []
    mask: list[list[list[list[bool]]]] = []
    for batch_index, batch_lengths in enumerate(cache_lengths):
        batch_key: list[list[list[int]]] = []
        batch_value: list[list[list[int]]] = []
        batch_mask: list[list[list[bool]]] = []
        for head_index, length in enumerate(batch_lengths):
            view_length = min(length, max_length)
            start = max(0, length - view_length)
            head_key = [list(row) for row in key_cache[batch_index][head_index][start:length]]
            head_value = [list(row) for row in value_cache[batch_index][head_index][start:length]]
            head_key.extend(
                [
                    [0 for _ in key_cache[batch_index][head_index][0]]
                    for _ in range(max_length - view_length)
                ]
            )
            head_value.extend(
                [
                    [0 for _ in value_cache[batch_index][head_index][0]]
                    for _ in range(max_length - view_length)
                ]
            )
            batch_key.append(head_key)
            batch_value.append(head_value)
            batch_mask.append(
                [
                    [token_index < view_length for token_index in range(max_length)]
                    for _ in range(query_tokens)
                ]
            )
        key_view.append(batch_key)
        value_view.append(batch_value)
        mask.append(batch_mask)
    return key_view, value_view, mask


def lower_kv_cache_update_smoke(
    runtime: E1NpuRuntime, graph: dict[str, Any]
) -> LoweredKvCacheUpdateResult:
    """Append tiny K/V decode tensors into fixed-capacity cache tensors."""

    if graph.get("schema") != SUPPORTED_KV_CACHE_UPDATE_SCHEMA:
        raise NpuLoweringError(f"unsupported graph schema {graph.get('schema')!r}")
    source_op = str(graph.get("op", ""))
    if source_op not in SUPPORTED_KV_CACHE_UPDATE_OPS:
        raise NpuLoweringError(f"unsupported kv_cache_update source op {source_op!r}")
    precision = str(graph.get("precision", "")).lower()
    if precision != "int8":
        raise NpuLoweringError(f"unsupported kv_cache_update precision {precision!r}")

    key_cache = _tensor4(graph.get("key_cache"), "key_cache")
    value_cache = _tensor4(graph.get("value_cache"), "value_cache")
    new_key = _tensor4(graph.get("new_key"), "new_key")
    new_value = _tensor4(graph.get("new_value"), "new_value")
    cache_lengths = _matrix(graph.get("cache_lengths"), "cache_lengths")
    _validate_kv_cache_update_shape(key_cache, value_cache, new_key, new_value, cache_lengths)
    _validate_tensor_range(key_cache, -128, 127, "key_cache")
    _validate_tensor_range(value_cache, -128, 127, "value_cache")
    _validate_tensor_range(new_key, -128, 127, "new_key")
    _validate_tensor_range(new_value, -128, 127, "new_value")

    updated_key_cache = _clone_tensor4(key_cache)
    updated_value_cache = _clone_tensor4(value_cache)
    updated_lengths = [list(row) for row in cache_lengths]
    appended_tokens = len(new_key[0][0])
    scalar_copy_count = 0
    for batch_index, batch_lengths in enumerate(cache_lengths):
        for head_index, start in enumerate(batch_lengths):
            for token_index in range(appended_tokens):
                dst_token = start + token_index
                for dim_index, value in enumerate(new_key[batch_index][head_index][token_index]):
                    updated_key_cache[batch_index][head_index][dst_token][dim_index] = _s32(
                        runtime.add(value, 0)
                    )
                    scalar_copy_count += 1
                for dim_index, value in enumerate(new_value[batch_index][head_index][token_index]):
                    updated_value_cache[batch_index][head_index][dst_token][dim_index] = _s32(
                        runtime.add(value, 0)
                    )
                    scalar_copy_count += 1
            updated_lengths[batch_index][head_index] = start + appended_tokens

    return LoweredKvCacheUpdateResult(
        schema="eliza.e1_npu_lowered_kv_cache_update_result.v1",
        source_dialect=str(graph.get("dialect", "unknown")),
        source_op=source_op,
        precision=precision,
        updated_key_cache=updated_key_cache,
        updated_value_cache=updated_value_cache,
        cache_lengths=updated_lengths,
        appended_tokens=appended_tokens,
        head_count=len(key_cache[0]),
        head_dim=len(key_cache[0][0][0]),
        value_dim=len(value_cache[0][0][0]),
        scalar_copy_count=scalar_copy_count,
        cpu_fallback=False,
        host_preserves_existing_cache=True,
        host_tracks_cache_lengths=True,
        claim_boundary="kv_cache_update_s8_scalar_append_smoke_only_not_paged_or_dma_cache",
    )


def lower_decode_attention_smoke(
    runtime: E1NpuRuntime, graph: dict[str, Any]
) -> LoweredDecodeAttentionResult:
    """Append K/V cache tokens, then attend query tokens over the updated cache."""

    if graph.get("schema") != SUPPORTED_DECODE_ATTENTION_SCHEMA:
        raise NpuLoweringError(f"unsupported graph schema {graph.get('schema')!r}")
    source_op = str(graph.get("op", ""))
    if source_op not in SUPPORTED_DECODE_ATTENTION_OPS:
        raise NpuLoweringError(f"unsupported decode_attention source op {source_op!r}")
    precision = str(graph.get("precision", "")).lower()
    if precision != "int8":
        raise NpuLoweringError(f"unsupported decode_attention precision {precision!r}")

    query = _tensor4(graph.get("query"), "query")
    key_cache = _tensor4(graph.get("key_cache"), "key_cache")
    value_cache = _tensor4(graph.get("value_cache"), "value_cache")
    new_key = _tensor4(graph.get("new_key"), "new_key")
    new_value = _tensor4(graph.get("new_value"), "new_value")
    cache_lengths = _matrix(graph.get("cache_lengths"), "cache_lengths")
    qk_score_shift = _nonnegative_int(graph.get("qk_score_shift", 0), "qk_score_shift")
    attention_weight_shift = _nonnegative_int(
        graph.get("attention_weight_shift", 1), "attention_weight_shift"
    )
    context_shift = _nonnegative_int(graph.get("context_shift", 0), "context_shift")
    cache_window = (
        None
        if graph.get("cache_window") is None
        else _positive_int(graph.get("cache_window"), "cache_window")
    )
    if qk_score_shift > 31 or attention_weight_shift > 31 or context_shift > 31:
        raise NpuLoweringError("decode_attention shifts must be in 0..31")
    _validate_attention_qk_shape(query, key_cache)
    _validate_kv_cache_update_shape(key_cache, value_cache, new_key, new_value, cache_lengths)

    kv_cache_update = lower_kv_cache_update_smoke(
        runtime,
        {
            "schema": SUPPORTED_KV_CACHE_UPDATE_SCHEMA,
            "dialect": graph.get("dialect", "unknown"),
            "op": "eliza.kv_cache_update",
            "precision": "int8",
            "key_cache": key_cache,
            "value_cache": value_cache,
            "new_key": new_key,
            "new_value": new_value,
            "cache_lengths": cache_lengths,
        },
    )
    key_view, value_view, mask = _materialize_attention_cache_view(
        kv_cache_update.updated_key_cache,
        kv_cache_update.updated_value_cache,
        kv_cache_update.cache_lengths,
        len(query[0][0]),
        cache_window,
    )
    attention = lower_attention_smoke(
        runtime,
        {
            "schema": SUPPORTED_ATTENTION_SCHEMA,
            "dialect": graph.get("dialect", "unknown"),
            "op": "eliza.attention",
            "precision": "int8",
            "query": query,
            "key": key_view,
            "value": value_view,
            "mask": mask,
            "qk_score_shift": qk_score_shift,
            "attention_weight_shift": attention_weight_shift,
            "context_shift": context_shift,
        },
    )
    max_cache_length = len(key_view[0][0])
    return LoweredDecodeAttentionResult(
        schema="eliza.e1_npu_lowered_decode_attention_result.v1",
        source_dialect=str(graph.get("dialect", "unknown")),
        source_op=source_op,
        precision=precision,
        kv_cache_update=kv_cache_update,
        attention=attention,
        attention_key_cache_view=key_view,
        attention_value_cache_view=value_view,
        attention_mask=mask,
        updated_cache_lengths=kv_cache_update.cache_lengths,
        max_attention_cache_length=max_cache_length,
        total_tile_count=attention.total_tile_count,
        scalar_add_count=kv_cache_update.scalar_copy_count + attention.scalar_add_count,
        cpu_fallback=False,
        updates_kv_cache=True,
        computes_attention_over_cache=True,
        host_materializes_cache_view=True,
        host_applies_decode_cache_window=cache_window is not None,
        decode_cache_window=cache_window,
        claim_boundary="decode_attention_kv_append_qk_softmax_av_smoke_only_not_paged_cache_flash_attention_or_production_compiler_backend",
    )


def lower_attention_qk_smoke(
    runtime: E1NpuRuntime, graph: dict[str, Any]
) -> LoweredAttentionQkResult:
    """Lower tiny QK attention score records into per-head GEMM smoke commands."""

    if graph.get("schema") != SUPPORTED_ATTENTION_QK_SCHEMA:
        raise NpuLoweringError(f"unsupported graph schema {graph.get('schema')!r}")
    source_op = str(graph.get("op", ""))
    if source_op not in SUPPORTED_ATTENTION_QK_OPS:
        raise NpuLoweringError(f"unsupported attention_qk source op {source_op!r}")
    precision = str(graph.get("precision", "")).lower()
    if precision not in {"int8", "int4"}:
        raise NpuLoweringError(f"unsupported attention_qk precision {precision!r}")

    query = _tensor4(graph.get("query"), "query")
    key = _tensor4(graph.get("key"), "key")
    _validate_attention_qk_shape(query, key)
    if precision == "int8":
        _validate_tensor_range(query, -128, 127, "query")
        _validate_tensor_range(key, -128, 127, "key")
    else:
        _validate_tensor_range(query, -8, 7, "query")
        _validate_tensor_range(key, -8, 7, "key")

    batch = len(query)
    heads = len(query[0])
    query_tokens = len(query[0][0])
    key_tokens = len(key[0][0])
    head_dim = len(query[0][0][0])
    scores: list[list[list[list[int]]]] = []
    golden: list[list[list[list[int]]]] = []
    matmuls: list[LoweredMatmulResult] = []
    for batch_index in range(batch):
        batch_scores: list[list[list[int]]] = []
        batch_golden: list[list[list[int]]] = []
        for head_index in range(heads):
            rhs = _transpose_matrix(key[batch_index][head_index])
            matmul = lower_matmul_smoke(
                runtime,
                {
                    "schema": SUPPORTED_SCHEMA,
                    "dialect": graph.get("dialect", "unknown"),
                    "op": "stablehlo.dot_general",
                    "precision": precision,
                    "lhs": query[batch_index][head_index],
                    "rhs": rhs,
                },
            )
            matmuls.append(matmul)
            batch_scores.append(matmul.result)
            batch_golden.append(matmul.golden)
        scores.append(batch_scores)
        golden.append(batch_golden)

    return LoweredAttentionQkResult(
        schema="eliza.e1_npu_lowered_attention_qk_result.v1",
        source_dialect=str(graph.get("dialect", "unknown")),
        source_op=source_op,
        precision=precision,
        scores=scores,
        golden=golden,
        score_shape=[batch, heads, query_tokens, key_tokens],
        head_count=heads,
        head_dim=head_dim,
        matmuls=matmuls,
        total_tile_count=sum(matmul.tile_count for matmul in matmuls),
        cpu_fallback=False,
        host_transposes_keys=True,
        host_iterates_heads=True,
        claim_boundary="attention_qk_scores_smoke_only_not_softmax_or_production_compiler_backend",
    )


def lower_conv2d_smoke(runtime: E1NpuRuntime, graph: dict[str, Any]) -> LoweredConv2dResult:
    """Lower one tiny Conv2D record through im2col into the matmul smoke path."""

    if graph.get("schema") != SUPPORTED_CONV2D_SCHEMA:
        raise NpuLoweringError(f"unsupported graph schema {graph.get('schema')!r}")
    source_op = str(graph.get("op", ""))
    if source_op not in SUPPORTED_CONV2D_OPS:
        raise NpuLoweringError(f"unsupported conv2d source op {source_op!r}")
    precision = str(graph.get("precision", "")).lower()
    if precision not in {"int8", "int4"}:
        raise NpuLoweringError(f"unsupported conv2d precision {precision!r}")

    input_nhwc = _tensor4(graph.get("input"), "input")
    filters_hwio = _tensor4(graph.get("filter"), "filter")
    _validate_conv2d_shape(input_nhwc, filters_hwio, graph)
    if precision == "int8":
        _validate_tensor_range(input_nhwc, -128, 127, "input")
        _validate_tensor_range(filters_hwio, -128, 127, "filter")
    else:
        _validate_tensor_range(input_nhwc, -8, 7, "input")
        _validate_tensor_range(filters_hwio, -8, 7, "filter")

    im2col, filter_matrix, output_shape = _conv2d_im2col_valid(input_nhwc, filters_hwio)
    matmul = lower_matmul_smoke(
        runtime,
        {
            "schema": SUPPORTED_SCHEMA,
            "dialect": graph.get("dialect", "unknown"),
            "op": "stablehlo.dot_general",
            "precision": precision,
            "lhs": im2col,
            "rhs": filter_matrix,
        },
    )
    output = _reshape_conv2d_output(matmul.result, output_shape)
    golden = _reshape_conv2d_output(matmul.golden, output_shape)

    return LoweredConv2dResult(
        schema="eliza.e1_npu_lowered_conv2d_result.v1",
        source_dialect=str(graph.get("dialect", "unknown")),
        source_op=source_op,
        precision=precision,
        output=output,
        golden=golden,
        output_shape=output_shape,
        im2col_shape=[len(im2col), len(im2col[0])],
        filter_matrix_shape=[len(filter_matrix), len(filter_matrix[0])],
        matmul=matmul,
        cpu_fallback=False,
        host_materializes_im2col=True,
        claim_boundary="single_conv2d_im2col_smoke_only_not_production_compiler_backend",
    )


def _depthwise_conv2d_direct(
    runtime: E1NpuRuntime,
    input_nhwc: list[list[list[list[int]]]],
    filters_hwcm: list[list[list[list[int]]]],
) -> tuple[list[list[list[list[int]]]], int, int]:
    filter_h = len(filters_hwcm)
    filter_w = len(filters_hwcm[0])
    input_h = len(input_nhwc[0])
    input_w = len(input_nhwc[0][0])
    input_c = len(input_nhwc[0][0][0])
    multiplier = len(filters_hwcm[0][0][0])
    output_h = input_h - filter_h + 1
    output_w = input_w - filter_w + 1
    output: list[list[list[int]]] = [[[] for _ in range(output_w)] for _ in range(output_h)]
    mul_count = 0
    add_count = 0
    for out_y in range(output_h):
        for out_x in range(output_w):
            values: list[int] = []
            for channel in range(input_c):
                for mult in range(multiplier):
                    acc = 0
                    for filt_y in range(filter_h):
                        for filt_x in range(filter_w):
                            product = _s32(
                                runtime.mul_lo(
                                    input_nhwc[0][out_y + filt_y][out_x + filt_x][channel],
                                    filters_hwcm[filt_y][filt_x][channel][mult],
                                )
                            )
                            mul_count += 1
                            acc = _s32(runtime.add(acc, product))
                            add_count += 1
                    values.append(acc)
            output[out_y][out_x] = values
    return [output], mul_count, add_count


def _golden_depthwise_conv2d(
    input_nhwc: list[list[list[list[int]]]], filters_hwcm: list[list[list[list[int]]]]
) -> list[list[list[list[int]]]]:
    filter_h = len(filters_hwcm)
    filter_w = len(filters_hwcm[0])
    input_h = len(input_nhwc[0])
    input_w = len(input_nhwc[0][0])
    input_c = len(input_nhwc[0][0][0])
    multiplier = len(filters_hwcm[0][0][0])
    output_h = input_h - filter_h + 1
    output_w = input_w - filter_w + 1
    output: list[list[list[int]]] = [[[] for _ in range(output_w)] for _ in range(output_h)]
    for out_y in range(output_h):
        for out_x in range(output_w):
            values: list[int] = []
            for channel in range(input_c):
                for mult in range(multiplier):
                    acc = 0
                    for filt_y in range(filter_h):
                        for filt_x in range(filter_w):
                            acc = _s32(
                                acc
                                + input_nhwc[0][out_y + filt_y][out_x + filt_x][channel]
                                * filters_hwcm[filt_y][filt_x][channel][mult]
                            )
                    values.append(acc)
            output[out_y][out_x] = values
    return [output]


def _grouped_conv2d_direct(
    runtime: E1NpuRuntime,
    input_nhwc: list[list[list[list[int]]]],
    filters_hwio: list[list[list[list[int]]]],
    groups: int,
) -> tuple[list[list[list[list[int]]]], int, int]:
    filter_h = len(filters_hwio)
    filter_w = len(filters_hwio[0])
    input_h = len(input_nhwc[0])
    input_w = len(input_nhwc[0][0])
    input_c = len(input_nhwc[0][0][0])
    output_c = len(filters_hwio[0][0][0])
    input_per_group = input_c // groups
    output_per_group = output_c // groups
    output_h = input_h - filter_h + 1
    output_w = input_w - filter_w + 1
    output: list[list[list[int]]] = [[[] for _ in range(output_w)] for _ in range(output_h)]
    mul_count = 0
    add_count = 0
    for out_y in range(output_h):
        for out_x in range(output_w):
            values: list[int] = []
            for group in range(groups):
                for out_group_channel in range(output_per_group):
                    output_channel = group * output_per_group + out_group_channel
                    acc = 0
                    for filt_y in range(filter_h):
                        for filt_x in range(filter_w):
                            for input_group_channel in range(input_per_group):
                                input_channel = group * input_per_group + input_group_channel
                                product = _s32(
                                    runtime.mul_lo(
                                        input_nhwc[0][out_y + filt_y][out_x + filt_x][
                                            input_channel
                                        ],
                                        filters_hwio[filt_y][filt_x][input_group_channel][
                                            output_channel
                                        ],
                                    )
                                )
                                mul_count += 1
                                acc = _s32(runtime.add(acc, product))
                                add_count += 1
                    values.append(acc)
            output[out_y][out_x] = values
    return [output], mul_count, add_count


def _golden_grouped_conv2d(
    input_nhwc: list[list[list[list[int]]]],
    filters_hwio: list[list[list[list[int]]]],
    groups: int,
) -> list[list[list[list[int]]]]:
    filter_h = len(filters_hwio)
    filter_w = len(filters_hwio[0])
    input_h = len(input_nhwc[0])
    input_w = len(input_nhwc[0][0])
    input_c = len(input_nhwc[0][0][0])
    output_c = len(filters_hwio[0][0][0])
    input_per_group = input_c // groups
    output_per_group = output_c // groups
    output_h = input_h - filter_h + 1
    output_w = input_w - filter_w + 1
    output: list[list[list[int]]] = [[[] for _ in range(output_w)] for _ in range(output_h)]
    for out_y in range(output_h):
        for out_x in range(output_w):
            values: list[int] = []
            for group in range(groups):
                for out_group_channel in range(output_per_group):
                    output_channel = group * output_per_group + out_group_channel
                    acc = 0
                    for filt_y in range(filter_h):
                        for filt_x in range(filter_w):
                            for input_group_channel in range(input_per_group):
                                input_channel = group * input_per_group + input_group_channel
                                acc = _s32(
                                    acc
                                    + input_nhwc[0][out_y + filt_y][out_x + filt_x][input_channel]
                                    * filters_hwio[filt_y][filt_x][input_group_channel][
                                        output_channel
                                    ]
                                )
                    values.append(acc)
            output[out_y][out_x] = values
    return [output]


def lower_depthwise_conv2d_smoke(
    runtime: E1NpuRuntime, graph: dict[str, Any]
) -> LoweredDepthwiseConv2dResult:
    """Lower tiny depthwise Conv2D records through direct scalar NPU MAC loops."""

    if graph.get("schema") != SUPPORTED_DEPTHWISE_CONV2D_SCHEMA:
        raise NpuLoweringError(f"unsupported graph schema {graph.get('schema')!r}")
    source_op = str(graph.get("op", ""))
    if source_op not in SUPPORTED_DEPTHWISE_CONV2D_OPS:
        raise NpuLoweringError(f"unsupported depthwise_conv2d source op {source_op!r}")
    precision = str(graph.get("precision", "")).lower()
    if precision != "int8":
        raise NpuLoweringError(f"unsupported depthwise_conv2d precision {precision!r}")

    input_nhwc = _tensor4(graph.get("input"), "input")
    filters_hwcm = _tensor4(graph.get("filter"), "filter")
    _validate_depthwise_conv2d_shape(input_nhwc, filters_hwcm, graph)
    _validate_tensor_range(input_nhwc, -128, 127, "input")
    _validate_tensor_range(filters_hwcm, -128, 127, "filter")

    output, mul_count, add_count = _depthwise_conv2d_direct(runtime, input_nhwc, filters_hwcm)
    golden = _golden_depthwise_conv2d(input_nhwc, filters_hwcm)
    output_shape = [1, len(output[0]), len(output[0][0]), len(output[0][0][0])]
    return LoweredDepthwiseConv2dResult(
        schema="eliza.e1_npu_lowered_depthwise_conv2d_result.v1",
        source_dialect=str(graph.get("dialect", "unknown")),
        source_op=source_op,
        precision=precision,
        output=output,
        golden=golden,
        output_shape=output_shape,
        input_channels=len(input_nhwc[0][0][0]),
        channel_multiplier=len(filters_hwcm[0][0][0]),
        scalar_mul_count=mul_count,
        scalar_add_count=add_count,
        cpu_fallback=False,
        host_uses_direct_depthwise_loops=True,
        host_materializes_im2col=False,
        claim_boundary="depthwise_conv2d_direct_scalar_smoke_only_not_vector_depthwise_or_production_compiler_backend",
    )


def lower_grouped_conv2d_smoke(
    runtime: E1NpuRuntime, graph: dict[str, Any]
) -> LoweredGroupedConv2dResult:
    """Lower tiny grouped Conv2D records through direct scalar NPU MAC loops."""

    if graph.get("schema") != SUPPORTED_GROUPED_CONV2D_SCHEMA:
        raise NpuLoweringError(f"unsupported graph schema {graph.get('schema')!r}")
    source_op = str(graph.get("op", ""))
    if source_op not in SUPPORTED_GROUPED_CONV2D_OPS:
        raise NpuLoweringError(f"unsupported grouped_conv2d source op {source_op!r}")
    precision = str(graph.get("precision", "")).lower()
    if precision != "int8":
        raise NpuLoweringError(f"unsupported grouped_conv2d precision {precision!r}")

    input_nhwc = _tensor4(graph.get("input"), "input")
    filters_hwio = _tensor4(graph.get("filter"), "filter")
    groups = _positive_int(graph.get("groups"), "groups")
    _validate_grouped_conv2d_shape(input_nhwc, filters_hwio, groups, graph)
    _validate_tensor_range(input_nhwc, -128, 127, "input")
    _validate_tensor_range(filters_hwio, -128, 127, "filter")

    output, mul_count, add_count = _grouped_conv2d_direct(runtime, input_nhwc, filters_hwio, groups)
    golden = _golden_grouped_conv2d(input_nhwc, filters_hwio, groups)
    output_shape = [1, len(output[0]), len(output[0][0]), len(output[0][0][0])]
    input_channels_per_group = len(input_nhwc[0][0][0]) // groups
    output_channels_per_group = len(filters_hwio[0][0][0]) // groups
    return LoweredGroupedConv2dResult(
        schema="eliza.e1_npu_lowered_grouped_conv2d_result.v1",
        source_dialect=str(graph.get("dialect", "unknown")),
        source_op=source_op,
        precision=precision,
        output=output,
        golden=golden,
        output_shape=output_shape,
        groups=groups,
        input_channels_per_group=input_channels_per_group,
        output_channels_per_group=output_channels_per_group,
        scalar_mul_count=mul_count,
        scalar_add_count=add_count,
        cpu_fallback=False,
        host_uses_direct_grouped_loops=True,
        host_materializes_im2col=False,
        claim_boundary="grouped_conv2d_direct_scalar_smoke_only_not_vector_grouped_conv_or_production_compiler_backend",
    )


def _matrix(value: Any, name: str) -> list[list[int]]:
    if not isinstance(value, list) or not value:
        raise NpuLoweringError(f"{name} must be a non-empty matrix")
    matrix: list[list[int]] = []
    for row in value:
        if not isinstance(row, list) or not row:
            raise NpuLoweringError(f"{name} must contain non-empty rows")
        matrix.append([_int(element, name) for element in row])
    width = len(matrix[0])
    if any(len(row) != width for row in matrix):
        raise NpuLoweringError(f"{name} must be rectangular")
    return matrix


def _tensor3(value: Any, name: str) -> list[list[list[int]]]:
    if not isinstance(value, list) or not value:
        raise NpuLoweringError(f"{name} must be a non-empty rank-3 tensor")
    tensor: list[list[list[int]]] = []
    dim1: int | None = None
    dim2: int | None = None
    for item0 in value:
        if not isinstance(item0, list) or not item0:
            raise NpuLoweringError(f"{name} must contain non-empty rank-2 slices")
        if dim1 is None:
            dim1 = len(item0)
        elif len(item0) != dim1:
            raise NpuLoweringError(f"{name} must be rectangular")
        tensor_item0: list[list[int]] = []
        for item1 in item0:
            if not isinstance(item1, list) or not item1:
                raise NpuLoweringError(f"{name} must contain non-empty innermost rows")
            if dim2 is None:
                dim2 = len(item1)
            elif len(item1) != dim2:
                raise NpuLoweringError(f"{name} must be rectangular")
            tensor_item0.append([_int(element, name) for element in item1])
        tensor.append(tensor_item0)
    return tensor


def _lowered_result_as_dict(value: Any) -> dict[str, Any]:
    as_dict = getattr(value, "as_dict", None)
    if not callable(as_dict):
        raise NpuLoweringError(f"lowered result {type(value).__name__} lacks as_dict")
    result = as_dict()
    if not isinstance(result, dict):
        raise NpuLoweringError(f"lowered result {type(value).__name__} as_dict returned non-dict")
    return result


def _vector(value: Any, name: str) -> list[int]:
    if not isinstance(value, list) or not value:
        raise NpuLoweringError(f"{name} must be a non-empty vector")
    return [_int(element, name) for element in value]


def _tensor4(value: Any, name: str) -> list[list[list[list[int]]]]:
    if not isinstance(value, list) or not value:
        raise NpuLoweringError(f"{name} must be a non-empty rank-4 tensor")
    tensor: list[list[list[list[int]]]] = []
    dim1: int | None = None
    dim2: int | None = None
    dim3: int | None = None
    for item0 in value:
        if not isinstance(item0, list) or not item0:
            raise NpuLoweringError(f"{name} must contain non-empty rank-3 slices")
        if dim1 is None:
            dim1 = len(item0)
        elif len(item0) != dim1:
            raise NpuLoweringError(f"{name} must be rectangular")
        tensor_item0: list[list[list[int]]] = []
        for item1 in item0:
            if not isinstance(item1, list) or not item1:
                raise NpuLoweringError(f"{name} must contain non-empty rank-2 slices")
            if dim2 is None:
                dim2 = len(item1)
            elif len(item1) != dim2:
                raise NpuLoweringError(f"{name} must be rectangular")
            tensor_item1: list[list[int]] = []
            for item2 in item1:
                if not isinstance(item2, list) or not item2:
                    raise NpuLoweringError(f"{name} must contain non-empty innermost rows")
                if dim3 is None:
                    dim3 = len(item2)
                elif len(item2) != dim3:
                    raise NpuLoweringError(f"{name} must be rectangular")
                tensor_item1.append([_int(element, name) for element in item2])
            tensor_item0.append(tensor_item1)
        tensor.append(tensor_item0)
    return tensor


def _bool_tensor4(value: Any, name: str) -> list[list[list[list[bool]]]]:
    if not isinstance(value, list) or not value:
        raise NpuLoweringError(f"{name} must be a non-empty rank-4 boolean tensor")
    tensor: list[list[list[list[bool]]]] = []
    dim1: int | None = None
    dim2: int | None = None
    dim3: int | None = None
    for item0 in value:
        if not isinstance(item0, list) or not item0:
            raise NpuLoweringError(f"{name} must contain non-empty rank-3 slices")
        if dim1 is None:
            dim1 = len(item0)
        elif len(item0) != dim1:
            raise NpuLoweringError(f"{name} must be rectangular")
        tensor_item0: list[list[list[bool]]] = []
        for item1 in item0:
            if not isinstance(item1, list) or not item1:
                raise NpuLoweringError(f"{name} must contain non-empty rank-2 slices")
            if dim2 is None:
                dim2 = len(item1)
            elif len(item1) != dim2:
                raise NpuLoweringError(f"{name} must be rectangular")
            tensor_item1: list[list[bool]] = []
            for item2 in item1:
                if not isinstance(item2, list) or not item2:
                    raise NpuLoweringError(f"{name} must contain non-empty innermost rows")
                if dim3 is None:
                    dim3 = len(item2)
                elif len(item2) != dim3:
                    raise NpuLoweringError(f"{name} must be rectangular")
                if any(not isinstance(element, bool) for element in item2):
                    raise NpuLoweringError(f"{name} entries must be boolean")
                tensor_item1.append(list(item2))
            tensor_item0.append(tensor_item1)
        tensor.append(tensor_item0)
    return tensor


def _int(value: Any, name: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise NpuLoweringError(f"{name} values must be integers")
    return value


def _nonnegative_int(value: Any, name: str) -> int:
    result = _int(value, name)
    if result < 0:
        raise NpuLoweringError(f"{name} must be non-negative")
    return result


def _positive_int(value: Any, name: str) -> int:
    result = _int(value, name)
    if result <= 0:
        raise NpuLoweringError(f"{name} must be positive")
    return result


def _s32(value: int) -> int:
    value &= 0xFFFF_FFFF
    return value - 0x1_0000_0000 if value & 0x8000_0000 else value


def _validate_matmul_shape(lhs: list[list[int]], rhs: list[list[int]]) -> None:
    m = len(lhs)
    k = len(lhs[0])
    rhs_k = len(rhs)
    n = len(rhs[0])
    if k != rhs_k:
        raise NpuLoweringError(f"matmul K mismatch: lhs K={k}, rhs K={rhs_k}")
    if k < 1:
        raise NpuLoweringError("matmul smoke path requires non-empty K dimension")
    if m < 1 or n < 1:
        raise NpuLoweringError("matmul smoke path requires non-empty M/N dimensions")


def _validate_batch_matmul_shape(
    lhs: list[list[list[list[int]]]], rhs: list[list[list[list[int]]]]
) -> None:
    batch = len(lhs)
    if len(rhs) != batch:
        raise NpuLoweringError(f"batch_matmul batch mismatch: lhs B={batch}, rhs B={len(rhs)}")
    heads = len(lhs[0])
    if len(rhs[0]) != heads:
        raise NpuLoweringError(f"batch_matmul head mismatch: lhs H={heads}, rhs H={len(rhs[0])}")
    for batch_index, (lhs_batch, rhs_batch) in enumerate(zip(lhs, rhs, strict=True)):
        if len(lhs_batch) != heads or len(rhs_batch) != heads:
            raise NpuLoweringError("batch_matmul head count must be rectangular")
        for head_index, (lhs_head, rhs_head) in enumerate(zip(lhs_batch, rhs_batch, strict=True)):
            try:
                _validate_matmul_shape(lhs_head, rhs_head)
            except NpuLoweringError as exc:
                raise NpuLoweringError(
                    f"batch_matmul slice [{batch_index}][{head_index}] invalid: {exc}"
                ) from exc


def _validate_qkv_projection_shape(inputs: list[list[int]], packed_weight: list[list[int]]) -> None:
    _validate_matmul_shape(inputs, packed_weight)
    output_width = len(packed_weight[0])
    if output_width % 3 != 0:
        raise NpuLoweringError(
            f"qkv_projection packed output width must be divisible by 3: {output_width}"
        )
    hidden_width = output_width // 3
    if hidden_width != len(inputs[0]):
        raise NpuLoweringError(
            f"qkv_projection hidden width mismatch: input D={len(inputs[0])}, q/k/v D={hidden_width}"
        )


def _validate_sparse_int4_matmul_shape(
    lhs: list[list[int]],
    rhs_nonzero: list[list[list[int]]],
    rhs_positions: list[list[list[int]]],
) -> None:
    if len(rhs_positions) != len(rhs_nonzero):
        raise NpuLoweringError("sparse_int4_matmul metadata block mismatch")
    output_cols = len(rhs_nonzero[0])
    if output_cols < 1:
        raise NpuLoweringError("sparse_int4_matmul requires non-empty output columns")
    for block_index, block in enumerate(rhs_nonzero):
        if len(block) != output_cols or len(rhs_positions[block_index]) != output_cols:
            raise NpuLoweringError("sparse_int4_matmul metadata column mismatch")
        for col_index, nonzero_weights in enumerate(block):
            positions = rhs_positions[block_index][col_index]
            if len(nonzero_weights) != 4:
                raise NpuLoweringError("sparse_int4_matmul requires four nonzero weights per block")
            if len(positions) != 4:
                raise NpuLoweringError(
                    "sparse_int4_matmul requires four metadata positions per block"
                )
            if len(set(positions[:2])) != 2 or len(set(positions[2:])) != 2:
                raise NpuLoweringError("sparse_int4_matmul requires distinct 2:4 positions")
    if len(lhs[0]) > len(rhs_nonzero) * 8:
        raise NpuLoweringError("sparse_int4_matmul K exceeds sparse metadata blocks")
    if len(lhs[0]) <= (len(rhs_nonzero) - 1) * 8:
        raise NpuLoweringError("sparse_int4_matmul has unused sparse metadata blocks")


def _validate_group_scaled_int4_matmul_shape(
    lhs: list[list[int]],
    rhs: list[list[int]],
    scales_q8_8: list[list[int]],
    group_size: int,
) -> None:
    output_cols = len(rhs[0])
    group_count = (len(rhs) + group_size - 1) // group_size
    if len(scales_q8_8) != group_count:
        raise NpuLoweringError(
            f"group_scaled_int4_matmul scale group mismatch: expected {group_count}, "
            f"got {len(scales_q8_8)}"
        )
    for group_index, scale_row in enumerate(scales_q8_8):
        if len(scale_row) != output_cols:
            raise NpuLoweringError(
                "group_scaled_int4_matmul scale output-column mismatch: "
                f"group {group_index} has {len(scale_row)}, expected {output_cols}"
            )
    if group_size > len(lhs[0]):
        raise NpuLoweringError("group_scaled_int4_matmul group_size exceeds K")


def _validate_same_shape(lhs: list[list[int]], rhs: list[list[int]], op_name: str) -> None:
    if len(lhs) != len(rhs) or len(lhs[0]) != len(rhs[0]):
        raise NpuLoweringError(
            f"{op_name} shape mismatch: lhs={len(lhs)}x{len(lhs[0])}, rhs={len(rhs)}x{len(rhs[0])}"
        )


def _validate_rope_shape(inputs: list[list[int]], cos: list[int], sin: list[int]) -> None:
    width = len(inputs[0])
    if width < 2 or width % 2 != 0:
        raise NpuLoweringError("rope smoke path requires an even non-empty model dimension")
    if len(cos) != width // 2:
        raise NpuLoweringError(f"rope cos width mismatch: input D={width}, cos={len(cos)}")
    if len(sin) != width // 2:
        raise NpuLoweringError(f"rope sin width mismatch: input D={width}, sin={len(sin)}")


def _validate_rmsnorm_shape(inputs: list[list[int]], weight: list[int]) -> None:
    width = len(inputs[0])
    if width < 1:
        raise NpuLoweringError("rmsnorm smoke path requires non-empty model dimension")
    if len(weight) != width:
        raise NpuLoweringError(
            f"rmsnorm weight width mismatch: input D={width}, weight={len(weight)}"
        )


def _validate_mlp_shape(
    inputs: list[list[int]],
    up_weight: list[list[int]],
    down_weight: list[list[int]],
    runtime: E1NpuRuntime,
) -> None:
    _validate_matmul_shape(inputs, up_weight)
    hidden_width = len(up_weight[0])
    if len(down_weight) != hidden_width:
        raise NpuLoweringError(
            f"mlp hidden K mismatch: up hidden={hidden_width}, down K={len(down_weight)}"
        )
    if len(inputs) * hidden_width > runtime.SCRATCH_BYTES:
        raise NpuLoweringError("mlp hidden activation exceeds VRELU_S8 scratchpad length")


def _validate_swiglu_shape(
    inputs: list[list[int]],
    up_weight: list[list[int]],
    gate_weight: list[list[int]],
    down_weight: list[list[int]],
) -> None:
    _validate_matmul_shape(inputs, up_weight)
    _validate_matmul_shape(inputs, gate_weight)
    hidden_width = len(up_weight[0])
    if len(gate_weight[0]) != hidden_width:
        raise NpuLoweringError(
            f"swiglu gate width mismatch: up hidden={hidden_width}, gate hidden={len(gate_weight[0])}"
        )
    if len(down_weight) != hidden_width:
        raise NpuLoweringError(
            f"swiglu down K mismatch: hidden={hidden_width}, down K={len(down_weight)}"
        )


def _validate_conv2d_shape(
    input_nhwc: list[list[list[list[int]]]],
    filters_hwio: list[list[list[list[int]]]],
    graph: dict[str, Any],
) -> None:
    batch = len(input_nhwc)
    input_h = len(input_nhwc[0])
    input_w = len(input_nhwc[0][0])
    input_c = len(input_nhwc[0][0][0])
    filter_h = len(filters_hwio)
    filter_w = len(filters_hwio[0])
    filter_c = len(filters_hwio[0][0])
    output_c = len(filters_hwio[0][0][0])
    if batch != 1:
        raise NpuLoweringError("conv2d smoke path currently supports batch=1 only")
    if filter_c != input_c:
        raise NpuLoweringError(f"conv2d channel mismatch: input C={input_c}, filter I={filter_c}")
    if output_c < 1:
        raise NpuLoweringError("conv2d smoke path requires non-empty output channels")
    if str(graph.get("data_format", "NHWC")).upper() != "NHWC":
        raise NpuLoweringError("conv2d smoke path requires NHWC input format")
    if str(graph.get("filter_format", "HWIO")).upper() != "HWIO":
        raise NpuLoweringError("conv2d smoke path requires HWIO filter format")
    if str(graph.get("padding", "VALID")).upper() != "VALID":
        raise NpuLoweringError("conv2d smoke path currently supports VALID padding only")
    if _pair(graph.get("strides", [1, 1]), "strides") != [1, 1]:
        raise NpuLoweringError("conv2d smoke path currently supports stride 1 only")
    if _pair(graph.get("dilations", [1, 1]), "dilations") != [1, 1]:
        raise NpuLoweringError("conv2d smoke path currently supports dilation 1 only")
    if input_h < filter_h or input_w < filter_w:
        raise NpuLoweringError("conv2d filter must fit inside VALID input extent")


def _validate_depthwise_conv2d_shape(
    input_nhwc: list[list[list[list[int]]]],
    filters_hwcm: list[list[list[list[int]]]],
    graph: dict[str, Any],
) -> None:
    batch = len(input_nhwc)
    input_h = len(input_nhwc[0])
    input_w = len(input_nhwc[0][0])
    input_c = len(input_nhwc[0][0][0])
    filter_h = len(filters_hwcm)
    filter_w = len(filters_hwcm[0])
    filter_c = len(filters_hwcm[0][0])
    multiplier = len(filters_hwcm[0][0][0])
    if batch != 1:
        raise NpuLoweringError("depthwise_conv2d smoke path currently supports batch=1 only")
    if filter_c != input_c:
        raise NpuLoweringError(
            f"depthwise_conv2d channel mismatch: input C={input_c}, filter C={filter_c}"
        )
    if multiplier < 1:
        raise NpuLoweringError("depthwise_conv2d requires non-empty channel multiplier")
    if str(graph.get("data_format", "NHWC")).upper() != "NHWC":
        raise NpuLoweringError("depthwise_conv2d smoke path requires NHWC input format")
    if str(graph.get("filter_format", "HWCM")).upper() != "HWCM":
        raise NpuLoweringError("depthwise_conv2d smoke path requires HWCM filter format")
    if str(graph.get("padding", "VALID")).upper() != "VALID":
        raise NpuLoweringError("depthwise_conv2d smoke path currently supports VALID padding only")
    if _pair(graph.get("strides", [1, 1]), "strides") != [1, 1]:
        raise NpuLoweringError("depthwise_conv2d smoke path currently supports stride 1 only")
    if _pair(graph.get("dilations", [1, 1]), "dilations") != [1, 1]:
        raise NpuLoweringError("depthwise_conv2d smoke path currently supports dilation 1 only")
    if input_h < filter_h or input_w < filter_w:
        raise NpuLoweringError("depthwise_conv2d filter must fit inside VALID input extent")


def _validate_grouped_conv2d_shape(
    input_nhwc: list[list[list[list[int]]]],
    filters_hwio: list[list[list[list[int]]]],
    groups: int,
    graph: dict[str, Any],
) -> None:
    batch = len(input_nhwc)
    input_h = len(input_nhwc[0])
    input_w = len(input_nhwc[0][0])
    input_c = len(input_nhwc[0][0][0])
    filter_h = len(filters_hwio)
    filter_w = len(filters_hwio[0])
    filter_c = len(filters_hwio[0][0])
    output_c = len(filters_hwio[0][0][0])
    if batch != 1:
        raise NpuLoweringError("grouped_conv2d smoke path currently supports batch=1 only")
    if groups <= 1:
        raise NpuLoweringError("grouped_conv2d requires groups greater than 1")
    if groups >= input_c:
        raise NpuLoweringError("grouped_conv2d excludes depthwise groups; use depthwise_conv2d")
    if input_c % groups != 0:
        raise NpuLoweringError("grouped_conv2d input channels must divide evenly by groups")
    if output_c % groups != 0:
        raise NpuLoweringError("grouped_conv2d output channels must divide evenly by groups")
    input_per_group = input_c // groups
    if filter_c != input_per_group:
        raise NpuLoweringError(
            f"grouped_conv2d channel mismatch: filter I={filter_c}, expected {input_per_group}"
        )
    if output_c < groups:
        raise NpuLoweringError("grouped_conv2d requires at least one output channel per group")
    if str(graph.get("data_format", "NHWC")).upper() != "NHWC":
        raise NpuLoweringError("grouped_conv2d smoke path requires NHWC input format")
    if str(graph.get("filter_format", "HWIO")).upper() != "HWIO":
        raise NpuLoweringError("grouped_conv2d smoke path requires HWIO filter format")
    if str(graph.get("padding", "VALID")).upper() != "VALID":
        raise NpuLoweringError("grouped_conv2d smoke path currently supports VALID padding only")
    if _pair(graph.get("strides", [1, 1]), "strides") != [1, 1]:
        raise NpuLoweringError("grouped_conv2d smoke path currently supports stride 1 only")
    if _pair(graph.get("dilations", [1, 1]), "dilations") != [1, 1]:
        raise NpuLoweringError("grouped_conv2d smoke path currently supports dilation 1 only")
    if input_h < filter_h or input_w < filter_w:
        raise NpuLoweringError("grouped_conv2d filter must fit inside VALID input extent")


def _pair(value: Any, name: str) -> list[int]:
    if not isinstance(value, list) or len(value) not in {2, 4}:
        raise NpuLoweringError(f"{name} must be [h, w] or [1, h, w, 1]")
    if len(value) == 4:
        if value[0] != 1 or value[3] != 1:
            raise NpuLoweringError(f"{name} batch/channel entries must be 1")
        value = [value[1], value[2]]
    return [_int(value[0], name), _int(value[1], name)]


def _validate_attention_qk_shape(
    query: list[list[list[list[int]]]], key: list[list[list[list[int]]]]
) -> None:
    batch = len(query)
    heads = len(query[0])
    query_tokens = len(query[0][0])
    head_dim = len(query[0][0][0])
    if len(key) != batch:
        raise NpuLoweringError(f"attention_qk batch mismatch: query B={batch}, key B={len(key)}")
    if len(key[0]) != heads:
        raise NpuLoweringError(f"attention_qk head mismatch: query H={heads}, key H={len(key[0])}")
    key_tokens = len(key[0][0])
    key_dim = len(key[0][0][0])
    if query_tokens < 1 or key_tokens < 1:
        raise NpuLoweringError("attention_qk smoke path requires non-empty token dimensions")
    if key_dim != head_dim:
        raise NpuLoweringError(
            f"attention_qk head_dim mismatch: query D={head_dim}, key D={key_dim}"
        )


def _validate_attention_softmax_shape(
    logits: list[list[list[list[int]]]], mask: list[list[list[list[bool]]]]
) -> None:
    if len(mask) != len(logits):
        raise NpuLoweringError("attention_softmax mask batch mismatch")
    for batch_logits, batch_mask in zip(logits, mask, strict=True):
        if len(batch_mask) != len(batch_logits):
            raise NpuLoweringError("attention_softmax mask head mismatch")
        for head_logits, head_mask in zip(batch_logits, batch_mask, strict=True):
            if len(head_mask) != len(head_logits):
                raise NpuLoweringError("attention_softmax mask query-token mismatch")
            for row_logits, row_mask in zip(head_logits, head_mask, strict=True):
                if len(row_mask) != len(row_logits):
                    raise NpuLoweringError("attention_softmax mask key-token mismatch")
                if not any(row_mask):
                    raise NpuLoweringError("attention_softmax each row needs an unmasked key")
                active_values = [
                    value for value, active in zip(row_logits, row_mask, strict=True) if active
                ]
                if max(active_values) - min(active_values) > 128:
                    raise NpuLoweringError(
                        "attention_softmax row logit spread must fit EXP2_NEG_Q0_8 delta range"
                    )


def _validate_attention_av_shape(
    attention: list[list[list[list[int]]]], value: list[list[list[list[int]]]]
) -> None:
    batch = len(attention)
    heads = len(attention[0])
    query_tokens = len(attention[0][0])
    key_tokens = len(attention[0][0][0])
    if len(value) != batch:
        raise NpuLoweringError(
            f"attention_av batch mismatch: attention B={batch}, value B={len(value)}"
        )
    if len(value[0]) != heads:
        raise NpuLoweringError(
            f"attention_av head mismatch: attention H={heads}, value H={len(value[0])}"
        )
    value_tokens = len(value[0][0])
    value_dim = len(value[0][0][0])
    if query_tokens < 1 or key_tokens < 1 or value_dim < 1:
        raise NpuLoweringError("attention_av smoke path requires non-empty dimensions")
    if value_tokens != key_tokens:
        raise NpuLoweringError(
            f"attention_av key/value token mismatch: attention K={key_tokens}, value K={value_tokens}"
        )


def _validate_kv_cache_update_shape(
    key_cache: list[list[list[list[int]]]],
    value_cache: list[list[list[list[int]]]],
    new_key: list[list[list[list[int]]]],
    new_value: list[list[list[list[int]]]],
    cache_lengths: list[list[int]],
) -> None:
    batch = len(key_cache)
    heads = len(key_cache[0])
    capacity = len(key_cache[0][0])
    head_dim = len(key_cache[0][0][0])
    value_dim = len(value_cache[0][0][0])
    if len(value_cache) != batch or len(new_key) != batch or len(new_value) != batch:
        raise NpuLoweringError("kv_cache_update batch mismatch")
    if len(cache_lengths) != batch:
        raise NpuLoweringError("kv_cache_update cache_lengths batch mismatch")
    for batch_index in range(batch):
        if (
            len(key_cache[batch_index]) != heads
            or len(value_cache[batch_index]) != heads
            or len(new_key[batch_index]) != heads
            or len(new_value[batch_index]) != heads
            or len(cache_lengths[batch_index]) != heads
        ):
            raise NpuLoweringError("kv_cache_update head mismatch")
        for head_index in range(heads):
            if len(key_cache[batch_index][head_index]) != capacity:
                raise NpuLoweringError("kv_cache_update key cache capacity mismatch")
            if len(value_cache[batch_index][head_index]) != capacity:
                raise NpuLoweringError("kv_cache_update value cache capacity mismatch")
            if len(new_key[batch_index][head_index]) != len(new_value[batch_index][head_index]):
                raise NpuLoweringError("kv_cache_update new key/value token mismatch")
            if not new_key[batch_index][head_index]:
                raise NpuLoweringError("kv_cache_update requires at least one appended token")
            if any(len(row) != head_dim for row in key_cache[batch_index][head_index]):
                raise NpuLoweringError("kv_cache_update key cache dim mismatch")
            if any(len(row) != value_dim for row in value_cache[batch_index][head_index]):
                raise NpuLoweringError("kv_cache_update value cache dim mismatch")
            if any(len(row) != head_dim for row in new_key[batch_index][head_index]):
                raise NpuLoweringError("kv_cache_update new key dim mismatch")
            if any(len(row) != value_dim for row in new_value[batch_index][head_index]):
                raise NpuLoweringError("kv_cache_update new value dim mismatch")
            start = cache_lengths[batch_index][head_index]
            appended = len(new_key[batch_index][head_index])
            if start < 0 or start + appended > capacity:
                raise NpuLoweringError("kv_cache_update append exceeds cache capacity")


def _validate_transformer_block_shape(
    inputs: list[list[int]],
    attention: list[list[list[list[int]]]],
    value: list[list[list[list[int]]]],
    attention_bias: list[int],
    up_weight: list[list[int]],
    down_weight: list[list[int]],
    runtime: E1NpuRuntime,
) -> None:
    _validate_attention_av_shape(attention, value)
    tokens = len(inputs)
    model_dim = len(inputs[0])
    if len(attention) != 1 or len(attention[0]) != 1:
        raise NpuLoweringError("transformer_block smoke path supports batch=1 and heads=1 only")
    if len(attention[0][0]) != tokens:
        raise NpuLoweringError(
            f"transformer_block token mismatch: input T={tokens}, attention Q={len(attention[0][0])}"
        )
    if len(value[0][0][0]) != model_dim:
        raise NpuLoweringError(
            f"transformer_block value dim mismatch: input D={model_dim}, value D={len(value[0][0][0])}"
        )
    if len(attention_bias) != model_dim:
        raise NpuLoweringError(
            f"transformer_block attention_bias mismatch: input D={model_dim}, bias D={len(attention_bias)}"
        )
    _validate_mlp_shape(inputs, up_weight, down_weight, runtime)
    if len(down_weight[0]) != model_dim:
        raise NpuLoweringError(
            f"transformer_block mlp output mismatch: input D={model_dim}, down N={len(down_weight[0])}"
        )


def _validate_modern_decoder_block_shape(
    inputs: list[list[int]],
    norm1_weight: list[int],
    norm2_weight: list[int],
    q_weight: list[list[int]],
    k_weight: list[list[int]],
    v_weight: list[list[int]],
    attention_mask: list[list[list[list[bool]]]] | None,
    attention_bias: list[int],
    cos: list[int],
    sin: list[int],
    swiglu_up_weight: list[list[int]],
    swiglu_gate_weight: list[list[int]],
    swiglu_down_weight: list[list[int]],
) -> None:
    tokens = len(inputs)
    model_dim = len(inputs[0])
    if model_dim % 2 != 0:
        raise NpuLoweringError("modern_decoder_block requires an even model dimension for RoPE")
    if len(norm1_weight) != model_dim:
        raise NpuLoweringError(
            f"modern_decoder_block norm1 width mismatch: input D={model_dim}, weight D={len(norm1_weight)}"
        )
    if len(norm2_weight) != model_dim:
        raise NpuLoweringError(
            f"modern_decoder_block norm2 width mismatch: input D={model_dim}, weight D={len(norm2_weight)}"
        )
    for name, weight in (("q_weight", q_weight), ("k_weight", k_weight), ("v_weight", v_weight)):
        _validate_matmul_shape(inputs, weight)
        if len(weight[0]) != model_dim:
            raise NpuLoweringError(
                f"modern_decoder_block {name} output mismatch: input D={model_dim}, output D={len(weight[0])}"
            )
    if attention_mask is not None:
        if len(attention_mask) != 1 or len(attention_mask[0]) != 1:
            raise NpuLoweringError(
                "modern_decoder_block smoke path supports batch=1 and heads=1 only"
            )
        if len(attention_mask[0][0]) != tokens or len(attention_mask[0][0][0]) != tokens:
            raise NpuLoweringError(
                "modern_decoder_block attention_mask must be [1][1][tokens][tokens]"
            )
    if len(attention_bias) != model_dim:
        raise NpuLoweringError(
            f"modern_decoder_block attention_bias mismatch: input D={model_dim}, bias D={len(attention_bias)}"
        )
    _validate_rope_shape(inputs, cos, sin)
    _validate_swiglu_shape(inputs, swiglu_up_weight, swiglu_gate_weight, swiglu_down_weight)
    if len(swiglu_down_weight[0]) != model_dim:
        raise NpuLoweringError(
            f"modern_decoder_block swiglu output mismatch: input D={model_dim}, down N={len(swiglu_down_weight[0])}"
        )


def _transpose_matrix(matrix: list[list[int]]) -> list[list[int]]:
    return [list(col) for col in zip(*matrix, strict=True)]


def _slice_columns(matrix: list[list[int]], start: int, stop: int) -> list[list[int]]:
    return [row[start:stop] for row in matrix]


def _requantize_s8_matrix(matrix: list[list[int]], shift: int) -> list[list[int]]:
    return [[_clamp_s8(value >> shift) for value in row] for row in matrix]


def _clone_tensor4(tensor: list[list[list[list[int]]]]) -> list[list[list[list[int]]]]:
    return [[[list(row) for row in head] for head in batch] for batch in tensor]


def _requantize_s8_tensor4(
    tensor: list[list[list[list[int]]]], shift: int
) -> list[list[list[list[int]]]]:
    return [
        [[[_clamp_s8(value >> shift) for value in row] for row in head] for head in batch]
        for batch in tensor
    ]


def mask_to_int8(mask: list[list[list[list[bool]]]]) -> list[list[list[list[int]]]]:
    return [
        [[[1 if value else 0 for value in row] for row in head] for head in batch] for batch in mask
    ]


def _requantize_attention_weights_s8(
    weights_q0_8: list[list[list[list[int]]]], shift: int
) -> list[list[list[list[int]]]]:
    rounding = 0 if shift == 0 else 1 << (shift - 1)
    return [
        [
            [[_clamp_s8((value + rounding) >> shift) for value in row] for row in head]
            for head in batch
        ]
        for batch in weights_q0_8
    ]


def _clamp_s8(value: int) -> int:
    return max(-128, min(127, value))


def _silu_s8_scalar_approx(runtime: E1NpuRuntime, value: int) -> tuple[int, int, bool]:
    decay = runtime.exp2_neg_q0_8(-abs(value))
    if value >= 0:
        sigmoid_q0_8 = _s32(runtime.sub(256, decay >> 1))
        used_sub = True
    else:
        sigmoid_q0_8 = decay >> 1
        used_sub = False
    product = _s32(runtime.mul_lo(value, sigmoid_q0_8))
    return _clamp_s8(product >> 8), sigmoid_q0_8, used_sub


def _golden_silu_s8_approx(matrix: list[list[int]]) -> list[list[int]]:
    output: list[list[int]] = []
    for row in matrix:
        output_row: list[int] = []
        for value in row:
            decay = 256 >> min(8, abs(value))
            sigmoid_q0_8 = 256 - (decay >> 1) if value >= 0 else decay >> 1
            output_row.append(_clamp_s8((value * sigmoid_q0_8) >> 8))
        output.append(output_row)
    return output


def _quick_gelu_s8_scalar_approx(runtime: E1NpuRuntime, value: int) -> tuple[int, int, int, bool]:
    scaled = _s32(runtime.mul_lo(value, 218)) >> 7
    decay = runtime.exp2_neg_q0_8(-abs(scaled))
    if scaled >= 0:
        sigmoid_q0_8 = _s32(runtime.sub(256, decay >> 1))
        used_sub = True
    else:
        sigmoid_q0_8 = decay >> 1
        used_sub = False
    product = _s32(runtime.mul_lo(value, sigmoid_q0_8))
    return _clamp_s8(product >> 8), scaled, sigmoid_q0_8, used_sub


def _golden_quick_gelu_s8_approx(matrix: list[list[int]]) -> list[list[int]]:
    output: list[list[int]] = []
    for row in matrix:
        output_row: list[int] = []
        for value in row:
            scaled = (value * 218) >> 7
            decay = 256 >> min(8, abs(scaled))
            sigmoid_q0_8 = 256 - (decay >> 1) if scaled >= 0 else decay >> 1
            output_row.append(_clamp_s8((value * sigmoid_q0_8) >> 8))
        output.append(output_row)
    return output


def _flatten_matrix(matrix: list[list[int]]) -> list[int]:
    return [value for row in matrix for value in row]


def _reshape_matrix(values: list[int], rows: int, cols: int) -> list[list[int]]:
    return [values[row * cols : (row + 1) * cols] for row in range(rows)]


def _golden_rope(
    inputs: list[list[int]],
    cos: list[int],
    sin: list[int],
    scale_shift: int,
) -> list[list[int]]:
    output: list[list[int]] = []
    for row in inputs:
        output_row: list[int] = []
        for pair_index in range(len(cos)):
            even = row[pair_index * 2]
            odd = row[pair_index * 2 + 1]
            rotated_even = even * cos[pair_index] - odd * sin[pair_index]
            rotated_odd = even * sin[pair_index] + odd * cos[pair_index]
            output_row.append(_clamp_s8(rotated_even >> scale_shift))
            output_row.append(_clamp_s8(rotated_odd >> scale_shift))
        output.append(output_row)
    return output


def _golden_rmsnorm(
    inputs: list[list[int]],
    weight: list[int],
    inv_rms_shift: int,
    output_shift: int,
    epsilon: int,
) -> tuple[list[list[int]], list[int], list[int], list[int]]:
    output: list[list[int]] = []
    row_sum_squares: list[int] = []
    row_rms: list[int] = []
    row_inv_rms_q: list[int] = []
    for row in inputs:
        sum_squares = sum(value * value for value in row)
        mean_square = (sum_squares + len(row) - 1) // len(row)
        rms = max(1, isqrt(mean_square + epsilon))
        inv_rms_q = (1 << inv_rms_shift) // rms
        output.append(
            [
                _clamp_s8((value * weight_value * inv_rms_q) >> output_shift)
                for value, weight_value in zip(row, weight, strict=True)
            ]
        )
        row_sum_squares.append(sum_squares)
        row_rms.append(rms)
        row_inv_rms_q.append(inv_rms_q)
    return output, row_sum_squares, row_rms, row_inv_rms_q


def _golden_swiglu_hidden(
    up_requantized: list[list[int]],
    gate_requantized: list[list[int]],
    gate_shift: int,
) -> list[list[int]]:
    return [
        [
            _clamp_s8((up_value * gate_value) >> gate_shift)
            for up_value, gate_value in zip(up_row, gate_row, strict=True)
        ]
        for up_row, gate_row in zip(up_requantized, gate_requantized, strict=True)
    ]


def _golden_attention_softmax(
    logits: list[list[list[list[int]]]], mask: list[list[list[list[bool]]]]
) -> tuple[
    list[list[list[list[int]]]],
    list[list[list[int]]],
    list[list[list[list[int]]]],
    list[list[list[int]]],
]:
    weights: list[list[list[list[int]]]] = []
    row_max: list[list[list[int]]] = []
    exp_rows: list[list[list[list[int]]]] = []
    row_sum_exp: list[list[list[int]]] = []
    for batch_logits, batch_mask in zip(logits, mask, strict=True):
        batch_weights: list[list[list[int]]] = []
        batch_max: list[list[int]] = []
        batch_exp: list[list[list[int]]] = []
        batch_sum: list[list[int]] = []
        for head_logits, head_mask in zip(batch_logits, batch_mask, strict=True):
            head_weights: list[list[int]] = []
            head_max: list[int] = []
            head_exp: list[list[int]] = []
            head_sum: list[int] = []
            for row_logits, row_mask in zip(head_logits, head_mask, strict=True):
                active_values = [
                    value for value, active in zip(row_logits, row_mask, strict=True) if active
                ]
                current_max = max(active_values)
                exp_row = [
                    (256 >> min(8, current_max - value)) if active else 0
                    for value, active in zip(row_logits, row_mask, strict=True)
                ]
                sum_exp = sum(exp_row)
                weight_row = [(value * 256 + (sum_exp // 2)) // sum_exp for value in exp_row]
                head_weights.append(weight_row)
                head_max.append(current_max)
                head_exp.append(exp_row)
                head_sum.append(sum_exp)
            batch_weights.append(head_weights)
            batch_max.append(head_max)
            batch_exp.append(head_exp)
            batch_sum.append(head_sum)
        weights.append(batch_weights)
        row_max.append(batch_max)
        exp_rows.append(batch_exp)
        row_sum_exp.append(batch_sum)
    return weights, row_max, exp_rows, row_sum_exp


def _conv2d_im2col_valid(
    input_nhwc: list[list[list[list[int]]]], filters_hwio: list[list[list[list[int]]]]
) -> tuple[list[list[int]], list[list[int]], list[int]]:
    input_h = len(input_nhwc[0])
    input_w = len(input_nhwc[0][0])
    input_c = len(input_nhwc[0][0][0])
    filter_h = len(filters_hwio)
    filter_w = len(filters_hwio[0])
    output_c = len(filters_hwio[0][0][0])
    output_h = input_h - filter_h + 1
    output_w = input_w - filter_w + 1

    im2col: list[list[int]] = []
    for out_y in range(output_h):
        for out_x in range(output_w):
            row: list[int] = []
            for filter_y in range(filter_h):
                for filter_x in range(filter_w):
                    row.extend(input_nhwc[0][out_y + filter_y][out_x + filter_x][:input_c])
            im2col.append(row)

    filter_matrix: list[list[int]] = []
    for filter_y in range(filter_h):
        for filter_x in range(filter_w):
            for channel in range(input_c):
                filter_matrix.append(
                    [filters_hwio[filter_y][filter_x][channel][out_c] for out_c in range(output_c)]
                )
    return im2col, filter_matrix, [1, output_h, output_w, output_c]


def _reshape_conv2d_output(
    matrix: list[list[int]], shape: list[int]
) -> list[list[list[list[int]]]]:
    batch, output_h, output_w, output_c = shape
    output: list[list[list[list[int]]]] = []
    row_index = 0
    for _batch in range(batch):
        batch_rows: list[list[list[int]]] = []
        for _out_y in range(output_h):
            image_row: list[list[int]] = []
            for _out_x in range(output_w):
                image_row.append(matrix[row_index][:output_c])
                row_index += 1
            batch_rows.append(image_row)
        output.append(batch_rows)
    return output


def _dispatch_tiled(
    gemm, lhs: list[list[int]], rhs: list[list[int]]
) -> tuple[list[list[int]], int]:
    m = len(lhs)
    n = len(rhs[0])
    result = [[0 for _ in range(n)] for _ in range(m)]
    tile_count = 0
    for row_base in range(0, m, MAX_TILE_M):
        lhs_tile = lhs[row_base : row_base + MAX_TILE_M]
        for col_base in range(0, n, MAX_TILE_N):
            for k_base in range(0, len(rhs), MAX_TILE_K):
                lhs_k_tile = [row[k_base : k_base + MAX_TILE_K] for row in lhs_tile]
                rhs_tile = [
                    row[col_base : col_base + MAX_TILE_N]
                    for row in rhs[k_base : k_base + MAX_TILE_K]
                ]
                tile = gemm(lhs_k_tile, rhs_tile)
                tile_count += 1
                for row_index, row in enumerate(tile):
                    for col_index, value in enumerate(row):
                        result[row_base + row_index][col_base + col_index] += value
    return result, tile_count


def _validate_range(matrix: list[list[int]], low: int, high: int, name: str) -> None:
    for row in matrix:
        for value in row:
            if not low <= value <= high:
                raise NpuLoweringError(f"{name} value {value} outside range {low}..{high}")


def _validate_vector_range(values: list[int], low: int, high: int, name: str) -> None:
    for value in values:
        if not low <= value <= high:
            raise NpuLoweringError(f"{name} value {value} outside range {low}..{high}")


def _validate_tensor_range(
    tensor: list[list[list[list[int]]]], low: int, high: int, name: str
) -> None:
    for item0 in tensor:
        for item1 in item0:
            for item2 in item1:
                for value in item2:
                    if not low <= value <= high:
                        raise NpuLoweringError(f"{name} value {value} outside range {low}..{high}")


def _validate_tensor3_range(tensor: list[list[list[int]]], low: int, high: int, name: str) -> None:
    for item0 in tensor:
        for item1 in item0:
            for value in item1:
                if not low <= value <= high:
                    raise NpuLoweringError(f"{name} value {value} outside range {low}..{high}")


def lower_stablehlo_module_smoke(
    runtime: E1NpuRuntime,
    module_payload: Any,
    graph_fields_by_op: dict[str, dict[str, Any]],
) -> LoweredStableHloModuleResult:
    """Parse, materialize, and dispatch a bounded StableHLO smoke module."""

    from e1_npu_stablehlo import (  # Local import keeps StableHLO IR independent of runtime.
        StableHloModule,
        StableHloParseError,
        StableHloValidationError,
        materialize_module_lowering_graphs,
        parse_module,
        plan_module_lowerings,
    )

    try:
        module = (
            module_payload
            if isinstance(module_payload, StableHloModule)
            else parse_module(module_payload)
        )
        plans = plan_module_lowerings(module)
        lowering_graphs = materialize_module_lowering_graphs(module, graph_fields_by_op)
    except (StableHloParseError, StableHloValidationError) as exc:
        raise NpuLoweringError(f"invalid StableHLO smoke module: {exc}") from exc

    dispatch = {
        "lower_matmul_smoke": lower_matmul_smoke,
        "lower_batch_matmul_smoke": lower_batch_matmul_smoke,
        "lower_int2_matmul_smoke": lower_int2_matmul_smoke,
        "lower_fp8_matmul_smoke": lower_fp8_matmul_smoke,
        "lower_fp16_matmul_smoke": lower_fp16_matmul_smoke,
        "lower_bf16_matmul_smoke": lower_bf16_matmul_smoke,
        "lower_sparse_int4_matmul_smoke": lower_sparse_int4_matmul_smoke,
        "lower_group_scaled_int4_matmul_smoke": lower_group_scaled_int4_matmul_smoke,
        "lower_conv2d_smoke": lower_conv2d_smoke,
        "lower_residual_add_smoke": lower_residual_add_smoke,
        "lower_bias_add_smoke": lower_bias_add_smoke,
        "lower_mlp_smoke": lower_mlp_smoke,
        "lower_attention_qk_smoke": lower_attention_qk_smoke,
        "lower_attention_av_smoke": lower_attention_av_smoke,
        "lower_transformer_block_smoke": lower_transformer_block_smoke,
        "lower_modern_decoder_block_smoke": lower_modern_decoder_block_smoke,
    }
    lowered_ops: list[Any] = []
    for plan, graph in zip(plans, lowering_graphs, strict=True):
        lower = dispatch.get(plan.runtime_api)
        if lower is None:
            raise NpuLoweringError(f"unsupported StableHLO runtime API {plan.runtime_api!r}")
        lowered_ops.append(lower(runtime, graph))

    cpu_fallback = any(bool(getattr(op, "cpu_fallback", True)) for op in lowered_ops)
    return LoweredStableHloModuleResult(
        schema="eliza.e1_npu_lowered_stablehlo_module_result.v1",
        source_dialect="stablehlo",
        module_name=module.name,
        op_count=len(lowered_ops),
        dispatch_order=tuple(plan.op_name for plan in plans),
        lowering_graphs=lowering_graphs,
        lowering_plans=tuple(plan.as_dict() for plan in plans),
        lowered_ops=tuple(lowered_ops),
        runtime_apis=tuple(plan.runtime_api for plan in plans),
        cpu_fallback=cpu_fallback,
        all_npu_dispatch=not cpu_fallback,
        claim_boundary=(
            "stablehlo_smoke_module_dispatch_only_not_mlir_pipeline_graph_partitioner_"
            "scheduler_or_production_compiler_backend"
        ),
    )
