#!/usr/bin/env python3
"""Rerun CompactBench cases and capture response-level valid-hit analysis.

The standard CompactBench JSONL intentionally stores compact scorecards,
not the judge model's raw answers. That is enough for official scores, but
not enough to tell whether a failed lexical check is a real compaction miss
or a scorer false negative. This script reruns the same case generation and
drift cycle loop, stores the artifact/response context needed for auditing,
and adds a conservative adjusted score from ``eliza_compactbench.valid_hits``.

The official CompactBench score is preserved in the output. The adjusted
score is a separate diagnostic metric.
"""

from __future__ import annotations

import argparse
import asyncio
import copy
from dataclasses import dataclass
from datetime import UTC, datetime
import json
import os
from pathlib import Path
import sys
import time
from typing import Any

from eliza_compactbench.cerebras_provider import register_cerebras_provider
from eliza_compactbench.valid_hits import evaluate_valid_hit, is_refusal, normalize_text


@dataclass(frozen=True)
class ItemAnalysis:
    item_key: str
    item_type: str
    check_type: str
    expected: dict[str, Any]
    prompt: str
    response: str
    official_score: float
    adjusted_score: float
    quality_score: float | None
    weight: float
    reason: str
    valid_false_negative: bool
    semantic_false_positive: bool
    invalid_expected_conflict: bool
    judge_refusal: bool


@dataclass(frozen=True)
class CycleAnalysis:
    cycle_number: int
    official_score: float
    adjusted_score: float
    adjusted_score_excluding_invalid: float | None
    official_penalized_score: float
    adjusted_penalized_score: float
    adjusted_penalized_score_excluding_invalid: float | None
    contradiction_rate: float
    compression_ratio: float
    latency_ms: int
    artifact: dict[str, Any]
    artifact_context: str
    items: list[ItemAnalysis]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--method")
    parser.add_argument("--suite", default="starter")
    parser.add_argument("--model", default="gpt-oss-120b")
    parser.add_argument(
        "--benchmarks-dir",
        default="external/compactbench-suites/benchmarks/public",
        type=Path,
    )
    parser.add_argument("--output", default=None, type=Path)
    parser.add_argument("--case-count", type=int, default=1)
    parser.add_argument("--drift-cycles", type=int, default=2)
    parser.add_argument("--difficulty", default="medium")
    parser.add_argument("--seed-group", default="default")
    parser.add_argument(
        "--template-key",
        action="append",
        default=None,
        help="Limit analysis to one template key. Repeat for multiple templates.",
    )
    parser.add_argument(
        "--seed-slot",
        action="append",
        type=int,
        default=None,
        help="Limit analysis to one case slot. Repeat for multiple slots.",
    )
    parser.add_argument(
        "--provider",
        default="cerebras",
        help="CompactBench provider key. The cerebras provider is registered automatically.",
    )
    parser.add_argument(
        "--rescore-from",
        type=Path,
        default=None,
        help=(
            "Recalculate adjusted scores from an existing analysis JSONL "
            "without rerunning compaction or model calls."
        ),
    )
    args = parser.parse_args()

    if args.rescore_from is not None:
        output = args.output or args.rescore_from.with_name(
            f"{args.rescore_from.stem}.rescored.jsonl"
        )
        summary = _rescore_analysis(args.rescore_from, output)
        print(json.dumps(summary, indent=2, sort_keys=True))
        print(f"wrote {output}")
        return 0

    if not args.method:
        print("error: --method is required unless --rescore-from is used", file=sys.stderr)
        return 2

    if args.output is None:
        args.output = Path("valid-hit-analysis.jsonl")

    if args.provider == "cerebras":
        if not os.environ.get("CEREBRAS_API_KEY"):
            print("error: CEREBRAS_API_KEY is required for --provider cerebras", file=sys.stderr)
            return 2
        if not register_cerebras_provider():
            print("error: failed to register cerebras provider", file=sys.stderr)
            return 2

    try:
        summary = asyncio.run(_run_analysis(args))
    except KeyboardInterrupt:
        print(f"\ninterrupted; partial analysis written to {args.output}", file=sys.stderr)
        return 130

    print(json.dumps(summary, indent=2, sort_keys=True))
    print(f"wrote {args.output}")
    return 0


