from elizaos_plugin_linear.providers.base import Provider, ProviderResult, RuntimeProtocol
from elizaos_plugin_linear.services.linear import LinearService


async def get_projects(
    runtime: RuntimeProtocol,
    _message: object,
    _state: object,
) -> ProviderResult:
    try:
        linear_service: LinearService = runtime.get_service("linear")
        if not linear_service:
            return ProviderResult(text="Linear service is not available")

        projects = await linear_service.get_projects()

        if not projects:
            return ProviderResult(text="No Linear projects found")

        active_projects = [p for p in projects if p.get("state") in ("started", "planned", None)]

        projects_list = [
            f"- {project['name']}: {project.get('state') or 'active'} "
            f"({project.get('startDate', 'No start date')[:10] if project.get('startDate') else 'No start date'} - "
            f"{project.get('targetDate', 'No target date')[:10] if project.get('targetDate') else 'No target date'})"
            for project in active_projects[:10]
        ]

        text = "Active Linear Projects:\n" + "\n".join(projects_list)

        return ProviderResult(
            text=text,
            data={
                "projects": [
                    {"id": p["id"], "name": p["name"], "state": p.get("state")}
                    for p in active_projects[:10]
                ]
            },
        )
    except Exception:
        return ProviderResult(text="Error retrieving Linear projects")


linear_projects_provider = Provider(
    name="LINEAR_PROJECTS",
    description="Provides context about active Linear projects",
    get=get_projects,
)
