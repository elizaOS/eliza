#!/usr/bin/env python3
"""Rank quarantined macro-placement candidates by deterministic proxy scores.

The evaluator consumes candidate manifests emitted by
train_macro_placement_policy.py. It does not replay candidates, edit design
sources, or claim physical-design improvement. It produces an auditable ranking
that says which candidate should be tried first once OpenLane/OpenROAD replay is
available.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_RUN_ID = "validation"
DEFAULT_CANDIDATE_DIR = ROOT / "build/ai_eda/macro_placement_policy/validation/candidates"
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/macro_placement_candidate_eval"
CLAIM_BOUNDARY = "macro_placement_candidate_ranking_only_no_openroad_replay_or_release_claim"
REQUIRED_REPLAY_GATES = {
    "deterministic_openroad_replay",
    "timing_check",
    "global_route_or_congestion_check",
    "drc_check",
    "antenna_check",
    "power_or_pdn_check",
    "human_review",
}


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def load_record(path: Path) -> dict[str, Any]:
    if path.suffix == ".json":
        data = json.loads(path.read_text(encoding="utf-8"))
    else:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected mapping")
    return data


def candidate_paths(explicit_candidates: list[Path], candidate_dirs: list[Path]) -> list[Path]:
    paths = list(explicit_candidates)
    for directory in candidate_dirs:
        if directory.exists():
            paths.extend(sorted(directory.glob("*.json")))
    deduped: list[Path] = []
    seen: set[Path] = set()
    for path in paths:
        resolved = path.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        deduped.append(path)
    return sorted(deduped)


def validate_candidate(record: dict[str, Any], path: Path) -> list[str]:
    errors = []
    record_id = record.get("id", rel(path))
    if record.get("schema") != "eda.e1_candidate.v1":
        errors.append(f"{record_id}: schema must be eda.e1_candidate.v1")
    if record.get("candidate_type") != "macro_placement":
        errors.append(f"{record_id}: candidate_type must be macro_placement")
    if not isinstance(record.get("proposed_changes"), list) or not record.get("proposed_changes"):
        errors.append(f"{record_id}: proposed_changes must be a non-empty list")
    generated_by = record.get("generated_by")
    if not isinstance(generated_by, dict):
        errors.append(f"{record_id}: generated_by must be a mapping")
    elif not isinstance(generated_by.get("score"), dict):
        errors.append(f"{record_id}: generated_by.score is required for ranking")
    ladder = record.get("validation_ladder")
    if not isinstance(ladder, dict):
        errors.append(f"{record_id}: validation_ladder must be a mapping")
    else:
        required = set(ladder.get("required_gates", []))
        missing_replay = sorted(REQUIRED_REPLAY_GATES - required)
        if missing_replay:
            errors.append(f"{record_id}: missing replay gate requirements {missing_replay}")
    decision = record.get("decision")
    if not isinstance(decision, dict) or decision.get("status") not in {"replayed_blocked", "pending"}:
        errors.append(f"{record_id}: ranking requires a quarantined candidate status")
    claim_boundary = record.get("claim_boundary")
    if not isinstance(claim_boundary, str) or "release_claim" not in claim_boundary:
        errors.append(f"{record_id}: claim_boundary must forbid release claims")
    return errors


def case_id_from_candidate(record: dict[str, Any]) -> str:
    record_id = str(record["id"])
    policy = str(record.get("generated_by", {}).get("policy", "unknown"))
    prefixes = {
        "center_legal_baseline": "macro-placement-center-baseline-",
        "target_aware_grid": "macro-placement-target-aware-grid-",
        "target_repair_search": "macro-placement-target-repair-search-",
        "supervised_mean_legalized_grid": "macro-placement-supervised-mean-",
        "torch_regressor_legalized_grid": "macro-placement-torch-regressor-",
    }
    prefix = prefixes.get(policy)
    if prefix and record_id.startswith(prefix) and record_id.endswith("-validation"):
        return record_id.removeprefix(prefix).removesuffix("-validation")
    return str(record.get("design_bundle_id", "unknown-design-bundle"))


def rank_key(item: dict[str, Any]) -> tuple[float, float, float, str]:
    score = item["score"]
    proxy_score = score.get("score")
    overlap_count = float(score.get("overlap_count", 0))
    out_of_bounds_count = float(score.get("out_of_bounds_count", 0))
    numeric_score = float(proxy_score) if proxy_score is not None else float("-inf")
    return (-overlap_count, -out_of_bounds_count, numeric_score, item["id"])


def summarize_candidate(path: Path, record: dict[str, Any]) -> dict[str, Any]:
    generated_by = record["generated_by"]
    score = generated_by["score"]
    ladder = record.get("validation_ladder", {})
    completed = set(ladder.get("completed_gates", [])) if isinstance(ladder, dict) else set()
    required = set(ladder.get("required_gates", [])) if isinstance(ladder, dict) else set()
    missing_gates = sorted(required - completed)
    return {
        "id": record["id"],
        "path": rel(path),
        "case_id": case_id_from_candidate(record),
        "design_bundle_id": record["design_bundle_id"],
        "policy": generated_by.get("policy", "unknown"),
        "score": score,
        "decision_status": record.get("decision", {}).get("status"),
        "missing_gates": missing_gates,
        "release_use_allowed": False,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default=DEFAULT_RUN_ID)
    parser.add_argument("--candidate", action="append", type=Path, default=[])
    parser.add_argument("--candidate-dir", action="append", type=Path, default=[])
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    candidate_dirs = args.candidate_dir or [
        DEFAULT_CANDIDATE_DIR if args.run_id == DEFAULT_RUN_ID else ROOT / "build/ai_eda/macro_placement_policy" / args.run_id / "candidates"
    ]
    selected_candidate_paths = candidate_paths(args.candidate, candidate_dirs)
    errors: list[str] = []
    candidates: list[dict[str, Any]] = []
    for path in selected_candidate_paths:
        if not path.exists():
            errors.append(f"{path}: missing candidate")
            continue
        try:
            record = load_record(path)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{path}: {exc}")
            continue
        record_errors = validate_candidate(record, path)
        errors.extend(record_errors)
        if not record_errors:
            candidates.append(summarize_candidate(path, record))

    out_dir = args.out_root / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)

    ranked_by_case = []
    for case_id in sorted({candidate["case_id"] for candidate in candidates}):
        case_candidates = [candidate for candidate in candidates if candidate["case_id"] == case_id]
        ranked = sorted(case_candidates, key=rank_key, reverse=True)
        best = ranked[0] if ranked else None
        ranked_by_case.append(
            {
                "case_id": case_id,
                "candidate_count": len(ranked),
                "best_candidate_id": best["id"] if best else None,
                "best_policy": best["policy"] if best else None,
                "best_score": best["score"] if best else None,
                "ranked_candidates": ranked,
            }
        )

    report = {
        "schema": "eliza.ai_eda.macro_placement_candidate_eval.v1",
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "candidate_dirs": [rel(path) for path in candidate_dirs],
        "candidate_paths": [rel(path) for path in selected_candidate_paths],
        "candidate_count": len(candidates),
        "error_count": len(errors),
        "errors": errors,
        "ranked_by_case": ranked_by_case,
        "next_required_gates": [
            "select at most one top candidate per case for deterministic replay",
            "import selected candidate into an isolated OpenLane/OpenROAD run tree",
            "compare replayed timing/congestion/DRC/antenna/power metrics against the baseline",
            "require human PD review before any source or config promotion",
        ],
        "release_use_allowed": False,
    }
    report_path = out_dir / "macro_placement_candidate_eval_report.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.macro_placement_candidate_eval {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.macro_placement_candidate_eval "
        f"candidates={len(candidates)} cases={len(ranked_by_case)} {rel(report_path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
