"""Security evaluator.

Runs after each message to detect potential security threats such as
prompt injection, social engineering, and anomalous requests.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import Evaluator, EvaluatorResult, HandlerOptions

from ..types import SecurityContext, SecurityEvent, SecurityEventType

if TYPE_CHECKING:
    from elizaos.types import ActionResult, IAgentRuntime, Memory, State

    from ..service import SecurityModuleService


async def _validate(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> bool:
    return True


async def _handler(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    responses: list[Memory] | None = None,
    action_results: list[ActionResult] | None = None,
) -> EvaluatorResult:
    """Check the latest message for security threats."""
    security_module: SecurityModuleService | None = None
    for svc in (runtime.services or {}).values():
        if getattr(svc, "service_type", None) == "security_module":
            security_module = svc  # type: ignore[assignment]
            break

    if security_module is None:
        return EvaluatorResult.pass_result(
            score=100, reason="Security module not available, skipping check"
        )

    content_text = message.content.text if message.content else ""
    if not content_text:
        return EvaluatorResult.pass_result(score=100, reason="Empty message")

    context = SecurityContext(
        entity_id=message.entity_id,
        room_id=message.room_id,
    )

    check = await security_module.detect_prompt_injection(content_text, context)

    if check.detected:
        # Log the security event
        if message.entity_id:
            event = SecurityEvent(
                type=SecurityEventType.PROMPT_INJECTION_ATTEMPT,
                entity_id=message.entity_id,
                severity=check.severity,
                context=context,
                details={
                    "confidence": check.confidence,
                    "details": check.details or "",
                },
            )
            await security_module.log_security_event(event)

        score = max(0, int((1 - check.confidence) * 100))
        return EvaluatorResult.fail_result(
            score=score,
            reason=f"Security threat detected: {check.type.value} "
            f"(severity={check.severity.value}, confidence={check.confidence:.2f})",
        )

    return EvaluatorResult.pass_result(score=100, reason="No security threats detected")


security_evaluator = Evaluator(
    name="SECURITY",
    description="Evaluates messages for security threats including prompt injection and social engineering",
    handler=_handler,
    validate=_validate,
    always_run=True,
)
