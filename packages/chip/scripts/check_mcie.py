#!/usr/bin/env python3
"""mcie gate (TEE-native confidential VM, lane 01 / S3 -- memory crypto+integrity).

Fail-closed gate for the E1 Memory Crypto + Integrity Engine RTL
(rtl/security/mcie/e1_mcie.sv + e1_mcie_aes.sv + e1_mcie_pkg.sv) per
docs/security/tee-plan/01-tee-core-architecture.md S3. The MCIE sits at the
memory-controller boundary, downstream of the system cache and the MTT check
(rtl/security/mtt/e1_mtt_checker.sv) and upstream of the LPDDR5X PHY. It
provides confidentiality (counter-mode AES, NOT XTS), integrity (per-line
CBC-MAC), and anti-replay (counter-integrity tree) for confidential DRAM lines,
and fails closed on any integrity failure (no unverified plaintext is ever
returned).

Writes build/reports/mcie.json in the eliza.gate_status.v1 shape. PASS requires
ALL of:
  (a) the shared MEE freshness model (scripts/check_tee_mee_freshness_model.py)
      still passes -- the RTL enforces the SAME counter-mode + anti-rollback
      semantics this pure-Python model proves (per-line monotonic counter,
      keystream over (key,addr,counter), MAC over (addr,counter,ct), verify
      requires counter==on-die counter then MAC match, per-boot reseed), so
      they must agree;
  (b) e1_mcie_pkg + e1_mcie_aes + e1_mcie lint clean under
      `verilator --lint-only -Wall` (strict, no functional waivers; fail-closed
      by construction);
  (c) the cocotb KAT (verify/cocotb/security/test_e1_mcie.py) runs and every
      expected test passes -- AES FIPS-197 KAT, write/read roundtrip,
      actually-encrypted (vs CTR reference), non-deterministic ciphertext
      (the not-XTS property), tamper detection (MAC fault, fail-closed),
      replay/anti-rollback (rollback fault, fail-closed), unwritten-line fault,
      and plaintext passthrough.

If verilator/cocotb is unavailable the gate reports BLOCKED with the missing
dependency and exits non-zero (fail-closed), exactly as check_mtt_checker.py.

PHYSICAL DEPENDENCY (claim boundary). This gate proves the ENGINE: counter-mode
crypto, the CBC-MAC integrity tag, and the counter-tree anti-replay invariant
against a backing-memory model. It does NOT prove the real LPDDR5X PHY/DFI data
path, the DRAM bandwidth cost of fetching the {ct,counter,mac} record and
walking the counter tree on silicon, the AXI4 splice into e1_dram_ctrl, or the
side-channel lab validation of ciphertext non-determinism on a real DDR bus --
those remain BLOCKED follow-ons.
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
REPORT = ROOT / "build/reports/mcie.json"

MCIE_PKG = "rtl/security/mcie/e1_mcie_pkg.sv"
MCIE_AES = "rtl/security/mcie/e1_mcie_aes.sv"
MCIE_RTL = "rtl/security/mcie/e1_mcie.sv"
FRESHNESS_CHECK = ROOT / "scripts/check_tee_mee_freshness_model.py"
COCOTB_DIR = ROOT / "verify/cocotb/security"
COCOTB_MAKEFILE = "Makefile.mcie"
COCOTB_RESULTS = COCOTB_DIR / "results_mcie.xml"
COCOTB_SIM_BUILD = "sim_build_mcie"

EXPECTED_TESTS = (
    "aes_fips197_kat",
    "roundtrip_confidential",
    "actually_encrypted",
    "non_deterministic_ciphertext",
    "tamper_ciphertext_detected",
    "replay_old_triple_detected",
    "read_unwritten_confidential_faults",
    "shared_plaintext_passthrough",
)


def _verilator() -> str | None:
    found = shutil.which("verilator")
    if found:
        return found
    oss = ROOT / "external/oss-cad-suite/bin/verilator"
    return str(oss) if oss.is_file() else None


def _now() -> str:
    return _dt.datetime.now(_dt.UTC).isoformat()


def check_freshness_model() -> dict:
    """The RTL enforces the SAME counter-mode + anti-rollback model the pure
    freshness model proves; they must agree."""
    if not FRESHNESS_CHECK.is_file():
        return {
            "id": "mee_freshness_model",
            "status": "blocked",
            "detail": f"{FRESHNESS_CHECK.name} missing",
        }
    proc = subprocess.run(
        [sys.executable, str(FRESHNESS_CHECK)], capture_output=True, text=True, cwd=ROOT
    )
    if proc.returncode != 0:
        return {
            "id": "mee_freshness_model",
            "status": "fail",
            "detail": (proc.stderr.strip() or proc.stdout.strip())[:400],
        }
    return {
        "id": "mee_freshness_model",
        "status": "pass",
        "detail": "MEE freshness model rejects stale + cross-boot replay; the MCIE "
        "RTL enforces the same per-line counter + anti-rollback invariant",
    }


def check_lint(verilator: str) -> dict:
    """Strict `-Wall` lint with NO functional waivers (fail-closed by construction)."""
    cmd = [
        verilator,
        "--lint-only",
        "-Wall",
        "-Wno-DECLFILENAME",
        str(ROOT / MCIE_PKG),
        str(ROOT / MCIE_AES),
        str(ROOT / MCIE_RTL),
        "--top-module",
        "e1_mcie",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT)
    diags = [ln for ln in proc.stderr.splitlines() if "%Warning" in ln or "%Error" in ln]
    if proc.returncode == 0 and not diags:
        return {
            "id": "verilator_lint",
            "status": "pass",
            "detail": "e1_mcie (+aes,+pkg) lints clean under verilator --lint-only "
            "-Wall (no functional waivers)",
        }
    return {
        "id": "verilator_lint",
        "status": "fail",
        "detail": "lint failed: " + "\n".join(diags[:8]),
    }


def check_cocotb() -> dict:
    if COCOTB_RESULTS.exists():
        COCOTB_RESULTS.unlink()
    rc = subprocess.run(
        [
            "make",
            "-C",
            str(COCOTB_DIR),
            "-f",
            COCOTB_MAKEFILE,
            f"SIM_BUILD={COCOTB_SIM_BUILD}",
            f"COCOTB_RESULTS_FILE={COCOTB_RESULTS.name}",
        ],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    if not COCOTB_RESULTS.is_file():
        last = rc.stderr.splitlines()[-1] if rc.stderr else ""
        return {
            "id": "cocotb_mcie",
            "status": "blocked",
            "detail": f"no {COCOTB_RESULTS.name}; cocotb/verilator unavailable. {last}",
        }
    tree = ET.parse(COCOTB_RESULTS)
    seen, failed = set(), []
    for tc in tree.iter("testcase"):
        name = tc.get("name", "")
        seen.add(name)
        if tc.find("failure") is not None or tc.find("error") is not None:
            failed.append(name)
    missing = [t for t in EXPECTED_TESTS if t not in seen]
    if failed or missing:
        return {
            "id": "cocotb_mcie",
            "status": "fail",
            "detail": f"failed={failed} missing={missing}",
        }
    return {
        "id": "cocotb_mcie",
        "status": "pass",
        "detail": f"{len(EXPECTED_TESTS)} MCIE cocotb tests passed (AES-FIPS197/roundtrip/"
        "actually-encrypted/non-deterministic-not-XTS/tamper-MAC-fail-closed/"
        "replay-rollback-fail-closed/unwritten-fault/plaintext-passthrough)",
    }


def main() -> int:
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    checks = [check_freshness_model()]

    verilator = _verilator()
    if verilator is None:
        checks.append(
            {
                "id": "verilator_lint",
                "status": "blocked",
                "detail": "verilator not found; source tools/env.sh / install oss-cad-suite",
            }
        )
        checks.append({"id": "cocotb_mcie", "status": "blocked", "detail": "verilator not found"})
    else:
        checks.append(check_lint(verilator))
        checks.append(check_cocotb())

    has_fail = any(c["status"] == "fail" for c in checks)
    has_block = any(c["status"] == "blocked" for c in checks)

    if has_fail:
        status, blocker_id = "FAIL", "mcie_check_failure"
        blocker_reason = "; ".join(
            f"{c['id']}: {c['detail']}" for c in checks if c["status"] == "fail"
        )
    elif has_block:
        status, blocker_id = "BLOCKED", "mcie_dependency_missing"
        blocker_reason = "; ".join(
            f"{c['id']}: {c['detail']}" for c in checks if c["status"] == "blocked"
        )
    else:
        status, blocker_id, blocker_reason = "PASS", None, None

    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "mcie",
        "status": status,
        "blocker_id": blocker_id,
        "blocker_reason": blocker_reason,
        "evidence_paths": [
            MCIE_RTL,
            MCIE_AES,
            MCIE_PKG,
            "scripts/check_tee_mee_freshness_model.py",
            "scripts/tee/mee_freshness_model.py",
            "verify/cocotb/security/test_e1_mcie.py",
            "verify/cocotb/security/Makefile.mcie",
        ],
        "as_of": _now(),
        "subsystem": "security",
        "claim_boundary": (
            "The E1 MCIE RTL (rtl/security/mcie/e1_mcie.sv + e1_mcie_aes.sv) is "
            "the lane-01 S3 memory confidentiality + integrity engine "
            "(01-tee-core-architecture.md S3). It sits at the memory-controller "
            "boundary, downstream of the system cache and the MTT check "
            "(e1_mtt_checker.sv supplies the per-page confidentiality class), and "
            "upstream of the LPDDR5X PHY. CONFIDENTIALITY is counter-mode AES, NOT "
            "XTS: keystream = AES_K({line_addr, 64-bit per-line counter}), "
            "ciphertext = plaintext XOR keystream, with the counter advancing on "
            "every write so identical plaintext yields DIFFERENT ciphertext -- "
            "defeating the TEE.fail / CipherLeaks ciphertext-equality side channel "
            "that breaks deterministic address-tweaked XTS. INTEGRITY is a per-line "
            "CBC-MAC over {line_addr, counter} || ciphertext (the 8-ary "
            "counter-integrity / Bonsai-Merkle tree over the counters; the on-die "
            "counter cache holds the authoritative leaf counters and the root lives "
            "in on-die SRAM, reseeded per cold boot). ANTI-REPLAY: a read VERIFIES "
            "the presented counter equals the on-die counter (else FAULT_ROLLBACK) "
            "and the recomputed MAC equals the stored MAC (else FAULT_MAC); on "
            "either failure the read is FAIL-CLOSED -- no plaintext is returned, an "
            "integrity fault pulses to the RoT/alert network and latches. free/"
            "shared pages pass through plaintext. This gate proves the shared MEE "
            "freshness model agrees, the RTL lints clean (-Wall, no functional "
            "waivers), the AES-128 core matches the FIPS-197 KAT, and the cocotb "
            "roundtrip / actually-encrypted / non-deterministic / tamper / replay / "
            "passthrough contracts pass against a backing-memory model. It does NOT "
            "prove the real LPDDR5X PHY/DFI data path, the DRAM bandwidth cost of "
            "the record fetch + counter-tree walk on silicon, the AXI4 splice into "
            "e1_dram_ctrl, nor the side-channel lab validation of ciphertext "
            "non-determinism on a real DDR bus -- those remain BLOCKED follow-ons."
        ),
        "summary": {
            "check_count": len(checks),
            "passing_check_count": sum(1 for c in checks if c["status"] == "pass"),
            "failures": [c["id"] for c in checks if c["status"] != "pass"],
        },
        "checks": checks,
    }
    REPORT.write_text(json.dumps(report, indent=2) + "\n")

    print(f"STATUS: {status} mcie -> {REPORT.relative_to(ROOT)}")
    for c in checks:
        print(f"  [{c['status'].upper():7}] {c['id']}: {c['detail']}")
    if blocker_reason:
        print(f"  blocker: {blocker_reason}")

    return {"PASS": 0, "BLOCKED": 2, "FAIL": 1}[status]


if __name__ == "__main__":
    sys.exit(main())
