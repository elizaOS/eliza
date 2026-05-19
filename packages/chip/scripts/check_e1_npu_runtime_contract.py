#!/usr/bin/env python3
import importlib.util
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONTRACT = ROOT / "docs/spec-db/e1-npu-runtime-contract.json"
RUNTIME = ROOT / "compiler/runtime/e1_npu_runtime.py"
LOWERING = ROOT / "compiler/runtime/e1_npu_lowering.py"
RUNTIME_SIM_TEST = ROOT / "compiler/runtime/test_e1_npu_runtime_sim.py"
ARCH_DOC = ROOT / "docs/arch/npu.md"
BSP_HEADER = ROOT / "sw/linux/drivers/e1/e1_platform_contract.h"
GENERATED_PLATFORM_HEADER = ROOT / "sw/platform/generated/e1_platform.h"
VERILATOR_GEMM = ROOT / "verify/verilator/test_npu_gemm.cpp"
NNAPI_PROOF = ROOT / "benchmarks/capabilities/e1_npu_nnapi.proof.json"


def load_runtime_class():
    spec = importlib.util.spec_from_file_location("e1_npu_runtime", RUNTIME)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load {RUNTIME}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module.E1NpuRuntime


def hex_to_int(value: str) -> int:
    return int(value, 16)


