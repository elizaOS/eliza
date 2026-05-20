from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT_PATH = Path(__file__).resolve().parent.parent / "scripts" / "manage_scam_defense_release.py"

if not SCRIPT_PATH.exists():
    pytest.skip(f"script not found: {SCRIPT_PATH.name}", allow_module_level=True)


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def build_release_dir(root: Path, label: str) -> Path:
    release_dir = root / label
    dataset_repo = release_dir / "huggingface" / "datasets" / f"{label}-dataset"
    model_repo = release_dir / "huggingface" / "models" / f"{label}-model"
    (dataset_repo / "data").mkdir(parents=True, exist_ok=True)
    (model_repo / "adapters").mkdir(parents=True, exist_ok=True)
    write_json(
        release_dir / "release_manifest.json",
        {
            "releaseName": label,
            "dataset_repo": str(dataset_repo),
            "models": [
                {
                    "id": f"{label}-model",
                    "repo_dir": str(model_repo),
                    "artifact_layout": "adapter",
                }
            ],
            "recommended_models": {"benchmark_best": f"{label}-model"},
        },
    )
    write_json(
        dataset_repo / "dataset_manifest.json",
        {"materializedManifest": {"trainingExampleCount": 10}},
    )
    (model_repo / "README.md").write_text("# model\n", encoding="utf-8")
    write_json(model_repo / "benchmark_summary.json", {"overall": 1.0})
    write_json(model_repo / "training_manifest.json", {"backend": "mlx"})
    (model_repo / "adapters" / "adapter_config.json").write_text("{}", encoding="utf-8")
    (model_repo / "adapters" / "adapters.safetensors").write_bytes(b"weights")
    return release_dir


def test_manage_scam_defense_release_promote_and_rollback(tmp_path: Path) -> None:
    release_root = tmp_path / "managed"
    release_one = build_release_dir(tmp_path, "candidate-one")
    release_two = build_release_dir(tmp_path, "candidate-two")

    promote_one = subprocess.run(
        [
            sys.executable,
            str(SCRIPT_PATH),
            "promote",
            "--release-dir",
            str(release_one),
            "--release-root",
            str(release_root),
            "--label",
            "candidate-one",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    payload_one = json.loads(promote_one.stdout)
    assert payload_one["release_id"].startswith("candidate-one-")
    assert (release_root / "current").is_symlink()

    promote_two = subprocess.run(
        [
            sys.executable,
            str(SCRIPT_PATH),
            "promote",
            "--release-dir",
            str(release_two),
            "--release-root",
            str(release_root),
            "--label",
            "candidate-two",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    payload_two = json.loads(promote_two.stdout)
    current = json.loads((release_root / "current.json").read_text(encoding="utf-8"))
    previous = json.loads((release_root / "previous.json").read_text(encoding="utf-8"))
    assert current["release_id"] == payload_two["release_id"]
    assert previous["release_id"] == payload_one["release_id"]

    rollback = subprocess.run(
        [
            sys.executable,
            str(SCRIPT_PATH),
            "rollback",
            "--release-root",
            str(release_root),
            "--target-release-id",
            payload_one["release_id"],
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    rollback_event = json.loads(rollback.stdout)
    current_after = json.loads((release_root / "current.json").read_text(encoding="utf-8"))
    assert rollback_event["to_release_id"] == payload_one["release_id"]
    assert current_after["release_id"] == payload_one["release_id"]