async def _run_analysis(args: argparse.Namespace) -> dict[str, Any]:
    from compactbench.dsl import DifficultyLevel, load_suite, validate_template
    from compactbench.engine import derive_case_seed, generate_case
    from compactbench.providers import get_provider_cls
    from compactbench.runner import resolve_compactor_class

    difficulty = DifficultyLevel(args.difficulty.lower())
    suite_dir = args.benchmarks_dir / args.suite
    if not suite_dir.is_dir():
        raise SystemExit(f"suite directory not found: {suite_dir}")

    templates = load_suite(suite_dir)
    if not templates:
        raise SystemExit(f"no templates in suite {args.suite!r}")
    for template in templates:
        validate_template(template)

    compactor_cls = resolve_compactor_class(args.method)
    provider = get_provider_cls(args.provider)()
    suite_version = _suite_version(templates)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    official_case_scores: list[float] = []
    adjusted_case_scores: list[float] = []
    adjusted_case_scores_excluding_invalid: list[float] = []
    total_items = 0
    quality_scored_items = 0
    quality_scored_items = 0
    valid_false_negatives = 0
    semantic_false_positives = 0
    failures_remaining = 0
    failures_remaining_excluding_invalid = 0
    invalid_expected_conflicts = 0
    judge_refusals = 0
    started_at = datetime.now(UTC)

    with args.output.open("w", encoding="utf-8") as fh:
        _write_event(
            fh,
            {
                "event": "analysis_start",
                "started_at": started_at.isoformat().replace("+00:00", "Z"),
                "method_spec": args.method,
                "method_name": compactor_cls.name,
                "suite_key": args.suite,
                "suite_version": suite_version,
                "provider": args.provider,
                "model": args.model,
                "difficulty": difficulty.value,
                "drift_cycles": args.drift_cycles,
                "seed_group": args.seed_group,
                "case_count_per_template": args.case_count,
                "template_key_filter": args.template_key,
                "seed_slot_filter": args.seed_slot,
            },
        )

        for template in templates:
            if args.template_key and template.key not in set(args.template_key):
                continue
            slots = args.seed_slot if args.seed_slot is not None else range(args.case_count)
            for slot in slots:
                if slot < 0 or slot >= args.case_count:
                    raise SystemExit(
                        f"--seed-slot {slot} is outside --case-count {args.case_count}"
                    )
                case_seed = derive_case_seed(
                    f"{args.suite}@{suite_version}", args.seed_group, slot
                )
                case = generate_case(template, case_seed, difficulty)
                compactor = compactor_cls(provider, args.model)
                case_cycles = await _execute_case_with_analysis(
                    case=case,
                    compactor=compactor,
                    provider=provider,
                    model=args.model,
                    drift_cycles=args.drift_cycles,
                    case_seed=case_seed,
                )
                official_case_score = _mean(
                    [cycle.official_penalized_score for cycle in case_cycles]
                )
                adjusted_case_score = _mean(
                    [cycle.adjusted_penalized_score for cycle in case_cycles]
                )
                adjusted_case_score_excluding_invalid = _mean_optional(
                    [
                        cycle.adjusted_penalized_score_excluding_invalid
                        for cycle in case_cycles
                    ]
                )
                official_case_scores.append(official_case_score)
                adjusted_case_scores.append(adjusted_case_score)
                if adjusted_case_score_excluding_invalid is not None:
                    adjusted_case_scores_excluding_invalid.append(
                        adjusted_case_score_excluding_invalid
                    )
                case_valid_false_negatives = sum(
                    1 for cycle in case_cycles for item in cycle.items if item.valid_false_negative
                )
                case_semantic_false_positives = sum(
                    1 for cycle in case_cycles for item in cycle.items if item.semantic_false_positive
                )
                case_failures_remaining = sum(
                    1 for cycle in case_cycles for item in cycle.items if item.adjusted_score < 1.0
                )
                case_invalid_expected_conflicts = sum(
                    1
                    for cycle in case_cycles
                    for item in cycle.items
                    if item.invalid_expected_conflict
                )
                case_judge_refusals = sum(
                    1 for cycle in case_cycles for item in cycle.items if item.judge_refusal
                )
                case_failures_remaining_excluding_invalid = sum(
                    1
                    for cycle in case_cycles
                    for item in cycle.items
                    if item.quality_score is not None and item.quality_score < 1.0
                )
                case_quality_scored_items = sum(
                    1
                    for cycle in case_cycles
                    for item in cycle.items
                    if item.quality_score is not None
                )
                total_items += sum(len(cycle.items) for cycle in case_cycles)
                quality_scored_items += case_quality_scored_items
                valid_false_negatives += case_valid_false_negatives
                semantic_false_positives += case_semantic_false_positives
                failures_remaining += case_failures_remaining
                failures_remaining_excluding_invalid += (
                    case_failures_remaining_excluding_invalid
                )
                invalid_expected_conflicts += case_invalid_expected_conflicts
                judge_refusals += case_judge_refusals

                _write_event(
                    fh,
                    {
                        "event": "case_analysis",
                        "case_id": case.case_id,
                        "template_key": case.template_key,
                        "seed": case.seed,
                        "ground_truth": case.ground_truth.model_dump(),
                        "official_case_score": official_case_score,
                        "adjusted_case_score": adjusted_case_score,
                        "adjusted_case_score_excluding_invalid": (
                            adjusted_case_score_excluding_invalid
                        ),
                        "benchmark_quality_case_score": (
                            adjusted_case_score_excluding_invalid
                        ),
                        "valid_false_negatives": case_valid_false_negatives,
                        "semantic_false_positives": case_semantic_false_positives,
                        "failures_remaining": case_failures_remaining,
                        "failures_remaining_excluding_invalid": (
                            case_failures_remaining_excluding_invalid
                        ),
                        "benchmark_quality_scored_items": case_quality_scored_items,
                        "invalid_expected_conflicts": case_invalid_expected_conflicts,
                        "judge_refusals": case_judge_refusals,
                        "cycles": [_cycle_to_dict(cycle) for cycle in case_cycles],
                    },
                )

        benchmark_quality_score = _mean_optional(adjusted_case_scores_excluding_invalid)
        summary = {
            "event": "analysis_end",
            "completed_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            "official_overall_score": _mean(official_case_scores),
            "adjusted_overall_score": _mean(adjusted_case_scores),
            "adjusted_overall_score_excluding_invalid": benchmark_quality_score,
            "benchmark_quality_score": benchmark_quality_score,
            "score_delta": _mean(adjusted_case_scores) - _mean(official_case_scores),
            "score_delta_excluding_invalid": _score_delta_optional(
                benchmark_quality_score,
                _mean(official_case_scores),
            ),
            "total_items": total_items,
            "benchmark_quality_scored_items": quality_scored_items,
            "benchmark_quality_unscored_items": total_items - quality_scored_items,
            "benchmark_quality_scored_cases": len(adjusted_case_scores_excluding_invalid),
            "benchmark_quality_unscored_cases": (
                len(official_case_scores) - len(adjusted_case_scores_excluding_invalid)
            ),
            "valid_false_negatives": valid_false_negatives,
            "semantic_false_positives": semantic_false_positives,
            "failures_remaining": failures_remaining,
            "failures_remaining_excluding_invalid": failures_remaining_excluding_invalid,
            "invalid_expected_conflicts": invalid_expected_conflicts,
            "judge_refusals": judge_refusals,
            "notes": [
                "official scores are unmodified CompactBench scores",
                "adjusted scores use response-local valid-hit analysis only",
                "benchmark_quality_score excludes impossible generated checks where the same value is both required and forbidden",
            ],
        }
        _write_event(fh, summary)
        return summary


