from elizaos_plugin_github.actions.create_issue import ActionContext, ActionResult
from elizaos_plugin_github.types import CreatePullRequestParams


class CreatePullRequestAction:
    @property
    def name(self) -> str:
        return "CREATE_GITHUB_PULL_REQUEST"

    @property
    def description(self) -> str:
        return "Creates a new pull request in a GitHub repository to merge changes from one branch to another."

    @property
    def similes(self) -> list[str]:
        return [
            "OPEN_PR",
            "CREATE_PR",
            "NEW_PULL_REQUEST",
            "SUBMIT_PR",
            "OPEN_PULL_REQUEST",
            "MERGE_REQUEST",
        ]

    async def validate(self, context: ActionContext) -> bool:
        content = context.message.get("content", {})
        text = ""
        if isinstance(content, dict):
            text = str(content.get("text", "")).lower()

        return "pull request" in text or "pr" in text or "merge" in text

    async def handler(
        self,
        context: ActionContext,
        service: object,
    ) -> ActionResult:
        from elizaos_plugin_github.service import GitHubService

        if not isinstance(service, GitHubService):
            return ActionResult.error_result("GitHub service not available")

        try:
            content = context.message.get("content", {})
            text = ""
            if isinstance(content, dict):
                text = str(content.get("text", ""))

            head = str(context.message.get("head", "feature"))
            base = str(context.message.get("base", "main"))

            params = CreatePullRequestParams(
                owner=context.owner,
                repo=context.repo,
                title=text[:100] if text else "New Pull Request",
                body=text,
                head=head,
                base=base,
            )

            pr = await service.create_pull_request(params)

            return ActionResult.success_result(
                f"Created pull request #{pr.number}: {pr.title}",
                {
                    "pull_number": pr.number,
                    "html_url": pr.html_url,
                    "head": pr.head.ref,
                    "base": pr.base.ref,
                },
            )
        except Exception as e:
            return ActionResult.error_result(f"Failed to create pull request: {e}")
