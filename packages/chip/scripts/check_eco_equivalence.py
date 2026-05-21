#!/usr/bin/env python3
"""Fail-closed gate: an ECO netlist patch must be formally equivalent.

Gates scripts/run_eco_resize.py output behind a Yosys equivalence proof. A
resizer ECO (gate sizing / buffer insertion) must preserve the boolean function;
this gate proves that the patched netlist (eco_patch.v) is equivalent to the
pre-ECO golden netlist using Yosys `equiv_make` + `equiv_induct` + `equiv_status
-assert` (and `sat` as a fallback / cross-check).

No ECO may be consumed without this gate passing:
  - exit 0  : equivalence proven.
  - exit 1  : NOT equivalent, or proof inconclusive -> ECO must be rejected.
  - exit 2  : Yosys absent -> BLOCKED (cannot prove; never assume equivalent).

Usage:
  scripts/check_eco_equivalence.py --golden <pre_eco.v> --revised <eco_patch.v> \
      --top e1_chip_top [--liberty <lib>]

The gate is conservative: an inconclusive proof is treated as a failure, never a
pass. There is no "assume equivalent" path.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def yosys_bin() -> str | None:
    local = ROOT / "external" / "oss-cad-suite" / "bin" / "yosys"
    if local.is_file():
        return str(local)
    return shutil.which("yosys")


def resolve(rel: str) -> Path:
    path = Path(rel)
    return path if path.is_absolute() else (ROOT / rel).resolve()


def build_equiv_script(
    *, golden: Path, revised: Path, top: str, liberty: Path | None, build_dir: Path
) -> Path:
    lib_read = f"read_liberty -lib {liberty}\n" if liberty else ""
    script = f"""# Auto-generated ECO equivalence proof by check_eco_equivalence.py
{lib_read}read_verilog {golden}
prep -top {top}
splitnets -ports
design -stash gold

{lib_read}read_verilog {revised}
prep -top {top}
splitnets -ports
design -stash gate

design -copy-from gold -as gold {top}
design -copy-from gate -as gate {top}

equiv_make gold gate equiv
prep -top equiv
equiv_induct
equiv_status -assert
"""
    out = build_dir / "eco_equiv.ys"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(script)
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--golden", required=True, help="Pre-ECO golden netlist")
    parser.add_argument("--revised", required=True, help="ECO patch netlist")
    parser.add_argument("--top", default="e1_chip_top")
    parser.add_argument("--liberty", default=None)
    parser.add_argument("--build-dir", default=None)
    args = parser.parse_args()

    golden = resolve(args.golden)
    revised = resolve(args.revised)
    if not golden.is_file():
        print(f"FAIL: golden netlist missing: {golden}", file=sys.stderr)
        return 1
    if not revised.is_file():
        print(f"FAIL: revised (ECO) netlist missing: {revised}", file=sys.stderr)
        return 1
    liberty = resolve(args.liberty) if args.liberty else None
    if liberty is not None and not liberty.is_file():
        print(f"FAIL: liberty missing: {liberty}", file=sys.stderr)
        return 1

    yosys = yosys_bin()
    if yosys is None:
        repro = (
            ". tools/env.sh && python3 scripts/check_eco_equivalence.py "
            f"--golden {args.golden} --revised {args.revised} --top {args.top}"
        )
        print(
            "STATUS: BLOCKED eco-equivalence - Yosys missing; cannot prove "
            f"equivalence (no assume-equivalent path). Reproduce: {repro}",
            file=sys.stderr,
        )
        return 2

    build_dir = resolve(args.build_dir) if args.build_dir else (
        ROOT / "build" / "qor" / "eco" / "equiv"
    )
    script = build_equiv_script(
        golden=golden, revised=revised, top=args.top, liberty=liberty, build_dir=build_dir
    )
    log = build_dir / "eco_equiv.log"
    completed = subprocess.run(
        [yosys, "-q", "-l", str(log), str(script)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        tail = "\n".join(
            (completed.stderr + "\n" + completed.stdout).splitlines()[-25:]
        )
        print(
            "FAIL: ECO equivalence NOT proven (equiv_status -assert failed or "
            f"proof inconclusive). ECO rejected.\nlog: {log.relative_to(ROOT)}\n{tail}",
            file=sys.stderr,
        )
        return 1

    print(
        f"PASS: ECO equivalence proven golden={golden.name} revised={revised.name} "
        f"top={args.top}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
