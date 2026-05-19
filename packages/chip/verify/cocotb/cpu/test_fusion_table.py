"""Host-side sanity check on rtl/cpu/fusion/fusion_pkg.sv.

Parses the package, extracts the `fusion_kind_e` enum, and confirms the
contract set documented in
``docs/architecture-optimization/sota-2028/ooo-execution.md`` Section
E.6 (`lui+addi`, `slli+add`, `auipc+jalr`, `addi+bne`, `lui+ld`) is
present. Additional pairs in the package are allowed; missing pairs are a
contract regression.
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


def parse_enum() -> list[str]:
    if not FUSION_PKG.is_file():
        raise SystemExit(f"missing {FUSION_PKG.relative_to(ROOT)}")
    text = FUSION_PKG.read_text(encoding="utf-8")
    match = re.search(
        r"typedef\s+enum\s+logic\s*\[[^\]]+\]\s*\{([^}]+)\}\s*fusion_kind_e", text, re.S
    )
    if not match:
        raise SystemExit("could not find fusion_kind_e enum in fusion_pkg.sv")
    body = match.group(1)
    names = []
    for line in body.splitlines():
        line = line.strip()
        if not line or line.startswith("//"):
            continue
        m = re.match(r"(FUSE_[A-Z0-9_]+)\s*=", line)
        if m:
            names.append(m.group(1))
    return names


def main(argv: list[str] | None = None) -> int:
    names = parse_enum()
    missing = [name for name in REQUIRED_CONTRACT_PAIRS if name not in names]
    if missing:
        print(f"STATUS: FAIL fusion.required_pairs missing: {missing}")
        return 1
    print(f"STATUS: PASS fusion.required_pairs - {len(names)} fusion kinds present")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main(sys.argv[1:]))
