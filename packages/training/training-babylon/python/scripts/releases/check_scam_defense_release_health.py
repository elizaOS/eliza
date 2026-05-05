#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REQUIRED_DATA_FILES = [
    "training_examples.jsonl",
    "detector_corpus.jsonl",
    "conversation_corpus.jsonl",
    "sft_corpus.jsonl",
    "reasoning_donor_corpus.jsonl",
    "scambench_scenario_seeds.jsonl",
    "scambench_curated_scenarios.json",
    "scenario_catalog.json",
]
REQUIRED_EXPORT_FILES = [
    "trajectories.jsonl",
    "manifest.json",
]
REQUIRED_MODEL_FILES = [
    "README.md",
    "benchmark_summary.json",
    "training_manifest.json",
]
DEFAULT_REQUIRED_CATEGORIES = [
    "social-engineering",
    "prompt-injection",
    "secret-exfiltration",
    "cli-execution",
    "admin-override",
    "environment-tampering",
]


def load_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"Expected JSON object at {path}")
    return payload


def build_alert(level: str, code: str, message: str, *, path: str | None = None) -> dict[str, Any]:
    alert = {"level": level, "code": code, "message": message}
    if path:
        alert["path"] = path
    return alert


def require_file(alerts: list[dict[str, Any]], path: Path, *, code: str, message: str) -> bool:
    if path.exists():
        return True
    alerts.append(build_alert("critical", code, message, path=str(path)))
    return False


def require_category_coverage(
    alerts: list[dict[str, Any]],
    *,
    category_counts: dict[str, Any],
    required_categories: list[str],
    code_prefix: str,
    label: str,
) -> None:
    missing = [
        category
        for category in required_categories
        if int(category_counts.get(category, 0) or 0) <= 0
    ]
    if missing:
        alerts.append(
            build_alert(
                "warning",
                f"{code_prefix}-categories-missing",
                f"{label} is missing category coverage for: {', '.join(sorted(missing))}.",
            )
        )


def validate_export_dir(
    export_dir: Path,
    *,
    alerts: list[dict[str, Any]],
    required_categories: list[str],
    require_held_out: bool,
    label: str,
) -> dict[str, Any] | None:
    for filename in REQUIRED_EXPORT_FILES:
        if not require_file(
            alerts,
            export_dir / filename,
            code=f"{label}-{filename.replace('.', '-')}-missing",
            message=f"{label} export is missing required file {filename}.",
        ):
            return None

    manifest = load_json(export_dir / "manifest.json")
    category_counts = manifest.get("categoryCounts")
    if not isinstance(category_counts, dict):
        alerts.append(
            build_alert(
                "warning",
                f"{label}-category-counts-missing",
                f"{label} export manifest is missing categoryCounts.",
                path=str(export_dir / "manifest.json"),
            )
        )
    else:
        require_category_coverage(
            alerts,
            category_counts=category_counts,
            required_categories=required_categories,
            code_prefix=label,
            label=label,
        )

    held_out_dir = export_dir / "held-out"
    if require_held_out:
        if not held_out_dir.is_dir():
            alerts.append(
                build_alert(
                    "critical",
                    f"{label}-held-out-missing",
                    f"{label} export is missing the held-out evaluation split.",
                    path=str(held_out_dir),
                )
            )
        else:
            for filename in REQUIRED_EXPORT_FILES:
                require_file(
                    alerts,
                    held_out_dir / filename,
                    code=f"{label}-held-out-{filename.replace('.', '-')}-missing",
                    message=f"{label} held-out export is missing required file {filename}.",
                )
            held_out_manifest = load_json(held_out_dir / "manifest.json")
            held_out_counts = held_out_manifest.get("categoryCounts")
            if isinstance(held_out_counts, dict):
                require_category_coverage(
                    alerts,
                    category_counts=held_out_counts,
                    required_categories=required_categories,
                    code_prefix=f"{label}-held-out",
                    label=f"{label} held-out split",
                )
    return manifest


