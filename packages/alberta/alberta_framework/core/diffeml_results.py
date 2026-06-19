"""Result validation helpers for DiffEML paper-quality benchmarks.

The helpers in this module are intentionally small and conservative. They do
not decide whether a result is impressive; they only prevent paper artifacts
from making logic-network claims without the minimum evidence needed to inspect
the claim: hard metrics, gate counts, and baseline provenance.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Literal

Provenance = Literal["paper_reported", "local_reproduced", "pending"]
RunKind = Literal["diffeml", "continuous_diffeml", "difflogic", "logictreenet", "baseline"]

DIFFEML_SCHEMA_VERSION = "diffeml.result.v1"
REQUIRED_DIFFEML_METRICS = (
    "train_soft_accuracy",
    "train_hard_accuracy",
    "test_soft_accuracy",
    "test_hard_accuracy",
    "packed_hard_test_accuracy",
)
OPTIONAL_DIFFEML_METRICS = (
    "packed_int8_head_test_accuracy",
)


@dataclass(frozen=True)
class DatasetInfo:
    """Dataset and split metadata for a benchmark record."""

    name: str
    train_examples: int
    test_examples: int
    seed: int
    split: str
    source: str = ""


@dataclass(frozen=True)
class ModelInfo:
    """Model metadata needed for logic-network comparisons."""

    kind: RunKind
    gate_count: int | None = None
    parameter_count: int | None = None
    gate_mode: str | None = None
    topology: str | None = None
    head: str | None = None
    notes: str = ""


@dataclass(frozen=True)
class TrainingInfo:
    """Training metadata for a benchmark record."""

    optimizer: str
    epochs: int
    batch_size: int
    seed: int
    elapsed_s: float | None = None


@dataclass(frozen=True)
class ExternalBaseline:
    """External baseline row used for paper comparisons."""

    name: str
    model_kind: RunKind
    dataset: str
    metric: str
    value: float | None
    gate_count: int | None
    provenance: Provenance
    source: str
    notes: str = ""


@dataclass(frozen=True)
class DiffEMLResultRecord:
    """Serializable benchmark record with explicit baseline provenance."""

    run_id: str
    dataset: DatasetInfo
    model: ModelInfo
    training: TrainingInfo
    metrics: dict[str, float | None]
    baselines: dict[str, ExternalBaseline] = field(default_factory=dict)
    artifacts: dict[str, str] = field(default_factory=dict)
    schema_version: str = DIFFEML_SCHEMA_VERSION

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-serializable dictionary."""
        return asdict(self)


@dataclass(frozen=True)
class BeatClaim:
    """Result of validating a claimed improvement over a baseline."""

    claim: str
    valid: bool
    diffeml_value: float | None
    baseline_value: float | None
    delta: float | None
    errors: tuple[str, ...]


class DiffEMLResultError(ValueError):
    """Raised when a DiffEML result record is invalid."""


