"""Trajectory-replay regression benchmark.

Closes the M5 follow-up gap: today only LifeOpsBench replays historical
trajectories against a candidate model. This adapter generalizes that
pattern to the standard benchmark surface so any model behind an
OpenAI-compatible endpoint can be regression-checked against a curated
set of ``eliza_native_v1`` trajectories captured by elizaOS runtimes
(``~/.eliza/trajectories/`` or ``~/.eliza/trajectories/``).

How replay works
----------------

A persisted trajectory contains one or more *stages*. Each stage that
called a model records the exact ``messages`` and ``tools`` the runtime
sent plus the model's recorded ``response`` and ``toolCalls``. We treat
the recorded response as the *baseline* ground truth and replay the
same input against the candidate model endpoint.

For each stage we compute two diff dimensions:

1. **Action sequence match** — the sequence of tool-call names emitted
   by the candidate must equal the baseline sequence exactly. We do not
   accept "close enough" reorderings. Either both sides emit the same
   ordered list of tool names or the stage is marked
   ``action_sequence_match=False``.

2. **Final-state match** — when the trajectory's terminal stage is a
   reply (``HANDLE_RESPONSE`` toolcall, ``plan.reply`` populated, or a
   plain text completion), we compare the candidate's final string
   payload against the baseline with a local lexical scorer.

The trajectory's overall score is the mean of stage scores (each
``action_sequence_match * 0.5 + reward * 0.5``). The benchmark's
aggregate score is the mean trajectory score.

Strict-by-default
-----------------

There is no fuzzy match anywhere — every threshold is an explicit
config knob. The defaults match what eliza-1's RL_STRATEGY.md uses for
verifiable correctness in GRPO training:

* ``--exact-action-sequence`` (default True): tool-name sequence must
  match byte-for-byte. Set to ``--no-exact-action-sequence`` to fall
  back to set-equality (still a hard match, just unordered).
* ``--reward-threshold`` (default 0.5): per-stage final-state pass
  threshold against the local lexical scorer. Stages below this don't
  get credit for final-state.

CLI:

    python -m benchmarks.standard.trajectory_replay \\
        --model-endpoint http://localhost:8000/v1 \\
        --traj-set ~/.eliza/trajectories \\
        --baseline meta-llama/Llama-3.1-8B-Instruct \\
        --output /tmp/traj-replay

Result file: ``<output>/trajectory-replay-results.json``.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import time
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ._base import (
    BenchmarkResult,
    ChatMessage,
    GenerationConfig,
    OpenAICompatibleClient,
    RunStats,
)
from ._cli import RunnerFactory, cli_dispatch

log = logging.getLogger("benchmarks.standard.trajectory_replay")

BENCHMARK_ID = "trajectory_replay"
DATASET_VERSION = "eliza_native_v1@replay"
RESULT_FILENAME = "trajectory-replay-results.json"

DEFAULT_REWARD_THRESHOLD = 0.5
DEFAULT_PER_TRAJECTORY_TIMEOUT_S = 60.0
DEFAULT_MAX_TOKENS = 768

# Stage weights — split 50/50 between "did the candidate take the same
# sequence of actions" and "did it produce a final response that scores
# above the reward threshold". Tunable via CLI.
DEFAULT_ACTION_WEIGHT = 0.5
DEFAULT_FINAL_STATE_WEIGHT = 0.5


FinalStateScorer = Callable[[str, str], float]


# ───────────────────────────── trajectory IO ─────────────────────────────


@dataclass(frozen=True)
class BaselineToolCall:
    """One recorded tool-call from a baseline trajectory stage."""

    name: str
    args: dict[str, Any]


@dataclass(frozen=True)
class ReplayStage:
    """One replayable stage extracted from a persisted trajectory.

    A trajectory is a sequence of stages; only stages with recorded
    model input (messages) and output (response or toolCalls) are
    replayable. Tool-execution stages and stages without a model record
    are skipped at extraction time.
    """

    stage_id: str
    kind: str
    model_type: str
    messages: tuple[dict[str, Any], ...]
    baseline_response_text: str
    baseline_tool_calls: tuple[BaselineToolCall, ...]
    tools: tuple[dict[str, Any], ...]

    @property
    def baseline_action_names(self) -> tuple[str, ...]:
        return tuple(tc.name for tc in self.baseline_tool_calls)


@dataclass(frozen=True)
class ReplayTrajectory:
    """A persisted trajectory pruned to replayable stages."""

    trajectory_id: str
    agent_id: str
    source_path: Path
    root_message_text: str
    stages: tuple[ReplayStage, ...]


def _coerce_str(value: Any) -> str:
    if isinstance(value, str):
        return value
    if value is None:
        return ""
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def _extract_stage(stage: dict[str, Any]) -> ReplayStage | None:
    """Pull the replayable fields out of one trajectory stage.

    Returns ``None`` when the stage didn't call a model (tool-execution
    stages, evaluator stages without a model record, malformed stages).
    """

    model = stage.get("model")
    if not isinstance(model, dict):
        return None
    messages = model.get("messages")
    if not isinstance(messages, list) or not messages:
        return None
    tools = model.get("tools") if isinstance(model.get("tools"), list) else []

    raw_tool_calls = model.get("toolCalls")
    baseline_tool_calls: list[BaselineToolCall] = []
    if isinstance(raw_tool_calls, list):
        for tc in raw_tool_calls:
            if not isinstance(tc, dict):
                continue
            name = tc.get("name")
            args = tc.get("args")
            if not isinstance(name, str) or not name:
                continue
            baseline_tool_calls.append(
                BaselineToolCall(
                    name=name,
                    args=args if isinstance(args, dict) else {},
                )
            )

    baseline_response_text = _coerce_str(model.get("response"))
    if not baseline_response_text and not baseline_tool_calls:
        # Nothing to score against.
        return None

    stage_id = stage.get("stageId")
    kind = stage.get("kind") or ""
    model_type = model.get("modelType") or ""
    if not isinstance(stage_id, str) or not stage_id:
        return None

    return ReplayStage(
        stage_id=stage_id,
        kind=str(kind),
        model_type=str(model_type),
        messages=tuple(m for m in messages if isinstance(m, dict)),
        baseline_response_text=baseline_response_text,
        baseline_tool_calls=tuple(baseline_tool_calls),
        tools=tuple(t for t in tools if isinstance(t, dict)),
    )


def load_trajectory_file(path: Path) -> ReplayTrajectory | None:
    """Parse one trajectory JSON file. Returns ``None`` on malformed input.

    Malformed = not a JSON object, missing required top-level fields, or
    no replayable stages after extraction. The caller logs and skips —
    we do not raise here because real persisted directories contain
    in-progress / aborted trajectories.
    """

    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    if not isinstance(payload, dict):
        return None

    trajectory_id = payload.get("trajectoryId")
    agent_id = payload.get("agentId") or ""
    stages = payload.get("stages")
    root_message = payload.get("rootMessage")
    if not isinstance(trajectory_id, str) or not trajectory_id:
        return None
    if not isinstance(stages, list):
        return None

    root_text = ""
    if isinstance(root_message, dict):
        root_text = _coerce_str(root_message.get("text"))

    replay_stages: list[ReplayStage] = []
    for stage in stages:
        if not isinstance(stage, dict):
            continue
        extracted = _extract_stage(stage)
        if extracted is not None:
            replay_stages.append(extracted)

    if not replay_stages:
        return None

    return ReplayTrajectory(
        trajectory_id=trajectory_id,
        agent_id=str(agent_id),
        source_path=path,
        root_message_text=root_text,
        stages=tuple(replay_stages),
    )


def load_trajectories(directory: Path, *, limit: int | None) -> list[ReplayTrajectory]:
    """Scan ``directory`` recursively for ``*.json`` trajectory files.

    Returns up to ``limit`` valid trajectories. Sorted by path so runs
    are reproducible.
    """

    if not directory.exists() or not directory.is_dir():
        raise RuntimeError(f"trajectory directory does not exist: {directory}")
    out: list[ReplayTrajectory] = []
    for path in sorted(directory.rglob("*.json")):
        if not path.is_file():
            continue
        traj = load_trajectory_file(path)
        if traj is None:
            log.debug("skip non-replayable trajectory: %s", path)
            continue
        out.append(traj)
        if limit is not None and len(out) >= limit:
            break
    return out


# ───────────────────────────── replay execution ─────────────────────────────


@dataclass
class StageReplayResult:
    """Per-stage outcome that feeds the aggregate score."""

    stage_id: str
    kind: str
    model_type: str
    baseline_actions: tuple[str, ...]
    candidate_actions: tuple[str, ...]
    action_sequence_match: bool
    action_set_match: bool
    reward: float
    reward_pass: bool
    candidate_text: str
    baseline_text: str
    action_weight: float = DEFAULT_ACTION_WEIGHT
    final_state_weight: float = DEFAULT_FINAL_STATE_WEIGHT
    error: str | None = None

    @property
    def stage_score(self) -> float:
        return _stage_score_from_components(
            action_match=self.action_sequence_match,
            reward=self.reward,
            reward_pass=self.reward_pass,
            action_weight=self.action_weight,
            final_state_weight=self.final_state_weight,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "stage_id": self.stage_id,
            "kind": self.kind,
            "model_type": self.model_type,
            "baseline_actions": list(self.baseline_actions),
            "candidate_actions": list(self.candidate_actions),
            "action_sequence_match": self.action_sequence_match,
            "action_set_match": self.action_set_match,
            "reward": self.reward,
            "reward_pass": self.reward_pass,
            "candidate_text": self.candidate_text[:600],
            "baseline_text": self.baseline_text[:600],
            "stage_score": self.stage_score,
            "error": self.error,
        }


@dataclass
class TrajectoryReplayResult:
    """One trajectory's worth of stage replays."""

    trajectory_id: str
    agent_id: str
    source_path: str
    n_stages: int
    stage_results: list[StageReplayResult]
    aggregate_score: float
    action_sequence_match_rate: float
    final_state_pass_rate: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "trajectory_id": self.trajectory_id,
            "agent_id": self.agent_id,
            "source_path": self.source_path,
            "n_stages": self.n_stages,
            "aggregate_score": self.aggregate_score,
            "action_sequence_match_rate": self.action_sequence_match_rate,
            "final_state_pass_rate": self.final_state_pass_rate,
            "stages": [s.to_dict() for s in self.stage_results],
        }


