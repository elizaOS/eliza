"""Form context provider for agent awareness.

Injects form state into the agent's context BEFORE response generation
so the agent knows about active forms, missing fields, and what to do next.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State


async def _get_form_context(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    """Build form context for the agent prompt."""
    try:
        from ..service import FormService

        form_service = runtime.get_service("FORM")
        if not isinstance(form_service, FormService):
            return ProviderResult(text="", values={}, data={})

        entity_id = str(message.entity_id)
        room_id = str(message.room_id) if message.room_id else ""

        if not entity_id or not room_id:
            return ProviderResult(text="", values={}, data={})

        session = await form_service.get_active_session(entity_id, room_id)

        if not session:
            # Check for stashed sessions
            stashed = await form_service.get_stashed_sessions(entity_id)
            if stashed:
                text = (
                    f"\n[STASHED FORMS]\n"
                    f"User has {len(stashed)} saved form(s). "
                    f"They can say 'resume' to continue.\n"
                    f"[/STASHED FORMS]"
                )
                return ProviderResult(
                    text=text,
                    values={"stashedFormCount": len(stashed)},
                    data={"stashedCount": len(stashed)},
                )
            return ProviderResult(text="", values={}, data={})

        # Build context from active session
        ctx = form_service.get_session_context(session)

        lines: list[str] = []
        lines.append(f"\n[ACTIVE FORM: {ctx.form_name or ctx.form_id}]")
        lines.append(f"Progress: {ctx.progress:.0f}%")
        lines.append(f"Status: {ctx.status}")

        # Required fields: have
        if ctx.filled_fields:
            lines.append("\nRequired fields collected:")
            for filled_field in ctx.filled_fields:
                lines.append(f"  - {filled_field.label}: {filled_field.display_value}")

        # Required fields: don't have
        if ctx.missing_required:
            lines.append("\nRequired fields still needed:")
            for missing_field in ctx.missing_required:
                prompt = missing_field.ask_prompt or f"Ask for their {missing_field.label}"
                lines.append(f"  - {missing_field.label}: {prompt}")

        # Uncertain fields
        if ctx.uncertain_fields:
            lines.append("\nFields needing confirmation:")
            for uncertain_field in ctx.uncertain_fields:
                lines.append(
                    f"  - {uncertain_field.label}: '{uncertain_field.value}' (confidence: {uncertain_field.confidence:.0%})"
                )

        # Pending external fields
        if ctx.pending_external_fields:
            lines.append("\nPending external actions:")
            for pending_field in ctx.pending_external_fields:
                lines.append(f"  - {pending_field.label}: {pending_field.instructions}")

        # Instruction
        if ctx.pending_cancel_confirmation:
            lines.append("\nInstruction: Confirm cancel -- user has invested effort.")
        elif ctx.uncertain_fields:
            uf = ctx.uncertain_fields[0]
            lines.append(f"\nInstruction: Confirm '{uf.label}' value with the user.")
        elif ctx.missing_required:
            nf = ctx.missing_required[0]
            lines.append(f"\nInstruction: Ask for {nf.label}.")
        elif ctx.status == "ready":
            lines.append("\nInstruction: All required fields collected. Confirm and submit.")

        lines.append("[/ACTIVE FORM]")

        text = "\n".join(lines)

        return ProviderResult(
            text=text,
            values={
                "formContext": text,
                "formProgress": f"{ctx.progress:.0f}%",
                "hasActiveForm": ctx.has_active_form,
            },
            data={
                "formContext": {
                    "hasActiveForm": ctx.has_active_form,
                    "formId": ctx.form_id,
                    "formName": ctx.form_name,
                    "progress": ctx.progress,
                    "status": ctx.status,
                    "filledCount": len(ctx.filled_fields),
                    "missingCount": len(ctx.missing_required),
                    "uncertainCount": len(ctx.uncertain_fields),
                },
            },
        )
    except Exception:
        return ProviderResult(text="", values={}, data={})


form_context_provider = Provider(
    name="FORM_CONTEXT",
    description="Injects active form state into the agent's context for guided conversations",
    get=_get_form_context,
    dynamic=True,
)
