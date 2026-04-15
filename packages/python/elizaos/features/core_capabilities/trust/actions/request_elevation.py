"""Request elevation action.

Allows an entity to request temporary elevation of permissions for a
specific action, evaluated against their trust profile.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from elizaos.types import Action, ActionResult, Content

from ..types import TrustContext, TrustRequirements

if TYPE_CHECKING:
    from elizaos.types import UUID, HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State

    from ..service import TrustEngineService


def _try_parse_json(text: str) -> dict[str, Any] | None:
    """Attempt to parse JSON from text, returning None on failure."""
    try:
        obj = json.loads(text)
        if isinstance(obj, dict):
            return obj
    except (json.JSONDecodeError, TypeError):
        pass
    return None


@dataclass
class RequestElevationAction:
    """Request temporary elevation of permissions for a specific action."""

    name: str = "REQUEST_ELEVATION"
    similes: list[str] = field(
        default_factory=lambda: [
            "REQUEST_ELEVATED_PERMISSIONS",
            "NEED_TEMPORARY_ACCESS",
            "REQUEST_HIGHER_PRIVILEGES",
            "NEED_ADMIN_PERMISSION",
            "ELEVATE_PERMISSIONS",
            "GRANT_ACCESS",
            "TEMPORARY_PERMISSION_REQUEST",
        ]
    )
    description: str = "Request temporary elevation of permissions for a specific action"

    async def validate(
        self,
        runtime: IAgentRuntime,
        message: Memory,
        _state: State | None = None,
    ) -> bool:
        """Validate that the message mentions elevation/permission keywords."""
        text = (message.content.text if message.content else "").lower()
        elevation_keywords = {
            "request",
            "elevation",
            "elevate",
            "permission",
            "privilege",
            "access",
            "grant",
            "temporary",
        }
        return any(kw in text for kw in elevation_keywords)

    async def handler(
        self,
        runtime: IAgentRuntime,
        message: Memory,
        state: State | None = None,
        options: HandlerOptions | None = None,
        callback: HandlerCallback | None = None,
        responses: list[Memory] | None = None,
    ) -> ActionResult:
        entity_id: UUID | None = message.entity_id
        if entity_id is None:
            return ActionResult(
                text="Cannot process elevation request: no entity specified.",
                success=False,
            )

        # Retrieve trust engine service
        service = runtime.get_service("trust_engine")
        trust_engine = service if isinstance(service, TrustEngineService) else None

        if trust_engine is None:
            return ActionResult(
                text="Trust engine service is not available. Cannot evaluate elevation request.",
                success=False,
            )

        # Parse the request from message content
        text = message.content.text if message.content else ""
        request_data = _try_parse_json(text)

        requested_action = (request_data or {}).get("action", "")
        requested_resource = (request_data or {}).get("resource", "*")
        (request_data or {}).get("justification", text)
        duration_minutes = int((request_data or {}).get("duration", 60))

        if not requested_action:
            hint = (
                "Please specify the action you need elevated permissions for. "
                'Example: "I need to manage roles to help moderate the channel"'
            )
            if callback:
                await callback(Content(text=hint, actions=["REQUEST_ELEVATION"]))
            return ActionResult(text=hint, success=False)

        # Evaluate trust for the requesting entity
        context = TrustContext(
            evaluator_id=runtime.agent_id,
            room_id=message.room_id if hasattr(message, "room_id") else None,
        )
        profile = await trust_engine.calculate_trust(entity_id, context)

        # Determine minimum trust required for the requested action
        action_trust_thresholds: dict[str, float] = {
            "manage_roles": 70.0,
            "manage_channels": 65.0,
            "moderate_content": 60.0,
            "manage_settings": 75.0,
            "view_audit_log": 50.0,
        }
        default_threshold = 60.0
        required_trust = action_trust_thresholds.get(requested_action.lower(), default_threshold)

        requirements = TrustRequirements(
            minimum_trust=required_trust,
            minimum_interactions=3,
            minimum_confidence=0.2,
        )
        decision = await trust_engine.evaluate_trust_decision(entity_id, requirements, context)

        if decision.allowed:
            expiry_minutes = duration_minutes
            expiry_text = f"{expiry_minutes} minutes"
            response_text = (
                f"Elevation approved! You have been granted temporary "
                f"{requested_action} permissions for {expiry_text}.\n\n"
                f"Please use these permissions responsibly. "
                f"All actions will be logged for audit."
            )

            if callback:
                await callback(Content(text=response_text, actions=["REQUEST_ELEVATION"]))

            return ActionResult(
                text=response_text,
                values={
                    "success": True,
                    "approved": True,
                    "action": requested_action,
                    "resource": requested_resource,
                    "durationMinutes": expiry_minutes,
                },
                data={
                    "actionName": "REQUEST_ELEVATION",
                    "entityId": str(entity_id),
                    "approved": True,
                    "expiresAt": time.time() + expiry_minutes * 60,
                    "trustScore": profile.overall_trust,
                },
                success=True,
            )
        else:
            denial_parts = [f"Elevation request denied: {decision.reason}"]
            denial_parts.append(f"\nYour current trust score is {profile.overall_trust:.0f}/100.")
            if decision.suggestions:
                suggestions_text = "\n".join(f"- {s}" for s in decision.suggestions)
                denial_parts.append(f"\nSuggestions:\n{suggestions_text}")

            denial_text = "\n".join(denial_parts)

            if callback:
                await callback(Content(text=denial_text, actions=["REQUEST_ELEVATION"]))

            return ActionResult(
                text=denial_text,
                values={
                    "success": False,
                    "approved": False,
                    "currentTrust": profile.overall_trust,
                    "requiredTrust": required_trust,
                },
                data={
                    "actionName": "REQUEST_ELEVATION",
                    "entityId": str(entity_id),
                    "approved": False,
                    "reason": decision.reason,
                    "trustScore": profile.overall_trust,
                },
                success=False,
            )

    @property
    def examples(self) -> list:
        return []


_inst = RequestElevationAction()

request_elevation_action = Action(
    name=_inst.name,
    similes=_inst.similes,
    description=_inst.description,
    validate=_inst.validate,
    handler=_inst.handler,
    examples=_inst.examples,
)
