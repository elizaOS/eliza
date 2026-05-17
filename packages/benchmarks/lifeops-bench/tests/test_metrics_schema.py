"""Round-trip smoke test for the canonical LifeOpsBench metrics schema.

Builds one example of each top-level artifact, serializes via ``to_dict``,
parses back via ``from_dict``, and asserts deep equality. Catches drift in
field names, required-vs-optional bookkeeping, and round-trip stability.
"""

from __future__ import annotations

import json

from eliza_lifeops_bench.metrics_schema import (
    DELTA_SCHEMA_VERSION,
    REPORT_SCHEMA_VERSION,
    Delta,
    DeltaRollup,
    DeltaScenario,
    DeltaSidecar,
    Report,
    ReportRollup,
    RunMetrics,
    StageMetrics,
    ToolCallMetrics,
    TurnMetrics,
)


def _example_turn(idx: int = 0) -> TurnMetrics:
    return TurnMetrics(
        turn_idx=idx,
        started_at=1_000.0,
        ended_at=1_350.0,
        latency_ms=350.0,
        provider="cerebras",
        model_name="gpt-oss-120b",
        model_tier="large",
        input_tokens=1024,
        output_tokens=256,
        total_tokens=1280,
        cache_read_input_tokens=896,
        cache_creation_input_tokens=128,
        cache_hit_pct=0.875,
        cache_supported=True,
        cost_usd=0.00123,
        tool_calls=[
            ToolCallMetrics(
                name="calendar.findFreeSlot",
                success=True,
                duration_ms=42.0,
            ),
            ToolCallMetrics(
                name="calendar.createEvent",
                success=False,
                duration_ms=18.0,
                error="conflict",
            ),
        ],
        tool_search_top_k=8,
        prompt_cache_key="lifeops-bench/calendar/seed=42",
        prefix_hash="sha256:deadbeef",
    )


def _example_stage() -> StageMetrics:
    return StageMetrics(
        stage_id="stg-0",
        kind="plannerTurn",
        iteration=0,
        started_at=1_000.0,
        ended_at=1_350.0,
        latency_ms=350.0,
        provider="cerebras",
        model_name="gpt-oss-120b",
        model_tier="large",
        input_tokens=1024,
        output_tokens=256,
        cache_read_input_tokens=896,
        cache_creation_input_tokens=128,
        cache_hit_pct=0.875,
        cache_supported=True,
        cost_usd=0.00123,
        prefix_hash="sha256:deadbeef",
        prompt_cache_key="lifeops-bench/calendar/seed=42",
    )


def _example_run() -> RunMetrics:
    turns = [_example_turn(0), _example_turn(1)]
    return RunMetrics(
        run_id="run-abc",
        scenario_id="calendar-001",
        harness="eliza",
        provider="cerebras",
        model_name="gpt-oss-120b",
        model_tier="large",
        pre_release=False,
        pass_at_1=True,
        pass_at_k=True,
        state_hash_match=True,
        started_at=1_000.0,
        ended_at=2_500.0,
        time_to_complete_ms=1_500.0,
        turns=turns,
        stages=[_example_stage()],
        total_input_tokens=2_048,
        total_output_tokens=512,
        total_cache_read_tokens=1_792,
        total_cache_creation_tokens=256,
        aggregate_cache_hit_pct=0.875,
        total_cost_usd=0.00246,
        planner_iterations=2,
        tool_call_count=4,
        tool_failure_count=1,
    )


def _example_report() -> Report:
    run = _example_run()
    return Report(
        generated_at="2026-05-11T17:00:00Z",
        run_id="run-abc",
        harness="eliza",
        provider="cerebras",
        model_name="gpt-oss-120b",
        model_tier="large",
        pre_release=False,
        scenarios=[run],
        rollup=ReportRollup(
            scenario_count=1,
            pass_count=1,
            pass_rate=1.0,
            total_input_tokens=2_048,
            total_output_tokens=512,
            total_cache_read_tokens=1_792,
            aggregate_cache_hit_pct=0.875,
            total_cost_usd=0.00246,
            total_time_ms=1_500.0,
        ),
        notes=["cerebras prompt cache: default-on, 128-token blocks"],
    )


def _example_delta() -> Delta:
    return Delta(
        generated_at="2026-05-11T18:00:00Z",
        baseline=DeltaSidecar(run_id="run-base", label="baseline"),
        candidate=DeltaSidecar(run_id="run-cand", label="optimized"),
        per_scenario=[
            DeltaScenario(
                scenario_id="calendar-001",
                pass_baseline=False,
                pass_candidate=True,
                delta_cost_usd=-0.00050,
                delta_latency_ms=-200.0,
                delta_total_tokens=-128.0,
                delta_cache_hit_pct=0.20,
            ),
            DeltaScenario(
                scenario_id="mail-002",
                pass_baseline=True,
                pass_candidate=True,
                delta_cost_usd=0.0,
                delta_latency_ms=0.0,
                delta_total_tokens=0.0,
                delta_cache_hit_pct=None,
            ),
        ],
        rollup=DeltaRollup(
            delta_pass_rate=0.5,
            delta_cost_usd=-0.00050,
            delta_total_tokens=-128.0,
            delta_cache_hit_pct=0.20,
            delta_time_ms=-200.0,
        ),
    )


def test_turn_round_trip() -> None:
    turn = _example_turn()
    encoded = json.dumps(turn.to_dict())
    decoded = TurnMetrics.from_dict(json.loads(encoded))
    assert decoded == turn


def test_stage_round_trip() -> None:
    stage = _example_stage()
    encoded = json.dumps(stage.to_dict())
    decoded = StageMetrics.from_dict(json.loads(encoded))
    assert decoded == stage


def test_run_round_trip() -> None:
    run = _example_run()
    encoded = json.dumps(run.to_dict())
    decoded = RunMetrics.from_dict(json.loads(encoded))
    assert decoded == run


def test_report_round_trip() -> None:
    report = _example_report()
    payload = report.to_dict()
    assert payload["schemaVersion"] == REPORT_SCHEMA_VERSION
    encoded = json.dumps(payload)
    decoded = Report.from_dict(json.loads(encoded))
    assert decoded == report


def test_delta_round_trip() -> None:
    delta = _example_delta()
    payload = delta.to_dict()
    assert payload["schemaVersion"] == DELTA_SCHEMA_VERSION
    encoded = json.dumps(payload)
    decoded = Delta.from_dict(json.loads(encoded))
    assert decoded == delta


def test_cache_supported_is_strict_bool() -> None:
    """`cache_supported` must always serialize as a real bool, never None."""
    turn = _example_turn()
    payload = turn.to_dict()
    assert isinstance(payload["cacheSupported"], bool)


def test_nullable_cache_fields_preserve_none() -> None:
    """A turn from a provider without cache support must keep `None`, not 0."""
    turn = TurnMetrics(
        turn_idx=0,
        started_at=0.0,
        ended_at=10.0,
        latency_ms=10.0,
        provider="local-llama",
        model_name="llama-3.2-1b-instruct",
        input_tokens=64,
        output_tokens=16,
        total_tokens=80,
        cache_read_input_tokens=None,
        cache_creation_input_tokens=None,
        cache_hit_pct=None,
        cache_supported=False,
        cost_usd=0.0,
        tool_calls=[],
    )
    payload = turn.to_dict()
    assert payload["cacheReadInputTokens"] is None
    assert payload["cacheCreationInputTokens"] is None
    assert payload["cacheHitPct"] is None
    assert payload["cacheSupported"] is False
    round_trip = TurnMetrics.from_dict(json.loads(json.dumps(payload)))
    assert round_trip == turn