def _stage_score_from_components(
    *,
    action_match: bool,
    reward: float,
    reward_pass: bool,
    action_weight: float,
    final_state_weight: float,
) -> float:
    """Combine action-sequence match + reward pass into a stage score.

    Both signals are 0/1 by design (the final-state scorer returns a
    scalar in [0, 1], and the *pass* signal is an explicit threshold
    check). Returned score is in ``[0, action_weight + final_state_weight]``
    — we cap at 1.0 to keep the aggregate in ``[0, 1]``.
    """

    total = action_weight + final_state_weight
    if total <= 0:
        return 0.0
    raw = (
        (action_weight if action_match else 0.0)
        + (final_state_weight if reward_pass else 0.0)
    )
    return max(0.0, min(1.0, raw / total))


def _name_from_tool_call(raw: object) -> str | None:
    if isinstance(raw, str) and raw:
        return raw
    if not isinstance(raw, dict):
        return None
    function = raw.get("function")
    if isinstance(function, dict):
        name = function.get("name")
        if isinstance(name, str) and name:
            return name
    for key in ("name", "tool_name", "tool", "command"):
        name = raw.get(key)
        if isinstance(name, str) and name:
            return name
    return None


def _extend_action_names_from_list(names: list[str], raw: object) -> None:
    if not isinstance(raw, list):
        return
    for item in raw:
        name = _name_from_tool_call(item)
        if name:
            names.append(name)


