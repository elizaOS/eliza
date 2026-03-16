"""CANCEL_GOAL action for cancelling/deleting goals."""

from dataclasses import dataclass, field
from typing import Protocol

from elizaos_plugin_goals.types import (
    Goal,
    GoalFilters,
    GoalOwnerType,
)


class RuntimeProtocol(Protocol):
    """Protocol for agent runtime."""

    agent_id: str

    async def use_model(self, model_type: str, params: dict[str, object]) -> str:
        """Use an LLM model."""
        ...


class GoalServiceProtocol(Protocol):
    """Protocol for goal service."""

    async def get_goals(self, filters: GoalFilters | None = None) -> list[Goal]:
        """Get goals with filters."""
        ...

    async def delete_goal(self, goal_id: str) -> bool:
        """Delete a goal."""
        ...


@dataclass
class ActionResult:
    """Result of an action execution."""

    success: bool
    text: str | None = None
    error: str | None = None
    data: dict[str, object] = field(default_factory=dict)


@dataclass
class ActionExample:
    """Example of action usage."""

    name: str
    content: dict[str, object]


class CancelGoalAction:
    """Action to cancel/delete a goal.

    This action uses LLM to match user intent with existing goals
    and removes the appropriate goal.
    """

    name = "CANCEL_GOAL"
    similes = ["DELETE_GOAL", "REMOVE_GOAL", "DROP_GOAL", "STOP_TRACKING"]
    description = "Cancels and removes a goal from tracking."

    examples: list[list[ActionExample]] = [
        [
            ActionExample(
                name="Alice",
                content={
                    "text": "Cancel my goal to learn guitar",
                    "source": "user",
                },
            ),
            ActionExample(
                name="Agent",
                content={
                    "text": 'Cancelled goal: "Learn guitar"',
                    "actions": ["CANCEL_GOAL"],
                },
            ),
        ],
        [
            ActionExample(
                name="Bob",
                content={
                    "text": "I don't want to track my reading goal anymore",
                    "source": "user",
                },
            ),
            ActionExample(
                name="Agent",
                content={
                    "text": 'Cancelled goal: "Read 20 books this year"',
                    "actions": ["CANCEL_GOAL"],
                },
            ),
        ],
    ]

    @staticmethod
    def wants_cancel(text: str) -> bool:
        """Check if user wants to cancel a goal based on message text."""
        lower = text.lower()
        return (
            "cancel" in lower
            or "delete" in lower
            or "remove" in lower
            or "stop tracking" in lower
            or ("don't" in lower and "want" in lower)
        )

    async def validate(
        self,
        runtime: RuntimeProtocol,
        message: dict[str, object],
        state: dict[str, object] | None = None,
    ) -> bool:
        """Validate if the action can run.

        Args:
            runtime: The agent runtime
            message: The incoming message
            state: Current state

        Returns:
            True if the action can run
        """
        room_id = message.get("roomId")
        if not room_id:
            return False

        # Check for cancel intent keywords
        content = message.get("content", {})
        text = str(content.get("text", "") if isinstance(content, dict) else "")

        return self.wants_cancel(text)

    async def handler(
        self,
        runtime: RuntimeProtocol,
        message: dict[str, object],
        state: dict[str, object] | None,
        goal_service: GoalServiceProtocol,
    ) -> ActionResult:
        """Handle the CANCEL_GOAL action.

        Args:
            runtime: The agent runtime
            message: The incoming message
            state: Current state
            goal_service: The goal data service

        Returns:
            Action result
        """
        try:
            room_id = message.get("roomId")
            if not room_id:
                return ActionResult(
                    success=False,
                    text="No room context available",
                    error="No room context available",
                )

            # Determine owner context
            entity_id = str(message.get("entityId", ""))
            is_entity_message = entity_id and entity_id != runtime.agent_id
            owner_type = GoalOwnerType.ENTITY if is_entity_message else GoalOwnerType.AGENT
            owner_id = entity_id if is_entity_message else runtime.agent_id
            owner_text = "Your" if is_entity_message else "Agent"

            # Get active goals
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
                    text=f"{owner_text} don't have any active goals to cancel.",
                )

            # Get message text
            content = message.get("content", {})
            message_text = str(content.get("text", "") if isinstance(content, dict) else "")

            # Use LLM to find the best matching goal
            goals_list = "\n".join(
                f"{idx + 1}. {goal.name}" for idx, goal in enumerate(active_goals)
            )
            match_prompt = f"""Given this cancellation request: "{message_text}"

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
                    text=f"I couldn't determine which goal you want to cancel. {owner_text} active goals:\n\n{goals_text}\n\nPlease be more specific.",
                )

            goal = active_goals[match_index]

            # Delete the goal
            await goal_service.delete_goal(goal.id)

            return ActionResult(
                success=True,
                text=f'Cancelled goal: "{goal.name}"',
                data={"goal_id": goal.id, "goal_name": goal.name},
            )

        except Exception as e:
            return ActionResult(
                success=False,
                text=f"Error: {e!s}",
                error=str(e),
            )
