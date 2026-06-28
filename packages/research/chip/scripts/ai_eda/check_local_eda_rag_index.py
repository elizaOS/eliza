#!/usr/bin/env python3
"""Validate the read-only local EDA RAG source manifest and citation smoke report."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_INDEX_DIR = ROOT / "build/ai_eda/rag_index"
CLAIM_BOUNDARY = "read_only_cited_triage_no_code_edit_or_evidence_claim"


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def repo_path(value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected JSON object")
    return data


def validate_manifest(manifest: dict[str, Any]) -> tuple[list[str], dict[str, dict[str, Any]]]:
    errors: list[str] = []
    if manifest.get("schema") != "eliza.ai_eda.local_rag.source_manifest.v1":
        errors.append("manifest schema mismatch")
    if manifest.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append("manifest claim_boundary mismatch")
    if manifest.get("mode") != "dry-run":
        errors.append("manifest mode must be dry-run")
    if manifest.get("status") != "READ_ONLY_INDEX_MANIFEST":
        errors.append("manifest status must be READ_ONLY_INDEX_MANIFEST")
    policy = manifest.get("index_policy")
    if not isinstance(policy, dict):
        errors.append("manifest index_policy must be a mapping")
    else:
        expected_true = (
            "read_only",
            "answers_require_citations",
            "engineering_actions_require_named_checker",
            "stale_index_fails_closed",
        )
        expected_false = (
            "network_required",
            "embeddings_generated",
            "can_edit_source",
        )
        for field in expected_true:
            if policy.get(field) is not True:
                errors.append(f"manifest index_policy.{field} must be true")
        for field in expected_false:
            if policy.get(field) is not False:
                errors.append(f"manifest index_policy.{field} must be false")
    sources = manifest.get("sources")
    if not isinstance(sources, list) or not sources:
        errors.append("manifest sources must be a non-empty list")
        return errors, {}
    if manifest.get("source_count") != len(sources):
        errors.append("manifest source_count does not match sources length")
    by_id: dict[str, dict[str, Any]] = {}
    for index, source in enumerate(sources):
        label = f"manifest sources[{index}]"
        if not isinstance(source, dict):
            errors.append(f"{label}: must be a mapping")
            continue
        source_id = source.get("id")
        if not isinstance(source_id, str) or not source_id:
            errors.append(f"{label}: id is required")
            continue
        if source_id in by_id:
            errors.append(f"{label}: duplicate id {source_id}")
        by_id[source_id] = source
        path_value = source.get("path")
        if not isinstance(path_value, str) or not path_value:
            errors.append(f"{source_id}: path is required")
        else:
            path = repo_path(path_value)
            if not path.is_file():
                errors.append(f"{source_id}: path is missing on disk")
            elif source.get("bytes") != path.stat().st_size:
                errors.append(f"{source_id}: byte count does not match file size")
        sha = source.get("sha256")
        if not isinstance(sha, str) or len(sha) != 64:
            errors.append(f"{source_id}: sha256 must be a 64-character digest")
        if not isinstance(source.get("kind"), str) or not source["kind"]:
            errors.append(f"{source_id}: kind is required")
        if not isinstance(source.get("topics"), list) or "ai_eda" not in source["topics"]:
            errors.append(f"{source_id}: topics must include ai_eda")
    return errors, by_id


def validate_smoke(smoke: dict[str, Any], sources_by_id: dict[str, dict[str, Any]]) -> list[str]:
    errors: list[str] = []
    if smoke.get("schema") != "eliza.ai_eda.local_rag.citation_smoke_report.v1":
        errors.append("smoke schema mismatch")
    if smoke.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append("smoke claim_boundary mismatch")
    if smoke.get("mode") != "dry-run":
        errors.append("smoke mode must be dry-run")
    if smoke.get("status") != "PASS":
        errors.append("smoke status must be PASS")
    queries = smoke.get("queries")
    if not isinstance(queries, list) or not queries:
        errors.append("smoke queries must be a non-empty list")
        return errors
    if smoke.get("query_count") != len(queries):
        errors.append("smoke query_count does not match queries length")
    seen: set[str] = set()
    for index, query in enumerate(queries):
        label = f"smoke queries[{index}]"
        if not isinstance(query, dict):
            errors.append(f"{label}: must be a mapping")
            continue
        query_id = query.get("id")
        if not isinstance(query_id, str) or not query_id:
            errors.append(f"{label}: id is required")
        elif query_id in seen:
            errors.append(f"{label}: duplicate id {query_id}")
        else:
            seen.add(query_id)
        if query.get("status") != "PASS":
            errors.append(f"{label}: status must be PASS")
        if not isinstance(query.get("query"), str) or not query["query"]:
            errors.append(f"{label}: query text is required")
        gates = query.get("required_followup_gates")
        if not isinstance(gates, list) or not gates:
            errors.append(f"{label}: required_followup_gates must be non-empty")
        citations = query.get("citations")
        if not isinstance(citations, list) or not citations:
            errors.append(f"{label}: citations must be non-empty")
            continue
        for citation_index, citation in enumerate(citations):
            citation_label = f"{label}: citations[{citation_index}]"
            if not isinstance(citation, dict):
                errors.append(f"{citation_label}: must be a mapping")
                continue
            source_id = citation.get("source_id")
            if not isinstance(source_id, str) or source_id not in sources_by_id:
                errors.append(f"{citation_label}: unknown source_id {source_id!r}")
                continue
            source = sources_by_id[source_id]
            if citation.get("path") != source.get("path"):
                errors.append(f"{citation_label}: path does not match manifest source")
            if citation.get("sha256") != source.get("sha256"):
                errors.append(f"{citation_label}: sha256 does not match manifest source")
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--index-dir", type=Path, default=DEFAULT_INDEX_DIR)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    manifest_path = args.index_dir / "source_manifest.json"
    smoke_path = args.index_dir / "citation_smoke_report.json"
    missing = [path for path in (manifest_path, smoke_path) if not path.exists()]
    if missing:
        for path in missing:
            print(f"STATUS: FAIL ai_eda.local_rag.read_only_index missing {rel(path)}")
        return 1
    try:
        manifest = load_json(manifest_path)
        smoke = load_json(smoke_path)
        errors, sources_by_id = validate_manifest(manifest)
        errors.extend(validate_smoke(smoke, sources_by_id))
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.local_rag.read_only_index {exc}")
        return 1
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.local_rag.read_only_index {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.local_rag.read_only_index "
        f"sources={manifest['source_count']} queries={smoke['query_count']} index={rel(args.index_dir)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
