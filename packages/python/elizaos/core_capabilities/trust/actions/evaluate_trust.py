"""Evaluate trust action.

Allows an agent to evaluate the trust profile of an entity by computing
multi-dimensional scores from historical evidence.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from elizaos.types import Action, ActionResult, Content

from ..types import TrustContext

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State

    from ..service import TrustEngineService


@dataclass
class EvaluateTrustAction:
    """Evaluate trust for an entity and return the trust profile."""

    name: str = "EVALUATE_TRUST"
    similes: list[str] = field(
        default_factory=lambda: ["CHECK_TRUST", "TRUST_SCORE", "GET_TRUST_PROFILE"]
    )
    description: str = "Evaluate the trust profile of an entity based on historical interactions"

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
                text="Cannot evaluate trust: no entity specified.",
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

        context = TrustContext(evaluator_id=runtime.agent_id)
        profile = await trust_engine.calculate_trust(entity_id, context)

        summary = (
            f"Trust Profile for entity {entity_id}:\n"
            f"  Overall Trust: {profile.overall_trust:.0f}/100\n"
            f"  Confidence: {profile.confidence:.2f}\n"
            f"  Interactions: {profile.interaction_count}\n"
            f"  Trend: {profile.trend.direction.value}\n"
            f"  Dimensions:\n"
            f"    Reliability:   {profile.dimensions.reliability:.0f}\n"
            f"    Competence:    {profile.dimensions.competence:.0f}\n"
            f"    Integrity:     {profile.dimensions.integrity:.0f}\n"
            f"    Benevolence:   {profile.dimensions.benevolence:.0f}\n"
            f"    Transparency:  {profile.dimensions.transparency:.0f}\n"
        )

        if callback:
            await callback(Content(text=summary, actions=["EVALUATE_TRUST"]))

        return ActionResult(
            text=summary,
            values={
                "success": True,
                "overallTrust": profile.overall_trust,
                "confidence": profile.confidence,
                "interactionCount": profile.interaction_count,
            },
            data={
                "actionName": "EVALUATE_TRUST",
                "entityId": str(entity_id),
                "overallTrust": profile.overall_trust,
                "dimensions": {
                    "reliability": profile.dimensions.reliability,
                    "competence": profile.dimensions.competence,
                    "integrity": profile.dimensions.integrity,
                    "benevolence": profile.dimensions.benevolence,
                    "transparency": profile.dimensions.transparency,
                },
            },
            success=True,
        )

    @property
    def examples(self) -> list:
        return []


_inst = EvaluateTrustAction()

evaluate_trust_action = Action(
    name=_inst.name,
    similes=_inst.similes,
    description=_inst.description,
    validate=_inst.validate,
    handler=_inst.handler,
    examples=_inst.examples,
)
