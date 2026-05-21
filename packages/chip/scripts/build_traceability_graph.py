#!/usr/bin/env python3
"""Build the E1 requirements traceability graph.

Parses the canonical requirement registry under
``docs/spec-db/requirements/*.yaml`` (schema ``eliza.requirement.v1``), the
fail-closed gate inventory in ``scripts/aggregate_tapeout_readiness.py`` (the
``GATES`` tuple), and the RTL gap work order
``verify/rtl_gap_work_order.yaml``. It emits a directed graph of

    requirement -> spec_doc / rtl / test / pd_evidence / mfg_artifact / gate

plus gap-derived ``gate -> affected RTL/test`` edges, and a self-contained
``DiGraph`` (no networkx dependency). Outputs:

* ``docs/spec-db/traceability/graph.json``  (``eliza.traceability_graph.v1``)
* ``docs/spec-db/traceability/matrix.md``   (human-readable trace matrix)

The graph is the shared data model consumed by ``scripts/check_traceability.py``
(fail-closed gate + coverage dashboard) and ``scripts/query_change_impact.py``
(reverse impact walk). This builder makes no silicon, boot, or signoff claim;
it only records edges that already exist in the seed documents.
"""

from __future__ import annotations

import importlib.util
import json
import re
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
REQUIREMENTS_DIR = ROOT / "docs/spec-db/requirements"
RTL_GAP_WORK_ORDER = ROOT / "verify/rtl_gap_work_order.yaml"
AGGREGATOR_PATH = ROOT / "scripts/aggregate_tapeout_readiness.py"
TRACEABILITY_DIR = ROOT / "docs/spec-db/traceability"
GRAPH_PATH = TRACEABILITY_DIR / "graph.json"
MATRIX_PATH = TRACEABILITY_DIR / "matrix.md"

GRAPH_SCHEMA = "eliza.traceability_graph.v1"
REQUIREMENT_SCHEMA = "eliza.requirement.v1"
CLAIM_BOUNDARY = "traceability_graph_records_existing_edges_no_silicon_or_signoff_claim"

REQUIREMENT_ID_RE = re.compile(r"^REQ-(?P<domain>[A-Z]+)-(?P<num>\d{4})$")
VALID_DOMAINS = {
    "SPEC",
    "ARCH",
    "RTL",
    "TIMING",
    "POWER",
    "DFT",
    "VERIF",
    "PKG",
    "PD",
    "MFG",
    "NODE",
}

LINK_KINDS = ("rtl", "tests", "pd_evidence", "mfg_artifacts")
# How a link bucket maps to a graph node kind.
LINK_NODE_KIND = {
    "rtl": "rtl",
    "tests": "test",
    "pd_evidence": "pd_evidence",
    "mfg_artifacts": "mfg_artifact",
}


class TraceabilityError(RuntimeError):
    """Raised when the registry is malformed enough to abort graph build."""


# --------------------------------------------------------------------------- #
# Self-contained directed graph (no third-party dependency).
# --------------------------------------------------------------------------- #
@dataclass
class DiGraph:
    """Minimal directed multigraph keyed by stable string node ids."""

    nodes: dict[str, dict[str, Any]] = field(default_factory=dict)
    _out: dict[str, list[tuple[str, str]]] = field(default_factory=lambda: defaultdict(list))
    _in: dict[str, list[tuple[str, str]]] = field(default_factory=lambda: defaultdict(list))

    def add_node(self, node_id: str, kind: str, **attrs: Any) -> None:
        existing = self.nodes.get(node_id)
        if existing is None:
            self.nodes[node_id] = {"id": node_id, "kind": kind, **attrs}
        else:
            existing.update(attrs)

    def add_edge(self, src: str, dst: str, relation: str) -> None:
        if (dst, relation) not in self._out[src]:
            self._out[src].append((dst, relation))
        if (src, relation) not in self._in[dst]:
            self._in[dst].append((src, relation))

    def successors(self, node_id: str) -> list[tuple[str, str]]:
        return list(self._out.get(node_id, ()))

    def predecessors(self, node_id: str) -> list[tuple[str, str]]:
        return list(self._in.get(node_id, ()))

    def edges(self) -> list[dict[str, str]]:
        out: list[dict[str, str]] = []
        for src, targets in self._out.items():
            for dst, relation in targets:
                out.append({"src": src, "dst": dst, "relation": relation})
        out.sort(key=lambda e: (e["src"], e["dst"], e["relation"]))
        return out

    def reachable_predecessors(self, node_id: str) -> set[str]:
        """All nodes that can reach ``node_id`` along directed edges."""
        seen: set[str] = set()
        stack = [node_id]
        while stack:
            current = stack.pop()
            for src, _relation in self.predecessors(current):
                if src not in seen:
                    seen.add(src)
                    stack.append(src)
        return seen


