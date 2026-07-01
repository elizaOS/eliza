"""Host-side sanity check on rtl/cpu/fusion/fusion_pkg.sv.

Parses the package, extracts the ``fusion_kind_e`` enum, and confirms the
contract set documented in
``docs/architecture-optimization/sota-2028/ooo-execution.md`` Section
E.6 (``lui+addi``, ``slli+add``, ``auipc+jalr``, ``addi+bne``, ``lui+ld``)
is present. Additional pairs in the package are allowed; missing pairs are
a contract regression.

Also asserts:

  - ``FUSE_NONE`` is enumerant 0 (the sentinel).
  - ``FUSE_TABLE_LEN`` matches the number of fusable enumerants (excluding
    FUSE_NONE).
  - The opcode/funct3 helper localparams referenced by
    ``static_lookup`` are declared (gives early failure if the package is
    re-shaped without updating the lookup).
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
FUSION_PKG = ROOT / "rtl/cpu/fusion/fusion_pkg.sv"

REQUIRED_CONTRACT_PAIRS = (
    "FUSE_LUI_ADDI",
    "FUSE_SLLI_ADD",
    "FUSE_AUIPC_JALR",
    "FUSE_ADDI_BNE",
    "FUSE_LUI_LD",
)

REQUIRED_OPCODES = (
    "OP_LUI",
    "OP_AUIPC",
    "OP_OP_IMM",
    "OP_OP",
    "OP_LOAD",
    "OP_STORE",
    "OP_BRANCH",
    "OP_JAL",
    "OP_JALR",
)


def parse_enum() -> list[tuple[str, int]]:
    if not FUSION_PKG.is_file():
        raise SystemExit(f"missing {FUSION_PKG.relative_to(ROOT)}")
    text = FUSION_PKG.read_text(encoding="utf-8")
    match = re.search(
        r"typedef\s+enum\s+logic\s*\[[^\]]+\]\s*\{([^}]+)\}\s*fusion_kind_e", text, re.S
    )
    if not match:
        raise SystemExit("could not find fusion_kind_e enum in fusion_pkg.sv")
    body = match.group(1)
    entries: list[tuple[str, int]] = []
    for line in body.splitlines():
        line = line.strip()
        if not line or line.startswith("//"):
            continue
        m = re.match(r"(FUSE_[A-Z0-9_]+)\s*=\s*5'd(\d+)", line)
        if m:
            entries.append((m.group(1), int(m.group(2))))
    return entries


def parse_table_len(text: str) -> int | None:
    match = re.search(r"FUSE_TABLE_LEN\s*=\s*(\d+)", text)
    return int(match.group(1)) if match else None


def parse_opcodes(text: str) -> set[str]:
    return set(re.findall(r"localparam\s+logic\s*\[6:0\]\s*(OP_[A-Z0-9_]+)", text))


def main(argv: list[str] | None = None) -> int:
    entries = parse_enum()
    names = [name for name, _ in entries]
    values = {name: val for name, val in entries}

    text = FUSION_PKG.read_text(encoding="utf-8")
    errors: list[str] = []

    missing = [name for name in REQUIRED_CONTRACT_PAIRS if name not in names]
    if missing:
        errors.append(f"fusion.required_pairs missing: {missing}")

    if values.get("FUSE_NONE") != 0:
        errors.append("FUSE_NONE must be enumerant 0 (sentinel contract)")

    # Duplicate id check.
    seen: dict[int, str] = {}
    for name, val in entries:
        if val in seen:
            errors.append(f"duplicate id {val} on {name} (also {seen[val]})")
        seen[val] = name

    table_len = parse_table_len(text)
    if table_len is None:
        errors.append("FUSE_TABLE_LEN localparam not found")
    else:
        # The contract is that FUSE_TABLE_LEN = number of fusable pairs
        # (excludes FUSE_NONE).
        expected_table_len = len([n for n in names if n != "FUSE_NONE"])
        if table_len != expected_table_len:
            errors.append(
                f"FUSE_TABLE_LEN={table_len} but enum has {expected_table_len} fusable entries"
            )

    opcodes = parse_opcodes(text)
    missing_ops = [op for op in REQUIRED_OPCODES if op not in opcodes]
    if missing_ops:
        errors.append(f"fusion.required_opcodes missing: {missing_ops}")

    if errors:
        print("STATUS: FAIL cpu.fusion_table")
        for err in errors:
            print(f"  - {err}")
        return 1

    print(
        f"STATUS: PASS cpu.fusion_table - {len(names)} fusion kinds present, "
        f"FUSE_TABLE_LEN={table_len}"
    )
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main(sys.argv[1:]))
