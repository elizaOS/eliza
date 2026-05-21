#!/usr/bin/env python3
"""Query the traceability graph for the blast radius of a changed path.

Given a repo-relative path (e.g. ``rtl/npu/e1_npu.sv``) this walks the directed
traceability graph backwards from the matching artifact node to enumerate every
requirement, RTL gap, and gate that the change can invalidate, plus the claim
boundaries that must be re-proven.

The graph is rebuilt in-process from the canonical seed sources (no cached
artifact required) using ``scripts/build_traceability_graph.py``. The directed
graph is pure stdlib; networkx is not required.

Usage::

    python3 scripts/query_change_impact.py rtl/npu/e1_npu.sv
    python3 scripts/query_change_impact.py rtl/npu/e1_npu.sv --json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import build_traceability_graph as btg

ROOT = btg.ROOT


def _rel(path_text: str) -> str:
    candidate = Path(path_text)
    if candidate.is_absolute():
        try:
            return str(candidate.relative_to(ROOT))
        except ValueError:
            return path_text
    return path_text


def find_artifact_nodes(graph: btg.DiGraph, path_text: str) -> list[str]:
    """Return every node whose ``path`` attribute matches ``path_text``."""
    matches = [
        node_id
        for node_id, attrs in graph.nodes.items()
        if attrs.get("path") == path_text
    ]
    return sorted(matches)


def compute_impact(graph: btg.DiGraph, path_text: str) -> dict[str, Any]:
    artifact_nodes = find_artifact_nodes(graph, path_text)
    reachable: set[str] = set()
    for node_id in artifact_nodes:
        reachable |= graph.reachable_predecessors(node_id)

    requirements: list[dict[str, Any]] = []
    gates: set[str] = set()
    gaps: list[dict[str, Any]] = []
    claim_boundaries: set[str] = set()

    for node_id in sorted(reachable):
        attrs = graph.nodes[node_id]
        kind = attrs.get("kind")
        if kind == "requirement":
            req_gates = sorted(
                graph.nodes[dst]["name"]
                for dst, relation in graph.successors(node_id)
                if relation == "validated_by" and "name" in graph.nodes.get(dst, {})
            )
            gates.update(req_gates)
            requirements.append(
                {
                    "id": node_id,
                    "title": attrs.get("title"),
                    "owner": attrs.get("owner"),
                    "status": attrs.get("status"),
                    "claim_boundary": attrs.get("claim_boundary"),
                    "gates": req_gates,
                }
            )
            if attrs.get("claim_boundary"):
                claim_boundaries.add(attrs["claim_boundary"])
        elif kind == "rtl_gap":
            gap_gates = sorted(
                graph.nodes[dst]["name"]
                for dst, relation in graph.successors(node_id)
                if relation == "validated_by" and "name" in graph.nodes.get(dst, {})
            )
            gaps.append(
                {
                    "gap_id": attrs.get("gap_id"),
                    "area": attrs.get("area"),
                    "severity": attrs.get("severity"),
                    "category": attrs.get("category"),
                }
            )
            gates.update(gap_gates)

    return {
        "schema": "eliza.change_impact.v1",
        "changed_path": path_text,
        "path_exists": (ROOT / path_text).exists(),
        "artifact_nodes": artifact_nodes,
        "invalidated_requirements": requirements,
        "invalidated_gaps": gaps,
        "invalidated_gates": sorted(gates),
        "claim_boundaries_to_reprove": sorted(claim_boundaries),
        "impact_count": len(requirements) + len(gaps),
    }


def render_text(impact: dict[str, Any]) -> str:
    lines = [f"change-impact: {impact['changed_path']}"]
    if not impact["path_exists"]:
        lines.append("  note: path does not currently exist in the package")
    if not impact["artifact_nodes"]:
        lines.append("  no traceability node references this path (no recorded impact)")
        return "\n".join(lines)
    lines.append(f"  artifact nodes: {', '.join(impact['artifact_nodes'])}")
    lines.append(f"  invalidated requirements ({len(impact['invalidated_requirements'])}):")
    for req in impact["invalidated_requirements"]:
        gates = ", ".join(req["gates"]) or "-"
        lines.append(f"    {req['id']} [{req['owner']}/{req['status']}] {req['title']}")
        lines.append(f"      gates: {gates}")
        lines.append(f"      claim_boundary: {req['claim_boundary']}")
    if impact["invalidated_gaps"]:
        lines.append(f"  invalidated RTL gaps ({len(impact['invalidated_gaps'])}):")
        for gap in impact["invalidated_gaps"]:
            lines.append(
                f"    {gap['gap_id']} [{gap['area']}/{gap['severity']}] {gap['category']}"
            )
    lines.append(f"  gates to re-run ({len(impact['invalidated_gates'])}): "
                 + (", ".join(impact["invalidated_gates"]) or "-"))
    return "\n".join(lines)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", help="repo-relative changed path, e.g. rtl/npu/e1_npu.sv")
    parser.add_argument("--json", action="store_true", help="emit JSON instead of text")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        built = btg.build()
    except btg.TraceabilityError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    impact = compute_impact(built["graph"], _rel(args.path))
    if args.json:
        print(json.dumps(impact, indent=2, sort_keys=True))
    else:
        print(render_text(impact))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
