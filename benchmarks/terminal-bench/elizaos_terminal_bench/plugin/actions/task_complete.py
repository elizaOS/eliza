"""TASK_COMPLETE action for signaling task completion in terminal benchmark."""

from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import (
    Action,
    ActionExample,
    ActionParameter,
    ActionParameterSchema,
    ActionResult,
    Content,
)

if TYPE_CHECKING:
    from elizaos.types import (
        HandlerCallback,
        HandlerOptions,
        IAgentRuntime,
        Memory,
        State,
    )


async def _validate_task_complete(
    runtime: IAgentRuntime, _message: Memory, _state: State | None = None
) -> bool:
    """Always valid - task completion is always possible."""
    _ = runtime
    return True


async def _handle_task_complete(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: HandlerCallback | None = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    """Signal that the current task is complete."""
    _ = message, state, responses

    # Get optional summary from parameters
    summary = ""
    if options and options.parameters:
        summary = str(options.parameters.get("summary", ""))

    # Set the task complete flag in runtime settings
    runtime.set_setting("TASK_COMPLETE_SIGNAL", True)
    if summary:
        runtime.set_setting("TASK_COMPLETE_SUMMARY", summary)

    response_content = Content(
        text=f"Task marked as complete.{' Summary: ' + summary if summary else ''}",
        actions=["TASK_COMPLETE"],
    )

    if callback:
        await callback(response_content)

    runtime.logger.info(f"Task completion signaled: {summary or 'No summary provided'}")

    return ActionResult(
        text="Task completion signaled",
        values={
            "taskComplete": True,
            "completionSummary": summary,
        },
        data={
            "actionName": "TASK_COMPLETE",
            "complete": True,
            "summary": summary,
        },
        success=True,
    )


task_complete_action = Action(
    name="TASK_COMPLETE",
    description=(
        "Signal that the current benchmark task has been completed. "
        "Use this action ONLY when you have finished all required steps "
        "and believe the task requirements have been met. "
        "Optionally provide a summary of what was accomplished."
    ),
    similes=["DONE", "FINISHED", "COMPLETE", "END_TASK"],
    validate=_validate_task_complete,
    handler=_handle_task_complete,
    parameters=[
        ActionParameter(
            name="summary",
            description="Optional summary of what was accomplished",
            required=False,
            schema=ActionParameterSchema(
                type="string",
                description="Brief description of completed work",
            ),
        ),
    ],
    examples=[
        [
            ActionExample(
                name="{{user}}",
                content=Content(text="The script is working correctly now"),
            ),
            ActionExample(
                name="{{agent}}",
                content=Content(
                    text="Task complete - script created and tested successfully.",
                    actions=["TASK_COMPLETE"],
                ),
            ),
        ],
    ],
)
