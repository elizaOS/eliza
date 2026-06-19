"""Canonical metrics schema for LifeOpsBench (Python mirror).

Mirrors ``packages/benchmarks/lib/src/metrics-schema.ts`` field-for-field.

Design rules (per AGENTS.md):
  - DTO fields are required by default. Optional only where genuinely nullable.
  - ``cache_supported`` is a hard boolean — never inferred from missing data.
  - Cache read / creation / hit-pct fields are ``Optional[...]`` (None means
    "not reported by provider"); they never silently default to zero, so the
    aggregator can distinguish "provider does not support cache" from
    "provider supports cache and this call had zero hits".

Round-trip rules:
  - ``to_dict`` emits camelCase keys (matching the TS schema and the JSON
    artifact format).
  - ``from_dict`` accepts camelCase. snake_case input is rejected; the
    aggregator + harnesses must emit the canonical wire shape.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, ClassVar, Literal, Optional

# ---------------------------------------------------------------------------
# Enum atoms — kept as ``Literal`` so dataclass equality + JSON round-trip
# stay simple. Validation happens in ``from_dict``.
# ---------------------------------------------------------------------------

Harness = Literal["hermes", "openclaw", "eliza"]
HARNESSES: tuple[Harness, ...] = ("hermes", "openclaw", "eliza")

ModelTier = Literal["small", "mid", "large", "frontier"]
MODEL_TIERS: tuple[ModelTier, ...] = ("small", "mid", "large", "frontier")

StageKind = Literal[
    "plannerTurn",
    "toolCall",
    "toolSearch",
    "evaluation",
    "subPlanner",
    "compaction",
    "factsAndRelationships",
]
STAGE_KINDS: tuple[StageKind, ...] = (
    "plannerTurn",
    "toolCall",
    "toolSearch",
    "evaluation",
    "subPlanner",
    "compaction",
    "factsAndRelationships",
)

REPORT_SCHEMA_VERSION = "lifeops-bench-v1"
DELTA_SCHEMA_VERSION = "lifeops-bench-delta-v1"


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def _require(d: dict[str, Any], key: str) -> Any:
    if key not in d:
        raise KeyError(f"metrics schema: missing required key '{key}'")
    return d[key]


def _optional(d: dict[str, Any], key: str) -> Any:
    return d.get(key)


def _check_enum(value: str, allowed: tuple[str, ...], label: str) -> str:
    if value not in allowed:
        raise ValueError(
            f"metrics schema: {label} = {value!r} not in {allowed!r}"
        )
    return value


# ---------------------------------------------------------------------------
# ToolCallMetrics
# ---------------------------------------------------------------------------


@dataclass
class ToolCallMetrics:
    name: str
    success: bool
    duration_ms: float
    error: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "name": self.name,
            "success": self.success,
            "durationMs": self.duration_ms,
        }
        if self.error is not None:
            out["error"] = self.error
        return out

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "ToolCallMetrics":
        return cls(
            name=_require(d, "name"),
            success=_require(d, "success"),
            duration_ms=_require(d, "durationMs"),
            error=_optional(d, "error"),
        )


# ---------------------------------------------------------------------------
# TurnMetrics
# ---------------------------------------------------------------------------


@dataclass
class TurnMetrics:
    turn_idx: int
    started_at: float
    ended_at: float
    latency_ms: float
    provider: str
    model_name: str
    input_tokens: int
    output_tokens: int
    total_tokens: int
    cache_read_input_tokens: Optional[int]
    cache_creation_input_tokens: Optional[int]
    cache_hit_pct: Optional[float]
    cache_supported: bool
    cost_usd: float
    tool_calls: list[ToolCallMetrics] = field(default_factory=list)
    model_tier: Optional[ModelTier] = None
    tool_search_top_k: Optional[int] = None
    prompt_cache_key: Optional[str] = None
    prefix_hash: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "turnIdx": self.turn_idx,
            "startedAt": self.started_at,
            "endedAt": self.ended_at,
            "latencyMs": self.latency_ms,
            "provider": self.provider,
            "modelName": self.model_name,
            "inputTokens": self.input_tokens,
            "outputTokens": self.output_tokens,
            "totalTokens": self.total_tokens,
            "cacheReadInputTokens": self.cache_read_input_tokens,
            "cacheCreationInputTokens": self.cache_creation_input_tokens,
            "cacheHitPct": self.cache_hit_pct,
            "cacheSupported": self.cache_supported,
            "costUsd": self.cost_usd,
            "toolCalls": [tc.to_dict() for tc in self.tool_calls],
        }
        if self.model_tier is not None:
            out["modelTier"] = self.model_tier
        if self.tool_search_top_k is not None:
            out["toolSearchTopK"] = self.tool_search_top_k
        if self.prompt_cache_key is not None:
            out["promptCacheKey"] = self.prompt_cache_key
        if self.prefix_hash is not None:
            out["prefixHash"] = self.prefix_hash
        return out

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "TurnMetrics":
        tier = _optional(d, "modelTier")
        if tier is not None:
            _check_enum(tier, MODEL_TIERS, "TurnMetrics.modelTier")
        return cls(
            turn_idx=_require(d, "turnIdx"),
            started_at=_require(d, "startedAt"),
            ended_at=_require(d, "endedAt"),
            latency_ms=_require(d, "latencyMs"),
            provider=_require(d, "provider"),
            model_name=_require(d, "modelName"),
            model_tier=tier,
            input_tokens=_require(d, "inputTokens"),
            output_tokens=_require(d, "outputTokens"),
            total_tokens=_require(d, "totalTokens"),
            cache_read_input_tokens=_require(d, "cacheReadInputTokens"),
            cache_creation_input_tokens=_require(d, "cacheCreationInputTokens"),
            cache_hit_pct=_require(d, "cacheHitPct"),
            cache_supported=_require(d, "cacheSupported"),
            cost_usd=_require(d, "costUsd"),
            tool_calls=[ToolCallMetrics.from_dict(tc) for tc in _require(d, "toolCalls")],
            tool_search_top_k=_optional(d, "toolSearchTopK"),
            prompt_cache_key=_optional(d, "promptCacheKey"),
            prefix_hash=_optional(d, "prefixHash"),
        )


# ---------------------------------------------------------------------------
# StageMetrics
# ---------------------------------------------------------------------------


@dataclass
class StageMetrics:
    stage_id: str
    kind: StageKind
    started_at: float
    ended_at: float
    latency_ms: float
    cache_read_input_tokens: Optional[int]
    cache_creation_input_tokens: Optional[int]
    cache_hit_pct: Optional[float]
    cache_supported: bool
    iteration: Optional[int] = None
    provider: Optional[str] = None
    model_name: Optional[str] = None
    model_tier: Optional[ModelTier] = None
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None
    cost_usd: Optional[float] = None
    tool_name: Optional[str] = None
    tool_success: Optional[bool] = None
    tool_error: Optional[str] = None
    prefix_hash: Optional[str] = None
    prompt_cache_key: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "stageId": self.stage_id,
            "kind": self.kind,
            "startedAt": self.started_at,
            "endedAt": self.ended_at,
            "latencyMs": self.latency_ms,
            "cacheReadInputTokens": self.cache_read_input_tokens,
            "cacheCreationInputTokens": self.cache_creation_input_tokens,
            "cacheHitPct": self.cache_hit_pct,
            "cacheSupported": self.cache_supported,
        }
        for src_key, dest_key in (
            ("iteration", "iteration"),
            ("provider", "provider"),
            ("model_name", "modelName"),
            ("model_tier", "modelTier"),
            ("input_tokens", "inputTokens"),
            ("output_tokens", "outputTokens"),
            ("cost_usd", "costUsd"),
            ("tool_name", "toolName"),
            ("tool_success", "toolSuccess"),
            ("tool_error", "toolError"),
            ("prefix_hash", "prefixHash"),
            ("prompt_cache_key", "promptCacheKey"),
        ):
            val = getattr(self, src_key)
            if val is not None:
                out[dest_key] = val
        return out

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "StageMetrics":
        kind = _require(d, "kind")
        _check_enum(kind, STAGE_KINDS, "StageMetrics.kind")
        tier = _optional(d, "modelTier")
        if tier is not None:
            _check_enum(tier, MODEL_TIERS, "StageMetrics.modelTier")
        return cls(
            stage_id=_require(d, "stageId"),
            kind=kind,
            iteration=_optional(d, "iteration"),
            started_at=_require(d, "startedAt"),
            ended_at=_require(d, "endedAt"),
            latency_ms=_require(d, "latencyMs"),
            provider=_optional(d, "provider"),
            model_name=_optional(d, "modelName"),
            model_tier=tier,
            input_tokens=_optional(d, "inputTokens"),
            output_tokens=_optional(d, "outputTokens"),
            cache_read_input_tokens=_require(d, "cacheReadInputTokens"),
            cache_creation_input_tokens=_require(d, "cacheCreationInputTokens"),
            cache_hit_pct=_require(d, "cacheHitPct"),
            cache_supported=_require(d, "cacheSupported"),
            cost_usd=_optional(d, "costUsd"),
            tool_name=_optional(d, "toolName"),
            tool_success=_optional(d, "toolSuccess"),
            tool_error=_optional(d, "toolError"),
            prefix_hash=_optional(d, "prefixHash"),
            prompt_cache_key=_optional(d, "promptCacheKey"),
        )


# ---------------------------------------------------------------------------
# RunMetrics
# ---------------------------------------------------------------------------


@dataclass
class RunMetrics:
    run_id: str
    scenario_id: str
    harness: Harness
    provider: str
    model_name: str
    model_tier: ModelTier
    pre_release: bool
    pass_at_1: bool
    started_at: float
    ended_at: float
    time_to_complete_ms: float
    turns: list[TurnMetrics]
    total_input_tokens: int
    total_output_tokens: int
    total_cache_read_tokens: Optional[int]
    total_cache_creation_tokens: Optional[int]
    aggregate_cache_hit_pct: Optional[float]
    total_cost_usd: float
    tool_call_count: int
    tool_failure_count: int
    pass_at_k: Optional[bool] = None
    state_hash_match: Optional[bool] = None
    stages: Optional[list[StageMetrics]] = None
    planner_iterations: Optional[int] = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "runId": self.run_id,
            "scenarioId": self.scenario_id,
            "harness": self.harness,
            "provider": self.provider,
            "modelName": self.model_name,
            "modelTier": self.model_tier,
            "preRelease": self.pre_release,
            "passAt1": self.pass_at_1,
            "startedAt": self.started_at,
            "endedAt": self.ended_at,
            "timeToCompleteMs": self.time_to_complete_ms,
            "turns": [t.to_dict() for t in self.turns],
            "totalInputTokens": self.total_input_tokens,
            "totalOutputTokens": self.total_output_tokens,
            "totalCacheReadTokens": self.total_cache_read_tokens,
            "totalCacheCreationTokens": self.total_cache_creation_tokens,
            "aggregateCacheHitPct": self.aggregate_cache_hit_pct,
            "totalCostUsd": self.total_cost_usd,
            "toolCallCount": self.tool_call_count,
            "toolFailureCount": self.tool_failure_count,
        }
        if self.pass_at_k is not None:
            out["passAtK"] = self.pass_at_k
        if self.state_hash_match is not None:
            out["stateHashMatch"] = self.state_hash_match
        if self.stages is not None:
            out["stages"] = [s.to_dict() for s in self.stages]
        if self.planner_iterations is not None:
            out["plannerIterations"] = self.planner_iterations
        return out

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "RunMetrics":
        harness = _require(d, "harness")
        _check_enum(harness, HARNESSES, "RunMetrics.harness")
        tier = _require(d, "modelTier")
        _check_enum(tier, MODEL_TIERS, "RunMetrics.modelTier")
        stages_raw = _optional(d, "stages")
        return cls(
            run_id=_require(d, "runId"),
            scenario_id=_require(d, "scenarioId"),
            harness=harness,
            provider=_require(d, "provider"),
            model_name=_require(d, "modelName"),
            model_tier=tier,
            pre_release=_require(d, "preRelease"),
            pass_at_1=_require(d, "passAt1"),
            pass_at_k=_optional(d, "passAtK"),
            state_hash_match=_optional(d, "stateHashMatch"),
            started_at=_require(d, "startedAt"),
            ended_at=_require(d, "endedAt"),
            time_to_complete_ms=_require(d, "timeToCompleteMs"),
            turns=[TurnMetrics.from_dict(t) for t in _require(d, "turns")],
            stages=(
                [StageMetrics.from_dict(s) for s in stages_raw]
                if stages_raw is not None
                else None
            ),
            total_input_tokens=_require(d, "totalInputTokens"),
            total_output_tokens=_require(d, "totalOutputTokens"),
            total_cache_read_tokens=_require(d, "totalCacheReadTokens"),
            total_cache_creation_tokens=_require(d, "totalCacheCreationTokens"),
            aggregate_cache_hit_pct=_require(d, "aggregateCacheHitPct"),
            total_cost_usd=_require(d, "totalCostUsd"),
            planner_iterations=_optional(d, "plannerIterations"),
            tool_call_count=_require(d, "toolCallCount"),
            tool_failure_count=_require(d, "toolFailureCount"),
        )


# ---------------------------------------------------------------------------
# Report — top-level artifact written as ``report.json``
# ---------------------------------------------------------------------------


@dataclass
class ReportRollup:
    scenario_count: int
    pass_count: int
    pass_rate: float
    total_input_tokens: int
    total_output_tokens: int
    total_cache_read_tokens: Optional[int]
    aggregate_cache_hit_pct: Optional[float]
    total_cost_usd: float
    total_time_ms: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "scenarioCount": self.scenario_count,
            "passCount": self.pass_count,
            "passRate": self.pass_rate,
            "totalInputTokens": self.total_input_tokens,
            "totalOutputTokens": self.total_output_tokens,
            "totalCacheReadTokens": self.total_cache_read_tokens,
            "aggregateCacheHitPct": self.aggregate_cache_hit_pct,
            "totalCostUsd": self.total_cost_usd,
            "totalTimeMs": self.total_time_ms,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "ReportRollup":
        return cls(
            scenario_count=_require(d, "scenarioCount"),
            pass_count=_require(d, "passCount"),
            pass_rate=_require(d, "passRate"),
            total_input_tokens=_require(d, "totalInputTokens"),
            total_output_tokens=_require(d, "totalOutputTokens"),
            total_cache_read_tokens=_require(d, "totalCacheReadTokens"),
            aggregate_cache_hit_pct=_require(d, "aggregateCacheHitPct"),
            total_cost_usd=_require(d, "totalCostUsd"),
            total_time_ms=_require(d, "totalTimeMs"),
        )


@dataclass
class Report:
    SCHEMA_VERSION: ClassVar[str] = REPORT_SCHEMA_VERSION

    generated_at: str
    run_id: str
    harness: Harness
    provider: str
    model_name: str
    model_tier: ModelTier
    pre_release: bool
    scenarios: list[RunMetrics]
    rollup: ReportRollup
    notes: Optional[list[str]] = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "schemaVersion": REPORT_SCHEMA_VERSION,
            "generatedAt": self.generated_at,
            "runId": self.run_id,
            "harness": self.harness,
            "provider": self.provider,
            "modelName": self.model_name,
            "modelTier": self.model_tier,
            "preRelease": self.pre_release,
            "scenarios": [s.to_dict() for s in self.scenarios],
            "rollup": self.rollup.to_dict(),
        }
        if self.notes is not None:
            out["notes"] = list(self.notes)
        return out

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Report":
        version = _require(d, "schemaVersion")
        if version != REPORT_SCHEMA_VERSION:
            raise ValueError(
                f"Report: schemaVersion = {version!r}, expected {REPORT_SCHEMA_VERSION!r}"
            )
        harness = _require(d, "harness")
        _check_enum(harness, HARNESSES, "Report.harness")
        tier = _require(d, "modelTier")
        _check_enum(tier, MODEL_TIERS, "Report.modelTier")
        return cls(
            generated_at=_require(d, "generatedAt"),
            run_id=_require(d, "runId"),
            harness=harness,
            provider=_require(d, "provider"),
            model_name=_require(d, "modelName"),
            model_tier=tier,
            pre_release=_require(d, "preRelease"),
            scenarios=[RunMetrics.from_dict(s) for s in _require(d, "scenarios")],
            rollup=ReportRollup.from_dict(_require(d, "rollup")),
            notes=_optional(d, "notes"),
        )


# ---------------------------------------------------------------------------
# Delta — A/B comparison artifact written as ``delta.json``
# ---------------------------------------------------------------------------


@dataclass
class DeltaSidecar:
    run_id: str
    label: str

    def to_dict(self) -> dict[str, Any]:
        return {"runId": self.run_id, "label": self.label}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "DeltaSidecar":
        return cls(run_id=_require(d, "runId"), label=_require(d, "label"))


@dataclass
class DeltaScenario:
    scenario_id: str
    pass_baseline: bool
    pass_candidate: bool
    delta_cost_usd: float
    delta_latency_ms: float
    delta_total_tokens: float
    delta_cache_hit_pct: Optional[float]

    def to_dict(self) -> dict[str, Any]:
        return {
            "scenarioId": self.scenario_id,
            "passBaseline": self.pass_baseline,
            "passCandidate": self.pass_candidate,
            "deltaCostUsd": self.delta_cost_usd,
            "deltaLatencyMs": self.delta_latency_ms,
            "deltaTotalTokens": self.delta_total_tokens,
            "deltaCacheHitPct": self.delta_cache_hit_pct,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "DeltaScenario":
        return cls(
            scenario_id=_require(d, "scenarioId"),
            pass_baseline=_require(d, "passBaseline"),
            pass_candidate=_require(d, "passCandidate"),
            delta_cost_usd=_require(d, "deltaCostUsd"),
            delta_latency_ms=_require(d, "deltaLatencyMs"),
            delta_total_tokens=_require(d, "deltaTotalTokens"),
            delta_cache_hit_pct=_require(d, "deltaCacheHitPct"),
        )


@dataclass
class DeltaRollup:
    delta_pass_rate: float
    delta_cost_usd: float
    delta_total_tokens: float
    delta_cache_hit_pct: Optional[float]
    delta_time_ms: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "deltaPassRate": self.delta_pass_rate,
            "deltaCostUsd": self.delta_cost_usd,
            "deltaTotalTokens": self.delta_total_tokens,
            "deltaCacheHitPct": self.delta_cache_hit_pct,
            "deltaTimeMs": self.delta_time_ms,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "DeltaRollup":
        return cls(
            delta_pass_rate=_require(d, "deltaPassRate"),
            delta_cost_usd=_require(d, "deltaCostUsd"),
            delta_total_tokens=_require(d, "deltaTotalTokens"),
            delta_cache_hit_pct=_require(d, "deltaCacheHitPct"),
            delta_time_ms=_require(d, "deltaTimeMs"),
        )


@dataclass
class Delta:
    SCHEMA_VERSION: ClassVar[str] = DELTA_SCHEMA_VERSION

    generated_at: str
    baseline: DeltaSidecar
    candidate: DeltaSidecar
    per_scenario: list[DeltaScenario]
    rollup: DeltaRollup

    def to_dict(self) -> dict[str, Any]:
        return {
            "schemaVersion": DELTA_SCHEMA_VERSION,
            "generatedAt": self.generated_at,
            "baseline": self.baseline.to_dict(),
            "candidate": self.candidate.to_dict(),
            "perScenario": [s.to_dict() for s in self.per_scenario],
            "rollup": self.rollup.to_dict(),
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Delta":
        version = _require(d, "schemaVersion")
        if version != DELTA_SCHEMA_VERSION:
            raise ValueError(
                f"Delta: schemaVersion = {version!r}, expected {DELTA_SCHEMA_VERSION!r}"
            )
        return cls(
            generated_at=_require(d, "generatedAt"),
            baseline=DeltaSidecar.from_dict(_require(d, "baseline")),
            candidate=DeltaSidecar.from_dict(_require(d, "candidate")),
            per_scenario=[
                DeltaScenario.from_dict(s) for s in _require(d, "perScenario")
            ],
            rollup=DeltaRollup.from_dict(_require(d, "rollup")),
        )


__all__ = [
    "Harness",
    "HARNESSES",
    "ModelTier",
    "MODEL_TIERS",
    "StageKind",
    "STAGE_KINDS",
    "REPORT_SCHEMA_VERSION",
    "DELTA_SCHEMA_VERSION",
    "ToolCallMetrics",
    "TurnMetrics",
    "StageMetrics",
    "RunMetrics",
    "ReportRollup",
    "Report",
    "DeltaSidecar",
    "DeltaScenario",
    "DeltaRollup",
    "Delta",
]
