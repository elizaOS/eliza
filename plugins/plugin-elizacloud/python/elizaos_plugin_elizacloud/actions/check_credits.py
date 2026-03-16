"""
CHECK_CLOUD_CREDITS — Query ElizaCloud credit balance and usage.
"""

from __future__ import annotations

import logging

from elizaos_plugin_elizacloud.actions.provision_agent import ActionResult, ServiceRegistry

logger = logging.getLogger("elizacloud.actions.credits")

DAILY_COST_PER_CONTAINER = 0.67


check_cloud_credits_action: dict[str, object] = {
    "name": "CHECK_CLOUD_CREDITS",
    "description": "Check ElizaCloud credit balance, container costs, and estimated remaining runtime.",
    "similes": ["check credits", "check balance", "how much credit", "cloud billing"],
    "tags": ["cloud", "billing"],
    "parameters": [
        {
            "name": "detailed",
            "description": "Include transaction history",
            "required": False,
            "schema": {"type": "boolean"},
        },
    ],
}


async def validate_check_credits(registry: ServiceRegistry) -> bool:
    return registry.auth is not None and registry.auth.is_authenticated()


async def handle_check_credits(
    registry: ServiceRegistry,
    message_text: str = "",
    message_metadata: dict[str, object] | None = None,
    options: dict[str, object] | None = None,
) -> ActionResult:
    """Handle the CHECK_CLOUD_CREDITS action."""
    auth = registry.auth
    container_svc = registry.containers

    if not auth or not auth.is_authenticated():
        return ActionResult(success=False, error="Not authenticated")

    client = auth.get_client()

    detailed = (options or {}).get("detailed") is True or (
        (message_metadata or {}).get("detailed") is True
    )

    resp = await client.get("/credits/balance")
    raw_data = resp.get("data", {})
    if not isinstance(raw_data, dict):
        raw_data = {}
    balance = float(raw_data.get("balance", 0))

    running_containers = 0
    if container_svc:
        running_containers = len(
            [c for c in container_svc.get_tracked_containers() if c.status == "running"]
        )
    daily_cost = running_containers * DAILY_COST_PER_CONTAINER
    days_remaining = balance / daily_cost if daily_cost > 0 else None

    lines = [
        f"ElizaCloud credits: ${balance:.2f}",
        (
            f"Active containers: {running_containers} (${daily_cost:.2f}/day) — "
            f"~{days_remaining:.1f} days remaining"
            if running_containers > 0
            else "No active containers."
        ),
    ]

    if detailed:
        summary_resp = await client.get("/credits/summary")
        summary_data = summary_resp.get("data", {})
        if not isinstance(summary_data, dict):
            summary_data = {}

        total_spent = float(summary_data.get("totalSpent", 0))
        total_added = float(summary_data.get("totalAdded", 0))
        lines.append(f"Total spent: ${total_spent:.2f} | Total added: ${total_added:.2f}")

        recent_txns = summary_data.get("recentTransactions", [])
        if isinstance(recent_txns, list):
            for tx in recent_txns[:10]:
                if isinstance(tx, dict):
                    amount = float(tx.get("amount", 0))
                    sign = "+" if amount >= 0 else ""
                    desc = tx.get("description", "")
                    date = str(tx.get("created_at", ""))[:10]
                    lines.append(f"  {sign}${amount:.2f} — {desc} ({date})")

    text = "\n".join(lines)

    return ActionResult(
        success=True,
        text=text,
        data={
            "balance": balance,
            "runningContainers": running_containers,
            "dailyCost": daily_cost,
            "estimatedDaysRemaining": days_remaining,
        },
    )