# --------------------------------------------------------------------------- #
# Seed loaders.
# --------------------------------------------------------------------------- #
def _rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def path_node_id(kind: str, path_text: str) -> str:
    return f"{kind}:{path_text}"


def load_requirements() -> list[dict[str, Any]]:
    """Load and validate every requirement from the registry."""
    if not REQUIREMENTS_DIR.is_dir():
        raise TraceabilityError(f"requirements registry missing: {_rel(REQUIREMENTS_DIR)}")
    requirements: list[dict[str, Any]] = []
    seen_ids: dict[str, str] = {}
    for yaml_path in sorted(REQUIREMENTS_DIR.glob("*.yaml")):
        payload = yaml.safe_load(yaml_path.read_text())
        if not isinstance(payload, dict):
            raise TraceabilityError(f"{_rel(yaml_path)}: top-level must be a mapping")
        if payload.get("schema") != REQUIREMENT_SCHEMA:
            raise TraceabilityError(
                f"{_rel(yaml_path)}: schema must be {REQUIREMENT_SCHEMA}"
            )
        file_domain = payload.get("domain")
        items = payload.get("requirements")
        if not isinstance(items, list):
            raise TraceabilityError(f"{_rel(yaml_path)}: requirements must be a list")
        for raw in items:
            req = _normalize_requirement(raw, file_domain, yaml_path)
            req_id = req["id"]
            if req_id in seen_ids:
                raise TraceabilityError(
                    f"duplicate requirement id {req_id} in {_rel(yaml_path)} "
                    f"(first seen in {seen_ids[req_id]})"
                )
            seen_ids[req_id] = _rel(yaml_path)
            req["source_registry"] = _rel(yaml_path)
            requirements.append(req)
    requirements.sort(key=lambda r: r["id"])
    return requirements


def _normalize_requirement(
    raw: Any, file_domain: Any, yaml_path: Path
) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise TraceabilityError(f"{_rel(yaml_path)}: each requirement must be a mapping")
    req_id = raw.get("id")
    if not isinstance(req_id, str):
        raise TraceabilityError(f"{_rel(yaml_path)}: requirement missing string id")
    match = REQUIREMENT_ID_RE.match(req_id)
    if not match:
        raise TraceabilityError(f"{req_id}: id must match REQ-<DOMAIN>-NNNN")
    domain = match.group("domain")
    if domain not in VALID_DOMAINS:
        raise TraceabilityError(f"{req_id}: unknown domain {domain}")
    if file_domain is not None and domain != file_domain:
        raise TraceabilityError(
            f"{req_id}: domain {domain} does not match file domain {file_domain}"
        )
    for required in ("title", "owner", "source_doc", "source_doc_sha", "status", "claim_boundary"):
        if not isinstance(raw.get(required), str) or not raw[required]:
            raise TraceabilityError(f"{req_id}: missing required string field '{required}'")
    links_raw = raw.get("links") or {}
    if not isinstance(links_raw, dict):
        raise TraceabilityError(f"{req_id}: links must be a mapping")
    links: dict[str, list[str]] = {}
    for kind in LINK_KINDS:
        bucket = links_raw.get(kind) or []
        if not isinstance(bucket, list) or any(not isinstance(p, str) for p in bucket):
            raise TraceabilityError(f"{req_id}: links.{kind} must be a list of strings")
        links[kind] = bucket
    gates_raw = raw.get("gates") or []
    if not isinstance(gates_raw, list) or any(not isinstance(g, str) for g in gates_raw):
        raise TraceabilityError(f"{req_id}: gates must be a list of strings")
    waiver = raw.get("waiver")
    if waiver is not None:
        if not isinstance(waiver, dict):
            raise TraceabilityError(f"{req_id}: waiver must be a mapping")
        for key in ("owner", "reason", "expiry"):
            if not isinstance(waiver.get(key), str) or not waiver[key]:
                raise TraceabilityError(f"{req_id}: waiver.{key} must be a non-empty string")
    return {
        "id": req_id,
        "domain": domain,
        "title": raw["title"],
        "owner": raw["owner"],
        "source_doc": raw["source_doc"],
        "source_doc_sha": raw["source_doc_sha"],
        "status": raw["status"],
        "claim_boundary": raw["claim_boundary"],
        "links": links,
        "gates": list(gates_raw),
        "work_order_id": raw.get("work_order_id"),
        "waiver": waiver,
    }


