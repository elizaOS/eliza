#!/usr/bin/env python3
"""Validate logic-synthesis recipe corpus and baseline reports."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CORPUS = ROOT / "build/ai_eda/logic_synthesis_recipes/validation/recipe_corpus.json"
DEFAULT_REPORT = ROOT / "build/ai_eda/logic_synthesis_baselines/validation/baseline_report.json"
CORPUS_CLAIM_BOUNDARY = (
    "logic_synthesis_recipe_corpus_only_no_training_inference_ppa_or_release_claim"
)
BASELINE_CLAIM_BOUNDARY = "logic_synthesis_baseline_only_no_ppa_equivalence_or_release_claim"
VALID_RESULT_STATUSES = {
    "PASS_YOSYS_RECIPE_SMOKE",
    "BLOCKED_EXTERNAL_ASSET_NOT_FETCHED",
    "BLOCKED_RECIPE_TIMEOUT",
}


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


def validate_corpus(corpus: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if corpus.get("schema") != "eliza.ai_eda.logic_synthesis_recipe_corpus.v1":
        errors.append("corpus schema must be eliza.ai_eda.logic_synthesis_recipe_corpus.v1")
    if corpus.get("claim_boundary") != CORPUS_CLAIM_BOUNDARY:
        errors.append("corpus claim_boundary is missing or incorrect")
    if corpus.get("release_use_allowed") is not False:
        errors.append("corpus release_use_allowed must be false")
    policy = corpus.get("policy")
    if not isinstance(policy, dict) or policy.get("source_modification_forbidden") is not True:
        errors.append("corpus policy must forbid source modification")
    for field in (
        "technology_mapped_qor_requires_liberty_sdc_and_equivalence",
        "accepted_recipe_requires_before_after_equivalence",
        "openabc_d_records_blocked_until_external_asset_review",
    ):
        if not isinstance(policy, dict) or policy.get(field) is not True:
            errors.append(f"corpus policy {field} must be true")

    targets = corpus.get("target_modules")
    recipes = corpus.get("recipes")
    if not isinstance(targets, list) or not targets:
        errors.append("corpus target_modules must be a non-empty list")
        targets = []
    if not isinstance(recipes, list) or not recipes:
        errors.append("corpus recipes must be a non-empty list")
        recipes = []

    seen_targets: set[str] = set()
    for target in targets:
        if not isinstance(target, dict):
            errors.append("target entries must be objects")
            continue
        target_id = target.get("id")
        if not isinstance(target_id, str) or not target_id:
            errors.append("target entry missing id")
        elif target_id in seen_targets:
            errors.append(f"{target_id}: duplicate target id")
        else:
            seen_targets.add(target_id)
        if not isinstance(target.get("top"), str) or not target.get("top"):
            errors.append(f"{target_id}: top must be a non-empty string")
        rtl = target.get("rtl")
        if not isinstance(rtl, list) or not rtl:
            errors.append(f"{target_id}: rtl must be a non-empty list")
        else:
            for path_text in rtl:
                path = repo_path(str(path_text))
                if not path.exists():
                    errors.append(f"{target_id}: missing RTL {rel(path)}")

    seen_recipes: set[str] = set()
    for recipe in recipes:
        if not isinstance(recipe, dict):
            errors.append("recipe entries must be objects")
            continue
        recipe_id = recipe.get("id")
        if not isinstance(recipe_id, str) or not recipe_id:
            errors.append("recipe entry missing id")
        elif recipe_id in seen_recipes:
            errors.append(f"{recipe_id}: duplicate recipe id")
        else:
            seen_recipes.add(recipe_id)
        if not isinstance(recipe.get("family"), str) or not recipe.get("family"):
            errors.append(f"{recipe_id}: family must be a non-empty string")
        external = recipe.get("requires_external_assets")
        if not isinstance(external, list):
            errors.append(f"{recipe_id}: requires_external_assets must be a list")
        passes = recipe.get("passes")
        if external:
            blockers = recipe.get("blocked_until")
            if not isinstance(blockers, list) or not blockers:
                errors.append(f"{recipe_id}: external recipes require blocked_until entries")
        elif not isinstance(passes, list) or not passes:
            errors.append(f"{recipe_id}: local recipes require non-empty passes")
    return errors


def validate_metrics(metrics: Any, result_id: str) -> list[str]:
    errors: list[str] = []
    if not isinstance(metrics, dict):
        return [f"{result_id}: metrics must be a mapping"]
    for field in ("wire_count", "wire_bits", "cell_count"):
        value = metrics.get(field)
        if not isinstance(value, int) or value <= 0:
            errors.append(f"{result_id}: metrics.{field} must be a positive integer")
    histogram = metrics.get("cell_histogram")
    if not isinstance(histogram, dict) or not histogram:
        errors.append(f"{result_id}: metrics.cell_histogram must be non-empty")
    elif any(not isinstance(value, int) or value <= 0 for value in histogram.values()):
        errors.append(f"{result_id}: cell histogram values must be positive integers")
    return errors


def validate_report(report: dict[str, Any], report_path: Path, corpus: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if report.get("schema") != "eliza.ai_eda.logic_synthesis_policy_baseline.v1":
        errors.append("baseline schema must be eliza.ai_eda.logic_synthesis_policy_baseline.v1")
    if report.get("claim_boundary") != BASELINE_CLAIM_BOUNDARY:
        errors.append("baseline claim_boundary is missing or incorrect")
    if report.get("release_use_allowed") is not False:
        errors.append("baseline release_use_allowed must be false")
    if report.get("run_id") != report_path.parent.name:
        errors.append("baseline run_id must match report directory name")

    if report.get("status") == "BLOCKED_YOSYS_NOT_FOUND":
        if report.get("results") != []:
            errors.append("BLOCKED_YOSYS_NOT_FOUND reports must have empty results")
        return errors
    if report.get("status") not in {"PASS_WITH_BLOCKED_OPENABC_D", "PASS", "FAIL"}:
        errors.append("baseline status is not recognized")
    if report.get("status") == "FAIL":
        errors.append("baseline report has failing synthesis results")

    corpus_path = repo_path(str(report.get("corpus", "")))
    if not corpus_path.exists():
        errors.append(f"baseline corpus path is missing: {rel(corpus_path)}")
    yosys = report.get("yosys")
    if not isinstance(yosys, dict) or not yosys.get("path") or not yosys.get("version"):
        errors.append("non-blocked baseline report must record yosys path and version")

    targets = {
        str(item["id"]): item
        for item in corpus.get("target_modules", [])
        if isinstance(item, dict) and item.get("id")
    }
    recipes = {
        str(item["id"]): item
        for item in corpus.get("recipes", [])
        if isinstance(item, dict) and item.get("id")
    }
    expected_count = len(targets) * len(recipes)
    results = report.get("results")
    if not isinstance(results, list):
        errors.append("baseline results must be a list")
        return errors
    if len(results) != expected_count:
        errors.append(
            f"baseline result count {len(results)} does not match expected {expected_count}"
        )

    seen: set[str] = set()
    summary_counts = {"passed": 0, "blocked": 0, "failed": 0}
    for result in results:
        if not isinstance(result, dict):
            errors.append("baseline result entries must be objects")
            continue
        result_id = str(result.get("id", ""))
        if not result_id:
            errors.append("baseline result missing id")
        elif result_id in seen:
            errors.append(f"{result_id}: duplicate result id")
        else:
            seen.add(result_id)
        if result.get("claim_boundary") != BASELINE_CLAIM_BOUNDARY:
            errors.append(f"{result_id}: claim_boundary is missing or incorrect")
        target_id = result.get("target")
        recipe_id = result.get("recipe")
        if target_id not in targets:
            errors.append(f"{result_id}: unknown target {target_id}")
        if recipe_id not in recipes:
            errors.append(f"{result_id}: unknown recipe {recipe_id}")
        status = result.get("status")
        if status not in VALID_RESULT_STATUSES:
            errors.append(f"{result_id}: unsupported status {status}")
        elif str(status).startswith("PASS"):
            summary_counts["passed"] += 1
            if result.get("returncode") != 0:
                errors.append(f"{result_id}: passing result must have returncode 0")
            for artifact_field in ("script", "log"):
                artifact_path = repo_path(str(result.get(artifact_field, "")))
                if not artifact_path.exists():
                    errors.append(f"{result_id}: missing {artifact_field} {rel(artifact_path)}")
            errors.extend(validate_metrics(result.get("metrics"), result_id))
        elif str(status).startswith("BLOCKED"):
            summary_counts["blocked"] += 1
            if status == "BLOCKED_EXTERNAL_ASSET_NOT_FETCHED":
                blockers = result.get("blockers")
                if not isinstance(blockers, list) or not blockers:
                    errors.append(f"{result_id}: external-asset block requires blockers")
            if status == "BLOCKED_RECIPE_TIMEOUT":
                if not isinstance(result.get("timeout_s"), int) or result["timeout_s"] <= 0:
                    errors.append(f"{result_id}: timeout block requires positive timeout_s")
                for artifact_field in ("script", "log"):
                    artifact_path = repo_path(str(result.get(artifact_field, "")))
                    if not artifact_path.exists():
                        errors.append(
                            f"{result_id}: missing timeout {artifact_field} {rel(artifact_path)}"
                        )
        else:
            summary_counts["failed"] += 1
    summary = report.get("summary")
    if not isinstance(summary, dict):
        errors.append("baseline summary must be a mapping")
    else:
        for key, value in summary_counts.items():
            if summary.get(key) != value:
                errors.append(f"baseline summary.{key} does not match results")
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--corpus-only", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    errors: list[str] = []
    try:
        corpus = load_json(args.corpus)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.logic_synthesis_policy_baseline {args.corpus}: {exc}")
        return 1
    errors.extend(validate_corpus(corpus))
    if args.corpus_only:
        if errors:
            for error in errors:
                print(f"STATUS: FAIL ai_eda.logic_synthesis_policy_baseline {error}")
            return 1
        print(
            "STATUS: PASS ai_eda.logic_synthesis_recipe_corpus "
            f"targets={len(corpus.get('target_modules', []))} recipes={len(corpus.get('recipes', []))} "
            f"claim_boundary={CORPUS_CLAIM_BOUNDARY}"
        )
        return 0
    elif args.report.exists():
        try:
            report = load_json(args.report)
        except Exception as exc:  # noqa: BLE001
            print(f"STATUS: FAIL ai_eda.logic_synthesis_policy_baseline {args.report}: {exc}")
            return 1
        errors.extend(validate_report(report, args.report, corpus))
        summary = report.get("summary", {}) if isinstance(report.get("summary"), dict) else {}
    else:
        errors.append(f"missing baseline report: {rel(args.report)}")
        summary = {}
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.logic_synthesis_policy_baseline {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.logic_synthesis_policy_baseline "
        f"passed={summary.get('passed', 0)} blocked={summary.get('blocked', 0)} "
        f"failed={summary.get('failed', 0)} claim_boundary={BASELINE_CLAIM_BOUNDARY}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
