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

LIST_PROJECTS_TEMPLATE = """Extract project filter criteria from the user's request.

User request: "{user_message}"

Return ONLY a JSON object:
{{
  "teamFilter": "Team name or key if mentioned",
  "stateFilter": "active/planned/completed/all",
  "showAll": true/false (true if user explicitly asks for "all")
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
        team_id: str | None = None
        show_all = False
        state_filter: str | None = None

        if content:
            prompt = LIST_PROJECTS_TEMPLATE.format(user_message=content)
            response = await runtime.use_model("TEXT_LARGE", {"prompt": prompt})

            if response:
                try:
                    cleaned = re.sub(r"^```(?:json)?\n?", "", response)
                    cleaned = re.sub(r"\n?```$", "", cleaned).strip()
                    parsed = json.loads(cleaned)

                    if parsed.get("teamFilter"):
                        teams = await linear_service.get_teams()
                        team = next(
                            (
                                t
                                for t in teams
                                if t["key"].lower() == parsed["teamFilter"].lower()
                                or t["name"].lower() == parsed["teamFilter"].lower()
                            ),
                            None,
                        )
                        if team:
                            team_id = team["id"]
                            logger.info(
                                f"Filtering projects by team: {team['name']} ({team['key']})"
                            )

                    show_all = parsed.get("showAll", False)
                    state_filter = parsed.get("stateFilter")

                except json.JSONDecodeError:
                    logger.warning("Failed to parse project filters")

                    team_match = re.search(
                        r"(?:for|in|of)\s+(?:the\s+)?(\w+)\s+team", content, re.IGNORECASE
                    )
                    if team_match:
                        teams = await linear_service.get_teams()
                        team = next(
                            (
                                t
                                for t in teams
                                if t["key"].lower() == team_match.group(1).lower()
                                or t["name"].lower() == team_match.group(1).lower()
                            ),
                            None,
                        )
                        if team:
                            team_id = team["id"]

                    show_all = "all" in content.lower() and "project" in content.lower()

        if not team_id and not show_all:
            default_team_key = runtime.get_setting("LINEAR_DEFAULT_TEAM_KEY")
            if default_team_key:
                teams = await linear_service.get_teams()
                default_team = next(
                    (t for t in teams if t["key"].lower() == default_team_key.lower()), None
                )
                if default_team:
                    team_id = default_team["id"]
                    logger.info(
                        f"Applying default team filter for projects: {default_team['name']}"
                    )

        projects = await linear_service.get_projects(team_id)

        if state_filter and state_filter != "all":
            filtered = []
            for project in projects:
                state = (project.get("state") or "").lower()
                if state_filter == "active":
                    if state in ("started", "in progress") or not state:
                        filtered.append(project)
                elif state_filter == "planned":
                    if state in ("planned", "backlog"):
                        filtered.append(project)
                elif state_filter == "completed":
                    if state in ("completed", "done", "canceled"):
                        filtered.append(project)
            projects = filtered

        if not projects:
            no_projects_msg = (
                "No projects found for the specified team."
                if team_id
                else "No projects found in Linear."
            )
            if callback:
                await callback(
                    {"text": no_projects_msg, "source": message.get("content", {}).get("source")}
                )
            return {"text": no_projects_msg, "success": True, "data": {"projects": []}}

        project_list = []
        for i, project in enumerate(projects):
            teams_data = project.get("teams", {}).get("nodes", [])
            team_names = ", ".join(t["name"] for t in teams_data) or "No teams"
            status = project.get("state") or "Active"
            progress = (
                f" ({round(project['progress'] * 100)}% complete)"
                if project.get("progress")
                else ""
            )
            lead = project.get("lead")
            lead_text = f" | Lead: {lead['name']}" if lead else ""

            dates = []
            if project.get("startDate"):
                dates.append(f"Start: {project['startDate'][:10]}")
            if project.get("targetDate"):
                dates.append(f"Due: {project['targetDate'][:10]}")
            date_info = f"\n   {' | '.join(dates)}" if dates else ""

            project_list.append(
                f"{i + 1}. {project['name']}{' - ' + project['description'] if project.get('description') else ''}\n"
                f"   Status: {status}{progress} | Teams: {team_names}{lead_text}{date_info}"
            )

        header_text = (
            f"📁 Found {len(projects)} {state_filter} project{'s' if len(projects) != 1 else ''}:"
            if state_filter and state_filter != "all"
            else f"📁 Found {len(projects)} project{'s' if len(projects) != 1 else ''}:"
        )

        result_message = f"{header_text}\n\n" + "\n\n".join(project_list)
        if callback:
            await callback(
                {"text": result_message, "source": message.get("content", {}).get("source")}
            )

        return {
            "text": f"Found {len(projects)} project{'s' if len(projects) != 1 else ''}",
            "success": True,
            "data": {
                "projects": [
                    {
                        "id": p["id"],
                        "name": p["name"],
                        "description": p.get("description"),
                        "url": p.get("url"),
                        "state": p.get("state"),
                        "progress": p.get("progress"),
                        "startDate": p.get("startDate"),
                        "targetDate": p.get("targetDate"),
                    }
                    for p in projects
                ],
                "count": len(projects),
                "filters": {"team": team_id, "state": state_filter},
            },
        }

    except Exception as error:
        logger.error(f"Failed to list projects: {error}")
        error_message = f"❌ Failed to list projects: {error}"
        if callback:
            await callback(
                {"text": error_message, "source": message.get("content", {}).get("source")}
            )
        return {"text": error_message, "success": False}


list_projects_action = create_action(
    name="LIST_LINEAR_PROJECTS",
    description="List projects in Linear with optional filters",
    similes=["list-linear-projects", "show-linear-projects", "get-linear-projects"],
    examples=[
        [
            ActionExample(name="User", content={"text": "Show me all projects"}),
            ActionExample(
                name="Assistant",
                content={
                    "text": "I'll list all the projects in Linear.",
                    "actions": ["LIST_LINEAR_PROJECTS"],
                },
            ),
        ],
    ],
    validate=validate,
    handler=handler,
)
