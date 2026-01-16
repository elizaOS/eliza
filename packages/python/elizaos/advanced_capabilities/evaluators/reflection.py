from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.bootstrap.types import EvaluatorResult
from elizaos.bootstrap.utils.xml import parse_key_value_xml
from elizaos.generated.spec_helpers import require_evaluator_spec
from elizaos.prompts import REFLECTION_TEMPLATE
from elizaos.types import Evaluator, ModelType

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State

# Get text content from centralized specs
_spec = require_evaluator_spec("REFLECTION")


async def evaluate_reflection(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> EvaluatorResult:
    if state is None:
        return EvaluatorResult(
            score=50,
            passed=True,
            reason="No state for reflection",
            details={},
        )

    recent_interactions: list[str] = []
    room_id = message.room_id

    if room_id:
        recent_messages = await runtime.get_memories(
            room_id=room_id,
            limit=10,
            order_by="created_at",
            order_direction="desc",
        )

        for msg in recent_messages:
            if msg.content and msg.content.text:
                sender = "Unknown"
                if msg.entity_id:
                    if str(msg.entity_id) == str(runtime.agent_id):
                        sender = runtime.character.name
                    else:
                        entity = await runtime.get_entity(msg.entity_id)
                        if entity and entity.name:
                            sender = entity.name
                recent_interactions.append(f"{sender}: {msg.content.text}")

    if not recent_interactions:
        return EvaluatorResult(
            score=50,
            passed=True,
            reason="No recent interactions to reflect on",
            details={"noInteractions": True},
        )

    interactions_text = "\n".join(recent_interactions)

    template = (
        runtime.character.templates.get("reflectionTemplate")
        if runtime.character.templates and "reflectionTemplate" in runtime.character.templates
        else REFLECTION_TEMPLATE
    )
    prompt = runtime.compose_prompt(state=state, template=template)
    prompt = prompt.replace("{{recentInteractions}}", interactions_text)

    response_text = await runtime.use_model(ModelType.TEXT_LARGE, prompt=prompt)
    parsed_xml = parse_key_value_xml(response_text)

    if parsed_xml is None:
        raise ValueError("Failed to parse reflection response")

    quality_str = str(parsed_xml.get("quality_score", "50"))
    quality_score = max(0, min(100, int(quality_str)))

    thought = str(parsed_xml.get("thought", ""))
    strengths = str(parsed_xml.get("strengths", ""))
    improvements = str(parsed_xml.get("improvements", ""))
    learnings = str(parsed_xml.get("learnings", ""))

    passed = quality_score >= 50

    return EvaluatorResult(
        score=quality_score,
        passed=passed,
        reason=f"Strengths: {strengths}\nImprovements: {improvements}",
        details={
            "thought": thought,
            "strengths": strengths,
            "improvements": improvements,
            "learnings": learnings,
            "interactionCount": len(recent_interactions),
        },
    )


async def validate_reflection(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | None = None,
) -> bool:
    return True


reflection_evaluator = Evaluator(
    name=_spec["name"],
    description=_spec["description"],
    similes=_spec.get("similes", []),
    validate=validate_reflection,
    handler=evaluate_reflection,
    always_run=_spec.get("alwaysRun", False),
    examples=_spec.get("examples", []),
)
