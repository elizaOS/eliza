#!/usr/bin/env python3
"""Build an Eliza-1 benchmark matrix artifact from benchmark result rows.

Callers pass already-collected ``(model_id, benchmark, score)`` rows — today
`benchmark_vs_cerebras.write_matrix_artifact` is the producer — and this module
lifts them into the canonical training-analysis artifact schema:

* reference rows, usually ``cerebras/gpt-oss-120b``
* base rows for an Eliza-1 tier
* trained rows for the same tier
* trained-vs-base and trained-vs-reference deltas

It does not run benchmarks itself. It is the bridge from already-recorded
Eliza harness benchmark evidence into the HTML analysis viewer.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Mapping, Sequence

BENCHMARK_MATRIX_ARTIFACT_SCHEMA = "eliza_benchmark_matrix_artifact"
BENCHMARK_MATRIX_ARTIFACT_VERSION = 1
DEFAULT_REFERENCE_MODEL_ID = "cerebras/gpt-oss-120b"


def _as_record(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _round(value: float | None) -> float | None:
    return round(value, 6) if value is not None else None


def _percent_delta(base: float | None, value: float | None) -> float | None:
    if base is None or value is None or base == 0:
        return None
    return ((value - base) / abs(base)) * 100.0


def _select_reference_model_id(
    rows: Sequence[Mapping[str, Any]],
    explicit: str | None,
) -> str | None:
    if explicit:
        return explicit
    for row in rows:
        if row.get("variant") == "reference":
            return str(row.get("modelId"))
    return None


def _score_for(
    rows: Sequence[Mapping[str, Any]],
    *,
    tier: str,
    benchmark: str,
    variant: str,
) -> Mapping[str, Any] | None:
    for row in rows:
        if row.get("benchmark") != benchmark:
            continue
        if row.get("variant") != variant:
            continue
        if variant == "reference" or row.get("tier") == tier:
            return row
    return None


def _is_dry_run_row(row: Mapping[str, Any] | None) -> bool:
    if row is None:
        return False
    metrics = _as_record(row.get("metrics"))
    raw = _as_record(row.get("raw"))
    raw_source = _as_record(raw.get("source"))
    return (
        row.get("dryRun") is True
        or row.get("dry_run") is True
        or metrics.get("dryRun") is True
        or metrics.get("dry_run") is True
        or raw.get("dryRun") is True
        or raw.get("dry_run") is True
        or raw_source.get("dryRun") is True
        or raw_source.get("dry_run") is True
    )


def build_artifact(
    *,
    rows: Sequence[Mapping[str, Any]],
    generated_at: str | None = None,
    reference_model_id: str | None = None,
    source: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    normalized_rows = [dict(row) for row in rows]
    reference = _select_reference_model_id(normalized_rows, reference_model_id)
    tiers = sorted(
        {
            str(row["tier"])
            for row in normalized_rows
            if row.get("tier")
        }
    )
    benchmarks = sorted({str(row["benchmark"]) for row in normalized_rows})
    comparisons: list[dict[str, Any]] = []
    for tier in tiers:
        for benchmark in benchmarks:
            base = _score_for(
                normalized_rows, tier=tier, benchmark=benchmark, variant="base"
            )
            trained = _score_for(
                normalized_rows, tier=tier, benchmark=benchmark, variant="trained"
            )
            ref = _score_for(
                normalized_rows, tier=tier, benchmark=benchmark, variant="reference"
            )
            if base is None and trained is None and ref is None:
                continue
            base_score = float(base["score"]) if base is not None else None
            trained_score = (
                float(trained["score"]) if trained is not None else None
            )
            ref_score = float(ref["score"]) if ref is not None else None
            comparisons.append(
                {
                    "tier": tier,
                    "benchmark": benchmark,
                    "baseModelId": base.get("modelId") if base else None,
                    "trainedModelId": trained.get("modelId") if trained else None,
                    "referenceModelId": ref.get("modelId") if ref else reference,
                    "baseScore": base_score,
                    "trainedScore": trained_score,
                    "referenceScore": ref_score,
                    "improvementAbsolute": _round(
                        trained_score - base_score
                        if trained_score is not None and base_score is not None
                        else None
                    ),
                    "improvementPercent": _round(
                        _percent_delta(base_score, trained_score)
                    ),
                    "trainedVsReferenceAbsolute": _round(
                        trained_score - ref_score
                        if trained_score is not None and ref_score is not None
                        else None
                    ),
                    "trainedVsReferencePercent": _round(
                        _percent_delta(ref_score, trained_score)
                    ),
                    "dryRun": _is_dry_run_row(base)
                    or _is_dry_run_row(trained)
                    or _is_dry_run_row(ref),
                }
            )
    return {
        "schema": BENCHMARK_MATRIX_ARTIFACT_SCHEMA,
        "version": BENCHMARK_MATRIX_ARTIFACT_VERSION,
        "generatedAt": generated_at or datetime.now(UTC).isoformat(),
        "source": dict(source or {"kind": "results_store"}),
        "referenceModelId": reference,
        "tiers": tiers,
        "benchmarks": benchmarks,
        "counts": {
            "rows": len(normalized_rows),
            "comparisons": len(comparisons),
            "tiers": len(tiers),
            "benchmarks": len(benchmarks),
        },
        "rows": normalized_rows,
        "comparisons": comparisons,
    }


def write_artifact(artifact: Mapping[str, Any], output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / "benchmark-matrix.json"
    path.write_text(json.dumps(artifact, indent=2) + "\n", encoding="utf-8")
    return path
