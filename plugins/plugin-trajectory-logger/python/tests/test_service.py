from __future__ import annotations

import time
import uuid

from elizaos_plugin_trajectory_logger.service import TrajectoryLoggerService
from elizaos_plugin_trajectory_logger.types import ActionAttempt, EnvironmentState, LLMCall


def test_service_records_trajectory() -> None:
    svc = TrajectoryLoggerService()
    agent_id = str(uuid.uuid4())
    trajectory_id = svc.start_trajectory(agent_id)

    step_id = svc.start_step(
        trajectory_id,
        EnvironmentState(
            timestamp=int(time.time() * 1000),
            agent_balance=0.0,
            agent_points=0.0,
            agent_pnl=0.0,
            open_positions=0,
        ),
    )

    svc.log_llm_call(
        step_id,
        LLMCall(
            call_id=str(uuid.uuid4()),
            timestamp=int(time.time() * 1000),
            model="test-model",
            system_prompt="sys",
            user_prompt="user",
            response="assistant",
            temperature=0.7,
            max_tokens=32,
            purpose="action",
        ),
    )

    svc.complete_step(
        trajectory_id,
        step_id,
        action=ActionAttempt(
            attempt_id=str(uuid.uuid4()),
            timestamp=int(time.time() * 1000),
            action_type="TEST",
            action_name="TEST",
            parameters={},
            success=True,
        ),
        reward=0.1,
    )

    assert svc.get_current_step_id(trajectory_id) is None