def _extract_candidate_action_names(raw: dict[str, object]) -> tuple[str, ...]:
    """Extract the candidate's tool-call sequence from a raw chat-completion.

    Looks at ``choices[0].message.tool_calls`` (the standard OpenAI shape).
    Returns an empty tuple when the response carried no tool calls.
    """

    choices = raw.get("choices")
    if isinstance(choices, list) and choices:
        choice = choices[0]
        if isinstance(choice, dict):
            message = choice.get("message")
            if isinstance(message, dict):
                names: list[str] = []
                _extend_action_names_from_list(names, message.get("tool_calls"))
                if names:
                    return tuple(names)

    names = []
    _extend_action_names_from_list(names, raw.get("tool_calls"))
    if names:
        return tuple(names)

    params = raw.get("params")
    if isinstance(params, dict):
        names = []
        _extend_action_names_from_list(names, params.get("tool_calls"))
        if names:
            return tuple(names)

        names = []
        _extend_action_names_from_list(names, params.get("BENCHMARK_ACTIONS"))
        if names:
            return tuple(names)

        single_name = _name_from_tool_call(params.get("BENCHMARK_ACTION"))
        if single_name:
            return (single_name,)

    names = []
    _extend_action_names_from_list(names, raw.get("actions"))
    return tuple(names)


