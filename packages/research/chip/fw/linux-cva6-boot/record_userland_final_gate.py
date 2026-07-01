#!/usr/bin/env python3
"""Record the linux_boot_cva6 gate from the dedicated isolated userland run.

Reads the isolated run's transcript + results XML (produced by
run_userland_final.sh, which uses fully-disjoint SIM_BUILD / transcript /
results so it never races a concurrent boot sim) and writes the canonical gate
report build/reports/linux_boot_cva6.json (schema eliza.gate_status.v1).

PASS only if ELIZA-USERLAND-OK is in the transcript AND the cocotb testcase
passed.  Otherwise BLOCKED on the next marker with the exact furthest marker and
the observed cycle count — never faked.  The claim is explicitly scoped as a
FUNCTIONAL boot proof on the fast sim config, not a timing/perf/silicon claim.
"""

from __future__ import annotations

import datetime as _dt
import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TRANSCRIPT = ROOT / "docs/evidence/cpu_ap/linux_userland_cva6.transcript"
SRC_TRANSCRIPT = ROOT / "docs/evidence/cpu_ap/linux_userland_final.transcript"
RESULTS_XML = ROOT / "verify/cocotb/integration/results_userland_final.xml"
RUN_LOG = ROOT / "build/reports/linux_userland_final.run.log"
REPORT = ROOT / "build/reports/linux_boot_cva6.json"

MARKERS = [
    ("opensbi_banner", "OpenSBI v"),
    ("smode_handoff", "S-MODE-OK"),
    ("linux_early", "Linux version"),
    ("linux_booting", "Booting Linux"),
    ("linux_mmu", "Switching to"),
    ("linux_freeing_init", "Freeing unused kernel"),
    ("linux_run_init", "Run /init"),
    ("userland", "ELIZA-USERLAND-OK"),
]

HEADER = (
    "# E1 CVA6 Linux-to-userland boot — FAST FUNCTIONAL CONFIG (dedicated run)\n"
    "# CLAIM BOUNDARY: functional boot proof, NOT a timing/perf/silicon claim.\n"
    "# Sim-only levers: +E1_DRAM_FAST zero-wait DRAM model, 32 MiB advertised\n"
    "#   RAM, Verilator -O2/threaded/x-fast, lpj=10000.\n"
    "# Harder-trimmed kernel: VT/crypto/sysfs/PTY/decompressors/PM/tracing off,\n"
    "#   initcall_debug on so do_initcalls() is fully observable.\n"
    "# Proves: real CVA6 RTL + OpenSBI v1.8.1 + real Linux 6.12.90 + real\n"
    "#   freestanding /init reach userland (ELIZA-USERLAND-OK).\n"
    "# ---------------------------------------------------------------\n"
)


def _now() -> str:
    return _dt.datetime.now(_dt.UTC).isoformat()


def _furthest(text: str) -> str:
    reached = "none"
    for name, token in MARKERS:
        if token in text:
            reached = name
    return reached


def _next_marker(furthest: str) -> str:
    for i, (name, _t) in enumerate(MARKERS):
        if name == furthest and i + 1 < len(MARKERS):
            return MARKERS[i + 1][0]
    return "none"


def _results_passed() -> tuple[bool, str]:
    if not RESULTS_XML.exists():
        return False, "results_userland_final.xml not produced (sim did not finish)"
    tree = ET.parse(RESULTS_XML)
    seen = 0
    for case in tree.iterfind(".//testcase"):
        seen += 1
        if case.find("failure") is not None or case.find("error") is not None:
            node = case.find("failure") or case.find("error")
            msg = (node.get("message") or node.text or "fail").strip()
            return False, f"{case.get('name')}: {msg[:400]}"
    if seen == 0:
        return False, "no cocotb testcases ran"
    return True, ""


def _observed() -> dict:
    """Pull the final heartbeat / boot-run summary from the run log."""
    out: dict[str, str | int] = {}
    if not RUN_LOG.exists():
        return out
    text = RUN_LOG.read_text(errors="replace")
    hbs = re.findall(r"heartbeat: cycle (\d+)/\d+, UART bytes (\d+), furthest = (\w+)", text)
    if hbs:
        last = hbs[-1]
        out["last_heartbeat_cycle"] = int(last[0])
        out["last_heartbeat_uart_bytes"] = int(last[1])
        out["last_heartbeat_furthest"] = last[2]
    m = re.search(
        r"E1 boot run: (\d+) UART bytes, (\d+) cycles, "
        r"DRAM AR=(\d+) R=(\d+), UART writes=(\d+)",
        text,
    )
    if m:
        out["final_uart_bytes"] = int(m.group(1))
        out["final_cycles"] = int(m.group(2))
        out["dram_ar_xfers"] = int(m.group(3))
        out["dram_r_xfers"] = int(m.group(4))
        out["uart_aw_xfers"] = int(m.group(5))
    return out