def validate_model_repo(
    repo_dir: Path, model_payload: dict[str, Any], alerts: list[dict[str, Any]]
) -> None:
    for filename in REQUIRED_MODEL_FILES:
        require_file(
            alerts,
            repo_dir / filename,
            code=f"model-{repo_dir.name}-{filename.replace('.', '-')}-missing",
            message=f"Model repo {repo_dir.name} is missing required file {filename}.",
        )

    artifact_layout = str(model_payload.get("artifact_layout", "")).strip().lower()
    if artifact_layout == "adapter":
        require_file(
            alerts,
            repo_dir / "adapters" / "adapter_config.json",
            code=f"model-{repo_dir.name}-adapter-config-missing",
            message=f"Model repo {repo_dir.name} is missing adapters/adapter_config.json.",
        )
        require_file(
            alerts,
            repo_dir / "adapters" / "adapters.safetensors",
            code=f"model-{repo_dir.name}-adapter-weights-missing",
            message=f"Model repo {repo_dir.name} is missing adapters/adapters.safetensors.",
        )
    elif artifact_layout == "full-model":
        require_file(
            alerts,
            repo_dir / "model" / "config.json",
            code=f"model-{repo_dir.name}-config-missing",
            message=f"Model repo {repo_dir.name} is missing model/config.json.",
        )
        require_file(
            alerts,
            repo_dir / "model" / "model.safetensors",
            code=f"model-{repo_dir.name}-weights-missing",
            message=f"Model repo {repo_dir.name} is missing model/model.safetensors.",
        )
    else:
        alerts.append(
            build_alert(
                "critical",
                f"model-{repo_dir.name}-layout-invalid",
                f"Model repo {repo_dir.name} has unsupported artifact layout {artifact_layout!r}.",
                path=str(repo_dir),
            )
        )


