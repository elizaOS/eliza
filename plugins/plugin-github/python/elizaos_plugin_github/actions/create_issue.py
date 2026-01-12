from typing import Protocol

from elizaos_plugin_github.types import CreateIssueParams


class ActionContext(Protocol):
    message: dict[str, object]
    owner: str
    repo: str


class ActionResult:
    def __init__(
        self,
        success: bool,
        message: str,
        data: dict[str, object] | None = None,
    ) -> None:
        self.success = success
        self.message = message
        self.data = data or {}

    @classmethod
    def success_result(cls, message: str, data: dict[str, object] | None = None) -> "ActionResult":
        return cls(success=True, message=message, data=data)

    @classmethod
    def error_result(cls, message: str) -> "ActionResult":
        return cls(success=False, message=message)


class CreateIssueAction:
    @property
    def name(self) -> str:
        return "CREATE_GITHUB_ISSUE"

    @property
    def description(self) -> str:
        return "Creates a new issue in a GitHub repository. Use this to report bugs, request features, or track tasks."

    @property
    def similes(self) -> list[str]:
        return [
            "OPEN_ISSUE",
            "NEW_ISSUE",
            "FILE_ISSUE",
            "REPORT_BUG",
            "CREATE_BUG_REPORT",
            "SUBMIT_ISSUE",
        ]

    async def validate(self, context: ActionContext) -> bool:
        content = context.message.get("content", {})
        text = ""
        if isinstance(content, dict):
            text = str(content.get("text", "")).lower()

        return "issue" in text or "bug" in text or "report" in text or "ticket" in text

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

            params = CreateIssueParams(
                owner=context.owner,
                repo=context.repo,
                title=text[:100] if text else "New Issue",
                body=text,
            )

            issue = await service.create_issue(params)

            return ActionResult.success_result(
                f"Created issue #{issue.number}: {issue.title}",
                {
                    "issue_number": issue.number,
                    "html_url": issue.html_url,
                },
            )
        except Exception as e:
            return ActionResult.error_result(f"Failed to create issue: {e}")