async def _execute_case_with_analysis(
    *,
    case: Any,
    compactor: Any,
    provider: Any,
    model: str,
    drift_cycles: int,
    case_seed: int,
) -> list[CycleAnalysis]:
    from compactbench.contracts import CompactionArtifact, Transcript
    from compactbench.runner import (
        evaluate_items,
        extend_with_continuation,
        render_artifact_for_prompt,
    )
    from compactbench.scoring import score_cycle

    transcript: Transcript = case.transcript
    previous_artifact: CompactionArtifact | None = None
    cycles: list[CycleAnalysis] = []

    for cycle_num in range(drift_cycles + 1):
        started = time.perf_counter()
        working_transcript = transcript
        if cycle_num >= 1 and previous_artifact is not None:
            working_transcript = await extend_with_continuation(
                working_transcript,
                previous_artifact,
                provider,
                model,
                case_seed,
                cycle_num,
            )

        artifact = await compactor.compact(
            working_transcript, previous_artifact=previous_artifact
        )
        responses = await evaluate_items(case.evaluation_items, artifact, provider, model)
        scorecard = score_cycle(case, artifact, responses, cycle_number=cycle_num)
        items = _analyze_items(
            case.evaluation_items,
            responses,
            scorecard.item_scores,
            invalid_expected_values=_ground_truth_conflict_values(case.ground_truth),
        )
        adjusted_score = _weighted_score(items, attr="adjusted_score")
        adjusted_score_excluding_invalid = _weighted_score_excluding_invalid(
            items, attr="quality_score"
        )
        adjusted_penalized = max(0.0, min(1.0, adjusted_score * (1.0 - scorecard.contradiction_rate)))
        adjusted_penalized_excluding_invalid = (
            None
            if adjusted_score_excluding_invalid is None
            else max(
                0.0,
                min(
                    1.0,
                    adjusted_score_excluding_invalid
                    * (1.0 - scorecard.contradiction_rate),
                ),
            )
        )
        cycles.append(
            CycleAnalysis(
                cycle_number=cycle_num,
                official_score=scorecard.cycle_score,
                adjusted_score=adjusted_score,
                adjusted_score_excluding_invalid=adjusted_score_excluding_invalid,
                official_penalized_score=scorecard.penalized_cycle_score,
                adjusted_penalized_score=adjusted_penalized,
                adjusted_penalized_score_excluding_invalid=adjusted_penalized_excluding_invalid,
                contradiction_rate=scorecard.contradiction_rate,
                compression_ratio=scorecard.compression_ratio,
                latency_ms=int((time.perf_counter() - started) * 1000),
                artifact=artifact.model_dump(by_alias=True),
                artifact_context=render_artifact_for_prompt(artifact),
                items=items,
            )
        )
        transcript = working_transcript
        previous_artifact = artifact

    return cycles