def build_health_report(
    *,
    release_dir: Path,
    min_training_examples: int,
    min_reasoning_donors: int,
    required_categories: list[str],
    require_held_out: bool,
) -> dict[str, Any]:
    alerts: list[dict[str, Any]] = []
    release_manifest_path = release_dir / "release_manifest.json"
    if not require_file(
        alerts,
        release_manifest_path,
        code="release-manifest-missing",
        message="Release bundle is missing release_manifest.json.",
    ):
        return {
            "checked_at": datetime.now(timezone.utc).isoformat(),
            "release_dir": str(release_dir),
            "status": "critical",
            "alert_count": len(alerts),
            "alerts": alerts,
        }

    manifest = load_json(release_manifest_path)
    dataset_repo = Path(str(manifest.get("dataset_repo", ""))).resolve()
    if not dataset_repo.exists():
        alerts.append(
            build_alert(
                "critical",
                "dataset-repo-missing",
                "Release manifest points to a missing dataset repo.",
                path=str(dataset_repo),
            )
        )
        status = "critical"
        return {
            "checked_at": datetime.now(timezone.utc).isoformat(),
            "release_dir": str(release_dir),
            "status": status,
            "alert_count": len(alerts),
            "alerts": alerts,
        }

    data_dir = dataset_repo / "data"
    for filename in REQUIRED_DATA_FILES:
        require_file(
            alerts,
            data_dir / filename,
            code=f"dataset-{filename.replace('.', '-')}-missing",
            message=f"Dataset repo is missing required data file {filename}.",
        )

    dataset_manifest_path = dataset_repo / "dataset_manifest.json"
    dataset_manifest = load_json(dataset_manifest_path) if dataset_manifest_path.exists() else {}
    materialized_manifest = dataset_manifest.get("materializedManifest", {})
    if not isinstance(materialized_manifest, dict):
        alerts.append(
            build_alert(
                "critical",
                "dataset-manifest-invalid",
                "dataset_manifest.json is missing materializedManifest.",
                path=str(dataset_manifest_path),
            )
        )
        materialized_manifest = {}

    training_examples = int(materialized_manifest.get("trainingExampleCount") or 0)
    reasoning_donors = int(materialized_manifest.get("reasoningDonorCount") or 0)
    if training_examples < min_training_examples:
        alerts.append(
            build_alert(
                "warning",
                "training-count-low",
                f"Training example count {training_examples} is below threshold {min_training_examples}.",
                path=str(dataset_manifest_path),
            )
        )
    if reasoning_donors < min_reasoning_donors:
        alerts.append(
            build_alert(
                "warning",
                "reasoning-donor-count-low",
                f"Reasoning donor count {reasoning_donors} is below threshold {min_reasoning_donors}.",
                path=str(dataset_manifest_path),
            )
        )

    weighted_manifest = validate_export_dir(
        dataset_repo / "exports" / "weighted",
        alerts=alerts,
        required_categories=required_categories,
        require_held_out=require_held_out,
        label="weighted",
    )
    unweighted_manifest = validate_export_dir(
        dataset_repo / "exports" / "unweighted",
        alerts=alerts,
        required_categories=required_categories,
        require_held_out=require_held_out,
        label="unweighted",
    )

    models = manifest.get("models", [])
    if not isinstance(models, list) or not models:
        alerts.append(
            build_alert(
                "critical",
                "models-missing",
                "Release manifest is missing model entries.",
                path=str(release_manifest_path),
            )
        )
        models = []
    for model_payload in models:
        if not isinstance(model_payload, dict):
            alerts.append(
                build_alert(
                    "critical",
                    "model-entry-invalid",
                    "Release manifest contains an invalid model entry.",
                )
            )
            continue
        repo_dir = Path(str(model_payload.get("repo_dir", ""))).resolve()
        if not repo_dir.exists():
            alerts.append(
                build_alert(
                    "critical",
                    "model-repo-missing",
                    f"Model repo is missing for {model_payload.get('id', 'unknown')}.",
                    path=str(repo_dir),
                )
            )
            continue
        validate_model_repo(repo_dir, model_payload, alerts)

    status = "healthy"
    if any(alert["level"] == "critical" for alert in alerts):
        status = "critical"
    elif alerts:
        status = "warning"

    return {
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "release_dir": str(release_dir),
        "status": status,
        "alert_count": len(alerts),
        "alerts": alerts,
        "summary": {
            "trainingExampleCount": training_examples,
            "reasoningDonorCount": reasoning_donors,
            "weightedTrajectoryCount": int((weighted_manifest or {}).get("trajectoryCount") or 0),
            "unweightedTrajectoryCount": int(
                (unweighted_manifest or {}).get("trajectoryCount") or 0
            ),
            "modelCount": len(models),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate scam-defense release artifacts and emit alerts."
    )
    parser.add_argument(
        "--release-dir", required=True, help="Path to the built scam-defense release directory."
    )
    parser.add_argument("--output", default="", help="Optional path for the health report JSON.")
    parser.add_argument("--min-training-examples", type=int, default=1000)
    parser.add_argument("--min-reasoning-donors", type=int, default=100)
    parser.add_argument(
        "--required-category",
        action="append",
        default=None,
        help="Require coverage for this category in weighted and unweighted exports. Pass multiple times.",
    )
    parser.add_argument(
        "--require-held-out",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Require held-out evaluation splits for both weighted and unweighted exports.",
    )
    args = parser.parse_args()

    required_categories = list(args.required_category or DEFAULT_REQUIRED_CATEGORIES)
    release_dir = Path(args.release_dir).resolve()
    health_report = build_health_report(
        release_dir=release_dir,
        min_training_examples=args.min_training_examples,
        min_reasoning_donors=args.min_reasoning_donors,
        required_categories=required_categories,
        require_held_out=bool(args.require_held_out),
    )

    output_path = (
        Path(args.output).resolve() if args.output else release_dir / "release_health.json"
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(health_report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(health_report, indent=2))
    return 1 if health_report["status"] == "critical" else 0


if __name__ == "__main__":
    raise SystemExit(main())
