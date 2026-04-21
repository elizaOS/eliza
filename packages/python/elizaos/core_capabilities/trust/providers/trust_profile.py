"""Trust profile provider.

Injects trust profile information about the message sender into the
agent context so the agent can reason about entity trustworthiness.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import Provider, ProviderResult

from ..types import TrustContext

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State

    from ..service import TrustEngineService


async def get_trust_profile(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    """Provide trust profile for the message sender."""
    entity_id = message.entity_id
    if entity_id is None:
        return ProviderResult(text="", values={"hasTrustProfile": False}, data={})

    # Find trust engine service
    trust_engine: TrustEngineService | None = None
    for svc in (runtime.services or {}).values():
        if getattr(svc, "service_type", None) == "trust_engine":
            trust_engine = svc  # type: ignore[assignment]
            break

    if trust_engine is None:
        return ProviderResult(text="", values={"hasTrustProfile": False}, data={})

    context = TrustContext(evaluator_id=runtime.agent_id)
    profile = await trust_engine.calculate_trust(entity_id, context)

    text = (
        f"# Trust Profile\n"
        f"Entity: {entity_id}\n"
        f"Overall Trust: {profile.overall_trust:.0f}/100 "
        f"(confidence: {profile.confidence:.2f})\n"
        f"Trend: {profile.trend.direction.value}\n"
        f"Dimensions: "
        f"reliability={profile.dimensions.reliability:.0f}, "
        f"competence={profile.dimensions.competence:.0f}, "
        f"integrity={profile.dimensions.integrity:.0f}, "
        f"benevolence={profile.dimensions.benevolence:.0f}, "
        f"transparency={profile.dimensions.transparency:.0f}"
    )

    return ProviderResult(
        text=text,
        values={
            "hasTrustProfile": True,
            "overallTrust": profile.overall_trust,
            "confidence": profile.confidence,
            "interactionCount": profile.interaction_count,
            "trend": profile.trend.direction.value,
        },
        data={
            "entityId": str(entity_id),
            "dimensions": {
                "reliability": profile.dimensions.reliability,
                "competence": profile.dimensions.competence,
                "integrity": profile.dimensions.integrity,
                "benevolence": profile.dimensions.benevolence,
                "transparency": profile.dimensions.transparency,
            },
        },
    )


trust_profile_provider = Provider(
    name="TRUST_PROFILE",
    description="Trust profile for the message sender based on historical interactions",
    get=get_trust_profile,
    dynamic=True,
)
