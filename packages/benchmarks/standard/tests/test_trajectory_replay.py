"""Smoke + unit tests for the trajectory-replay adapter."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from benchmarks.standard._base import MockClient
from benchmarks.standard._cli import main_entry
from benchmarks.standard.trajectory_replay import (
    BENCHMARK_ID,
    DATASET_VERSION,
    SMOKE_TRAJECTORY,
    BaselineToolCall,
    ReplayStage,
    ReplayTrajectory,
    TrajectoryReplayRunner,
    _extract_action_names_from_text,
    _extract_candidate_action_names,
    _extract_stage,
    _stage_score_from_components,
    _TrajectoryReplayFactory,
    load_trajectories,
    load_trajectory_file,
    write_smoke_fixture,
)


# ───────────────────────────── helpers ─────────────────────────────


def _make_stage(
    *,
    stage_id: str = "stage-0",
    kind: str = "messageHandler",
    model_type: str = "RESPONSE_HANDLER",
    actions: tuple[str, ...] = (),
    response_text: str = "ok",
    tools: tuple[dict[str, Any], ...] = (),
) -> ReplayStage:
    return ReplayStage(
        stage_id=stage_id,
        kind=kind,
        model_type=model_type,
        messages=(
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "hi"},
        ),
        baseline_response_text=response_text,
        baseline_tool_calls=tuple(BaselineToolCall(name=a, args={}) for a in actions),
        tools=tools,
    )


def _make_trajectory(
    *,
    trajectory_id: str = "tj-0001",
    stages: tuple[ReplayStage, ...] = (),
) -> ReplayTrajectory:
    return ReplayTrajectory(
        trajectory_id=trajectory_id,
        agent_id="agent-1",
        source_path=Path("/tmp/test-fixture.json"),
        root_message_text="say hi",
        stages=stages,
    )


class _ToolCallMockClient(MockClient):
    """MockClient that injects tool_calls into the raw response payload.

    Lets us simulate a candidate model that emits OpenAI-shaped
    ``message.tool_calls`` so we can exercise the action-sequence
    comparison path.
    """

    def __init__(
        self,
        responses: list[str],
        *,
        tool_call_seqs: list[tuple[str, ...]],
    ) -> None:
        super().__init__(responses)
        if len(tool_call_seqs) != len(responses):
            raise ValueError("tool_call_seqs must align with responses")
        self._seqs = tool_call_seqs
        self.seen_tools: list[tuple[dict[str, Any], ...]] = []

    def generate(self, messages, config):  # type: ignore[override]
        idx = self._idx
        result = super().generate(messages, config)
        self.seen_tools.append(tuple(dict(tool) for tool in config.tools))
        seq = self._seqs[idx % len(self._seqs)]
        tool_calls = [
            {
                "id": f"tc{i}",
                "type": "function",
                "function": {"name": name, "arguments": "{}"},
            }
            for i, name in enumerate(seq)
        ]
        raw: dict[str, object] = {
            "choices": [{"message": {"tool_calls": tool_calls, "content": result.text}}],
            "mock": True,
        }
        return type(result)(
            text=result.text,
            prompt_tokens=0,
            completion_tokens=0,
            raw=raw,
        )


def _string_match_score(expected: str, response: str) -> float:
    """Deterministic reward fn for tests — 1.0 on exact-string match, else 0.0."""

    return 1.0 if response.strip() == str(expected).strip() else 0.0


# ───────────────────────────── extraction tests ─────────────────────────────


def test_extract_stage_returns_none_when_no_model() -> None:
    assert _extract_stage({"stageId": "s1", "kind": "evaluation"}) is None


def test_extract_stage_returns_none_when_no_response_or_tool_calls() -> None:
    raw = {
        "stageId": "s1",
        "kind": "messageHandler",
        "model": {
            "modelType": "RESPONSE_HANDLER",
            "messages": [{"role": "user", "content": "x"}],
            "tools": [],
            "response": "",
            "toolCalls": [],
        },
    }
    assert _extract_stage(raw) is None


def test_extract_stage_keeps_tool_calls_only() -> None:
    raw = {
        "stageId": "s1",
        "kind": "messageHandler",
        "model": {
            "modelType": "ACTION_PLANNER",
            "messages": [{"role": "user", "content": "x"}],
            "tools": [{"name": "T", "schema": {}}],
            "response": "",
            "toolCalls": [
                {"id": "tc1", "name": "REPLY", "args": {}},
                {"id": "tc2", "name": "FETCH", "args": {"q": 1}},
                {"id": "tc3", "name": "", "args": {}},  # dropped: empty name
                "garbage",  # dropped: not a dict
            ],
        },
    }
    stage = _extract_stage(raw)
    assert stage is not None
    assert stage.baseline_action_names == ("REPLY", "FETCH")
    assert stage.tools == ({"name": "T", "schema": {}},)


def test_load_trajectory_file_skips_malformed(tmp_path: Path) -> None:
    bad = tmp_path / "bad.json"
    bad.write_text("not json", encoding="utf-8")
    assert load_trajectory_file(bad) is None

    missing_id = tmp_path / "missing.json"
    missing_id.write_text(json.dumps({"stages": []}), encoding="utf-8")
    assert load_trajectory_file(missing_id) is None

    no_stages = tmp_path / "nostages.json"
    no_stages.write_text(
        json.dumps({"trajectoryId": "tj-x", "stages": "not a list"}),
        encoding="utf-8",
    )
    assert load_trajectory_file(no_stages) is None


def test_load_trajectory_file_reads_smoke_fixture(tmp_path: Path) -> None:
    path = write_smoke_fixture(tmp_path)
    traj = load_trajectory_file(path)
    assert traj is not None
    assert traj.trajectory_id == "tj-fixture-0001"
    assert len(traj.stages) == 1
    assert traj.stages[0].baseline_action_names == ("HANDLE_RESPONSE",)


def test_load_trajectories_respects_limit(tmp_path: Path) -> None:
    for i in range(3):
        sub = tmp_path / f"agent-{i}"
        sub.mkdir()
        path = write_smoke_fixture(sub)
        # Make trajectory ids unique so they all load distinctly.
        data = json.loads(path.read_text("utf-8"))
        data["trajectoryId"] = f"tj-fixture-{i:04d}"
        path.write_text(json.dumps(data), encoding="utf-8")
    loaded = load_trajectories(tmp_path, limit=2)
    assert len(loaded) == 2


def test_load_trajectories_raises_when_missing() -> None:
    with pytest.raises(RuntimeError, match="trajectory directory does not exist"):
        load_trajectories(Path("/tmp/does-not-exist-xyz-trajectory-set"), limit=None)


# ───────────────────────────── helper logic tests ─────────────────────────────


def test_extract_candidate_action_names_from_openai_shape() -> None:
    raw = {
        "choices": [
            {
                "message": {
                    "tool_calls": [
                        {"function": {"name": "FOO"}},
                        {"function": {"name": "BAR"}},
                    ]
                }
            }
        ]
    }
    assert _extract_candidate_action_names(raw) == ("FOO", "BAR")


def test_extract_candidate_action_names_top_level_fallback() -> None:
    raw = {
        "choices": [
            {"message": {"tool_calls": [{"name": "BAZ"}]}},
        ]
    }
    assert _extract_candidate_action_names(raw) == ("BAZ",)


def test_extract_candidate_action_names_prefers_harness_tool_calls() -> None:
    raw = {
        "harness": "hermes",
        "actions": ["SEARCH"],
        "params": {
            "tool_calls": [
                {"name": "SEARCH", "arguments": {"q": "x"}},
                {"function": {"name": "OPEN"}},
            ]
        },
    }
    assert _extract_candidate_action_names(raw) == ("SEARCH", "OPEN")


def test_extract_action_names_from_text_handles_hermes_xml() -> None:
    text = (
        'pre <tool_call>{"name":"A","args":{}}</tool_call> mid '
        '<tool_call>{"name":"B","arguments":{"x":1}}</tool_call> tail'
    )
    assert _extract_action_names_from_text(text) == ("A", "B")


def test_extract_action_names_from_text_ignores_malformed() -> None:
    text = "<tool_call>not json</tool_call> <tool_call>{}</tool_call>"
    assert _extract_action_names_from_text(text) == ()


def test_stage_score_components_clamp_to_unit_interval() -> None:
    assert _stage_score_from_components(
        action_match=True,
        reward=1.0,
        reward_pass=True,
        action_weight=0.5,
        final_state_weight=0.5,
    ) == pytest.approx(1.0)
    assert _stage_score_from_components(
        action_match=False,
        reward=-1.0,
        reward_pass=False,
        action_weight=0.5,
        final_state_weight=0.5,
    ) == pytest.approx(0.0)
    # Action match only with no final-state pass → half credit.
    assert _stage_score_from_components(
        action_match=True,
        reward=0.0,
        reward_pass=False,
        action_weight=0.5,
        final_state_weight=0.5,
    ) == pytest.approx(0.5)


def test_stage_score_components_rejects_zero_total_weight() -> None:
    assert _stage_score_from_components(
        action_match=True,
        reward=1.0,
        reward_pass=True,
        action_weight=0.0,
        final_state_weight=0.0,
    ) == 0.0


# ───────────────────────────── runner config tests ─────────────────────────────


def test_runner_rejects_out_of_range_reward_threshold(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="reward_threshold"):
        TrajectoryReplayRunner(
            traj_set=tmp_path,
            baseline="m",
            reward_threshold=2.0,
        )


def test_runner_rejects_negative_score_weights(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="non-negative"):
        TrajectoryReplayRunner(
            traj_set=tmp_path,
            baseline="m",
            action_weight=-0.1,
            final_state_weight=0.5,
        )


def test_runner_rejects_zero_total_weight(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="at least one score weight"):
        TrajectoryReplayRunner(
            traj_set=tmp_path,
            baseline="m",
            action_weight=0.0,
            final_state_weight=0.0,
        )


# ───────────────────────────── end-to-end replay tests ─────────────────────────────


def test_runner_scores_full_pass_when_candidate_matches(tmp_path: Path) -> None:
    """Exact-string match + correct tool sequence → score 1.0 per stage."""

    stage = _make_stage(
        actions=("HANDLE_RESPONSE",),
        response_text="hello",
    )
    traj = _make_trajectory(stages=(stage,))
    candidate = _ToolCallMockClient(
        responses=["hello"],
        tool_call_seqs=[("HANDLE_RESPONSE",)],
    )
    runner = TrajectoryReplayRunner(
        traj_set=tmp_path,
        baseline="baseline",
        reward_threshold=0.5,
        trajectories=[traj],
        final_state_scorer=_string_match_score,
    )
    result = runner.run(
        client=candidate,
        model="cand",
        endpoint="http://mock",
        output_dir=tmp_path,
        limit=None,
    )
    assert result.benchmark == BENCHMARK_ID
    assert result.dataset_version == DATASET_VERSION
    assert result.n == 1
    assert result.metrics["score"] == pytest.approx(1.0)
    assert result.metrics["action_sequence_match_rate"] == pytest.approx(1.0)
    assert result.metrics["final_state_pass_rate"] == pytest.approx(1.0)
    assert result.metrics["n_stages"] == 1.0


def test_runner_passes_recorded_tools_to_openai_client(tmp_path: Path) -> None:
    """Trajectory replay must exercise native function calling, not text only."""

    tool = {
        "type": "function",
        "function": {
            "name": "lookup_order",
            "description": "Look up an order.",
            "parameters": {"type": "object", "properties": {}},
        },
    }
    stage = _make_stage(
        actions=("lookup_order",),
        response_text="",
        tools=(tool,),
    )
    traj = _make_trajectory(stages=(stage,))
    candidate = _ToolCallMockClient(
        responses=[""],
        tool_call_seqs=[("lookup_order",)],
    )
    runner = TrajectoryReplayRunner(
        traj_set=tmp_path,
        baseline="baseline",
        trajectories=[traj],
        final_state_scorer=_string_match_score,
    )
    result = runner.run(
        client=candidate,
        model="cand",
        endpoint="http://mock",
        output_dir=tmp_path,
        limit=None,
    )
    assert result.metrics["action_sequence_match_rate"] == pytest.approx(1.0)
    assert candidate.seen_tools == [(tool,)]


def test_runner_partial_credit_on_action_match_only(tmp_path: Path) -> None:
    stage = _make_stage(
        actions=("HANDLE_RESPONSE",),
        response_text="hello",
    )
    traj = _make_trajectory(stages=(stage,))
    candidate = _ToolCallMockClient(
        responses=["wrong text"],
        tool_call_seqs=[("HANDLE_RESPONSE",)],
    )
    runner = TrajectoryReplayRunner(
        traj_set=tmp_path,
        baseline="baseline",
        reward_threshold=0.5,
        trajectories=[traj],
        final_state_scorer=_string_match_score,
    )
    result = runner.run(
        client=candidate,
        model="cand",
        endpoint="http://mock",
        output_dir=tmp_path,
        limit=None,
    )
    # Action match (0.5) + final-state miss (0.0) → 0.5.
    assert result.metrics["score"] == pytest.approx(0.5)
    assert result.metrics["action_sequence_match_rate"] == pytest.approx(1.0)
    assert result.metrics["final_state_pass_rate"] == pytest.approx(0.0)


def test_runner_zero_when_nothing_matches(tmp_path: Path) -> None:
    stage = _make_stage(
        actions=("HANDLE_RESPONSE",),
        response_text="hello",
    )
    traj = _make_trajectory(stages=(stage,))
    candidate = _ToolCallMockClient(
        responses=["wrong"],
        tool_call_seqs=[("DIFFERENT_TOOL",)],
    )
    runner = TrajectoryReplayRunner(
        traj_set=tmp_path,
        baseline="baseline",
        reward_threshold=0.5,
        trajectories=[traj],
        final_state_scorer=_string_match_score,
    )
    result = runner.run(
        client=candidate,
        model="cand",
        endpoint="http://mock",
        output_dir=tmp_path,
        limit=None,
    )
    assert result.metrics["score"] == pytest.approx(0.0)
    # And the diff was written into raw_json for debugging.
    trajectories = result.raw_json["trajectories"]
    assert isinstance(trajectories, list)
    stage_row = trajectories[0]["stages"][0]
    assert stage_row["baseline_actions"] == ["HANDLE_RESPONSE"]
    assert stage_row["candidate_actions"] == ["DIFFERENT_TOOL"]
    assert stage_row["action_sequence_match"] is False
    assert stage_row["reward_pass"] is False


def test_runner_set_match_mode_allows_reorder(tmp_path: Path) -> None:
    stage = _make_stage(
        actions=("A", "B"),
        response_text="hello",
    )
    traj = _make_trajectory(stages=(stage,))
    candidate = _ToolCallMockClient(
        responses=["hello"],
        tool_call_seqs=[("B", "A")],
    )
    runner_strict = TrajectoryReplayRunner(
        traj_set=tmp_path,
        baseline="baseline",
        reward_threshold=0.5,
        exact_action_sequence=True,
        trajectories=[traj],
        final_state_scorer=_string_match_score,
    )
    strict = runner_strict.run(
        client=candidate,
        model="cand",
        endpoint="http://mock",
        output_dir=tmp_path,
        limit=None,
    )
    assert strict.metrics["action_sequence_match_rate"] == 0.0

    # Same fixtures, but now allow set-match. We need fresh client state.
    candidate2 = _ToolCallMockClient(
        responses=["hello"],
        tool_call_seqs=[("B", "A")],
    )
    runner_loose = TrajectoryReplayRunner(
        traj_set=tmp_path,
        baseline="baseline",
        reward_threshold=0.5,
        exact_action_sequence=False,
        trajectories=[traj],
        final_state_scorer=_string_match_score,
    )
    loose = runner_loose.run(
        client=candidate2,
        model="cand",
        endpoint="http://mock",
        output_dir=tmp_path,
        limit=None,
    )
    assert loose.metrics["action_sequence_match_rate"] == 1.0


def test_runner_aggregates_failures(tmp_path: Path) -> None:
    good = _make_trajectory(
        trajectory_id="tj-good",
        stages=(_make_stage(actions=("X",), response_text="ok"),),
    )
    bad = _make_trajectory(
        trajectory_id="tj-bad",
        stages=(_make_stage(actions=("X",), response_text="ok"),),
    )
    # 1st generate() answers good correctly, 2nd answers bad incorrectly.
    candidate = _ToolCallMockClient(
        responses=["ok", "nope"],
        tool_call_seqs=[("X",), ("Y",)],
    )
    runner = TrajectoryReplayRunner(
        traj_set=tmp_path,
        baseline="baseline",
        reward_threshold=0.5,
        trajectories=[good, bad],
        final_state_scorer=_string_match_score,
    )
    result = runner.run(
        client=candidate,
        model="cand",
        endpoint="http://mock",
        output_dir=tmp_path,
        limit=None,
    )
    assert result.n == 2
    failure_ids = [f["trajectory_id"] for f in result.failures]
    assert "tj-bad" in failure_ids
    assert "tj-good" not in failure_ids


def test_runner_raises_when_no_trajectories_loaded(tmp_path: Path) -> None:
    runner = TrajectoryReplayRunner(
        traj_set=tmp_path,
        baseline="baseline",
        trajectories=[],
        final_state_scorer=_string_match_score,
    )
    with pytest.raises(RuntimeError, match="zero trajectories"):
        runner.run(
            client=MockClient(["x"]),
            model="cand",
            endpoint="http://mock",
            output_dir=tmp_path,
            limit=None,
        )


def test_runner_records_per_stage_error_without_crashing(tmp_path: Path) -> None:
    class _BoomClient:
        def generate(self, messages, config):  # noqa: ARG002
            raise RuntimeError("backend exploded")

    stage = _make_stage(actions=("X",), response_text="hi")
    traj = _make_trajectory(stages=(stage,))
    runner = TrajectoryReplayRunner(
        traj_set=tmp_path,
        baseline="baseline",
        trajectories=[traj],
        final_state_scorer=_string_match_score,
    )
    result = runner.run(
        client=_BoomClient(),  # type: ignore[arg-type]
        model="cand",
        endpoint="http://mock",
        output_dir=tmp_path,
        limit=None,
    )
    assert result.metrics["score"] == pytest.approx(0.0)
    trajectories = result.raw_json["trajectories"]
    assert isinstance(trajectories, list)
    err = trajectories[0]["stages"][0]["error"]
    assert err == "backend exploded"


# ───────────────────────────── CLI smoke test ─────────────────────────────


def test_cli_smoke_end_to_end(tmp_path: Path) -> None:
    """Drive the CLI in --mock mode against the bundled smoke fixture.

    Mirrors what `python -m benchmarks.standard.trajectory_replay --mock`
    would produce in CI: an end-to-end pass with one trajectory and one
    stage, scoring 0.5 (final-state matches via string equality, but the
    MockClient can't emit tool_calls so the action sequence is empty).
    """

    traj_set = tmp_path / "traj-set"
    out_dir = tmp_path / "out"
    rc = main_entry(
        _TrajectoryReplayFactory(),
        output_filename="trajectory-replay-results.json",
        argv=[
            "--mock",
            "--provider",
            "openai",
            "--model",
            "candidate",
            "--api-key-env",
            "DOES_NOT_EXIST",
            "--output",
            str(out_dir),
            "--traj-set",
            str(traj_set),
            "--baseline",
            "fixture-baseline",
        ],
    )
    assert rc == 0
    data = json.loads(
        (out_dir / "trajectory-replay-results.json").read_text("utf-8")
    )
    assert data["benchmark"] == BENCHMARK_ID
    assert data["dataset_version"] == DATASET_VERSION
    assert data["metrics"]["n_stages"] == 1.0
    # Smoke fixture: MockClient returns the baseline response text verbatim
    # but cannot emit tool_calls, so action-sequence misses (0.0) while
    # final-state passes (1.0) → stage score 0.5.
    assert data["metrics"]["score"] == pytest.approx(0.5)
    assert data["metrics"]["action_sequence_match_rate"] == pytest.approx(0.0)
    assert data["metrics"]["final_state_pass_rate"] == pytest.approx(1.0)
    assert data["metrics"]["reward_threshold"] == 0.5
    # And the persisted on-disk fixture is preserved for re-use.
    assert (traj_set / "tj-smoke-0001.json").exists()


def test_cli_rejects_no_exact_action_sequence_inversion(tmp_path: Path) -> None:
    """`--no-exact-action-sequence` should toggle the strict flag off."""

    traj_set = tmp_path / "traj-set"
    out_dir = tmp_path / "out"
    rc = main_entry(
        _TrajectoryReplayFactory(),
        output_filename="trajectory-replay-results.json",
        argv=[
            "--mock",
            "--provider",
            "openai",
            "--model",
            "candidate",
            "--api-key-env",
            "DOES_NOT_EXIST",
            "--output",
            str(out_dir),
            "--traj-set",
            str(traj_set),
            "--baseline",
            "fixture-baseline",
            "--no-exact-action-sequence",
        ],
    )
    assert rc == 0
    data = json.loads(
        (out_dir / "trajectory-replay-results.json").read_text("utf-8")
    )
    assert data["raw_json"]["exact_action_sequence"] is False


# ───────────────────────────── registry integration ─────────────────────────────


def test_trajectory_replay_registered_in_top_level_registry() -> None:
    from benchmarks.bench_cli_types import ModelSpec
    from benchmarks.registry import get_benchmark_registry

    workspace = Path(__file__).resolve().parents[3]
    registry = {entry.id: entry for entry in get_benchmark_registry(workspace)}
    assert "trajectory_replay" in registry
    entry = registry["trajectory_replay"]
    assert entry.display_name == "Trajectory Replay"
    cmd = entry.build_command(
        Path("/tmp/out"),
        ModelSpec(provider="openai", model="m"),
        {
            "traj_set": "/tmp/traj",
            "baseline": "base",
            "model_endpoint": "http://x/v1",
            "reward_threshold": 0.25,
            "exact_action_sequence": False,
            "max_tokens": 256,
        },
    )
    assert "benchmarks.standard.trajectory_replay" in cmd
    assert "--traj-set" in cmd and "/tmp/traj" in cmd
    assert "--baseline" in cmd and "base" in cmd
    assert "--reward-threshold" in cmd and "0.25" in cmd
    assert "--no-exact-action-sequence" in cmd
    assert "--max-tokens" in cmd and "256" in cmd


def test_registry_rejects_missing_traj_set() -> None:
    from benchmarks.bench_cli_types import ModelSpec
    from benchmarks.registry import get_benchmark_registry

    workspace = Path(__file__).resolve().parents[3]
    registry = {entry.id: entry for entry in get_benchmark_registry(workspace)}
    entry = registry["trajectory_replay"]
    with pytest.raises(ValueError, match="traj_set"):
        entry.build_command(
            Path("/tmp/out"),
            ModelSpec(provider="openai", model="m"),
            {"baseline": "base", "model_endpoint": "http://x/v1"},
        )


def test_registry_rejects_missing_baseline() -> None:
    from benchmarks.bench_cli_types import ModelSpec
    from benchmarks.registry import get_benchmark_registry

    workspace = Path(__file__).resolve().parents[3]
    registry = {entry.id: entry for entry in get_benchmark_registry(workspace)}
    entry = registry["trajectory_replay"]
    with pytest.raises(ValueError, match="baseline"):
        entry.build_command(
            Path("/tmp/out"),
            ModelSpec(provider="openai", model="m"),
            {"traj_set": "/tmp/traj", "model_endpoint": "http://x/v1"},
        )


def test_registry_locate_result_returns_canonical_filename(tmp_path: Path) -> None:
    from benchmarks.registry import get_benchmark_registry

    workspace = Path(__file__).resolve().parents[3]
    registry = {entry.id: entry for entry in get_benchmark_registry(workspace)}
    entry = registry["trajectory_replay"]
    assert entry.locate_result(tmp_path).name == "trajectory-replay-results.json"


def test_registry_extract_score_reads_metrics() -> None:
    from benchmarks.registry import get_benchmark_registry

    workspace = Path(__file__).resolve().parents[3]
    registry = {entry.id: entry for entry in get_benchmark_registry(workspace)}
    entry = registry["trajectory_replay"]
    sample = {
        "benchmark": "trajectory_replay",
        "model": "m",
        "endpoint": "x",
        "dataset_version": DATASET_VERSION,
        "n": 2,
        "metrics": {
            "score": 0.42,
            "n": 2.0,
            "n_stages": 5.0,
            "action_sequence_match_rate": 0.4,
            "final_state_pass_rate": 0.5,
            "reward_threshold": 0.5,
        },
        "raw_json": {},
    }
    extraction = entry.extract_score(sample)
    assert extraction.score == 0.42
    assert extraction.unit == "ratio"
    assert extraction.higher_is_better is True
    assert extraction.metrics["score"] == 0.42
    assert extraction.metrics["action_sequence_match_rate"] == 0.4
    assert extraction.metrics["final_state_pass_rate"] == 0.5
    assert extraction.metrics["n_stages"] == 5.0
