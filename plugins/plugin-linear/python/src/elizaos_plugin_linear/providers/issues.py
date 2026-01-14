from elizaos_plugin_linear.providers.base import Provider, ProviderResult, RuntimeProtocol
from elizaos_plugin_linear.services.linear import LinearService
from elizaos_plugin_linear.types import LinearSearchFilters


async def get_issues(
    runtime: RuntimeProtocol,
    _message: object,
    _state: object,
) -> ProviderResult:
    try:
        linear_service: LinearService = runtime.get_service("linear")
        if not linear_service:
            return ProviderResult(text="Linear service is not available")

        filters = LinearSearchFilters(limit=10)
        issues = await linear_service.search_issues(filters)

        if not issues:
            return ProviderResult(text="No recent Linear issues found")

        issues_list = []
        for issue in issues:
            assignee = issue.get("assignee", {})
            state = issue.get("state", {})

            assignee_name = assignee.get("name", "Unassigned") if assignee else "Unassigned"
            state_name = state.get("name", "Unknown") if state else "Unknown"

            issues_list.append(
                f"- {issue['identifier']}: {issue['title']} ({state_name}, {assignee_name})"
            )

        text = "Recent Linear Issues:\n" + "\n".join(issues_list)

        return ProviderResult(
            text=text,
            data={
                "issues": [
                    {"id": i["id"], "identifier": i["identifier"], "title": i["title"]}
                    for i in issues
                ]
            },
        )
    except Exception:
        return ProviderResult(text="Error retrieving Linear issues")


linear_issues_provider = Provider(
    name="LINEAR_ISSUES",
    description="Provides context about recent Linear issues",
    get=get_issues,
)
