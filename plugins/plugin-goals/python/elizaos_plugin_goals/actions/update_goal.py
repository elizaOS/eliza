"""UPDATE_GOAL action for updating existing goals."""

from dataclasses import dataclass, field
from typing import Protocol

from elizaos_plugin_goals.types import (
    Goal,
    GoalFilters,
    GoalOwnerType,
    UpdateGoalParams,
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

    async def update_goal(self, goal_id: str, updates: UpdateGoalParams) -> bool:
        """Update a goal."""
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


class UpdateGoalAction:
    """Action to update an existing goal.

    This action uses LLM to match user intent with existing goals
    and updates the appropriate goal's name or description.
    """

    name = "UPDATE_GOAL"
    similes = ["EDIT_GOAL", "MODIFY_GOAL", "CHANGE_GOAL", "RENAME_GOAL"]
    description = "Updates an existing goal's name or description."

    examples: list[list[ActionExample]] = [
        [
            ActionExample(
                name="Alice",
                content={
                    "text": "Rename my reading goal to 'Read 30 books this year'",
                    "source": "user",
                },
            ),
            ActionExample(
                name="Agent",
                content={
                    "text": 'Updated goal: "Read 30 books this year"',
                    "actions": ["UPDATE_GOAL"],
                },
            ),
        ],
        [
            ActionExample(
                name="Bob",
                content={
                    "text": "Change my exercise goal description to include swimming",
                    "source": "user",
                },
            ),
            ActionExample(
                name="Agent",
                content={
                    "text": "Updated goal description.",
                    "actions": ["UPDATE_GOAL"],
                },
            ),
        ],
    ]

    @staticmethod
    def wants_update(text: str) -> bool:
        """Check if user wants to update a goal based on message text."""
        lower = text.lower()
        return (
            "update" in lower
            or "edit" in lower
            or "modify" in lower
            or "change" in lower
            or "rename" in lower
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

        # Check for update intent keywords
        content = message.get("content", {})
        text = str(content.get("text", "") if isinstance(content, dict) else "")

        return self.wants_update(text)

    async def handler(
        self,
        runtime: RuntimeProtocol,
        message: dict[str, object],
        state: dict[str, object] | None,
        goal_service: GoalServiceProtocol,
    ) -> ActionResult:
        """Handle the UPDATE_GOAL action.

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
                    text=f"{owner_text} don't have any active goals to update.",
                )

            # Get message text
            content = message.get("content", {})
            message_text = str(content.get("text", "") if isinstance(content, dict) else "")

            # Use LLM to find the best matching goal and extract updates
            goals_list = "\n".join(
                f"{idx + 1}. {goal.name}" for idx, goal in enumerate(active_goals)
            )
            extraction_prompt = f"""Given this update request: "{message_text}"

Which of these active goals is being updated? And what should the new name/description be?

{goals_list}

Return in format:
GOAL_NUMBER: <number or 0 if none match>
NEW_NAME: <new name or "none" if not changing>
NEW_DESCRIPTION: <new description or "none" if not changing>"""

            extraction_result = await runtime.use_model(
                "TEXT_REASONING_SMALL",
                {"prompt": extraction_prompt, "temperature": 0.1},
            )

            # Parse extraction result
            lines = extraction_result.strip().split("\n")
            goal_number = 0
            new_name: str | None = None
            new_description: str | None = None

            for line in lines:
                if line.startswith("GOAL_NUMBER:"):
                    try:
                        goal_number = int(line.split(":")[1].strip())
                    except ValueError:
                        goal_number = 0
                elif line.startswith("NEW_NAME:"):
                    value = line.split(":", 1)[1].strip()
                    if value.lower() != "none":
                        new_name = value
                elif line.startswith("NEW_DESCRIPTION:"):
                    value = line.split(":", 1)[1].strip()
                    if value.lower() != "none":
                        new_description = value

            match_index = goal_number - 1
            if match_index < 0 or match_index >= len(active_goals):
                goals_text = "\n".join(f"- {g.name}" for g in active_goals)
                return ActionResult(
                    success=True,
                    text=f"I couldn't determine which goal you want to update. {owner_text} active goals:\n\n{goals_text}\n\nPlease be more specific.",
                )

            if not new_name and not new_description:
                return ActionResult(
                    success=True,
                    text="I couldn't determine what you want to change. Please specify a new name or description.",
                )

            goal = active_goals[match_index]

            # Update the goal
            updates = UpdateGoalParams(
                name=new_name,
                description=new_description,
            )
            await goal_service.update_goal(goal.id, updates)

            update_text = []
            if new_name:
                update_text.append(f'name to "{new_name}"')
            if new_description:
                update_text.append("description")

            return ActionResult(
                success=True,
                text=f"Updated goal {', '.join(update_text)}.",
                data={
                    "goal_id": goal.id,
                    "old_name": goal.name,
                    "new_name": new_name,
                    "new_description": new_description,
                },
            )

        except Exception as e:
            return ActionResult(
                success=False,
                text=f"Error: {e!s}",
                error=str(e),
            )