_TOOL_CALL_TEXT_RE = re.compile(
    r"<tool_call>\s*(\{.*?\})\s*</tool_call>",
    re.DOTALL,
)


def _extract_action_names_from_text(text: str) -> tuple[str, ...]:
    """Extract Hermes/OpenClaw-style serialized tool calls from message text."""

    names: list[str] = []
    for raw_call in _TOOL_CALL_TEXT_RE.findall(text or ""):
        try:
            parsed = json.loads(raw_call)
        except json.JSONDecodeError:
            continue
        name = _name_from_tool_call(parsed)
        if name:
            names.append(name)
    return tuple(names)


def _normalize_text_for_score(text: str) -> list[str]:
    lowered = text.lower()
    cleaned = "".join(ch if ch.isalnum() else " " for ch in lowered)
    return [token for token in cleaned.split() if token]


def _lexical_final_state_score(expected: str, actual: str) -> float:
    """Local final-state score for replay without external corpus parsers."""

    expected_norm = " ".join(_normalize_text_for_score(expected))
    actual_norm = " ".join(_normalize_text_for_score(actual))
    if not expected_norm and not actual_norm:
        return 1.0
    if expected_norm and expected_norm == actual_norm:
        return 1.0
    expected_tokens = _normalize_text_for_score(expected)
    actual_tokens = _normalize_text_for_score(actual)
    if not expected_tokens or not actual_tokens:
        return 0.0
    expected_counts: dict[str, int] = {}
    for token in expected_tokens:
        expected_counts[token] = expected_counts.get(token, 0) + 1
    overlap = 0
    for token in actual_tokens:
        count = expected_counts.get(token, 0)
        if count > 0:
            overlap += 1
            expected_counts[token] = count - 1
    precision = overlap / len(actual_tokens)
    recall = overlap / len(expected_tokens)
    if precision + recall == 0:
        return 0.0
    return 2 * precision * recall / (precision + recall)


# ───────────────────────────── runner ─────────────────────────────


