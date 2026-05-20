#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import logging
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from check_rlvr_pipeline_health import build_health_report

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("rlvr-release")

DEFAULT_MIN_EVAL_SCORE = 60.0
DEFAULT_MAX_LOSS = 5.0


def load_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"Expected JSON object at {path}")
    return payload


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def write_symlink(path: Path, target: Path) -> None:
    if path.exists() or path.is_symlink():
        path.unlink()
    path.symlink_to(target)


def release_id_for(label: str) -> str:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    slug = "".join(ch.lower() if ch.isalnum() else "-" for ch in label).strip("-")
    return f"{slug}-{timestamp}"


def resolve_candidate(report: dict[str, Any], explicit_adapter: str | None) -> tuple[str, str]:
    phases = report.get("phases")
    if not isinstance(phases, dict):
        raise ValueError("RLVR report missing phases.")

    if explicit_adapter:
        return explicit_adapter, "manual"

    distill = phases.get("distill")
    if (
        isinstance(distill, dict)
        and distill.get("status") == "completed"
        and distill.get("adapter_path")
    ):
        return str(distill["adapter_path"]), "distill"

    sft = phases.get("sft")
    if isinstance(sft, dict) and sft.get("status") == "completed" and sft.get("adapter_path"):
        return str(sft["adapter_path"]), "sft"

    raise ValueError("No completed adapter-producing phase found in report.")


def load_optional_manifest(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    return load_json(path)


def resolve_eval_phase(phases: dict[str, Any], source_name: str) -> dict[str, Any]:
    if source_name == "distill":
        candidate_names = ("eval_distill", "eval_sft")
    elif source_name == "sft":
        candidate_names = ("eval_sft", "eval_distill")
    else:
        candidate_names = ("eval_distill", "eval_sft")

    for phase_name in candidate_names:
        phase = phases.get(phase_name)
        if isinstance(phase, dict):
            return phase
    return {}


def copy_release_artifact(
    *,
    source_path: str | None,
    release_dir: Path,
    artifact_name: str,
    required: bool,
) -> str | None:
    if not source_path:
        if required:
            raise ValueError(f"Missing required release artifact: {artifact_name}")
        return None

    source = Path(source_path).resolve()
    if not source.exists():
        if required:
            raise ValueError(f"Release artifact does not exist: {source}")
        return None

    destination = release_dir / artifact_name
    if source.is_dir():
        shutil.copytree(source, destination)
    else:
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
    return str(destination)


def promote_release(
    *,
    report_path: Path,
    release_root: Path,
    adapter_path: str | None,
    label: str,
    base_model: str | None,
    min_eval_score: float,
    max_loss: float,
) -> dict[str, Any]:
    report = load_json(report_path)
    candidate_adapter, source_name = resolve_candidate(report, adapter_path)
    adapter = Path(candidate_adapter).resolve()
    if not adapter.exists():
        raise ValueError(f"Adapter path does not exist: {adapter}")

    health_report = build_health_report(
        report,
        report_path=report_path,
        min_eval_score=min_eval_score,
        max_loss=max_loss,
    )
    if health_report["status"] == "critical":
        raise ValueError(
            f"Refusing to promote release with critical health status: {health_report['alerts']}"
        )

    phases = report.get("phases", {})
    eval_phase = resolve_eval_phase(phases, source_name)

    current_manifest = release_root / "current.json"
    previous_manifest = release_root / "previous.json"
    previous_current = load_optional_manifest(current_manifest)
    release_id = release_id_for(label)
    release_dir = release_root / "releases" / release_id
    release_dir.mkdir(parents=True, exist_ok=False)
    packaged_adapter_path = copy_release_artifact(
        source_path=str(adapter),
        release_dir=release_dir,
        artifact_name=adapter.name if adapter.is_file() else "adapter",
        required=True,
    )
    packaged_score_path = copy_release_artifact(
        source_path=eval_phase.get("score_path")
        if isinstance(eval_phase.get("score_path"), str)
        else None,
        release_dir=release_dir,
        artifact_name="score.json",
        required=False,
    )
    packaged_decision_output_path = copy_release_artifact(
        source_path=eval_phase.get("output_path")
        if isinstance(eval_phase.get("output_path"), str)
        else None,
        release_dir=release_dir,
        artifact_name="decisions.json",
        required=False,
    )
    packaged_report_path = copy_release_artifact(
        source_path=str(report_path),
        release_dir=release_dir,
        artifact_name="pipeline_report.json",
        required=True,
    )
    health_report_path = release_dir / "health.json"
    write_json(health_report_path, health_report)

    manifest = {
        "release_id": release_id,
        "label": label,
        "promoted_at": datetime.now(timezone.utc).isoformat(),
        "source_report_path": str(report_path),
        "release_report_path": packaged_report_path,
        "source_phase": source_name,
        "source_adapter_path": str(adapter),
        "adapter_path": packaged_adapter_path,
        "base_model": base_model or report.get("config", {}).get("model"),
        "overall_score": eval_phase.get("overall_score"),
        "source_score_path": eval_phase.get("score_path"),
        "score_path": packaged_score_path,
        "source_decision_output_path": eval_phase.get("output_path"),
        "decision_output_path": packaged_decision_output_path,
        "previous_release_id": previous_current.get("release_id") if previous_current else None,
        "health_status": health_report["status"],
        "health_alert_count": health_report["alert_count"],
        "health_path": str(health_report_path),
    }
    write_json(release_dir / "manifest.json", manifest)

    if previous_current is not None:
        write_json(previous_manifest, previous_current)
        previous_target = release_root / "releases" / str(previous_current["release_id"])
        if previous_target.exists():
            write_symlink(release_root / "previous", previous_target)

    write_json(current_manifest, manifest)
    write_symlink(release_root / "current", release_dir)
    return manifest


def rollback_release(
    *,
    release_root: Path,
    target_release_id: str | None,
) -> dict[str, Any]:
    current_manifest_path = release_root / "current.json"
    previous_manifest_path = release_root / "previous.json"
    current_manifest = load_optional_manifest(current_manifest_path)
    if current_manifest is None:
        raise ValueError("No current release manifest found.")

    if target_release_id:
        target_path = release_root / "releases" / target_release_id / "manifest.json"
    else:
        target_path = previous_manifest_path
    if not target_path.exists():
        raise ValueError("Rollback target manifest not found.")

    target_manifest = load_json(target_path)
    target_dir = release_root / "releases" / str(target_manifest["release_id"])
    if not target_dir.exists():
        raise ValueError(f"Rollback target directory missing: {target_dir}")

    write_json(previous_manifest_path, current_manifest)
    write_json(current_manifest_path, target_manifest)
    write_symlink(release_root / "current", target_dir)
    write_symlink(
        release_root / "previous",
        release_root / "releases" / str(current_manifest["release_id"]),
    )

    event = {
        "rolled_back_at": datetime.now(timezone.utc).isoformat(),
        "from_release_id": current_manifest["release_id"],
        "to_release_id": target_manifest["release_id"],
    }
    rollback_log = release_root / "rollback_events.jsonl"
    with rollback_log.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(event) + "\n")
    return event


