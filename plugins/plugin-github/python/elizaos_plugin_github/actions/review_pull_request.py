from elizaos_plugin_github.actions.create_issue import ActionContext, ActionResult
from elizaos_plugin_github.types import CreateReviewParams, ReviewEvent


class ReviewPullRequestAction:
    @property
    def name(self) -> str:
        return "REVIEW_GITHUB_PULL_REQUEST"

    @property
    def description(self) -> str:
        return "Creates a review on a GitHub pull request. Can approve, request changes, or add comments."

    @property
    def similes(self) -> list[str]:
        return [
            "APPROVE_PR",
            "REQUEST_CHANGES",
            "COMMENT_ON_PR",
            "REVIEW_PR",
            "PR_REVIEW",
            "CODE_REVIEW",
        ]

    async def validate(self, context: ActionContext) -> bool:
        content = context.message.get("content", {})
        text = ""
        if isinstance(content, dict):
            text = str(content.get("text", "")).lower()

        return "review" in text or "approve" in text or "request changes" in text or "lgtm" in text

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
                text = str(content.get("text", "")).lower()

            event = ReviewEvent.COMMENT
            if "approve" in text or "lgtm" in text or "looks good" in text:
                event = ReviewEvent.APPROVE
            elif "request changes" in text or "needs work" in text or "fix" in text:
                event = ReviewEvent.REQUEST_CHANGES

            pull_number = int(context.message.get("pull_number", 0))

            params = CreateReviewParams(
                owner=context.owner,
                repo=context.repo,
                pull_number=pull_number,
                body=text,
                event=event,
            )

            review = await service.create_review(params)

            event_label = (
                "approved"
                if review.state.value == "APPROVED"
                else "requested changes on"
                if review.state.value == "CHANGES_REQUESTED"
                else "commented on"
            )

            return ActionResult.success_result(
                f"Successfully {event_label} pull request #{pull_number}",
                {
                    "review_id": review.id,
                    "html_url": review.html_url,
                    "state": review.state.value,
                },
            )
        except Exception as e:
            return ActionResult.error_result(f"Failed to create review: {e}")