def _analyze_items(
    evaluation_items: list[Any],
    responses: dict[str, str],
    item_scores: list[Any],
    *,
    invalid_expected_values: set[str] | None = None,
) -> list[ItemAnalysis]:
    score_by_key = {score.item_key: score for score in item_scores}
    invalid_expected_values = invalid_expected_values or set()
    analyses: list[ItemAnalysis] = []
    for item in evaluation_items:
        response = responses.get(item.key, "")
        official_item = score_by_key[item.key]
        valid = evaluate_valid_hit(item.expected, response)
        quality_score, invalid_expected_conflict = _quality_score_for_item(
            item.expected,
            response,
            invalid_expected_values,
            adjusted_score=float(valid.adjusted_score),
        )
        # Keep CompactBench's official score as the source of truth for
        # official_score. valid.official_score should match, but this makes
        # the analysis robust to future scorer metadata.
        analyses.append(
            ItemAnalysis(
                item_key=item.key,
                item_type=item.item_type.value,
                check_type=str(item.expected.get("check", "unknown")),
                expected=dict(item.expected),
                prompt=item.prompt,
                response=response,
                official_score=float(official_item.score),
                adjusted_score=float(valid.adjusted_score),
                quality_score=quality_score,
                weight=float(official_item.weight),
                reason=valid.reason,
                valid_false_negative=valid.valid_false_negative,
                semantic_false_positive=valid.semantic_false_positive,
                invalid_expected_conflict=invalid_expected_conflict,
                judge_refusal=is_refusal(response),
            )
        )
    return analyses


