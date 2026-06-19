from __future__ import annotations

import subprocess
import sys
from itertools import combinations
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import check_cache_hierarchy as gate  # noqa: E402


def _data_col_body(cols: list[int]) -> str:
    lines = [
        "function automatic logic [7:0] secded_data_col(input int unsigned d);",
        "    unique case (d)",
    ]
    for idx, value in enumerate(cols):
        lines.append(f"        32'd{idx}: secded_data_col = 8'h{value:02X};")
    lines.append("        default: secded_data_col = 8'h00;")
    lines.append("    endcase")
    lines.append("endfunction")
    return "\n".join(lines)


def _hsiao_data_cols() -> list[int]:
    def odd(weight: int) -> list[int]:
        out = []
        for combo in combinations(range(8), weight):
            value = 0
            for bit in combo:
                value |= 1 << bit
            out.append(value)
        return out

    return odd(3) + odd(5)[:8]


def test_parse_secded_data_cols_matches_rtl() -> None:
    cols = gate.parse_secded_data_cols(gate.CACHE_PKG.read_text())
    assert cols is not None
    assert set(cols) == set(range(64))
    assert cols == dict(enumerate(_hsiao_data_cols()))


def test_real_hsiao_matrix_passes() -> None:
    errors: list[str] = []
    gate.check_secded_hsiao_matrix(gate.CACHE_PKG.read_text(), errors)
    assert errors == []


def test_rejects_colliding_columns() -> None:
    cols = _hsiao_data_cols()
    cols[1] = cols[0]  # break SEC distinctness
    errors: list[str] = []
    gate.check_secded_hsiao_matrix(_data_col_body(cols), errors)
    assert any("not distinct" in e or "are equal" in e for e in errors)


def test_rejects_even_weight_columns() -> None:
    # Reconstruct the old LARP encoder masks; their columns are even-weight.
    masks = [
        0xFF00FF00FF00FF00,
        0x00FF00FF00FF00FF,
        0xF0F0F0F0F0F0F0F0,
        0x0F0F0F0F0F0F0F0F,
        0xCCCCCCCCCCCCCCCC,
        0x3333333333333333,
        0xAAAAAAAAAAAAAAAA,
        0x5555555555555555,
    ]
    cols = []
    for i in range(64):
        col = 0
        for k in range(8):
            if (masks[k] >> i) & 1:
                col |= 1 << k
        cols.append(col)
    errors: list[str] = []
    gate.check_secded_hsiao_matrix(_data_col_body(cols), errors)
    assert any("even-weight" in e for e in errors)


def test_rejects_missing_data_col_function() -> None:
    errors: list[str] = []
    gate.check_secded_hsiao_matrix("// no codec here", errors)
    assert any("secded_data_col() body not found" in e for e in errors)


def test_corrector_stub_detector_passes_on_real_rtl() -> None:
    errors: list[str] = []
    gate.check_l1d_corrector_not_stub(errors)
    assert errors == []


def test_corrector_stub_detector_flags_noop() -> None:
    errors: list[str] = []
    # Simulate the old stub body by checking the detector's tokens against a
    # synthetic text via monkeypatching the read path.
    original = gate.L1D_CACHE_RTL
    try:
        stub = ROOT / "build" / "_test_l1d_stub.sv"
        stub.parent.mkdir(parents=True, exist_ok=True)
        stub.write_text(
            "function automatic logic [63:0] ecc_correct"
            "(input logic [63:0] d, input logic [7:0] s);\n"
            "  // the corrector is a stub that returns d\n"
            "  r = d; return r;\n"
            "endfunction\n"
        )
        gate.L1D_CACHE_RTL = stub
        gate.check_l1d_corrector_not_stub(errors)
    finally:
        gate.L1D_CACHE_RTL = original
        stub.unlink(missing_ok=True)
    assert any("stub" in e for e in errors)


def test_full_gate_passes_with_real_ecc_injection() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_cache_hierarchy.py"],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert "Cache hierarchy claim gate passed." in result.stdout
    assert "l1d_secded_injection:" in result.stdout
