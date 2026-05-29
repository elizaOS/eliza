#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_vector_kernel_template.json"

WORKPLAN = ROOT / "build/reports/e1x_full_output_workplan.json"
PE_RTL = ROOT / "rtl/e1x/e1x_pe_core.sv"
KERNEL_CODEGEN = ROOT / "compiler/runtime/e1x_kernel_codegen.py"

OP_IMM = 0x13
OP = 0x33
LOAD = 0x03
STORE = 0x23
ECALL = 0x0000_0073

X0 = 0
X1 = 1
X2 = 2
X3 = 3
X10 = 10
X11 = 11
X12 = 12
X13 = 13
X14 = 14
X15 = 15


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def pass_fail(condition: bool, detail: str, fail_detail: str | None = None) -> tuple[str, str]:
    return ("pass", detail) if condition else ("fail", fail_detail or detail)


def signed_imm12(value: int) -> int:
    if not -2048 <= value <= 2047:
        raise ValueError(f"immediate {value} does not fit signed imm12")
    return value & 0xFFF


def r_type(funct7: int, rs2: int, rs1: int, funct3: int, rd: int, opcode: int = OP) -> int:
    return (
        ((funct7 & 0x7F) << 25)
        | ((rs2 & 0x1F) << 20)
        | ((rs1 & 0x1F) << 15)
        | ((funct3 & 0x7) << 12)
        | ((rd & 0x1F) << 7)
        | (opcode & 0x7F)
    )


def i_type(imm: int, rs1: int, funct3: int, rd: int, opcode: int = OP_IMM) -> int:
    return (
        (signed_imm12(imm) << 20)
        | ((rs1 & 0x1F) << 15)
        | ((funct3 & 0x7) << 12)
        | ((rd & 0x1F) << 7)
        | (opcode & 0x7F)
    )


def s_type(imm: int, rs2: int, rs1: int, funct3: int) -> int:
    enc = signed_imm12(imm)
    return (
        ((enc >> 5) << 25)
        | ((rs2 & 0x1F) << 20)
        | ((rs1 & 0x1F) << 15)
        | ((funct3 & 0x7) << 12)
        | ((enc & 0x1F) << 7)
        | STORE
    )


def rv_addi(rd: int, rs1: int, imm: int) -> int:
    return i_type(imm, rs1, 0x0, rd)


def rv_lb(rd: int, rs1: int, imm: int) -> int:
    return i_type(imm, rs1, 0x0, rd, LOAD)


def rv_lw(rd: int, rs1: int, imm: int) -> int:
    return i_type(imm, rs1, 0x2, rd, LOAD)


def rv_sw(rs2: int, rs1: int, imm: int) -> int:
    return s_type(imm, rs2, rs1, 0x2)


def rv_add(rd: int, rs1: int, rs2: int) -> int:
    return r_type(0x00, rs2, rs1, 0x0, rd)


def rv_mul(rd: int, rs1: int, rs2: int) -> int:
    return r_type(0x01, rs2, rs1, 0x0, rd)


def rv_srli(rd: int, rs1: int, shamt: int) -> int:
    return ((shamt & 0x3F) << 20) | ((rs1 & 0x1F) << 15) | (0x5 << 12) | ((rd & 0x1F) << 7) | OP_IMM


def rv_slli(rd: int, rs1: int, shamt: int) -> int:
    return ((shamt & 0x3F) << 20) | ((rs1 & 0x1F) << 15) | (0x1 << 12) | ((rd & 0x1F) << 7) | OP_IMM


def rv_srai(rd: int, rs1: int, shamt: int) -> int:
    return (
        (0x20 << 25)
        | ((shamt & 0x3F) << 20)
        | ((rs1 & 0x1F) << 15)
        | (0x5 << 12)
        | ((rd & 0x1F) << 7)
        | OP_IMM
    )


def hex_words(words: list[int]) -> list[str]:
    return [f"{word & 0xFFFF_FFFF:08x}" for word in words]


def vector_word_template() -> list[int]:
    words = [
        rv_addi(X10, X0, 0),  # accumulator
        rv_lw(X12, X2, 0),  # packed W4 weights at x2
    ]
    for lane in range(8):
        words.append(rv_lb(X11, X1, lane))  # signed activation byte at x1+lane
        if lane == 0:
            words.append(rv_addi(X13, X12, 0))
        else:
            words.append(rv_srli(X13, X12, lane * 4))
        words.append(rv_slli(X13, X13, 60))
        words.append(rv_srai(X13, X13, 60))
        words.append(rv_mul(X14, X11, X13))
        words.append(rv_add(X10, X10, X14))
    words.extend([
        rv_srai(X15, X10, 7),  # sampled Q8.8 requant step before final clamp/merge
        rv_sw(X15, X3, 0),  # store local partial output
        rv_sw(X15, X3, 0x10),  # WAVELET_TX_DATA when x3 is MMIO base
        ECALL,
    ])
    return words


