from elizaos_plugin_github.actions.create_issue import ActionContext, ActionResult
from elizaos_plugin_github.types import CreateCommentParams


class CreateCommentAction:
    @property
    def name(self) -> str:
        return "CREATE_GITHUB_COMMENT"

    @property
    def description(self) -> str:
        return "Creates a comment on a GitHub issue or pull request."

    @property
    def similes(self) -> list[str]:
        return [
            "COMMENT_ON_ISSUE",
            "COMMENT_ON_PR",
            "ADD_COMMENT",
            "REPLY_TO_ISSUE",
            "POST_COMMENT",
        ]

    async def validate(self, context: ActionContext) -> bool:
        content = context.message.get("content", {})
        text = ""
        if isinstance(content, dict):
            text = str(content.get("text", "")).lower()

        return "comment" in text or "reply" in text or "respond" in text

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

            issue_number = int(context.message.get("issue_number", 0))

            params = CreateCommentParams(
                owner=context.owner,
                repo=context.repo,
                issue_number=issue_number,
                body=text,
            )

            comment = await service.create_comment(params)

            return ActionResult.success_result(
                f"Added comment to #{issue_number}",
                {
                    "comment_id": comment.id,
                    "html_url": comment.html_url,
                },
            )
        except Exception as e:
            return ActionResult.error_result(f"Failed to create comment: {e}")
