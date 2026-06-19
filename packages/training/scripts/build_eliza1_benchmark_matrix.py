#!/usr/bin/env python3
"""Build an Eliza-1 benchmark matrix artifact from benchmark result rows.

The shared benchmark ResultsStore records individual
``(model_id, benchmark, score)`` rows. This script lifts those rows into the
training-analysis artifact schema used by ``plugin-training``:

* reference rows, usually ``cerebras/gpt-oss-120b``
* base rows for an Eliza-1 tier
* trained rows for the same tier
* trained-vs-base and trained-vs-reference deltas

It does not run benchmarks itself. It is the bridge from already-recorded
Eliza harness benchmark evidence into the HTML analysis viewer.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Mapping, Sequence

ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parents[1]

BENCHMARK_MATRIX_ARTIFACT_SCHEMA = "eliza_benchmark_matrix_artifact"
BENCHMARK_MATRIX_ARTIFACT_VERSION = 1
DEFAULT_REFERENCE_MODEL_ID = "cerebras/gpt-oss-120b"


@dataclass(frozen=True)
class ModelSpec:
    model_id: str
    variant: str
    tier: str | None = None
    provider: str | None = None


def _load_results_store_class():
    module_name = "_eliza_benchmark_results_store_for_matrix"
    if module_name in sys.modules:
        return sys.modules[module_name].ResultsStore
    rs_path = REPO_ROOT / "packages" / "benchmarks" / "lib" / "results_store.py"
    spec = importlib.util.spec_from_file_location(module_name, rs_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"could not load ResultsStore from {rs_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module.ResultsStore


def _as_record(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _parse_spec_text(value: str) -> ModelSpec:
    parts = value.split(":")
    if len(parts) < 2:
        raise ValueError(
            "model specs must be 'variant:model_id' or "
            "'variant:tier:model_id[:provider]'"
        )
    variant = parts[0].strip()
    if variant not in {"reference", "base", "trained"}:
        raise ValueError(f"unsupported variant {variant!r}")
    if len(parts) == 2:
        return ModelSpec(model_id=parts[1].strip(), variant=variant)
    tier = parts[1].strip() or None
    model_id = parts[2].strip()
    provider = parts[3].strip() if len(parts) >= 4 and parts[3].strip() else None
    if not model_id:
        raise ValueError(f"model spec {value!r} has an empty model id")
    return ModelSpec(model_id=model_id, variant=variant, tier=tier, provider=provider)


def parse_model_specs(values: Sequence[str]) -> list[ModelSpec]:
    specs: list[ModelSpec] = []
    for value in values:
        specs.append(_parse_spec_text(value))
    return specs


def load_model_specs(path: Path) -> list[ModelSpec]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise ValueError(f"{path}: expected a JSON array")
    specs: list[ModelSpec] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ValueError(f"{path}: item {index} must be an object")
        variant = item.get("variant")
        model_id = item.get("model_id") or item.get("modelId")
        if variant not in {"reference", "base", "trained"}:
            raise ValueError(f"{path}: item {index} has invalid variant")
        if not isinstance(model_id, str) or not model_id.strip():
            raise ValueError(f"{path}: item {index} is missing model_id")
        tier = item.get("tier")
        provider = item.get("provider")
        specs.append(
            ModelSpec(
                model_id=model_id.strip(),
                variant=variant,
                tier=tier.strip() if isinstance(tier, str) and tier.strip() else None,
                provider=provider.strip()
                if isinstance(provider, str) and provider.strip()
                else None,
            )
        )
    return specs


def infer_tier(model_id: str, explicit: str | None = None) -> str | None:
    if explicit:
        return explicit
    normalized = model_id.lower()
    if "27b" in normalized:
        return "27b"
    if "9b" in normalized:
        return "9b"
    if "4b" in normalized:
        return "4b"
    if "2b" in normalized:
        return "2b"
    if "0_8b" in normalized or "0.8b" in normalized:
        return "0_8b"
    if "0b" in normalized:
        return "0b"
    return None


def collect_latest_rows(
    *,
    db_path: Path | None,
    specs: Sequence[ModelSpec],
    benchmarks: set[str] | None = None,
) -> list[dict[str, Any]]:
    ResultsStore = _load_results_store_class()
    store = ResultsStore(db_path=db_path)
    rows: list[dict[str, Any]] = []
    try:
        for spec in specs:
            latest = store.get_latest_for_model(model_id=spec.model_id)
            for benchmark, run in sorted(latest.items()):
                if benchmarks is not None and benchmark not in benchmarks:
                    continue
                raw = dict(run.raw())
                rows.append(
                    {
                        "modelId": run.model_id,
                        "benchmark": run.benchmark,
                        "score": run.score,
                        "variant": spec.variant,
                        "tier": infer_tier(run.model_id, spec.tier),
                        "provider": spec.provider,
                        "datasetVersion": run.dataset_version,
                        "codeCommit": run.code_commit,
                        "ts": run.ts,
                        "metrics": _as_record(raw.get("metrics")),
                        "raw": raw,
                    }
                )
    finally:
        store.close()
    return rows


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


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--results-db", help="Path to benchmark ResultsStore DB")
    parser.add_argument(
        "--model-spec",
        action="append",
        default=[],
        help=(
            "Model spec as variant:model_id or variant:tier:model_id[:provider]. "
            "Repeat for reference/base/trained rows."
        ),
    )
    parser.add_argument("--model-specs-json", help="JSON array of model specs")
    parser.add_argument(
        "--benchmark",
        action="append",
        default=[],
        help="Benchmark id to include. Repeatable. Defaults to all latest rows.",
    )
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--generated-at")
    parser.add_argument("--reference-model-id", default=DEFAULT_REFERENCE_MODEL_ID)
    args = parser.parse_args(list(argv) if argv is not None else None)

    specs = parse_model_specs(args.model_spec)
    if args.model_specs_json:
        specs.extend(load_model_specs(Path(args.model_specs_json)))
    if not specs:
        parser.error("provide at least one --model-spec or --model-specs-json")

    db_path = Path(args.results_db).expanduser().resolve() if args.results_db else None
    rows = collect_latest_rows(
        db_path=db_path,
        specs=specs,
        benchmarks=set(args.benchmark) if args.benchmark else None,
    )
    artifact = build_artifact(
        rows=rows,
        generated_at=args.generated_at,
        reference_model_id=args.reference_model_id,
        source={
            "kind": "results_store",
            "resultsDb": str(db_path) if db_path else os.environ.get("ELIZA_BENCHMARK_RESULTS_DB"),
            "modelSpecs": [spec.__dict__ for spec in specs],
        },
    )
    path = write_artifact(artifact, Path(args.output_dir))
    print(json.dumps({"artifactPath": str(path), "counts": artifact["counts"]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
