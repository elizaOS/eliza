"""Secrets status provider.

Injects a summary of the agent's secret configuration into the context
so the agent knows which secrets are available and which are missing.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import Provider, ProviderResult

from ..types import SecretContext, SecretLevel

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State

    from ..service import SecretsService


async def get_secrets_status(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    """Provide summary of available secrets configuration."""
    secrets_svc: SecretsService | None = None
    for svc in (runtime.services or {}).values():
        if getattr(svc, "service_type", None) == "secrets":
            secrets_svc = svc  # type: ignore[assignment]
            break

    if secrets_svc is None:
        return ProviderResult(text="", values={"secretsAvailable": False}, data={})

    context = SecretContext(level=SecretLevel.GLOBAL, agent_id=str(runtime.agent_id))
    metadata = await secrets_svc.list(context)

    total = len(metadata)
    valid_count = sum(
        1
        for cfg in metadata.values()
        if (cfg.status.value if hasattr(cfg.status, "value") else cfg.status) == "valid"
    )
    missing_count = sum(
        1
        for cfg in metadata.values()
        if (cfg.status.value if hasattr(cfg.status, "value") else cfg.status) == "missing"
    )

    if total == 0:
        text = "# Secrets Status\nNo secrets configured."
    else:
        text = (
            f"# Secrets Status\n"
            f"Total: {total}, Valid: {valid_count}, Missing: {missing_count}\n"
            f"Keys: {', '.join(sorted(metadata.keys()))}"
        )

    return ProviderResult(
        text=text,
        values={
            "secretsAvailable": True,
            "totalSecrets": total,
            "validSecrets": valid_count,
            "missingSecrets": missing_count,
        },
        data={
            "keys": list(metadata.keys()),
        },
    )


secrets_status_provider = Provider(
    name="SECRETS_STATUS",
    description="Summary of the agent's secret configuration and availability",
    get=get_secrets_status,
    dynamic=True,
)
