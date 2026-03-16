"""CONFIRM_GOAL action for confirming pending goal creation."""

from dataclasses import dataclass, field
from typing import Protocol, TypedDict

from elizaos_plugin_goals.types import (
    CreateGoalParams,
    GoalOwnerType,
)


class PendingGoalData(TypedDict, total=False):
    """Pending goal data stored in state."""

    name: str
    description: str | None
    task_type: str  # "daily" | "one-off" | "aspirational"
    priority: int | None
    urgent: bool | None
    due_date: str | None
    recurring: str | None  # "daily" | "weekly" | "monthly"
    tags: list[str] | None
    metadata: dict[str, object] | None


class RuntimeProtocol(Protocol):
    """Protocol for agent runtime."""

    agent_id: str

    async def use_model(self, model_type: str, params: dict[str, object]) -> str:
        """Use an LLM model."""
        ...


class GoalServiceProtocol(Protocol):
    """Protocol for goal service."""

    async def create_goal(self, params: CreateGoalParams) -> str | None:
        """Create a goal."""
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


class ConfirmGoalAction:
    """Action to confirm or cancel a pending goal creation.

    This action handles the confirmation step when a user is asked
    to confirm a goal before it's created.
    """

    name = "CONFIRM_GOAL"
    similes = ["CONFIRM_TASK", "APPROVE_GOAL", "APPROVE_TASK", "GOAL_CONFIRM"]
    description = "Confirms or cancels a pending goal creation after user review."

    examples: list[list[ActionExample]] = [
        [
            ActionExample(
                name="User",
                content={
                    "text": "Add a goal to finish my taxes by April 15",
                    "source": "user",
                },
            ),
            ActionExample(
                name="Agent",
                content={
                    "text": "I'll create a one-off goal: 'Finish taxes' with Priority 2, Due April 15.\n\nIs this correct?",
                    "actions": ["CREATE_GOAL_PREVIEW"],
                },
            ),
            ActionExample(
                name="User",
                content={
                    "text": "Yes, that looks good",
                    "source": "user",
                },
            ),
            ActionExample(
                name="Agent",
                content={
                    "text": "✅ Created task: 'Finish taxes' (Priority 2, Due: 4/15/2024)",
                    "actions": ["CONFIRM_GOAL_SUCCESS"],
                },
            ),
        ],
        [
            ActionExample(
                name="User",
                content={
                    "text": "I want to add a daily task to exercise",
                    "source": "user",
                },
            ),
            ActionExample(
                name="Agent",
                content={
                    "text": "I'll create a daily goal: 'Exercise'.\n\nIs this correct?",
                    "actions": ["CREATE_GOAL_PREVIEW"],
                },
            ),
            ActionExample(
                name="User",
                content={
                    "text": "Actually, nevermind",
                    "source": "user",
                },
            ),
            ActionExample(
                name="Agent",
                content={
                    "text": "Okay, I've cancelled the task creation. Let me know if you'd like to create a different task.",
                    "actions": ["CONFIRM_GOAL_CANCELLED"],
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
        """Validate if the action can run.

        This action is only valid if there's a pending goal in the state.

        Args:
            runtime: The agent runtime
            message: The incoming message
            state: Current state

        Returns:
            True if the action can run
        """
        if not state:
            return False

        data = state.get("data", {})
        pending_goal = data.get("pendingGoal") if isinstance(data, dict) else None
        return pending_goal is not None

    async def _extract_confirmation_intent(
        self,
        runtime: RuntimeProtocol,
        message_text: str,
        pending_goal: PendingGoalData,
    ) -> tuple[bool, bool, str | None]:
        """Extract confirmation intent from the user's message.

        Returns:
            Tuple of (is_confirmation, should_proceed, modifications)
        """
        pending_task_text = f"""
Name: {pending_goal.get("name", "")}
Type: {pending_goal.get("task_type", "")}
{f"Priority: {pending_goal.get('priority')}" if pending_goal.get("priority") else ""}
{f"Due Date: {pending_goal.get('due_date')}" if pending_goal.get("due_date") else ""}
"""

        prompt = f"""Given this pending task:
{pending_task_text}

And the user's response: "{message_text}"

Is this a confirmation response (yes/no/cancel)?
Should we proceed with creating the task?
Are there any modifications requested?

Return in format:
IS_CONFIRMATION: true/false
SHOULD_PROCEED: true/false
MODIFICATIONS: <any modifications or "none">"""

        result = await runtime.use_model(
            "TEXT_REASONING_SMALL",
            {"prompt": prompt, "temperature": 0.1},
        )

        # Parse result
        lines = result.strip().split("\n")
        is_confirmation = False
        should_proceed = False
        modifications: str | None = None

        for line in lines:
            if line.startswith("IS_CONFIRMATION:"):
                is_confirmation = "true" in line.lower()
            elif line.startswith("SHOULD_PROCEED:"):
                should_proceed = "true" in line.lower()
            elif line.startswith("MODIFICATIONS:"):
                value = line.split(":", 1)[1].strip()
                if value.lower() != "none":
                    modifications = value

        return is_confirmation, should_proceed, modifications

    async def handler(
        self,
        runtime: RuntimeProtocol,
        message: dict[str, object],
        state: dict[str, object] | None,
        goal_service: GoalServiceProtocol,
    ) -> ActionResult:
        """Handle the CONFIRM_GOAL action.

        Args:
            runtime: The agent runtime
            message: The incoming message
            state: Current state
            goal_service: The goal data service

        Returns:
            Action result
        """
        try:
            if not state:
                return ActionResult(
                    success=False,
                    text="Unable to process confirmation without state context.",
                    error="No state context",
                )

            data = state.get("data", {})
            pending_goal: PendingGoalData | None = (
                data.get("pendingGoal") if isinstance(data, dict) else None
            )

            if not pending_goal:
                return ActionResult(
                    success=False,
                    text="I don't have a pending task to confirm. Would you like to create a new task?",
                    error="No pending task",
                )

            room_id = message.get("roomId")
            entity_id = str(message.get("entityId", ""))

            if not room_id or not entity_id:
                return ActionResult(
                    success=False,
                    text="I cannot confirm a goal without a room and entity context.",
                    error="No room or entity context",
                )

            # Get message text
            content = message.get("content", {})
            message_text = str(content.get("text", "") if isinstance(content, dict) else "")

            # Extract confirmation intent
            (
                is_confirmation,
                should_proceed,
                modifications,
            ) = await self._extract_confirmation_intent(runtime, message_text, pending_goal)

            if not is_confirmation:
                goal_name = pending_goal.get("name", "")
                return ActionResult(
                    success=True,
                    text=f'I\'m still waiting for your confirmation on the task "{goal_name}". Would you like me to create it?',
                )

            if not should_proceed:
                # Clear pending goal from state
                if isinstance(data, dict):
                    data.pop("pendingGoal", None)
                return ActionResult(
                    success=True,
                    text="Okay, I've cancelled the task creation. Let me know if you'd like to create a different task.",
                )

            # User confirmed - create the task
            goal_name = pending_goal.get("name", "")
            task_type = pending_goal.get("task_type", "one-off")
            priority = pending_goal.get("priority")
            urgent = pending_goal.get("urgent")
            due_date = pending_goal.get("due_date")

            created_goal_id = await goal_service.create_goal(
                CreateGoalParams(
                    agent_id=runtime.agent_id,
                    owner_type=GoalOwnerType.ENTITY,
                    owner_id=entity_id,
                    name=goal_name,
                    description=pending_goal.get("description") or goal_name,
                    metadata={
                        **(pending_goal.get("metadata") or {}),
                        "taskType": task_type,
                        "priority": priority,
                        "urgent": urgent,
                        "dueDate": due_date,
                        "recurring": pending_goal.get("recurring"),
                    },
                    tags=pending_goal.get("tags") or [],
                )
            )

            if not created_goal_id:
                return ActionResult(
                    success=False,
                    text="Failed to create goal",
                    error="Failed to create goal",
                )

            # Clear pending goal from state
            if isinstance(data, dict):
                data.pop("pendingGoal", None)

            # Build success message
            if task_type == "daily":
                success_message = f'✅ Created daily task: "{goal_name}".'
            elif task_type == "one-off":
                priority_text = f"Priority {priority or 3}"
                urgent_text = ", Urgent" if urgent else ""
                due_date_text = f", Due: {due_date}" if due_date else ""
                success_message = (
                    f'✅ Created task: "{goal_name}" ({priority_text}{urgent_text}{due_date_text})'
                )
            else:
                success_message = f'✅ Created aspirational goal: "{goal_name}"'

            if modifications:
                success_message += f'\n\nI created the task as originally described. The modifications you mentioned ("{modifications}") weren\'t applied. You can use UPDATE_GOAL to make changes.'

            return ActionResult(
                success=True,
                text=success_message,
                data={"goal_id": created_goal_id, "goal_name": goal_name},
            )

        except Exception as e:
            return ActionResult(
                success=False,
                text=f"Error: {e!s}",
                error=str(e),
            )
