"""Set secret action.

Allows setting a secret through a natural-language interface.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from elizaos.types import Action, ActionResult, Content

from ..types import SecretContext, SecretLevel

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State

    from ..service import SecretsService


@dataclass
class SetSecretAction:
    name: str = "SET_SECRET"
    similes: list[str] = field(
        default_factory=lambda: ["STORE_SECRET", "SAVE_SECRET", "ADD_API_KEY"]
    )
    description: str = "Set or update a secret value at the global, world, or user level"

    async def validate(
        self, runtime: IAgentRuntime, message: Memory, _state: State | None = None
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
        secrets_svc: SecretsService | None = None
        for svc in (runtime.services or {}).values():
            if getattr(svc, "service_type", None) == "secrets":
                secrets_svc = svc  # type: ignore[assignment]
                break

        if secrets_svc is None:
            return ActionResult(text="Secrets service is not available.", success=False)

        # Extract key=value from message text
        text = (message.content.text if message.content else "").strip()
        if "=" not in text:
            msg = "Please provide the secret in KEY=VALUE format."
            if callback:
                await callback(Content(text=msg, actions=["SET_SECRET"]))
            return ActionResult(text=msg, success=False)

        key, _, value = text.partition("=")
        key = key.strip().upper()
        value = value.strip()

        if not key or not value:
            msg = "Both key and value must be non-empty."
            if callback:
                await callback(Content(text=msg, actions=["SET_SECRET"]))
            return ActionResult(text=msg, success=False)

        context = SecretContext(
            level=SecretLevel.GLOBAL,
            agent_id=str(runtime.agent_id),
        )
        success = await secrets_svc.set(key, value, context)

        if success:
            result_text = f"Secret '{key}' has been set successfully."
        else:
            result_text = f"Failed to set secret '{key}'."

        if callback:
            await callback(Content(text=result_text, actions=["SET_SECRET"]))

        return ActionResult(
            text=result_text,
            values={"success": success, "key": key},
            data={"actionName": "SET_SECRET", "key": key},
            success=success,
        )

    @property
    def examples(self) -> list:
        return []


_inst = SetSecretAction()

set_secret_action = Action(
    name=_inst.name,
    similes=_inst.similes,
    description=_inst.description,
    validate=_inst.validate,
    handler=_inst.handler,
    examples=_inst.examples,
)
