"""moltbookState provider - Provides Moltbook context to the agent."""

from elizaos_plugin_moltbook.constants import MOLTBOOK_SERVICE_NAME, URLS
from elizaos_plugin_moltbook.providers.base import Provider, ProviderResult, RuntimeProtocol
from elizaos_plugin_moltbook.services.moltbook import MoltbookService


async def get_moltbook_state(
    runtime: RuntimeProtocol,
    _message: object,
    _state: object,
) -> ProviderResult:
    """Provides Moltbook context: trending posts, availability, and autonomy state."""
    service: MoltbookService | None = runtime.get_service(MOLTBOOK_SERVICE_NAME)

    if not service:
        return ProviderResult(
            text="Moltbook service is not available.",
            data={"available": False},
        )

    # Get recent Moltbook posts for context
    trending_posts: list[str] = []
    browse_result = await service.moltbook_browse(None, "hot")
    if browse_result.success and browse_result.data:
        for p in list(browse_result.data)[:5]:
            submolt_name = (
                p.get("submolt", {}).get("name", "general")
                if p.get("submolt") else "general"
            )
            upvotes = p.get("upvotes", 0)
            title = p.get("title", "?")
            trending_posts.append(f"[{submolt_name}] {title} ({upvotes} votes)")

    moltbook_url = URLS["moltbook"].replace("/api/v1", "")
    is_autonomy_running = service.is_autonomy_running()

    trending_context = ""
    if trending_posts:
        trending_context = "\nTrending on Moltbook:\n" + "\n".join(trending_posts)

    text = (
        "The agent is connected to Moltbook, a Reddit-style social platform for AI agents.\n"
        f"Website: {moltbook_url}\n"
        f"Autonomy: {'running' if is_autonomy_running else 'stopped'}\n\n"
        "The agent can:\n"
        "- Create posts on Moltbook (submolts are like subreddits)\n"
        "- Browse trending and new posts\n"
        "- Comment on posts and reply to discussions\n"
        f"- Read full posts with comments{trending_context}"
    )

    return ProviderResult(
        text=text,
        data={
            "available": True,
            "trendingPosts": trending_posts,
            "moltbookUrl": moltbook_url,
            "isAutonomyRunning": is_autonomy_running,
        },
    )


moltbook_state_provider = Provider(
    name="MOLTBOOK_STATE",
    description="Provides context about Moltbook status, trending posts, and agent capabilities",
    get=get_moltbook_state,
)
