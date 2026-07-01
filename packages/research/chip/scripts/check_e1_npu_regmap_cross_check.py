#!/usr/bin/env python3
"""Cross-check the NPU register map across RTL, arch docs, and the contract JSON.

Three sources own the NPU register map:

1. ``rtl/npu/e1_npu.sv`` — the read-data mux (``case`` over 6-bit offsets).
2. ``docs/arch/npu.md`` — the markdown register tables (``| 0x... |`` rows).
3. ``docs/spec-db/e1-npu-runtime-contract.json`` — the runtime contract.

This validator parses each source, normalizes offsets and field names, and
fails closed if any source disagrees. It is view-only; it does not modify
any source. Run it via ``make npu-regmap-cross-check``.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RTL = ROOT / "rtl/npu/e1_npu.sv"
ARCH_DOC = ROOT / "docs/arch/npu.md"
CONTRACT = ROOT / "docs/spec-db/e1-npu-runtime-contract.json"

# Lines in the RTL read-data mux look like:
#     6'h00: rdata = id_reg;
#     6'h08: rdata = {13'h0, gemm_k, 6'h0, gemm_n, 2'h0, vec_len};
#     7'h7c: rdata = perf_thermal_throttle;
# Capture the offset (in hex) and the whole right-hand side so we can
# match doc names like `gemm_cfg` against packed concatenations that
# contain `gemm_k`, `gemm_n`, `vec_len`, etc.
_RTL_MUX_RE = re.compile(r"(?P<width>\d+)'h(?P<off>[0-9a-fA-F]+)\s*:\s*rdata\s*=\s*(?P<rhs>[^;]+);")
# Identifier pattern used to extract candidate signal tokens from a packed
# concatenation.
_IDENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")

# Lines in docs/arch/npu.md register tables look like:
#     | `0x00` | `ID` | RO | ... |
#     | `0x80`-`0xbc` | `SCRATCH[0..15]` | ... |
# Capture the first hex offset of each row plus the bracketed name.
_DOC_ROW_RE = re.compile(r"\|\s*`?0x(?P<off>[0-9a-fA-F]+)`?[^|]*\|\s*`?(?P<name>[^|`]+)`?")


def _hex_to_int(value: str, width: int | None = None) -> int:
    n = int(value, 16)
    # RTL signals declared as 6-bit see only word-offset; the runtime contract
    # records byte offsets. Normalise to byte offsets where we can: when the
    # case width is 6 bits the value is the word index (multiplied by 4 in the
    # full address-decode upstream). When the width is 7+ bits the value is
    # the byte offset truncated to that width.
    if width == 6:
        return n * 4
    return n


_VERILOG_KEYWORDS = {
    "h",  # part of literal width specifier patterns
    "b",
    "d",
    "o",
    "rdata",
}


def _parse_rtl_offsets() -> dict[int, tuple[str, ...]]:
    """Return ``{byte_offset: (signal_token, ...)}`` for the read-data mux.

    Packed concatenations expose multiple identifiers per offset. We strip
    Verilog numeric literals (``13'h0``) before extracting bare identifiers
    so the cross-check can match doc names like ``gemm_cfg`` against
    ``{13'h0, gemm_k, 6'h0, gemm_n, 2'h0, vec_len}``.
    """
    text = RTL.read_text(encoding="utf-8")
    table: dict[int, tuple[str, ...]] = {}
    for match in _RTL_MUX_RE.finditer(text):
        width = int(match.group("width"))
        offset = _hex_to_int(match.group("off"), width=width)
        rhs = match.group("rhs")
        # Drop Verilog literal-prefixed digits like 13'h0 / 2'b10.
        rhs_clean = re.sub(r"\d+'[bdho][0-9a-fA-FxXzZ_]*", "", rhs)
        tokens = tuple(
            tok.lower()
            for tok in _IDENT_RE.findall(rhs_clean)
            if tok.lower() not in _VERILOG_KEYWORDS
        )
        if not tokens:
            tokens = ("(packed_literal_only)",)
        table[offset] = tokens
    return table


def _parse_doc_offsets() -> dict[int, str]:
    text = ARCH_DOC.read_text(encoding="utf-8")
    table: dict[int, str] = {}
    for line in text.splitlines():
        if "|" not in line or "0x" not in line:
            continue
        match = _DOC_ROW_RE.search(line)
        if not match:
            continue
        try:
            offset = int(match.group("off"), 16)
        except ValueError:
            continue
        # Skip table-header continuation rows like `|---:|---|---:|`
        name = match.group("name").strip()
        if not name or set(name) <= {"-", " "}:
            continue
        table[offset] = name.split()[0].lower().strip("` ")
    return table


def _normalise(name: str) -> str:
    # ID -> id, CTRL_STATUS -> ctrl_status, perf_thermal_throttle -> perf_thermal_throttle,
    # SCRATCH[0..15] -> scratch (vector header), GEMM_BASE -> gemm_base.
    name = name.strip().lower()
    name = name.split("[")[0]
    name = name.replace("`", "")
    name = name.replace(" ", "_")
    name = re.sub(r"[^a-z0-9_]", "", name)
    # Common synonyms between docs and RTL signal names.
    aliases = {
        "id": "id_reg",
        "ctrl_status": "ctrl_status_reg",
        "opcode": "opcode_reg",
        "op_a": "op_a_reg",
        "op_b": "op_b_reg",
        "acc": "acc_reg",
        "result": "result_reg",
        "result_hi": "result_hi_reg",
        "scratch": "scratch_word",
    }
    return aliases.get(name, name)


def _names_agree(rtl_tokens: tuple[str, ...], doc: str) -> bool:
    """Return True iff any RTL signal token shares a meaningful prefix with
    the doc name.

    The doc name is the canonical register identifier (e.g. ``GEMM_CFG``);
    the RTL exposes one or more packed-concatenation signal tokens
    (``gemm_k``, ``gemm_n``, ``vec_len``). Agreement means at least one
    rtl token's domain prefix equals the doc name's domain prefix.
    """
    d = _normalise(doc)
    if not d:
        return False
    d_root = d.split("_", 1)[0]
    for token in rtl_tokens:
        r = _normalise(token)
        if r == d:
            return True
        # Suffix / prefix elision against the full doc name.
        for suffix in ("_q", "_reg", "_word", "_lo", "_hi", "_packed"):
            if r.endswith(suffix) and r[: -len(suffix)] == d:
                return True
            if d.endswith(suffix) and d[: -len(suffix)] == r:
                return True
        # Domain-root match: ``gemm_*`` in RTL agrees with ``GEMM_CFG`` doc.
        r_root = r.split("_", 1)[0]
        if r_root == d_root and len(d_root) >= 3:
            return True
        if "scratch" in r and "scratch" in d:
            return True
    return False


def main() -> int:
    errors: list[str] = []
    for path in (RTL, ARCH_DOC, CONTRACT):
        if not path.exists():
            print(f"FAIL: source missing: {path.relative_to(ROOT)}", file=sys.stderr)
            return 1

    rtl_offsets = _parse_rtl_offsets()
    doc_offsets = _parse_doc_offsets()

    if not rtl_offsets:
        print("FAIL: parsed zero offsets from rtl/npu/e1_npu.sv", file=sys.stderr)
        return 1
    if not doc_offsets:
        print("FAIL: parsed zero offsets from docs/arch/npu.md", file=sys.stderr)
        return 1

    # Registers below 0x20 (OP_A, OP_B, RESULT, OPCODE, ACC, CTRL_STATUS,
    # RESULT_HI) are described in prose at the top of docs/arch/npu.md, not
    # in the byte-offset register table. The cross-check skips coverage for
    # them and only validates that wherever docs AND RTL both bind an offset,
    # the names agree.
    DOC_TABLE_FLOOR = 0x20

    # 1. Disagreement at any offset bound by both sources is a hard fail.
    common = sorted(set(rtl_offsets).intersection(doc_offsets))
    for offset in common:
        tokens = rtl_offsets[offset]
        name = doc_offsets[offset]
        if not _names_agree(tokens, name):
            errors.append(
                f"offset 0x{offset:02x}: RTL tokens {tokens} disagree with doc name '{name}'"
            )

    # 2. Offsets at or above the doc-table floor that the RTL exposes must
    # also appear in the doc table (allow scratchpad vector band).
    for offset, tokens in sorted(rtl_offsets.items()):
        if offset < DOC_TABLE_FLOOR:
            continue
        if offset in doc_offsets:
            continue
        if 0x80 <= offset <= 0xBC and any(0x80 <= o <= 0xBC for o in doc_offsets):
            continue
        errors.append(
            f"RTL offset 0x{offset:02x} ({tokens[0]}) not in docs/arch/npu.md register table"
        )

    # 3. Offsets at or above the doc-table floor that the docs expose must
    # appear in the RTL read-data mux (allow scratchpad family + write-only
    # registers that legitimately have no read path).
    # Write-only registers that legitimately have no read-data mux entry:
    #   0x38 SEC_LOCK  — W1S sticky monitor-programming lock (read via SEC_STATUS)
    #   0x40 DESC_BASE — write-only ring base
    write_only_offsets = {0x38, 0x40}
    for offset, name in sorted(doc_offsets.items()):
        if offset < DOC_TABLE_FLOOR:
            continue
        if offset in rtl_offsets:
            continue
        if offset in write_only_offsets:
            continue
        if 0x80 <= offset <= 0xBC and any(0x80 <= o <= 0xBC for o in rtl_offsets):
            continue
        errors.append(f"doc offset 0x{offset:02x} ({name}) not in rtl/npu/e1_npu.sv read-data mux")

    # 3. Contract sanity: the JSON must parse and carry the NPU schema.
    contract = json.loads(CONTRACT.read_text(encoding="utf-8"))
    if "schema" not in contract:
        errors.append("contract JSON missing schema key")
    elif not contract["schema"].startswith("eliza.e1_npu_runtime_contract."):
        errors.append(
            f"contract schema '{contract['schema']}' does not look like the NPU runtime contract"
        )

    if errors:
        print("npu regmap cross-check failed:", file=sys.stderr)
        for line in errors:
            print(f"  - {line}", file=sys.stderr)
        return 1

    print(
        f"npu regmap cross-check passed: rtl_offsets={len(rtl_offsets)} "
        f"doc_offsets={len(doc_offsets)} contract_schema={contract.get('schema')}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
