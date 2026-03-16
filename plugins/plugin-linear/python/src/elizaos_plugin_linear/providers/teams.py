from elizaos_plugin_linear.providers.base import Provider, ProviderResult, RuntimeProtocol
from elizaos_plugin_linear.services.linear import LinearService


async def get_teams(
    runtime: RuntimeProtocol,
    _message: object,
    _state: object,
) -> ProviderResult:
    try:
        linear_service: LinearService = runtime.get_service("linear")
        if not linear_service:
            return ProviderResult(text="Linear service is not available")

        teams = await linear_service.get_teams()

        if not teams:
            return ProviderResult(text="No Linear teams found")

        teams_list = [
            f"- {team['name']} ({team['key']}): {team.get('description') or 'No description'}"
            for team in teams
        ]

        text = "Linear Teams:\n" + "\n".join(teams_list)

        return ProviderResult(
            text=text,
            data={"teams": [{"id": t["id"], "name": t["name"], "key": t["key"]} for t in teams]},
        )
    except Exception:
        return ProviderResult(text="Error retrieving Linear teams")


linear_teams_provider = Provider(
    name="LINEAR_TEAMS",
    description="Provides context about Linear teams",
    get=get_teams,
)
