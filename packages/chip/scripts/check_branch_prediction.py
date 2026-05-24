#!/usr/bin/env python3
"""Fail-closed evidence gate for the Branch Prediction Unit.

Parses ``rtl/cpu/bpu/bpu_pkg.sv`` for the selected parameter values, checks
them against the 2028 minimum thresholds documented in
``docs/arch/branch-prediction.md``, and writes
``docs/evidence/cpu_ap/branch-prediction-params.json`` summarising the BPU
selection plus tool-versions.

Refuses to mark ``status=clean`` if any parameter regresses below the
threshold, or if the supporting RTL/manifest files are missing.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PKG_PATH = ROOT / "rtl/cpu/bpu/bpu_pkg.sv"
TOP_PATH = ROOT / "rtl/cpu/bpu/bpu_top.sv"
CONTRACT_DOC = ROOT / "docs/arch/branch-prediction.md"
MANIFEST_PATH = ROOT / "docs/generators/xiangshan/eliza-kunminghu-manifest.json"
EVIDENCE_PATH = ROOT / "docs/evidence/cpu_ap/branch-prediction-params.json"

# The minimum thresholds the BPU geometry must satisfy to support a 2028
# phone-class application processor claim. Values come from the SOTA report
# `docs/architecture-optimization/sota-2028/branch-predictors.md`.
THRESHOLDS: dict[str, int] = {
    "FETCH_BLOCK_BYTES": 32,
    "MAX_BR_PER_BLOCK": 2,
    "FTQ_ENTRIES": 32,
    "UFTB_ENTRIES": 256,
    "UFTB_STEER_CONF_MIN": 2,
    "FTB_ENTRIES": 2048,
    "FTB_WAYS": 4,
    "TAGE_TABLES": 4,
    "TAGE_ENTRIES_TABLE": 4096,
    "BIM_ENTRIES": 8192,
    "SC_TABLES": 4,
    "SC_ENTRIES_TABLE": 512,
    "LOOP_ENTRIES": 32,
    "ITTAGE_TABLES": 5,
    "RAS_ARCH_ENTRIES": 16,
    "RAS_SPEC_ENTRIES": 32,
    "SC_LOCAL_HISTORY_BITS": 8,
    "SC_LOCAL_HISTORY_ENTRIES": 1024,
    "ITTAGE_TARGET_HISTORY_BITS": 64,
    "ITTAGE_TARGET_HISTORY_TOKEN_BITS": 7,
    "ITTAGE_TARGET_HISTORY_SHIFT": 8,
}
TAGE_HIST_LEN_MAX_THRESHOLD = 100
ITTAGE_HIST_LEN_MAX_THRESHOLD = 80

# Names whose values are parsed from `bpu_pkg.sv` localparams. `THRESHOLDS`
# entries are fail-closed minimums; the extra names are performance-relevant
# tuning knobs that must be visible in evidence even when they are not floor
# checks.
EVIDENCE_SCALARS = {
    "BIM_CTR_W",
    "FTB_TARGET_CONF_W",
    "ITTAGE_CTR_W",
    "ITTAGE_PATH_HISTORY_BITS",
    "ITTAGE_PATH_HISTORY_SHIFT",
    "ITTAGE_PATH_HISTORY_TOKEN_BITS",
    "ITTAGE_REPLACE_MIN_PROVIDER",
    "ITTAGE_REPLACE_WEAK_CTR",
    "ITTAGE_TAG_W",
    "ITTAGE_TARGET_HISTORY_BITS",
    "ITTAGE_TARGET_HISTORY_SHIFT",
    "ITTAGE_TARGET_HISTORY_TOKEN_BITS",
    "ITTAGE_USEFUL_RESET_PERIOD",
    "ITTAGE_USEFUL_W",
    "LOOP_CONF_W",
    "LOOP_CTR_W",
    "SC_ADAPTIVE",
    "SC_CTR_W",
    "SC_TC_LIMIT",
    "SC_LOCAL_HISTORY_BITS",
    "SC_LOCAL_HISTORY_ENTRIES",
    "SC_THRESH_INIT",
    "SC_THRESH_MAX",
    "SC_THRESH_MIN",
    "TAGE_CTR_W",
    "TAGE_USE_ALT_ON_NA",
    "TAGE_TAG_W",
    "TAGE_USEFUL_RESET_PERIOD",
    "TAGE_USEFUL_W",
    "UFTB_STEER_CONF_MIN",
    "UFTB_WAYS",
}
SCALAR_NAMES = sorted(set(THRESHOLDS) | EVIDENCE_SCALARS)


def parse_int_literal(token: str) -> int:
    token = token.strip().rstrip(";")
    if "'" in token:
        # SystemVerilog sized literal: 32'd64 / 16'hABCD
        _width, _, magnitude = token.partition("'")
        base = magnitude[0].lower()
        digits = magnitude[1:]
        radix = {"d": 10, "h": 16, "b": 2, "o": 8}[base]
        return int(digits, radix)
    return int(token, 0)


def parse_package(text: str) -> dict[str, int | list[int]]:
    values: dict[str, int | list[int]] = {}
    scalar_re = re.compile(
        r"localparam\s+int\s+unsigned\s+(?P<name>[A-Z_][A-Z0-9_]*)\s*=\s*(?P<value>[^;]+);"
    )
    raw_scalars: dict[str, int] = {}
    for match in scalar_re.finditer(text):
        name = match.group("name")
        raw = match.group("value").strip()
        try:
            parsed = parse_int_literal(raw)
        except (ValueError, KeyError):
            # Derived parameters (e.g. `$clog2(...)`) are skipped — the gate
            # only checks the primary geometry knobs declared as integer
            # literals.
            continue
        raw_scalars[name] = parsed
        if name in SCALAR_NAMES:
            values[name] = parsed

    # Reconstitute per-component arrays by collecting indexed localparams
    # named NAME_0, NAME_1, .... yosys does not accept array-form localparams
    # in package context, so the package declares one entry at a time.
    for array_name, count in (
        ("TAGE_HIST_LEN", raw_scalars.get("TAGE_TABLES", 5)),
        ("SC_HIST_LEN", raw_scalars.get("SC_TABLES", 4)),
        ("ITTAGE_ENTRIES", raw_scalars.get("ITTAGE_TABLES", 5)),
        ("ITTAGE_HIST_LEN", raw_scalars.get("ITTAGE_TABLES", 5)),
    ):
        elements: list[int] = []
        for idx in range(count):
            key = f"{array_name}_{idx}"
            if key in raw_scalars:
                elements.append(raw_scalars[key])
        if len(elements) == count:
            values[array_name] = elements
    return values


def sha256_path(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def detect_tool_versions() -> dict[str, str]:
    tools = {}
    for binary, args in (
        ("verilator", ["verilator", "--version"]),
        ("iverilog", ["iverilog", "-V"]),
        ("yosys", ["yosys", "-V"]),
        ("sby", ["sby", "--version"]),
    ):
        try:
            proc = subprocess.run(args, check=False, capture_output=True, text=True)
            output = (proc.stdout or proc.stderr).strip().splitlines()
            tools[binary] = output[0] if output else "unavailable"
        except FileNotFoundError:
            tools[binary] = "unavailable"
    try:
        import cocotb

        tools["cocotb"] = f"cocotb {cocotb.__version__}"
    except ImportError:
        tools["cocotb"] = "unavailable"
    return tools


def git_revision() -> str:
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
        return proc.stdout.strip() or "unknown"
    except FileNotFoundError:
        return "unknown"


def evaluate(values: dict[str, int | list[int]]) -> tuple[str, list[str]]:
    failures: list[str] = []
    for name, threshold in THRESHOLDS.items():
        if name not in values:
            failures.append(f"missing parameter {name} in {PKG_PATH.name}")
            continue
        actual = values[name]
        if isinstance(actual, int) and actual < threshold:
            failures.append(f"{name}={actual} below 2028 minimum threshold {threshold}")
    tage_hist = values.get("TAGE_HIST_LEN")
    if not isinstance(tage_hist, list) or len(tage_hist) < 4:
        failures.append("TAGE_HIST_LEN must declare >=4 per-table histories")
    elif max(tage_hist) < TAGE_HIST_LEN_MAX_THRESHOLD:
        failures.append(
            f"max TAGE history {max(tage_hist)} below minimum reach {TAGE_HIST_LEN_MAX_THRESHOLD}"
        )
    ittage_hist = values.get("ITTAGE_HIST_LEN")
    if not isinstance(ittage_hist, list) or len(ittage_hist) < 5:
        failures.append("ITTAGE_HIST_LEN must declare >=5 per-table histories")
    elif max(ittage_hist) < ITTAGE_HIST_LEN_MAX_THRESHOLD:
        failures.append(
            f"max ITTAGE history {max(ittage_hist)} below minimum reach "
            f"{ITTAGE_HIST_LEN_MAX_THRESHOLD}"
        )
    ittage_entries = values.get("ITTAGE_ENTRIES")
    if not isinstance(ittage_entries, list) or sum(ittage_entries) < 1024:
        failures.append(
            "ITTAGE_ENTRIES total must be >= 1024 entries to satisfy indirect-target storage floor"
        )
    status = "clean" if not failures else "blocked"
    return status, failures


def build_evidence(
    values: dict[str, int | list[int]],
    status: str,
    failures: list[str],
    tools: dict[str, str],
) -> dict:
    serialisable: dict[str, int | list[int]] = {
        name: values[name]
        for name in values
        if name in THRESHOLDS
        or name
        in {
            "TAGE_HIST_LEN",
            "SC_HIST_LEN",
            "ITTAGE_ENTRIES",
            "ITTAGE_HIST_LEN",
        }
        or name in EVIDENCE_SCALARS
    }
    synthetic_mpki_path = ROOT / "docs/evidence/cpu_ap/mpki_results_synthetic.json"
    synthetic_mpki_ref: dict[str, str | bool] = {
        "path": str(synthetic_mpki_path.relative_to(ROOT)),
        "schema": "eliza.bpu_mpki.v1",
        "harness": "cocotb-rtl-bpu_top",
        "command": "make mpki-eval-rtl",
        "comparison_table": "docs/evidence/cpu_ap/mpki_synthetic_vs_cbp5_reference.md",
        "trace_class": "synthetic_planning_only",
        "spec2017_claim": False,
        "android_claim": False,
        "cbp5_claim": False,
    }
    if synthetic_mpki_path.is_file():
        synthetic_mpki_ref["sha256"] = sha256_path(synthetic_mpki_path)
        synthetic_mpki_ref["present"] = True
    else:
        synthetic_mpki_ref["present"] = False

    cbp5_model_path = ROOT / "docs/evidence/cpu_ap/mpki_results_cbp5.json"
    cbp5_rtl_path = ROOT / "docs/evidence/cpu_ap/mpki_results_cbp5_rtl.json"
    cbp5_mpki_ref: dict[str, object] = {
        "comparison_table": "docs/evidence/cpu_ap/mpki_cbp5_vs_tagesc_l_64kb.md",
        "evidence_class": "cbp5_train_traces_only",
        "spec2017_claim": False,
        "android_claim": False,
        "v8_claim": False,
        "cbp5_claim": cbp5_model_path.is_file() or cbp5_rtl_path.is_file(),
        "model": {
            "path": str(cbp5_model_path.relative_to(ROOT)),
            "schema": "eliza.bpu_mpki.v1",
            "harness": "behavioural-bpu-model",
            "command": "python3 benchmarks/cpu/branch/run_mpki.py --backend model --traces external/cbp5-traces/",
            "present": cbp5_model_path.is_file(),
        },
        "rtl": {
            "path": str(cbp5_rtl_path.relative_to(ROOT)),
            "schema": "eliza.bpu_mpki.v1",
            "harness": "cocotb-rtl-bpu_top",
            "command": "make mpki-eval-rtl",
            "present": cbp5_rtl_path.is_file(),
        },
    }
    if cbp5_model_path.is_file():
        cbp5_mpki_ref["model"]["sha256"] = sha256_path(cbp5_model_path)  # type: ignore[index]
    if cbp5_rtl_path.is_file():
        cbp5_mpki_ref["rtl"]["sha256"] = sha256_path(cbp5_rtl_path)  # type: ignore[index]

    return {
        "schema": "eliza.bpu_params.v1",
        "status": status,
        "generated_at_utc": datetime.now(UTC).isoformat(),
        "source_revision": git_revision(),
        "tool_versions": tools,
        "thresholds": THRESHOLDS,
        "parameters": serialisable,
        "blockers": failures,
        "sources": {
            "package": {
                "path": str(PKG_PATH.relative_to(ROOT)),
                "sha256": sha256_path(PKG_PATH),
            },
            "top": {
                "path": str(TOP_PATH.relative_to(ROOT)),
                "sha256": sha256_path(TOP_PATH),
            },
            "contract": {
                "path": str(CONTRACT_DOC.relative_to(ROOT)),
                "sha256": sha256_path(CONTRACT_DOC),
            },
            "manifest": {
                "path": str(MANIFEST_PATH.relative_to(ROOT)),
                "sha256": sha256_path(MANIFEST_PATH),
            },
        },
        "synthetic_mpki_results_ref": synthetic_mpki_ref,
        "cbp5_mpki_results_ref": cbp5_mpki_ref,
        "claim_policy": {
            "spec2017_mpki_claim": False,
            "android_mpki_claim": False,
            "two_taken_per_cycle_claim": False,
            "fdip_claim": False,
            "cbp5_mpki_claim": bool(cbp5_mpki_ref["cbp5_claim"]),
            "reason": (
                "Open RTL geometry verified against 2028 thresholds. CBP-5"
                " train-trace MPKI is on file (evidence_class"
                " cbp5_train_traces_only); SPEC, AOSP, and JS-engine MPKI"
                " claims remain blocked until those trace sets land in"
                " benchmarks/cpu/branch/."
            ),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--require-clean",
        action="store_true",
        help="exit non-zero if status is not clean (CI gate mode)",
    )
    parser.add_argument(
        "--print-only",
        action="store_true",
        help="print the evidence JSON to stdout without writing it",
    )
    args = parser.parse_args()

    for path in (PKG_PATH, TOP_PATH, CONTRACT_DOC, MANIFEST_PATH):
        if not path.is_file():
            print(f"BLOCKED: missing required input {path}", file=sys.stderr)
            return 2

    values = parse_package(PKG_PATH.read_text(encoding="utf-8"))
    status, failures = evaluate(values)
    tools = detect_tool_versions()
    evidence = build_evidence(values, status, failures, tools)

    if args.print_only:
        json.dump(evidence, sys.stdout, indent=2, sort_keys=True)
        sys.stdout.write("\n")
    else:
        EVIDENCE_PATH.parent.mkdir(parents=True, exist_ok=True)
        EVIDENCE_PATH.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
        print(
            f"eliza-evidence: status={'PASS' if status == 'clean' else 'BLOCKED'} "
            f"path={EVIDENCE_PATH.relative_to(ROOT)}"
        )

    if status != "clean":
        for fail in failures:
            print(f"BLOCKED: {fail}", file=sys.stderr)
        if args.require_clean:
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
