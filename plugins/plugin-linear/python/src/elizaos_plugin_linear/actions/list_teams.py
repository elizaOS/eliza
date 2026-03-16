import json
import logging
import re
from typing import Any

from elizaos_plugin_linear.actions.base import (
    ActionExample,
    ActionResult,
    HandlerCallback,
    Memory,
    RuntimeProtocol,
    State,
    create_action,
)
from elizaos_plugin_linear.services.linear import LinearService

logger = logging.getLogger(__name__)

LIST_TEAMS_TEMPLATE = """Extract team filter criteria from the user's request.

User request: "{user_message}"

Return ONLY a JSON object:
{{
  "nameFilter": "Keywords to search in team names",
  "specificTeam": "Specific team name or key if looking for one team",
  "showAll": true/false (true if user explicitly asks for "all"),
  "includeDetails": true/false (true if user wants detailed info)
}}

Only include fields that are clearly mentioned."""


async def validate(
    runtime: RuntimeProtocol,
    _message: Memory,
    _state: State | None = None,
) -> bool:
    try:
        api_key = runtime.get_setting("LINEAR_API_KEY")
        return bool(api_key)
    except Exception:
        return False


async def handler(
    runtime: RuntimeProtocol,
    message: Memory,
    _state: State | None = None,
    options: dict[str, Any] | None = None,
    callback: HandlerCallback | None = None,
) -> ActionResult:
    try:
        linear_service: LinearService = runtime.get_service("linear")
        if not linear_service:
            raise RuntimeError("Linear service not available")

        content = message.get("content", {}).get("text", "")
        name_filter: str | None = None
        specific_team: str | None = None

        if content:
            prompt = LIST_TEAMS_TEMPLATE.format(user_message=content)
            response = await runtime.use_model("TEXT_LARGE", {"prompt": prompt})

            if response:
                try:
                    cleaned = re.sub(r"^```(?:json)?\n?", "", response)
                    cleaned = re.sub(r"\n?```$", "", cleaned).strip()
                    parsed = json.loads(cleaned)

                    name_filter = parsed.get("nameFilter")
                    specific_team = parsed.get("specificTeam")
                    parsed.get("includeDetails", False)

                except json.JSONDecodeError:
                    logger.warning("Failed to parse team filters")

        teams = await linear_service.get_teams()

        # Filter for specific team
        if specific_team:
            teams = [
                t
                for t in teams
                if t["key"].lower() == specific_team.lower()
                or t["name"].lower() == specific_team.lower()
            ]

        # Filter by name keywords
        if name_filter and not specific_team:
            keywords = name_filter.lower().split()
            teams = [
                t
                for t in teams
                if any(kw in f"{t['name']} {t.get('description', '')}".lower() for kw in keywords)
            ]

        if not teams:
            no_teams_msg = (
                f'No team found matching "{specific_team}".'
                if specific_team
                else f'No teams found matching "{name_filter}".'
                if name_filter
                else "No teams found in Linear."
            )
            if callback:
                await callback(
                    {"text": no_teams_msg, "source": message.get("content", {}).get("source")}
                )
            return {"text": no_teams_msg, "success": True, "data": {"teams": []}}

        team_list = []
        for i, team in enumerate(teams):
            info = f"{i + 1}. {team['name']} ({team['key']})"

            if team.get("description"):
                info += f"\n   {team['description']}"

            team_list.append(info)

        header_text = (
            "📋 Team Details:"
            if specific_team and len(teams) == 1
            else f'📋 Found {len(teams)} team{"s" if len(teams) != 1 else ""} matching "{name_filter}":'
            if name_filter
            else f"📋 Found {len(teams)} team{'s' if len(teams) != 1 else ''}:"
        )

        result_message = f"{header_text}\n\n" + "\n\n".join(team_list)
        if callback:
            await callback(
                {"text": result_message, "source": message.get("content", {}).get("source")}
            )

        return {
            "text": f"Found {len(teams)} team{'s' if len(teams) != 1 else ''}",
            "success": True,
            "data": {
                "teams": [
                    {
                        "id": t["id"],
                        "name": t["name"],
                        "key": t["key"],
                        "description": t.get("description"),
                    }
                    for t in teams
                ],
                "count": len(teams),
                "filters": {"name": name_filter, "specific": specific_team},
            },
        }

    except Exception as error:
        logger.error(f"Failed to list teams: {error}")
        error_message = f"❌ Failed to list teams: {error}"
        if callback:
            await callback(
                {"text": error_message, "source": message.get("content", {}).get("source")}
            )
        return {"text": error_message, "success": False}


list_teams_action = create_action(
    name="LIST_LINEAR_TEAMS",
    description="List teams in Linear with optional filters",
    similes=["list-linear-teams", "show-linear-teams", "get-linear-teams"],
    examples=[
        [
            ActionExample(name="User", content={"text": "Show me all teams"}),
            ActionExample(
                name="Assistant",
                content={
                    "text": "I'll list all the teams in Linear.",
                    "actions": ["LIST_LINEAR_TEAMS"],
                },
            ),
        ],
    ],
    validate=validate,
    handler=handler,
)
