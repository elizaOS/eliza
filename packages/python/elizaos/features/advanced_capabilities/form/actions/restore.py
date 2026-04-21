"""Form Restore Action -- restores a stashed form session.

This is an Action (not Evaluator) because restore needs to happen
BEFORE the provider runs, so the agent has the restored form context
for its immediate response.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import Action, ActionExample, ActionResult, Content

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State


async def _validate(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | None = None,
) -> bool:
    """Validate: check if user wants to restore a stashed form."""
    text = (message.content.text or "").lower()
    restore_keywords = [
        "restore",
        "resume",
        "continue",
        "pick up where",
        "get back to",
        "my form",
        "unfinished form",
    ]
    if not any(kw in text for kw in restore_keywords):
        return False

    # Check if user has stashed sessions
    try:
        from ..service import FormService

        form_service = runtime.get_service("FORM")
        if not isinstance(form_service, FormService):
            return False
        stashed = await form_service.get_stashed_sessions(str(message.entity_id))
        return len(stashed) > 0
    except Exception:
        return False


async def _handler(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: HandlerCallback | None = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    """Restore the most recent stashed form session."""
    from ..service import FormService

    form_service = runtime.get_service("FORM")
    if not isinstance(form_service, FormService):
        return ActionResult(
            text="Form service is not available.",
            success=False,
            values={"error": "service_unavailable"},
        )

    entity_id = str(message.entity_id)

    # Check for active session conflict
    if message.room_id:
        active = await form_service.get_active_session(entity_id, str(message.room_id))
        if active:
            if callback:
                await callback(
                    Content(
                        text="You already have an active form in this room. "
                        "Please complete or stash it before restoring another.",
                    )
                )
            return ActionResult(
                text="Active form conflict",
                success=False,
                values={"error": "active_form_conflict"},
            )

    # Get stashed sessions
    stashed = await form_service.get_stashed_sessions(entity_id)
    if not stashed:
        if callback:
            await callback(Content(text="You don't have any stashed forms to restore."))
        return ActionResult(
            text="No stashed forms",
            success=False,
            values={"error": "no_stashed_forms"},
        )

    # Restore the most recent stashed session
    session = stashed[0]
    restored = await form_service.restore(session.id, entity_id)

    # Build summary
    context = form_service.get_session_context(restored)
    filled_count = len(context.filled_fields)
    missing_count = len(context.missing_required)

    summary = (
        f"I've restored your '{context.form_name or restored.form_id}' form. "
        f"Progress: {context.progress:.0f}% ({filled_count} fields filled, "
        f"{missing_count} still needed)."
    )

    if context.next_field:
        summary += f" Next, I need your {context.next_field.label}."

    if callback:
        await callback(Content(text=summary, actions=["FORM_RESTORE"]))

    return ActionResult(
        text=summary,
        values={
            "success": True,
            "sessionId": restored.id,
            "formId": restored.form_id,
            "progress": context.progress,
        },
        data={
            "actionName": "FORM_RESTORE",
            "restoredSessionId": restored.id,
        },
        success=True,
    )


form_restore_action = Action(
    name="FORM_RESTORE",
    similes=["RESUME_FORM", "CONTINUE_FORM", "RESTORE_FORM"],
    description="Restores a previously stashed form session so the user can continue filling it out",
    validate=_validate,
    handler=_handler,
    examples=[
        [
            ActionExample(
                name="{{user}}",
                content=Content(text="Resume my form"),
            ),
            ActionExample(
                name="{{agent}}",
                content=Content(
                    text="I've restored your registration form. Progress: 60%. Next, I need your email.",
                    actions=["FORM_RESTORE"],
                ),
            ),
        ],
    ],
)
