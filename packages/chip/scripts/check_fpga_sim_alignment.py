#!/usr/bin/env python3
"""Correlate FPGA build/run evidence with QEMU/Renode software-reference sims.

The FPGA lane (board/fpga, scripts/check_fpga_target.py, check_fpga_release.py)
and the QEMU/Renode software-reference sims (scripts/run_qemu.sh,
scripts/run_renode.sh) are both real but have never been cross-referenced. This
gate emits ``eliza.fpga_sim_alignment.v1`` correlating the two evidence streams:

* FPGA side: the target contract names ``rtl_top`` and the synth/timing reports
  exist under ``board/fpga/reports/``.
* Sim side: the QEMU smoke manifest and Renode smoke manifest each record a
  firmware image and its SHA-256.

Fail-closed contract:
* If EITHER side is absent the gate fails (you cannot claim alignment with one
  side missing).
* The QEMU and Renode sims must run the SAME firmware image (matching SHA-256);
  a mismatch means the two software references are not aligned.
* Claim boundary stays ``sim_is_software_reference_only_not_fpga_or_e1_rtl``: the
  sims are software references, NOT proof that the FPGA bitstream matches the
  e1-chip ABI, and the FPGA bitstream release stays blocked until pins/timing
  evidence lands (see scripts/check_fpga_release.py).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from chip_utils import load_yaml_object

REPO_ROOT = Path(__file__).resolve().parents[1]
FPGA_CFG = REPO_ROOT / "board/fpga/e1_demo_fpga.yaml"
FPGA_REPORTS = REPO_ROOT / "board/fpga/reports"
QEMU_MANIFEST = REPO_ROOT / "build/reports/qemu_smoke.manifest"
RENODE_MANIFEST = REPO_ROOT / "build/reports/renode_smoke.manifest"
RENODE_JSON = REPO_ROOT / "build/renode/eliza_e1_smoke.json"
DEFAULT_OUT = REPO_ROOT / "build/reports/fpga_sim_alignment.json"


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


def parse_kv_manifest(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if "=" in line:
            key, _, value = line.partition("=")
            out[key.strip()] = value.strip()
    return out


def collect_fpga(errors: list[str]) -> dict[str, Any]:
    side: dict[str, Any] = {"present": False}
    if not FPGA_CFG.is_file():
        errors.append(f"FPGA target contract missing: {rel(FPGA_CFG)}")
        return side
    cfg = load_yaml_object(FPGA_CFG)
    rtl_top = cfg.get("rtl_top")
    if not isinstance(rtl_top, str) or not rtl_top:
        errors.append(f"{rel(FPGA_CFG)}: rtl_top must be a non-empty string")
        return side
    reports = sorted(p for p in FPGA_REPORTS.rglob("*") if p.is_file()) if FPGA_REPORTS.is_dir() else []
    if not reports:
        errors.append(
            f"no FPGA build reports under {rel(FPGA_REPORTS)}; "
            "run the board/fpga synth/pnr flow before claiming alignment"
        )
        return side
    side.update(
        present=True,
        rtl_top=rtl_top,
        status=cfg.get("status"),
        reports=[rel(p) for p in reports],
    )
    return side


def collect_sim(errors: list[str]) -> dict[str, Any]:
    side: dict[str, Any] = {"present": False}
    if not QEMU_MANIFEST.is_file():
        errors.append(
            f"QEMU smoke manifest missing: {rel(QEMU_MANIFEST)}; run scripts/run_qemu.sh --check"
        )
    if not RENODE_MANIFEST.is_file():
        errors.append(
            f"Renode smoke manifest missing: {rel(RENODE_MANIFEST)}; run scripts/run_renode.sh --check"
        )
    if not QEMU_MANIFEST.is_file() or not RENODE_MANIFEST.is_file():
        return side

    qemu = parse_kv_manifest(QEMU_MANIFEST)
    renode = parse_kv_manifest(RENODE_MANIFEST)
    qemu_fw = qemu.get("firmware_sha256")
    renode_fw = renode.get("firmware_sha256")

    if not qemu_fw or qemu_fw == "missing":
        errors.append(f"{rel(QEMU_MANIFEST)}: firmware_sha256 missing")
    if not renode_fw or renode_fw == "missing":
        errors.append(f"{rel(RENODE_MANIFEST)}: firmware_sha256 missing")
    if qemu_fw and renode_fw and qemu_fw not in ("missing",) and qemu_fw != renode_fw:
        errors.append(
            f"QEMU firmware sha256 {qemu_fw} != Renode firmware sha256 {renode_fw}; "
            "the software references run different firmware"
        )

    side.update(
        present=not errors,
        qemu_status=qemu.get("status"),
        qemu_firmware=qemu.get("firmware"),
        qemu_firmware_sha256=qemu_fw,
        renode_status=renode.get("status"),
        renode_firmware=renode.get("firmware"),
        renode_firmware_sha256=renode_fw,
        renode_json=rel(RENODE_JSON) if RENODE_JSON.is_file() else None,
    )
    return side


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args(argv)

    errors: list[str] = []
    fpga = collect_fpga(errors)
    sim = collect_sim(errors)

    aligned = bool(fpga.get("present")) and bool(sim.get("present")) and not errors
    report = {
        "schema": "eliza.fpga_sim_alignment.v1",
        "claim_boundary": "sim_is_software_reference_only_not_fpga_or_e1_rtl",
        "fpga": fpga,
        "sim": sim,
        "aligned": aligned,
        "errors": errors,
        "status": "passed" if aligned else "failed",
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    if not aligned:
        for error in errors:
            print(f"FAIL: {error}")
        print(f"alignment report written: {rel(args.out)}")
        return 1
    print(
        f"PASS: fpga/sim alignment ({fpga['rtl_top']} target, shared firmware "
        f"{sim['qemu_firmware_sha256'][:12]}); {rel(args.out)}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