def _ground_truth_conflict_values(ground_truth: Any) -> set[str]:
    locked = {normalize_text(value) for value in getattr(ground_truth, "locked_decisions", [])}
    forbidden = {
        normalize_text(value) for value in getattr(ground_truth, "forbidden_behaviors", [])
    }
    return locked & forbidden


def _quality_score_for_item(
    expected: dict[str, Any],
    response: str,
    invalid_expected_values: set[str],
    *,
    adjusted_score: float,
) -> tuple[float | None, bool]:
    invalid_values = _expected_values(expected) & invalid_expected_values
    if not invalid_values:
        return adjusted_score, False

    if expected.get("check") == "set_match":
        raw_values = expected.get("values", [])
        if not isinstance(raw_values, list):
            return adjusted_score, True
        valid_values = [
            value
            for value in raw_values
            if isinstance(value, str) and normalize_text(value) not in invalid_values
        ]
        if not valid_values:
            return None, True
        adjusted_expected = dict(expected)
        adjusted_expected["values"] = valid_values
        return float(evaluate_valid_hit(adjusted_expected, response).adjusted_score), True

    return None, True


def _expected_values(expected: dict[str, Any]) -> set[str]:
    values = set()
    value = expected.get("value")
    if isinstance(value, str):
        values.add(normalize_text(value))
    raw_values = expected.get("values", [])
    if isinstance(raw_values, list):
        values.update(normalize_text(value) for value in raw_values if isinstance(value, str))
    return values


def _expected_value(expected: dict[str, Any]) -> str | None:
    value = expected.get("value")
    return normalize_text(value) if isinstance(value, str) else None


def _weighted_score(items: list[ItemAnalysis], *, attr: str) -> float:
    total_weight = sum(item.weight for item in items)
    if total_weight <= 0:
        return 0.0
    return sum(item.weight * float(getattr(item, attr)) for item in items) / total_weight


def _weighted_score_excluding_invalid(
    items: list[ItemAnalysis], *, attr: str
) -> float | None:
    valid_items = [item for item in items if getattr(item, attr) is not None]
    if not valid_items:
        return None
    total_weight = sum(item.weight for item in valid_items)
    if total_weight <= 0:
        return None
    return (
        sum(item.weight * float(getattr(item, attr)) for item in valid_items)
        / total_weight
    )


def _mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _mean_optional(values: list[float | None]) -> float | None:
    present = [value for value in values if value is not None]
    return _mean(present) if present else None


def _score_delta_optional(left: float | None, right: float) -> float | None:
    return None if left is None else left - right


def _suite_version(templates: list[Any]) -> str:
    versions = {template.version for template in templates}
    return next(iter(versions)) if len(versions) == 1 else "mixed"


def _cycle_to_dict(cycle: CycleAnalysis) -> dict[str, Any]:
    return {
        "cycle_number": cycle.cycle_number,
        "official_score": cycle.official_score,
        "adjusted_score": cycle.adjusted_score,
        "adjusted_score_excluding_invalid": cycle.adjusted_score_excluding_invalid,
        "official_penalized_score": cycle.official_penalized_score,
        "adjusted_penalized_score": cycle.adjusted_penalized_score,
        "adjusted_penalized_score_excluding_invalid": (
            cycle.adjusted_penalized_score_excluding_invalid
        ),
        "contradiction_rate": cycle.contradiction_rate,
        "compression_ratio": cycle.compression_ratio,
        "latency_ms": cycle.latency_ms,
        "artifact": cycle.artifact,
        "artifact_context": cycle.artifact_context,
        "items": [item.__dict__ for item in cycle.items],
    }


def _write_event(fh: Any, event: dict[str, Any]) -> None:
    fh.write(json.dumps(event, ensure_ascii=False) + "\n")
    fh.flush()