def decode_opcodes(words: list[int]) -> dict[int, int]:
    counts: dict[int, int] = {}
    for word in words:
        opcode = word & 0x7F
        counts[opcode] = counts.get(opcode, 0) + 1
    return counts


def main() -> int:
    checks: list[dict[str, str]] = []
    paths = (WORKPLAN, PE_RTL, KERNEL_CODEGEN)
    missing = [str(path.relative_to(ROOT)) for path in paths if not path.is_file()]
    status, detail = pass_fail(
        not missing,
        "vector-kernel template inputs present",
        "missing inputs: " + ", ".join(missing),
    )
    checks.append({"id": "e1x_vector_kernel_template_inputs_present", "status": status, "detail": detail})

    workplan = load_json(WORKPLAN) if WORKPLAN.is_file() else {}
    pe_rtl = PE_RTL.read_text(encoding="utf-8") if PE_RTL.is_file() else ""
    kernel_codegen = KERNEL_CODEGEN.read_text(encoding="utf-8") if KERNEL_CODEGEN.is_file() else ""
    template_words = vector_word_template()
    template_hex = hex_words(template_words)
    template_sha256 = sha256(("\n".join(template_hex) + "\n").encode()).hexdigest()
    opcode_counts = decode_opcodes(template_words)

    support_markers = (
        "OP_LOAD",
        "OP_STORE",
        "OP_OPIMM",
        "OP_OP",
        "mul_op",
        "WAVELET_TX_DATA",
        "rv_sw",
        "rv_ecall",
    )
    missing_markers = [
        marker for marker in support_markers if marker not in pe_rtl and marker not in kernel_codegen
    ]
    status, detail = pass_fail(
        not missing_markers,
        "PE RTL and codegen helpers expose the template instruction classes",
        "missing instruction support markers: " + ", ".join(missing_markers),
    )
    checks.append({"id": "e1x_vector_kernel_template_instruction_support", "status": status, "detail": detail})

    template_ok = (
        len(template_words) == 54
        and opcode_counts.get(LOAD, 0) == 9
        and opcode_counts.get(OP_IMM, 0) == 26
        and opcode_counts.get(OP, 0) == 16
        and opcode_counts.get(STORE, 0) == 2
        and template_words[-1] == ECALL
    )
    status, detail = pass_fail(
        template_ok,
        f"generated {len(template_words)} RV64IM words for one packed W4A8 vector word",
        "unexpected vector template opcode mix",
    )
    checks.append({"id": "e1x_vector_kernel_template_opcode_mix", "status": status, "detail": detail})

    workplan_summary = workplan.get("summary", {})
    vector_word_ops = int(workplan_summary.get("vector_word_op_count", 0))
    full_instruction_estimate = vector_word_ops * len(template_words)
    scale_ok = (
        workplan.get("status") == "PASS"
        and vector_word_ops == 1_627_345_920
        and int(workplan_summary.get("full_mac_count", 0)) == 13_015_864_320
        and int(workplan_summary.get("core_wave_count", 0)) == 4_187_241
        and int(workplan_summary.get("routing_color_count", 0)) == 24
    )
    status, detail = pass_fail(
        scale_ok,
        f"template scales across {vector_word_ops} packed vector-word operations",
        "full-output workplan scale inputs mismatch",
    )
    checks.append({"id": "e1x_vector_kernel_template_scales_to_workplan", "status": status, "detail": detail})

    failures = [check for check in checks if check["status"] != "pass"]
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "template_instruction_words": len(template_words),
        "template_sha256": template_sha256,
        "template_words_hex": template_hex,
        "load_instruction_count": int(opcode_counts.get(LOAD, 0)),
        "opimm_instruction_count": int(opcode_counts.get(OP_IMM, 0)),
        "op_instruction_count": int(opcode_counts.get(OP, 0)),
        "store_instruction_count": int(opcode_counts.get(STORE, 0)),
        "vector_word_op_count": vector_word_ops,
        "full_template_instruction_estimate": full_instruction_estimate,
        "workplan_sha256": str(workplan_summary.get("workplan_sha256", "")),
        "residual_blocker": "looped_vector_kernel_codegen_and_full_execution_missing",
    }
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-vector-kernel-template",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": (
            "Concrete RV64IM unrolled W4A8 vector-word kernel template for one "
            "packed W4 word and 8 signed int8 activations, scaled against the "
            "full-output workplan. This is not looped per-layer kernel codegen, "
            "not execution of every row, and not a full-output numerical proof."
        ),
        "evidence_paths": [
            "build/reports/e1x_full_output_workplan.json",
            "rtl/e1x/e1x_pe_core.sv",
            "compiler/runtime/e1x_kernel_codegen.py",
            "scripts/check_e1x_vector_kernel_template.py",
        ],
        "checks": checks,
        "summary": summary,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print("BLOCKED: E1X vector-kernel template failed: " + ", ".join(c["id"] for c in failures))
        return 1
    print(f"PASS: E1X vector-kernel template; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
