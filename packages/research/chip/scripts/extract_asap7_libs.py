#!/usr/bin/env python3
"""Extract the ASAP7 7p5t Liberty files for one (library, Vt, corner) tuple.

The ASAP7 stdcell distribution ships every Liberty file as a `.lib.7z`. This
helper decompresses the requested set into a build directory so the yosys+ABC
flow can consume them. Already-extracted files are skipped (idempotent).

Usage:
    extract_asap7_libs.py --asap7-root <path> --out-dir <path> \
        --library asap7sc7p5t_27 --vt RVT --corner TT

The five canonical groups for the 7p5t library (INVBUF, SIMPLE, AO, OA, SEQ)
are extracted together. Other Vt/corner combinations are supported with the
same naming convention.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

try:
    import py7zr
except ImportError as exc:
    raise SystemExit(
        "BLOCKED: py7zr is required for ASAP7 lib extraction; "
        "install with `pip install --break-system-packages py7zr`"
    ) from exc

GROUPS = ("AO", "INVBUF", "OA", "SEQ", "SIMPLE")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--asap7-root", required=True, type=Path)
    p.add_argument("--out-dir", required=True, type=Path)
    p.add_argument("--library", default="asap7sc7p5t_27")
    p.add_argument("--vt", default="RVT", choices=("LVT", "RVT", "SLVT", "SRAM"))
    p.add_argument("--corner", default="TT", choices=("FF", "TT", "SS"))
    return p.parse_args()


def main() -> int:
    args = parse_args()
    nldm_dir = args.asap7_root / args.library / "LIB" / "NLDM"
    if not nldm_dir.is_dir():
        # Some library names (e.g. asap7sc6t_26) live one level up.
        alt = args.asap7_root / args.library.replace("_27", "") / "LIB" / "NLDM"
        if alt.is_dir():
            nldm_dir = alt
        else:
            print(f"BLOCKED: ASAP7 NLDM dir missing: {nldm_dir}", file=sys.stderr)
            return 1

    args.out_dir.mkdir(parents=True, exist_ok=True)
    extracted: list[str] = []
    for group in GROUPS:
        # ASAP7 file naming: `<library>_<group>_<Vt>_<corner>_nldm_<date>.lib.7z`
        pattern = f"{args.library.split('_')[0]}_{group}_{args.vt}_{args.corner}_nldm_*.lib.7z"
        matches = sorted(nldm_dir.glob(pattern))
        if not matches:
            print(f"BLOCKED: no {pattern} under {nldm_dir}", file=sys.stderr)
            return 1
        for archive in matches:
            expected_lib = args.out_dir / archive.name.removesuffix(".7z")
            if expected_lib.is_file() and expected_lib.stat().st_size > 0:
                continue
            with py7zr.SevenZipFile(archive, mode="r") as z:
                z.extractall(args.out_dir)
            extracted.append(expected_lib.name)
    if extracted:
        print(f"extracted {len(extracted)} ASAP7 libs into {args.out_dir}")
    else:
        print(f"ASAP7 libs already present in {args.out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