def _rescore_analysis(input_path: Path, output_path: Path) -> dict[str, Any]:
    official_case_scores: list[float] = []
    adjusted_case_scores: list[float] = []
    adjusted_case_scores_excluding_invalid: list[float] = []
    total_items = 0
    valid_false_negatives = 0
    semantic_false_positives = 0
    failures_remaining = 0
    failures_remaining_excluding_invalid = 0
    invalid_expected_conflicts = 0
    judge_refusals = 0

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with input_path.open("r", encoding="utf-8") as source, output_path.open(
        "w", encoding="utf-8"
    ) as target:
        for line in source:
            event = json.loads(line)
            if event.get("event") != "case_analysis":
                if event.get("event") == "analysis_end":
                    continue
                _write_event(target, event)
                continue

            rescored = _rescore_case_event(event)
            official_case_scores.append(float(rescored["official_case_score"]))
            adjusted_case_scores.append(float(rescored["adjusted_case_score"]))
            excluding_invalid = rescored.get("adjusted_case_score_excluding_invalid")
            if excluding_invalid is not None:
                adjusted_case_scores_excluding_invalid.append(float(excluding_invalid))
            valid_false_negatives += int(rescored["valid_false_negatives"])
            semantic_false_positives += int(rescored["semantic_false_positives"])
            failures_remaining += int(rescored["failures_remaining"])
            failures_remaining_excluding_invalid += int(
                rescored["failures_remaining_excluding_invalid"]
            )
            invalid_expected_conflicts += int(rescored["invalid_expected_conflicts"])
            judge_refusals += int(rescored["judge_refusals"])
            total_items += sum(
                len(cycle.get("items", [])) for cycle in rescored.get("cycles", [])
            )
            quality_scored_items += int(rescored["benchmark_quality_scored_items"])
            _write_event(target, rescored)

        benchmark_quality_score = _mean_optional(adjusted_case_scores_excluding_invalid)
        summary = {
            "event": "analysis_end",
            "completed_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            "official_overall_score": _mean(official_case_scores),
            "adjusted_overall_score": _mean(adjusted_case_scores),
            "adjusted_overall_score_excluding_invalid": benchmark_quality_score,
            "benchmark_quality_score": benchmark_quality_score,
            "score_delta": _mean(adjusted_case_scores) - _mean(official_case_scores),
            "score_delta_excluding_invalid": _score_delta_optional(
                benchmark_quality_score,
                _mean(official_case_scores),
            ),
            "total_items": total_items,
            "benchmark_quality_scored_items": quality_scored_items,
            "benchmark_quality_unscored_items": total_items - quality_scored_items,
            "benchmark_quality_scored_cases": len(adjusted_case_scores_excluding_invalid),
            "benchmark_quality_unscored_cases": (
                len(official_case_scores) - len(adjusted_case_scores_excluding_invalid)
            ),
            "valid_false_negatives": valid_false_negatives,
            "semantic_false_positives": semantic_false_positives,
            "failures_remaining": failures_remaining,
            "failures_remaining_excluding_invalid": failures_remaining_excluding_invalid,
            "invalid_expected_conflicts": invalid_expected_conflicts,
            "judge_refusals": judge_refusals,
            "notes": [
                "official scores are unmodified CompactBench scores",
                "adjusted scores use response-local valid-hit analysis only",
                "benchmark_quality_score excludes impossible generated checks where the same value is both required and forbidden",
                f"rescored from {input_path}",
            ],
        }
        _write_event(target, summary)
        return summary


