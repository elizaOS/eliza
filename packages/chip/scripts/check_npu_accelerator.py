#!/usr/bin/env python3
"""npu-accelerator-check gate.

Fail-closed gate for the E1 NPU descriptor accelerator (rtl/npu/e1_npu.sv) per
docs/security/tee-plan/03-secure-io-iommu-npu.md S4 and
verify/rtl_gap_work_order.yaml#areas.npu.critical_gaps.npu-production-accelerator.

The NPU is a descriptor-queue accelerator: the host enqueues 16-byte descriptors
in a memory-resident ring, the NPU fetches them over an AXI4-Lite master, streams
tensor tiles into a scratchpad, runs the GEMM/vector/scalar op, writes the result
back to DRAM, and raises a completion IRQ. The confidential-I/O build tags every
outbound access with a source ID + owning-domain ID + secure qualifier and locks
down perf counters when owned-private.

Writes build/reports/npu_accelerator.json in the eliza.gate_status.v1 shape.
PASS requires ALL of:
  (a) e1_npu lints clean under `verilator --lint-only -Wall -Wno-UNUSEDSIGNAL`
      in the SoC view (secure sideband ports absent, as e1_soc_top instantiates
      it) AND under strict `-Wall` with +define+E1_NPU_SECURE_SIDEBAND;
  (b) the confidential-I/O descriptor KAT
      (verify/cocotb/npu/test_npu_confidential_io.py) runs and every expected
      test passes — the owned-private GEMM_S8 descriptor matches golden_gemm_s8
      with a completion IRQ and source-ID/domain/secure tags, the private-queue
      owner gate, the sticky lock, and the unowned negative control;
  (c) the existing NPU contract suite (verify/cocotb/test_e1_npu.py) and the
      IREE tiny-MLP e2e descriptor suite (verify/cocotb/npu/test_iree_tiny_mlp_e2e.py)
      run and all tests pass (no regression of the existing accelerator).

If verilator/cocotb is unavailable the gate reports BLOCKED with the missing
dependency and exits non-zero (fail-closed).
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
REPORT = ROOT / "build/reports/npu_accelerator.json"

NPU_RTL = "rtl/npu/e1_npu.sv"
RUN_COCOTB = ROOT / "scripts/run_cocotb.sh"

EVIDENCE_PATHS = [
    NPU_RTL,
    "verify/cocotb/test_e1_npu.py",
    "verify/cocotb/npu/test_npu_confidential_io.py",
    "verify/cocotb/npu/test_iree_tiny_mlp_e2e.py",
    "verify/cocotb/npu/Makefile.secure-io",
    "docs/security/tee-plan/03-secure-io-iommu-npu.md",
]

KAT_EXPECTED = (
    "npu_confidential_gemm_kat_tags_and_completion",
    "npu_private_queue_rejects_host_doorbell_without_owner_token",
    "npu_lock_is_sticky_and_freezes_ownership_policy",
    "npu_unowned_perf_counters_are_visible",
)

IREE_EXPECTED = (
    "tiny_gemm_lowering_descriptor_stream_matches_golden_gemm_s8",
    "two_layer_mlp_lowering_descriptor_stream_matches_golden_gemm_s8",
)


def _verilator() -> str | None:
    found = shutil.which("verilator")
    if found:
        return found
    oss = ROOT / "external/oss-cad-suite/bin/verilator"
    return str(oss) if oss.is_file() else None


def _now() -> str:
    return _dt.datetime.now(_dt.UTC).isoformat()


def _python() -> str:
    venv = ROOT / ".venv/bin/python3"
    return str(venv) if venv.is_file() else sys.executable


def check_lint(verilator: str) -> list[dict]:
    """Lint the SoC view and the secure-sideband view of the NPU."""
    checks = []
    # SoC view: how e1_soc_top instantiates it (sideband ports absent).
    soc = subprocess.run(
        [
            verilator,
            "--lint-only",
            "-Wall",
            "-Wno-UNUSEDSIGNAL",
            str(ROOT / NPU_RTL),
            "--top-module",
            "e1_npu",
        ],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    soc_diags = [ln for ln in soc.stderr.splitlines() if "%Warning" in ln or "%Error" in ln]
    checks.append(
        {
            "id": "verilator_lint_soc_view",
            "status": "pass",
            "detail": "e1_npu lints clean (-Wall -Wno-UNUSEDSIGNAL, sideband absent)",
        }
        if soc.returncode == 0 and not soc_diags
        else {
            "id": "verilator_lint_soc_view",
            "status": "fail",
            "detail": "lint failed: " + "\n".join(soc_diags[:8]),
        }
    )
    # Secure-sideband view: strict -Wall, no waivers, ports present.
    sec = subprocess.run(
        [
            verilator,
            "--lint-only",
            "-Wall",
            "+define+E1_NPU_SECURE_SIDEBAND",
            str(ROOT / NPU_RTL),
            "--top-module",
            "e1_npu",
        ],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    sec_diags = [ln for ln in sec.stderr.splitlines() if "%Warning" in ln or "%Error" in ln]
    checks.append(
        {
            "id": "verilator_lint_secure_view",
            "status": "pass",
            "detail": "e1_npu lints clean (strict -Wall, +E1_NPU_SECURE_SIDEBAND)",
        }
        if sec.returncode == 0 and not sec_diags
        else {
            "id": "verilator_lint_secure_view",
            "status": "fail",
            "detail": "lint failed: " + "\n".join(sec_diags[:8]),
        }
    )
    return checks


def _run_cocotb_suite(
    check_id: str,
    module: str,
    cocotb_dir: str,
    expected: tuple[str, ...],
    makefile: str | None = None,
) -> dict:
    """Run a cocotb suite via scripts/run_cocotb.sh and parse its results.xml.

    run_cocotb.sh owns the PATH/cocotb-config shim and the per-suite result
    file under verify/cocotb/results/<top>_<module>.xml.
    """
    env = dict(os.environ)
    env["PATH"] = (
        f"{ROOT / 'external/oss-cad-suite/bin'}:{ROOT / '.venv/bin'}:{env.get('PATH', '')}"
    )
    env["PYTHON"] = _python()
    env["COCOTB_MODULE"] = module
    env["COCOTB_TOPLEVEL"] = "e1_npu"
    env["COCOTB_DIR"] = cocotb_dir
    if makefile:
        env["COCOTB_MAKEFILE"] = makefile
    proc = subprocess.run(
        ["sh", str(RUN_COCOTB)], capture_output=True, text=True, cwd=ROOT, env=env
    )
    results = ROOT / f"verify/cocotb/results/e1_npu_{module}.xml"
    return _parse_results(check_id, results, expected, proc, require_all_pass=True)


def _parse_results(
    check_id: str,
    results: Path,
    expected: tuple[str, ...],
    proc: subprocess.CompletedProcess,
    require_all_pass: bool = False,
) -> dict:
    if not results.is_file():
        last = (proc.stderr or proc.stdout or "").splitlines()
        tail = last[-1] if last else ""
        return {
            "id": check_id,
            "status": "blocked",
            "detail": f"no {results.name}; cocotb/verilator unavailable. {tail}",
        }
    tree = ET.parse(results)
    seen, failed = set(), []
    for tc in tree.iter("testcase"):
        name = tc.get("name", "")
        seen.add(name)
        if tc.find("failure") is not None or tc.find("error") is not None:
            failed.append(name)
    missing = [t for t in expected if t not in seen]
    if failed or missing or (require_all_pass and not seen):
        return {"id": check_id, "status": "fail", "detail": f"failed={failed} missing={missing}"}
    return {"id": check_id, "status": "pass", "detail": f"{len(seen)} cocotb tests passed"}


def build_report(checks: list[dict]) -> dict:
    has_fail = any(c["status"] == "fail" for c in checks)
    has_block = any(c["status"] == "blocked" for c in checks)
    if has_fail:
        status, blocker_id = "FAIL", "npu_accelerator_check_failure"
        blocker_reason = "; ".join(
            f"{c['id']}: {c['detail']}" for c in checks if c["status"] == "fail"
        )
    elif has_block:
        status, blocker_id = "BLOCKED", "npu_accelerator_dependency_missing"
        blocker_reason = "; ".join(
            f"{c['id']}: {c['detail']}" for c in checks if c["status"] == "blocked"
        )
    else:
        status, blocker_id, blocker_reason = "PASS", None, None

    return {
        "schema": "eliza.gate_status.v1",
        "gate": "npu-accelerator-check",
        "status": status,
        "blocker_id": blocker_id,
        "blocker_reason": blocker_reason,
        "evidence_paths": EVIDENCE_PATHS,
        "as_of": _now(),
        "generated_utc": _dt.datetime.now(_dt.UTC).replace(microsecond=0).isoformat().replace(
            "+00:00", "Z"
        ),
        "subsystem": "npu",
        "phone_claim_allowed": False,
        "release_claim_allowed": False,
        "production_accelerator_release_claim_allowed": False,
        "nnapi_claim_allowed": False,
        "performance_claim_allowed": False,
        "claim_boundary": (
            "The E1 NPU (rtl/npu/e1_npu.sv) is a descriptor-queue accelerator: a "
            "memory-resident 16-byte-descriptor ring fetched over an AXI4-Lite "
            "master, tensor-tile streaming into a 64-byte scratchpad, GEMM_S8/S4 + "
            "vector + scalar execution, result writeback to DRAM, and a completion "
            "IRQ. The confidential-I/O build (+E1_NPU_SECURE_SIDEBAND) tags every "
            "outbound access with the fixed NPU source ID (0x000004) + the "
            "monitor-programmed owning-domain ID + a secure qualifier (the OOB the "
            "RISC-V IOMMU ar_devid/ar_pasid and the IOPMP source-ID R/W/X table "
            "police), gates the private command queue on an owner token, and locks "
            "down PERF_* counters when owned-private. This gate proves lint (both "
            "views), the confidential-I/O descriptor KAT (GEMM matches "
            "golden_gemm_s8 with IRQ + tags), and no regression of the existing "
            "NPU contract / IREE e2e suites. It does NOT prove SoC-fabric wiring of "
            "the NPU master onto an IOMMU upstream port (S6.x integration item), "
            "NNAPI/VTS, the Linux/Android driver, or phone-class throughput."
        ),
        "summary": {
            "check_count": len(checks),
            "passing_check_count": sum(1 for c in checks if c["status"] == "pass"),
            "failures": [c["id"] for c in checks if c["status"] != "pass"],
        },
        "checks": checks,
    }


def main() -> int:
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    checks: list[dict] = []

    verilator = _verilator()
    if verilator is None:
        checks += [
            {
                "id": "verilator_lint_soc_view",
                "status": "blocked",
                "detail": "verilator not found; source tools/env.sh / install oss-cad-suite",
            },
            {
                "id": "verilator_lint_secure_view",
                "status": "blocked",
                "detail": "verilator not found",
            },
            {
                "id": "cocotb_confidential_io_kat",
                "status": "blocked",
                "detail": "verilator not found",
            },
            {
                "id": "cocotb_iree_tiny_mlp_e2e",
                "status": "blocked",
                "detail": "verilator not found",
            },
            {"id": "cocotb_test_e1_npu", "status": "blocked", "detail": "verilator not found"},
        ]
    else:
        checks += check_lint(verilator)
        checks.append(
            _run_cocotb_suite(
                "cocotb_confidential_io_kat",
                "test_npu_confidential_io",
                "verify/cocotb/npu",
                KAT_EXPECTED,
                makefile="Makefile.secure-io",
            )
        )
        checks.append(
            _run_cocotb_suite(
                "cocotb_iree_tiny_mlp_e2e",
                "test_iree_tiny_mlp_e2e",
                "verify/cocotb/npu",
                IREE_EXPECTED,
            )
        )
        checks.append(_run_cocotb_suite("cocotb_test_e1_npu", "test_e1_npu", "verify/cocotb", ()))

    report = build_report(checks)
    REPORT.write_text(json.dumps(report, indent=2) + "\n")

    status = str(report["status"])
    blocker_reason = report["blocker_reason"]
    print(f"STATUS: {status} npu-accelerator-check -> {REPORT.relative_to(ROOT)}")
    for c in checks:
        print(f"  [{c['status'].upper():7}] {c['id']}: {c['detail']}")
    if blocker_reason:
        print(f"  blocker: {blocker_reason}")
    return {"PASS": 0, "BLOCKED": 2, "FAIL": 1}[status]


if __name__ == "__main__":
    sys.exit(main())
