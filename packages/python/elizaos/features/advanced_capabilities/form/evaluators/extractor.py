"""Form evaluator for field extraction and intent handling.

The evaluator is the "brain" of the form plugin. It runs AFTER each user
message and:
1. Detects user intent (submit, cancel, undo, etc.)
2. Extracts field values from natural language
3. Updates session state accordingly
4. Triggers lifecycle transitions
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import ActionResult, Evaluator, ModelType
from elizaos.utils.xml import parse_key_value_xml

from ..intent import has_data_to_extract, is_lifecycle_intent, is_ux_intent, quick_intent_detect
from ..types import ExtractionResult, FormIntent, IntentResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State


async def _validate(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | None = None,
) -> bool:
    """Only run when there is an active form session."""
    try:
        from ..service import FormService

        form_service = runtime.get_service("FORM")
        if not isinstance(form_service, FormService):
            return False
        if not message.room_id or not message.entity_id:
            return False
        session = await form_service.get_active_session(
            str(message.entity_id), str(message.room_id)
        )
        return session is not None
    except Exception:
        return False


async def _llm_intent_and_extract(
    runtime: IAgentRuntime,
    message_text: str,
    field_descriptions: str,
) -> IntentResult:
    """Use LLM to detect intent and extract field values simultaneously."""
    prompt = f"""Analyze this message in the context of a form being filled:

Message: "{message_text}"

Available fields to extract:
{field_descriptions}

Determine:
1. The user's intent (fill_form, submit, stash, cancel, undo, skip, explain, example, progress, autofill, other)
2. Any field values mentioned in the message

Respond with XML:
<response>
<intent>fill_form</intent>
<extractions>
<field name="field_key" confidence="0.9">extracted value</field>
</extractions>
</response>"""

    result = await runtime.use_model(ModelType.TEXT_SMALL, prompt=prompt)
    parsed = parse_key_value_xml(str(result))

    intent: FormIntent = "other"
    extractions: list[ExtractionResult] = []

    if parsed:
        raw_intent = parsed.get("intent", "other")
        if isinstance(raw_intent, str) and raw_intent in (
            "fill_form",
            "submit",
            "stash",
            "cancel",
            "undo",
            "skip",
            "explain",
            "example",
            "progress",
            "autofill",
            "other",
        ):
            intent = raw_intent  # type: ignore[assignment]

        # Parse extractions from the response
        raw_extractions = parsed.get("extractions")
        if isinstance(raw_extractions, dict):
            for field_key, value in raw_extractions.items():
                if isinstance(value, dict):
                    extractions.append(
                        ExtractionResult(
                            field=field_key,
                            value=value.get("value", value),
                            confidence=float(value.get("confidence", 0.5)),
                        )
                    )

    return IntentResult(intent=intent, extractions=extractions)


async def _handler(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | None = None,
) -> ActionResult | None:
    """Process form intent and extract field values."""
    from ..service import FormService

    form_service = runtime.get_service("FORM")
    if not isinstance(form_service, FormService):
        return None

    entity_id = str(message.entity_id)
    room_id = str(message.room_id)
    session = await form_service.get_active_session(entity_id, room_id)
    if not session:
        return None

    message_text = message.content.text or ""
    if not message_text.strip():
        return None

    # Tier 1: Fast-path intent detection
    intent = quick_intent_detect(message_text)
    intent_result: IntentResult | None = None

    if intent and intent != "restore":
        # Fast path matched -- wrap in IntentResult
        intent_result = IntentResult(intent=intent)
    else:
        # Tier 2: LLM fallback
        definition = form_service.get_form(session.form_id)
        if definition:
            field_desc = "\n".join(
                f"- {c.key} ({c.type}): {c.description or c.label}"
                + (" [required]" if c.required else "")
                for c in definition.controls
            )
            intent_result = await _llm_intent_and_extract(runtime, message_text, field_desc)
        else:
            intent_result = IntentResult(intent="other")

    # Handle lifecycle intents
    if is_lifecycle_intent(intent_result.intent):
        if intent_result.intent == "submit":
            try:
                submission = await form_service.submit(session.id, entity_id)
                return ActionResult(
                    text=f"Form submitted (ID: {submission.id})",
                    success=True,
                    values={"submissionId": submission.id},
                )
            except Exception as e:
                return ActionResult(
                    text=f"Cannot submit: {e}",
                    success=False,
                )
        elif intent_result.intent == "stash":
            await form_service.stash(session.id, entity_id)
            return ActionResult(
                text="Form saved for later",
                success=True,
            )
        elif intent_result.intent == "cancel":
            cancelled = await form_service.cancel(session.id, entity_id)
            if not cancelled:
                return ActionResult(
                    text="Are you sure you want to cancel? You have progress that will be lost.",
                    success=True,
                    values={"pendingConfirmation": True},
                )
            return ActionResult(text="Form cancelled", success=True)

    # Handle UX intents
    if is_ux_intent(intent_result.intent):
        if intent_result.intent == "undo":
            result = await form_service.undo_last_change(session.id, entity_id)
            if result:
                return ActionResult(
                    text=f"Undone: {result['field']} restored",
                    success=True,
                )
            return ActionResult(text="Nothing to undo", success=True)

        if intent_result.intent == "skip":
            if session.last_asked_field:
                skipped = await form_service.skip_field(
                    session.id, entity_id, session.last_asked_field
                )
                if skipped:
                    return ActionResult(
                        text=f"Skipped {session.last_asked_field}",
                        success=True,
                    )
                return ActionResult(
                    text="Cannot skip a required field",
                    success=False,
                )

    # Handle data extraction
    if has_data_to_extract(intent_result.intent) and intent_result.extractions:
        for extraction in intent_result.extractions:
            # Check if this is a subfield
            if "." in extraction.field:
                parent, sub = extraction.field.split(".", 1)
                await form_service.update_sub_field(
                    session.id,
                    entity_id,
                    parent,
                    sub,
                    extraction.value,
                    extraction.confidence,
                    message_id=str(message.id) if message.id else None,
                )
            else:
                await form_service.update_field(
                    session.id,
                    entity_id,
                    extraction.field,
                    extraction.value,
                    extraction.confidence,
                    "extraction",
                    message_id=str(message.id) if message.id else None,
                )

    return None


form_evaluator = Evaluator(
    name="FORM_EXTRACTOR",
    description="Extracts field values from user messages and handles form intents",
    always_run=False,
    validate=_validate,
    handler=_handler,
    examples=[],
)
