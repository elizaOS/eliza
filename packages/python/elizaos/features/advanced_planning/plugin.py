from __future__ import annotations

from elizaos.types import Plugin

from .actions import (
    analyze_input_action,
    create_plan_action,
    execute_final_action,
    process_analysis_action,
)
from .message_classifier import message_classifier_provider
from .planning_service import PlanningService


def create_advanced_planning_plugin() -> Plugin:
    async def init_plugin(_config, runtime) -> None:
        runtime.logger.info(
            "Advanced planning enabled",
            src="plugin:advanced-planning",
            agentId=str(runtime.agent_id),
        )

    return Plugin(
        name="advanced-planning",
        description="Built-in advanced planning and execution capabilities",
        init=init_plugin,
        config={},
        services=[PlanningService],
        actions=[
            analyze_input_action,
            process_analysis_action,
            execute_final_action,
            create_plan_action,
        ],
        providers=[message_classifier_provider],
        evaluators=[],
    )


advanced_planning_plugin = create_advanced_planning_plugin()