def main() -> int:
    errors: list[str] = []
    for path in (
        CONTRACT,
        RUNTIME,
        LOWERING,
        RUNTIME_SIM_TEST,
        ARCH_DOC,
        BSP_HEADER,
        GENERATED_PLATFORM_HEADER,
        VERILATOR_GEMM,
    ):
        if not path.is_file():
            errors.append(f"missing required artifact: {path.relative_to(ROOT)}")
    if errors:
        return report(errors)

    contract = json.loads(CONTRACT.read_text())
    if contract.get("schema") != "eliza.e1_npu_runtime_contract.v1":
        errors.append("runtime contract schema mismatch")
    boundary = contract.get("claim_boundary", "")
    if "not_phone_class_ai_accelerator" not in boundary:
        errors.append("contract must stay fail-closed for phone-class accelerator claims")

    current = contract.get("current_capability", {})
    if current.get("classification") != "L0_RTL_UNIT":
        errors.append("current NPU capability must remain classified as L0_RTL_UNIT")
    not_claimed = set(current.get("not_claimed", []))
    for required in (
        "Android NNAPI acceleration",
        "phone-class TOPS",
        "production model compiler backend",
        "production DMA-backed tensor execution",
        "sustained power or thermal performance",
    ):
        if required not in not_claimed:
            errors.append(f"contract must explicitly not claim: {required}")

    runtime = load_runtime_class()
    base = hex_to_int(contract["mmio"]["base"])
    registers = contract["mmio"]["registers"]
    for name, offset in registers.items():
        expected = base + hex_to_int(offset)
        actual = getattr(runtime, name, None)
        if actual != expected:
            actual_text = f"0x{actual:08x}" if isinstance(actual, int) else repr(actual)
            errors.append(f"runtime {name} address {actual_text} != contract 0x{expected:08x}")

    if getattr(runtime, "SCRATCH_BYTES", None) != contract["mmio"].get("scratch_bytes"):
        errors.append("runtime scratch size does not match contract")

    for name, value in contract.get("opcodes", {}).items():
        actual = getattr(runtime, f"OP_{name}", None)
        if actual != value:
            errors.append(f"runtime opcode OP_{name}={actual!r} != contract {value!r}")

    probe_writes: list[tuple[int, int]] = []

    def read32(addr: int) -> int:
        if addr == runtime.CTRL_STATUS:
            return 0x2
        return {
            runtime.RESULT: 0x1234,
            runtime.PERF_UNSUPPORTED_OPS: 0,
            runtime.PERF_CYCLES: 12,
            runtime.PERF_MACS: 12,
            runtime.PERF_OPS: 1,
            runtime.PERF_ERRORS: 0,
        }.get(addr, 0)

    def write32(addr: int, value: int) -> None:
        probe_writes.append((addr, value))

    instance = runtime(read32, write32)
    instance.clear_perf()
    if probe_writes[-1] != (runtime.PERF_ERRORS, 1):
        errors.append("runtime clear_perf must write 1 to PERF_ERRORS")
    perf_keys = set(instance.perf())
    required_perf_keys = {"unsupported_ops", "cycles", "macs", "ops", "errors"}
    if perf_keys != required_perf_keys:
        errors.append(f"runtime perf keys {sorted(perf_keys)} != {sorted(required_perf_keys)}")
    if not hasattr(runtime, "descriptor_counters"):
        errors.append("runtime must expose descriptor_counters for queue telemetry proof")
    else:
        desc_keys = set(instance.descriptor_counters())
        required_desc_keys = {
            "status",
            "head",
            "tail",
            "timeout_count",
            "bytes_read",
            "bytes_written",
            "read_beats",
            "write_beats",
        }
        if not required_desc_keys.issubset(desc_keys):
            errors.append(
                f"runtime descriptor counter keys missing {sorted(required_desc_keys - desc_keys)}"
            )
    instance.dot8_s4(0, 0)
    if (runtime.OPCODE, runtime.OP_DOT8_S4) not in probe_writes:
        errors.append("runtime dot8_s4 must submit opcode 7")
    instance.relu4_s8([0, 1, -1, 2])
    if (runtime.OPCODE, runtime.OP_RELU4_S8) not in probe_writes:
        errors.append("runtime relu4_s8 must submit opcode 10")
    if getattr(runtime, "OP_GEMM_S4", None) != 9:
        errors.append("runtime must expose OP_GEMM_S4 = 9")
    if getattr(runtime, "OP_SDOT4_S4_2_4", None) != 12:
        errors.append("runtime must expose OP_SDOT4_S4_2_4 = 12")
    instance.sdot4_s4_2_4([1, 2, 3, 4], [0, 1, 2, 3, 4, 5, 6, 7], [0, 1, 0, 1])
    if (runtime.OPCODE, runtime.OP_SDOT4_S4_2_4) not in probe_writes:
        errors.append("runtime sdot4_s4_2_4 must submit opcode 12")
    if getattr(runtime, "OP_DOT16_S2", None) != 13:
        errors.append("runtime must expose OP_DOT16_S2 = 13")
    instance.dot16_s2([0] * 16, [1] * 16)
    if (runtime.OPCODE, runtime.OP_DOT16_S2) not in probe_writes:
        errors.append("runtime dot16_s2 must submit opcode 13")
    if getattr(runtime, "OP_DOT4_FP8_E4M3", None) != 14:
        errors.append("runtime must expose OP_DOT4_FP8_E4M3 = 14")
    instance.dot4_fp8_e4m3([0x38, 0xBC, 0x30, 0x40], [0x40, 0xB8, 0x28, 0xB0], 64)
    if (runtime.OPCODE, runtime.OP_DOT4_FP8_E4M3) not in probe_writes:
        errors.append("runtime dot4_fp8_e4m3 must submit opcode 14")
    if getattr(runtime, "OP_EXP2_NEG_Q0_8", None) != 15:
        errors.append("runtime must expose OP_EXP2_NEG_Q0_8 = 15")
    instance.exp2_neg_q0_8(-3)
    if (runtime.OPCODE, runtime.OP_EXP2_NEG_Q0_8) not in probe_writes:
        errors.append("runtime exp2_neg_q0_8 must submit opcode 15")
    if not hasattr(runtime, "submit_descriptors"):
        errors.append("runtime must expose submit_descriptors for reserved descriptor queue status")
    precision = {entry["precision"]: entry["state"] for entry in instance.precision_matrix()}
    for required in ("INT4", "INT8", "INT2", "FP16", "BF16", "FP8"):
        if required not in precision:
            errors.append(f"runtime precision matrix missing {required}")
    for blocked in ("FP16", "BF16"):
        if precision.get(blocked) != "blocked":
            errors.append(
                f"runtime must report {blocked} as blocked, got {precision.get(blocked)!r}"
            )
    if precision.get("FP8") != "supported":
        errors.append(f"runtime must report FP8 as supported, got {precision.get('FP8')!r}")

    arch_text = ARCH_DOC.read_text()
    runtime_sim_text = RUNTIME_SIM_TEST.read_text()
    header_text = BSP_HEADER.read_text()
    generated_header_text = GENERATED_PLATFORM_HEADER.read_text()
    verilator_text = VERILATOR_GEMM.read_text().lower()
    header_offsets = {
        name: int(value, 16)
        for name, value in re.findall(
            r"#define\s+E1_NPU_([A-Z0-9_]+)_OFFSET\s+0x([0-9A-Fa-f]+)u",
            header_text,
        )
    }
    for name, offset in registers.items():
        if name.startswith("PERF_") and name not in arch_text:
            errors.append(f"architecture doc missing perf register {name}")
        if name == "SCRATCH":
            continue
        header_name = {
            "DEBUG": "TRACE",
        }.get(name, name)
        actual_offset = header_offsets.get(header_name)
        if actual_offset != hex_to_int(offset):
            errors.append(f"BSP header E1_NPU_{header_name}_OFFSET {actual_offset!r} != {offset}")
        generated_token = f"#define E1_NPU_{header_name}_OFFSET 0x{hex_to_int(offset):02X}UL"
        if generated_token not in generated_header_text:
            errors.append(f"generated platform header missing {generated_token}")

    for name in ("DESC_BASE", "DESC_HEAD", "DESC_TAIL", "DESC_STATUS", "CMD_PARAM"):
        token = f"E1_NPU_{name}_OFFSET"
        if token not in header_text or token not in generated_header_text:
            errors.append(f"descriptor queue register {token} missing from platform headers")

    for token in (
        "sdot4_s4_2_4",
        "golden_sdot4_s4_2_4",
        "dot16_s2",
        "golden_dot16_s2",
        "dot4_fp8_e4m3",
        "golden_dot4_fp8_e4m3",
    ):
        if token not in runtime_sim_text:
            errors.append(f"runtime simulator missing low-precision token {token!r}")

    for name, expected in (
        ("DESC_RING_ENTRIES", 8),
        ("DESC_STATUS_EMPTY", 0x1),
        ("DESC_STATUS_DONE", 0x2),
        ("DESC_STATUS_ERROR", 0x4),
        ("DESC_STATUS_TIMEOUT", 0x8),
        ("DESC_STATUS_MEM_ERROR", 0x10),
        ("DESC_STATUS_STREAM_ERROR", 0x20),
        ("DESC_STATUS_OWNER_ERROR", 0x40),
        ("DESC_STATUS_WRITEBACK_UNSUPPORTED", 0x80),
        ("DESC_FLAG_STREAM_TO_SCRATCH", 1 << 8),
        ("DESC_FLAG_WRITEBACK_REQUEST", 1 << 30),
        ("DESC_FLAG_VALID_OWNER", 1 << 31),
    ):
        if getattr(runtime, name, None) != expected:
            errors.append(f"runtime {name}={getattr(runtime, name, None)!r} != {expected!r}")

    lowering = contract.get("matmul_lowering_smoke", {})
    if lowering.get("runtime_api") != "lower_matmul_smoke":
        errors.append("matmul lowering smoke must identify lower_matmul_smoke runtime API")
    if (
        lowering.get("claim_boundary")
        != "single_matmul_tiled_smoke_only_not_production_compiler_backend"
    ):
        errors.append(
            "matmul lowering smoke claim boundary must remain production-compiler blocked"
        )
    if set(lowering.get("supported_precisions", [])) != {"int8", "int4"}:
        errors.append("matmul lowering smoke must be limited to int8/int4")
    tile_shape_limit = lowering.get("tile_shape_limit", {})
    if tile_shape_limit != {"m": 3, "n": 3, "k": 7}:
        errors.append("matmul lowering smoke tile_shape_limit must match current GEMM bounds")
    if "accumulates int32 split-K partial outputs" not in str(lowering.get("tiled_dispatch", "")):
        errors.append("matmul lowering smoke must describe bounded M/N/K tiled dispatch")
    lowering_text = LOWERING.read_text()
    for token in (
        "lower_matmul_smoke",
        "_dispatch_tiled",
        "tile_count",
        "tiled_dispatch",
        "split_k",
        "host_accumulates_partials",
        "stablehlo.dot_general",
        "tflite.fully_connected",
        "OP_GEMM_S8",
        "OP_GEMM_S4",
        "cpu_fallback=False",
        "single_matmul_tiled_smoke_only_not_production_compiler_backend",
    ):
        if token not in lowering_text:
            errors.append(f"matmul lowering smoke missing token {token!r}")

    sparse_int4_matmul_lowering = contract.get("sparse_int4_matmul_lowering_smoke", {})
    if sparse_int4_matmul_lowering.get("runtime_api") != "lower_sparse_int4_matmul_smoke":
        errors.append(
            "sparse INT4 matmul lowering smoke must identify lower_sparse_int4_matmul_smoke"
        )
    if (
        sparse_int4_matmul_lowering.get("claim_boundary")
        != "sparse_int4_2_4_matmul_sdot4_smoke_only_not_sparse_tensor_gemm_or_production_compiler_backend"
    ):
        errors.append(
            "sparse INT4 matmul lowering smoke claim boundary must remain scalar-dot-only"
        )
    if set(sparse_int4_matmul_lowering.get("supported_precisions", [])) != {
        "int4",
        "sparse_int4",
        "s4_2_4",
    }:
        errors.append(
            "sparse INT4 matmul lowering smoke must be limited to int4/sparse_int4/s4_2_4"
        )
    for required in ("SDOT4_S4_2_4", "two distinct metadata positions", "OP_ADD"):
        if required not in str(sparse_int4_matmul_lowering.get("lowering", "")):
            errors.append(f"sparse INT4 matmul contract missing {required!r}")
    for token in (
        "SUPPORTED_SPARSE_INT4_MATMUL_SCHEMA",
        "lower_sparse_int4_matmul_smoke",
        "golden_sdot4_s4_2_4",
        "runtime.sdot4_s4_2_4",
        "host_pads_k_to_sparse_blocks",
        "host_uses_2_4_metadata",
        "sdot4_count",
        "eliza.sparse_2_4_matmul",
        "eliza.sparse_int4_matmul",
        "sparse_int4_2_4_matmul_sdot4_smoke_only_not_sparse_tensor_gemm_or_production_compiler_backend",
    ):
        if token not in lowering_text:
            errors.append(f"sparse INT4 matmul lowering smoke missing token {token!r}")

    int2_matmul_lowering = contract.get("int2_matmul_lowering_smoke", {})
    if int2_matmul_lowering.get("runtime_api") != "lower_int2_matmul_smoke":
        errors.append("INT2 matmul lowering smoke must identify lower_int2_matmul_smoke")
    if (
        int2_matmul_lowering.get("claim_boundary")
        != "int2_matmul_dot16_smoke_only_not_tensor_int2_gemm_or_production_compiler_backend"
    ):
        errors.append("INT2 matmul lowering smoke claim boundary must remain scalar-dot-only")
    if set(int2_matmul_lowering.get("supported_precisions", [])) != {
        "int2",
        "bitnet_int2",
    }:
        errors.append("INT2 matmul lowering smoke must be limited to int2/bitnet_int2")
    for required in ("DOT16_S2", "pads K to DOT16 width", "signed int32 accumulation"):
        if required not in str(int2_matmul_lowering.get("lowering", "")):
            errors.append(f"INT2 matmul contract missing {required!r}")
    for token in (
        "SUPPORTED_INT2_MATMUL_SCHEMA",
        "lower_int2_matmul_smoke",
        "golden_dot16_s2",
        "runtime.dot16_s2",
        "host_pads_k_to_dot16",
        "dot16_count",
        "eliza.int2_matmul",
        "eliza.bitnet_matmul",
        "int2_matmul_dot16_smoke_only_not_tensor_int2_gemm_or_production_compiler_backend",
    ):
        if token not in lowering_text:
            errors.append(f"INT2 matmul lowering smoke missing token {token!r}")

    fp8_matmul_lowering = contract.get("fp8_matmul_lowering_smoke", {})
    if fp8_matmul_lowering.get("runtime_api") != "lower_fp8_matmul_smoke":
        errors.append("FP8 matmul lowering smoke must identify lower_fp8_matmul_smoke")
    if (
        fp8_matmul_lowering.get("claim_boundary")
        != "fp8_e4m3_matmul_dot4_smoke_only_not_tensor_fp8_gemm_or_production_compiler_backend"
    ):
        errors.append("FP8 matmul lowering smoke claim boundary must remain scalar-dot-only")
    if set(fp8_matmul_lowering.get("supported_precisions", [])) != {"fp8_e4m3"}:
        errors.append("FP8 matmul lowering smoke must be limited to fp8_e4m3")
    for required in ("DOT4_FP8_E4M3", "pads K to DOT4 width", "signed Q8.8 accumulation"):
        if required not in str(fp8_matmul_lowering.get("lowering", "")):
            errors.append(f"FP8 matmul contract missing {required!r}")
    for token in (
        "SUPPORTED_FP8_MATMUL_SCHEMA",
        "lower_fp8_matmul_smoke",
        "golden_dot4_fp8_e4m3",
        "runtime.dot4_fp8_e4m3",
        "host_pads_k_to_dot4",
        "dot4_count",
        "eliza.fp8_matmul",
        "fp8_e4m3_matmul_dot4_smoke_only_not_tensor_fp8_gemm_or_production_compiler_backend",
    ):
        if token not in lowering_text:
            errors.append(f"FP8 matmul lowering smoke missing token {token!r}")

    conv2d_lowering = contract.get("conv2d_lowering_smoke", {})
    if conv2d_lowering.get("runtime_api") != "lower_conv2d_smoke":
        errors.append("conv2d lowering smoke must identify lower_conv2d_smoke runtime API")
    if (
        conv2d_lowering.get("claim_boundary")
        != "single_conv2d_im2col_smoke_only_not_production_compiler_backend"
    ):
        errors.append(
            "conv2d lowering smoke claim boundary must remain production-compiler blocked"
        )
    if set(conv2d_lowering.get("supported_precisions", [])) != {"int8", "int4"}:
        errors.append("conv2d lowering smoke must be limited to int8/int4")
    conv2d_layout = conv2d_lowering.get("layout", {})
    if conv2d_layout.get("input") != "NHWC" or conv2d_layout.get("filter") != "HWIO":
        errors.append("conv2d lowering smoke must document NHWC/HWIO layout")
    if "perform every convolution MAC" not in str(conv2d_lowering.get("lowering", "")):
        errors.append("conv2d lowering smoke must route convolution MACs through GEMM")
    for token in (
        "lower_conv2d_smoke",
        "_conv2d_im2col_valid",
        "host_materializes_im2col",
        "stablehlo.convolution",
        "tflite.conv_2d",
        "single_conv2d_im2col_smoke_only_not_production_compiler_backend",
    ):
        if token not in lowering_text:
            errors.append(f"conv2d lowering smoke missing token {token!r}")

    attention_qk_lowering = contract.get("attention_qk_lowering_smoke", {})
    if attention_qk_lowering.get("runtime_api") != "lower_attention_qk_smoke":
        errors.append(
            "attention_qk lowering smoke must identify lower_attention_qk_smoke runtime API"
        )
    if (
        attention_qk_lowering.get("claim_boundary")
        != "attention_qk_scores_smoke_only_not_softmax_or_production_compiler_backend"
    ):
        errors.append(
            "attention_qk lowering smoke claim boundary must remain softmax/compiler blocked"
        )
    if set(attention_qk_lowering.get("supported_precisions", [])) != {"int8", "int4"}:
        errors.append("attention_qk lowering smoke must be limited to int8/int4")
    if "perform every QK score MAC" not in str(attention_qk_lowering.get("lowering", "")):
        errors.append("attention_qk lowering smoke must route score MACs through GEMM")
    for token in (
        "lower_attention_qk_smoke",
        "_validate_attention_qk_shape",
        "host_transposes_keys",
        "host_iterates_heads",
        "stablehlo.dot_general",
        "tflite.batch_matmul",
        "eliza.attention_qk",
        "attention_qk_scores_smoke_only_not_softmax_or_production_compiler_backend",
    ):
        if token not in lowering_text:
            errors.append(f"attention_qk lowering smoke missing token {token!r}")

    attention_softmax_lowering = contract.get("attention_softmax_lowering_smoke", {})
    if attention_softmax_lowering.get("runtime_api") != "lower_attention_softmax_smoke":
        errors.append(
            "attention_softmax lowering smoke must identify lower_attention_softmax_smoke runtime API"
        )
    if (
        attention_softmax_lowering.get("claim_boundary")
        != "attention_softmax_exp2_q0_8_smoke_only_not_production_softmax_or_fused_attention"
    ):
        errors.append(
            "attention_softmax lowering smoke claim boundary must remain approximation-only"
        )
    if set(attention_softmax_lowering.get("supported_precisions", [])) != {"int8"}:
        errors.append("attention_softmax lowering smoke must be limited to int8")
    softmax_lowering_text = str(attention_softmax_lowering.get("lowering", ""))
    for required in ("MAX_U32", "OP_SUB", "EXP2_NEG_Q0_8", "OP_ADD", "divides by row sum"):
        if required not in softmax_lowering_text:
            errors.append(f"attention_softmax contract missing {required!r}")
    for token in (
        "lower_attention_softmax_smoke",
        "_validate_attention_softmax_shape",
        "_golden_attention_softmax",
        "runtime.max_u32",
        "runtime.sub",
        "runtime.exp2_neg_q0_8",
        "runtime.add",
        "host_applies_mask",
        "host_divides_by_row_sum",
        "stablehlo.softmax",
        "tflite.softmax",
        "eliza.attention_softmax",
        "attention_softmax_exp2_q0_8_smoke_only_not_production_softmax_or_fused_attention",
    ):
        if token not in lowering_text:
            errors.append(f"attention_softmax lowering smoke missing token {token!r}")

    attention_av_lowering = contract.get("attention_av_lowering_smoke", {})
    if attention_av_lowering.get("runtime_api") != "lower_attention_av_smoke":
        errors.append(
            "attention_av lowering smoke must identify lower_attention_av_smoke runtime API"
        )
    if (
        attention_av_lowering.get("claim_boundary")
        != "attention_av_context_smoke_only_not_softmax_or_production_compiler_backend"
    ):
        errors.append(
            "attention_av lowering smoke claim boundary must remain softmax/compiler blocked"
        )
    if set(attention_av_lowering.get("supported_precisions", [])) != {"int8", "int4"}:
        errors.append("attention_av lowering smoke must be limited to int8/int4")
    if "perform every AV context MAC" not in str(attention_av_lowering.get("lowering", "")):
        errors.append("attention_av lowering smoke must route context MACs through GEMM")
    for token in (
        "lower_attention_av_smoke",
        "_validate_attention_av_shape",
        "requires_prequantized_attention",
        "host_iterates_heads",
        "stablehlo.dot_general",
        "tflite.batch_matmul",
        "eliza.attention_av",
        "attention_av_context_smoke_only_not_softmax_or_production_compiler_backend",
    ):
        if token not in lowering_text:
            errors.append(f"attention_av lowering smoke missing token {token!r}")

    kv_cache_lowering = contract.get("kv_cache_update_lowering_smoke", {})
    if kv_cache_lowering.get("runtime_api") != "lower_kv_cache_update_smoke":
        errors.append("kv_cache_update lowering smoke must identify lower_kv_cache_update_smoke")
    if (
        kv_cache_lowering.get("claim_boundary")
        != "kv_cache_update_s8_scalar_append_smoke_only_not_paged_or_dma_cache"
    ):
        errors.append("kv_cache_update claim boundary must remain append-smoke-only")
    if set(kv_cache_lowering.get("supported_precisions", [])) != {"int8"}:
        errors.append("kv_cache_update lowering smoke must be limited to int8")
    for required in ("OP_ADD(value, 0)", "preserves existing cache", "advances cache_lengths"):
        if required not in str(kv_cache_lowering.get("lowering", "")):
            errors.append(f"kv_cache_update contract missing {required!r}")
    for token in (
        "lower_kv_cache_update_smoke",
        "_validate_kv_cache_update_shape",
        "_clone_tensor4",
        "host_preserves_existing_cache",
        "host_tracks_cache_lengths",
        "scalar_copy_count",
        "eliza.kv_cache_update",
        "stablehlo.kv_cache_update",
        "tflite.kv_cache_update",
        "kv_cache_update_s8_scalar_append_smoke_only_not_paged_or_dma_cache",
    ):
        if token not in lowering_text:
            errors.append(f"kv_cache_update lowering smoke missing token {token!r}")

    mlp_lowering = contract.get("mlp_lowering_smoke", {})
    if mlp_lowering.get("runtime_api") != "lower_mlp_smoke":
        errors.append("mlp lowering smoke must identify lower_mlp_smoke runtime API")
    if (
        mlp_lowering.get("claim_boundary")
        != "transformer_mlp_relu_smoke_only_not_gelu_or_production_compiler_backend"
    ):
        errors.append("mlp lowering smoke claim boundary must remain GELU/compiler blocked")
    if set(mlp_lowering.get("supported_precisions", [])) != {"int8"}:
        errors.append("mlp lowering smoke must be limited to int8")
    if "activation through VRELU_S8" not in str(mlp_lowering.get("lowering", "")):
        errors.append("mlp lowering smoke must route activation through VRELU_S8")
    for token in (
        "lower_mlp_smoke",
        "_validate_mlp_shape",
        "host_requantizes_hidden",
        "activation_opcode",
        "VRELU_S8",
        "stablehlo.mlp",
        "tflite.mlp",
        "eliza.transformer_mlp",
        "transformer_mlp_relu_smoke_only_not_gelu_or_production_compiler_backend",
    ):
        if token not in lowering_text:
            errors.append(f"mlp lowering smoke missing token {token!r}")

    swiglu_lowering = contract.get("swiglu_lowering_smoke", {})
    if swiglu_lowering.get("runtime_api") != "lower_swiglu_smoke":
        errors.append("SwiGLU lowering smoke must identify lower_swiglu_smoke runtime API")
    if (
        swiglu_lowering.get("claim_boundary")
        != "swiglu_s8_scalar_gate_smoke_only_not_silu_or_production_compiler_backend"
    ):
        errors.append("SwiGLU lowering smoke claim boundary must remain SiLU/compiler blocked")
    if set(swiglu_lowering.get("supported_precisions", [])) != {"int8"}:
        errors.append("SwiGLU lowering smoke must be limited to int8")
    if "OP_MUL_LO" not in str(swiglu_lowering.get("lowering", "")):
        errors.append("SwiGLU lowering smoke must route gate products through OP_MUL_LO")
    for token in (
        "lower_swiglu_smoke",
        "_validate_swiglu_shape",
        "_golden_swiglu_hidden",
        "host_applies_gate_shift_and_saturation",
        "runtime.mul_lo",
        "stablehlo.swiglu",
        "tflite.swiglu",
        "eliza.swiglu",
        "swiglu_s8_scalar_gate_smoke_only_not_silu_or_production_compiler_backend",
    ):
        if token not in lowering_text:
            errors.append(f"SwiGLU lowering smoke missing token {token!r}")

    bias_add_lowering = contract.get("bias_add_lowering_smoke", {})
    if bias_add_lowering.get("runtime_api") != "lower_bias_add_smoke":
        errors.append("bias_add lowering smoke must identify lower_bias_add_smoke runtime API")
    if (
        bias_add_lowering.get("claim_boundary")
        != "bias_add_s8_scalar_broadcast_smoke_only_not_vector_or_production_compiler_backend"
    ):
        errors.append("bias_add lowering smoke claim boundary must remain scalar-broadcast-only")
    if set(bias_add_lowering.get("supported_precisions", [])) != {"int8"}:
        errors.append("bias_add lowering smoke must be limited to int8")
    if "scalar OP_ADD" not in str(bias_add_lowering.get("lowering", "")):
        errors.append("bias_add lowering smoke must route element adds through OP_ADD")
    for token in (
        "lower_bias_add_smoke",
        "_validate_vector_range",
        "host_broadcasts_bias",
        "host_saturates_int8",
        "scalar_add_count",
        "stablehlo.add",
        "tflite.add",
        "eliza.bias_add",
        "bias_add_s8_scalar_broadcast_smoke_only_not_vector_or_production_compiler_backend",
    ):
        if token not in lowering_text:
            errors.append(f"bias_add lowering smoke missing token {token!r}")

    residual_add_lowering = contract.get("residual_add_lowering_smoke", {})
    if residual_add_lowering.get("runtime_api") != "lower_residual_add_smoke":
        errors.append(
            "residual_add lowering smoke must identify lower_residual_add_smoke runtime API"
        )
    if (
        residual_add_lowering.get("claim_boundary")
        != "residual_add_s8_scalar_smoke_only_not_vector_or_production_compiler_backend"
    ):
        errors.append("residual_add lowering smoke claim boundary must remain scalar-only")
    if set(residual_add_lowering.get("supported_precisions", [])) != {"int8"}:
        errors.append("residual_add lowering smoke must be limited to int8")
    if "scalar OP_ADD" not in str(residual_add_lowering.get("lowering", "")):
        errors.append("residual_add lowering smoke must route element adds through OP_ADD")
    for token in (
        "lower_residual_add_smoke",
        "_validate_same_shape",
        "host_saturates_int8",
        "scalar_add_count",
        "stablehlo.add",
        "tflite.add",
        "eliza.residual_add",
        "residual_add_s8_scalar_smoke_only_not_vector_or_production_compiler_backend",
    ):
        if token not in lowering_text:
            errors.append(f"residual_add lowering smoke missing token {token!r}")

    transformer_block_lowering = contract.get("transformer_block_lowering_smoke", {})
    if transformer_block_lowering.get("runtime_api") != "lower_transformer_block_smoke":
        errors.append(
            "transformer_block lowering smoke must identify lower_transformer_block_smoke runtime API"
        )
    if (
        transformer_block_lowering.get("claim_boundary")
        != "single_head_transformer_block_smoke_only_not_softmax_norm_multihead_or_production_compiler_backend"
    ):
        errors.append(
            "transformer_block lowering smoke claim boundary must remain block-smoke-only"
        )
    if set(transformer_block_lowering.get("supported_precisions", [])) != {"int8"}:
        errors.append("transformer_block lowering smoke must be limited to int8")
    if "prequantized attention weights" not in str(transformer_block_lowering.get("lowering", "")):
        errors.append("transformer_block lowering smoke must require prequantized attention")
    for token in (
        "lower_transformer_block_smoke",
        "_validate_transformer_block_shape",
        "requires_prequantized_attention",
        "total_tile_count",
        "scalar_add_count",
        "eliza.transformer_block",
        "stablehlo.transformer_block",
        "tflite.transformer_block",
        "single_head_transformer_block_smoke_only_not_softmax_norm_multihead_or_production_compiler_backend",
    ):
        if token not in lowering_text:
            errors.append(f"transformer_block lowering smoke missing token {token!r}")

    modern_decoder_block_lowering = contract.get("modern_decoder_block_lowering_smoke", {})
    if modern_decoder_block_lowering.get("runtime_api") != "lower_modern_decoder_block_smoke":
        errors.append(
            "modern_decoder_block lowering smoke must identify lower_modern_decoder_block_smoke runtime API"
        )
    if (
        modern_decoder_block_lowering.get("claim_boundary")
        != "modern_decoder_block_single_head_exp2_softmax_smoke_only_not_multihead_kv_cache_or_production_compiler_backend"
    ):
        errors.append(
            "modern_decoder_block lowering smoke claim boundary must remain decoder-smoke-only"
        )
    if set(modern_decoder_block_lowering.get("supported_precisions", [])) != {"int8"}:
        errors.append("modern_decoder_block lowering smoke must be limited to int8")
    modern_decoder_lowering_text = str(modern_decoder_block_lowering.get("lowering", ""))
    for required in (
        "lower_rmsnorm_smoke",
        "lower_attention_qk_smoke",
        "lower_attention_softmax_smoke",
        "lower_attention_av_smoke",
        "lower_swiglu_smoke",
        "host QK-score requantization",
        "host Q0.8 attention-weight requantization",
    ):
        if required not in modern_decoder_lowering_text:
            errors.append(f"modern_decoder_block contract missing {required!r}")
    for token in (
        "lower_modern_decoder_block_smoke",
        "_validate_modern_decoder_block_shape",
        "SUPPORTED_MODERN_DECODER_BLOCK_SCHEMA",
        "computes_qk_scores",
        "computes_attention_softmax",
        "requires_prequantized_attention",
        "host_requantizes_qkv",
        "host_requantizes_qk_scores",
        "host_requantizes_attention_weights",
        "eliza.decoder_block",
        "stablehlo.decoder_block",
        "tflite.decoder_block",
        "modern_decoder_block_single_head_exp2_softmax_smoke_only_not_multihead_kv_cache_or_production_compiler_backend",
    ):
        if token not in lowering_text:
            errors.append(f"modern_decoder_block lowering smoke missing token {token!r}")

    rope_lowering = contract.get("rope_lowering_smoke", {})
    if rope_lowering.get("runtime_api") != "lower_rope_smoke":
        errors.append("RoPE lowering smoke must identify lower_rope_smoke runtime API")
    if (
        rope_lowering.get("claim_boundary")
        != "rope_s8_scalar_smoke_only_not_vector_or_production_compiler_backend"
    ):
        errors.append("RoPE lowering smoke claim boundary must remain vector/compiler blocked")
    if set(rope_lowering.get("supported_precisions", [])) != {"int8"}:
        errors.append("RoPE lowering smoke must be limited to int8")
    if "OP_MUL_LO" not in str(rope_lowering.get("lowering", "")):
        errors.append("RoPE lowering smoke must route multiply arithmetic through OP_MUL_LO")
    for token in (
        "lower_rope_smoke",
        "_validate_rope_shape",
        "_golden_rope",
        "host_applies_shift_and_saturation",
        "runtime.mul_lo",
        "runtime.sub",
        "runtime.add",
        "stablehlo.rope",
        "tflite.rope",
        "eliza.rope",
        "rope_s8_scalar_smoke_only_not_vector_or_production_compiler_backend",
    ):
        if token not in lowering_text:
            errors.append(f"RoPE lowering smoke missing token {token!r}")

    rmsnorm_lowering = contract.get("rmsnorm_lowering_smoke", {})
    if rmsnorm_lowering.get("runtime_api") != "lower_rmsnorm_smoke":
        errors.append("RMSNorm lowering smoke must identify lower_rmsnorm_smoke runtime API")
    if (
        rmsnorm_lowering.get("claim_boundary")
        != "rmsnorm_s8_scalar_smoke_only_not_vector_or_production_compiler_backend"
    ):
        errors.append("RMSNorm lowering smoke claim boundary must remain vector/compiler blocked")
    if set(rmsnorm_lowering.get("supported_precisions", [])) != {"int8"}:
        errors.append("RMSNorm lowering smoke must be limited to int8")
    if "OP_MUL_LO" not in str(rmsnorm_lowering.get("lowering", "")):
        errors.append("RMSNorm lowering smoke must route multiply arithmetic through OP_MUL_LO")
    for token in (
        "lower_rmsnorm_smoke",
        "_validate_rmsnorm_shape",
        "_golden_rmsnorm",
        "host_computes_reciprocal_rms",
        "host_applies_shift_and_saturation",
        "runtime.mul_lo",
        "runtime.add",
        "stablehlo.rms_norm",
        "tflite.rms_norm",
        "eliza.rms_norm",
        "rmsnorm_s8_scalar_smoke_only_not_vector_or_production_compiler_backend",
    ):
        if token not in lowering_text:
            errors.append(f"RMSNorm lowering smoke missing token {token!r}")

    for absolute in (
        runtime.PERF_UNSUPPORTED_OPS,
        runtime.PERF_CYCLES,
        runtime.PERF_MACS,
        runtime.PERF_OPS,
        runtime.PERF_ERRORS,
    ):
        token = f"0x{absolute:08x}u"
        if token not in verilator_text:
            errors.append(f"Verilator GEMM test must read/check {token}")

    stale_perf_addresses = {"0x10020030u", "0x10020034u"}
    stale_hits = sorted(token for token in stale_perf_addresses if token in verilator_text)
    if stale_hits:
        errors.append(
            "Verilator GEMM test still references stale perf address(es): " + ", ".join(stale_hits)
        )

    missing_delta = set(contract.get("target_2028_delta", {}).get("missing_for_phone_class", []))
    for required in (
        "160 dense INT8 peak TOPS target evidence",
        "AIDL HAL, VTS, CTS, and SELinux evidence",
        "MLIR/StableHLO/TFLite/ExecuTorch compiler path",
        "power and thermal traces",
    ):
        if required not in missing_delta:
            errors.append(f"target delta missing blocker: {required}")

    if NNAPI_PROOF.exists():
        errors.append(
            "unexpected NNAPI proof exists; benchmark acceleration claims need separate evidence review"
        )

    contract_precision = {
        entry.get("precision"): entry.get("state")
        for entry in contract.get("precision_matrix", [])
        if isinstance(entry, dict)
    }
    for blocked in ("FP16", "BF16"):
        if contract_precision.get(blocked) != "blocked":
            errors.append(f"contract precision matrix must keep {blocked} blocked")
    if contract_precision.get("FP8") != "supported_prototype":
        errors.append("contract precision matrix must identify FP8 supported_prototype")
    descriptor_queue = contract.get("descriptor_queue_submission", {})
    if descriptor_queue.get("state") != "rtl_local_descriptor_ring":
        errors.append(
            "contract descriptor queue submission must describe rtl_local_descriptor_ring"
        )
    for token in (
        "timeout_polls",
        "ctrl_status",
        "desc_status",
        "perf_counters",
        "desc_timeout_count",
        "desc_bytes_read",
        "desc_bytes_written",
        "desc_read_beats",
        "desc_write_beats",
    ):
        if token not in descriptor_queue.get("required_error_reporting", []):
            errors.append(f"descriptor queue error reporting missing {token}")

    runtime_sim_text = RUNTIME_SIM_TEST.read_text()
    for token in (
        "gemm_s8",
        "gemm_s4",
        "vrelu_s8",
        "golden_gemm_s8",
        "golden_gemm_s4",
        "golden_vrelu_s8",
        "lower_matmul_smoke",
        "lower_sparse_int4_matmul_smoke",
        "lower_int2_matmul_smoke",
        "lower_fp8_matmul_smoke",
        "lower_conv2d_smoke",
        "lower_attention_qk_smoke",
        "lower_attention_av_smoke",
        "lower_kv_cache_update_smoke",
        "lower_mlp_smoke",
        "lower_swiglu_smoke",
        "lower_bias_add_smoke",
        "lower_residual_add_smoke",
        "lower_transformer_block_smoke",
        "lower_modern_decoder_block_smoke",
        "lower_rope_smoke",
        "lower_rmsnorm_smoke",
        "test_runtime_matmul_smoke_lowering_dispatches_multiple_tiles",
        "test_runtime_matmul_smoke_lowering_split_k_accumulates_npu_partials",
        "test_runtime_sparse_int4_matmul_smoke_dispatches_sdot4_chunks",
        "test_runtime_int2_matmul_smoke_dispatches_dot16_chunks",
        "test_runtime_fp8_matmul_smoke_dispatches_dot4_chunks",
        "test_runtime_conv2d_smoke_lowering_dispatches_im2col_tiles",
        "test_runtime_attention_qk_smoke_lowering_dispatches_per_head_gemm",
        "test_runtime_attention_softmax_smoke_dispatches_scalar_exp2_path",
        "test_runtime_attention_av_smoke_lowering_dispatches_per_head_gemm",
        "test_runtime_kv_cache_update_smoke_dispatches_scalar_copies",
        "test_runtime_transformer_mlp_smoke_dispatches_gemm_vrelu_gemm",
        "test_runtime_swiglu_smoke_dispatches_gemm_scalar_gate_gemm",
        "test_runtime_bias_add_smoke_dispatches_broadcast_scalar_adds",
        "test_runtime_residual_add_smoke_dispatches_scalar_adds",
        "test_runtime_transformer_block_smoke_dispatches_composed_primitives",
        "test_runtime_modern_decoder_block_smoke_dispatches_composed_primitives",
        "test_runtime_rope_smoke_dispatches_scalar_arithmetic",
        "test_runtime_rmsnorm_smoke_dispatches_scalar_arithmetic",
        "submit_descriptors",
        "descriptor_counters",
        "DESC_BYTES_READ",
        "unsupported_ops",
        "prototype limits",
    ):
        if token not in runtime_sim_text:
            errors.append(f"runtime simulator test missing token {token!r}")
    runtime_text = RUNTIME.read_text()
    for token in ("DESC_FLAG_VALID_OWNER", "DESC_FLAG_WRITEBACK_REQUEST"):
        if token not in runtime_text:
            errors.append(f"runtime missing descriptor flag token {token!r}")

    return report(errors)


def report(errors: list[str]) -> int:
    if errors:
        for error in errors:
            print(f"FAIL: {error}")
        return 1
    print("e1 NPU runtime contract check passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
