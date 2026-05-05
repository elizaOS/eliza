#!/usr/bin/env python3
"""
Build a canonical scam-defense release bundle for local use and Hugging Face.

The bundle is self-contained and intentionally narrow:
- one canonical dataset repo layout
- one canonical set of model repo layouts
- one canonical release manifest and publish/training instructions

It does not retrain models or re-run benchmarks. It packages the already
selected artifacts recorded in Marketplace-of-Trust/runs/scam-defense.
"""

from __future__ import annotations

import argparse
import json
import logging
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

WORKSPACE_ROOT = Path(__file__).resolve().parents[5]
LOGGER = logging.getLogger(__name__)


def default_selection_path() -> Path:
    return WORKSPACE_ROOT / "paper" / "runs" / "scam-defense" / "release_selection.json"


def default_output_root() -> Path:
    return WORKSPACE_ROOT / "babylon" / "releases" / "scam-defense-v1"


DATASET_FILES = [
    "training_examples.jsonl",
    "detector_corpus.jsonl",
    "conversation_corpus.jsonl",
    "sft_corpus.jsonl",
    "reasoning_donor_corpus.jsonl",
    "scambench_scenario_seeds.jsonl",
    "scambench_curated_scenarios.json",
    "manifest.json",
    "summary.md",
]
EXPORT_FILES = [
    "trajectories.jsonl",
    "manifest.json",
]
HELD_OUT_FILES = [
    "trajectories.jsonl",
    "manifest.json",
]
ADAPTER_FILES = [
    "adapter_config.json",
    "adapters.safetensors",
]
FULL_MODEL_FILES = [
    "config.json",
    "generation_config.json",
    "model.safetensors",
    "tokenizer.json",
    "tokenizer.model",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "merges.txt",
    "vocab.json",
    "added_tokens.json",
]