def load_gate_specs() -> list[dict[str, str]]:
    """Import the aggregator's GATES tuple as the canonical gate node set."""
    module_name = "_agg_for_trace"
    spec = importlib.util.spec_from_file_location(module_name, AGGREGATOR_PATH)
    if spec is None or spec.loader is None:
        raise TraceabilityError(f"cannot import aggregator: {_rel(AGGREGATOR_PATH)}")
    module = importlib.util.module_from_spec(spec)
    # Register before exec so the module's @dataclass decorators can resolve
    # ``cls.__module__`` against sys.modules during class processing.
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    gates: list[dict[str, str]] = []
    for gate in module.GATES:
        gates.append(
            {
                "name": gate.name,
                "script": gate.script,
                "subsystem": gate.subsystem,
                "tier": gate.tier,
            }
        )
    gates.sort(key=lambda g: g["name"])
    return gates


def load_rtl_gaps() -> list[dict[str, Any]]:
    """Load critical gaps from the RTL gap work order (edge-bearing entries)."""
    if not RTL_GAP_WORK_ORDER.is_file():
        raise TraceabilityError(f"rtl gap work order missing: {_rel(RTL_GAP_WORK_ORDER)}")
    payload = yaml.safe_load(RTL_GAP_WORK_ORDER.read_text())
    if not isinstance(payload, dict):
        raise TraceabilityError(f"{_rel(RTL_GAP_WORK_ORDER)}: top-level must be a mapping")
    areas = payload.get("areas") or {}
    gaps: list[dict[str, Any]] = []
    if isinstance(areas, dict):
        for area_name, area in areas.items():
            if not isinstance(area, dict):
                continue
            for gap in area.get("critical_gaps") or []:
                if not isinstance(gap, dict):
                    continue
                affected = [
                    p for p in (gap.get("affected_paths") or []) if isinstance(p, str)
                ]
                gaps.append(
                    {
                        "id": gap.get("id"),
                        "area": area_name,
                        "severity": gap.get("severity"),
                        "category": gap.get("category"),
                        "affected_paths": affected,
                        "blocking_gate": gap.get("blocking_gate"),
                    }
                )
    return gaps


# --------------------------------------------------------------------------- #
# Graph construction.
# --------------------------------------------------------------------------- #
def _kind_for_path(path_text: str) -> str:
    """Classify a path into an RTL or test node kind for gap-derived edges."""
    if path_text.startswith("rtl/"):
        return "rtl"
    if path_text.startswith(("verify/", "sw/", "fw/")) and path_text.endswith(
        (".py", ".cpp", ".sv", ".sby")
    ):
        return "test"
    return "artifact"


def build_graph(
    requirements: list[dict[str, Any]],
    gate_specs: list[dict[str, str]],
    rtl_gaps: list[dict[str, Any]],
) -> DiGraph:
    graph = DiGraph()
    gate_names = {g["name"] for g in gate_specs}

    for gate in gate_specs:
        node_id = f"gate:{gate['name']}"
        graph.add_node(
            node_id,
            "gate",
            name=gate["name"],
            script=gate["script"],
            subsystem=gate["subsystem"],
            tier=gate["tier"],
        )

    for req in requirements:
        req_node = req["id"]
        graph.add_node(
            req_node,
            "requirement",
            title=req["title"],
            owner=req["owner"],
            status=req["status"],
            domain=req["domain"],
            claim_boundary=req["claim_boundary"],
            source_registry=req["source_registry"],
        )
        doc_node = path_node_id("spec_doc", req["source_doc"])
        graph.add_node(doc_node, "spec_doc", path=req["source_doc"], sha=req["source_doc_sha"])
        graph.add_edge(req_node, doc_node, "derived_from")

        for kind, bucket in req["links"].items():
            node_kind = LINK_NODE_KIND[kind]
            for path_text in bucket:
                node_id = path_node_id(node_kind, path_text)
                graph.add_node(node_id, node_kind, path=path_text)
                graph.add_edge(req_node, node_id, f"links_{kind}")

        for gate_name in req["gates"]:
            gate_node = f"gate:{gate_name}"
            if gate_name not in gate_names:
                # Record a placeholder so the gate can flag the dangling edge.
                graph.add_node(gate_node, "gate", name=gate_name, unknown=True)
            graph.add_edge(req_node, gate_node, "validated_by")

    for gap in rtl_gaps:
        gap_id = gap["id"]
        if not isinstance(gap_id, str):
            continue
        gap_node = f"gap:{gap_id}"
        graph.add_node(
            gap_node,
            "rtl_gap",
            gap_id=gap_id,
            area=gap.get("area"),
            severity=gap.get("severity"),
            category=gap.get("category"),
        )
        for path_text in gap["affected_paths"]:
            kind = _kind_for_path(path_text)
            node_id = path_node_id(kind, path_text)
            graph.add_node(node_id, kind, path=path_text)
            graph.add_edge(gap_node, node_id, "affects")

    return graph


