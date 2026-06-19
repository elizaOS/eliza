#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_tensor_cycle_executor.json"

PROOF = ROOT / "benchmarks/results/e1x-real-graph-w4a8-microkernel-proof.json"
KERNEL_PLAN = ROOT / "benchmarks/results/e1x-real-graph-kernel-dispatch-plan.json"
PE_COCOTB_REPORT = ROOT / "build/reports/e1x_pe_core_cocotb.json"
PE_RTL = ROOT / "rtl/e1x/e1x_pe_core.sv"
PE_COCOTB = ROOT / "verify/cocotb/e1x_core_full/test_e1x_pe_core.py"


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def pass_fail(condition: bool, detail: str, fail_detail: str | None = None) -> tuple[str, str]:
    return ("pass", detail) if condition else ("fail", fail_detail or detail)


def s64(value: int) -> int:
    value &= (1 << 64) - 1
    return value - (1 << 64) if value & (1 << 63) else value


def unpack_signed_w4_word(word: int) -> list[int]:
    values = []
    for lane in range(8):
        nibble = (word >> (lane * 4)) & 0xF
        values.append(nibble - 16 if nibble & 0x8 else nibble)
    return values


def arithmetic_shift_right(value: int, amount: int) -> int:
    return s64(value) >> amount


def execute_scalar_row(activations: list[int], packed_words_hex: list[str]) -> dict[str, int]:
    weights = [
        weight
        for word_hex in packed_words_hex
        for weight in unpack_signed_w4_word(int(word_hex, 16))
    ][: len(activations)]
    regs = {10: 0, 11: 0, 12: 0}
    cycles = 1  # addi x10, x0, 0
    for activation, weight in zip(activations, weights, strict=True):
        regs[11] = s64(activation)
        cycles += 1
        regs[12] = s64(weight)
        cycles += 1
        regs[11] = s64(regs[11] * regs[12])
        cycles += 1
        regs[10] = s64(regs[10] + regs[11])
        cycles += 1
    regs[11] = arithmetic_shift_right(regs[10], 7)
    cycles += 1
    cycles += 1  # ecall
    return {
        "accumulator": int(regs[10]),
        "requantized_s8_unclamped": int(regs[11]),
        "cycles": cycles,
        "instruction_count": cycles,
        "mac_count": len(activations),
    }