def main() -> int:
    text = SRC_TRANSCRIPT.read_text(errors="replace") if SRC_TRANSCRIPT.exists() else ""
    if not text.startswith("# "):
        text = HEADER + text
    # Mirror the dedicated transcript to the canonical evidence path.
    TRANSCRIPT.write_text(text, encoding="utf-8")

    furthest = _furthest(text)
    passed, reason = _results_passed()
    reached_userland = "ELIZA-USERLAND-OK" in text
    observed = _observed()

    evidence = [
        "rtl/top/e1_cva6_dram_boot_top.sv",
        "rtl/memory/dram_ctrl/e1_dram_ctrl.sv",
        "fw/linux-cva6-boot/e1-cva6-linux.dts",
        "fw/linux-cva6-boot/minimal.config",
        "fw/linux-cva6-boot/init.c",
        "fw/linux-cva6-boot/run_userland_final.sh",
        "verify/cocotb/integration/test_linux_boot_cva6.py",
        "verify/cocotb/integration/Makefile.linux-cva6-boot",
        "docs/evidence/cpu_ap/linux_userland_cva6.transcript",
        "build/reports/linux_userland_final.run.log",
    ]

    detail = {
        "stage": "userland",
        "config": "fast_functional_boot",
        "required_marker": "ELIZA-USERLAND-OK",
        "furthest_marker": furthest,
        "fast_levers": [
            "+E1_DRAM_FAST: behavioural-DRAM open-row/refresh/tCCD latency "
            "collapsed to 1 cycle (AXI4 protocol + ordering + data path intact)",
            "32 MiB advertised RAM in the DTS memory node",
            "Verilator built -O2 + --x-assign fast --x-initial fast + --threads 4",
            "kernel/bootarg trims: lpj=10000 skips calibrate_delay, PRINTK_TIME "
            "on for per-initcall timing, no SMP/NET/PCI/block/VT/crypto/sysfs/PTY",
        ],
        "harder_trim": (
            "vs prior minimal.config: dropped CONFIG_VT/VT_CONSOLE/DUMMY_CONSOLE, "
            "all CONFIG_RD_*/decompressors (uncompressed builtin cpio), CONFIG_SYSFS, "
            "CONFIG_UNIX98_PTYS/LEGACY_PTYS, CONFIG_CRYPTO, CONFIG_BINFMT_SCRIPT, "
            "PM/CPU_FREQ/CPU_IDLE/SUSPEND, FTRACE/BPF/PROFILING, "
            "RTC/I2C/SPI/GPIO/MTD/MMC/WATCHDOG/HWMON/INPUT/HW_RANDOM/THERMAL; "
            "added SLUB_TINY + initcall_debug; Image 2.0 MiB -> 1.70 MiB."
        ),
        "claim_boundary": (
            "FUNCTIONAL BOOT PROOF, NOT A TIMING/PERF/SILICON CLAIM.  Sim-only "
            "zero-wait DRAM + tiny advertised RAM make the OpenSBI -> Linux -> "
            "userland boot fit a bounded Verilator wall-time.  It proves the CVA6 "
            "RTL + OpenSBI + real Linux + real /init reach userland; it makes NO "
            "statement about cycle counts, memory latency, or wall-clock "
            "performance on silicon.  The realistic-latency config (no "
            "+E1_DRAM_FAST) remains the DRAMsim3-derived fidelity reference."
        ),
        "observed": observed,
        "transcript": "docs/evidence/cpu_ap/linux_userland_cva6.transcript",
        "transcript_excerpt": text[-2500:],
    }

    REPORT.parent.mkdir(parents=True, exist_ok=True)
    if passed and reached_userland:
        detail["proof"] = (
            "Real CVA6 RTL + OpenSBI v1.8.1 + real Linux 6.12.90 + real "
            "freestanding /init reached userland: ELIZA-USERLAND-OK printed over "
            "the ns16550a UART, preceded by a live uname(2) + /proc/cpuinfo dump."
        )
        payload = {
            "schema": "eliza.gate_status.v1",
            "gate": "linux_boot_cva6",
            "status": "PASS",
            "blocker_id": None,
            "blocker_reason": None,
            "evidence_paths": evidence,
            "as_of": _now(),
            "subsystem": "cpu_ap",
            "detail": detail,
        }
        print(f"PASS: reached userland (furthest={furthest})")
    else:
        nxt = _next_marker(furthest)
        detail["next_marker"] = nxt
        payload = {
            "schema": "eliza.gate_status.v1",
            "gate": "linux_boot_cva6",
            "status": "BLOCKED",
            "blocker_id": "boot-marker-not-reached",
            "blocker_reason": (
                f"required marker 'ELIZA-USERLAND-OK' not reached on the fast "
                f"functional config; furthest honest marker = {furthest}; next "
                f"gap = {nxt}. {reason} NOT FAKED."
            ),
            "evidence_paths": evidence,
            "as_of": _now(),
            "subsystem": "cpu_ap",
            "detail": detail,
        }
        print(f"BLOCKED: furthest marker = {furthest}; userland not reached. {reason}")

    out = json.dumps(payload, indent=2) + "\n"
    REPORT.write_text(out, encoding="utf-8")
    (REPORT.parent / "linux_boot_cva6.userland.json").write_text(out, encoding="utf-8")
    return 0 if (passed and reached_userland) else 1


if __name__ == "__main__":
    raise SystemExit(main())