def load_json(path: Path) -> dict[str, Any] | list[Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def copy_file(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)


def copy_selected_files(src_dir: Path, dst_dir: Path, filenames: list[str]) -> list[str]:
    copied: list[str] = []
    dst_dir.mkdir(parents=True, exist_ok=True)
    for name in filenames:
        src = src_dir / name
        if not src.exists():
            continue
        copy_file(src, dst_dir / name)
        copied.append(name)
    return copied


def copy_model_payload(
    src_dir: Path, repo_dir: Path, artifact_layout: str
) -> tuple[str, list[str]]:
    if artifact_layout == "adapter":
        adapters_src = src_dir / "adapters"
        adapters_dst = repo_dir / "adapters"
        copied = copy_selected_files(adapters_src, adapters_dst, ADAPTER_FILES)
        return "adapter", [f"adapters/{name}" for name in copied]

    model_dst = repo_dir / "model"
    copied = copy_selected_files(src_dir, model_dst, FULL_MODEL_FILES)
    for shard in sorted(src_dir.glob("model-*.safetensors")):
        copy_file(shard, model_dst / shard.name)
        copied.append(shard.name)
    return "full-model", [f"model/{name}" for name in copied]


def safe_slug(value: str) -> str:
    return "".join(char.lower() if char.isalnum() else "-" for char in value).strip("-")


def legacy_selection_root_mappings() -> list[tuple[Path, Path]]:
    return [
        (
            WORKSPACE_ROOT / "Marketplace-of-Trust",
            WORKSPACE_ROOT / "paper",
        ),
        (
            WORKSPACE_ROOT / "benchmarks" / "scambench",
            WORKSPACE_ROOT / "scambench",
        ),
    ]


def normalize_selection_paths(payload: Any) -> Any:
    if isinstance(payload, dict):
        return {key: normalize_selection_paths(value) for key, value in payload.items()}
    if isinstance(payload, list):
        return [normalize_selection_paths(value) for value in payload]
    if not isinstance(payload, str) or not payload.startswith("/"):
        return payload

    for legacy_root, current_root in legacy_selection_root_mappings():
        legacy_prefix = str(legacy_root)
        if payload == legacy_prefix or payload.startswith(f"{legacy_prefix}/"):
            legacy_path = Path(payload)
            current_path = current_root / legacy_path.relative_to(legacy_root)
            if not legacy_path.exists() and current_path.exists():
                return str(current_path)
    return payload


def load_release_selection(path: Path) -> dict[str, Any]:
    payload = load_json(path)
    if not isinstance(payload, dict):
        raise ValueError(f"Release selection must be a JSON object: {path}")
    normalized = normalize_selection_paths(payload)
    if not isinstance(normalized, dict):
        raise ValueError(f"Normalized release selection must be a JSON object: {path}")
    return normalized


def dataset_card_text(
    selection: dict[str, Any],
    dataset_manifest: dict[str, Any],
    weighted_manifest: dict[str, Any],
    unweighted_manifest: dict[str, Any],
    comparison: list[dict[str, Any]],
) -> str:
    top_handler = comparison[0]["handler"] if comparison else "n/a"
    top_score = comparison[0]["overallScore"] if comparison else "n/a"
    caveats = selection.get("methodology_caveats", [])
    caveat_lines = "\n".join(f"- {item}" for item in caveats)
    return "\n".join(
        [
            "---",
            "license: mit",
            "language:",
            "  - en",
            "tags:",
            "  - scam-defense",
            "  - prompt-injection",
            "  - social-engineering",
            "  - benchmark",
            "  - red-team",
            "pretty_name: Babylon Scam Defense v1",
            "---",
            "",
            "# Babylon Scam Defense v1",
            "",
            "Canonical release dataset for the Babylon anti-scam training and evaluation work.",
            "",
            "## Contents",
            "",
            f"- Materialized training examples: `{dataset_manifest['trainingExampleCount']}`",
            f"- Detector rows: `{dataset_manifest['detectorCount']}`",
            f"- Conversation rows: `{dataset_manifest['conversationCount']}`",
            f"- SFT rows: `{dataset_manifest['sftCount']}`",
            f"- Reasoning donors: `{dataset_manifest.get('reasoningDonorCount', 0)}`",
            f"- Curated ScamBench scenarios: `{dataset_manifest['scenarioCount']}`",
            f"- Weighted Babylon trajectories: `{weighted_manifest['trajectoryCount']}` trajectories / `{weighted_manifest['sampleCount']}` samples",
            f"- Unweighted Babylon trajectories: `{unweighted_manifest['trajectoryCount']}` trajectories / `{unweighted_manifest['sampleCount']}` samples",
            "",
            "## Benchmark Snapshot",
            "",
            f"- Top full-catalog ScamBench checkpoint: `{top_handler}` at `{top_score}`",
            "",
            "## Files",
            "",
            "- `data/training_examples.jsonl`: agent-policy training examples.",
            "- `data/detector_corpus.jsonl`: detector-style scam rows for auxiliary modeling.",
            "- `data/conversation_corpus.jsonl`: source conversations retained for analysis and augmentation.",
            "- `data/sft_corpus.jsonl`: prompt/response-style rows retained from source corpora.",
            "- `data/reasoning_donor_corpus.jsonl`: reasoning-trace donor rows retained for private-analysis synthesis.",
            "- `data/scambench_scenario_seeds.jsonl`: scenario seed inventory.",
            "- `data/scambench_curated_scenarios.json`: curated multi-turn scenarios.",
            "- `data/scenario_catalog.json`: canonical full ScamBench catalog for this release.",
            "- `exports/weighted/trajectories.jsonl`: weighted Babylon training export.",
            "- `exports/unweighted/trajectories.jsonl`: unweighted Babylon training export.",
            "",
            "## Methodology Caveats",
            "",
            caveat_lines,
            "",
        ]
    )


def model_card_text(
    selection: dict[str, Any],
    model_cfg: dict[str, Any],
    training_manifest: dict[str, Any],
    benchmark_summary: dict[str, Any],
    validation_report: dict[str, Any] | None,
    artifact_layout: str,
    included_files: list[str],
) -> str:
    caveats = selection.get("methodology_caveats", [])
    caveat_lines = "\n".join(f"- {item}" for item in caveats)
    validation_label = None
    json_aux_passed = None
    if isinstance(validation_report, dict):
        primary_gate = validation_report.get("primary_gate")
        if isinstance(primary_gate, dict):
            validation_label = primary_gate.get("label")
        json_aux = validation_report.get("json_format_aux")
        if not isinstance(json_aux, dict):
            json_aux = validation_report.get("decision_format")
        if isinstance(json_aux, dict):
            json_aux_passed = json_aux.get("passed")
    if validation_label:
        validation_line = f"- Primary deterministic validation: `{validation_label}`"
        if json_aux_passed is not None:
            validation_line += (
                f"\n- Auxiliary JSON-format recovery: `{'pass' if json_aux_passed else 'fail'}`"
            )
    else:
        validation_passed = training_manifest.get("validation_passed")
        validation_line = (
            f"- Deterministic validation passed: `{validation_passed}`"
            if validation_passed is not None
            else "- Deterministic validation: not recorded"
        )
    role = model_cfg.get("role", "candidate")
    included_file_lines = (
        [f"- `{name}`" for name in included_files]
        if included_files
        else ["- No model payload files were copied."]
    )
    return "\n".join(
        [
            "---",
            "license: mit",
            f"base_model: {model_cfg['base_model']}",
            "tags:",
            "  - scam-defense",
            "  - prompt-injection",
            "  - social-engineering",
            "  - lora",
            f"  - {safe_slug(role)}",
            "---",
            "",
            f"# {model_cfg['label']}",
            "",
            f"Role in release: `{role}`",
            "",
            "## Metrics",
            "",
            f"- Full-catalog ScamBench: `{benchmark_summary['scambench_overall_score']}`",
            validation_line,
            *(
                [
                    f"- Legacy detector benchmark F1: `{benchmark_summary['legacy_detector_macro_f1']}`"
                ]
                if benchmark_summary.get("legacy_detector_macro_f1") is not None
                else []
            ),
            "",
            "## Training",
            "",
            f"- Backend: `{training_manifest.get('backend')}`",
            f"- Base model: `{training_manifest.get('model_name')}`",
            f"- Source dir: `{training_manifest.get('source_dir')}`",
            f"- Eval source dir: `{training_manifest.get('eval_source_dir')}`",
            f"- Raw training samples: `{training_manifest.get('raw_training_sample_count')}`",
            f"- Training samples after formatting: `{training_manifest.get('training_sample_count')}`",
            "",
            "## Notes",
            "",
            f"- {model_cfg.get('notes', 'No additional notes.')}",
            "",
            "## Methodology Caveats",
            "",
            caveat_lines,
            "",
            "## Included Files",
            "",
            f"- Artifact layout: `{artifact_layout}`",
            *included_file_lines,
            "- `training_manifest.json`",
            "- `validation_report.json`",
            "- `benchmark_summary.json`",
            "",
        ]
    )


def root_readme_text(selection: dict[str, Any], manifest: dict[str, Any]) -> str:
    recommended = selection.get("recommended_models", {})
    models = manifest.get("models", [])
    model_lines = "\n".join(f"- `{item['id']}` -> `{item['repo_dir']}`" for item in models)
    return "\n".join(
        [
            f"# {selection['release_name']}",
            "",
            "Canonical local release bundle for the Babylon scam-defense work.",
            "",
            "## Recommended Checkpoints",
            "",
            f"- Benchmark best: `{recommended.get('benchmark_best')}`",
            f"- Balanced best: `{recommended.get('balanced_best')}`",
            f"- Best 9B: `{recommended.get('best_9b')}`",
            "",
            "## Layout",
            "",
            f"- Dataset repo: `{manifest['dataset_repo']}`",
            "- Model repos:",
            model_lines,
            "",
            "## Included Guidance",
            "",
            "- `TRAINING.md` for exact local retraining commands.",
            "- `PUBLISH.md` for Hugging Face upload commands.",
            "- `metadata/release_manifest.json` for the full machine-readable manifest.",
            "",
        ]
    )


def training_instructions_text(selection: dict[str, Any]) -> str:
    dataset = selection["dataset"]
    models = selection["models"]
    lines = [
        "# Training Commands",
        "",
        "These commands reproduce the packaged checkpoints from the canonical exports.",
        "",
    ]
    for model in models:
        source_dir = (
            dataset["unweighted_export_dir"]
            if "unweighted" in model["id"]
            else dataset["weighted_export_dir"]
        )
        lines.extend(
            [
                f"## {model['label']}",
                "",
                "```bash",
                "cd <BABYLON_ROOT>/packages/training/python/scripts",
                (
                    "python3 train_local.py "
                    f"--backend mlx "
                    f"--model {model['base_model']} "
                    f"--source-dir {source_dir} "
                    f"--eval-source-dir {source_dir} "
                    f"--output {model['source_dir']} "
                    "--iters 20 "
                    "--batch-size 1 "
                    "--max-seq-length 512 "
                    "--sample-profile raw "
                    "--validate"
                ),
                "```",
                "",
            ]
        )
    return "\n".join(lines)


def publish_instructions_text(selection: dict[str, Any], manifest: dict[str, Any]) -> str:
    dataset_repo = manifest["dataset_repo"]
    lines = [
        "# Hugging Face Publish Commands",
        "",
        "These commands assume `huggingface-cli login` is already done.",
        "",
        "## Dataset",
        "",
        "```bash",
        f"huggingface-cli upload {selection['dataset']['repo_name']} {dataset_repo} --repo-type dataset",
        "```",
        "",
        "## Models",
        "",
    ]
    for model in manifest["models"]:
        lines.extend(
            [
                f"### {model['id']}",
                "",
                "```bash",
                f"huggingface-cli upload {model['repo_name']} {model['repo_dir']}",
                "```",
                "",
            ]
        )
    return "\n".join(lines)


def build_dataset_repo(
    selection: dict[str, Any],
    output_root: Path,
) -> dict[str, Any]:
    dataset_cfg = selection["dataset"]
    materialized_dir = Path(dataset_cfg["materialized_dir"]).resolve()
    weighted_export_dir = Path(dataset_cfg["weighted_export_dir"]).resolve()
    unweighted_export_dir = Path(dataset_cfg["unweighted_export_dir"]).resolve()
    scenario_catalog = Path(dataset_cfg["scenario_catalog"]).resolve()
    experiment_registry = Path(dataset_cfg["experiment_registry"]).resolve()
    scambench_comparison = Path(dataset_cfg["scambench_comparison"]).resolve()

    repo_dir = output_root / "huggingface" / "datasets" / dataset_cfg["repo_name"]
    data_dir = repo_dir / "data"
    exports_dir = repo_dir / "exports"
    metadata_dir = repo_dir / "metadata"
    benchmarks_dir = repo_dir / "benchmarks"

    copied_dataset_files = copy_selected_files(materialized_dir, data_dir, DATASET_FILES)
    copy_file(scenario_catalog, data_dir / "scenario_catalog.json")
    copy_selected_files(weighted_export_dir, exports_dir / "weighted", EXPORT_FILES)
    copy_selected_files(unweighted_export_dir, exports_dir / "unweighted", EXPORT_FILES)
    # Include held-out eval splits when they exist
    weighted_held_out = weighted_export_dir / "held-out"
    unweighted_held_out = unweighted_export_dir / "held-out"
    if weighted_held_out.is_dir():
        copy_selected_files(
            weighted_held_out, exports_dir / "weighted" / "held-out", HELD_OUT_FILES
        )
    if unweighted_held_out.is_dir():
        copy_selected_files(
            unweighted_held_out, exports_dir / "unweighted" / "held-out", HELD_OUT_FILES
        )
    copy_file(experiment_registry, metadata_dir / "experiment_registry.json")
    copy_file(scambench_comparison, benchmarks_dir / "scambench-comparison.json")

    for optional_key, filename in [
        ("publication_summary_md", "publication_summary.md"),
        ("publication_summary_json", "publication_summary.json"),
    ]:
        source = Path(dataset_cfg[optional_key]).resolve()
        if source.exists():
            copy_file(source, metadata_dir / filename)

    dataset_manifest = load_json(materialized_dir / "manifest.json")
    if not isinstance(dataset_manifest, dict):
        raise ValueError("Merged materialized manifest must be a JSON object")
    weighted_manifest = load_json(weighted_export_dir / "manifest.json")
    unweighted_manifest = load_json(unweighted_export_dir / "manifest.json")
    comparison = load_json(scambench_comparison)
    if not isinstance(weighted_manifest, dict) or not isinstance(unweighted_manifest, dict):
        raise ValueError("Export manifests must be JSON objects")
    if not isinstance(comparison, list):
        raise ValueError("ScamBench comparison must be a JSON list")

    release_dataset_manifest = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "repoName": dataset_cfg["repo_name"],
        "sourceMaterializedDir": str(materialized_dir),
        "sourceScenarioCatalog": str(scenario_catalog),
        "sourceWeightedExportDir": str(weighted_export_dir),
        "sourceUnweightedExportDir": str(unweighted_export_dir),
        "copiedDatasetFiles": [*copied_dataset_files, "scenario_catalog.json"],
        "materializedManifest": dataset_manifest,
        "weightedExportManifest": weighted_manifest,
        "unweightedExportManifest": unweighted_manifest,
        "topScamBenchHandler": comparison[0] if comparison else None,
    }
    write_json(repo_dir / "dataset_manifest.json", release_dataset_manifest)
    (repo_dir / "README.md").write_text(
        dataset_card_text(
            selection=selection,
            dataset_manifest=dataset_manifest,
            weighted_manifest=weighted_manifest,
            unweighted_manifest=unweighted_manifest,
            comparison=comparison,
        )
        + "\n",
        encoding="utf-8",
    )
    return {
        "repo_dir": str(repo_dir),
        "repo_name": dataset_cfg["repo_name"],
        "manifest_path": str(repo_dir / "dataset_manifest.json"),
    }


