#!/usr/bin/env python3
"""Create a hash-pinned CUDA readiness evidence bundle manifest."""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/cuda_evidence_bundles"
CLAIM_BOUNDARY = "cuda_evidence_bundle_manifest_only_no_training_inference_or_release_claim"


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def repo_path(value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def sha256_file(path: Path) -> str | None:
    if not path.is_file():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{rel(path)} must contain a JSON object")
    return data


def artifact_entry(path_value: str, role: str) -> dict[str, Any]:
    path = repo_path(path_value)
    digest = sha256_file(path)
    return {
        "role": role,
        "path": rel(path),
        "status": "PRESENT" if digest else "MISSING",
        "sha256": digest,
        "size_bytes": path.stat().st_size if path.is_file() else None,
    }


def dedupe_artifacts(artifacts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    deduped: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in artifacts:
        path = item.get("path")
        if not isinstance(path, str) or path in seen:
            continue
        seen.add(path)
        deduped.append(item)
    return deduped


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument(
        "--readiness-audit",
        type=Path,
        default=None,
        help="Readiness audit JSON; defaults to build/ai_eda/cuda_readiness_audit/<run-id>/cuda_readiness_audit.json.",
    )
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    audit_path = (
        args.readiness_audit
        or ROOT / f"build/ai_eda/cuda_readiness_audit/{args.run_id}/cuda_readiness_audit.json"
    )
    audit_path = repo_path(str(audit_path))
    if not audit_path.is_file():
        print(f"STATUS: FAIL ai_eda.cuda_evidence_bundle missing_readiness_audit {rel(audit_path)}")
        return 1
    audit = load_json(audit_path)
    if audit.get("schema") != "eliza.ai_eda.cuda_readiness_audit.v1":
        print("STATUS: FAIL ai_eda.cuda_evidence_bundle readiness audit schema mismatch")
        return 1

    artifacts: list[dict[str, Any]] = [
        artifact_entry(rel(audit_path), "cuda_readiness_audit"),
    ]
    for item in audit.get("input_artifacts", []):
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            continue
        role = Path(item["path"]).parent.parent.name if "/" in item["path"] else "input_artifact"
        artifacts.append(artifact_entry(item["path"], role))
    artifacts = dedupe_artifacts(artifacts)

    present = [item for item in artifacts if item["status"] == "PRESENT"]
    missing = [item for item in artifacts if item["status"] == "MISSING"]
    blocker_counts: dict[str, int] = {}
    for blocker in audit.get("blockers", []):
        if isinstance(blocker, dict):
            severity = str(blocker.get("severity", "unknown"))
            blocker_counts[severity] = blocker_counts.get(severity, 0) + 1

    report = {
        "schema": "eliza.ai_eda.cuda_evidence_bundle.v1",
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "source_readiness_audit": rel(audit_path),
        "source_readiness_audit_sha256": sha256_file(audit_path),
        "readiness_status": audit.get("status"),
        "evidence_run_ids": audit.get("evidence_run_ids", {}),
        "capabilities": audit.get("capabilities", {}),
        "blocker_counts": blocker_counts,
        "artifact_count": len(artifacts),
        "present_artifact_count": len(present),
        "missing_artifact_count": len(missing),
        "artifacts": artifacts,
        "replay_commands": [
            "python3 scripts/ai_eda/check_cuda_readiness_audit.py --report " + rel(audit_path),
            "python3 scripts/ai_eda/package_cuda_evidence_bundle.py --run-id " + args.run_id,
            f"python3 scripts/ai_eda/check_cuda_evidence_bundle.py --report build/ai_eda/cuda_evidence_bundles/{args.run_id}/cuda_evidence_bundle.json",
        ],
        "policy": {
            "contains_datasets": False,
            "contains_model_weights": False,
            "runs_training": False,
            "runs_inference": False,
            "runs_openlane": False,
            "release_use_allowed": False,
        },
    }
    out_dir = args.out_root / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    report_path = out_dir / "cuda_evidence_bundle.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    status = "PASS_WITH_MISSING_ARTIFACTS" if missing else "PASS"
    print(
        f"STATUS: {status} ai_eda.cuda_evidence_bundle "
        f"artifacts={len(artifacts)} present={len(present)} missing={len(missing)} {rel(report_path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
