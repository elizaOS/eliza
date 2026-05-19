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
STABLEHLO = ROOT / "compiler/runtime/e1_npu_stablehlo.py"
RUNTIME_TEST = ROOT / "compiler/runtime/test_e1_npu_runtime.py"
COMMAND_BUFFER_TEST = ROOT / "compiler/runtime/test_e1_npu_runtime_commandbuffer.py"
STABLEHLO_TEST = ROOT / "compiler/runtime/test_e1_npu_stablehlo.py"
RUNTIME_SIM_TEST = ROOT / "compiler/runtime/test_e1_npu_runtime_sim.py"
PARTITIONER = ROOT / "compiler/runtime/e1_npu_partitioner.py"
PARTITIONER_TEST = ROOT / "compiler/runtime/test_e1_partitioner.py"
EXECUTORCH_DELEGATE = ROOT / "compiler/runtime/e1_executorch_delegate.py"
EXECUTORCH_DELEGATE_TEST = ROOT / "compiler/runtime/test_e1_executorch_delegate.py"
LITERT_DELEGATE = ROOT / "compiler/runtime/e1_litert_delegate.py"
LITERT_DELEGATE_TEST = ROOT / "compiler/runtime/test_e1_litert_delegate.py"
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
        STABLEHLO,
        RUNTIME_TEST,
        COMMAND_BUFFER_TEST,
        STABLEHLO_TEST,
        RUNTIME_SIM_TEST,
        PARTITIONER,
        PARTITIONER_TEST,
        EXECUTORCH_DELEGATE,
        EXECUTORCH_DELEGATE_TEST,
        LITERT_DELEGATE,
        LITERT_DELEGATE_TEST,
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

    stablehlo_import = contract.get("stablehlo_subset_import", {})
    expected_stablehlo_precisions = {
        "int8",
        "int4",
        "int2",
        "bitnet_int2",
        "fp8_e4m3",
        "fp16",
        "float16",
        "bf16",
        "bfloat16",
        "sparse_int4_2_4",
        "int4_group_scaled",
        "group_scaled_int4",
        "w4a8_gs",
    }
    if stablehlo_import.get("module") != "compiler/runtime/e1_npu_stablehlo.py":
        errors.append("StableHLO subset contract must identify e1_npu_stablehlo.py")
    if set(stablehlo_import.get("supported_rank2_dot_ops", [])) != {
        "stablehlo.dot_general",
        "stablehlo.dot",
    }:
        errors.append("StableHLO subset contract must cover dot_general and dot")
    if set(stablehlo_import.get("supported_rank2_dot_precisions", [])) != (
        expected_stablehlo_precisions
    ):
        errors.append("StableHLO subset contract precision set mismatch")
    if set(stablehlo_import.get("supported_rank4_batch_matmul_ops", [])) != {
        "stablehlo.batch_matmul"
    }:
        errors.append("StableHLO subset contract must cover bounded batch_matmul")
    if set(stablehlo_import.get("supported_rank4_batch_matmul_precisions", [])) != {
        "int8",
        "int4",
    }:
        errors.append("StableHLO subset batch_matmul precision set mismatch")
    if set(stablehlo_import.get("supported_convolution_ops", [])) != {"stablehlo.convolution"}:
        errors.append("StableHLO subset contract must cover stablehlo.convolution")
    if set(stablehlo_import.get("supported_convolution_precisions", [])) != {
        "int8",
        "int4",
    }:
        errors.append("StableHLO subset convolution precision set mismatch")
    if set(stablehlo_import.get("supported_add_ops", [])) != {
        "stablehlo.add",
        "stablehlo.residual_add",
        "stablehlo.bias_add",
    }:
        errors.append("StableHLO subset contract must cover stablehlo add aliases")
    if set(stablehlo_import.get("supported_add_precisions", [])) != {"int8"}:
        errors.append("StableHLO subset add precision set mismatch")
    if set(stablehlo_import.get("supported_mlp_ops", [])) != {"stablehlo.mlp"}:
        errors.append("StableHLO subset contract must cover stablehlo.mlp")
    if set(stablehlo_import.get("supported_mlp_precisions", [])) != {"int8"}:
        errors.append("StableHLO subset mlp precision set mismatch")
    if set(stablehlo_import.get("supported_attention_ops", [])) != {
        "stablehlo.attention_qk",
        "stablehlo.attention_av",
    }:
        errors.append("StableHLO subset contract must cover attention_qk/attention_av")
    if set(stablehlo_import.get("supported_attention_precisions", [])) != {"int8", "int4"}:
        errors.append("StableHLO subset attention precision set mismatch")
    stablehlo_validation = str(stablehlo_import.get("validation", ""))
    for token in (
        "stablehlo.attention_qk",
        "stablehlo.attention_av",
        "lower_attention_qk_smoke",
        "lower_attention_av_smoke",
    ):
        if token not in stablehlo_validation:
            errors.append(f"StableHLO subset contract validation missing {token!r}")
    if (
        stablehlo_import.get("claim_boundary")
        != "stablehlo_subset_parser_only_not_mlir_pipeline_graph_partitioner_or_production_compiler_backend"
    ):
        errors.append("StableHLO subset claim boundary must remain parser-only")
    stablehlo_text = STABLEHLO.read_text()
    stablehlo_test_text = STABLEHLO_TEST.read_text()
    for token in (
        "OP_DOT",
        "OP_ADD",
        "OP_BIAS_ADD",
        "OP_RESIDUAL_ADD",
        "OP_MLP",
        "OP_ATTENTION_QK",
        "OP_ATTENTION_AV",
        "OP_BATCH_MATMUL",
        "OP_CONVOLUTION",
        "Add",
        "BiasAdd",
        "ResidualAdd",
        "BatchMatmul",
        "Convolution",
        "Mlp",
        "AttentionQk",
        "AttentionAv",
        "SUPPORTED_PRECISIONS",
        "bitnet_int2",
        "fp16",
        "bf16",
        "sparse_int4_2_4",
        "int4_group_scaled",
        "w4a8_gs",
        "SUPPORTED_OPS",
        "LoweringPlan",
        "plan_module_lowerings",
        "plan_op_lowering",
        "materialize_lowering_graph",
        "materialize_op_lowering_graph",
        "materialize_module_lowering_graphs",
        "MODULE_EMPTY",
        "DUPLICATE_OP_NAME",
        "_BATCH_MATMUL_LOWERING_TARGETS",
        "_CONVOLUTION_LOWERING_TARGETS",
        "_RESIDUAL_ADD_LOWERING_TARGETS",
        "_BIAS_ADD_LOWERING_TARGETS",
        "_MLP_LOWERING_TARGETS",
        "_ATTENTION_QK_LOWERING_TARGETS",
        "_ATTENTION_AV_LOWERING_TARGETS",
        "_DOT_LOWERING_TARGETS",
        "_validate_dot_general",
        "_validate_batch_matmul",
        "_validate_convolution",
        "_validate_add",
        "_validate_bias_add",
        "_validate_residual_add",
        "_validate_mlp",
        "_validate_attention_qk",
        "_validate_attention_av",
        "_check_tile_bounds",
    ):
        if token not in stablehlo_text:
            errors.append(f"StableHLO subset missing token {token!r}")
    for token in (
        "test_stablehlo_subset_accepts_low_precision_rank2_dot_smoke_precisions",
        "test_stablehlo_subset_accepts_stablehlo_dot_alias_for_matmul_smoke",
        "test_stablehlo_subset_plans_runtime_lowering_targets_for_low_precision_dot_modes",
        "test_stablehlo_subset_plans_bounded_batch_matmul_runtime_lowering",
        "test_stablehlo_subset_rejects_batch_matmul_unsupported_precision_and_shape",
        "test_stablehlo_subset_materializes_batch_matmul_smoke_graph_from_plan",
        "test_stablehlo_subset_plans_bounded_convolution_runtime_lowering",
        "test_stablehlo_subset_plans_add_and_bias_add_runtime_lowering",
        "test_stablehlo_subset_plans_mlp_runtime_lowering",
        "test_stablehlo_subset_accepts_attention_qk_and_av_smoke_records",
        "test_stablehlo_subset_plans_attention_qk_and_av_runtime_lowering",
        "test_stablehlo_subset_rejects_convolution_unsupported_precision_and_shape",
        "test_stablehlo_subset_rejects_add_and_bias_add_unsupported_shapes",
        "test_stablehlo_subset_rejects_mlp_unsupported_activation_precision_and_shape",
        "test_stablehlo_subset_rejects_attention_unsupported_precision_and_shape",
        "test_stablehlo_subset_materializes_convolution_smoke_graph_from_plan",
        "test_stablehlo_subset_materializes_add_and_bias_add_smoke_graphs_from_plan",
        "test_stablehlo_subset_materializes_mlp_smoke_graph_from_plan",
        "test_stablehlo_subset_materializes_attention_qk_and_av_smoke_graphs_from_plan",
        "test_stablehlo_subset_plans_required_graph_fields_for_metadata_backed_precisions",
        "test_stablehlo_subset_materializes_runtime_smoke_graph_from_plan",
        "test_stablehlo_subset_materializes_metadata_backed_runtime_graphs",
        "test_stablehlo_subset_rejects_empty_modules_and_duplicate_op_names",
        "UNSUPPORTED_PRECISION",
        "TILE_M_OUT_OF_RANGE",
    ):
        if token not in stablehlo_test_text:
            errors.append(f"StableHLO subset test missing token {token!r}")
    lowering_text = LOWERING.read_text()
    runtime_test_text = RUNTIME_TEST.read_text()
    for token in (
        "LoweredStableHloModuleResult",
        "LoweredBatchMatmulResult",
        "lower_batch_matmul_smoke",
        "lower_conv2d_smoke",
        "lower_residual_add_smoke",
        "lower_bias_add_smoke",
        "lower_mlp_smoke",
        "lower_attention_qk_smoke",
        "lower_attention_av_smoke",
        "SUPPORTED_BATCH_MATMUL_SCHEMA",
        "SUPPORTED_CONV2D_SCHEMA",
        "lower_stablehlo_module_smoke",
        "materialize_module_lowering_graphs",
        "host_iterates_batch_heads",
        "dispatch_order",
        "lowering_plans",
        "all_npu_dispatch",
        "stablehlo_smoke_module_dispatch_only_not_mlir_pipeline_graph_partitioner",
        "lower_fp8_matmul_smoke",
        "host_materializes_im2col",
        "lower_sparse_int4_matmul_smoke",
        "lower_group_scaled_int4_matmul_smoke",
        "stablehlo.attention_qk",
        "stablehlo.attention_av",
    ):
        if token not in lowering_text:
            errors.append(f"StableHLO module smoke dispatch missing token {token!r}")
    for token in (
        "test_stablehlo_module_smoke_dispatches_materialized_dot_graphs_without_cpu_fallback",
        "test_batch_matmul_smoke_reuses_tiled_matmul_without_cpu_fallback",
        "test_stablehlo_module_smoke_dispatches_batch_matmul_graph_without_cpu_fallback",
        "test_stablehlo_module_smoke_dispatches_convolution_graph_without_cpu_fallback",
        "test_stablehlo_module_smoke_dispatches_add_and_bias_add_without_cpu_fallback",
        "test_stablehlo_module_smoke_dispatches_mlp_without_cpu_fallback",
        "test_stablehlo_module_smoke_dispatches_attention_qk_and_av_without_cpu_fallback",
        "test_batch_matmul_smoke_rejects_unsupported_graphs_before_touching_mmio",
        "test_stablehlo_module_smoke_rejects_invalid_import_before_touching_mmio",
        "DUPLICATE_OP_NAME",
    ):
        if token not in runtime_test_text:
            errors.append(f"StableHLO module smoke dispatch test missing token {token!r}")

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
    for scalar_float16 in ("FP16", "BF16"):
        if precision.get(scalar_float16) != "supported":
            errors.append(
                f"runtime must report {scalar_float16} scalar Q8.8 smoke as supported, "
                f"got {precision.get(scalar_float16)!r}"
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
    register_followups = contract.get("mmio", {}).get("register_followups", {})
    bsp_header_pending = set(register_followups.get("bsp_header_pending", []))
    for name, offset in registers.items():
        if name.startswith("PERF_") and name not in arch_text:
            errors.append(f"architecture doc missing perf register {name}")
        if name == "SCRATCH":
            continue
        header_name = {
            "DEBUG": "TRACE",
        }.get(name, name)
        if name in bsp_header_pending:
            # BSP header parity for the new perf counters lands in a follow-up
            # commit owned by the BSP/platform scope; runtime + RTL + arch doc
            # still have to agree on the offset here.
            continue
        actual_offset = header_offsets.get(header_name)
        if actual_offset != hex_to_int(offset):
            errors.append(f"BSP header E1_NPU_{header_name}_OFFSET {actual_offset!r} != {offset}")
        generated_token = f"#define E1_NPU_{header_name}_OFFSET 0x{hex_to_int(offset):02X}UL"
        if generated_token not in generated_header_text:
            errors.append(f"generated platform header missing {generated_token}")

    perf_added = contract.get("perf_counters_added", {})
    added_entries = {entry.get("name"): entry for entry in perf_added.get("entries", [])}
    expected_added = {
        "PERF_STALL_CYCLES": "0x74",
        "PERF_SCRATCH_BYTES": "0x78",
        "PERF_THERMAL_THROTTLE": "0x7c",
    }
    for counter_name, expected_offset in expected_added.items():
        if counter_name not in registers:
            errors.append(f"contract mmio.registers missing {counter_name}")
        elif registers[counter_name] != expected_offset:
            errors.append(
                f"contract mmio.registers {counter_name}={registers[counter_name]!r} "
                f"!= {expected_offset!r}"
            )
        entry = added_entries.get(counter_name)
        if entry is None:
            errors.append(f"contract perf_counters_added missing {counter_name}")
            continue
        if entry.get("offset") != expected_offset:
            errors.append(
                f"contract perf_counters_added {counter_name} offset mismatch: "
                f"{entry.get('offset')!r} != {expected_offset!r}"
            )
        if counter_name not in arch_text:
            errors.append(f"architecture doc missing perf counter {counter_name}")
        runtime_const = getattr(runtime, counter_name, None)
        if runtime_const != base + hex_to_int(expected_offset):
            errors.append(
                f"runtime {counter_name} address {runtime_const!r} "
                f"!= contract base + {expected_offset}"
            )
    if expected_added.keys() - bsp_header_pending:
        errors.append(
            "mmio.register_followups.bsp_header_pending must list every "
            "newly added perf counter while the BSP header parity is a follow-up"
        )
    thermal_entry = added_entries.get("PERF_THERMAL_THROTTLE", {})
    if "simulation_only" not in str(thermal_entry.get("claim_boundary", "")):
        errors.append(
            "PERF_THERMAL_THROTTLE must keep a simulation-only claim boundary "
            "until a thermal HAL drives it"
        )

    dot16_modes = contract.get("dot16_s2_modes", {})
    ternary_mode = dot16_modes.get("ternary", {})
    if ternary_mode.get("cmd_param_flag") != "CMD_PARAM[1]=1":
        errors.append("contract dot16_s2_modes.ternary must declare CMD_PARAM[1]=1 selector")
    if "0b00=0" not in ternary_mode.get("lane_encoding", ""):
        errors.append(
            "contract dot16_s2_modes.ternary lane_encoding must document the "
            "0b00=0/0b01=+1/0b10=-1/0b11=reserved decode"
        )
    if "fails closed" not in ternary_mode.get("reserved_encoding_behavior", ""):
        errors.append(
            "contract dot16_s2_modes.ternary must declare fail-closed rejection "
            "for the reserved 0b11 encoding"
        )
    if (
        ternary_mode.get("claim_boundary")
        != "bitnet_ternary_prototype_dot16_only_not_tensor_int2_gemm_or_bitnet_compiler_backend"
    ):
        errors.append("contract dot16_s2_modes.ternary claim boundary must remain prototype-only")
    cmd_param_flags = contract.get("cmd_param_flags", {})
    if cmd_param_flags.get("DOT16_TERNARY") != "0x2":
        errors.append("contract cmd_param_flags.DOT16_TERNARY must be 0x2")
    if cmd_param_flags.get("DESC_SUBMIT") != "0x1":
        errors.append("contract cmd_param_flags.DESC_SUBMIT must be 0x1")
    if getattr(runtime, "CMD_PARAM_DOT16_TERNARY", None) != 0x2:
        errors.append("runtime must expose CMD_PARAM_DOT16_TERNARY = 0x2")
    if getattr(runtime, "CMD_PARAM_DESC_SUBMIT", None) != 0x1:
        errors.append("runtime must expose CMD_PARAM_DESC_SUBMIT = 0x1")
    if not hasattr(runtime, "dot16_ternary"):
        errors.append("runtime must expose dot16_ternary helper")
    if not hasattr(runtime, "extended_perf"):
        errors.append("runtime must expose extended_perf for new counters")
    if not hasattr(runtime, "increment_thermal_throttle"):
        errors.append(
            "runtime must expose increment_thermal_throttle to drive the "
            "simulation-only thermal latch"
        )
    probe_writes.clear()
    instance.dot16_ternary([0] * 16, [0] * 16)
    if (runtime.CMD_PARAM, runtime.CMD_PARAM_DOT16_TERNARY) not in probe_writes:
        errors.append("dot16_ternary must arm CMD_PARAM[1]")
    if (runtime.OPCODE, runtime.OP_DOT16_S2) not in probe_writes:
        errors.append("dot16_ternary must submit OP_DOT16_S2")
    extended_keys = set(instance.extended_perf())
    required_extended = {"stall_cycles", "scratch_bytes", "thermal_throttle"}
    if extended_keys != required_extended:
        errors.append(
            f"runtime extended_perf keys {sorted(extended_keys)} != {sorted(required_extended)}"
        )
    contract_precision_matrix = {
        entry.get("precision"): entry
        for entry in contract.get("precision_matrix", [])
        if isinstance(entry, dict)
    }
    bitnet_entry = contract_precision_matrix.get("BITNET_TERNARY", {})
    if bitnet_entry.get("state") != "supported_prototype":
        errors.append("contract precision_matrix must declare BITNET_TERNARY supported_prototype")
    if (
        bitnet_entry.get("claim_boundary")
        != "bitnet_ternary_prototype_dot16_only_not_tensor_int2_gemm_or_bitnet_compiler_backend"
    ):
        errors.append(
            "contract precision_matrix BITNET_TERNARY claim boundary must remain prototype-only"
        )

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

    group_scaled_int4_lowering = contract.get("group_scaled_int4_matmul_lowering_smoke", {})
    if group_scaled_int4_lowering.get("runtime_api") != "lower_group_scaled_int4_matmul_smoke":
        errors.append(
            "group-scaled INT4 matmul lowering smoke must identify "
            "lower_group_scaled_int4_matmul_smoke"
        )
    if (
        group_scaled_int4_lowering.get("claim_boundary")
        != "group_scaled_int4_matmul_q8_8_scalar_smoke_only_not_gemm_s4_gs_or_production_compiler_backend"
    ):
        errors.append(
            "group-scaled INT4 matmul lowering smoke claim boundary must remain scalar-only"
        )
    if set(group_scaled_int4_lowering.get("supported_precisions", [])) != {
        "int4_group_scaled",
        "group_scaled_int4",
        "w4a8_gs",
    }:
        errors.append(
            "group-scaled INT4 matmul lowering smoke must be limited to group-scaled INT4"
        )
    for required in ("signed Q8.8 per-group scales", "MUL_LO", "ADD"):
        if required not in str(group_scaled_int4_lowering.get("lowering", "")):
            errors.append(f"group-scaled INT4 matmul contract missing {required!r}")
    for token in (
        "SUPPORTED_GROUP_SCALED_INT4_MATMUL_SCHEMA",
        "lower_group_scaled_int4_matmul_smoke",
        "_validate_group_scaled_int4_matmul_shape",
        "host_applies_group_scales",
        "host_uses_q8_8_scales",
        "group_dot_products",
        "scales_q8_8",
        "eliza.group_scaled_int4_matmul",
        "eliza.awq_int4_matmul",
        "group_scaled_int4_matmul_q8_8_scalar_smoke_only_not_gemm_s4_gs_or_production_compiler_backend",
    ):
        if token not in lowering_text:
            errors.append(f"group-scaled INT4 matmul lowering smoke missing token {token!r}")

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

    fp16_matmul_lowering = contract.get("fp16_matmul_lowering_smoke", {})
    if fp16_matmul_lowering.get("runtime_api") != "lower_fp16_matmul_smoke":
        errors.append("FP16 matmul lowering smoke must identify lower_fp16_matmul_smoke")
    if (
        fp16_matmul_lowering.get("claim_boundary")
        != "fp16_matmul_q8_8_scalar_smoke_only_not_tensor_fp16_gemm_or_production_compiler_backend"
    ):
        errors.append("FP16 matmul lowering smoke claim boundary must remain scalar-Q8.8-only")
    if set(fp16_matmul_lowering.get("supported_precisions", [])) != {"fp16", "float16"}:
        errors.append("FP16 matmul lowering smoke must be limited to fp16/float16")
    for required in ("converts finite normal/zero values to signed Q8.8", "MUL_LO", "ADD"):
        if required not in str(fp16_matmul_lowering.get("lowering", "")):
            errors.append(f"FP16 matmul contract missing {required!r}")

    bf16_matmul_lowering = contract.get("bf16_matmul_lowering_smoke", {})
    if bf16_matmul_lowering.get("runtime_api") != "lower_bf16_matmul_smoke":
        errors.append("BF16 matmul lowering smoke must identify lower_bf16_matmul_smoke")
    if (
        bf16_matmul_lowering.get("claim_boundary")
        != "bf16_matmul_q8_8_scalar_smoke_only_not_tensor_bf16_gemm_or_production_compiler_backend"
    ):
        errors.append("BF16 matmul lowering smoke claim boundary must remain scalar-Q8.8-only")
    if set(bf16_matmul_lowering.get("supported_precisions", [])) != {"bf16", "bfloat16"}:
        errors.append("BF16 matmul lowering smoke must be limited to bf16/bfloat16")
    for required in ("converts finite normal/zero values to signed Q8.8", "MUL_LO", "ADD"):
        if required not in str(bf16_matmul_lowering.get("lowering", "")):
            errors.append(f"BF16 matmul contract missing {required!r}")
    for token in (
        "SUPPORTED_FP16_MATMUL_SCHEMA",
        "SUPPORTED_BF16_MATMUL_SCHEMA",
        "lower_fp16_matmul_smoke",
        "lower_bf16_matmul_smoke",
        "_fp16_bits_to_q8_8",
        "_bf16_bits_to_q8_8",
        "runtime.mul_lo",
        "runtime.add",
        "host_converts_float16_to_q8_8",
        "host_requantizes_products",
        "eliza.fp16_matmul",
        "eliza.bf16_matmul",
        "fp16_matmul_q8_8_scalar_smoke_only_not_tensor_fp16_gemm_or_production_compiler_backend",
        "bf16_matmul_q8_8_scalar_smoke_only_not_tensor_bf16_gemm_or_production_compiler_backend",
    ):
        if token not in lowering_text:
            errors.append(f"FP16/BF16 matmul lowering smoke missing token {token!r}")

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

    depthwise_conv2d_lowering = contract.get("depthwise_conv2d_lowering_smoke", {})
    if depthwise_conv2d_lowering.get("runtime_api") != "lower_depthwise_conv2d_smoke":
        errors.append(
            "depthwise conv2d lowering smoke must identify lower_depthwise_conv2d_smoke runtime API"
        )
    if (
        depthwise_conv2d_lowering.get("claim_boundary")
        != "depthwise_conv2d_direct_scalar_smoke_only_not_vector_depthwise_or_production_compiler_backend"
    ):
        errors.append(
            "depthwise conv2d lowering smoke claim boundary must remain vector/backend blocked"
        )
    if set(depthwise_conv2d_lowering.get("supported_precisions", [])) != {"int8"}:
        errors.append("depthwise conv2d lowering smoke must be limited to int8")
    depthwise_layout = depthwise_conv2d_lowering.get("layout", {})
    if depthwise_layout.get("input") != "NHWC" or depthwise_layout.get("filter") != "HWCM":
        errors.append("depthwise conv2d lowering smoke must document NHWC/HWCM layout")
    depthwise_lowering = str(depthwise_conv2d_lowering.get("lowering", ""))
    for required in ("OP_MUL_LO", "OP_ADD", "without im2col"):
        if required not in depthwise_lowering:
            errors.append(f"depthwise conv2d contract missing {required!r}")
    for token in (
        "lower_depthwise_conv2d_smoke",
        "_validate_depthwise_conv2d_shape",
        "_depthwise_conv2d_direct",
        "_golden_depthwise_conv2d",
        "host_uses_direct_depthwise_loops",
        "host_materializes_im2col=False",
        "stablehlo.depthwise_convolution",
        "tflite.depthwise_conv_2d",
        "eliza.depthwise_conv2d",
        "depthwise_conv2d_direct_scalar_smoke_only_not_vector_depthwise_or_production_compiler_backend",
    ):
        if token not in lowering_text:
            errors.append(f"depthwise conv2d lowering smoke missing token {token!r}")

    grouped_conv2d_lowering = contract.get("grouped_conv2d_lowering_smoke", {})
    if grouped_conv2d_lowering.get("runtime_api") != "lower_grouped_conv2d_smoke":
        errors.append(
            "grouped conv2d lowering smoke must identify lower_grouped_conv2d_smoke runtime API"
        )
    if (
        grouped_conv2d_lowering.get("claim_boundary")
        != "grouped_conv2d_direct_scalar_smoke_only_not_vector_grouped_conv_or_production_compiler_backend"
    ):
        errors.append(
            "grouped conv2d lowering smoke claim boundary must remain vector/backend blocked"
        )
    if set(grouped_conv2d_lowering.get("supported_precisions", [])) != {"int8"}:
        errors.append("grouped conv2d lowering smoke must be limited to int8")
    grouped_layout = grouped_conv2d_lowering.get("layout", {})
    if grouped_layout.get("input") != "NHWC" or grouped_layout.get("filter") != "HWIO":
        errors.append("grouped conv2d lowering smoke must document NHWC/HWIO layout")
    grouped_lowering = str(grouped_conv2d_lowering.get("lowering", ""))
    for required in ("OP_MUL_LO", "OP_ADD", "without im2col", "groups"):
        if required not in grouped_lowering:
            errors.append(f"grouped conv2d contract missing {required!r}")
    for token in (
        "lower_grouped_conv2d_smoke",
        "_validate_grouped_conv2d_shape",
        "_grouped_conv2d_direct",
        "_golden_grouped_conv2d",
        "host_uses_direct_grouped_loops",
        "host_materializes_im2col=False",
        "SUPPORTED_GROUPED_CONV2D_OPS",
        "eliza.grouped_conv2d",
        "grouped_conv2d_direct_scalar_smoke_only_not_vector_grouped_conv_or_production_compiler_backend",
    ):
        if token not in lowering_text:
            errors.append(f"grouped conv2d lowering smoke missing token {token!r}")

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
        "stablehlo.attention_qk",
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
        "stablehlo.attention_av",
        "stablehlo.dot_general",
        "tflite.batch_matmul",
        "eliza.attention_av",
        "attention_av_context_smoke_only_not_softmax_or_production_compiler_backend",
    ):
        if token not in lowering_text:
            errors.append(f"attention_av lowering smoke missing token {token!r}")

    attention_lowering = contract.get("attention_lowering_smoke", {})
    if attention_lowering.get("runtime_api") != "lower_attention_smoke":
        errors.append("attention lowering smoke must identify lower_attention_smoke runtime API")
    if (
        attention_lowering.get("claim_boundary")
        != "multihead_attention_qk_exp2_softmax_av_smoke_only_not_fused_flash_attention_or_production_compiler_backend"
    ):
        errors.append("attention lowering smoke claim boundary must remain composed-smoke-only")
    if set(attention_lowering.get("supported_precisions", [])) != {"int8"}:
        errors.append("attention lowering smoke must be limited to int8")
    attention_lowering_text = str(attention_lowering.get("lowering", ""))
    for required in (
        "lower_attention_qk_smoke",
        "optional host-generated causal or sliding_window mask_mode",
        "lower_attention_softmax_smoke",
        "lower_attention_av_smoke",
        "host QK-score requantization",
        "host Q0.8 attention-weight requantization",
    ):
        if required not in attention_lowering_text:
            errors.append(f"attention contract missing {required!r}")
    for token in (
        "SUPPORTED_ATTENTION_SCHEMA",
        "lower_attention_smoke",
        "_zero_attention_logits",
        "_causal_attention_mask",
        "_sliding_window_attention_mask",
        "mask_mode",
        "mask_window",
        "computes_qk_scores",
        "computes_attention_softmax",
        "requires_prequantized_attention",
        "host_generates_causal_mask",
        "host_generates_sliding_window_mask",
        "host_requantizes_qk_scores",
        "host_requantizes_attention_weights",
        "host_requantizes_context",
        "eliza.attention",
        "stablehlo.attention",
        "tflite.attention",
        "multihead_attention_qk_exp2_softmax_av_smoke_only_not_fused_flash_attention_or_production_compiler_backend",
    ):
        if token not in lowering_text:
            errors.append(f"attention lowering smoke missing token {token!r}")

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

    qkv_projection_lowering = contract.get("qkv_projection_lowering_smoke", {})
    if qkv_projection_lowering.get("runtime_api") != "lower_qkv_projection_smoke":
        errors.append("qkv_projection lowering smoke must identify lower_qkv_projection_smoke")
    if (
        qkv_projection_lowering.get("claim_boundary")
        != "qkv_projection_packed_gemm_smoke_only_not_fused_attention_or_production_compiler_backend"
    ):
        errors.append("qkv_projection claim boundary must remain packed-projection-smoke-only")
    if set(qkv_projection_lowering.get("supported_precisions", [])) != {"int8"}:
        errors.append("qkv_projection lowering smoke must be limited to int8")
    qkv_projection_text = str(qkv_projection_lowering.get("lowering", ""))
    for required in (
        "lower_matmul_smoke",
        "slices the packed accumulator into Q/K/V",
        "host-side Q/K/V requantization",
    ):
        if required not in qkv_projection_text:
            errors.append(f"qkv_projection contract missing {required!r}")
    for token in (
        "SUPPORTED_QKV_PROJECTION_SCHEMA",
        "SUPPORTED_QKV_PROJECTION_OPS",
        "lower_qkv_projection_smoke",
        "_validate_qkv_projection_shape",
        "_slice_columns",
        "packed_accumulator",
        "host_slices_packed_qkv",
        "host_requantizes_qkv",
        "eliza.qkv_projection",
        "stablehlo.qkv_projection",
        "tflite.qkv_projection",
        "qkv_projection_packed_gemm_smoke_only_not_fused_attention_or_production_compiler_backend",
    ):
        if token not in lowering_text:
            errors.append(f"qkv_projection lowering smoke missing token {token!r}")

    decode_attention_lowering = contract.get("decode_attention_lowering_smoke", {})
    if decode_attention_lowering.get("runtime_api") != "lower_decode_attention_smoke":
        errors.append("decode_attention lowering smoke must identify lower_decode_attention_smoke")
    if (
        decode_attention_lowering.get("claim_boundary")
        != "decode_attention_kv_append_qk_softmax_av_smoke_only_not_paged_cache_flash_attention_or_production_compiler_backend"
    ):
        errors.append("decode_attention claim boundary must remain decode-smoke-only")
    if set(decode_attention_lowering.get("supported_precisions", [])) != {"int8"}:
        errors.append("decode_attention lowering smoke must be limited to int8")
    decode_attention_text = str(decode_attention_lowering.get("lowering", ""))
    for required in (
        "lower_kv_cache_update_smoke",
        "host cache-view materialization",
        "optional cache_window recent-token compaction",
        "lower_attention_smoke",
    ):
        if required not in decode_attention_text:
            errors.append(f"decode_attention contract missing {required!r}")
    for token in (
        "SUPPORTED_DECODE_ATTENTION_SCHEMA",
        "lower_decode_attention_smoke",
        "_materialize_attention_cache_view",
        "updates_kv_cache",
        "computes_attention_over_cache",
        "host_materializes_cache_view",
        "host_applies_decode_cache_window",
        "decode_cache_window",
        "cache_window",
        "eliza.decode_attention",
        "stablehlo.decode_attention",
        "tflite.decode_attention",
        "decode_attention_kv_append_qk_softmax_av_smoke_only_not_paged_cache_flash_attention_or_production_compiler_backend",
    ):
        if token not in lowering_text:
            errors.append(f"decode_attention lowering smoke missing token {token!r}")

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
        "gate_activated",
        "gate_activation_result",
        "host_applies_gate_shift_and_saturation",
        "runtime.mul_lo",
        "stablehlo.swiglu",
        "tflite.swiglu",
        "eliza.swiglu",
        "swiglu_s8_scalar_gate_smoke_only_not_silu_or_production_compiler_backend",
    ):
        if token not in lowering_text:
            errors.append(f"SwiGLU lowering smoke missing token {token!r}")

    swiglu_silu_lowering = contract.get("swiglu_silu_gate_lowering_smoke", {})
    if swiglu_silu_lowering.get("runtime_api") != "lower_swiglu_smoke":
        errors.append("SwiGLU SiLU-gate smoke must identify lower_swiglu_smoke runtime API")
    if swiglu_silu_lowering.get("activation") != "silu":
        errors.append("SwiGLU SiLU-gate smoke must identify silu activation")
    if (
        swiglu_silu_lowering.get("claim_boundary")
        != "swiglu_s8_silu_gate_smoke_only_not_fused_vector_swiglu_or_production_compiler_backend"
    ):
        errors.append("SwiGLU SiLU-gate smoke claim boundary must remain fused-vector blocked")
    if set(swiglu_silu_lowering.get("supported_precisions", [])) != {"int8"}:
        errors.append("SwiGLU SiLU-gate smoke must be limited to int8")
    swiglu_silu_lowering_text = str(swiglu_silu_lowering.get("lowering", ""))
    for required in ("lower_silu_smoke", "EXP2_NEG_Q0_8", "OP_SUB", "OP_MUL_LO"):
        if required not in swiglu_silu_lowering_text:
            errors.append(f"SwiGLU SiLU-gate smoke contract missing {required!r}")
    for token in (
        "swiglu_s8_silu_gate_smoke_only_not_fused_vector_swiglu_or_production_compiler_backend",
        'activation in {"silu", "swiglu_silu"}',
        "gate_activated",
        "gate_activation_result",
        "lower_silu_smoke",
    ):
        if token not in lowering_text:
            errors.append(f"SwiGLU SiLU-gate smoke missing token {token!r}")

    silu_lowering = contract.get("silu_lowering_smoke", {})
    if silu_lowering.get("runtime_api") != "lower_silu_smoke":
        errors.append("SiLU lowering smoke must identify lower_silu_smoke runtime API")
    if (
        silu_lowering.get("claim_boundary")
        != "silu_s8_exp2_piecewise_smoke_only_not_exact_sigmoid_or_vector_activation"
    ):
        errors.append("SiLU lowering smoke claim boundary must remain approximation-only")
    if set(silu_lowering.get("supported_precisions", [])) != {"int8"}:
        errors.append("SiLU lowering smoke must be limited to int8")
    silu_lowering_text = str(silu_lowering.get("lowering", ""))
    for required in ("EXP2_NEG_Q0_8", "OP_SUB", "OP_MUL_LO", "Q0.8 shift"):
        if required not in silu_lowering_text:
            errors.append(f"SiLU lowering smoke contract missing {required!r}")
    for token in (
        "SUPPORTED_SILU_SCHEMA",
        "SUPPORTED_SILU_OPS",
        "lower_silu_smoke",
        "_silu_s8_scalar_approx",
        "_golden_silu_s8_approx",
        "runtime.exp2_neg_q0_8",
        "runtime.sub",
        "runtime.mul_lo",
        "host_applies_shift_and_saturation",
        "stablehlo.silu",
        "tflite.silu",
        "eliza.silu",
        "silu_s8_exp2_piecewise_smoke_only_not_exact_sigmoid_or_vector_activation",
    ):
        if token not in lowering_text:
            errors.append(f"SiLU lowering smoke missing token {token!r}")

    gelu_lowering = contract.get("gelu_lowering_smoke", {})
    if gelu_lowering.get("runtime_api") != "lower_gelu_smoke":
        errors.append("GELU lowering smoke must identify lower_gelu_smoke runtime API")
    if (
        gelu_lowering.get("claim_boundary")
        != "gelu_s8_quick_exp2_piecewise_smoke_only_not_exact_gelu_or_vector_activation"
    ):
        errors.append("GELU lowering smoke claim boundary must remain approximation-only")
    if set(gelu_lowering.get("supported_precisions", [])) != {"int8"}:
        errors.append("GELU lowering smoke must be limited to int8")
    gelu_lowering_text = str(gelu_lowering.get("lowering", ""))
    for required in ("OP_MUL_LO", "EXP2_NEG_Q0_8", "OP_SUB", "Q0.8 shift"):
        if required not in gelu_lowering_text:
            errors.append(f"GELU lowering smoke contract missing {required!r}")
    for token in (
        "SUPPORTED_GELU_SCHEMA",
        "SUPPORTED_GELU_OPS",
        "lower_gelu_smoke",
        "_quick_gelu_s8_scalar_approx",
        "_golden_quick_gelu_s8_approx",
        "runtime.exp2_neg_q0_8",
        "runtime.sub",
        "runtime.mul_lo",
        "scalar_scale_mul_count",
        "scalar_gate_mul_count",
        "host_applies_shift_and_saturation",
        "stablehlo.gelu",
        "tflite.gelu",
        "eliza.quick_gelu",
        "gelu_s8_quick_exp2_piecewise_smoke_only_not_exact_gelu_or_vector_activation",
    ):
        if token not in lowering_text:
            errors.append(f"GELU lowering smoke missing token {token!r}")

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
        "stablehlo.bias_add",
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
        "stablehlo.residual_add",
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
        "lower_qkv_projection_smoke",
        "host Q/K/V slicing",
        "lower_swiglu_smoke",
        "optional SiLU-gated swiglu_activation",
        "optional host-generated causal or sliding_window attention_mask_mode",
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
        "attention_mask_mode",
        "attention_mask_window",
        "host_generates_causal_mask",
        "host_generates_sliding_window_mask",
        "packed_qkv_weight",
        "qkv_projection",
        "host_slices_packed_qkv",
        "swiglu_activation",
        "gate_activation_result",
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
    for scalar_float16 in ("FP16", "BF16"):
        if contract_precision.get(scalar_float16) != "supported_prototype":
            errors.append(
                f"contract precision matrix must identify {scalar_float16} supported_prototype"
            )
    if contract_precision.get("INT4_GROUP_SCALED") != "supported_prototype":
        errors.append(
            "contract precision matrix must identify INT4_GROUP_SCALED supported_prototype"
        )
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

    command_buffer = contract.get("command_buffer_submission", {})
    if command_buffer.get("runtime_api") != "submit":
        errors.append("command buffer submission must identify submit runtime API")
    if command_buffer.get("state") != "runtime_descriptor_batching":
        errors.append("command buffer submission must describe runtime_descriptor_batching")
    if command_buffer.get("descriptor_type") != "NpuStreamDescriptor":
        errors.append("command buffer submission must use NpuStreamDescriptor entries")
    if command_buffer.get("max_entries") != 7:
        errors.append("command buffer submission must stay within the 3-bit RTL ring window")
    if command_buffer.get("descriptor_bytes") != 16:
        errors.append("command buffer submission must document four-word descriptors")
    if (
        command_buffer.get("claim_boundary")
        != "command_buffer_descriptor_batching_smoke_only_not_scheduler_iommu_or_production_dma_runtime"
    ):
        errors.append("command buffer claim boundary must remain smoke-only")
    command_buffer_text = COMMAND_BUFFER_TEST.read_text()
    runtime_text = RUNTIME.read_text()
    for token in (
        "CommandBuffer",
        "descriptor_image",
        "stage",
        "stage_host_runtime_sequence",
        "eliza.e1_npu_host_runtime_sequence_stage_result.v1",
        "NpuStreamDescriptor",
        "submit",
        "MAX_ENTRIES",
        "DESCRIPTOR_BYTES",
    ):
        if token not in runtime_text:
            errors.append(f"runtime command buffer missing token {token!r}")
    for token in (
        "test_command_buffer_descriptor_image_is_word_addressed_and_contiguous",
        "test_command_buffer_stage_writes_descriptor_image_once",
        "test_command_buffer_stage_rejects_invalid_writer_and_empty_buffer",
        "test_stage_host_runtime_sequence_replays_memory_and_mmio_writes",
        "test_stage_host_runtime_sequence_is_fail_closed",
        "test_prepared_batch_host_runtime_sequence_stages_and_submits_in_sim",
        "partition_module",
        "prepared_descriptor_batch",
        "E1NpuMmioSim",
        "test_memory_backed_sim_descriptor_rejects_missing_owner_bit",
        "DESC_STATUS_OWNER_ERROR",
        "bytes_written",
        "0x8000_0000: 58",
        "0x8000_0004: 64",
        "0x8000_0008: 139",
        "0x8000_000C: 154",
        "test_runtime_submit_dispatches_multi_entry_buffer_with_one_completion_wait",
        "NpuDescriptorSubmission",
    ):
        if token not in command_buffer_text:
            errors.append(f"command buffer test missing token {token!r}")

    partition_batches = contract.get("partitioner_command_buffer_batches", {})
    if partition_batches.get("module") != "compiler/runtime/e1_npu_partitioner.py":
        errors.append("partitioner command-buffer batches must identify e1_npu_partitioner.py")
    if partition_batches.get("state") != "contiguous_supported_op_batching":
        errors.append("partitioner command-buffer batches must describe contiguous batching")
    if partition_batches.get("uses") != "CommandBuffer.MAX_ENTRIES":
        errors.append("partitioner command-buffer batches must use CommandBuffer.MAX_ENTRIES")
    if (
        partition_batches.get("claim_boundary")
        != "partitioner_command_buffer_batching_smoke_only_not_dependency_scheduler"
    ):
        errors.append("partitioner command-buffer batching claim boundary must remain smoke-only")
    partitioner_text = PARTITIONER.read_text()
    partitioner_test_text = PARTITIONER_TEST.read_text()
    for token in (
        "PartitionCommandBufferBatch",
        "command_buffer_batches",
        "CommandBuffer.MAX_ENTRIES",
        "TensorArenaPlan",
        "TensorArenaAllocation",
        "tensor_arena_plan",
        "eliza.e1_npu_tensor_arena_plan.v1",
        "storage_dtype",
        "int32_accumulator",
        "tensor_arena_metadata_only_not_lifetime_allocator_or_dma_planner",
        "RuntimeBindingPlan",
        "RuntimeTensorBinding",
        "RuntimeUnresolvedBinding",
        "runtime_binding_plan",
        "eliza.e1_npu_runtime_binding_plan.v1",
        "runtime_binding_metadata_only_not_dma_or_binary_descriptor_codegen",
        "RuntimeDescriptorStagingPlan",
        "RuntimeDescriptorStagingOp",
        "RuntimeDescriptorInput",
        "descriptor_staging_plan",
        "eliza.e1_npu_descriptor_staging_plan.v1",
        "descriptor_staging_relocatable_template_only_not_arena_base_assignment_or_dma_runtime",
        "descriptor_word_template",
        "descriptor_words",
        "RuntimeDescriptorCommandBufferImage",
        "RuntimePreparedDescriptorBatch",
        "RuntimeDescriptorBatch",
        "RuntimeDescriptorExecutionBatch",
        "RuntimeDescriptorBatchBlocker",
        "descriptor_batches",
        "descriptor_execution_batches",
        "shared_mmio_preamble",
        "execution_command_buffer_image",
        "command_buffer_image",
        "eliza.e1_npu_descriptor_command_buffer_image.v1",
        "incompatible GEMM MMIO preambles",
        "prepared_descriptor_batch",
        "eliza.e1_npu_prepared_descriptor_batch.v1",
        "prepared_descriptor_batch_metadata_only_not_mmio_execution_or_dma_submission",
        "host_runtime_sequence",
        "eliza.e1_npu_host_runtime_sequence.v1",
        "host_runtime_sequence_metadata_only_not_tensor_population_or_execution",
        "mmio_preamble_writes",
        "descriptor_memory_writes",
        "submission_mmio_writes",
        "completion_poll",
        "descriptor_command_buffer_image_only_not_dma_submission_or_tensor_population",
        "descriptor_codegen_ready",
        "input_stream_ready",
        "writeback_ready",
        "blocking_reasons",
        "unresolved_inputs",
        "descriptor_slots",
        "partitioner_command_buffer_batching_smoke_only_not_dependency_scheduler",
    ):
        if token not in partitioner_text:
            errors.append(f"partitioner command-buffer batching missing token {token!r}")
    for token in (
        "test_partition_report_groups_contiguous_supported_ops_into_command_buffer_batches",
        "test_partition_report_does_not_batch_across_cpu_fallback_ops",
        "test_partition_report_emits_runtime_binding_plan_from_arena_offsets",
        "test_partition_report_runtime_binding_plan_records_unresolved_metadata_fields",
        "test_partition_report_emits_descriptor_staging_plan_for_ready_input_streams",
        "test_partition_report_descriptor_word_materialization_is_fail_closed",
        "test_descriptor_staging_plan_materializes_ready_command_buffer_image",
        "test_descriptor_staging_plan_command_buffer_image_is_fail_closed",
        "_mismatched_dot_batch_payload",
        "test_descriptor_staging_plan_splits_execution_batches_by_mmio_preamble",
        "test_descriptor_staging_plan_materializes_execution_batch_images",
        "test_descriptor_staging_plan_execution_batch_image_is_fail_closed",
        "test_partition_report_prepares_descriptor_batch_with_mmio_preamble",
        "test_partition_report_prepared_descriptor_batch_is_fail_closed",
        "host_runtime_sequence",
        "test_descriptor_staging_plan_reports_batch_level_blockers",
        "test_partition_report_descriptor_staging_plan_blocks_unresolved_inputs",
        "PartitionCommandBufferBatch",
    ):
        if token not in partitioner_test_text:
            errors.append(f"partitioner command-buffer test missing token {token!r}")

    delegate_preprocess = contract.get("delegate_command_buffer_preprocess", {})
    if delegate_preprocess.get("state") != "prototype_delegate_blob_includes_partitioner_batches":
        errors.append("delegate command-buffer preprocess must describe prototype batch blobs")
    if (
        delegate_preprocess.get("claim_boundary")
        != "delegate_preprocess_command_buffer_metadata_only_not_binary_kernels_or_android_delegate"
    ):
        errors.append("delegate command-buffer preprocess claim boundary must remain metadata-only")
    if set(delegate_preprocess.get("modules", [])) != {
        "compiler/runtime/e1_executorch_delegate.py",
        "compiler/runtime/e1_litert_delegate.py",
    }:
        errors.append("delegate command-buffer preprocess must cover ExecuTorch and LiteRT")
    executorch_text = EXECUTORCH_DELEGATE.read_text()
    executorch_test_text = EXECUTORCH_DELEGATE_TEST.read_text()
    litert_text = LITERT_DELEGATE.read_text()
    litert_test_text = LITERT_DELEGATE_TEST.read_text()
    for token, text, label in (
        ("command_buffer_batches", executorch_text, "ExecuTorch delegate"),
        ("tensor_arena_plan", executorch_text, "ExecuTorch delegate"),
        ("runtime_binding_plan", executorch_text, "ExecuTorch delegate"),
        ("descriptor_staging_plan", executorch_text, "ExecuTorch delegate"),
        ("descriptor_command_buffer_image", executorch_text, "ExecuTorch delegate"),
        ("prepared_descriptor_batch", executorch_text, "ExecuTorch delegate"),
        ("partition_report.descriptor_staging_plan", executorch_text, "ExecuTorch delegate"),
        (
            "test_backend_materializes_descriptor_command_buffer_image_for_ready_batch",
            executorch_test_text,
            "ExecuTorch delegate test",
        ),
        (
            "test_backend_descriptor_command_buffer_image_fails_closed_for_mixed_batch",
            executorch_test_text,
            "ExecuTorch delegate test",
        ),
        (
            "test_backend_prepares_descriptor_batch_for_ready_batch",
            executorch_test_text,
            "ExecuTorch delegate test",
        ),
        ("host_runtime_sequence", executorch_test_text, "ExecuTorch delegate test"),
        (
            "test_backend_prepared_descriptor_batch_fails_closed_for_mixed_batch",
            executorch_test_text,
            "ExecuTorch delegate test",
        ),
        ("descriptor_codegen_ready", executorch_test_text, "ExecuTorch delegate test"),
        ("unresolved_inputs", executorch_test_text, "ExecuTorch delegate test"),
        ("input_stream_ready", executorch_test_text, "ExecuTorch delegate test"),
        ("partition_report.command_buffer_batches", executorch_text, "ExecuTorch delegate"),
        ("partition_report.tensor_arena_plan", executorch_text, "ExecuTorch delegate"),
        ("partition_report.runtime_binding_plan", executorch_text, "ExecuTorch delegate"),
        ("command_buffer_batches", litert_text, "LiteRT delegate"),
        ("tensor_arena_plan", litert_text, "LiteRT delegate"),
        ("runtime_binding_plan", litert_text, "LiteRT delegate"),
        ("descriptor_staging_plan", litert_text, "LiteRT delegate"),
        ("descriptor_command_buffer_image", litert_text, "LiteRT delegate"),
        ("prepared_descriptor_batch", litert_text, "LiteRT delegate"),
        ("e1_litert_delegate_descriptor_command_buffer_image", litert_text, "LiteRT delegate"),
        ("e1_litert_delegate_prepared_descriptor_batch", litert_text, "LiteRT delegate"),
        ("partition_report.descriptor_staging_plan", litert_text, "LiteRT delegate"),
        (
            "test_delegate_materializes_descriptor_command_buffer_image_for_ready_batch",
            litert_test_text,
            "LiteRT delegate test",
        ),
        (
            "test_delegate_descriptor_command_buffer_image_fails_closed_for_mixed_batch",
            litert_test_text,
            "LiteRT delegate test",
        ),
        (
            "test_delegate_prepares_descriptor_batch_for_ready_batch",
            litert_test_text,
            "LiteRT delegate test",
        ),
        ("host_runtime_sequence", litert_test_text, "LiteRT delegate test"),
        (
            "test_delegate_prepared_descriptor_batch_fails_closed_for_mixed_batch",
            litert_test_text,
            "LiteRT delegate test",
        ),
        ("descriptor_codegen_ready", litert_test_text, "LiteRT delegate test"),
        ("blocking_reasons", litert_test_text, "LiteRT delegate test"),
        ("partition_report.command_buffer_batches", litert_text, "LiteRT delegate"),
        ("partition_report.tensor_arena_plan", litert_text, "LiteRT delegate"),
        ("partition_report.runtime_binding_plan", litert_text, "LiteRT delegate"),
        ("command_buffer_batches", executorch_test_text, "ExecuTorch delegate test"),
        ("tensor_arena_plan", executorch_test_text, "ExecuTorch delegate test"),
        ("runtime_binding_plan", executorch_test_text, "ExecuTorch delegate test"),
        (
            "partitioner_command_buffer_batching_smoke_only",
            executorch_test_text,
            "ExecuTorch delegate test",
        ),
        ("command_buffer_batches", litert_test_text, "LiteRT delegate test"),
        ("tensor_arena_plan", litert_test_text, "LiteRT delegate test"),
        ("runtime_binding_plan", litert_test_text, "LiteRT delegate test"),
        (
            "partitioner_command_buffer_batching_smoke_only",
            litert_test_text,
            "LiteRT delegate test",
        ),
    ):
        if token not in text:
            errors.append(f"{label} missing token {token!r}")

    delegate_arena = contract.get("delegate_tensor_arena_preprocess", {})
    if delegate_arena.get("schema") != "eliza.e1_npu_tensor_arena_plan.v1":
        errors.append("delegate tensor arena preprocess must identify tensor arena schema")
    if delegate_arena.get("state") != "metadata_only_linear_tensor_arena":
        errors.append("delegate tensor arena preprocess must remain metadata-only")
    for token in ("storage_dtype", "int32_accumulator"):
        if token not in delegate_arena.get("emits", ""):
            errors.append(f"delegate tensor arena contract missing {token}")
    if (
        delegate_arena.get("claim_boundary")
        != "tensor_arena_metadata_only_not_lifetime_allocator_or_dma_planner"
    ):
        errors.append("delegate tensor arena claim boundary must remain allocator-blocked")

    runtime_bindings = contract.get("delegate_runtime_binding_preprocess", {})
    if runtime_bindings.get("schema") != "eliza.e1_npu_runtime_binding_plan.v1":
        errors.append("delegate runtime binding preprocess must identify runtime binding schema")
    if runtime_bindings.get("state") != "metadata_only_runtime_field_to_arena_bindings":
        errors.append("delegate runtime binding preprocess must remain metadata-only")
    for token in ("descriptor_codegen_ready", "ready_ops", "blocked_ops", "unresolved_inputs"):
        if token not in runtime_bindings.get("emits", ""):
            errors.append(f"delegate runtime binding contract missing {token}")
    if "storage_dtype" not in runtime_bindings.get("emits", ""):
        errors.append("delegate runtime binding contract missing storage_dtype")
    if (
        runtime_bindings.get("claim_boundary")
        != "runtime_binding_metadata_only_not_dma_or_binary_descriptor_codegen"
    ):
        errors.append("delegate runtime binding claim boundary must remain descriptor-blocked")

    descriptor_staging = contract.get("delegate_descriptor_staging_preprocess", {})
    if descriptor_staging.get("schema") != "eliza.e1_npu_descriptor_staging_plan.v1":
        errors.append(
            "delegate descriptor staging preprocess must identify descriptor staging schema"
        )
    if descriptor_staging.get("state") != "metadata_only_descriptor_stream_templates":
        errors.append("delegate descriptor staging preprocess must remain metadata-only")
    for token in (
        "descriptor_staging_plan",
        "input_stream_ready",
        "writeback_ready",
        "descriptor_codegen_ready",
        "stream_byte_count",
        "GEMM",
        "descriptor_word_template",
        "descriptor_words",
        "command_buffer_image",
        "eliza.e1_npu_descriptor_command_buffer_image.v1",
        "descriptor_command_buffer_image",
        "e1_litert_delegate_descriptor_command_buffer_image",
        "prepared_descriptor_batch",
        "eliza.e1_npu_prepared_descriptor_batch.v1",
        "e1_litert_delegate_prepared_descriptor_batch",
        "host_runtime_sequence",
        "eliza.e1_npu_host_runtime_sequence.v1",
        "descriptor submission MMIO writes",
        "descriptor_batches",
        "descriptor_execution_batches",
        "shared_mmio_preamble",
        "execution_command_buffer_image",
        "ready_ops",
        "blocked_ops",
        "blocking_reasons",
    ):
        if token not in descriptor_staging.get("emits", ""):
            errors.append(f"delegate descriptor staging contract missing {token}")
    if (
        descriptor_staging.get("claim_boundary")
        != "descriptor_staging_relocatable_template_only_not_arena_base_assignment_or_dma_runtime"
    ):
        errors.append("delegate descriptor staging claim boundary must remain runtime-blocked")

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
        "lower_group_scaled_int4_matmul_smoke",
        "lower_int2_matmul_smoke",
        "lower_fp8_matmul_smoke",
        "lower_conv2d_smoke",
        "lower_depthwise_conv2d_smoke",
        "lower_grouped_conv2d_smoke",
        "lower_attention_smoke",
        "lower_attention_qk_smoke",
        "lower_attention_av_smoke",
        "lower_kv_cache_update_smoke",
        "lower_qkv_projection_smoke",
        "lower_decode_attention_smoke",
        "lower_mlp_smoke",
        "lower_swiglu_smoke",
        "lower_silu_smoke",
        "lower_gelu_smoke",
        "lower_bias_add_smoke",
        "lower_residual_add_smoke",
        "lower_transformer_block_smoke",
        "lower_modern_decoder_block_smoke",
        "lower_rope_smoke",
        "lower_rmsnorm_smoke",
        "test_runtime_matmul_smoke_lowering_dispatches_multiple_tiles",
        "test_runtime_matmul_smoke_lowering_split_k_accumulates_npu_partials",
        "test_runtime_sparse_int4_matmul_smoke_dispatches_sdot4_chunks",
        "test_runtime_group_scaled_int4_matmul_smoke_dispatches_scalar_scale_path",
        "test_runtime_int2_matmul_smoke_dispatches_dot16_chunks",
        "test_runtime_fp8_matmul_smoke_dispatches_dot4_chunks",
        "test_runtime_fp16_matmul_smoke_dispatches_scalar_q8_8_path",
        "test_runtime_bf16_matmul_smoke_dispatches_scalar_q8_8_path",
        "test_runtime_conv2d_smoke_lowering_dispatches_im2col_tiles",
        "test_runtime_depthwise_conv2d_smoke_dispatches_direct_scalar_macs",
        "test_runtime_grouped_conv2d_smoke_dispatches_direct_scalar_macs",
        "test_runtime_attention_smoke_dispatches_qk_softmax_av",
        "test_runtime_attention_smoke_dispatches_generated_causal_mask",
        "test_runtime_attention_smoke_dispatches_generated_sliding_window_mask",
        "test_runtime_attention_qk_smoke_lowering_dispatches_per_head_gemm",
        "test_runtime_attention_softmax_smoke_dispatches_scalar_exp2_path",
        "test_runtime_attention_av_smoke_lowering_dispatches_per_head_gemm",
        "test_runtime_kv_cache_update_smoke_dispatches_scalar_copies",
        "test_runtime_qkv_projection_smoke_dispatches_packed_gemm_and_slices_qkv",
        "test_runtime_decode_attention_smoke_dispatches_kv_append_and_attention",
        "test_runtime_decode_attention_smoke_dispatches_recent_cache_window",
        "test_runtime_transformer_mlp_smoke_dispatches_gemm_vrelu_gemm",
        "test_runtime_swiglu_smoke_dispatches_gemm_scalar_gate_gemm",
        "test_runtime_swiglu_smoke_with_silu_gate_dispatches_exp2_gate_gemm",
        "test_runtime_silu_smoke_dispatches_exp2_piecewise_scalar_activation",
        "test_runtime_gelu_smoke_dispatches_quick_exp2_piecewise_scalar_activation",
        "test_runtime_bias_add_smoke_dispatches_broadcast_scalar_adds",
        "test_runtime_residual_add_smoke_dispatches_scalar_adds",
        "test_runtime_transformer_block_smoke_dispatches_composed_primitives",
        "test_runtime_modern_decoder_block_smoke_dispatches_composed_primitives",
        "test_runtime_modern_decoder_block_smoke_dispatches_packed_qkv_projection",
        "test_runtime_modern_decoder_block_smoke_dispatches_packed_qkv_silu_swiglu_gate",
        "test_runtime_modern_decoder_block_smoke_dispatches_generated_causal_mask",
        "test_runtime_modern_decoder_block_smoke_dispatches_generated_sliding_window_mask",
        "test_runtime_rope_smoke_dispatches_scalar_arithmetic",
        "test_runtime_rmsnorm_smoke_dispatches_scalar_arithmetic",
        "submit_descriptors",
        "descriptor_counters",
        "DESC_BYTES_READ",
        "DESC_BYTES_WRITTEN",
        "_execute_memory_backed_descriptors",
        "_memory_read_u8",
        "_scratch_write_u8",
        "_execute_gemm_from_scratch",
        "write_mem32",
        "DESC_STATUS_OWNER_ERROR",
        "DESC_STATUS_WRITEBACK_UNSUPPORTED",
        "unsupported_ops",
        "prototype limits",
    ):
        if token not in runtime_sim_text:
            errors.append(f"runtime simulator test missing token {token!r}")
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
