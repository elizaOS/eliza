from dataclasses import dataclass, field
from datetime import datetime
from typing import Protocol

from elizaos_plugin_goals.types import (
    Goal,
    GoalFilters,
    GoalOwnerType,
    UpdateGoalParams,
)


class RuntimeProtocol(Protocol):
    agent_id: str

    async def use_model(self, model_type: str, params: dict[str, object]) -> str: ...


class GoalServiceProtocol(Protocol):
    async def get_goals(self, filters: GoalFilters | None = None) -> list[Goal]: ...

    async def update_goal(self, goal_id: str, updates: UpdateGoalParams) -> bool: ...


@dataclass
class ActionResult:
    success: bool
    text: str | None = None
    error: str | None = None
    data: dict[str, object] = field(default_factory=dict)


@dataclass
class ActionExample:
    name: str
    content: dict[str, object]


class CompleteGoalAction:
    name = "COMPLETE_GOAL"
    similes = ["ACHIEVE_GOAL", "FINISH_GOAL", "CHECK_OFF_GOAL", "ACCOMPLISH_GOAL"]
    description = "Marks a goal as completed/achieved."

    examples: list[list[ActionExample]] = [
        [
            ActionExample(
                name="Alice",
                content={
                    "text": "I've completed my goal of learning French fluently!",
                    "source": "user",
                },
            ),
            ActionExample(
                name="Agent",
                content={
                    "text": '🎉 Congratulations! User goal achieved: "Learn French fluently"!',
                    "actions": ["COMPLETE_GOAL"],
                },
            ),
        ],
        [
            ActionExample(
                name="Bob",
                content={
                    "text": "I finally achieved my marathon goal!",
                    "source": "user",
                },
            ),
            ActionExample(
                name="Agent",
                content={
                    "text": '🎉 Congratulations! User goal achieved: "Run a marathon"!',
                    "actions": ["COMPLETE_GOAL"],
                },
            ),
        ],
    ]

    async def validate(
        self,
        runtime: RuntimeProtocol,
        message: dict[str, object],
        state: dict[str, object] | None = None,
    ) -> bool:
        room_id = message.get("roomId")
        if not room_id:
            return False

        # Check for completion intent keywords
        content = message.get("content", {})
        text = str(content.get("text", "") if isinstance(content, dict) else "").lower()

        completion_keywords = ["complete", "achieve", "finish", "done", "accomplished"]
        return any(keyword in text for keyword in completion_keywords)

    async def handler(
        self,
        runtime: RuntimeProtocol,
        message: dict[str, object],
        state: dict[str, object] | None,
        goal_service: GoalServiceProtocol,
    ) -> ActionResult:
        try:
            room_id = message.get("roomId")
            if not room_id:
                return ActionResult(
                    success=False,
                    text="No room context available",
                    error="No room context available",
                )

            entity_id = str(message.get("entityId", ""))
            is_entity_message = entity_id and entity_id != runtime.agent_id
            owner_type = GoalOwnerType.ENTITY if is_entity_message else GoalOwnerType.AGENT
            owner_id = entity_id if is_entity_message else runtime.agent_id
            owner_text = "User" if is_entity_message else "Agent"

            active_goals = await goal_service.get_goals(
                GoalFilters(
                    owner_type=owner_type,
                    owner_id=owner_id,
                    is_completed=False,
                )
            )

            if not active_goals:
                return ActionResult(
                    success=True,
                    text=f"{owner_text} don't have any active goals to complete.",
                )

            content = message.get("content", {})
            message_text = str(content.get("text", "") if isinstance(content, dict) else "")

            goals_list = "\n".join(
                f"{idx + 1}. {goal.name}" for idx, goal in enumerate(active_goals)
            )
            match_prompt = f"""Given this completion request: "{message_text}"

Which of these active goals best matches the request? Return only the number.

{goals_list}

If none match well, return 0."""

            match_result = await runtime.use_model(
                "TEXT_REASONING_SMALL",
                {"prompt": match_prompt, "temperature": 0.1},
            )

            try:
                match_index = int(match_result.strip()) - 1
            except ValueError:
                match_index = -1

            if match_index < 0 or match_index >= len(active_goals):
                goals_text = "\n".join(f"- {g.name}" for g in active_goals)
                return ActionResult(
                    success=True,
                    text=f"I couldn't determine which goal you want to complete. {owner_text} have these active goals:\n\n{goals_text}\n\nPlease be more specific.",
                )

            goal = active_goals[match_index]

            await goal_service.update_goal(
                goal.id,
                UpdateGoalParams(
                    is_completed=True,
                    completed_at=datetime.now(),
                    metadata={
                        **(goal.metadata or {}),
                        "completedBy": entity_id,
                    },
                ),
            )

            return ActionResult(
                success=True,
                text=f'🎉 Congratulations! {owner_text} goal achieved: "{goal.name}"!',
                data={"goal_id": goal.id, "goal_name": goal.name},
            )

        except Exception as e:
            return ActionResult(
                success=False,
                text=f"Error: {e!s}",
                error=str(e),
            )