class TrajectoryReplayRunner:
    """Replay a curated trajectory set against a candidate model endpoint."""

    benchmark_id: str = BENCHMARK_ID
    dataset_version: str = DATASET_VERSION

    def __init__(
        self,
        *,
        traj_set: Path,
        baseline: str,
        reward_threshold: float = DEFAULT_REWARD_THRESHOLD,
        exact_action_sequence: bool = True,
        action_weight: float = DEFAULT_ACTION_WEIGHT,
        final_state_weight: float = DEFAULT_FINAL_STATE_WEIGHT,
        max_tokens: int = DEFAULT_MAX_TOKENS,
        trajectories: Iterable[ReplayTrajectory] | None = None,
        final_state_scorer: FinalStateScorer | None = None,
    ) -> None:
        if reward_threshold < 0.0 or reward_threshold > 1.0:
            raise ValueError(
                f"reward_threshold must be in [0, 1]; got {reward_threshold}"
            )
        if action_weight < 0 or final_state_weight < 0:
            raise ValueError("score weights must be non-negative")
        if action_weight + final_state_weight <= 0:
            raise ValueError("at least one score weight must be > 0")
        self._traj_set = traj_set
        self._baseline = baseline
        self._reward_threshold = reward_threshold
        self._exact_action_sequence = exact_action_sequence
        self._action_weight = action_weight
        self._final_state_weight = final_state_weight
        self._max_tokens = max_tokens
        self._trajectories = list(trajectories) if trajectories is not None else None
        self._final_state_scorer = final_state_scorer

    def _resolve_final_state_scorer(self) -> FinalStateScorer:
        return self._final_state_scorer or _lexical_final_state_score

    def _replay_stage(
        self,
        *,
        client: OpenAICompatibleClient,
        model: str,
        stage: ReplayStage,
        final_state_scorer: FinalStateScorer,
    ) -> StageReplayResult:
        chat_messages = [
            ChatMessage(role=str(m.get("role", "user")), content=_coerce_str(m.get("content")))
            for m in stage.messages
            if isinstance(m.get("role"), str)
        ]
        config = GenerationConfig(
            model=model,
            max_tokens=self._max_tokens,
            temperature=0.0,
            tools=stage.tools,
            tool_choice="auto" if stage.tools else None,
        )

        try:
            gen = client.generate(chat_messages, config)
        except Exception as exc:  # noqa: BLE001  # boundary: external SDK
            log.warning("stage replay failed (%s): %s", stage.stage_id, exc)
            return StageReplayResult(
                stage_id=stage.stage_id,
                kind=stage.kind,
                model_type=stage.model_type,
                baseline_actions=stage.baseline_action_names,
                candidate_actions=(),
                action_sequence_match=False,
                action_set_match=False,
                reward=-1.0,
                reward_pass=False,
                candidate_text="",
                baseline_text=stage.baseline_response_text,
                action_weight=self._action_weight,
                final_state_weight=self._final_state_weight,
                error=str(exc),
            )

        candidate_actions = _extract_candidate_action_names(gen.raw)
        if not candidate_actions:
            candidate_actions = _extract_action_names_from_text(gen.text)

        baseline_actions = stage.baseline_action_names
        action_sequence_match = baseline_actions == candidate_actions
        action_set_match = set(baseline_actions) == set(candidate_actions)
        effective_action_match = (
            action_sequence_match
            if self._exact_action_sequence
            else action_set_match
        )

        reward_value = final_state_scorer(stage.baseline_response_text, gen.text)
        reward_pass = reward_value >= self._reward_threshold

        return StageReplayResult(
            stage_id=stage.stage_id,
            kind=stage.kind,
            model_type=stage.model_type,
            baseline_actions=baseline_actions,
            candidate_actions=candidate_actions,
            action_sequence_match=effective_action_match,
            action_set_match=action_set_match,
            reward=reward_value,
            reward_pass=reward_pass,
            candidate_text=gen.text,
            baseline_text=stage.baseline_response_text,
            action_weight=self._action_weight,
            final_state_weight=self._final_state_weight,
        )

    def _replay_trajectory(
        self,
        *,
        client: OpenAICompatibleClient,
        model: str,
        trajectory: ReplayTrajectory,
        final_state_scorer: FinalStateScorer,
    ) -> TrajectoryReplayResult:
        stage_results: list[StageReplayResult] = []
        for stage in trajectory.stages:
            stage_results.append(
                self._replay_stage(
                    client=client,
                    model=model,
                    stage=stage,
                    final_state_scorer=final_state_scorer,
                )
            )

        n = len(stage_results)
        if n == 0:
            return TrajectoryReplayResult(
                trajectory_id=trajectory.trajectory_id,
                agent_id=trajectory.agent_id,
                source_path=str(trajectory.source_path),
                n_stages=0,
                stage_results=[],
                aggregate_score=0.0,
                action_sequence_match_rate=0.0,
                final_state_pass_rate=0.0,
            )

        per_stage_scores = [
            _stage_score_from_components(
                action_match=s.action_sequence_match,
                reward=s.reward,
                reward_pass=s.reward_pass,
                action_weight=self._action_weight,
                final_state_weight=self._final_state_weight,
            )
            for s in stage_results
        ]
        action_match_count = sum(1 for s in stage_results if s.action_sequence_match)
        reward_pass_count = sum(1 for s in stage_results if s.reward_pass)

        return TrajectoryReplayResult(
            trajectory_id=trajectory.trajectory_id,
            agent_id=trajectory.agent_id,
            source_path=str(trajectory.source_path),
            n_stages=n,
            stage_results=stage_results,
            aggregate_score=round(sum(per_stage_scores) / n, 4),
            action_sequence_match_rate=round(action_match_count / n, 4),
            final_state_pass_rate=round(reward_pass_count / n, 4),
        )

    def run(
        self,
        *,
        client: OpenAICompatibleClient,
        model: str,
        endpoint: str,
        output_dir: Path,
        limit: int | None,
    ) -> BenchmarkResult:
        stats = RunStats()
        trajectories = (
            self._trajectories
            if self._trajectories is not None
            else load_trajectories(self._traj_set, limit=limit)
        )
        if not trajectories:
            raise RuntimeError(
                f"trajectory replay loaded zero trajectories from {self._traj_set}"
            )
        if limit is not None and self._trajectories is not None:
            trajectories = trajectories[:limit]

        final_state_scorer = self._resolve_final_state_scorer()
        traj_results: list[TrajectoryReplayResult] = []
        failures: list[dict[str, object]] = []
        for traj in trajectories:
            traj_result = self._replay_trajectory(
                client=client,
                model=model,
                trajectory=traj,
                final_state_scorer=final_state_scorer,
            )
            traj_results.append(traj_result)
            if traj_result.aggregate_score < self._reward_threshold and len(failures) < 8:
                failures.append(
                    {
                        "trajectory_id": traj_result.trajectory_id,
                        "agent_id": traj_result.agent_id,
                        "source_path": traj_result.source_path,
                        "score": traj_result.aggregate_score,
                        "action_match_rate": traj_result.action_sequence_match_rate,
                        "final_state_pass_rate": traj_result.final_state_pass_rate,
                    }
                )

        n = len(traj_results)
        total_stages = sum(t.n_stages for t in traj_results)
        if total_stages == 0:
            raise RuntimeError("trajectory replay produced zero stage results")

        agg_score = sum(t.aggregate_score for t in traj_results) / n
        action_rate = sum(t.action_sequence_match_rate for t in traj_results) / n
        final_state_rate = sum(t.final_state_pass_rate for t in traj_results) / n

        return BenchmarkResult(
            benchmark=BENCHMARK_ID,
            model=model,
            endpoint=endpoint,
            dataset_version=DATASET_VERSION,
            n=n,
            metrics={
                "score": round(agg_score, 4),
                "n": float(n),
                "n_stages": float(total_stages),
                "action_sequence_match_rate": round(action_rate, 4),
                "final_state_pass_rate": round(final_state_rate, 4),
                "reward_threshold": float(self._reward_threshold),
            },
            raw_json={
                "baseline": self._baseline,
                "traj_set": str(self._traj_set),
                "exact_action_sequence": self._exact_action_sequence,
                "action_weight": self._action_weight,
                "final_state_weight": self._final_state_weight,
                "trajectories": [t.to_dict() for t in traj_results],
            },
            failures=failures,
            elapsed_s=stats.elapsed(),
        )