def status_release(release_root: Path) -> dict[str, Any]:
    return {
        "current": load_optional_manifest(release_root / "current.json"),
        "previous": load_optional_manifest(release_root / "previous.json"),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Promote and rollback RLVR release artifacts.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    promote = subparsers.add_parser("promote")
    promote.add_argument("--report", required=True)
    promote.add_argument("--release-root", required=True)
    promote.add_argument("--adapter-path", default="")
    promote.add_argument("--label", default="rlvr")
    promote.add_argument("--base-model", default="")
    promote.add_argument("--min-eval-score", type=float, default=DEFAULT_MIN_EVAL_SCORE)
    promote.add_argument("--max-loss", type=float, default=DEFAULT_MAX_LOSS)

    rollback = subparsers.add_parser("rollback")
    rollback.add_argument("--release-root", required=True)
    rollback.add_argument("--target-release-id", default="")

    status = subparsers.add_parser("status")
    status.add_argument("--release-root", required=True)

    args = parser.parse_args()
    release_root = Path(args.release_root).resolve()
    release_root.mkdir(parents=True, exist_ok=True)

    try:
        if args.command == "promote":
            payload = promote_release(
                report_path=Path(args.report).resolve(),
                release_root=release_root,
                adapter_path=args.adapter_path or None,
                label=args.label,
                base_model=args.base_model or None,
                min_eval_score=args.min_eval_score,
                max_loss=args.max_loss,
            )
        elif args.command == "rollback":
            payload = rollback_release(
                release_root=release_root,
                target_release_id=args.target_release_id or None,
            )
        else:
            payload = status_release(release_root)
    except Exception as exc:
        logger.error("Release command %s failed: %s", args.command, exc)
        return 1

    print(json.dumps(payload, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