def write_result_record(record: DiffEMLResultRecord, path: Path) -> None:
    """Write a result record as stable, indented JSON."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record.to_dict(), indent=2, sort_keys=True) + "\n", encoding="utf-8")


def load_result_record(path: Path) -> dict[str, Any]:
    """Load a result record JSON file."""
    loaded = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(loaded, dict):
        raise DiffEMLResultError("result JSON must contain an object")
    return loaded


def image_demo_result_record(
    payload: Mapping[str, Any],
    *,
    result_index: int = 0,
    run_id: str | None = None,
    source_artifact: str | Path | None = None,
) -> DiffEMLResultRecord:
    """Convert an image-demo JSON payload into a paper-quality result record.

    The image demo is convenient for experiments, but paper/release artifacts
    need a stable schema with explicit dataset, model, training, metric, and
    baseline fields. This adapter keeps the lossy conversion in one audited
    place and requires packed hard accuracy for discrete DiffEML rows.
    """
    config = _expect_mapping(payload.get("config"), "config")
    results = payload.get("results")
    if not isinstance(results, list) or not results:
        raise DiffEMLResultError("results must be a non-empty list")
    try:
        result = results[result_index]
    except IndexError as exc:
        raise DiffEMLResultError(f"result_index {result_index} is out of range") from exc
    result_map = _expect_mapping(result, f"results[{result_index}]")
    if "error" in result_map:
        raise DiffEMLResultError(f"cannot convert errored result: {result_map['error']}")

    data = _expect_mapping(result_map.get("data"), "result.data")
    model = _expect_mapping(result_map.get("model"), "result.model")
    training = _expect_mapping(result_map.get("training"), "result.training")
    metrics = _expect_mapping(result_map.get("metrics"), "result.metrics")
    dataset_name = _required_str(result_map, "dataset", "result")
    seed = _required_int(config, "seed", "config")
    train_examples = _required_int(data, "train_examples", "result.data")
    test_examples = _required_int(data, "test_examples", "result.data")
    width = _required_int(model, "width", "result.model")
    layers = _required_int(model, "layers", "result.model")
    topology = _required_str(model, "wiring_mode", "result.model")
    feature_mode = str(data.get("feature_mode", config.get("feature_mode", "unknown")))

    record_run_id = run_id or (
        f"diffeml_{dataset_name}_{feature_mode}_{topology}_w{width}_l{layers}_seed{seed}"
    )
    required_metrics: dict[str, float | None] = {
        metric: _required_float(metrics, metric, "result.metrics")
        for metric in REQUIRED_DIFFEML_METRICS
    }
    for metric in OPTIONAL_DIFFEML_METRICS:
        value = _number_or_none(metrics.get(metric))
        if value is not None:
            required_metrics[metric] = value
    active_params = _optional_int(model.get("active_node_parameters"))
    head_params = _optional_int(model.get("head_parameters"))
    parameter_count = (
        None
        if active_params is None and head_params is None
        else (active_params or 0) + (head_params or 0)
    )
    baselines = _image_demo_baselines(
        result_map.get("baselines", {}),
        dataset=dataset_name,
    )
    artifacts = {} if source_artifact is None else {"source": str(source_artifact)}
    return DiffEMLResultRecord(
        run_id=record_run_id,
        dataset=DatasetInfo(
            name=dataset_name,
            train_examples=train_examples,
            test_examples=test_examples,
            seed=seed,
            split=f"{train_examples} train / {test_examples} test",
            source=str(data.get("source", "")),
        ),
        model=ModelInfo(
            kind="diffeml",
            gate_count=_required_int(model, "nodes", "result.model"),
            parameter_count=parameter_count,
            gate_mode=str(model.get("gate_mode", "")) or None,
            topology=topology,
            head=str(model.get("head_mode", "")) or None,
        ),
        training=TrainingInfo(
            optimizer="adam",
            epochs=_required_int(training, "epochs", "result.training"),
            batch_size=_required_int(training, "batch_size", "result.training"),
            seed=seed,
            elapsed_s=_optional_float(training.get("elapsed_s")),
        ),
        metrics=required_metrics,
        baselines=baselines,
        artifacts=artifacts,
    )


def validate_result_record(record: Mapping[str, Any]) -> tuple[str, ...]:
    """Return validation errors for a paper-quality DiffEML result record."""
    errors: list[str] = []
    if record.get("schema_version") != DIFFEML_SCHEMA_VERSION:
        errors.append(f"schema_version must be {DIFFEML_SCHEMA_VERSION!r}")
    if not isinstance(record.get("run_id"), str) or not record.get("run_id"):
        errors.append("run_id is required")

    dataset = _mapping_value(record, "dataset", errors)
    _require_str(dataset, "name", "dataset", errors)
    _require_positive_int(dataset, "train_examples", "dataset", errors)
    _require_positive_int(dataset, "test_examples", "dataset", errors)
    _require_int(dataset, "seed", "dataset", errors)

    model = _mapping_value(record, "model", errors)
    model_kind = model.get("kind") if isinstance(model, Mapping) else None
    if model_kind not in {"diffeml", "continuous_diffeml", "difflogic", "logictreenet", "baseline"}:
        errors.append("model.kind must be a known benchmark kind")
    if model_kind in {"diffeml", "difflogic", "logictreenet"}:
        _require_positive_int(model, "gate_count", "model", errors)

    training = _mapping_value(record, "training", errors)
    _require_str(training, "optimizer", "training", errors)
    _require_positive_int(training, "epochs", "training", errors)
    _require_positive_int(training, "batch_size", "training", errors)

    metrics = _mapping_value(record, "metrics", errors)
    if model_kind == "diffeml":
        for metric in REQUIRED_DIFFEML_METRICS:
            _require_number(metrics, metric, "metrics", errors)
    if model_kind == "continuous_diffeml":
        has_accuracy = any(metric in metrics for metric in ("test_accuracy", "test_soft_accuracy"))
        has_loss = any(metric in metrics for metric in ("test_loss", "test_mse"))
        if not has_accuracy and not has_loss:
            errors.append(
                "continuous_diffeml metrics must include test_accuracy/test_soft_accuracy "
                "or test_loss/test_mse"
            )

    baselines = record.get("baselines", {})
    if not isinstance(baselines, Mapping):
        errors.append("baselines must be an object")
    else:
        for name, baseline in baselines.items():
            if not isinstance(name, str):
                errors.append("baseline names must be strings")
            if not isinstance(baseline, Mapping):
                errors.append(f"baseline {name!r} must be an object")
                continue
            _validate_baseline(name, baseline, errors)

    return tuple(errors)


def assert_valid_result_record(record: Mapping[str, Any]) -> None:
    """Raise if a result record is not paper-quality."""
    errors = validate_result_record(record)
    if errors:
        raise DiffEMLResultError("; ".join(errors))


def validate_beat_claim(
    record: Mapping[str, Any],
    baseline_name: str,
    *,
    metric: str = "packed_hard_test_accuracy",
    require_local_baseline: bool = False,
) -> BeatClaim:
    """Validate a claim that DiffEML beats a named external baseline.

    Args:
        record: Result record dictionary.
        baseline_name: Key inside ``record["baselines"]``.
        metric: DiffEML metric to compare.
        require_local_baseline: If true, paper-reported baselines are not enough
            for a valid claim.

    Returns:
        A :class:`BeatClaim` with all errors instead of raising.
    """
    errors = list(validate_result_record(record))
    metrics = record.get("metrics", {})
    baselines = record.get("baselines", {})
    diffeml_value = _number_or_none(metrics.get(metric)) if isinstance(metrics, Mapping) else None
    baseline_value: float | None = None

    if diffeml_value is None:
        errors.append(f"metric {metric!r} is required for beat claim")
    if not isinstance(baselines, Mapping) or baseline_name not in baselines:
        errors.append(f"baseline {baseline_name!r} is required for beat claim")
    else:
        baseline = baselines[baseline_name]
        if not isinstance(baseline, Mapping):
            errors.append(f"baseline {baseline_name!r} must be an object")
        else:
            baseline_metric = baseline.get("metric")
            if baseline_metric != metric:
                errors.append(
                    f"baseline {baseline_name!r} metric must match claim metric {metric!r}"
                )
            baseline_value = _number_or_none(baseline.get("value"))
            if baseline_value is None:
                errors.append(f"baseline {baseline_name!r} value is required")
            provenance = baseline.get("provenance")
            if provenance == "pending":
                errors.append(f"baseline {baseline_name!r} is still pending")
            if require_local_baseline and provenance != "local_reproduced":
                errors.append(f"baseline {baseline_name!r} must be locally reproduced")

    delta = (
        None
        if diffeml_value is None or baseline_value is None
        else diffeml_value - baseline_value
    )
    if delta is not None and delta <= 0.0:
        errors.append(f"DiffEML does not beat {baseline_name}: delta={delta:.6g}")

    return BeatClaim(
        claim=f"DiffEML {metric} > {baseline_name}",
        valid=not errors,
        diffeml_value=diffeml_value,
        baseline_value=baseline_value,
        delta=delta,
        errors=tuple(errors),
    )


def _mapping_value(
    record: Mapping[str, Any],
    key: str,
    errors: list[str],
) -> Mapping[str, Any]:
    value = record.get(key)
    if isinstance(value, Mapping):
        return value
    errors.append(f"{key} must be an object")
    return {}


def _expect_mapping(value: Any, name: str) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return value
    raise DiffEMLResultError(f"{name} must be an object")


def _required_str(record: Mapping[str, Any], key: str, prefix: str) -> str:
    value = record.get(key)
    if not isinstance(value, str) or not value:
        raise DiffEMLResultError(f"{prefix}.{key} is required")
    return value


def _required_int(record: Mapping[str, Any], key: str, prefix: str) -> int:
    value = record.get(key)
    if not isinstance(value, int):
        raise DiffEMLResultError(f"{prefix}.{key} must be an integer")
    return value


def _required_float(record: Mapping[str, Any], key: str, prefix: str) -> float:
    value = _number_or_none(record.get(key))
    if value is None:
        raise DiffEMLResultError(f"{prefix}.{key} must be a number")
    return value


def _optional_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    return None


def _optional_float(value: Any) -> float | None:
    return _number_or_none(value)


def _image_demo_baselines(
    baselines: Any,
    *,
    dataset: str,
) -> dict[str, ExternalBaseline]:
    if not isinstance(baselines, Mapping):
        return {}
    converted: dict[str, ExternalBaseline] = {}
    mlp = baselines.get("mlp_same_features")
    if isinstance(mlp, Mapping):
        converted["mlp_same_features"] = ExternalBaseline(
            name="same-feature MLP",
            model_kind="baseline",
            dataset=dataset,
            metric="test_accuracy",
            value=_number_or_none(mlp.get("test_accuracy")),
            gate_count=None,
            provenance="local_reproduced",
            source="image_demo.baselines.mlp_same_features",
            notes=f"hidden_sizes={mlp.get('hidden_sizes', 'unknown')}",
        )
    return converted


def _require_str(
    record: Mapping[str, Any],
    key: str,
    prefix: str,
    errors: list[str],
) -> None:
    if not isinstance(record.get(key), str) or not record.get(key):
        errors.append(f"{prefix}.{key} is required")


def _require_int(
    record: Mapping[str, Any],
    key: str,
    prefix: str,
    errors: list[str],
) -> None:
    value = record.get(key)
    if not isinstance(value, int):
        errors.append(f"{prefix}.{key} must be an integer")


def _require_positive_int(
    record: Mapping[str, Any],
    key: str,
    prefix: str,
    errors: list[str],
) -> None:
    value = record.get(key)
    if not isinstance(value, int) or value <= 0:
        errors.append(f"{prefix}.{key} must be a positive integer")


def _require_number(
    record: Mapping[str, Any],
    key: str,
    prefix: str,
    errors: list[str],
) -> None:
    if _number_or_none(record.get(key)) is None:
        errors.append(f"{prefix}.{key} must be a number")


def _number_or_none(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return float(value)
    return None


def _validate_baseline(name: str, baseline: Mapping[str, Any], errors: list[str]) -> None:
    _require_str(baseline, "name", f"baselines.{name}", errors)
    if baseline.get("model_kind") not in {
        "diffeml",
        "continuous_diffeml",
        "difflogic",
        "logictreenet",
        "baseline",
    }:
        errors.append(f"baselines.{name}.model_kind must be a known benchmark kind")
    _require_str(baseline, "dataset", f"baselines.{name}", errors)
    _require_str(baseline, "metric", f"baselines.{name}", errors)
    provenance = baseline.get("provenance")
    if provenance not in {"paper_reported", "local_reproduced", "pending"}:
        errors.append(f"baselines.{name}.provenance must be valid")
    if provenance != "pending":
        _require_number(baseline, "value", f"baselines.{name}", errors)
    if baseline.get("model_kind") in {"difflogic", "logictreenet"}:
        _require_positive_int(baseline, "gate_count", f"baselines.{name}", errors)
    _require_str(baseline, "source", f"baselines.{name}", errors)
