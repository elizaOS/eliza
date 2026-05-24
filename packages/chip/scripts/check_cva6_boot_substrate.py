#!/usr/bin/env python3
"""Gate: CVA6 CPU-execution substrate for booting Linux on the E1 RTL SoC.

PASS only if BOTH hold, with executable evidence:

  1. The OpenHW CVA6 v5.3.0 core RTL ELABORATES clean under Verilator inside
     `e1_cva6_dram_boot_top` (NoC->AXI4 adapter RTL, 64->128 width converter
     RTL, e1_axi4_interconnect fabric RTL, e1_dram_ctrl DRAM-controller RTL
     model, e1_clint RTL, e1_rot_reset_seq gate).

  2. A bare-metal RV64 M-mode firmware image PROVABLY EXECUTES from the
     DRAM-controller RTL model through the RTL datapath: the cocotb sim asserts
     the CPU fetched + wrote through the RTL DRAM path, programmed the CLINT,
     took the machine timer trap, and emitted the "E1BOOT-OK" marker.

Both are produced by running the cocotb test `test_cva6_dram_boot.py`, which
elaborates the full stack (proving #1) and asserts the execution proof (#2).
The firmware is rebuilt from source first.

Writes build/reports/cva6_boot_substrate.json (schema eliza.gate_status.v1).
Fail-closed: any missing toolchain, elaboration failure, or assertion failure
yields BLOCKED/FAIL with the blocker recorded.
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import shutil
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FW_DIR = ROOT / "fw/bare-metal/e1-cva6-dram-boot"
FW_HEX = FW_DIR / "build/boot.hex128"
COCOTB_DIR = ROOT / "verify/cocotb/integration"
MAKEFILE = COCOTB_DIR / "Makefile.cva6-dram-boot"
SIM_BUILD = COCOTB_DIR / "sim_build_cva6_dram_boot"
RESULTS_XML = COCOTB_DIR / "results.xml"
REPORT = ROOT / "build/reports/cva6_boot_substrate.json"
GATE = "cva6_boot_substrate"
SUBSYSTEM = "cpu_ap"


def _now() -> str:
    return _dt.datetime.now(_dt.UTC).isoformat()


def _write(
    status: str,
    blocker_id: str | None,
    reason: str | None,
    evidence: list[str],
    extra: dict | None = None,
) -> None:
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    payload: dict[str, object] = {
        "schema": "eliza.gate_status.v1",
        "gate": GATE,
        "status": status,
        "blocker_id": blocker_id,
        "blocker_reason": reason,
        "evidence_paths": evidence,
        "as_of": _now(),
        "subsystem": SUBSYSTEM,
    }
    if extra:
        payload["detail"] = extra
    REPORT.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def _tool_on_path(name: str) -> bool:
    return shutil.which(name) is not None


def _run(cmd: list[str], cwd: Path, env: dict, log: Path, timeout: int) -> tuple[int, str]:
    with log.open("w", encoding="utf-8") as fh:
        proc = subprocess.run(
            cmd, cwd=str(cwd), env=env, stdout=fh, stderr=subprocess.STDOUT, timeout=timeout
        )
    return proc.returncode, log.read_text(encoding="utf-8", errors="replace")


def _build_firmware(env: dict) -> tuple[bool, str]:
    log = ROOT / "build/reports/cva6_boot_substrate.fw.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    try:
        rc, _ = _run(["make", "clean"], FW_DIR, env, log, timeout=120)
        rc, out = _run(["make"], FW_DIR, env, log, timeout=300)
    except subprocess.TimeoutExpired:
        return False, "firmware build timed out"
    if rc != 0 or not FW_HEX.exists():
        return False, f"firmware build failed (rc={rc}); see {log}"
    return True, ""


def _parse_results() -> tuple[bool, str]:
    if not RESULTS_XML.exists():
        return False, "cocotb results.xml not produced (sim did not run)"
    try:
        tree = ET.parse(RESULTS_XML)
    except ET.ParseError as exc:
        return False, f"results.xml parse error: {exc}"
    cases = tree.iterfind(".//testcase")
    seen = 0
    for case in cases:
        seen += 1
        failure = case.find("failure")
        error = case.find("error")
        skipped = case.find("skipped")
        if skipped is not None:
            return False, f"test skipped: {case.get('name')}"
        if failure is not None or error is not None:
            node = failure if failure is not None else error
            assert node is not None  # narrowed by the guard above
            msg = (node.get("message") or node.text or "assertion failed").strip()
            return False, f"{case.get('name')}: {msg[:400]}"
    if seen == 0:
        return False, "no cocotb testcases ran"
    return True, ""


def main() -> int:
    env = dict(os.environ)
    env.setdefault("CVA6_VERILATOR_FULL_OK", "1")

    evidence = [
        "rtl/top/e1_cva6_dram_boot_top.sv",
        "fw/bare-metal/e1-cva6-dram-boot/boot.S",
        "verify/cocotb/integration/test_cva6_dram_boot.py",
    ]

    # Toolchain gate (fail-closed): native Verilator + RISC-V gcc required.
    for tool in ("verilator", "riscv64-unknown-elf-gcc"):
        if not _tool_on_path(tool):
            _write(
                "BLOCKED",
                "toolchain-missing",
                f"{tool} not on PATH — run `source tools/env.sh` first",
                evidence,
            )
            print(f"BLOCKED: {tool} not on PATH (source tools/env.sh)")
            return 1

    ok, reason = _build_firmware(env)
    if not ok:
        _write("BLOCKED", "firmware-build", reason, evidence)
        print(f"BLOCKED: {reason}")
        return 1

    # Run the cocotb sim: this elaborates the full CVA6 stack (proving the
    # elaboration leg) and asserts the execution proof.
    if SIM_BUILD.exists():
        shutil.rmtree(SIM_BUILD, ignore_errors=True)
    if RESULTS_XML.exists():
        RESULTS_XML.unlink()
    sim_log = ROOT / "build/reports/cva6_boot_substrate.sim.log"
    cmd = [
        "make",
        "-f",
        str(MAKEFILE),
        "SIM_BUILD=sim_build_cva6_dram_boot",
        "MODULE=test_cva6_dram_boot",
        f"PLUSARGS=+E1_DRAM_PRELOAD_HEX={FW_HEX}",
    ]
    try:
        rc, out = _run(cmd, COCOTB_DIR, env, sim_log, timeout=1800)
    except subprocess.TimeoutExpired:
        _write(
            "BLOCKED",
            "sim-timeout",
            "cocotb sim exceeded 1800s (elaboration or run hang)",
            evidence,
        )
        print("BLOCKED: cocotb sim timed out")
        return 1

    # Distinguish an elaboration failure from a runtime assertion failure.
    if rc != 0 and not RESULTS_XML.exists():
        tail = "\n".join(out.splitlines()[-25:])
        _write(
            "FAIL",
            "elaboration-or-build",
            f"Verilator build/elaboration of e1_cva6_dram_boot_top failed; see {sim_log}",
            evidence,
            extra={"log_tail": tail},
        )
        print(f"FAIL: elaboration/build failed; see {sim_log}")
        return 1

    passed, reason = _parse_results()
    if not passed:
        _write(
            "FAIL",
            "execution-proof",
            f"CVA6 execution proof failed: {reason}",
            evidence,
            extra={"sim_log": str(sim_log.relative_to(ROOT))},
        )
        print(f"FAIL: {reason}")
        return 1

    _write(
        "PASS",
        None,
        None,
        evidence
        + [
            "verify/cocotb/integration/Makefile.cva6-dram-boot",
            "build/reports/cva6_boot_substrate.sim.log",
        ],
        extra={
            "proof": "CVA6 elaborated + bare-metal image executed through the RTL "
            "DRAM path (markers + timer trap asserted)",
        },
    )
    print(
        "PASS: CVA6 elaborated and the bare-metal image provably executed "
        "through the RTL DRAM path (DRAM markers + CLINT timer trap asserted)."
    )
    _write(
        "PASS",
        None,
        None,
        evidence
        + [
            "verify/cocotb/integration/Makefile.cva6-dram-boot",
            "build/reports/cva6_boot_substrate.sim.log",
        ],
        extra={
            "proof": "CVA6 elaborated + bare-metal image executed from real DRAM "
            "(markers + timer trap asserted)",
        },
    )
    print(
        "PASS: CVA6 elaborated and the bare-metal image provably executed "
        "from the real DRAM controller (DRAM markers + CLINT timer trap "
        "asserted)."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
