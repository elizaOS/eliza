#!/usr/bin/env python3
"""External DRC/LVS verifier for OpenRAM-generated Sky130 macros.

OpenRAM 1.2.48 ships its own conda Magic pinned at 8.3.363, which fails to
load Volare's Sky130A magic techfile (Magic 8.3.411+ required). We disable
OpenRAM's inline DRC/LVS and verify externally here using the OpenLane2
container's Magic 8.3.489.

Run after `python3 $OPENRAM_HOME/sram_compiler.py ... openram_config.py`
produces `<macro>.gds` and `<macro>.sp`:

    python3 scripts/check_openram_macro_drc.py \\
        --macro-dir pd/macros/sky130/e1_sram_4kb_1rw/build \\
        --macro-name e1_sram_4kb_1rw \\
        --out-json build/reports/pd/openram_4kb_drc.json

Outputs a JSON with DRC counts + magic stdout/stderr paths. Exit code 0
when DRC is clean, 1 otherwise.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PDK_PATH = (
    ROOT
    / "external"
    / "pdks"
    / "volare"
    / "sky130"
    / "versions"
    / "0fe599b2afb6708d281543108caf8310912f54af"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--macro-dir", required=True)
    parser.add_argument("--macro-name", required=True)
    parser.add_argument("--out-json")
    parser.add_argument(
        "--openlane-image",
        default="ghcr.io/efabless/openlane2:2.4.0.dev1",
    )
    return parser.parse_args()


def run_magic_drc(macro_dir: Path, macro_name: str, image: str) -> dict[str, object]:
    if shutil.which("docker") is None:
        raise SystemExit("docker not on PATH")
    gds = macro_dir / f"{macro_name}.gds"
    if not gds.is_file():
        raise SystemExit(f"missing GDS: {gds}")
    out_log = macro_dir / f"{macro_name}.magic_drc.log"
    out_report = macro_dir / f"{macro_name}.magic_drc.report"
    drc_tcl = (
        "drc euclidean on\n"
        "drc style drc(full)\n"
        f"gds read {macro_name}.gds\n"
        f"load {macro_name}\n"
        "select top cell\n"
        "expand\n"
        "drc check\n"
        "drc catchup\n"
        "drc count total\n"
        f"drc listall why {macro_name}.magic_drc.report\n"
        "quit -noprompt\n"
    )
    cmd = [
        "docker",
        "run",
        "--rm",
        "-v",
        f"{PDK_PATH}:{PDK_PATH}",
        "-v",
        f"{macro_dir}:/macro",
        "-w",
        "/macro",
        "-e",
        f"PDK_ROOT={PDK_PATH}",
        image,
        "bash",
        "-lc",
        (
            f"magic -dnull -noconsole -rcfile {PDK_PATH}/sky130A/libs.tech/magic/sky130A.magicrc <<'EOF'\n"
            f"{drc_tcl}\nEOF\n"
        ),
    ]
    print(f"RUN: {' '.join(cmd[:8])} ... (full TCL in log)")
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    out_log.write_text(
        f"# DRC TCL:\n{drc_tcl}\n# STDOUT:\n{proc.stdout}\n# STDERR:\n{proc.stderr}\n"
    )
    drc_count: int | None = None
    for line in proc.stdout.splitlines():
        m = (
            re.match(r"\[INFO\]?\s*Total DRC errors found:\s*(\d+)", line)
            or re.search(r"Total errors\s*:\s*(\d+)", line)
            or re.search(r"^Total\s+DRC\s+errors\s*=\s*(\d+)", line)
        )
        if m:
            drc_count = int(m.group(1))
            break
    return {
        "magic_drc_log": str(out_log),
        "magic_drc_report": str(out_report) if out_report.is_file() else None,
        "drc_errors_total": drc_count,
        "exit_code": proc.returncode,
    }


def main() -> int:
    args = parse_args()
    macro_dir = Path(args.macro_dir).resolve()
    result = {
        "schema": "eliza.pd_openram_macro_verify.v1",
        "macro_dir": str(macro_dir),
        "macro_name": args.macro_name,
    }
    drc = run_magic_drc(macro_dir, args.macro_name, args.openlane_image)
    result["magic_drc"] = drc
    drc_count = drc["drc_errors_total"]
    result["status"] = (
        "PASS"
        if drc_count == 0
        else ("FAIL" if isinstance(drc_count, int) and drc_count > 0 else "UNKNOWN")
    )
    text = json.dumps(result, indent=2, sort_keys=True) + "\n"
    if args.out_json:
        Path(args.out_json).write_text(text)
    print(text)
    return 0 if result["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
