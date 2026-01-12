from typing import Literal

from elizaos_plugin_github.actions.create_issue import ActionContext, ActionResult
from elizaos_plugin_github.types import MergePullRequestParams


class MergePullRequestAction:
    @property
    def name(self) -> str:
        return "MERGE_GITHUB_PULL_REQUEST"

    @property
    def description(self) -> str:
        return "Merges a GitHub pull request using merge, squash, or rebase strategy."

    @property
    def similes(self) -> list[str]:
        return [
            "MERGE_PR",
            "SQUASH_MERGE",
            "REBASE_MERGE",
            "COMPLETE_PR",
            "ACCEPT_PR",
        ]

    async def validate(self, context: ActionContext) -> bool:
        content = context.message.get("content", {})
        text = ""
        if isinstance(content, dict):
            text = str(content.get("text", "")).lower()

        return "merge" in text

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

            # Determine merge method
            merge_method: Literal["merge", "squash", "rebase"] = "merge"
            if "squash" in text:
                merge_method = "squash"
            elif "rebase" in text:
                merge_method = "rebase"

            pull_number = int(context.message.get("pull_number", 0))

            params = MergePullRequestParams(
                owner=context.owner,
                repo=context.repo,
                pull_number=pull_number,
                merge_method=merge_method,
            )

            sha, merged, message = await service.merge_pull_request(params)

            if merged:
                return ActionResult.success_result(
                    f"Successfully merged pull request #{pull_number}",
                    {
                        "sha": sha,
                        "merged": merged,
                        "merge_method": merge_method,
                    },
                )
            else:
                return ActionResult.error_result(
                    f"Could not merge pull request #{pull_number}: {message}"
                )
        except Exception as e:
            return ActionResult.error_result(f"Failed to merge pull request: {e}")
