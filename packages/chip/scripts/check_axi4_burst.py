#!/usr/bin/env python3
"""AXI4 burst evidence gate checker.

Validates docs/evidence/memory/axi4-burst-evidence-gate.yaml plus the
RTL files it scopes.  The gate is BLOCKED until every required cocotb
test exists and the AXI4 RTL has the named capabilities checked in.
"""

from __future__ import annotations

import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
GATE = ROOT / "docs/evidence/memory/axi4-burst-evidence-gate.yaml"


REQUIRED_RTL = [
    "rtl/interconnect/axi4/e1_axi4_interconnect.sv",
    "rtl/interconnect/axi4/e1_axi4_pkg.sv",
    "rtl/memory/dram_ctrl/e1_axi4_dram_model.sv",
    "rtl/memory/dram_ctrl/e1_dram_ctrl.sv",
    "rtl/interconnect/chi_bridge/e1_chi_to_axi4_bridge.sv",
]

REQUIRED_RTL_TOKENS = {
    "rtl/interconnect/axi4/e1_axi4_interconnect.sv": [
        "module e1_axi4_interconnect",
        "logic [NUM_MASTERS-1:0][ID_WIDTH-1:0]      m_awid",
        "logic [NUM_MASTERS-1:0][BURST_LEN_W-1:0]   m_awlen",
        "logic [NUM_MASTERS-1:0][3:0]               m_awcache",
        "logic [NUM_MASTERS-1:0][3:0]               m_awqos",
        "logic [NUM_MASTERS-1:0]                    m_awlock",
        "excl_mon",
        "decode_err_irq",
        "exclusive_fail_irq",
    ],
    "rtl/interconnect/axi4/e1_axi4_pkg.sv": [
        "package e1_axi4_pkg",
        "BURST_FIXED",
        "BURST_INCR",
        "BURST_WRAP",
        "RESP_EXOKAY",
        "QOS_DISPLAY_RT",
    ],
    "rtl/memory/dram_ctrl/e1_axi4_dram_model.sv": [
        "module e1_axi4_dram_model",
        "BURST_LEN_W",
        "s_wstrb",
        "s_rlast",
    ],
    "rtl/memory/dram_ctrl/e1_dram_ctrl.sv": [
        "module e1_dram_ctrl",
        "DFI 5.0",
        "TREFI_CYCLES",
        "ZQCS_INTERVAL",
        "refresh_active",
        "ecc_uncorrected_irq",
    ],
    "rtl/interconnect/chi_bridge/e1_chi_to_axi4_bridge.sv": [
        "module e1_chi_to_axi4_bridge",
        "chi_req_is_exclusive",
        "chi_req_stash",
        "CACHE_WRITE_BACK_RW",
    ],
}

REQUIRED_TEST_IDS = {
    "incr_burst_length_sweep",
    "write_strobe_partial_beat_preserves_unwritten_bytes",
    "id_ordering_per_axid",
    "decode_error_returns_decerr",
    "exclusive_read_then_write_returns_exokay_or_okay",
}

REQUIRED_ARTIFACTS = {
    "docs/evidence/memory/axi4_burst_correctness_report.json": "eliza.memory.axi4_burst_correctness.v1",
    "docs/evidence/memory/axi4_id_ordering_report.json": "eliza.memory.axi4_id_ordering.v1",
    "docs/evidence/memory/axi4_exclusive_monitor_report.json": "eliza.memory.axi4_exclusive_monitor.v1",
    "docs/evidence/memory/axi4_qos_fairness_report.json": "eliza.memory.axi4_qos_fairness.v1",
}


def require(condition: bool, msg: str, errors: list[str]) -> None:
    if not condition:
        errors.append(msg)


def main() -> int:
    errors: list[str] = []

    require(GATE.is_file(), f"missing {GATE.relative_to(ROOT)}", errors)
    if not GATE.is_file():
        for e in errors:
            print(f"  - {e}")
        return 1

    data = yaml.safe_load(GATE.read_text())
    require(isinstance(data, dict), "gate must be a YAML mapping", errors)

    require(
        data.get("schema") == "eliza.axi4_burst_evidence_gate.v1", "gate schema drifted", errors
    )
    require(
        data.get("status") == "blocked_until_evidence",
        "gate must remain blocked_until_evidence",
        errors,
    )

    for rel in REQUIRED_RTL:
        require((ROOT / rel).is_file(), f"missing RTL {rel}", errors)
    for rel, tokens in REQUIRED_RTL_TOKENS.items():
        path = ROOT / rel
        if not path.is_file():
            continue
        text = path.read_text()
        for token in tokens:
            require(token in text, f"{rel} missing token: {token}", errors)

    tests = data.get("required_tests") or []
    seen_ids = {item.get("id") for item in tests if isinstance(item, dict)}
    missing = sorted(REQUIRED_TEST_IDS - seen_ids)
    require(not missing, "required_tests missing ids: " + ", ".join(missing), errors)

    test_file = ROOT / "verify/cocotb/axi4/test_axi4_burst.py"
    require(test_file.is_file(), "verify/cocotb/axi4/test_axi4_burst.py missing", errors)
    if test_file.is_file():
        text = test_file.read_text()
        for tid in REQUIRED_TEST_IDS:
            require(tid in text, f"cocotb file missing test {tid}", errors)

    artifacts = data.get("required_artifacts") or []
    require(
        isinstance(artifacts, list) and bool(artifacts), "gate must list required_artifacts", errors
    )
    for art in artifacts:
        require(art in REQUIRED_ARTIFACTS, f"unexpected artifact {art}", errors)
        require(not (ROOT / art).exists(), f"gate is blocked but artifact exists: {art}", errors)

    schemas = data.get("required_artifact_schemas") or {}
    for art, schema in REQUIRED_ARTIFACTS.items():
        require(
            schemas.get(art) == schema,
            f"artifact schema for {art} drifted (expected {schema})",
            errors,
        )

    if errors:
        print("AXI4 burst evidence gate failed:")
        for e in errors:
            print(f"  - {e}")
        return 1

    print("AXI4 burst evidence gate passed.")
    print(f"  rtl_files: {len(REQUIRED_RTL)} required RTL units present")
    print(f"  test_ids:  {len(REQUIRED_TEST_IDS)} cocotb tests declared")
    print(f"  artifacts: {len(REQUIRED_ARTIFACTS)} BLOCKED evidence files tracked")
    return 0


if __name__ == "__main__":
    sys.exit(main())
