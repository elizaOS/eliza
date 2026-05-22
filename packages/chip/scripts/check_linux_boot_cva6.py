#!/usr/bin/env python3
"""Gate: OpenSBI hands off (M->S) and a real Linux kernel boots on the real
CVA6 from real DRAM, in Verilator — recorded to the furthest honest marker.

This is the OS-bring-up step above scripts/check_opensbi_cva6_boot.py (which
proves the OpenSBI M-mode banner).  The bespoke read-modify-write atomics
adapter has been replaced by the vendored pulp-platform `axi_riscv_atomics`
filter (rtl/top/adapters/e1_axi4_riscv_atomics.sv, wrapping CVA6's own vendor
tree), which resolves RISC-V atomics + LR/SC with the RVWMO ordering CVA6's
wt_axi_adapter assumes — so the run proceeds PAST the post-banner write-ID FIFO
assertion that previously stopped the boot.

Two stages, selected by --stage:

  smode  (default): preload the OpenSBI S-mode image; assert the S-MODE-OK
          marker prints over the UART.  This is the M->S handoff proof Linux
          needs — OpenSBI completed M-mode init and dropped to the S-mode
          payload.

  linux:  preload the OpenSBI -> Linux image (real riscv64 Image + initramfs);
          run a bounded sim and record the FURTHEST boot marker reached
          (early console / "Linux version" / MMU up / Run /init / userland).

Writes build/reports/linux_boot_cva6.json (schema eliza.gate_status.v1) with
the furthest marker recorded.  PASS criterion = whatever level is genuinely
reached and required (--require).  Fail-closed and HONEST: a development sim
boot is not a silicon claim, and a run that stops at, say, the kernel banner is
recorded as BLOCKED on the next marker with the precise gap — never faked.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COCOTB_DIR = ROOT / "verify/cocotb/integration"
RESULTS_XML = COCOTB_DIR / "results.xml"
# Per-stage report so the smode (M->S handoff) and linux (kernel boot) results
# are both preserved on disk; the canonical gate report mirrors the last stage
# run for backward compatibility with build/reports/linux_boot_cva6.json.
REPORT = ROOT / "build/reports/linux_boot_cva6.json"
EVIDENCE_DIR = ROOT / "docs/evidence/cpu_ap"
GATE = "linux_boot_cva6"
SUBSYSTEM = "cpu_ap"
LINUX_GNU = ROOT / "external/riscv64-linux-gnu"

# Ordered boot markers, earliest -> furthest (mirrors test_linux_boot_cva6.py).
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


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat()


def _write(status: str, blocker_id, reason, evidence, extra=None,
           stage: str | None = None) -> None:
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    payload = {
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
    text = json.dumps(payload, indent=2) + "\n"
    REPORT.write_text(text, encoding="utf-8")
    if stage:
        (REPORT.parent / f"linux_boot_cva6.{stage}.json").write_text(
            text, encoding="utf-8")


def _run(cmd, cwd, env, log, timeout):
    with log.open("w", encoding="utf-8") as fh:
        proc = subprocess.run(cmd, cwd=str(cwd), env=env, stdout=fh,
                              stderr=subprocess.STDOUT, timeout=timeout)
    return proc.returncode, log.read_text(encoding="utf-8", errors="replace")


def _furthest(text: str) -> str:
    reached = "none"
    for name, token in MARKERS:
        if token in text:
            reached = name
    return reached


def _parse_results():
    if not RESULTS_XML.exists():
        return False, "cocotb results.xml not produced (sim did not run)"
    try:
        tree = ET.parse(RESULTS_XML)
    except ET.ParseError as exc:
        return False, f"results.xml parse error: {exc}"
    seen = 0
    for case in tree.iterfind(".//testcase"):
        seen += 1
        if case.find("skipped") is not None:
            return False, f"test skipped: {case.get('name')}"
        node = case.find("failure") or case.find("error")
        if node is not None:
            msg = (node.get("message") or node.text or "assertion failed").strip()
            return False, f"{case.get('name')}: {msg[:800]}"
    if seen == 0:
        return False, "no cocotb testcases ran"
    return True, ""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", choices=("smode", "linux"), default="smode")
    ap.add_argument("--require", default=None,
                    help="marker token that must appear (default: stage default)")
    ap.add_argument("--max-cycles", type=int, default=None)
    ap.add_argument("--idle-limit", type=int, default=None)
    ap.add_argument("--sim-timeout", type=int, default=21600)
    args = ap.parse_args()

    env = dict(os.environ)
    env.setdefault("CVA6_VERILATOR_FULL_OK", "1")

    if args.stage == "smode":
        makefile = COCOTB_DIR / "Makefile.opensbi-cva6-boot"
        sim_build = "sim_build_opensbi_cva6_boot"
        builder = ROOT / "fw/opensbi-cva6-boot/build_boot_image.py"
        boot_hex = ROOT / "fw/opensbi-cva6-boot/build/boot.hex128"
        require = args.require or "S-MODE-OK"
        transcript_name = "opensbi_smode_handoff_cva6.transcript"
        max_cycles = args.max_cycles or 8_000_000
        idle_limit = args.idle_limit or 2_000_000
        build_cmd = ["python3", str(builder)]
    else:
        makefile = COCOTB_DIR / "Makefile.linux-cva6-boot"
        sim_build = "sim_build_linux_cva6_boot"
        builder = ROOT / "fw/linux-cva6-boot/build_linux_boot_image.py"
        boot_hex = ROOT / "fw/linux-cva6-boot/build/linux_boot.hex128"
        require = args.require or "Linux version"
        transcript_name = "linux_boot_cva6.transcript"
        max_cycles = args.max_cycles or 200_000_000
        idle_limit = args.idle_limit or 8_000_000
        build_cmd = ["python3", str(builder)]

    transcript = EVIDENCE_DIR / transcript_name
    evidence = [
        "rtl/top/e1_cva6_dram_boot_top.sv",
        "rtl/top/adapters/e1_axi4_riscv_atomics.sv",
        "external/cva6/cva6/vendor/pulp-platform/axi_riscv_atomics/src/axi_riscv_atomics.sv",
        "verify/cocotb/integration/test_linux_boot_cva6.py",
        str(makefile.relative_to(ROOT)),
    ]

    for tool in ("verilator", "riscv64-unknown-elf-gcc", "dtc"):
        if shutil.which(tool) is None:
            _write("BLOCKED", "toolchain-missing",
                   f"{tool} not on PATH — run `source tools/env.sh` first", evidence)
            print(f"BLOCKED: {tool} not on PATH (source tools/env.sh)")
            return 1
    if not (LINUX_GNU / "usr/bin/riscv64-linux-gnu-gcc").exists():
        _write("BLOCKED", "toolchain-missing",
               "riscv64-linux-gnu-gcc not found under external/riscv64-linux-gnu",
               evidence)
        print("BLOCKED: riscv64-linux-gnu-gcc missing")
        return 1

    # 1) Build the preload image from source.
    build_log = ROOT / f"build/reports/linux_boot_cva6.{args.stage}.image.log"
    build_log.parent.mkdir(parents=True, exist_ok=True)
    try:
        rc, out = _run(build_cmd, ROOT, env, build_log, timeout=1800)
    except subprocess.TimeoutExpired:
        _write("BLOCKED", "image-build-timeout",
               f"{args.stage} boot image build exceeded 1800s", evidence)
        print("BLOCKED: boot image build timed out")
        return 1
    if rc != 0 or not boot_hex.exists():
        tail = "\n".join(out.splitlines()[-25:])
        _write("BLOCKED", "image-build",
               f"{args.stage} boot image build failed (rc={rc}); see {build_log}",
               evidence, extra={"log_tail": tail})
        print(f"BLOCKED: boot image build failed; see {build_log}")
        return 1

    # 2) Elaborate + run the cocotb sim.
    sim_build_dir = COCOTB_DIR / sim_build
    if RESULTS_XML.exists():
        RESULTS_XML.unlink()
    sim_log = ROOT / f"build/reports/linux_boot_cva6.{args.stage}.sim.log"
    test_env = dict(env)
    test_env["E1_BOOT_REQUIRE"] = require
    test_env["E1_BOOT_TRANSCRIPT"] = transcript_name
    test_env["E1_BOOT_MAX_CYCLES"] = str(max_cycles)
    test_env["E1_BOOT_IDLE_LIMIT"] = str(idle_limit)
    cmd = [
        "make", "-f", str(makefile),
        f"SIM_BUILD={sim_build}",
        "MODULE=test_linux_boot_cva6",
        f"PLUSARGS=+E1_DRAM_PRELOAD_HEX={boot_hex}",
    ]
    try:
        rc, out = _run(cmd, COCOTB_DIR, test_env, sim_log, timeout=args.sim_timeout)
    except subprocess.TimeoutExpired:
        furthest = _furthest(transcript.read_text(errors="replace")) \
            if transcript.exists() else "none"
        _write("BLOCKED", "sim-timeout",
               f"cocotb sim exceeded {args.sim_timeout}s; furthest marker "
               f"reached before timeout = {furthest}", evidence,
               extra={"furthest_marker": furthest,
                      "sim_log": str(sim_log.relative_to(ROOT))},
               stage=args.stage)
        print(f"BLOCKED: sim timed out; furthest marker = {furthest}")
        return 1

    if rc != 0 and not RESULTS_XML.exists():
        tail = "\n".join(out.splitlines()[-25:])
        _write("FAIL", "elaboration-or-build",
               f"Verilator build/elaboration failed; see {sim_log}", evidence,
               extra={"log_tail": tail})
        print(f"FAIL: elaboration/build failed; see {sim_log}")
        return 1

    transcript_text = transcript.read_text(errors="replace") if transcript.exists() else ""
    furthest = _furthest(transcript_text)
    extra = {
        "stage": args.stage,
        "required_marker": require,
        "furthest_marker": furthest,
        "sim_log": str(sim_log.relative_to(ROOT)),
    }
    if transcript.exists():
        extra["transcript"] = str(transcript.relative_to(ROOT))
        extra["transcript_excerpt"] = transcript_text[-2000:]

    passed, reason = _parse_results()
    evidence_full = evidence + [
        f"docs/evidence/cpu_ap/{transcript_name}",
        str(sim_log.relative_to(ROOT)),
    ]
    if not passed:
        # The required marker was not reached: record the furthest honest marker
        # and stay BLOCKED on the next one with the precise gap.
        nxt = "none"
        for i, (name, _tok) in enumerate(MARKERS):
            if name == furthest and i + 1 < len(MARKERS):
                nxt = MARKERS[i + 1][0]
                break
        extra["next_marker"] = nxt
        _write("BLOCKED", "boot-marker-not-reached",
               f"required marker {require!r} not reached; furthest honest marker "
               f"= {furthest}; next gap = {nxt}. {reason}", evidence_full, extra,
               stage=args.stage)
        print(f"BLOCKED: furthest marker = {furthest}; required {require!r} not reached")
        return 1

    proof = ("OpenSBI completed M-mode init and handed off to the S-mode payload "
             "(S-MODE-OK printed over the ns16550a UART) on the real CVA6 from "
             "real DRAM through the vendored axi_riscv_atomics filter — the M->S "
             "transition Linux requires."
             if args.stage == "smode" else
             f"Linux boot reached marker {furthest!r} (required {require!r}).")
    extra["proof"] = proof
    _write("PASS", None, None, evidence_full, extra, stage=args.stage)
    print(f"PASS: stage={args.stage} furthest marker = {furthest} (required {require!r})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
