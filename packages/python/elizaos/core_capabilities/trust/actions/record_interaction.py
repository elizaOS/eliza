"""Record trust interaction action.

Allows the agent to record a trust interaction (positive or negative evidence)
for an entity.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from elizaos.types import Action, ActionResult, Content

from ..types import TrustEvidenceType, TrustInteraction

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State

    from ..service import TrustEngineService


@dataclass
class RecordInteractionAction:
    """Record a trust interaction for an entity."""

    name: str = "RECORD_TRUST_INTERACTION"
    similes: list[str] = field(
        default_factory=lambda: ["LOG_TRUST", "TRUST_EVENT", "ADD_TRUST_EVIDENCE"]
    )
    description: str = "Record a trust interaction (positive or negative evidence) for an entity"

    async def validate(
        self,
        runtime: IAgentRuntime,
        message: Memory,
        _state: State | None = None,
    ) -> bool:
        return True

    async def handler(
        self,
        runtime: IAgentRuntime,
        message: Memory,
        state: State | None = None,
        options: HandlerOptions | None = None,
        callback: HandlerCallback | None = None,
        responses: list[Memory] | None = None,
    ) -> ActionResult:
        entity_id = message.entity_id
        if entity_id is None:
            return ActionResult(
                text="Cannot record interaction: no entity specified.",
                success=False,
            )

        # Retrieve trust engine service
        trust_engine: TrustEngineService | None = None
        for svc in (runtime.services or {}).values():
            if getattr(svc, "service_type", None) == "trust_engine":
                trust_engine = svc  # type: ignore[assignment]
                break

        if trust_engine is None:
            return ActionResult(
                text="Trust engine service is not available.",
                success=False,
            )

        # Determine evidence type from message content
        text = (message.content.text if message.content else "").lower()
        evidence_type = TrustEvidenceType.HELPFUL_ACTION
        impact = 8.0

        # Simple heuristic to determine evidence type from message
        negative_keywords = {"broken", "harmful", "spam", "suspicious", "violation", "failed"}
        positive_keywords = {"helpful", "promise kept", "consistent", "verified", "contribution"}

        if any(kw in text for kw in negative_keywords):
            evidence_type = TrustEvidenceType.HARMFUL_ACTION
            impact = -15.0
        elif any(kw in text for kw in positive_keywords):
            evidence_type = TrustEvidenceType.HELPFUL_ACTION
            impact = 10.0

        interaction = TrustInteraction(
            source_entity_id=runtime.agent_id,
            target_entity_id=entity_id,
            type=evidence_type,
            timestamp=time.time(),
            impact=impact,
            details={"description": text, "message_id": str(message.id) if message.id else None},
        )

        await trust_engine.record_interaction(interaction)

        response_text = (
            f"Recorded {evidence_type.value} interaction for entity {entity_id} "
            f"with impact {impact:+.0f}"
        )

        if callback:
            await callback(Content(text=response_text, actions=["RECORD_TRUST_INTERACTION"]))

        return ActionResult(
            text=response_text,
            values={"success": True, "evidenceType": evidence_type.value, "impact": impact},
            data={"actionName": "RECORD_TRUST_INTERACTION", "entityId": str(entity_id)},
            success=True,
        )

    @property
    def examples(self) -> list:
        return []


_inst = RecordInteractionAction()

record_interaction_action = Action(
    name=_inst.name,
    similes=_inst.similes,
    description=_inst.description,
    validate=_inst.validate,
    handler=_inst.handler,
    examples=_inst.examples,
)
