#!/usr/bin/env python3
"""Fail-closed traceability gate for the E1 requirement registry.

Builds the traceability graph from the canonical seed sources and enforces:

* Every requirement link (``rtl`` / ``tests`` / ``pd_evidence`` /
  ``mfg_artifacts``) resolves to a real file in the package.
* Every requirement has at least one link or a valid waiver (no orphans).
* Every gate a requirement declares exists in the aggregator GATES inventory.
* Every waiver carries ``owner`` / ``reason`` / ``expiry`` and has not expired.
* Every recorded ``source_doc_sha`` still matches the source document (drift
  detection): a changed source doc with a stale recorded hash fails closed.

It also emits a coverage dashboard at
``docs/spec-db/traceability/coverage.json`` (``eliza.traceability_coverage.v1``)
that extends the tapeout-readiness model with per-requirement closure %. Closure
% is the share of the requirement's expected closure dimensions (RTL, tests,
PD evidence, gates) that are populated and resolve. This is a structural
completeness metric, not a silicon or signoff claim.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path
from typing import Any

import build_traceability_graph as btg

ROOT = btg.ROOT
COVERAGE_PATH = btg.TRACEABILITY_DIR / "coverage.json"
COVERAGE_SCHEMA = "eliza.traceability_coverage.v1"
CLAIM_BOUNDARY = "traceability_closure_is_structural_completeness_not_silicon_or_signoff"

# Dimensions that count toward per-requirement structural closure.
CLOSURE_DIMENSIONS = ("rtl", "tests", "pd_evidence", "gates")


def _rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def _sha256_prefix(path: Path, length: int) -> str:
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    return digest[:length]


def check_links(req: dict[str, Any], errors: list[str]) -> dict[str, Any]:
    """Validate that every declared link resolves; return per-dimension stats."""
    resolved: dict[str, int] = {}
    declared: dict[str, int] = {}
    for kind in btg.LINK_KINDS:
        bucket = req["links"][kind]
        declared[kind] = len(bucket)
        ok = 0
        for path_text in bucket:
            if (ROOT / path_text).is_file():
                ok += 1
            else:
                errors.append(f"{req['id']}: dangling {kind} link -> {path_text} (file missing)")
        resolved[kind] = ok
    return {"declared": declared, "resolved": resolved}


def check_gates(req: dict[str, Any], gate_names: set[str], errors: list[str]) -> int:
    resolved = 0
    for gate_name in req["gates"]:
        if gate_name in gate_names:
            resolved += 1
        else:
            errors.append(
                f"{req['id']}: declared gate '{gate_name}' is not in the aggregator GATES inventory"
            )
    return resolved


def check_source_doc(req: dict[str, Any], errors: list[str]) -> None:
    source = ROOT / req["source_doc"]
    if not source.is_file():
        errors.append(f"{req['id']}: source_doc missing -> {req['source_doc']}")
        return
    recorded = req["source_doc_sha"]
    actual = _sha256_prefix(source, len(recorded))
    if actual != recorded:
        errors.append(
            f"{req['id']}: source_doc_sha drift for {req['source_doc']} "
            f"(recorded {recorded}, actual {actual}) — update the registry after review"
        )


def check_waiver(req: dict[str, Any], today: date, errors: list[str]) -> bool:
    """Return True if a valid (non-expired) waiver is present."""
    waiver = req["waiver"]
    if waiver is None:
        return False
    try:
        expiry = date.fromisoformat(waiver["expiry"])
    except ValueError:
        errors.append(f"{req['id']}: waiver.expiry is not an ISO date: {waiver['expiry']}")
        return False
    if expiry < today:
        errors.append(
            f"{req['id']}: waiver expired on {waiver['expiry']} "
            f"(owner={waiver['owner']}, reason={waiver['reason']})"
        )
        return False
    return True


def compute_closure(link_stats: dict[str, Any], gate_resolved: int, gate_declared: int) -> float:
    """Fraction of closure dimensions that are populated and fully resolved."""
    declared = link_stats["declared"]
    resolved = link_stats["resolved"]
    score = 0.0
    for kind in ("rtl", "tests", "pd_evidence"):
        if declared[kind] > 0 and resolved[kind] == declared[kind]:
            score += 1.0
    if gate_declared > 0 and gate_resolved == gate_declared:
        score += 1.0
    return round(score / len(CLOSURE_DIMENSIONS), 4)


def build_coverage(
    requirements: list[dict[str, Any]],
    gate_names: set[str],
    today: date,
) -> tuple[dict[str, Any], list[str]]:
    errors: list[str] = []
    per_requirement: list[dict[str, Any]] = []
    by_domain: dict[str, list[float]] = defaultdict(list)
    waived = 0

    for req in requirements:
        link_stats = check_links(req, errors)
        gate_resolved = check_gates(req, gate_names, errors)
        check_source_doc(req, errors)
        has_valid_waiver = check_waiver(req, today, errors)
        if has_valid_waiver:
            waived += 1

        total_links = sum(link_stats["declared"].values())
        if total_links == 0 and not req["gates"] and not has_valid_waiver:
            errors.append(
                f"{req['id']}: orphan requirement (no links and no gates); "
                f"add links/gates or a reviewed waiver"
            )

        closure = compute_closure(link_stats, gate_resolved, len(req["gates"]))
        by_domain[req["domain"]].append(closure)
        per_requirement.append(
            {
                "id": req["id"],
                "domain": req["domain"],
                "owner": req["owner"],
                "status": req["status"],
                "closure_pct": round(closure * 100, 2),
                "links_declared": link_stats["declared"],
                "links_resolved": link_stats["resolved"],
                "gates_declared": len(req["gates"]),
                "gates_resolved": gate_resolved,
                "waived": has_valid_waiver,
                "claim_boundary": req["claim_boundary"],
            }
        )

    domain_summary = {
        domain: round(sum(scores) / len(scores) * 100, 2)
        for domain, scores in sorted(by_domain.items())
    }
    overall = (
        round(
            sum(r["closure_pct"] for r in per_requirement) / len(per_requirement),
            2,
        )
        if per_requirement
        else 0.0
    )
    coverage = {
        "schema": COVERAGE_SCHEMA,
        "as_of": today.isoformat(),
        "claim_boundary": CLAIM_BOUNDARY,
        "summary": {
            "requirements": len(requirements),
            "waived": waived,
            "overall_closure_pct": overall,
            "closure_pct_by_domain": domain_summary,
        },
        "requirements": per_requirement,
    }
    return coverage, errors


def write_coverage(coverage: dict[str, Any]) -> None:
    btg.TRACEABILITY_DIR.mkdir(parents=True, exist_ok=True)
    COVERAGE_PATH.write_text(json.dumps(coverage, indent=2, sort_keys=True) + "\n")


def run(write: bool = True, today: date | None = None) -> tuple[int, dict[str, Any], list[str]]:
    today = today or date.today()
    try:
        built = btg.build()
    except btg.TraceabilityError as exc:
        return 1, {}, [str(exc)]
    requirements = built["requirements"]
    gate_names = {g["name"] for g in built["gate_specs"]}
    coverage, errors = build_coverage(requirements, gate_names, today)
    if write:
        btg.write_outputs(built["serialized"], requirements)
        write_coverage(coverage)
    return (1 if errors else 0), coverage, errors


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--no-write",
        action="store_true",
        help="validate only; do not (re)write graph/matrix/coverage artifacts",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    code, coverage, errors = run(write=not args.no_write)
    if errors:
        for line in errors:
            print(f"FAIL: {line}", file=sys.stderr)
        print(f"FAIL: traceability gate found {len(errors)} issue(s)", file=sys.stderr)
        return code
    summary = coverage["summary"]
    print(
        f"STATUS: PASS traceability {_rel(COVERAGE_PATH)} "
        f"(requirements={summary['requirements']} waived={summary['waived']} "
        f"overall_closure={summary['overall_closure_pct']}%)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
