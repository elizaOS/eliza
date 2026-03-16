from __future__ import annotations

import uuid

from elizaos_plugin_trajectory_logger.art_format import (
    extract_shared_prefix,
    group_trajectories,
    prepare_for_ruler,
    to_art_messages,
    to_art_trajectory,
    validate_art_compatibility,
)
from elizaos_plugin_trajectory_logger.types import (
    ActionAttempt,
    ARTTrajectory,
    EnvironmentState,
    LLMCall,
    Trajectory,
    TrajectoryStep,
)


def _make_trajectory(
    *, scenario_id: str | None = None, response: str = "I will hold."
) -> Trajectory:
    now = 1_700_000_000_000
    step_id = str(uuid.uuid4())
    trajectory_id = str(uuid.uuid4())
    agent_id = str(uuid.uuid4())

    step = TrajectoryStep(
        step_id=step_id,
        step_number=0,
        timestamp=now,
        environment_state=EnvironmentState(
            timestamp=now,
            agent_balance=100.0,
            agent_points=0.0,
            agent_pnl=0.0,
            open_positions=0,
        ),
        llm_calls=[
            LLMCall(
                call_id=str(uuid.uuid4()),
                timestamp=now,
                model="test-model",
                system_prompt="You are a trading agent.",
                user_prompt="BTC at 50%. Trade?",
                response=response,
                temperature=0.7,
                max_tokens=512,
                purpose="action",
            )
        ],
        provider_accesses=[],
        action=ActionAttempt(
            attempt_id=str(uuid.uuid4()),
            timestamp=now,
            action_type="HOLD",
            action_name="HOLD",
            parameters={},
            success=True,
        ),
        reward=0.5,
        done=True,
    )

    return Trajectory(
        trajectory_id=trajectory_id,
        agent_id=agent_id,
        start_time=now,
        end_time=now,
        duration_ms=0,
        scenario_id=scenario_id,
        steps=[step],
        total_reward=0.5,
        metadata={},
    )


def test_to_art_messages() -> None:
    t = _make_trajectory()
    messages = to_art_messages(t)

    assert messages[0].role == "system"
    assert messages[1].role == "user"
    assert messages[2].role == "assistant"


def test_to_art_trajectory() -> None:
    t = _make_trajectory()
    art: ARTTrajectory = to_art_trajectory(t)
    assert art.reward == 0.5
    assert art.metadata["trajectoryId"] == t.trajectory_id


def test_grouping_and_ruler_prep() -> None:
    t1 = _make_trajectory(scenario_id="s1", response="A")
    t2 = _make_trajectory(scenario_id="s1", response="B")
    t3 = _make_trajectory(scenario_id="s2", response="C")

    groups = group_trajectories([t1, t2, t3])
    assert len(groups) == 2

    s1 = next(g for g in groups if g.scenario_id == "s1")
    prefix = extract_shared_prefix([t1, t2])
    assert len(prefix) > 0

    ruler = prepare_for_ruler(s1)
    assert len(ruler.shared_prefix) > 0
    assert len(ruler.suffixes) == 2


def test_validate_art_compatibility() -> None:
    t = _make_trajectory()
    valid, errors, warnings = validate_art_compatibility(t)
    assert valid is True
    assert errors == []
    assert isinstance(warnings, list)
