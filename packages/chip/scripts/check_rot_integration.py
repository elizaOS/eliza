#!/usr/bin/env python3
"""rot-integration-check gate (W1).

Fail-closed gate for the E1 root-of-trust integration top
(rtl/security/rot/e1_rot_top.sv) per docs/security/tee-plan/02-root-of-trust.md
S8. Writes build/reports/rot_integration.json in the eliza.gate_status.v1 shape.

PASS requires ALL of:
  (a) the OpenTitan pin manifest resolves: the checkout is present and its HEAD
      matches external/opentitan/pin-manifest.json (Apache-2.0, Earl Grey tag);
  (b) e1_rot_top elaborates clean under Verilator -- both the spine-only build
      and the Ibex-instantiated build;
  (c) the cocotb reset-release + mailbox tests pass.

It additionally reports the real-vs-shim block inventory and FAILS CLOSED
(status BLOCKED) for every security block that is shimmed rather than truly
integrated, naming the missing dependency. This is the project's fail-closed
law (CLAUDE.md / AGENTS.md): a shimmed crypto block must not be reported as
integrated.

If Verilator or cocotb is unavailable, or the OpenTitan checkout is absent, the
gate reports BLOCKED with the missing dependency and exits non-zero.
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
REPORT = ROOT / "build/reports/rot_integration.json"
OT_MANIFEST = ROOT / "external/opentitan/pin-manifest.json"
OT_CHECKOUT = ROOT / "external/opentitan/opentitan"
IBEX_FLIST = ROOT / "verify/cocotb/integration/ibex_pmc_min.f"
COCOTB_RESULTS = ROOT / "verify/cocotb/rot/results.xml"

# Spine RTL (no Ibex) -- this is the scope that elaborates clean stand-alone.
SPINE_SOURCES = [
    "rtl/security/rot/e1_rot_tlul_pkg.sv",
    "rtl/security/otp/e1_otp_map.sv",
    "rtl/security/rot/e1_rot_crypto_shim.sv",
    "rtl/security/rot/e1_rot_mailbox.sv",
    "rtl/security/rot/e1_rot_reset_seq.sv",
    "rtl/security/rot/e1_rot_top.sv",
]

# Block inventory. real=True means truly elaborated from real RTL; real=False
# means a fail-closed E1 integration shim (e1_rot_crypto_shim) with the named
# missing dependency. Order of the shimmed crypto blocks MUST match CRYPTO_ID in
# rtl/security/rot/e1_rot_top.sv.
MISSING_OT_DEP = (
    "OpenTitan top_earlgrey topgen/fusesoc-generated reg packages "
    "(*_reg_pkg.sv / *_reg_top.sv) + the full prim/secded/mubi/lc/keymgr "
    "package elaboration chain; vendored at the pin but not yet staged into a "
    "Verilator-elaborable filelist for this block"
)
BLOCKS = [
    {"name": "ibex_rv32imc", "real": True,
     "detail": "lowRISC ibex_top from the FuseSoC-staged tree "
               "(external/ibex/ibex/build, shared with the PMC lane); "
               "elaborated under E1_ROT_INSTANTIATE_IBEX."},
    {"name": "rot_sram_maskrom", "real": True,
     "detail": "E1 behavioral RoT instruction/data SRAM + mask-ROM region in "
               "e1_rot_top.sv."},
    {"name": "e1_otp_map", "real": True,
     "detail": "W4 OTP controller (rtl/security/otp/e1_otp_map.sv), "
               "instantiated for real with 2-of-3 majority + parity fault."},
    {"name": "e1_rot_mailbox", "real": True,
     "detail": "AP<->RoT TL-UL mailbox; round-trip + AP-isolation proven by "
               "cocotb."},
    {"name": "e1_rot_reset_seq", "real": True,
     "detail": "Cold-boot reset sequencer; fail-closed reset-release proven by "
               "cocotb."},
    {"name": "e1_lc_ctrl", "real": True,
     "detail": "W5 lifecycle binding: the OTP lifecycle one-hot drives the "
               "reset-release SCRAP gating directly; the W5 controller binds by "
               "name under E1_ROT_HAVE_LC_CTRL when present."},
    {"name": "rom_ctrl", "real": False, "missing": MISSING_OT_DEP},
    {"name": "keymgr", "real": False, "missing": MISSING_OT_DEP},
    {"name": "kmac", "real": False, "missing": MISSING_OT_DEP},
    {"name": "hmac", "real": False, "missing": MISSING_OT_DEP},
    {"name": "aes", "real": False, "missing": MISSING_OT_DEP},
    {"name": "csrng", "real": False, "missing": MISSING_OT_DEP},
    {"name": "edn", "real": False, "missing": MISSING_OT_DEP},
    {"name": "entropy_src", "real": False, "missing": MISSING_OT_DEP},
    {"name": "alert_handler", "real": False, "missing": MISSING_OT_DEP},
]

EXPECTED_COCOTB_TESTS = (
    "rot_released_first_cores_held",
    "cores_released_on_verified_boot",
    "cores_stay_in_reset_when_not_verified",
    "scrap_latches_halt_and_never_releases",
    "mailbox_request_response_roundtrip",
    "ap_cannot_write_response_bank",
)


def _verilator() -> str | None:
    v = shutil.which("verilator")
    if v:
        return v
    oss = ROOT / "external/oss-cad-suite/bin/verilator"
    return str(oss) if oss.is_file() else None


def _now() -> str:
    return _dt.datetime.now(_dt.UTC).isoformat()


def check_pin() -> dict:
    """Resolve the OpenTitan pin manifest: checkout present and HEAD == pin."""
    if not OT_MANIFEST.is_file():
        return {"id": "opentitan_pin", "status": "blocked",
                "detail": f"manifest missing: {OT_MANIFEST.relative_to(ROOT)}"}
    manifest = json.loads(OT_MANIFEST.read_text())
    if manifest.get("license") != "Apache-2.0":
        return {"id": "opentitan_pin", "status": "fail",
                "detail": "OpenTitan license must be Apache-2.0"}
    if not OT_CHECKOUT.is_dir():
        return {"id": "opentitan_pin", "status": "blocked",
                "detail": "external/opentitan/opentitan absent; run "
                          "scripts/bootstrap_opentitan.sh"}
    try:
        head = subprocess.check_output(
            ["git", "-C", str(OT_CHECKOUT), "rev-parse", "HEAD"],
            text=True, stderr=subprocess.PIPE).strip()
    except subprocess.CalledProcessError as exc:
        return {"id": "opentitan_pin", "status": "blocked",
                "detail": f"rev-parse failed: {exc.stderr.strip()}"}
    pin = manifest.get("upstream_commit_pinned", "")
    if head != pin:
        return {"id": "opentitan_pin", "status": "fail",
                "detail": f"HEAD={head[:12]} != pin={pin[:12]}"}
    for rel in manifest.get("minimum_required_files", []):
        if not (ROOT / rel).is_file():
            return {"id": "opentitan_pin", "status": "blocked",
                    "detail": f"missing required file {rel}"}
    return {"id": "opentitan_pin", "status": "pass",
            "detail": f"HEAD={head[:12]} matches pin ({manifest['upstream_tag_pinned']})"}


def _lint(verilator: str, sources: list[str], extra: list[str]) -> tuple[bool, str]:
    cmd = [verilator, "--lint-only", "-Wall", "-Wno-DECLFILENAME",
           "-Wno-UNUSEDPARAM", *extra,
           *[str(ROOT / s) for s in sources], "--top-module", "e1_rot_top"]
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT)
    warns = [ln for ln in proc.stderr.splitlines()
             if "%Warning" in ln or "%Error" in ln]
    return (proc.returncode == 0 and not warns), "\n".join(warns[:8])


def check_elaborate_spine(verilator: str) -> dict:
    ok, msg = _lint(verilator, SPINE_SOURCES, [])
    if ok:
        return {"id": "elaborate_spine", "status": "pass",
                "detail": "e1_rot_top spine (Ibex undefined) lints clean"}
    return {"id": "elaborate_spine", "status": "fail",
            "detail": f"spine lint failed: {msg}"}


def check_elaborate_ibex(verilator: str) -> dict:
    if not IBEX_FLIST.is_file():
        return {"id": "elaborate_ibex", "status": "blocked",
                "detail": f"{IBEX_FLIST.relative_to(ROOT)} missing; run "
                          "scripts/bootstrap_ibex.sh"}
    incdirs, ibex_src = [], []
    for line in IBEX_FLIST.read_text().splitlines():
        line = line.strip()
        if line.startswith("+incdir+"):
            incdirs.append("+incdir+" + str(ROOT / line[len("+incdir+"):]))
        elif line and not line.startswith(("#", "+")):
            ibex_src.append(str(ROOT / line))
    missing = [p for p in ibex_src if not Path(p).is_file()]
    if missing:
        return {"id": "elaborate_ibex", "status": "blocked",
                "detail": f"{len(missing)} staged Ibex source(s) absent; run "
                          "scripts/bootstrap_ibex.sh (e.g. {})".format(
                              Path(missing[0]).name)}
    waivers = ["-Wno-PINMISSING", "-Wno-WIDTHTRUNC", "-Wno-WIDTHEXPAND",
               "-Wno-CASEINCOMPLETE", "-Wno-LATCH", "-Wno-ASCRANGE",
               "-Wno-MULTIDRIVEN", "-Wno-CMPCONST", "-Wno-UNUSEDGENVAR",
               "-Wno-CONSTRAINTIGN", "-Wno-UNUSEDSIGNAL", "-Wno-UNOPTFLAT",
               "-Wno-SYNCASYNCNET", "-Wno-PINCONNECTEMPTY", "-Wno-TIMESCALEMOD",
               "+define+E1_ROT_INSTANTIATE_IBEX", "+define+SYNTHESIS",
               *incdirs]
    cmd = [verilator, "--lint-only", "-Wno-fatal", "-Wall", *waivers,
           *ibex_src, *[str(ROOT / s) for s in SPINE_SOURCES],
           "--top-module", "e1_rot_top"]
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT)
    bad = [ln for ln in proc.stderr.splitlines() if "%Error" in ln]
    if proc.returncode == 0 and not bad:
        return {"id": "elaborate_ibex", "status": "pass",
                "detail": f"e1_rot_top + real Ibex ({len(ibex_src)} src) "
                          "elaborates clean (upstream lint waivers applied)"}
    return {"id": "elaborate_ibex", "status": "fail",
            "detail": "Ibex-build elaboration failed: " + "\n".join(bad[:6])}


def check_cocotb() -> dict:
    rc = subprocess.run(["make", "-C", str(ROOT / "verify/cocotb/rot")],
                        capture_output=True, text=True, cwd=ROOT)
    if not COCOTB_RESULTS.is_file():
        return {"id": "cocotb_reset_release_mailbox", "status": "blocked",
                "detail": "no results.xml; cocotb/verilator unavailable. "
                          + rc.stderr.splitlines()[-1] if rc.stderr else ""}
    tree = ET.parse(COCOTB_RESULTS)
    seen, failed = set(), []
    for tc in tree.iter("testcase"):
        name = tc.get("name", "")
        seen.add(name)
        if tc.find("failure") is not None or tc.find("error") is not None:
            failed.append(name)
    missing = [t for t in EXPECTED_COCOTB_TESTS if t not in seen]
    if failed or missing:
        return {"id": "cocotb_reset_release_mailbox", "status": "fail",
                "detail": f"failed={failed} missing={missing}"}
    return {"id": "cocotb_reset_release_mailbox", "status": "pass",
            "detail": f"{len(EXPECTED_COCOTB_TESTS)} reset-release + mailbox "
                      "tests passed"}


def main() -> int:
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    checks = [check_pin()]

    verilator = _verilator()
    if verilator is None:
        checks.append({"id": "elaborate_spine", "status": "blocked",
                       "detail": "verilator not found; install oss-cad-suite"})
        checks.append({"id": "elaborate_ibex", "status": "blocked",
                       "detail": "verilator not found"})
    else:
        checks.append(check_elaborate_spine(verilator))
        checks.append(check_elaborate_ibex(verilator))
    checks.append(check_cocotb())

    real_blocks = [b["name"] for b in BLOCKS if b["real"]]
    shimmed = [{"block": b["name"], "missing_dependency": b["missing"]}
               for b in BLOCKS if not b["real"]]

    # Gate verdict. Fail-closed: any non-pass check, or any shimmed security
    # block, prevents a PASS. Shimmed blocks downgrade the gate to BLOCKED with
    # the named dependency rather than FAIL (the spine is real; the missing
    # crypto is a vendoring-depth blocker, not a regression).
    has_fail = any(c["status"] == "fail" for c in checks)
    has_block = any(c["status"] == "blocked" for c in checks)

    if has_fail:
        status, blocker_id, blocker_reason = "FAIL", "rot_check_failure", \
            "; ".join(f"{c['id']}: {c['detail']}"
                      for c in checks if c["status"] == "fail")
    elif has_block:
        status, blocker_id = "BLOCKED", "rot_dependency_missing"
        blocker_reason = "; ".join(f"{c['id']}: {c['detail']}"
                                   for c in checks if c["status"] == "blocked")
    elif shimmed:
        status, blocker_id = "BLOCKED", "rot_crypto_blocks_shimmed"
        blocker_reason = (
            "Integration spine (Ibex + OTP + lifecycle + mailbox + reset "
            "sequencer) is REAL and elaborates/tests clean, but the following "
            "OpenTitan crypto/security blocks are fail-closed SHIMS, not "
            "integrated: " + ", ".join(s["block"] for s in shimmed) +
            ". Missing dependency: " + MISSING_OT_DEP)
    else:
        status, blocker_id, blocker_reason = "PASS", None, None

    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "rot-integration-check",
        "status": status,
        "blocker_id": blocker_id,
        "blocker_reason": blocker_reason,
        "evidence_paths": [
            "rtl/security/rot/e1_rot_top.sv",
            "rtl/security/rot/e1_rot_mailbox.sv",
            "rtl/security/rot/e1_rot_reset_seq.sv",
            "rtl/security/rot/e1_rot_crypto_shim.sv",
            "rtl/security/rot/e1_rot_tlul_pkg.sv",
            "verify/cocotb/test_e1_rot_top.py",
            "verify/cocotb/rot/e1_rot_top_tb.sv",
            "external/opentitan/pin-manifest.json",
            "scripts/bootstrap_opentitan.sh",
        ],
        "as_of": _now(),
        "subsystem": "security",
        "claim_boundary": (
            "The RoT INTEGRATION SPINE is real: the Ibex RV32IMC RoT core, the "
            "W4 OTP controller, the W5 lifecycle binding, the AP<->RoT TL-UL "
            "mailbox, and the fail-closed reset sequencer elaborate clean under "
            "Verilator and the reset-release + mailbox contracts pass in cocotb. "
            "The OpenTitan crypto/security blocks (rom_ctrl/keymgr/kmac/hmac/aes/"
            "csrng/edn/entropy_src/alert_handler) are vendored at the pin but "
            "bound via fail-closed E1 integration shims, NOT integrated -- they "
            "are reported BLOCKED with the named missing dependency. No secure-"
            "boot / hardware-key / attestation claim is permitted from this tree."
        ),
        "block_inventory": {
            "real": real_blocks,
            "shimmed": shimmed,
            "real_count": len(real_blocks),
            "shimmed_count": len(shimmed),
        },
        "summary": {
            "check_count": len(checks),
            "passing_check_count": sum(1 for c in checks if c["status"] == "pass"),
            "failures": [c["id"] for c in checks if c["status"] != "pass"],
        },
        "checks": checks,
    }
    REPORT.write_text(json.dumps(report, indent=2) + "\n")

    print(f"STATUS: {status} rot-integration-check -> {REPORT.relative_to(ROOT)}")
    for c in checks:
        print(f"  [{c['status'].upper():7}] {c['id']}: {c['detail']}")
    print(f"  real blocks   ({len(real_blocks)}): {', '.join(real_blocks)}")
    print(f"  shimmed blocks({len(shimmed)}): "
          f"{', '.join(s['block'] for s in shimmed)}")
    if blocker_reason:
        print(f"  blocker: {blocker_reason}")

    # Exit code: PASS -> 0; BLOCKED -> 2 (fail-closed, non-zero); FAIL -> 1.
    return {"PASS": 0, "BLOCKED": 2, "FAIL": 1}[status]


if __name__ == "__main__":
    sys.exit(main())