def build_model_repo(
    selection: dict[str, Any],
    model_cfg: dict[str, Any],
    output_root: Path,
) -> dict[str, Any]:
    source_dir = Path(model_cfg["source_dir"]).resolve()
    repo_dir = output_root / "huggingface" / "models" / model_cfg["repo_name"]
    training_manifest_path = source_dir / "training_manifest.json"
    validation_report_path = source_dir / "validation_report.json"
    scambench_score_path = Path(model_cfg["scambench_score_file"]).resolve()
    trustbench_path = (
        Path(model_cfg["trustbench_file"]).resolve() if model_cfg.get("trustbench_file") else None
    )

    requested_layout = str(model_cfg.get("artifact_layout", "auto")).strip().lower()
    if requested_layout == "auto":
        artifact_layout = "adapter" if (source_dir / "adapters").is_dir() else "full-model"
    else:
        artifact_layout = requested_layout
    copied_model_files = []
    if artifact_layout in {"adapter", "full-model"}:
        artifact_layout, copied_model_files = copy_model_payload(
            source_dir, repo_dir, artifact_layout
        )
    else:
        raise ValueError(f"Unsupported artifact layout: {artifact_layout}")
    copy_file(training_manifest_path, repo_dir / "training_manifest.json")
    if validation_report_path.exists():
        copy_file(validation_report_path, repo_dir / "validation_report.json")
    copy_file(scambench_score_path, repo_dir / "scambench_score.json")
    if trustbench_path and trustbench_path.exists():
        copy_file(trustbench_path, repo_dir / "trustbench_score.json")

    training_manifest = load_json(training_manifest_path)
    if not isinstance(training_manifest, dict):
        raise ValueError("Training manifest must be a JSON object")
    validation_report = None
    if validation_report_path.exists():
        loaded_validation = load_json(validation_report_path)
        if isinstance(loaded_validation, dict):
            validation_report = loaded_validation
    trustbench_payload = None
    if trustbench_path and trustbench_path.exists():
        loaded_trustbench = load_json(trustbench_path)
        if not isinstance(loaded_trustbench, dict):
            raise ValueError("TrustBench payload must be a JSON object")
        trustbench_payload = loaded_trustbench

    benchmark_summary = {
        "role": model_cfg["role"],
        "scambench_overall_score": model_cfg["scambench_score"],
        "scambench_score_file": str(scambench_score_path),
        "legacy_detector_macro_f1": model_cfg.get("trustbench_macro_f1"),
        "legacy_detector_file": str(trustbench_path) if trustbench_path else None,
        "legacy_detector_total_tests": trustbench_payload.get("total_tests")
        if trustbench_payload
        else None,
    }
    write_json(repo_dir / "benchmark_summary.json", benchmark_summary)
    (repo_dir / "README.md").write_text(
        model_card_text(
            selection=selection,
            model_cfg=model_cfg,
            training_manifest=training_manifest,
            benchmark_summary=benchmark_summary,
            validation_report=validation_report,
            artifact_layout=artifact_layout,
            included_files=copied_model_files,
        )
        + "\n",
        encoding="utf-8",
    )
    return {
        "id": model_cfg["id"],
        "repo_name": model_cfg["repo_name"],
        "repo_dir": str(repo_dir),
        "artifact_layout": artifact_layout,
        "model_files": copied_model_files,
        "scambench_score": model_cfg["scambench_score"],
        "legacy_detector_macro_f1": model_cfg.get("trustbench_macro_f1"),
        "role": model_cfg["role"],
    }


