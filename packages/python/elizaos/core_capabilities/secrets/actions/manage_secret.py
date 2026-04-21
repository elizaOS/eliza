"""Manage secret action.

Provides list, delete, and status operations on secrets through a
natural-language interface.
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
class ManageSecretAction:
    name: str = "MANAGE_SECRET"
    similes: list[str] = field(
        default_factory=lambda: ["DELETE_SECRET", "REMOVE_SECRET", "LIST_SECRETS", "SECRET_STATUS"]
    )
    description: str = "List, delete, or check the status of stored secrets"

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

        text = (message.content.text if message.content else "").strip().lower()
        context = SecretContext(level=SecretLevel.GLOBAL, agent_id=str(runtime.agent_id))

        # Determine operation
        if "delete" in text or "remove" in text:
            # Extract key to delete
            words = text.split()
            key = next(
                (w.upper() for w in words if w.upper() != w.lower() or "_" in w),
                None,
            )
            if not key:
                msg = "Please specify which secret to delete."
                if callback:
                    await callback(Content(text=msg, actions=["MANAGE_SECRET"]))
                return ActionResult(text=msg, success=False)

            key = key.upper()
            success = await secrets_svc.delete(key, context)
            msg = (
                f"Secret '{key}' deleted successfully." if success else f"Secret '{key}' not found."
            )
            if callback:
                await callback(Content(text=msg, actions=["MANAGE_SECRET"]))
            return ActionResult(text=msg, values={"success": success}, success=success)

        # Default: list secrets
        metadata = await secrets_svc.list(context)
        if not metadata:
            msg = "No secrets are currently stored."
        else:
            lines = ["# Stored Secrets"]
            for key, config in metadata.items():
                status = config.status.value if hasattr(config.status, "value") else config.status
                lines.append(f"- {key}: {status} (level={config.level.value})")
            msg = "\n".join(lines)

        if callback:
            await callback(Content(text=msg, actions=["MANAGE_SECRET"]))

        return ActionResult(
            text=msg,
            values={"success": True, "secretCount": len(metadata)},
            data={"actionName": "MANAGE_SECRET", "keys": list(metadata.keys())},
            success=True,
        )

    @property
    def examples(self) -> list:
        return []


_inst = ManageSecretAction()

manage_secret_action = Action(
    name=_inst.name,
    similes=_inst.similes,
    description=_inst.description,
    validate=_inst.validate,
    handler=_inst.handler,
    examples=_inst.examples,
)
