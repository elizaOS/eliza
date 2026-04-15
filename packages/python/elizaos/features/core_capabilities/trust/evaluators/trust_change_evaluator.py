"""Trust change evaluator.

Monitors trust profile changes after interactions and logs significant
trust movements for the agent to be aware of.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import Evaluator, EvaluatorResult, HandlerOptions

from ..types import TrustContext

if TYPE_CHECKING:
    from elizaos.types import ActionResult, IAgentRuntime, Memory, State

    from ..service import TrustEngineService


async def _validate(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> bool:
    return message.entity_id is not None


async def _handler(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    responses: list[Memory] | None = None,
    action_results: list[ActionResult] | None = None,
) -> EvaluatorResult:
    """Evaluate trust changes for the message sender."""
    entity_id = message.entity_id
    if entity_id is None:
        return EvaluatorResult.pass_result(score=50, reason="No entity to evaluate")

    service = runtime.get_service("trust_engine")
    trust_engine = service if isinstance(service, TrustEngineService) else None

    if trust_engine is None:
        return EvaluatorResult.pass_result(score=50, reason="Trust engine not available")

    context = TrustContext(evaluator_id=runtime.agent_id)
    profile = await trust_engine.calculate_trust(entity_id, context)

    # Check for significant trust changes
    if profile.trend.direction.value == "decreasing" and profile.trend.change_rate < -2:
        return EvaluatorResult(
            score=max(0, int(profile.overall_trust)),
            passed=profile.overall_trust >= 30,
            reason=(
                f"Trust declining rapidly: "
                f"rate={profile.trend.change_rate:.1f} points/day, "
                f"current={profile.overall_trust:.0f}"
            ),
            details={
                "entityId": str(entity_id),
                "overallTrust": profile.overall_trust,
                "trendDirection": profile.trend.direction.value,
                "changeRate": profile.trend.change_rate,
            },
        )

    if profile.overall_trust < 20 and profile.interaction_count > 3:
        return EvaluatorResult.fail_result(
            score=int(profile.overall_trust),
            reason=f"Very low trust score: {profile.overall_trust:.0f}/100 "
            f"after {profile.interaction_count} interactions",
        )

    return EvaluatorResult.pass_result(
        score=int(min(100, profile.overall_trust)),
        reason=f"Trust stable at {profile.overall_trust:.0f}/100 ({profile.trend.direction.value})",
    )


trust_change_evaluator = Evaluator(
    name="TRUST_CHANGE",
    description="Monitors trust profile changes and flags significant trust movements",
    handler=_handler,
    validate=_validate,
)