def build_release_bundle(
    selection_path: Path,
    output_root: Path,
    clean: bool = False,
) -> dict[str, Any]:
    selection = load_release_selection(selection_path)

    if clean and output_root.exists():
        shutil.rmtree(output_root)
    output_root.mkdir(parents=True, exist_ok=True)

    dataset_info = build_dataset_repo(selection, output_root)
    model_infos = [
        build_model_repo(selection, model_cfg, output_root) for model_cfg in selection["models"]
    ]

    metadata_dir = output_root / "metadata"
    metadata_dir.mkdir(parents=True, exist_ok=True)
    write_json(metadata_dir / "release_selection.json", selection)

    paper_dir = output_root / "paper"
    paper_dir.mkdir(parents=True, exist_ok=True)
    for key, filename in [
        ("publication_summary_md", "publication_summary.md"),
        ("publication_summary_json", "publication_summary.json"),
        ("paper_pdf", "babylon_scam_defense_paper.pdf"),
    ]:
        source = Path(selection["dataset"][key]).resolve()
        if source.exists():
            copy_file(source, paper_dir / filename)

    manifest = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "releaseName": selection["release_name"],
        "selectionPath": str(selection_path.resolve()),
        "outputRoot": str(output_root.resolve()),
        "dataset_repo": dataset_info["repo_dir"],
        "models": model_infos,
        "recommended_models": selection.get("recommended_models", {}),
        "methodology_caveats": selection.get("methodology_caveats", []),
    }
    write_json(metadata_dir / "release_manifest.json", manifest)
    write_json(output_root / "release_manifest.json", manifest)
    (output_root / "README.md").write_text(
        root_readme_text(selection, manifest) + "\n", encoding="utf-8"
    )
    (output_root / "TRAINING.md").write_text(
        training_instructions_text(selection) + "\n", encoding="utf-8"
    )
    (output_root / "PUBLISH.md").write_text(
        publish_instructions_text(selection, manifest) + "\n", encoding="utf-8"
    )
    return manifest


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build a canonical scam-defense release bundle.")
    parser.add_argument(
        "--selection",
        default=str(default_selection_path()),
        help="Release selection JSON file.",
    )
    parser.add_argument(
        "--output-dir",
        default=str(default_output_root()),
        help="Directory to write the consolidated release bundle into.",
    )
    parser.add_argument(
        "--clean",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Delete the previous output directory before rebuilding.",
    )
    parser.add_argument("--log-level", default="INFO", help="Python logging level for stderr logs.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    logging.basicConfig(
        level=getattr(logging, str(args.log_level).upper(), logging.INFO),
        format="%(levelname)s %(name)s: %(message)s",
    )
    try:
        selection_path = Path(args.selection).resolve()
        output_root = Path(args.output_dir).resolve()
        LOGGER.info("Building scam-defense release from %s into %s", selection_path, output_root)
        manifest = build_release_bundle(
            selection_path=selection_path,
            output_root=output_root,
            clean=bool(args.clean),
        )
        LOGGER.info("Release bundle ready at %s", manifest["outputRoot"])
        print(json.dumps(manifest, indent=2))
        return 0
    except Exception:
        LOGGER.exception("Scam-defense release build failed")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
