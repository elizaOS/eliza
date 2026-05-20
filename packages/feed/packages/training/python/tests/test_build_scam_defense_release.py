"""
Tests for the canonical scam-defense release bundle builder.
"""

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

PYTHON_ROOT = Path(__file__).resolve().parent.parent


def load_script_module(module_name: str, script_path: Path):
    spec = importlib.util.spec_from_file_location(module_name, script_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


_first_script = Path(__file__).resolve().parent.parent / "scripts" / "build_scam_defense_release.py"
if not _first_script.exists():
    pytest.skip("script not found: build_scam_defense_release.py", allow_module_level=True)

release_script = load_script_module(
    "build_scam_defense_release",
    PYTHON_ROOT / "scripts" / "build_scam_defense_release.py",
)


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def test_load_release_selection_rewrites_legacy_workspace_paths(
    tmp_path: Path,
    monkeypatch,
):
    marketplace_root = tmp_path / "Marketplace-of-Trust"
    paper_root = tmp_path / "paper"
    (paper_root / "runs" / "scam-defense").mkdir(parents=True, exist_ok=True)
    (paper_root / "generated").mkdir(parents=True, exist_ok=True)
    (paper_root / "trained-models").mkdir(parents=True, exist_ok=True)
    (tmp_path / "scambench" / "generated").mkdir(parents=True, exist_ok=True)
    (tmp_path / "scambench" / "results" / "local-eval").mkdir(parents=True, exist_ok=True)

    experiment_registry = paper_root / "runs" / "scam-defense" / "experiment_registry.json"
    publication_summary_md = paper_root / "generated" / "publication_summary.md"
    paper_pdf = paper_root / "babylon_scam_defense_paper.pdf"
    model_dir = paper_root / "trained-models" / "demo-model"
    model_dir.mkdir(parents=True, exist_ok=True)
    scenario_catalog = tmp_path / "scambench" / "generated" / "scenario-catalog.json"
    scambench_eval_score = tmp_path / "scambench" / "results" / "local-eval" / "demo-score.json"

    write_json(experiment_registry, {"experiments": []})
    publication_summary_md.write_text("# summary\n", encoding="utf-8")
    paper_pdf.write_bytes(b"%PDF-1.4\n")
    write_json(scenario_catalog, {"scenarios": []})
    write_json(scambench_eval_score, {"overallScore": 2.0})

    selection_path = tmp_path / "release_selection.json"
    write_json(
        selection_path,
        {
            "release_name": "demo-release",
            "dataset": {
                "repo_name": "demo-dataset",
                "materialized_dir": str(marketplace_root / "materialized"),
                "weighted_export_dir": str(marketplace_root / "weighted"),
                "unweighted_export_dir": str(marketplace_root / "unweighted"),
                "scenario_catalog": str(
                    tmp_path / "benchmarks" / "scambench" / "generated" / "scenario-catalog.json"
                ),
                "experiment_registry": str(
                    marketplace_root / "runs" / "scam-defense" / "experiment_registry.json"
                ),
                "scambench_comparison": str(marketplace_root / "generated" / "comparison.json"),
                "publication_summary_md": str(
                    marketplace_root / "generated" / "publication_summary.md"
                ),
                "publication_summary_json": str(
                    marketplace_root / "generated" / "publication_summary.json"
                ),
                "paper_pdf": str(marketplace_root / "babylon_scam_defense_paper.pdf"),
            },
            "recommended_models": {},
            "methodology_caveats": [],
            "models": [
                {
                    "id": "demo-model",
                    "repo_name": "demo-model",
                    "label": "Demo Model",
                    "role": "candidate",
                    "base_model": "demo/base",
                    "source_dir": str(marketplace_root / "trained-models" / "demo-model"),
                    "scambench_score": 1.0,
                    "scambench_score_file": str(
                        tmp_path
                        / "benchmarks"
                        / "scambench"
                        / "results"
                        / "local-eval"
                        / "demo-score.json"
                    ),
                    "notes": "demo",
                }
            ],
        },
    )

    monkeypatch.setattr(release_script, "WORKSPACE_ROOT", tmp_path)

    normalized = release_script.load_release_selection(selection_path)

    assert normalized["dataset"]["experiment_registry"] == str(experiment_registry)
    assert normalized["dataset"]["publication_summary_md"] == str(publication_summary_md)
    assert normalized["dataset"]["paper_pdf"] == str(paper_pdf)
    assert normalized["dataset"]["scenario_catalog"] == str(scenario_catalog)
    assert normalized["models"][0]["source_dir"] == str(model_dir)
    assert normalized["models"][0]["scambench_score_file"] == str(scambench_eval_score)
    assert normalized["dataset"]["repo_name"] == "demo-dataset"


def test_build_release_bundle_creates_hf_ready_layout(tmp_path: Path):
    materialized_dir = tmp_path / "materialized"
    for name in release_script.DATASET_FILES:
        target = materialized_dir / name
        target.parent.mkdir(parents=True, exist_ok=True)
        if name.endswith(".jsonl"):
            target.write_text('{"id":"demo"}\n', encoding="utf-8")
        elif name.endswith(".json"):
            write_json(target, {"scenarios": []} if "scambench_curated" in name else {"ok": True})
        else:
            target.write_text("# summary\n", encoding="utf-8")
    write_json(
        materialized_dir / "manifest.json",
        {
            "trainingExampleCount": 10,
            "detectorCount": 3,
            "conversationCount": 4,
            "sftCount": 2,
            "scenarioCount": 5,
        },
    )

    weighted_export_dir = tmp_path / "weighted-export"
    unweighted_export_dir = tmp_path / "unweighted-export"
    for export_dir, trajectory_count in [(weighted_export_dir, 7), (unweighted_export_dir, 5)]:
        (export_dir / "trajectories.jsonl").parent.mkdir(parents=True, exist_ok=True)
        (export_dir / "trajectories.jsonl").write_text('{"trajectory":"demo"}\n', encoding="utf-8")
        write_json(
            export_dir / "manifest.json",
            {
                "trajectoryCount": trajectory_count,
                "sampleCount": trajectory_count * 4,
            },
        )

    scenario_catalog = tmp_path / "scenario-catalog.json"
    write_json(scenario_catalog, {"scenarios": [{"id": "demo"}]})

    experiment_registry = tmp_path / "experiment_registry.json"
    write_json(experiment_registry, {"study": "demo", "experiments": []})
    scambench_comparison = tmp_path / "scambench-comparison.json"
    write_json(
        scambench_comparison,
        [
            {
                "handler": "demo-handler",
                "scenariosRun": 1,
                "overallScore": 88.0,
            }
        ],
    )

    publication_summary_md = tmp_path / "publication_summary.md"
    publication_summary_md.write_text("# summary\n", encoding="utf-8")
    publication_summary_json = tmp_path / "publication_summary.json"
    write_json(publication_summary_json, {"sections": {"scambench": {"available": True}}})
    paper_pdf = tmp_path / "paper.pdf"
    paper_pdf.write_bytes(b"%PDF-1.4\n")

    model_source = tmp_path / "model"
    adapters_dir = model_source / "adapters"
    adapters_dir.mkdir(parents=True)
    (adapters_dir / "adapter_config.json").write_text('{"r":8}\n', encoding="utf-8")
    (adapters_dir / "adapters.safetensors").write_bytes(b"weights")
    (adapters_dir / "0000010_adapters.safetensors").write_bytes(b"old-checkpoint")
    write_json(
        model_source / "training_manifest.json",
        {
            "backend": "mlx",
            "model_name": "mlx-community/Qwen3.5-4B-MLX-4bit",
            "source_dir": "/tmp/source",
            "eval_source_dir": "/tmp/eval",
            "raw_training_sample_count": 12,
            "training_sample_count": 24,
            "validation_passed": False,
        },
    )
    write_json(model_source / "validation_report.json", {"passed": False})

    scambench_score = tmp_path / "scambench_score.json"
    write_json(scambench_score, {"overallScore": 88.0})
    trustbench_score = tmp_path / "trustbench_score.json"
    write_json(trustbench_score, {"overall_f1": 0.75, "total_tests": 10})

    selection = {
        "release_name": "demo-release",
        "dataset": {
            "repo_name": "demo-dataset",
            "materialized_dir": str(materialized_dir),
            "weighted_export_dir": str(weighted_export_dir),
            "unweighted_export_dir": str(unweighted_export_dir),
            "scenario_catalog": str(scenario_catalog),
            "experiment_registry": str(experiment_registry),
            "scambench_comparison": str(scambench_comparison),
            "publication_summary_md": str(publication_summary_md),
            "publication_summary_json": str(publication_summary_json),
            "paper_pdf": str(paper_pdf),
        },
        "recommended_models": {
            "benchmark_best": "demo-model",
            "balanced_best": "demo-model",
            "best_9b": "demo-model",
        },
        "methodology_caveats": ["demo caveat"],
        "models": [
            {
                "id": "demo-model",
                "repo_name": "demo-model-repo",
                "label": "Demo Model",
                "role": "benchmark-best",
                "base_model": "mlx-community/Qwen3.5-4B-MLX-4bit",
                "source_dir": str(model_source),
                "scambench_score": 88.0,
                "scambench_score_file": str(scambench_score),
                "trustbench_macro_f1": 0.75,
                "trustbench_file": str(trustbench_score),
                "notes": "demo notes",
            }
        ],
    }
    selection_path = tmp_path / "release_selection.json"
    write_json(selection_path, selection)

    output_root = tmp_path / "release-output"
    manifest = release_script.build_release_bundle(selection_path, output_root, clean=True)

    dataset_repo = output_root / "huggingface" / "datasets" / "demo-dataset"
    model_repo = output_root / "huggingface" / "models" / "demo-model-repo"

    assert manifest["dataset_repo"] == str(dataset_repo)
    assert (dataset_repo / "README.md").exists()
    assert (dataset_repo / "data" / "scenario_catalog.json").exists()
    assert (dataset_repo / "exports" / "weighted" / "trajectories.jsonl").exists()
    assert (dataset_repo / "benchmarks" / "scambench-comparison.json").exists()

    assert (model_repo / "README.md").exists()
    assert (model_repo / "benchmark_summary.json").exists()
    assert (model_repo / "adapters" / "adapter_config.json").exists()
    assert (model_repo / "adapters" / "adapters.safetensors").exists()
    assert not (model_repo / "adapters" / "0000010_adapters.safetensors").exists()
    assert manifest["models"][0]["artifact_layout"] == "adapter"
    assert "adapters/adapter_config.json" in manifest["models"][0]["model_files"]

    root_readme = (output_root / "README.md").read_text(encoding="utf-8")
    publish_text = (output_root / "PUBLISH.md").read_text(encoding="utf-8")
    assert "demo-release" in root_readme
    assert "huggingface-cli upload demo-dataset" in publish_text


def test_build_release_bundle_supports_full_model_layout(tmp_path: Path):
    materialized_dir = tmp_path / "materialized"
    for name in release_script.DATASET_FILES:
        target = materialized_dir / name
        target.parent.mkdir(parents=True, exist_ok=True)
        if name.endswith(".jsonl"):
            target.write_text('{"id":"demo"}\n', encoding="utf-8")
        elif name.endswith(".json"):
            write_json(target, {"scenarios": []} if "scambench_curated" in name else {"ok": True})
        else:
            target.write_text("# summary\n", encoding="utf-8")
    write_json(
        materialized_dir / "manifest.json",
        {
            "trainingExampleCount": 10,
            "detectorCount": 3,
            "conversationCount": 4,
            "sftCount": 2,
            "scenarioCount": 5,
        },
    )

    export_dir = tmp_path / "export"
    (export_dir / "trajectories.jsonl").parent.mkdir(parents=True, exist_ok=True)
    (export_dir / "trajectories.jsonl").write_text('{"trajectory":"demo"}\n', encoding="utf-8")
    write_json(export_dir / "manifest.json", {"trajectoryCount": 1, "sampleCount": 2})

    scenario_catalog = tmp_path / "scenario-catalog.json"
    write_json(scenario_catalog, {"scenarios": [{"id": "demo"}]})
    experiment_registry = tmp_path / "experiment_registry.json"
    write_json(experiment_registry, {"study": "demo", "experiments": []})
    scambench_comparison = tmp_path / "scambench-comparison.json"
    write_json(scambench_comparison, [{"handler": "demo-handler", "overallScore": 1.0}])
    publication_summary_md = tmp_path / "publication_summary.md"
    publication_summary_md.write_text("# summary\n", encoding="utf-8")
    publication_summary_json = tmp_path / "publication_summary.json"
    write_json(publication_summary_json, {"ok": True})
    paper_pdf = tmp_path / "paper.pdf"
    paper_pdf.write_bytes(b"%PDF-1.4\n")

    model_source = tmp_path / "full-model"
    model_source.mkdir(parents=True)
    (model_source / "config.json").write_text('{"architectures":["Demo"]}\n', encoding="utf-8")
    (model_source / "generation_config.json").write_text('{"max_length":128}\n', encoding="utf-8")
    (model_source / "model.safetensors").write_bytes(b"weights")
    (model_source / "tokenizer_config.json").write_text(
        '{"tokenizer_class":"Demo"}\n', encoding="utf-8"
    )
    write_json(
        model_source / "training_manifest.json",
        {
            "backend": "cuda",
            "model_name": "Qwen/Qwen3.5-4B",
            "source_dir": "/tmp/source",
            "eval_source_dir": "/tmp/eval",
            "raw_training_sample_count": 12,
            "training_sample_count": 24,
            "validation_passed": True,
        },
    )
    write_json(
        model_source / "validation_report.json",
        {"passed": True, "primary_gate": {"label": "pass (action_reason)"}},
    )

    scambench_score = tmp_path / "scambench_score.json"
    write_json(scambench_score, {"overallScore": 12.0})

    selection = {
        "release_name": "demo-release",
        "dataset": {
            "repo_name": "demo-dataset",
            "materialized_dir": str(materialized_dir),
            "weighted_export_dir": str(export_dir),
            "unweighted_export_dir": str(export_dir),
            "scenario_catalog": str(scenario_catalog),
            "experiment_registry": str(experiment_registry),
            "scambench_comparison": str(scambench_comparison),
            "publication_summary_md": str(publication_summary_md),
            "publication_summary_json": str(publication_summary_json),
            "paper_pdf": str(paper_pdf),
        },
        "recommended_models": {
            "benchmark_best": "demo-model",
            "balanced_best": "demo-model",
            "best_9b": "demo-model",
        },
        "methodology_caveats": ["demo caveat"],
        "models": [
            {
                "id": "demo-model",
                "repo_name": "demo-model-repo",
                "label": "Demo Model",
                "role": "benchmark-best",
                "base_model": "Qwen/Qwen3.5-4B",
                "source_dir": str(model_source),
                "artifact_layout": "full-model",
                "scambench_score": 12.0,
                "scambench_score_file": str(scambench_score),
                "notes": "demo notes",
            }
        ],
    }
    selection_path = tmp_path / "release_selection.json"
    write_json(selection_path, selection)

    output_root = tmp_path / "release-output"
    manifest = release_script.build_release_bundle(selection_path, output_root, clean=True)
    model_repo = output_root / "huggingface" / "models" / "demo-model-repo"

    assert (model_repo / "model" / "config.json").exists()
    assert (model_repo / "model" / "model.safetensors").exists()
    assert manifest["models"][0]["artifact_layout"] == "full-model"
    assert "model/model.safetensors" in manifest["models"][0]["model_files"]


def test_build_release_cli_logs_missing_selection(tmp_path: Path):
    proc = subprocess.run(
        [
            sys.executable,
            str(PYTHON_ROOT / "scripts" / "build_scam_defense_release.py"),
            "--selection",
            str(tmp_path / "missing-selection.json"),
            "--output-dir",
            str(tmp_path / "output"),
        ],
        capture_output=True,
        text=True,
        check=False,
    )

    assert proc.returncode == 1
    assert "Scam-defense release build failed" in proc.stderr