def main() -> int:
    checks: list[dict[str, str]] = []
    input_paths = (PROOF, KERNEL_PLAN, PE_COCOTB_REPORT, PE_RTL, PE_COCOTB)
    missing = [str(path.relative_to(ROOT)) for path in input_paths if not path.is_file()]
    status, detail = pass_fail(
        not missing,
        "tensor cycle-executor inputs present",
        "missing inputs: " + ", ".join(missing),
    )
    checks.append(
        {"id": "e1x_tensor_cycle_executor_inputs_present", "status": status, "detail": detail}
    )

    proof = load_json(PROOF) if PROOF.is_file() else {}
    kernel_plan = load_json(KERNEL_PLAN) if KERNEL_PLAN.is_file() else {}
    pe_cocotb = load_json(PE_COCOTB_REPORT) if PE_COCOTB_REPORT.is_file() else {}
    pe_rtl = PE_RTL.read_text(encoding="utf-8") if PE_RTL.is_file() else ""
    pe_cocotb_text = PE_COCOTB.read_text(encoding="utf-8") if PE_COCOTB.is_file() else ""

    schema_ok = (
        proof.get("schema") == "eliza.e1x.w4a8_microkernel_proof.v1"
        and kernel_plan.get("schema") == "eliza.e1x.kernel_dispatch_plan.v1"
        and proof.get("source_kernel_plan_sha256") == kernel_plan.get("artifact_sha256")
    )
    status, detail = pass_fail(
        schema_ok,
        "microkernel proof links to current kernel dispatch plan",
        "microkernel proof/kernel-plan schema or hash mismatch",
    )
    checks.append(
        {
            "id": "e1x_tensor_cycle_executor_proof_links_kernel_plan",
            "status": status,
            "detail": detail,
        }
    )

    pe_status_ok = (
        pe_cocotb.get("status") == "PASS"
        and int(pe_cocotb.get("summary", {}).get("testcases", 0)) >= 16
        and int(pe_cocotb.get("summary", {}).get("missing_expected_tests", 1)) == 0
    )
    status, detail = pass_fail(
        pe_status_ok,
        "PE-core cocotb includes generated W4A8 RTL execution sample",
        "PE-core cocotb evidence missing generated W4A8 sample",
    )
    checks.append(
        {"id": "e1x_tensor_cycle_executor_pe_cocotb_present", "status": status, "detail": detail}
    )

    pe_markers = ("mul_op", "OP_OPIMM", "OP_OP", "srai", "mcycle", "minstret")
    missing_pe_markers = [marker for marker in pe_markers if marker not in pe_rtl + pe_cocotb_text]
    status, detail = pass_fail(
        not missing_pe_markers,
        "PE RTL/cocotb expose RV64IM scalar MUL/add/shift/cycle-counter execution path",
        "missing PE execution markers: " + ", ".join(missing_pe_markers),
    )
    checks.append(
        {
            "id": "e1x_tensor_cycle_executor_pe_scalar_path_markers",
            "status": status,
            "detail": detail,
        }
    )

    records = proof.get("records", [])
    mismatches = []
    total_rows = 0
    total_macs = 0
    total_cycles = 0
    max_row_cycles = 0
    layer_counts: dict[str, int] = {}
    sampled_rows: list[dict[str, int | str]] = []
    if isinstance(records, list):
        for record in records:
            activations = record.get("activation_s8", [])
            rows = record.get("row_results", [])
            kind = str(record.get("kind", ""))
            layer_counts[kind] = layer_counts.get(kind, 0) + 1
            if not isinstance(activations, list) or not isinstance(rows, list):
                mismatches.append(f"malformed:{record.get('layer_name')}")
                continue
            for row in rows:
                result = execute_scalar_row(activations, list(row.get("packed_w4_words_hex", [])))
                expected_acc = int(row.get("accumulator", 0))
                expected_requant = int(row.get("requantized_s8", 0))
                if result["accumulator"] != expected_acc:
                    mismatches.append(f"acc:{record.get('layer_name')}:{row.get('output_row')}")
                clamped = max(-128, min(127, int(result["requantized_s8_unclamped"])))
                if clamped != expected_requant:
                    mismatches.append(f"rq:{record.get('layer_name')}:{row.get('output_row')}")
                total_rows += 1
                total_macs += int(result["mac_count"])
                total_cycles += int(result["cycles"])
                max_row_cycles = max(max_row_cycles, int(result["cycles"]))
                if len(sampled_rows) < 6:
                    sampled_rows.append(
                        {
                            "layer_index": int(record.get("layer_index", -1)),
                            "layer_name": str(record.get("layer_name", "")),
                            "output_row": int(row.get("output_row", -1)),
                            "mac_count": int(result["mac_count"]),
                            "cycles": int(result["cycles"]),
                            "accumulator": int(result["accumulator"]),
                        }
                    )

    execution_ok = (
        not mismatches
        and len(records) >= 283
        and total_rows >= 1132
        and total_macs >= 26180
        and total_cycles == total_macs * 4 + total_rows * 3
    )
    status, detail = pass_fail(
        execution_ok,
        f"cycle-level scalar executor replayed {total_rows} sampled rows and {total_macs} MACs",
        "cycle executor mismatches: " + ", ".join(mismatches[:8]),
    )
    checks.append(
        {
            "id": "e1x_tensor_cycle_executor_replays_all_sampled_rows",
            "status": status,
            "detail": detail,
        }
    )

    failures = [check for check in checks if check["status"] != "pass"]
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "proof_layer_count": len(records) if isinstance(records, list) else 0,
        "executed_row_count": total_rows,
        "executed_mac_count": total_macs,
        "scalar_instruction_count": total_cycles,
        "scalar_cycle_count": total_cycles,
        "max_row_cycles": max_row_cycles,
        "pe_cocotb_testcases": int(pe_cocotb.get("summary", {}).get("testcases", 0)),
        "kind_counts": dict(sorted(layer_counts.items())),
        "sampled_rows": sampled_rows,
        "residual_blocker": "vectorized_full_tensor_fabric_executor_missing",
    }
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-tensor-cycle-executor",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": (
            "Cycle-level scalar RV64IM W4A8 executor evidence for every sampled "
            "microkernel row in the real-graph proof, linked to the PE-core RTL "
            "cocotb generated W4A8 sample. This is not the vectorized full tensor "
            "backend, fabric reduction/merge executor, or full-output numerical proof."
        ),
        "evidence_paths": [
            "benchmarks/results/e1x-real-graph-w4a8-microkernel-proof.json",
            "benchmarks/results/e1x-real-graph-kernel-dispatch-plan.json",
            "build/reports/e1x_pe_core_cocotb.json",
            "rtl/e1x/e1x_pe_core.sv",
            "verify/cocotb/e1x_core_full/test_e1x_pe_core.py",
            "scripts/check_e1x_tensor_cycle_executor.py",
        ],
        "checks": checks,
        "summary": summary,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print("BLOCKED: E1X tensor cycle executor failed: " + ", ".join(c["id"] for c in failures))
        return 1
    print(f"PASS: E1X tensor cycle executor; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