# ───────────────────────────── smoke fixtures ─────────────────────────────


SMOKE_TRAJECTORY: dict[str, Any] = {
    "trajectoryId": "tj-fixture-0001",
    "agentId": "00000000-0000-0000-0000-fixture",
    "roomId": "00000000-0000-0000-0000-fixturer",
    "rootMessage": {"id": "m1", "text": "say hello", "sender": "u1"},
    "startedAt": 0,
    "status": "finished",
    "stages": [
        {
            "stageId": "stage-smoke-0",
            "kind": "messageHandler",
            "startedAt": 0,
            "endedAt": 1,
            "latencyMs": 1,
            "model": {
                "modelType": "RESPONSE_HANDLER",
                "modelName": "fixture",
                "provider": "mock",
                "messages": [
                    {"role": "system", "content": "You are a benchmark agent."},
                    {"role": "user", "content": "say hello"},
                ],
                "tools": [],
                "response": (
                    '{"processMessage":"RESPOND","plan":{"contexts":["simple"],'
                    '"reply":"Hello, world!"}}'
                ),
                "toolCalls": [
                    {
                        "id": "tc1",
                        "name": "HANDLE_RESPONSE",
                        "args": {
                            "processMessage": "RESPOND",
                            "plan": {
                                "contexts": ["simple"],
                                "reply": "Hello, world!",
                            },
                        },
                    }
                ],
            },
        }
    ],
    "endedAt": 2,
}


