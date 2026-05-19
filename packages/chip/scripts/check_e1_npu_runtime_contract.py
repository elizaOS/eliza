#!/usr/bin/env python3
import importlib.util
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONTRACT = ROOT / "docs/spec-db/e1-npu-runtime-contract.json"
RUNTIME = ROOT / "compiler/runtime/e1_npu_runtime.py"
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
        "model compiler backend",
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
    if not hasattr(runtime, "submit_descriptors"):
        errors.append("runtime must expose submit_descriptors for reserved descriptor queue status")
    precision = {entry["precision"]: entry["state"] for entry in instance.precision_matrix()}
    for required in ("INT4", "INT8", "FP16", "BF16", "FP8"):
        if required not in precision:
            errors.append(f"runtime precision matrix missing {required}")
    for blocked in ("FP16", "BF16", "FP8"):
        if precision.get(blocked) != "blocked":
            errors.append(
                f"runtime must report {blocked} as blocked, got {precision.get(blocked)!r}"
            )

    arch_text = ARCH_DOC.read_text()
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
    for blocked in ("FP16", "BF16", "FP8"):
        if contract_precision.get(blocked) != "blocked":
            errors.append(f"contract precision matrix must keep {blocked} blocked")
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
        "golden_gemm_s8",
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
