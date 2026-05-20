from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT_PATH = (
    Path(__file__).resolve().parent.parent / "scripts" / "check_scam_defense_release_health.py"
)

if not SCRIPT_PATH.exists():
    pytest.skip(f"script not found: {SCRIPT_PATH.name}", allow_module_level=True)


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def build_release_dir(root: Path, *, with_held_out: bool = True) -> Path:
    release_dir = root / "release"
    dataset_repo = release_dir / "huggingface" / "datasets" / "demo-dataset"
    model_repo = release_dir / "huggingface" / "models" / "demo-model"
    data_dir = dataset_repo / "data"
    weighted_dir = dataset_repo / "exports" / "weighted"
    unweighted_dir = dataset_repo / "exports" / "unweighted"
    (model_repo / "adapters").mkdir(parents=True, exist_ok=True)

    for filename in [
        "training_examples.jsonl",
        "detector_corpus.jsonl",
        "conversation_corpus.jsonl",
        "sft_corpus.jsonl",
        "reasoning_donor_corpus.jsonl",
        "scambench_scenario_seeds.jsonl",
    ]:
        (data_dir / filename).parent.mkdir(parents=True, exist_ok=True)
        (data_dir / filename).write_text('{"id":"demo"}\n', encoding="utf-8")
    write_json(data_dir / "scambench_curated_scenarios.json", {"scenarios": [{"id": "demo"}]})
    write_json(data_dir / "scenario_catalog.json", {"scenarios": [{"id": "demo"}]})

    category_counts = {
        "social-engineering": 10,
        "prompt-injection": 5,
        "secret-exfiltration": 5,
        "cli-execution": 2,
        "admin-override": 1,
        "environment-tampering": 1,
    }
    for export_dir in [weighted_dir, unweighted_dir]:
        export_dir.mkdir(parents=True, exist_ok=True)
        (export_dir / "trajectories.jsonl").write_text('{"trajectory":"demo"}\n', encoding="utf-8")
        write_json(
            export_dir / "manifest.json",
            {"trajectoryCount": 5, "sampleCount": 20, "categoryCounts": category_counts},
        )
        if with_held_out:
            held_out_dir = export_dir / "held-out"
            held_out_dir.mkdir(parents=True, exist_ok=True)
            (held_out_dir / "trajectories.jsonl").write_text(
                '{"trajectory":"eval"}\n', encoding="utf-8"
            )
            write_json(
                held_out_dir / "manifest.json",
                {"trajectoryCount": 2, "sampleCount": 8, "categoryCounts": category_counts},
            )

    write_json(
        dataset_repo / "dataset_manifest.json",
        {
            "materializedManifest": {
                "trainingExampleCount": 3149,
                "reasoningDonorCount": 474,
            }
        },
    )
    (model_repo / "README.md").write_text("# model\n", encoding="utf-8")
    write_json(model_repo / "benchmark_summary.json", {"overall": 1.0})
    write_json(model_repo / "training_manifest.json", {"backend": "mlx"})
    (model_repo / "adapters" / "adapter_config.json").write_text("{}", encoding="utf-8")
    (model_repo / "adapters" / "adapters.safetensors").write_bytes(b"weights")
    write_json(
        release_dir / "release_manifest.json",
        {
            "releaseName": "demo",
            "dataset_repo": str(dataset_repo),
            "models": [
                {
                    "id": "demo-model",
                    "repo_dir": str(model_repo),
                    "artifact_layout": "adapter",
                }
            ],
        },
    )
    return release_dir


def test_check_scam_defense_release_health_reports_healthy_release(tmp_path: Path) -> None:
    release_dir = build_release_dir(tmp_path)

    proc = subprocess.run(
        [sys.executable, str(SCRIPT_PATH), "--release-dir", str(release_dir)],
        capture_output=True,
        text=True,
        check=False,
    )

    assert proc.returncode == 0
    health = json.loads(proc.stdout)
    assert health["status"] == "healthy"
    assert health["alert_count"] == 0


def test_check_scam_defense_release_health_warns_on_missing_held_out(tmp_path: Path) -> None:
    release_dir = build_release_dir(tmp_path, with_held_out=False)

    proc = subprocess.run(
        [sys.executable, str(SCRIPT_PATH), "--release-dir", str(release_dir)],
        capture_output=True,
        text=True,
        check=False,
    )

    assert proc.returncode == 1
    health = json.loads(proc.stdout)
    assert health["status"] == "critical"
    assert any(alert["code"] == "weighted-held-out-missing" for alert in health["alerts"])
