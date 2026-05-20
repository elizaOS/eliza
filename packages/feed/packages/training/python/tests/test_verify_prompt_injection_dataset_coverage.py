"""
Tests for prompt-injection dataset coverage verification.
"""

import importlib.util
import json
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


_first_script = (
    Path(__file__).resolve().parent.parent
    / "scripts"
    / "verify_prompt_injection_dataset_coverage.py"
)
if not _first_script.exists():
    pytest.skip(
        "script not found: verify_prompt_injection_dataset_coverage.py", allow_module_level=True
    )

coverage_script = load_script_module(
    "verify_prompt_injection_dataset_coverage",
    PYTHON_ROOT / "scripts" / "verify_prompt_injection_dataset_coverage.py",
)


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")


def build_fixture_tree(tmp_path: Path, datasets: list[str]) -> dict[str, Path]:
    source_root = tmp_path / "datasets" / "source" / "huggingface"
    registry_path = tmp_path / "datasets" / "manifests" / "source_registry.json"
    catalog_path = tmp_path / "datasets" / "manifests" / "source_catalog.json"
    analysis_path = tmp_path / "datasets" / "process" / "normalization-plan" / "analysis.json"
    canonical_root = tmp_path / "datasets" / "process" / "canonical-seeds"
    final_mix_root = tmp_path / "datasets" / "final" / "corpus"

    registry_records = []
    catalog_records = []
    analysis_records = []
    canonical_rows = []
    format_rows = []

    for index, dataset_name in enumerate(datasets):
        slug = coverage_script.slugify(dataset_name)
        dataset_dir = source_root / slug
        dataset_dir.mkdir(parents=True, exist_ok=True)
        (dataset_dir / "data.jsonl").write_text('{"text":"hello"}\n', encoding="utf-8")

        registry_records.append(
            {
                "repo_id": dataset_name,
                "group": "prompt_injection_jailbreak",
                "processing_bucket": "attack_prompt_injection",
                "status": "downloaded",
                "local_path": str(dataset_dir),
            }
        )
        catalog_records.append({"repo_id": dataset_name})
        analysis_records.append(
            {
                "name": dataset_name,
                "group": "prompt_injection_jailbreak",
                "analysisStatus": "ok",
                "transformFamily": "prompt_attack_seed",
                "targetBehavior": "prompt_injection_defense",
            }
        )
        canonical_rows.append({"sourceDataset": dataset_name, "seedId": f"{dataset_name}::{index}"})
        format_rows.append(
            {"metadata": {"sourceDataset": dataset_name}, "id": f"{dataset_name}::{index}"}
        )

    write_json(
        registry_path,
        {
            "records": registry_records,
            "status_counts": {"downloaded": len(registry_records)},
            "group_counts": {"prompt_injection_jailbreak": len(registry_records)},
        },
    )
    write_json(catalog_path, {"huggingface_datasets": catalog_records})
    write_json(analysis_path, {"datasets": analysis_records})

    canonical_dir = canonical_root / "demo-canonical"
    write_json(canonical_dir / "manifest.json", {"seedCount": len(canonical_rows)})
    write_jsonl(canonical_dir / "canonical-seeds.jsonl", canonical_rows)

    sweep_dir = final_mix_root / "demo-sweep"
    write_json(sweep_dir / "sweep-summary.json", {"mixCount": 1})
    mix_dir = sweep_dir / "a40-b20-l25-r10-s15"
    for format_name in coverage_script.REQUIRED_FORMAT_FILES:
        write_jsonl(mix_dir / "formats" / format_name, format_rows)

    return {
        "source_root": source_root,
        "registry_path": registry_path,
        "catalog_path": catalog_path,
        "analysis_path": analysis_path,
        "canonical_root": canonical_root,
        "final_mix_root": final_mix_root,
    }


def test_build_report_passes_when_required_datasets_are_covered(tmp_path: Path):
    datasets = ["alpha/prompt-dataset", "beta/prompt-dataset"]
    paths = build_fixture_tree(tmp_path, datasets)

    report = coverage_script.build_report(
        datasets=datasets,
        source_root=paths["source_root"],
        registry_path=paths["registry_path"],
        catalog_path=paths["catalog_path"],
        analysis_path=paths["analysis_path"],
        canonical_root=paths["canonical_root"],
        final_mix_root=paths["final_mix_root"],
    )

    assert report["overallStatus"] == "pass"
    assert report["issues"] == []
    assert report["selectedMixName"] == "a40-b20-l25-r10-s15"
    assert report["requiredDatasets"]["alpha/prompt-dataset"]["canonicalSeedCount"] == 1
    assert (
        report["requiredDatasets"]["beta/prompt-dataset"]["bestMixFormatCounts"]["canonical.jsonl"]
        == 1
    )


def test_build_report_fails_when_dataset_missing_from_mix_formats(tmp_path: Path):
    datasets = ["alpha/prompt-dataset", "beta/prompt-dataset"]
    paths = build_fixture_tree(tmp_path, datasets)
    mix_dir = paths["final_mix_root"] / "demo-sweep" / "a40-b20-l25-r10-s15"
    write_jsonl(
        mix_dir / "formats" / "openclaw-session.jsonl",
        [{"metadata": {"sourceDataset": "alpha/prompt-dataset"}, "id": "alpha::0"}],
    )

    report = coverage_script.build_report(
        datasets=datasets,
        source_root=paths["source_root"],
        registry_path=paths["registry_path"],
        catalog_path=paths["catalog_path"],
        analysis_path=paths["analysis_path"],
        canonical_root=paths["canonical_root"],
        final_mix_root=paths["final_mix_root"],
    )

    assert report["overallStatus"] == "fail"
    assert any(
        "beta/prompt-dataset: absent from openclaw-session.jsonl" in issue
        for issue in report["issues"]
    )