# --------------------------------------------------------------------------- #
# Serialization.
# --------------------------------------------------------------------------- #
def serialize_graph(
    graph: DiGraph,
    requirements: list[dict[str, Any]],
    gate_specs: list[dict[str, str]],
    rtl_gaps: list[dict[str, Any]],
) -> dict[str, Any]:
    nodes = [graph.nodes[node_id] for node_id in sorted(graph.nodes)]
    kind_counts: dict[str, int] = defaultdict(int)
    for node in nodes:
        kind_counts[node["kind"]] += 1
    return {
        "schema": GRAPH_SCHEMA,
        "claim_boundary": CLAIM_BOUNDARY,
        "seed_sources": {
            "requirements_dir": _rel(REQUIREMENTS_DIR),
            "rtl_gap_work_order": _rel(RTL_GAP_WORK_ORDER),
            "gate_inventory": _rel(AGGREGATOR_PATH),
        },
        "counts": {
            "requirements": len(requirements),
            "gates": len(gate_specs),
            "rtl_gaps": len(rtl_gaps),
            "nodes": len(nodes),
            "edges": len(graph.edges()),
            "node_kinds": dict(sorted(kind_counts.items())),
        },
        "nodes": nodes,
        "edges": graph.edges(),
    }


def render_matrix(serialized: dict[str, Any], requirements: list[dict[str, Any]]) -> str:
    counts = serialized["counts"]
    lines = [
        "# E1 requirements traceability matrix",
        "",
        f"Schema: `{serialized['schema']}`  ",
        f"Claim boundary: `{serialized['claim_boundary']}`",
        "",
        (
            f"Requirements: {counts['requirements']} | gates: {counts['gates']} | "
            f"RTL gaps: {counts['rtl_gaps']} | nodes: {counts['nodes']} | "
            f"edges: {counts['edges']}"
        ),
        "",
        "Generated by `scripts/build_traceability_graph.py`. Do not hand-edit.",
        "",
        "| Requirement | Owner | Status | Source doc | RTL | Tests | PD evidence | Mfg | Gates |",
        "| ----------- | ----- | ------ | ---------- | --- | ----- | ----------- | --- | ----- |",
    ]
    for req in requirements:
        links = req["links"]
        row = [
            f"`{req['id']}`",
            req["owner"],
            req["status"],
            f"`{req['source_doc']}`",
            str(len(links["rtl"])),
            str(len(links["tests"])),
            str(len(links["pd_evidence"])),
            str(len(links["mfg_artifacts"])),
            ", ".join(req["gates"]) or "-",
        ]
        lines.append("| " + " | ".join(row) + " |")
    lines.append("")
    return "\n".join(lines)


def write_outputs(serialized: dict[str, Any], requirements: list[dict[str, Any]]) -> None:
    TRACEABILITY_DIR.mkdir(parents=True, exist_ok=True)
    GRAPH_PATH.write_text(json.dumps(serialized, indent=2, sort_keys=True) + "\n")
    MATRIX_PATH.write_text(render_matrix(serialized, requirements))


def build() -> dict[str, Any]:
    requirements = load_requirements()
    gate_specs = load_gate_specs()
    rtl_gaps = load_rtl_gaps()
    graph = build_graph(requirements, gate_specs, rtl_gaps)
    return {
        "graph": graph,
        "requirements": requirements,
        "gate_specs": gate_specs,
        "rtl_gaps": rtl_gaps,
        "serialized": serialize_graph(graph, requirements, gate_specs, rtl_gaps),
    }


def main() -> int:
    try:
        result = build()
    except TraceabilityError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    write_outputs(result["serialized"], result["requirements"])
    counts = result["serialized"]["counts"]
    print(
        f"STATUS: PASS traceability_graph {_rel(GRAPH_PATH)} "
        f"(requirements={counts['requirements']} nodes={counts['nodes']} "
        f"edges={counts['edges']})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