def write_smoke_fixture(directory: Path) -> Path:
    """Write the canonical smoke trajectory under ``directory``.

    Returns the file path. Used by the test suite + ``--smoke`` runs.
    """

    directory.mkdir(parents=True, exist_ok=True)
    target = directory / "tj-smoke-0001.json"
    target.write_text(json.dumps(SMOKE_TRAJECTORY, indent=2), encoding="utf-8")
    return target


# ───────────────────────────── CLI ─────────────────────────────


def _expand_traj_set(raw: str) -> Path:
    expanded = os.path.expanduser(raw)
    return Path(expanded).resolve()


class _TrajectoryReplayFactory(RunnerFactory):
    prog = "benchmarks.standard.trajectory_replay"
    description = (
        "Trajectory replay regression benchmark. Replays a curated set of "
        "eliza_native_v1 trajectories against a candidate endpoint, scoring "
        "native action sequence + local final-state similarity."
    )

    def augment_parser(self, parser: argparse.ArgumentParser) -> None:
        parser.add_argument(
            "--traj-set",
            required=True,
            help=(
                "Directory containing trajectory JSON files (e.g. "
                "~/.eliza/trajectories or a curated regression set)."
            ),
        )
        parser.add_argument(
            "--baseline",
            required=True,
            help="Baseline model id whose recorded outputs are the ground truth.",
        )
        parser.add_argument(
            "--reward-threshold",
            type=float,
            default=DEFAULT_REWARD_THRESHOLD,
            help=(
                "Pass threshold for the per-stage final-state similarity in [0,1]. "
                "Stages below this don't count toward final-state credit. "
                "Default: 0.5."
            ),
        )
        parser.add_argument(
            "--exact-action-sequence",
            dest="exact_action_sequence",
            action="store_true",
            default=True,
            help="Require exact ordered match of tool-call names (default).",
        )
        parser.add_argument(
            "--no-exact-action-sequence",
            dest="exact_action_sequence",
            action="store_false",
            help="Allow unordered set-match instead of ordered sequence match.",
        )
        parser.add_argument(
            "--action-weight",
            type=float,
            default=DEFAULT_ACTION_WEIGHT,
            help="Weight on action-sequence match in stage score (default 0.5).",
        )
        parser.add_argument(
            "--final-state-weight",
            type=float,
            default=DEFAULT_FINAL_STATE_WEIGHT,
            help="Weight on final-state reward in stage score (default 0.5).",
        )
        parser.add_argument(
            "--max-tokens",
            type=int,
            default=DEFAULT_MAX_TOKENS,
            help="Cap on tokens per stage replay (default 768).",
        )

    def build(
        self,
        args: argparse.Namespace,
    ) -> tuple[TrajectoryReplayRunner, Sequence[str] | None]:
        traj_set = _expand_traj_set(args.traj_set)
        mock_responses: Sequence[str] | None = None
        trajectories: list[ReplayTrajectory] | None = None
        final_state_scorer: FinalStateScorer | None = None

        if args.mock:
            # In mock mode we synthesize a fixture trajectory and feed
            # the canonical baseline response back to the candidate.
            # This keeps the CLI runnable without a populated
            # trajectory directory or training-tree checkout.
            scratch = traj_set
            scratch.mkdir(parents=True, exist_ok=True)
            write_smoke_fixture(scratch)
            trajectories = load_trajectories(scratch, limit=None)
            mock_responses = [
                SMOKE_TRAJECTORY["stages"][0]["model"]["response"]  # type: ignore[index]
            ]

            def _mock_final_state_scorer(expected: str, response: str) -> float:
                # In smoke mode we score on exact string equality with
                # the baseline.
                return 1.0 if response.strip() == str(expected).strip() else 0.0

            final_state_scorer = _mock_final_state_scorer

        runner = TrajectoryReplayRunner(
            traj_set=traj_set,
            baseline=args.baseline,
            reward_threshold=args.reward_threshold,
            exact_action_sequence=args.exact_action_sequence,
            action_weight=args.action_weight,
            final_state_weight=args.final_state_weight,
            max_tokens=args.max_tokens,
            trajectories=trajectories,
            final_state_scorer=final_state_scorer,
        )
        return runner, mock_responses


def main() -> int:
    cli_dispatch(_TrajectoryReplayFactory(), output_filename=RESULT_FILENAME)
    return 0  # unreachable


if __name__ == "__main__":
    main()
