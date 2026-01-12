from elizaos_plugin_github.actions.create_issue import ActionContext, ActionResult
from elizaos_plugin_github.types import CreateCommitParams, FileChange


class PushCodeAction:
    @property
    def name(self) -> str:
        return "PUSH_GITHUB_CODE"

    @property
    def description(self) -> str:
        return "Creates a commit with file changes and pushes to a GitHub branch."

    @property
    def similes(self) -> list[str]:
        return [
            "COMMIT_CODE",
            "PUSH_CHANGES",
            "COMMIT_FILES",
            "PUSH_FILES",
            "GIT_PUSH",
            "SAVE_CODE",
        ]

    async def validate(self, context: ActionContext) -> bool:
        content = context.message.get("content", {})
        text = ""
        if isinstance(content, dict):
            text = str(content.get("text", "")).lower()

        return "push" in text or "commit" in text or "save" in text or "upload" in text

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

            files_data = context.message.get("files", [])
            files: list[FileChange] = []

            if isinstance(files_data, list):
                for f in files_data:
                    if isinstance(f, dict):
                        files.append(
                            FileChange(
                                path=str(f.get("path", "")),
                                content=str(f.get("content", "")),
                            )
                        )

            branch = str(context.message.get("branch", "main"))

            params = CreateCommitParams(
                owner=context.owner,
                repo=context.repo,
                message=text[:100] if text else "Update files",
                files=files,
                branch=branch,
            )

            commit = await service.create_commit(params)

            return ActionResult.success_result(
                f"Pushed {len(files)} file(s) to {branch}",
                {
                    "sha": commit.sha,
                    "html_url": commit.html_url,
                    "message": commit.message,
                },
            )
        except Exception as e:
            return ActionResult.error_result(f"Failed to push code: {e}")
