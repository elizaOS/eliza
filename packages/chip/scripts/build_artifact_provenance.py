#!/usr/bin/env python3
"""Build and verify the die->package->board artifact provenance graph.

Each node in docs/spec-db/artifact-provenance.yaml pins the sha256 of its own
source artifact (node_checksum) and the upstream node's checksum it was cut
against (upstream_checksum). Default (check) mode recomputes the source
checksums and fail-closes when a node_checksum is stale, an upstream_checksum
does not match the recorded upstream node, or an ECO/ECN has not propagated to
its downstream nodes. `--build` rewrites the recorded checksums in place.
"""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "docs/spec-db/artifact-provenance.yaml"
EXPECTED_SCHEMA = "eliza.artifact_provenance.v1"
LEVEL_ORDER = ("die", "package", "board")


def fail(errors: list[str], message: str) -> None:
    errors.append(f"FAIL: {message}")


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_nodes(errors: list[str]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    manifest = yaml.safe_load(MANIFEST.read_text())
    if not isinstance(manifest, dict):
        fail(errors, "provenance manifest must be a mapping")
        return {}, []
    if manifest.get("schema") != EXPECTED_SCHEMA:
        fail(errors, "unexpected schema")
    raw_nodes = manifest.get("nodes")
    if not isinstance(raw_nodes, list):
        fail(errors, "nodes must be a list")
        return manifest, []
    nodes = [node for node in raw_nodes if isinstance(node, dict)]
    if len(nodes) != len(raw_nodes):
        fail(errors, "every node must be a mapping")
    return manifest, nodes


def compute_node_checksum(node: dict[str, Any], errors: list[str]) -> str | None:
    source = node.get("source_path")
    node_id = node.get("id")
    if not isinstance(source, str):
        fail(errors, f"node {node_id} missing source_path")
        return None
    path = ROOT / source
    if not path.is_file():
        fail(errors, f"node {node_id} source missing: {source}")
        return None
    return sha256_file(path)


def build(errors: list[str]) -> int:
    manifest, nodes = load_nodes(errors)
    if errors:
        print("\n".join(errors))
        return 1
    computed: dict[str, str] = {}
    for node in nodes:
        checksum = compute_node_checksum(node, errors)
        if checksum is None:
            continue
        node["node_checksum"] = checksum
        computed[str(node["id"])] = checksum
    for node in nodes:
        upstream = node.get("upstream")
        if upstream is None:
            node["upstream_checksum"] = None
        elif upstream in computed:
            node["upstream_checksum"] = computed[upstream]
        else:
            fail(errors, f"node {node.get('id')} references unknown upstream: {upstream}")
    if errors:
        print("\n".join(errors))
        return 1
    MANIFEST.write_text(yaml.safe_dump(manifest, sort_keys=False))
    print(f"STATUS: PASS artifact_provenance built ({len(nodes)} nodes)")
    return 0


def check(errors: list[str]) -> int:
    _, nodes = load_nodes(errors)
    by_id = {str(node.get("id")): node for node in nodes}
    computed: dict[str, str] = {}
    for node in nodes:
        node_id = str(node.get("id"))
        level = node.get("level")
        if level not in LEVEL_ORDER:
            fail(errors, f"node {node_id} has unknown level: {level}")
        checksum = compute_node_checksum(node, errors)
        if checksum is None:
            continue
        computed[node_id] = checksum
        recorded = node.get("node_checksum")
        if recorded == "REFRESH_WITH_BUILD":
            fail(errors, f"node {node_id} node_checksum not built; run --build")
        elif recorded != checksum:
            fail(errors, f"node {node_id} node_checksum is stale (source changed)")

    for node in nodes:
        node_id = str(node.get("id"))
        upstream = node.get("upstream")
        recorded_up = node.get("upstream_checksum")
        if upstream is None:
            if recorded_up is not None:
                fail(errors, f"root node {node_id} must have null upstream_checksum")
            continue
        if upstream not in by_id:
            fail(errors, f"node {node_id} references unknown upstream: {upstream}")
            continue
        actual_up = computed.get(upstream)
        if recorded_up == "REFRESH_WITH_BUILD":
            fail(errors, f"node {node_id} upstream_checksum not built; run --build")
        elif actual_up is not None and recorded_up != actual_up:
            fail(
                errors,
                f"node {node_id} references stale upstream {upstream} "
                f"checksum (upstream source changed without ECO/ECN propagation)",
            )
        upstream_node = by_id[upstream]
        upstream_ecos = {str(e) for e in upstream_node.get("eco_ecn", []) or []}
        node_ecos = {str(e) for e in node.get("eco_ecn", []) or []}
        unpropagated = sorted(upstream_ecos - node_ecos)
        if unpropagated:
            fail(
                errors,
                f"node {node_id} missing upstream ECO/ECN propagation: " + ", ".join(unpropagated),
            )

    if errors:
        print("\n".join(errors))
        return 1
    print(
        f"STATUS: PASS artifact_provenance docs/spec-db/artifact-provenance.yaml ({len(nodes)} nodes)"
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--build",
        action="store_true",
        help="recompute and rewrite recorded checksums from the source artifacts",
    )
    args = parser.parse_args()
    errors: list[str] = []
    if not MANIFEST.is_file():
        fail(errors, f"missing {MANIFEST.relative_to(ROOT)}")
        print("\n".join(errors))
        return 1
    return build(errors) if args.build else check(errors)


if __name__ == "__main__":
    raise SystemExit(main())
