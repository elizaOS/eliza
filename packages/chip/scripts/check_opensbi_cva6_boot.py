#!/usr/bin/env python3
"""Gate: real OpenSBI boots on the real CVA6 from real DRAM, in Verilator.

PASS only with executable evidence that ALL of the following hold:

  1. The OpenSBI boot image builds from source — the REAL repo OpenSBI v1.8.1
     fw_jump (FW_TEXT_START=0x80000000, next-stage S-mode), a compiled
     device-tree blob, the S-mode payload, and the entry shim — assembled into
     one dense DRAM preload image (fw/opensbi-cva6-boot/build_boot_image.py).

  2. The CVA6-from-DRAM boot top (with the ns16550a UART @0x10001000 and the
     AXI4 atomics adapter wired onto the fabric) ELABORATES clean under
     Verilator.

  3. Running the cocotb sim, the REAL CVA6 fetches + executes the REAL OpenSBI
     from the REAL DRAM controller and OpenSBI prints its banner over the
     ns16550a UART (the milestone for this proof).

The cocotb test (`test_opensbi_cva6_boot.py`) asserts the banner and writes the
UART transcript to docs/evidence/cpu_ap/.  The M->S handoff and the long Linux
kernel run are the documented next steps (see the gate JSON detail and the test
docstring): CVA6's wt_axi_adapter has an internal write-ID-FIFO assertion that
assumes fully-serialized atomics, which the external (non-coherent) atomics
adapter does not guarantee once OpenSBI's post-banner printing interleaves
stores with lr/sc.

Writes build/reports/opensbi_cva6_boot.json (schema eliza.gate_status.v1).
Fail-closed: any missing toolchain, build/elaboration failure, or a missing
banner yields BLOCKED/FAIL with the blocker recorded.
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUILDER = ROOT / "fw/opensbi-cva6-boot/build_boot_image.py"
BOOT_HEX = ROOT / "fw/opensbi-cva6-boot/build/boot.hex128"
COCOTB_DIR = ROOT / "verify/cocotb/integration"
MAKEFILE = COCOTB_DIR / "Makefile.opensbi-cva6-boot"
SIM_BUILD = COCOTB_DIR / "sim_build_opensbi_cva6_boot"
RESULTS_XML = COCOTB_DIR / "results.xml"
TRANSCRIPT = ROOT / "docs/evidence/cpu_ap/opensbi_cva6_boot.transcript"
REPORT = ROOT / "build/reports/opensbi_cva6_boot.json"
GATE = "opensbi_cva6_boot"
SUBSYSTEM = "cpu_ap"

LINUX_GNU = ROOT / "external/riscv64-linux-gnu"


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat()


def _write(status: str, blocker_id: str | None, reason: str | None,
           evidence: list[str], extra: dict | None = None) -> None:
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


def _tool_on_path(name: str, path: str | None = None) -> bool:
    return shutil.which(name, path=path) is not None


def _run(cmd: list[str], cwd: Path, env: dict, log: Path,
         timeout: int) -> tuple[int, str]:
    with log.open("w", encoding="utf-8") as fh:
        proc = subprocess.run(cmd, cwd=str(cwd), env=env, stdout=fh,
                              stderr=subprocess.STDOUT, timeout=timeout)
    return proc.returncode, log.read_text(encoding="utf-8", errors="replace")


def _parse_results() -> tuple[bool, str]:
    if not RESULTS_XML.exists():
        return False, "cocotb results.xml not produced (sim did not run)"
    try:
        tree = ET.parse(RESULTS_XML)
    except ET.ParseError as exc:
        return False, f"results.xml parse error: {exc}"
    seen = 0
    for case in tree.iterfind(".//testcase"):
        seen += 1
        skipped = case.find("skipped")
        if skipped is not None:
            return False, f"test skipped: {case.get('name')}"
        failure = case.find("failure")
        error = case.find("error")
        if failure is not None or error is not None:
            node = failure if failure is not None else error
            if node is None:
                continue
            msg = (node.get("message") or node.text or "assertion failed").strip()
            return False, f"{case.get('name')}: {msg[:600]}"
    if seen == 0:
        return False, "no cocotb testcases ran"
    return True, ""


def main() -> int:
    env = dict(os.environ)
    env.setdefault("CVA6_VERILATOR_FULL_OK", "1")

    evidence = [
        "rtl/top/e1_cva6_dram_boot_top.sv",
        "rtl/peripherals/e1_uart_ns16550.sv",
        "fw/opensbi-cva6-boot/build_boot_image.py",
        "fw/opensbi-cva6-boot/e1-cva6-boot.dts",
        "fw/opensbi-cva6-boot/shim.S",
        "fw/opensbi-payloads/e1-smode/e1.c",
        "verify/cocotb/integration/test_opensbi_cva6_boot.py",
        "sw/opensbi/platform/eliza/platform.c",
    ]

    # Toolchain gate (fail-closed).
    for tool in ("verilator", "riscv64-unknown-elf-gcc", "dtc"):
        if not _tool_on_path(tool):
            _write("BLOCKED", "toolchain-missing",
                   f"{tool} not on PATH — run `source tools/env.sh` first",
                   evidence)
            print(f"BLOCKED: {tool} not on PATH (source tools/env.sh)")
            return 1
    # OpenSBI needs the PIE-capable Linux GNU cross.
    gnu_bin = LINUX_GNU / "usr/bin"
    if not (gnu_bin / "riscv64-linux-gnu-gcc").exists():
        _write("BLOCKED", "toolchain-missing",
               "riscv64-linux-gnu-gcc not found under external/riscv64-linux-gnu "
               "(OpenSBI requires a PIE-capable linker)", evidence)
        print("BLOCKED: riscv64-linux-gnu-gcc missing")
        return 1

    # 1) Build the OpenSBI boot image from source.
    build_log = ROOT / "build/reports/opensbi_cva6_boot.image.log"
    build_log.parent.mkdir(parents=True, exist_ok=True)
    try:
        rc, out = _run(["python3", str(BUILDER)], ROOT, env, build_log,
                       timeout=900)
    except subprocess.TimeoutExpired:
        _write("BLOCKED", "image-build-timeout",
               "OpenSBI boot image build exceeded 900s", evidence)
        print("BLOCKED: boot image build timed out")
        return 1
    if rc != 0 or not BOOT_HEX.exists():
        tail = "\n".join(out.splitlines()[-25:])
        _write("BLOCKED", "image-build",
               f"OpenSBI boot image build failed (rc={rc}); see {build_log}",
               evidence, extra={"log_tail": tail})
        print(f"BLOCKED: boot image build failed; see {build_log}")
        return 1

    # 2+3) Elaborate + run the cocotb sim.
    if SIM_BUILD.exists():
        shutil.rmtree(SIM_BUILD, ignore_errors=True)
    if RESULTS_XML.exists():
        RESULTS_XML.unlink()
    sim_log = ROOT / "build/reports/opensbi_cva6_boot.sim.log"
    cmd = [
        "make", "-f", str(MAKEFILE),
        "SIM_BUILD=sim_build_opensbi_cva6_boot",
        "MODULE=test_opensbi_cva6_boot",
        f"PLUSARGS=+E1_DRAM_PRELOAD_HEX={BOOT_HEX}",
    ]
    try:
        rc, out = _run(cmd, COCOTB_DIR, env, sim_log, timeout=5400)
    except subprocess.TimeoutExpired:
        _write("BLOCKED", "sim-timeout",
               "cocotb sim exceeded 5400s (elaboration or run hang)", evidence)
        print("BLOCKED: cocotb sim timed out")
        return 1

    if rc != 0 and not RESULTS_XML.exists():
        tail = "\n".join(out.splitlines()[-25:])
        _write("FAIL", "elaboration-or-build",
               f"Verilator build/elaboration of e1_cva6_dram_boot_top failed; "
               f"see {sim_log}", evidence, extra={"log_tail": tail})
        print(f"FAIL: elaboration/build failed; see {sim_log}")
        return 1

    passed, reason = _parse_results()
    extra = {"sim_log": str(sim_log.relative_to(ROOT))}
    if TRANSCRIPT.exists():
        extra["transcript"] = str(TRANSCRIPT.relative_to(ROOT))
        extra["transcript_excerpt"] = TRANSCRIPT.read_text(
            encoding="utf-8", errors="replace")[:1200]
    if not passed:
        _write("FAIL", "boot-proof",
               f"OpenSBI-on-CVA6 boot proof failed: {reason}", evidence, extra)
        print(f"FAIL: {reason}")
        return 1

    _write("PASS", None, None, evidence + [
        "verify/cocotb/integration/Makefile.opensbi-cva6-boot",
        "docs/evidence/cpu_ap/opensbi_cva6_boot.transcript",
        "build/reports/opensbi_cva6_boot.sim.log",
    ], extra={**extra,
              "proof": "real OpenSBI v1.8.1 booted in M-mode on the real CVA6 "
                       "from the real DRAM controller (through the real fabric, "
                       "real CLINT/PLIC + RoT gate) and printed its banner over "
                       "the ns16550a UART.",
              "next_step": "M->S handoff to S-mode + Linux kernel boot: blocked "
                           "on CVA6 wt_axi_adapter's serialized-atomics write-ID "
                           "FIFO assertion under the external atomics adapter "
                           "(fires shortly after the banner); the standard fix "
                           "is the vendored pulp axi_riscv_atomics filter, plus "
                           "an Image+initramfs payload and a multi-hour run."})
    print("PASS: real OpenSBI v1.8.1 booted on the real CVA6 from real DRAM "
          "and printed its banner over the ns16550a UART.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