def _rescore_case_event(event: dict[str, Any]) -> dict[str, Any]:
    updated = copy.deepcopy(event)
    adjusted_cycle_scores: list[float] = []
    adjusted_cycle_scores_excluding_invalid: list[float] = []
    valid_false_negatives = 0
    semantic_false_positives = 0
    failures_remaining = 0
    failures_remaining_excluding_invalid = 0
    invalid_expected_conflicts = 0
    judge_refusals = 0
    quality_scored_items = 0

    for cycle in updated.get("cycles", []):
        items = cycle.get("items", [])
        invalid_values = _ground_truth_conflict_values_from_event(updated)
        for item in items:
            result = evaluate_valid_hit(item.get("expected", {}), item.get("response", ""))
            item["adjusted_score"] = result.adjusted_score
            item["reason"] = result.reason
            item["valid_false_negative"] = result.valid_false_negative
            item["semantic_false_positive"] = result.semantic_false_positive
            quality_score, invalid_expected_conflict = _quality_score_for_item(
                item.get("expected", {}),
                item.get("response", ""),
                invalid_values,
                adjusted_score=float(result.adjusted_score),
            )
            item["quality_score"] = quality_score
            item["invalid_expected_conflict"] = invalid_expected_conflict
            item["judge_refusal"] = is_refusal(item.get("response", ""))
            valid_false_negatives += 1 if result.valid_false_negative else 0
            semantic_false_positives += 1 if result.semantic_false_positive else 0
            failures_remaining += 1 if result.adjusted_score < 1.0 else 0
            failures_remaining_excluding_invalid += (
                1
                if quality_score is not None and quality_score < 1.0
                else 0
            )
            invalid_expected_conflicts += 1 if item["invalid_expected_conflict"] else 0
            judge_refusals += 1 if item["judge_refusal"] else 0
            quality_scored_items += 1 if quality_score is not None else 0
        adjusted_score = _weighted_score_dicts(items, attr="adjusted_score")
        adjusted_score_excluding_invalid = _weighted_score_dicts_excluding_invalid(
            items, attr="quality_score"
        )
        cycle["adjusted_score"] = adjusted_score
        cycle["adjusted_score_excluding_invalid"] = adjusted_score_excluding_invalid
        cycle["adjusted_penalized_score"] = max(
            0.0,
            min(1.0, adjusted_score * (1.0 - float(cycle.get("contradiction_rate", 0.0)))),
        )
        cycle["adjusted_penalized_score_excluding_invalid"] = (
            None
            if adjusted_score_excluding_invalid is None
            else max(
                0.0,
                min(
                    1.0,
                    adjusted_score_excluding_invalid
                    * (1.0 - float(cycle.get("contradiction_rate", 0.0))),
                ),
            )
        )
        adjusted_cycle_scores.append(float(cycle["adjusted_penalized_score"]))
        if cycle["adjusted_penalized_score_excluding_invalid"] is not None:
            adjusted_cycle_scores_excluding_invalid.append(
                float(cycle["adjusted_penalized_score_excluding_invalid"])
            )

    updated["adjusted_case_score"] = _mean(adjusted_cycle_scores)
    updated["adjusted_case_score_excluding_invalid"] = _mean(
        adjusted_cycle_scores_excluding_invalid
    ) if adjusted_cycle_scores_excluding_invalid else None
    updated["benchmark_quality_case_score"] = updated[
        "adjusted_case_score_excluding_invalid"
    ]
    updated["valid_false_negatives"] = valid_false_negatives
    updated["semantic_false_positives"] = semantic_false_positives
    updated["failures_remaining"] = failures_remaining
    updated["failures_remaining_excluding_invalid"] = failures_remaining_excluding_invalid
    updated["benchmark_quality_scored_items"] = quality_scored_items
    updated["invalid_expected_conflicts"] = invalid_expected_conflicts
    updated["judge_refusals"] = judge_refusals
    return updated


def _ground_truth_conflict_values_from_event(event: dict[str, Any]) -> set[str]:
    ground_truth = event.get("ground_truth", {})
    if not isinstance(ground_truth, dict):
        return set()
    locked = {
        normalize_text(value)
        for value in ground_truth.get("locked_decisions", [])
        if isinstance(value, str)
    }
    forbidden = {
        normalize_text(value)
        for value in ground_truth.get("forbidden_behaviors", [])
        if isinstance(value, str)
    }
    return locked & forbidden


def _weighted_score_dicts(items: list[dict[str, Any]], *, attr: str) -> float:
    total_weight = sum(float(item.get("weight", 0.0)) for item in items)
    if total_weight <= 0:
        return 0.0
    return (
        sum(float(item.get("weight", 0.0)) * float(item.get(attr, 0.0)) for item in items)
        / total_weight
    )


def _weighted_score_dicts_excluding_invalid(
    items: list[dict[str, Any]], *, attr: str
) -> float | None:
    valid_items = [item for item in items if item.get(attr) is not None]
    if not valid_items:
        return None
    return _weighted_score_dicts(valid_items, attr=attr)


if __name__ == "__main__":
    sys.exit(main())
