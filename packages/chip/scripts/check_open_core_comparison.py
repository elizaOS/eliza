#!/usr/bin/env python3
"""Fail-closed gate for the E1-vs-open-RISC-V comparison dataset.

Loads ``docs/spec-db/open-riscv-core-comparison.yaml`` and enforces the
honesty contract: every numeric cell (any mapping carrying a ``value`` key)
must declare a ``claim`` of ``measured``/``published``/``modeled``/``target``/
``blocked``, and carry the companion field that claim requires:

    measured  -> ``evidence`` path that exists on disk
    published -> non-empty ``source``
    modeled   -> ``claim_level`` from the claim ladder
    target    -> ``claim_level`` from the claim ladder
    blocked   -> non-empty ``blocker``

It also checks that the cohort actually contains CVA6 and at least one
out-of-order open core, and that ``e1_vs_ariane_verdict`` covers every axis in
``comparison_axes`` with a legal verdict. Any violation exits non-zero so the
comparison can never silently drift into unbacked claims.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
COMPARISON_PATH = ROOT / "docs/spec-db/open-riscv-core-comparison.yaml"

VALID_CLAIMS = {"measured", "published", "modeled", "target", "blocked"}
VALID_CLAIM_LEVELS = {
    "L0_RTL_UNIT",
    "L1_RTL_FULL_SOC",
    "L2_ARCH_SIM",
    "L3_FPGA",
    "L4_DEV_BOARD",
    "L5_PROTOTYPE_SILICON",
    "L6_COMPLETE_PHONE",
}
VALID_VERDICTS = {"win", "parity", "loss", "unproven"}
REQUIRED_FALSE_CLAIM_FLAGS = {
    "claim_allowed",
    "release_claim_allowed",
    "silicon_performance_claim_allowed",
    "tapeout_claim_allowed",
    "phone_performance_claim_allowed",
}


def iter_evidence_paths(evidence: Any) -> Iterator[str]:
    """Yield evidence paths from either a scalar path or a list of paths."""
    if isinstance(evidence, str):
        yield evidence
    elif isinstance(evidence, list):
        for item in evidence:
            if isinstance(item, str):
                yield item


def iter_cells(node: Any, path: str = "") -> Iterator[tuple[str, dict[str, Any]]]:
    """Yield (path, cell) for every mapping that carries a ``value`` key."""
    if isinstance(node, dict):
        if "value" in node:
            yield path, node
            return
        for key, child in node.items():
            yield from iter_cells(child, f"{path}.{key}" if path else str(key))
    elif isinstance(node, list):
        for idx, child in enumerate(node):
            yield from iter_cells(child, f"{path}[{idx}]")


def check_cell(path: str, cell: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    claim = cell.get("claim")
    if claim not in VALID_CLAIMS:
        errors.append(f"{path}: claim={claim!r} not in {sorted(VALID_CLAIMS)}")
        return errors
    if claim == "measured":
        evidence = cell.get("evidence")
        if not evidence:
            errors.append(f"{path}: measured cell missing 'evidence'")
        else:
            evidence_paths = list(iter_evidence_paths(evidence))
            if not evidence_paths:
                errors.append(f"{path}: evidence must be a path or list of paths")
            for evidence_path in evidence_paths:
                if not (ROOT / evidence_path).exists():
                    errors.append(f"{path}: evidence file not found: {evidence_path}")
    elif claim == "published":
        if not str(cell.get("source", "")).strip():
            errors.append(f"{path}: published cell missing non-empty 'source'")
    elif claim in {"modeled", "target"}:
        level = cell.get("claim_level")
        if level not in VALID_CLAIM_LEVELS:
            errors.append(f"{path}: {claim} cell claim_level={level!r} invalid")
    elif claim == "blocked":
        if not str(cell.get("blocker", "")).strip():
            errors.append(f"{path}: blocked cell missing non-empty 'blocker'")
    return errors


def check(comparison_path: Path) -> list[str]:
    errors: list[str] = []
    if not comparison_path.is_file():
        return [f"comparison dataset missing: {comparison_path}"]
    data = yaml.safe_load(comparison_path.read_text())

    if data.get("schema") != "eliza.open_riscv_core_comparison.v1":
        errors.append(f"unexpected schema: {data.get('schema')!r}")
    for key in REQUIRED_FALSE_CLAIM_FLAGS:
        if data.get(key) is not False:
            errors.append(f"{key} must be false")

    cores = data.get("cores")
    if not isinstance(cores, dict) or not cores:
        return errors + ["'cores' missing or empty"]

    # Honesty contract: every numeric cell carries a valid claim.
    for path, cell in iter_cells(cores, "cores"):
        errors.extend(check_cell(path, cell))

    # Cohort sanity: CVA6 (the Ariane reference) plus a real OoO open core.
    if "cva6" not in cores:
        errors.append("cohort missing 'cva6' (the Ariane reference core)")
    ooo_open = [
        cid
        for cid, c in cores.items()
        if not c.get("is_e1")
        and c.get("open_source")
        and c.get("microarch", {}).get("ordering") == "out-of-order"
    ]
    if not ooo_open:
        errors.append("cohort has no open out-of-order core (need BOOM/C910/XiangShan)")

    # Every comparison axis must have a covered, legal verdict.
    axes = {a["id"] for a in data.get("comparison_axes", []) if isinstance(a, dict)}
    if not axes:
        errors.append("'comparison_axes' missing or empty")
    verdicts = data.get("e1_vs_ariane_verdict", {})
    if not isinstance(verdicts, dict):
        errors.append("'e1_vs_ariane_verdict' missing")
        verdicts = {}
    for axis in sorted(axes):
        v = verdicts.get(axis)
        if not isinstance(v, dict):
            errors.append(f"verdict missing for axis '{axis}'")
            continue
        if v.get("verdict") not in VALID_VERDICTS:
            errors.append(f"axis '{axis}': verdict={v.get('verdict')!r} invalid")
        if not str(v.get("reason", "")).strip():
            errors.append(f"axis '{axis}': missing 'reason'")
        if v.get("verdict") == "win" and v.get("evidence"):
            evidence_paths = list(iter_evidence_paths(v["evidence"]))
            if not evidence_paths:
                errors.append(f"axis '{axis}': verdict evidence must be a path or list of paths")
            for evidence_path in evidence_paths:
                if not (ROOT / evidence_path).exists():
                    errors.append(f"axis '{axis}': verdict evidence not found: {evidence_path}")
    for axis in sorted(set(verdicts) - axes):
        errors.append(f"verdict for unknown axis '{axis}' (not in comparison_axes)")

    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--path", type=Path, default=COMPARISON_PATH)
    args = parser.parse_args()

    errors = check(args.path)
    rel = args.path.relative_to(ROOT) if args.path.is_relative_to(ROOT) else args.path
    if errors:
        print(f"STATUS: FAIL open-core-comparison ({rel})")
        for err in errors:
            print(f"  - {err}")
        return 1
    print(f"STATUS: OK open-core-comparison ({rel})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
