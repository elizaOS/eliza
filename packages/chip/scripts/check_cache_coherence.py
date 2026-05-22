#!/usr/bin/env python3
"""cache-coherence-check gate (cache subsystem, SMP coherence).

Fail-closed gate for the E1 SMP cache coherence layer: the MESI directory
controller (rtl/cache/coherence/e1_coherence_dir.sv) connecting >=2 private
e1_l1d_cache instances over a shared backing store, per
docs/security/tee-plan/05-cpu-memory-performance.md (SMP-Linux-capable
coherence) and the partition/flush-on-domain-switch requirement in
docs/security/tee-plan/04-side-channel-physical-hardening.md S1.2.

Writes build/reports/cache_coherence.json in the eliza.gate_status.v1 shape.
PASS requires ALL of:
  (a) the directory + L1D + SMP harness lint clean under
      `verilator --lint-only -Wall` with only the cache-block lint waivers
      (the same -Wno-* set the cache cocotb Makefile uses);
  (b) the multi-core coherence cocotb suite
      (verify/cocotb/cache/test_smp_coherence.py) runs and every coherence
      invariant test passes: SWMR (single-writer, no-two-modified sweep),
      write propagation, the message-passing litmus, dirty writeback
      ordering, and the domain-flush partition;
  (c) the existing single-L1D MESI coherence vectors
      (verify/cocotb/cache/test_coherence_vectors.py) still pass, so this
      work did not regress the probe/downgrade/invalidate contract.

If verilator/cocotb is unavailable the gate reports BLOCKED with the missing
dependency and exits non-zero (fail-closed).
"""

from __future__ import annotations

import datetime as _dt
import json
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/cache_coherence.json"

CACHE_PKG = "rtl/cache/cache_pkg.sv"
LSU_PKG = "rtl/cache/lsu_to_l1d_pkg.sv"
L1D_RTL = "rtl/cache/l1d/e1_l1d_cache.sv"
DIR_RTL = "rtl/cache/coherence/e1_coherence_dir.sv"
SMP_TB = "verify/cocotb/cache/e1_coherence_smp_tb.sv"

COCOTB_DIR = ROOT / "verify/cocotb/cache"

# Cache-block lint waivers (mirrors verify/cocotb/cache/Makefile). These are
# style waivers for the modeled-array RTL; no functional check is suppressed.
LINT_WAIVERS = [
    "-Wno-UNUSEDSIGNAL",
    "-Wno-UNUSEDPARAM",
    "-Wno-WIDTHEXPAND",
    "-Wno-WIDTHTRUNC",
    "-Wno-ASCRANGE",
    "-Wno-DECLFILENAME",
    "-Wno-VARHIDDEN",
    "-Wno-LATCH",
]

SMP_COCOTB = {
    "id": "cocotb_smp_coherence",
    "toplevel": "e1_coherence_smp_tb",
    "module": "test_smp_coherence",
    "sim_build": "sim_build_smp_coherence",
    "results": "results_smp_coherence.xml",
    "expected": (
        "test_write_propagation",
        "test_swmr_single_writer",
        "test_no_two_modified_invariant",
        "test_message_passing_litmus",
        "test_dirty_writeback_ordering",
        "test_domain_flush_partition",
    ),
    "label": "SMP MESI directory coherence (SWMR / write-propagation / "
    "MP-litmus / writeback-ordering / domain-flush)",
}

VECTORS_COCOTB = {
    "id": "cocotb_coherence_vectors",
    "toplevel": "e1_l1d_cache",
    "module": "test_coherence_vectors",
    "sim_build": "sim_build_coherence_vectors",
    "results": "results_coherence_vectors.xml",
    "expected": (
        "test_clean_line_probe_invalidate_no_writeback",
        "test_dirty_line_probe_invalidate_writeback",
        "test_dirty_line_probe_downgrade_to_shared",
        "test_invalidate_miss_no_data",
    ),
    "label": "single-L1D MESI probe vectors (no regression)",
}


def _verilator() -> str | None:
    found = shutil.which("verilator")
    if found:
        return found
    oss = ROOT / "external/oss-cad-suite/bin/verilator"
    return str(oss) if oss.is_file() else None


def _now() -> str:
    return _dt.datetime.now(_dt.UTC).isoformat()


def check_lint(verilator: str) -> dict:
    cmd = (
        [verilator, "--lint-only", "-Wall"]
        + LINT_WAIVERS
        + [
            str(ROOT / CACHE_PKG),
            str(ROOT / LSU_PKG),
            str(ROOT / L1D_RTL),
            str(ROOT / DIR_RTL),
            str(ROOT / SMP_TB),
            "--top-module",
            "e1_coherence_smp_tb",
        ]
    )
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT)
    diags = [
        ln for ln in proc.stderr.splitlines() if "%Warning" in ln or "%Error" in ln
    ]
    if proc.returncode == 0 and not diags:
        return {
            "id": "verilator_lint",
            "status": "pass",
            "detail": "e1_coherence_dir + e1_l1d_cache + SMP harness lint clean "
            "under verilator --lint-only -Wall (cache-block style waivers only)",
        }
    return {
        "id": "verilator_lint",
        "status": "fail",
        "detail": "lint failed: " + "\n".join(diags[:8]),
    }


