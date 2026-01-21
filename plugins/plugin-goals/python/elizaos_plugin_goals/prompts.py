# Import generated prompts (fallback to empty strings if not available)
CHECK_SIMILARITY_TEMPLATE: str
EXTRACT_GOAL_TEMPLATE: str
EXTRACT_CANCELLATION_TEMPLATE: str
EXTRACT_CONFIRMATION_TEMPLATE: str
EXTRACT_GOAL_SELECTION_TEMPLATE: str
EXTRACT_GOAL_UPDATE_TEMPLATE: str

try:
    from elizaos_plugin_goals._generated_prompts import (  # type: ignore[import-not-found]
        CHECK_SIMILARITY_TEMPLATE as _CHECK_SIMILARITY_TEMPLATE,
    )
    from elizaos_plugin_goals._generated_prompts import (
        EXTRACT_CANCELLATION_TEMPLATE as _EXTRACT_CANCELLATION_TEMPLATE,
    )
    from elizaos_plugin_goals._generated_prompts import (
        EXTRACT_CONFIRMATION_TEMPLATE as _EXTRACT_CONFIRMATION_TEMPLATE,
    )
    from elizaos_plugin_goals._generated_prompts import (
        EXTRACT_GOAL_SELECTION_TEMPLATE as _EXTRACT_GOAL_SELECTION_TEMPLATE,
    )
    from elizaos_plugin_goals._generated_prompts import (
        EXTRACT_GOAL_TEMPLATE as _EXTRACT_GOAL_TEMPLATE,
    )
    from elizaos_plugin_goals._generated_prompts import (
        EXTRACT_GOAL_UPDATE_TEMPLATE as _EXTRACT_GOAL_UPDATE_TEMPLATE,
    )

    CHECK_SIMILARITY_TEMPLATE = _CHECK_SIMILARITY_TEMPLATE
    EXTRACT_GOAL_TEMPLATE = _EXTRACT_GOAL_TEMPLATE
    EXTRACT_CANCELLATION_TEMPLATE = _EXTRACT_CANCELLATION_TEMPLATE
    EXTRACT_CONFIRMATION_TEMPLATE = _EXTRACT_CONFIRMATION_TEMPLATE
    EXTRACT_GOAL_SELECTION_TEMPLATE = _EXTRACT_GOAL_SELECTION_TEMPLATE
    EXTRACT_GOAL_UPDATE_TEMPLATE = _EXTRACT_GOAL_UPDATE_TEMPLATE
except ImportError as err:
    # Generated prompts not available - this should not happen in production
    # Prompts should be generated via build:prompts script
    raise ImportError(
        "Generated prompts not found. Run 'npm run build:prompts' to generate prompts."
    ) from err


def build_check_similarity_prompt(
    new_goal_name: str,
    new_goal_description: str | None,
    existing_goals: list[dict[str, str]],
) -> str:
    """Build the check similarity prompt with provided values.

    Args:
        new_goal_name: Name of the new goal
        new_goal_description: Description of the new goal
        existing_goals: List of existing goals with name and description

    Returns:
        Formatted prompt string
    """
    goals_text = "\n".join(
        f"- {goal['name']}: {goal.get('description', 'No description')}" for goal in existing_goals
    )

    return (
        CHECK_SIMILARITY_TEMPLATE.replace("{{newGoalName}}", new_goal_name)
        .replace("{{newGoalDescription}}", new_goal_description or "No description")
        .replace("{{existingGoals}}", goals_text)
    )


def build_extract_goal_prompt(text: str, message_history: str) -> str:
    return EXTRACT_GOAL_TEMPLATE.replace("{{text}}", text).replace(
        "{{messageHistory}}", message_history
    )


def build_extract_cancellation_prompt(text: str, message_history: str, available_tasks: str) -> str:
    return (
        EXTRACT_CANCELLATION_TEMPLATE.replace("{{text}}", text)
        .replace("{{messageHistory}}", message_history)
        .replace("{{availableTasks}}", available_tasks)
    )


def build_extract_confirmation_prompt(text: str, message_history: str, pending_task: str) -> str:
    return (
        EXTRACT_CONFIRMATION_TEMPLATE.replace("{{text}}", text)
        .replace("{{messageHistory}}", message_history)
        .replace("{{pendingTask}}", pending_task)
    )


def build_extract_goal_selection_prompt(text: str, available_goals: str) -> str:
    return EXTRACT_GOAL_SELECTION_TEMPLATE.replace("{{text}}", text).replace(
        "{{availableGoals}}", available_goals
    )


def build_extract_goal_update_prompt(text: str, goal_details: str) -> str:
    return EXTRACT_GOAL_UPDATE_TEMPLATE.replace("{{text}}", text).replace(
        "{{goalDetails}}", goal_details
    )


__all__ = [
    "CHECK_SIMILARITY_TEMPLATE",
    "EXTRACT_GOAL_TEMPLATE",
    "EXTRACT_CANCELLATION_TEMPLATE",
    "EXTRACT_CONFIRMATION_TEMPLATE",
    "EXTRACT_GOAL_SELECTION_TEMPLATE",
    "EXTRACT_GOAL_UPDATE_TEMPLATE",
    "build_check_similarity_prompt",
    "build_extract_goal_prompt",
    "build_extract_cancellation_prompt",
    "build_extract_confirmation_prompt",
    "build_extract_goal_selection_prompt",
    "build_extract_goal_update_prompt",
]
