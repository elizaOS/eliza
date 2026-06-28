#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_looped_vector_kernel_skeleton.json"

WORKPLAN = ROOT / "build/reports/e1x_full_output_workplan.json"
VECTOR_TEMPLATE = ROOT / "build/reports/e1x_vector_kernel_template.json"
PE_RTL = ROOT / "rtl/e1x/e1x_pe_core.sv"

OP_IMM = 0x13
BRANCH = 0x63
ECALL = 0x0000_0073

X0 = 0
X1 = 1
X2 = 2
X5 = 5  # row_count limit, preloaded by layer dispatch
X6 = 6  # vector-word limit, preloaded by layer dispatch
X20 = 20  # row counter
X21 = 21  # vector-word counter


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


def rv_addi(rd: int, rs1: int, imm: int) -> int:
    return (signed_imm12(imm) << 20) | (rs1 << 15) | (0x0 << 12) | (rd << 7) | OP_IMM


def rv_branch(rs1: int, rs2: int, imm: int, funct3: int) -> int:
    if imm % 2 != 0 or not -4096 <= imm <= 4094:
        raise ValueError(f"branch immediate {imm} is not encodable")
    enc = imm & 0x1FFF
    return (
        (((enc >> 12) & 0x1) << 31)
        | (((enc >> 5) & 0x3F) << 25)
        | (rs2 << 20)
        | (rs1 << 15)
        | (funct3 << 12)
        | (((enc >> 1) & 0xF) << 8)
        | (((enc >> 11) & 0x1) << 7)
        | BRANCH
    )


def rv_bge(rs1: int, rs2: int, imm: int) -> int:
    return rv_branch(rs1, rs2, imm, 0x5)


def rv_bne(rs1: int, rs2: int, imm: int) -> int:
    return rv_branch(rs1, rs2, imm, 0x1)


def hex_words(words: list[int]) -> list[str]:
    return [f"{word & 0xFFFF_FFFF:08x}" for word in words]


def loop_skeleton_words() -> list[int]:
    # Register contract:
    #   x1: activation pointer, incremented by 8 bytes per packed vector word.
    #   x2: packed W4 pointer, incremented by 4 bytes per packed vector word.
    #   x5: row_count limit, x6: vector_word_count limit.
    # Template body is inserted at the inner-loop marker by the real codegen pass.
    return [
        rv_addi(X20, X0, 0),  # row = 0
        rv_bge(X20, X5, 32),  # if row >= rows goto done
        rv_addi(X21, X0, 0),  # vector = 0
        rv_bge(X21, X6, 20),  # if vector >= vector_words goto next_row
        rv_addi(X1, X1, 8),  # advance activation pointer
        rv_addi(X2, X2, 4),  # advance packed weight pointer
        rv_addi(X21, X21, 1),  # vector++
        rv_bne(X21, X6, -16),  # loop inner
        rv_addi(X20, X20, 1),  # row++
        rv_bne(X20, X5, -32),  # loop outer
        ECALL,
    ]


def opcode_counts(words: list[int]) -> dict[int, int]:
    counts: dict[int, int] = {}
    for word in words:
        opcode = word & 0x7F
        counts[opcode] = counts.get(opcode, 0) + 1
    return counts


