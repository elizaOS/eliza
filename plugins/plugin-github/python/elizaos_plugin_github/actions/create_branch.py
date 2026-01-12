from elizaos_plugin_github.actions.create_issue import ActionContext, ActionResult
from elizaos_plugin_github.types import CreateBranchParams


class CreateBranchAction:
    @property
    def name(self) -> str:
        return "CREATE_GITHUB_BRANCH"

    @property
    def description(self) -> str:
        return "Creates a new branch in a GitHub repository from an existing branch or commit."

    @property
    def similes(self) -> list[str]:
        return [
            "NEW_BRANCH",
            "BRANCH_FROM",
            "FORK_BRANCH",
            "CREATE_FEATURE_BRANCH",
        ]

    async def validate(self, context: ActionContext) -> bool:
        content = context.message.get("content", {})
        text = ""
        if isinstance(content, dict):
            text = str(content.get("text", "")).lower()

        return "branch" in text or "fork" in text or "checkout" in text

    async def handler(
        self,
        context: ActionContext,
        service: object,
    ) -> ActionResult:
        from elizaos_plugin_github.service import GitHubService

        if not isinstance(service, GitHubService):
            return ActionResult.error_result("GitHub service not available")

        try:
            branch_name = str(context.message.get("branch_name", "new-branch"))
            from_ref = str(context.message.get("from_ref", "main"))

            params = CreateBranchParams(
                owner=context.owner,
                repo=context.repo,
                branch_name=branch_name,
                from_ref=from_ref,
            )

            branch = await service.create_branch(params)

            return ActionResult.success_result(
                f"Created branch '{branch.name}' from {from_ref}",
                {
                    "branch_name": branch.name,
                    "sha": branch.sha,
                },
            )
        except Exception as e:
            return ActionResult.error_result(f"Failed to create branch: {e}")
