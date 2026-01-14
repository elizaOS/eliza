import re
from typing import Protocol


class ProviderContext(Protocol):
    message: dict[str, object]


def extract_issue_number(text: str) -> int | None:
    patterns = [
        r"#(\d+)",
        r"issue\s*#?(\d+)",
        r"pr\s*#?(\d+)",
        r"pull\s*request\s*#?(\d+)",
    ]

    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            return int(match.group(1))

    return None


class IssueContextProvider:
    @property
    def name(self) -> str:
        return "GITHUB_ISSUE_CONTEXT"

    @property
    def description(self) -> str:
        return "Provides detailed context about a specific GitHub issue or pull request when referenced"

    async def get(
        self,
        context: ProviderContext,
        service: object,
    ) -> str | None:
        from elizaos_plugin_github.service import GitHubService

        if not isinstance(service, GitHubService):
            return None

        content = context.message.get("content", {})
        text = ""
        if isinstance(content, dict):
            text = str(content.get("text", ""))

        issue_number = extract_issue_number(text)
        if not issue_number:
            return None

        try:
            config = service.config

            if not config.owner or not config.repo:
                return None

            try:
                issue = await service.get_issue(config.owner, config.repo, issue_number)

                if issue.is_pull_request:
                    pr = await service.get_pull_request(config.owner, config.repo, issue_number)

                    labels = ", ".join(label.name for label in pr.labels)
                    assignees = ", ".join(a.login for a in pr.assignees)
                    reviewers = ", ".join(r.login for r in pr.requested_reviewers)

                    parts = [
                        f"## Pull Request #{pr.number}: {pr.title}",
                        "",
                        f"**State:** {pr.state.value}{'  (Draft)' if pr.draft else ''}{'  (Merged)' if pr.merged else ''}",
                        f"**Author:** {pr.user.login}",
                        f"**Branch:** {pr.head.ref} → {pr.base.ref}",
                        f"**Created:** {pr.created_at}",
                        f"**Updated:** {pr.updated_at}",
                    ]

                    if labels:
                        parts.append(f"**Labels:** {labels}")
                    if assignees:
                        parts.append(f"**Assignees:** {assignees}")
                    if reviewers:
                        parts.append(f"**Reviewers Requested:** {reviewers}")

                    parts.extend(
                        [
                            "",
                            f"**Changes:** +{pr.additions} / -{pr.deletions} ({pr.changed_files} files)",
                            "",
                            "### Description",
                            pr.body or "_No description provided_",
                            "",
                            f"**URL:** {pr.html_url}",
                        ]
                    )

                    return "\n".join(parts)

                labels = ", ".join(label.name for label in issue.labels)
                assignees = ", ".join(a.login for a in issue.assignees)

                parts = [
                    f"## Issue #{issue.number}: {issue.title}",
                    "",
                    f"**State:** {issue.state.value}{(' (' + issue.state_reason.value + ')') if issue.state_reason else ''}",
                    f"**Author:** {issue.user.login}",
                    f"**Created:** {issue.created_at}",
                    f"**Updated:** {issue.updated_at}",
                    f"**Comments:** {issue.comments}",
                ]

                if labels:
                    parts.append(f"**Labels:** {labels}")
                if assignees:
                    parts.append(f"**Assignees:** {assignees}")
                if issue.milestone:
                    parts.append(f"**Milestone:** {issue.milestone.title}")

                parts.extend(
                    [
                        "",
                        "### Description",
                        issue.body or "_No description provided_",
                        "",
                        f"**URL:** {issue.html_url}",
                    ]
                )

                return "\n".join(parts)

            except Exception:
                return f"Issue/PR #{issue_number} not found in {config.owner}/{config.repo}"

        except Exception as e:
            return f"Unable to fetch issue context: {e}"