def run_cocotb(spec: dict) -> dict:
    results = COCOTB_DIR / spec["results"]
    if results.exists():
        results.unlink()
    rc = subprocess.run(
        [
            "make",
            "-C",
            str(COCOTB_DIR),
            f"TOPLEVEL={spec['toplevel']}",
            f"MODULE={spec['module']}",
            f"SIM_BUILD={spec['sim_build']}",
            f"COCOTB_RESULTS_FILE={spec['results']}",
        ],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    if not results.is_file():
        last = rc.stderr.splitlines()[-1] if rc.stderr else ""
        return {
            "id": spec["id"],
            "status": "blocked",
            "detail": f"no {spec['results']}; cocotb/verilator unavailable. {last}",
        }
    tree = ET.parse(results)
    seen, failed = set(), []
    for tc in tree.iter("testcase"):
        name = tc.get("name", "")
        seen.add(name)
        if tc.find("failure") is not None or tc.find("error") is not None:
            failed.append(name)
    missing = [t for t in spec["expected"] if t not in seen]
    if failed or missing:
        return {
            "id": spec["id"],
            "status": "fail",
            "detail": f"{spec['label']}: failed={failed} missing={missing}",
        }
    return {
        "id": spec["id"],
        "status": "pass",
        "detail": f"{len(spec['expected'])} tests passed -- {spec['label']}",
    }


def main() -> int:
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    checks: list[dict] = []

    verilator = _verilator()
    if verilator is None:
        checks.append(
            {
                "id": "verilator_lint",
                "status": "blocked",
                "detail": "verilator not found; source tools/env.sh / install oss-cad-suite",
            }
        )
        checks.append(
            {"id": SMP_COCOTB["id"], "status": "blocked", "detail": "verilator not found"}
        )
        checks.append(
            {"id": VECTORS_COCOTB["id"], "status": "blocked", "detail": "verilator not found"}
        )
    else:
        checks.append(check_lint(verilator))
        checks.append(run_cocotb(SMP_COCOTB))
        checks.append(run_cocotb(VECTORS_COCOTB))

    has_fail = any(c["status"] == "fail" for c in checks)
    has_block = any(c["status"] == "blocked" for c in checks)

    if has_fail:
        status, blocker_id = "FAIL", "cache_coherence_check_failure"
        blocker_reason = "; ".join(
            f"{c['id']}: {c['detail']}" for c in checks if c["status"] == "fail"
        )
    elif has_block:
        status, blocker_id = "BLOCKED", "cache_coherence_dependency_missing"
        blocker_reason = "; ".join(
            f"{c['id']}: {c['detail']}" for c in checks if c["status"] == "blocked"
        )
    else:
        status, blocker_id, blocker_reason = "PASS", None, None

    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "cache-coherence-check",
        "status": status,
        "blocker_id": blocker_id,
        "blocker_reason": blocker_reason,
        "evidence_paths": [
            DIR_RTL,
            L1D_RTL,
            CACHE_PKG,
            SMP_TB,
            "verify/cocotb/cache/test_smp_coherence.py",
            "verify/cocotb/cache/test_coherence_vectors.py",
            "verify/cocotb/cache/Makefile",
        ],
        "as_of": _now(),
        "subsystem": "cache",
        "claim_boundary": (
            "The E1 SMP cache coherence layer (rtl/cache/coherence/"
            "e1_coherence_dir.sv) is a MESI directory controller that serves "
            "as the cluster ordering point for >=2 private e1_l1d_cache "
            "instances over a shared backing store. It tracks per-line stable "
            "state (I/S/E/M) and a per-core sharer mask, and issues probes that "
            "enforce SWMR by construction: a write acquire invalidates every "
            "peer (collecting any dirty owner's writeback) before granting "
            "Modified, and a read acquire downgrades a dirty owner to Shared "
            "(again collecting the writeback) before the grant, so a reader "
            "always observes the most recent write. It also implements a "
            "flush-by-domain hook that drops a confidential domain's directory "
            "lines on a domain switch. This gate proves the RTL lints clean "
            "(-Wall, cache-block style waivers only) and that the multi-core "
            "cocotb KAT proves SWMR, write propagation, the message-passing "
            "litmus, dirty writeback ordering, and the domain-flush partition, "
            "with the single-L1D probe vectors still green. It does NOT prove "
            "SoC-level integration of the directory into e1_soc_top, the full "
            "litmus-test suite (only MP is covered), formal coherence across "
            "L1/L2/L3 with the directory instantiated, N>2 core scaling, or "
            "writeback-on-silent-eviction in e1_l1d_cache (the L1D's dirty "
            "writeback is probe-driven, not capacity-eviction-driven)."
        ),
        "summary": {
            "check_count": len(checks),
            "passing_check_count": sum(1 for c in checks if c["status"] == "pass"),
            "failures": [c["id"] for c in checks if c["status"] != "pass"],
        },
        "checks": checks,
    }
    REPORT.write_text(json.dumps(report, indent=2) + "\n")

    print(f"STATUS: {status} cache-coherence-check -> {REPORT.relative_to(ROOT)}")
    for c in checks:
        print(f"  [{c['status'].upper():7}] {c['id']}: {c['detail']}")
    if blocker_reason:
        print(f"  blocker: {blocker_reason}")

    return {"PASS": 0, "BLOCKED": 2, "FAIL": 1}[status]


if __name__ == "__main__":
    sys.exit(main())
