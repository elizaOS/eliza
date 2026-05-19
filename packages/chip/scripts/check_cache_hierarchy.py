#!/usr/bin/env python3
"""Cache hierarchy claim gate.

Enforces the 2028 phone-class minimums declared in
`docs/evidence/cache/cache-evidence-gate.yaml` against the actual
parameter values in `rtl/cache/cache_pkg.sv`. Fails closed if:

- The gate YAML is missing or schema-drifted.
- Any required RTL file is missing.
- The RTL parameters declare smaller-than-minimum cache sizes.
- Any blocked claim's evidence artifact already exists (which would
  contradict the BLOCKED status).
- The arch doc loses any required token.

Writes a tiny evidence JSON to `build/reports/cache_hierarchy_gate.json`
on success so downstream gates can chain.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
GATE = ROOT / "docs/evidence/cache/cache-evidence-gate.yaml"
ARCH_DOC = ROOT / "docs/arch/cache-hierarchy.md"
CACHE_PKG = ROOT / "rtl/cache/cache_pkg.sv"
FTQ_PKG = ROOT / "rtl/cache/ftq_to_l1i_pkg.sv"
LSU_PKG = ROOT / "rtl/cache/lsu_to_l1d_pkg.sv"

REQUIRED_RTL = [
    "rtl/cache/cache_pkg.sv",
    "rtl/cache/ftq_to_l1i_pkg.sv",
    "rtl/cache/lsu_to_l1d_pkg.sv",
    "rtl/cache/l1i/e1_l1i_cache.sv",
    "rtl/cache/l1d/e1_l1d_cache.sv",
    "rtl/cache/l2/e1_l2_cache.sv",
    "rtl/cache/l3/e1_l3_cache.sv",
    "rtl/cache/slc/e1_slc.sv",
    "rtl/cache/prefetch/e1_berti_prefetcher.sv",
    "rtl/cache/prefetch/e1_fdip_l1i_prefetcher.sv",
    "rtl/cache/prefetch/e1_stride_prefetcher.sv",
    "rtl/cache/prefetch/e1_best_offset_prefetcher.sv",
    "rtl/cache/prefetch/e1_spp_prefetcher.sv",
    "rtl/cache/prefetch/e1_ipcp_prefetcher.sv",
    "rtl/cache/prefetch/e1_pythia_stub.sv",
    "rtl/cache/replacement/e1_drrip.sv",
    "rtl/cache/replacement/e1_hawkeye.sv",
    "rtl/cache/replacement/e1_mockingjay.sv",
    "rtl/cache/compression/e1_bdi_compress.sv",
    "rtl/cache/compression/e1_bdi_decompress.sv",
    "rtl/cache/coherence/tl_c_to_chi_bridge.sv",
]

REQUIRED_DOC_TOKENS = [
    "Cache hierarchy contract",
    "L1I",
    "L1D",
    "L2",
    "L3",
    "SLC",
    "SECDED",
    "MESI",
    "TileLink TL-C",
    "Mockingjay",
    "Berti",
    "FDIP",
    "BDI",
    "QoS",
    "BLOCKED until",
    "make cache-hierarchy-claim-gate",
]

REQUIRED_BLOCKED_IDS = {
    "phone_class_ipc",
    "phone_class_latency_curve",
    "phone_class_sustained_bandwidth",
    "champsim_prefetcher_sweep",
    "mockingjay_vs_lru_sweep",
    "pythia_rl_prefetcher",
    "silicon_evidence",
}


def require(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def parse_pkg_localparam(text: str, name: str) -> int | None:
    """Extract `localparam int unsigned NAME = <expr>;` and evaluate."""
    pattern = re.compile(rf"localparam\s+int\s+unsigned\s+{name}\s*=\s*([^;]+);")
    m = pattern.search(text)
    if not m:
        return None
    expr = m.group(1).strip()
    # Drop SystemVerilog-only suffixes and comments
    expr = re.sub(r"//.*", "", expr).strip()
    # Allow basic arithmetic
    try:
        # Safe-ish eval over arithmetic-only expression
        if not re.fullmatch(r"[\d\s\+\-\*/()]+", expr):
            return None
        return int(eval(expr))  # noqa: S307 - constrained char set
    except Exception:
        return None


def check_rtl_present(errors: list[str]) -> None:
    for rel in REQUIRED_RTL:
        path = ROOT / rel
        require(path.is_file(), f"missing RTL file: {rel}", errors)


def check_pkg_minimums(gate: dict, errors: list[str]) -> dict[str, int]:
    actual: dict[str, int] = {}
    if not CACHE_PKG.is_file():
        errors.append("missing rtl/cache/cache_pkg.sv")
        return actual
    text = CACHE_PKG.read_text()

    expected = {
        "L1I_SIZE_BYTES": gate["phone_2028_minimums"]["l1i_kib_min"] * 1024,
        "L1D_SIZE_BYTES": gate["phone_2028_minimums"]["l1d_kib_min"] * 1024,
        "L2_SIZE_BYTES": gate["phone_2028_minimums"]["l2_kib_min"] * 1024,
        "L3_SIZE_BYTES": gate["phone_2028_minimums"]["l3_mib_min"] * 1024 * 1024,
        "SLC_SIZE_BYTES": gate["phone_2028_minimums"]["slc_mib_min"] * 1024 * 1024,
    }
    for name, minimum in expected.items():
        value = parse_pkg_localparam(text, name)
        if value is None:
            errors.append(f"cache_pkg.sv missing or unparseable {name}")
            continue
        actual[name] = value
        if value < minimum:
            errors.append(f"cache_pkg.sv {name}={value} is below 2028 minimum {minimum}")

    # Line bytes must match the gate
    line_bytes = parse_pkg_localparam(text, "LINE_BYTES_DEFAULT")
    expected_line = gate["phone_2028_minimums"]["line_bytes"]
    if line_bytes != expected_line:
        errors.append(
            f"cache_pkg.sv LINE_BYTES_DEFAULT={line_bytes} != gate line_bytes={expected_line}"
        )
    if line_bytes is not None:
        actual["LINE_BYTES_DEFAULT"] = line_bytes

    # SECDED helpers must exist on L1D
    for token in (
        "function automatic logic [7:0] secded_encode",
        "function automatic logic secded_is_single",
        "function automatic logic secded_is_double",
    ):
        if token not in text:
            errors.append(f"cache_pkg.sv missing SECDED helper: {token}")

    # MESI enum must exist
    for token in ("MESI_I", "MESI_S", "MESI_E", "MESI_M"):
        if token not in text:
            errors.append(f"cache_pkg.sv missing MESI state: {token}")
    return actual


def check_packages(errors: list[str]) -> None:
    if not FTQ_PKG.is_file():
        errors.append("missing rtl/cache/ftq_to_l1i_pkg.sv")
    else:
        ftq = FTQ_PKG.read_text()
        for token in (
            "package e1_ftq_to_l1i_pkg",
            "ftq_prefetch_req_t",
            "paddr_line",
            "confidence",
            "branch_target",
        ):
            if token not in ftq:
                errors.append(f"ftq_to_l1i_pkg.sv missing token: {token}")

    if not LSU_PKG.is_file():
        errors.append("missing rtl/cache/lsu_to_l1d_pkg.sv")
    else:
        lsu = LSU_PKG.read_text()
        for token in (
            "package e1_lsu_to_l1d_pkg",
            "lsu_l1d_req_t",
            "lsu_l1d_resp_t",
            "is_load",
            "ecc_uncorrectable",
        ):
            if token not in lsu:
                errors.append(f"lsu_to_l1d_pkg.sv missing token: {token}")


def check_doc(errors: list[str]) -> None:
    if not ARCH_DOC.is_file():
        errors.append("missing docs/arch/cache-hierarchy.md")
        return
    text = ARCH_DOC.read_text()
    for token in REQUIRED_DOC_TOKENS:
        if token not in text:
            errors.append(f"docs/arch/cache-hierarchy.md missing token: {token}")


def check_gate_yaml(errors: list[str]) -> dict:
    if not GATE.is_file():
        errors.append("missing docs/evidence/cache/cache-evidence-gate.yaml")
        return {}
    data = yaml.safe_load(GATE.read_text())
    if not isinstance(data, dict):
        errors.append("cache-evidence-gate.yaml must be a YAML mapping")
        return {}
    require(
        data.get("schema") == "eliza.cache_hierarchy_evidence_gate.v1",
        "cache evidence gate schema drifted",
        errors,
    )
    require(
        data.get("status") == "scaffold_rtl_real_claims_blocked",
        "cache evidence gate must stay scaffold_rtl_real_claims_blocked",
        errors,
    )

    mins = data.get("phone_2028_minimums") or {}
    for key, minimum in (
        ("l1i_kib_min", 32),
        ("l1d_kib_min", 32),
        ("l2_kib_min", 256),
        ("l3_mib_min", 4),
        ("slc_mib_min", 8),
        ("line_bytes", 64),
    ):
        value = mins.get(key)
        require(
            isinstance(value, int) and value >= minimum,
            f"phone_2028_minimums.{key} must be at least {minimum}",
            errors,
        )

    blocked = data.get("blocked_real_claims") or []
    blocked_ids = {item.get("id") for item in blocked if isinstance(item, dict)}
    missing = sorted(REQUIRED_BLOCKED_IDS - blocked_ids)
    require(
        not missing,
        "cache gate missing blocked claim ids: " + ", ".join(missing),
        errors,
    )
    for item in blocked:
        if not isinstance(item, dict):
            continue
        require(
            item.get("status") == "blocked",
            f"claim {item.get('id')} must remain blocked",
            errors,
        )
        artifacts = item.get("evidence_artifacts") or []
        for artifact in artifacts:
            if not isinstance(artifact, str):
                errors.append(f"claim {item.get('id')} non-string evidence artifact")
                continue
            if (ROOT / artifact).exists():
                errors.append(f"claim {item.get('id')} is blocked but artifact exists: {artifact}")

    return data


def main() -> int:
    errors: list[str] = []
    gate = check_gate_yaml(errors)
    check_rtl_present(errors)
    actual = check_pkg_minimums(gate, errors) if gate else {}
    check_packages(errors)
    check_doc(errors)

    if errors:
        print("Cache hierarchy claim gate failed:")
        for error in errors:
            print(f"  - {error}")
        return 1

    out_dir = ROOT / "build/reports"
    out_dir.mkdir(parents=True, exist_ok=True)
    report = {
        "schema": "eliza.cache_hierarchy_gate.v1",
        "status": "pass",
        "rtl_module_count": len(REQUIRED_RTL),
        "phone_2028_minimums": gate["phone_2028_minimums"],
        "cache_pkg_actuals": actual,
        "blocked_claim_count": len(REQUIRED_BLOCKED_IDS),
    }
    (out_dir / "cache_hierarchy_gate.json").write_text(json.dumps(report, indent=2) + "\n")
    print("Cache hierarchy claim gate passed.")
    print(f"  rtl_modules: {len(REQUIRED_RTL)}")
    print(
        f"  l1i={actual.get('L1I_SIZE_BYTES')} B "
        f"l1d={actual.get('L1D_SIZE_BYTES')} B "
        f"l2={actual.get('L2_SIZE_BYTES')} B "
        f"l3={actual.get('L3_SIZE_BYTES')} B "
        f"slc={actual.get('SLC_SIZE_BYTES')} B"
    )
    print(f"  blocked_real_claims: {len(REQUIRED_BLOCKED_IDS)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