def main() -> int:
    checks: list[dict[str, str]] = []
    paths = (WORKPLAN, VECTOR_TEMPLATE, PE_RTL)
    missing = [str(path.relative_to(ROOT)) for path in paths if not path.is_file()]
    status, detail = pass_fail(
        not missing,
        "looped vector-kernel skeleton inputs present",
        "missing inputs: " + ", ".join(missing),
    )
    checks.append(
        {
            "id": "e1x_looped_vector_kernel_skeleton_inputs_present",
            "status": status,
            "detail": detail,
        }
    )

    workplan = load_json(WORKPLAN) if WORKPLAN.is_file() else {}
    template = load_json(VECTOR_TEMPLATE) if VECTOR_TEMPLATE.is_file() else {}
    pe_rtl = PE_RTL.read_text(encoding="utf-8") if PE_RTL.is_file() else ""
    words = loop_skeleton_words()
    words_hex = hex_words(words)
    skeleton_sha256 = sha256(("\n".join(words_hex) + "\n").encode()).hexdigest()
    counts = opcode_counts(words)

    branch_markers = ("OP_BRANCH", "branch_taken", "BNE", "BGE")
    missing_markers = [marker for marker in branch_markers if marker not in pe_rtl]
    status, detail = pass_fail(
        not missing_markers,
        "PE RTL supports branch control needed by looped vector kernels",
        "missing PE branch markers: " + ", ".join(missing_markers),
    )
    checks.append(
        {
            "id": "e1x_looped_vector_kernel_skeleton_branch_support",
            "status": status,
            "detail": detail,
        }
    )

    skeleton_ok = (
        len(words) == 11
        and counts.get(OP_IMM, 0) == 6
        and counts.get(BRANCH, 0) == 4
        and words[-1] == ECALL
        and skeleton_sha256 == "9422315bcb1a9f158be7d795c6fc386a3c65e31907b80cb5a3cc743d4145dfd3"
    )
    status, detail = pass_fail(
        skeleton_ok,
        f"generated {len(words)} RV64IM loop-control words for row/vector iteration",
        "unexpected loop skeleton opcode mix or hash",
    )
    checks.append(
        {"id": "e1x_looped_vector_kernel_skeleton_opcode_mix", "status": status, "detail": detail}
    )

    workplan_summary = workplan.get("summary", {})
    template_summary = template.get("summary", {})
    full_rows = int(workplan_summary.get("full_output_row_count", 0))
    vector_word_ops = int(workplan_summary.get("vector_word_op_count", 0))
    template_words = int(template_summary.get("template_instruction_words", 0))
    inner_loop_control_estimate = vector_word_ops * 4
    outer_loop_control_estimate = full_rows * 3
    total_control_estimate = inner_loop_control_estimate + outer_loop_control_estimate
    total_template_estimate = int(template_summary.get("full_template_instruction_estimate", 0))
    scale_ok = (
        workplan.get("status") == "PASS"
        and template.get("status") == "PASS"
        and full_rows == 2_608_640
        and vector_word_ops == 1_627_345_920
        and template_words == 54
        and total_template_estimate == 87_876_679_680
        and total_control_estimate == 6_517_209_600
    )
    status, detail = pass_fail(
        scale_ok,
        f"loop skeleton scales to {total_control_estimate} control instructions over the full-output workplan",
        "loop skeleton scale inputs mismatch",
    )
    checks.append(
        {
            "id": "e1x_looped_vector_kernel_skeleton_scales_to_workplan",
            "status": status,
            "detail": detail,
        }
    )

    failures = [check for check in checks if check["status"] != "pass"]
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "skeleton_instruction_words": len(words),
        "skeleton_words_hex": words_hex,
        "skeleton_sha256": skeleton_sha256,
        "branch_instruction_count": int(counts.get(BRANCH, 0)),
        "opimm_instruction_count": int(counts.get(OP_IMM, 0)),
        "full_output_row_count": full_rows,
        "vector_word_op_count": vector_word_ops,
        "template_instruction_words": template_words,
        "template_instruction_estimate": total_template_estimate,
        "loop_control_instruction_estimate": total_control_estimate,
        "combined_template_plus_loop_instruction_estimate": total_template_estimate
        + total_control_estimate,
        "workplan_sha256": str(workplan_summary.get("workplan_sha256", "")),
        "template_sha256": str(template_summary.get("template_sha256", "")),
        "residual_blocker": "per_layer_looped_vector_kernel_codegen_execution_missing",
    }
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-looped-vector-kernel-skeleton",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": (
            "Concrete RV64IM branch/control skeleton for looping over output rows "
            "and packed W4 vector words, scaled against the full-output workplan and "
            "the vector-word template. This is not per-layer codegen integration, "
            "not execution of every row, and not a full-output numerical proof."
        ),
        "evidence_paths": [
            "build/reports/e1x_full_output_workplan.json",
            "build/reports/e1x_vector_kernel_template.json",
            "rtl/e1x/e1x_pe_core.sv",
            "scripts/check_e1x_looped_vector_kernel_skeleton.py",
        ],
        "checks": checks,
        "summary": summary,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print(
            "BLOCKED: E1X looped vector-kernel skeleton failed: "
            + ", ".join(c["id"] for c in failures)
        )
        return 1
    print(f"PASS: E1X looped vector-kernel skeleton; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
