#!/usr/bin/env python3
"""Capture post-run E1 formal execution evidence.

This script does not run formal tools. It packages the manifest and logs
produced by scripts/run_formal.sh and records whether the evidence is strict
SymbiYosys evidence or fallback-only Yosys evidence.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/formal_execution_evidence"
DEFAULT_MANIFEST = ROOT / "build/reports/formal_manifest.json"
DEFAULT_STRICT_WORK_ROOT = ROOT / "build/formal"
SCHEMA = "eliza.ai_eda.formal_execution_evidence.v1"
FORMAL_MANIFEST_SCHEMA = "e1-chip-formal-evidence-v1"
CLAIM_BOUNDARY = "formal_execution_evidence_only_no_release_claim"
STRICT_BLOCKS = ("e1_dbg_mmio_bridge", "e1_npu", "e1_dma", "e1_soc_top")


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


def load_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{rel(path)}: expected JSON object")
    return data


def artifact(path: Path, required: bool = True) -> dict[str, Any]:
    return {
        "path": rel(path),
        "required": required,
        "status": "PRESENT" if path.is_file() else "MISSING",
        "sha256": sha256_file(path),
        "size_bytes": path.stat().st_size if path.is_file() else None,
    }


def manifest_log_artifacts(manifest: dict[str, Any] | None) -> dict[str, Any]:
    artifacts: dict[str, Any] = {}
    entries = manifest.get("entries", {}) if isinstance(manifest, dict) else {}
    if not isinstance(entries, dict):
        return artifacts
    for block, entry in entries.items():
        if not isinstance(entry, dict):
            continue
        paths = entry.get("paths", {})
        if not isinstance(paths, dict):
            continue
        for kind in ("status", "log"):
            path_value = paths.get(kind)
            if isinstance(path_value, str) and path_value:
                artifacts[f"{block}_{kind}"] = artifact(repo_path(path_value))
    return artifacts


def latest_strict_attempt(block: str, work_root: Path) -> Path | None:
    candidates = [path for path in work_root.glob(f"{block}.*") if path.is_dir()]
    if not candidates:
        return None
    return max(candidates, key=lambda path: path.stat().st_mtime)


def strict_attempt_artifacts(attempts: list[dict[str, Any]]) -> dict[str, Any]:
    artifacts: dict[str, Any] = {}
    for attempt in attempts:
        block = attempt["block"]
        status_path = repo_path(str(attempt["paths"].get("status", "")))
        log_path = repo_path(str(attempt["paths"].get("log", "")))
        if status_path.name == "status":
            artifacts[f"{block}_strict_status"] = artifact(status_path)
        if log_path.name == "logfile.txt":
            artifacts[f"{block}_strict_log"] = artifact(log_path)
    return artifacts


def summarize_strict_attempts(work_root: Path) -> tuple[list[dict[str, Any]], list[str]]:
    attempts: list[dict[str, Any]] = []
    blockers: list[str] = []
    for block in STRICT_BLOCKS:
        attempt_dir = latest_strict_attempt(block, work_root)
        if attempt_dir is None:
            continue
        status_path = attempt_dir / "status"
        log_path = attempt_dir / "logfile.txt"
        status_text = (
            status_path.read_text(encoding="utf-8", errors="ignore")
            if status_path.is_file()
            else ""
        )
        log_text = (
            log_path.read_text(encoding="utf-8", errors="ignore") if log_path.is_file() else ""
        )
        error_markers = [
            marker
            for marker in (
                "ERROR",
                "Traceback",
                "BrokenPipeError",
                "Engine terminated without status",
            )
            if marker in f"{status_text}\n{log_text}"
        ]
        attempt = {
            "block": block,
            "work_dir": rel(attempt_dir),
            "status_text": status_text.strip() or None,
            "has_error_marker": bool(error_markers),
            "error_markers": sorted(set(error_markers)),
            "paths": {
                "status": rel(status_path) if status_path.is_file() else None,
                "log": rel(log_path) if log_path.is_file() else None,
            },
        }
        attempts.append(attempt)
        if error_markers:
            blockers.append(
                f"{block}: strict SymbiYosys attempt failed in {rel(attempt_dir)} "
                f"with markers {', '.join(sorted(set(error_markers)))}"
            )
    return attempts, blockers


def summarize_entries(manifest: dict[str, Any] | None) -> tuple[list[dict[str, Any]], list[str]]:
    blockers: list[str] = []
    summary: list[dict[str, Any]] = []
    entries = manifest.get("entries", {}) if isinstance(manifest, dict) else {}
    if not isinstance(entries, dict) or not entries:
        return summary, ["formal manifest entries are missing"]
    for block, entry in sorted(entries.items()):
        if not isinstance(entry, dict):
            blockers.append(f"{block}: entry is not structured")
            continue
        status = str(entry.get("status", "missing"))
        evidence_class = str(entry.get("evidence_class", "unknown"))
        paths = entry.get("paths", {}) if isinstance(entry.get("paths"), dict) else {}
        summary.append(
            {
                "block": block,
                "status": status,
                "evidence_class": evidence_class,
                "has_status": isinstance(paths.get("status"), str),
                "has_log": isinstance(paths.get("log"), str),
            }
        )
        if status in {"missing", "fail"}:
            blockers.append(f"{block}: formal status is {status}")
        if evidence_class.startswith("fallback"):
            blockers.append(f"{block}: fallback formal evidence is not deep proof evidence")
        if evidence_class == "blocked_requires_sby":
            blockers.append(f"{block}: strict SymbiYosys evidence is blocked")
    return summary, blockers


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default="validation")
    parser.add_argument("--formal-manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--strict-work-root", type=Path, default=DEFAULT_STRICT_WORK_ROOT)
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    manifest_path = repo_path(str(args.formal_manifest))
    manifest = load_json(manifest_path)
    blockers: list[str] = []
    if manifest is None:
        blockers.append("formal_manifest.json is missing or unreadable")
    elif manifest.get("schema") != FORMAL_MANIFEST_SCHEMA:
        blockers.append("formal manifest schema mismatch")

    entry_summary, entry_blockers = summarize_entries(manifest)
    blockers.extend(entry_blockers)
    strict_attempts, strict_attempt_blockers = summarize_strict_attempts(
        repo_path(str(args.strict_work_root))
    )
    blockers.extend(strict_attempt_blockers)
    mode = str(manifest.get("mode")) if isinstance(manifest, dict) else None
    strict_ready = (
        isinstance(manifest, dict)
        and manifest.get("mode") == "sby-deep-top"
        and entry_summary
        and all(
            item["status"] == "pass" and str(item["evidence_class"]).startswith("sby")
            for item in entry_summary
        )
    )
    if strict_ready and not blockers:
        status = "STRICT_FORMAL_EVIDENCE_READY"
    elif strict_attempt_blockers:
        status = "STRICT_FORMAL_EVIDENCE_BLOCKED_WITH_ENGINE_ERRORS"
    elif manifest is not None:
        status = "FALLBACK_FORMAL_EVIDENCE_CAPTURED_WITH_BLOCKERS"
    else:
        status = "BLOCKED_FORMAL_EXECUTION_EVIDENCE"
    artifacts = {"formal_manifest": artifact(manifest_path)}
    artifacts.update(manifest_log_artifacts(manifest))
    artifacts.update(strict_attempt_artifacts(strict_attempts))
    report = {
        "schema": SCHEMA,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "release_use_allowed": False,
        "formal_proof_claim_allowed": status == "STRICT_FORMAL_EVIDENCE_READY",
        "status": status,
        "formal_manifest_mode": mode,
        "strict_deep_formal_ready": status == "STRICT_FORMAL_EVIDENCE_READY",
        "fallback_evidence_only": status == "FALLBACK_FORMAL_EVIDENCE_CAPTURED_WITH_BLOCKERS",
        "entry_summary": entry_summary,
        "strict_attempt_summary": strict_attempts,
        "artifacts": artifacts,
        "blockers": blockers,
        "next_required_gates": [
            "keep SymbiYosys and SMT solvers available on PATH",
            "resolve any yosys-smtbmc solver engine errors from strict_attempt_summary",
            "rerun make PYTHON=python3 formal-strict",
            "recapture this report from the strict formal_manifest.json or failed strict work dirs",
            "require reviewer disposition before accepting generated assertions or RTL rewrites",
        ],
    }
    out_dir = args.out_root / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "formal_execution_evidence.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        "STATUS: PASS ai_eda.formal_execution_evidence "
        f"status={status} blockers={len(blockers)} {rel(path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
