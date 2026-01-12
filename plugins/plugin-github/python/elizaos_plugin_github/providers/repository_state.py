from typing import Protocol

from elizaos_plugin_github.types import ListIssuesParams, ListPullRequestsParams, RepositoryRef


class ProviderContext(Protocol):
    pass


class RepositoryStateProvider:
    @property
    def name(self) -> str:
        return "GITHUB_REPOSITORY_STATE"

    @property
    def description(self) -> str:
        return "Provides context about the current GitHub repository including recent activity"

    async def get(
        self,
        _context: ProviderContext,
        service: object,
    ) -> str | None:
        from elizaos_plugin_github.service import GitHubService

        if not isinstance(service, GitHubService):
            return None

        try:
            config = service.config

            if not config.owner or not config.repo:
                return "GitHub repository not configured. Please set GITHUB_OWNER and GITHUB_REPO."

            repo = await service.get_repository(RepositoryRef(owner=config.owner, repo=config.repo))

            issues = await service.list_issues(
                ListIssuesParams(
                    owner=config.owner,
                    repo=config.repo,
                    state="open",
                    per_page=5,
                )
            )

            # Fetch recent open PRs (limit 5)
            pull_requests = await service.list_pull_requests(
                ListPullRequestsParams(
                    owner=config.owner,
                    repo=config.repo,
                    state="open",
                    per_page=5,
                )
            )

            parts: list[str] = [
                f"## GitHub Repository: {repo.full_name}",
                "",
                f"**Description:** {repo.description or 'No description'}",
                f"**Default Branch:** {repo.default_branch}",
                f"**Language:** {repo.language or 'Not specified'}",
                f"**Stars:** {repo.stargazers_count} | **Forks:** {repo.forks_count}",
                f"**Open Issues:** {repo.open_issues_count}",
                "",
            ]

            if issues:
                parts.append("### Recent Open Issues")
                for issue in issues:
                    labels = ", ".join(label.name for label in issue.labels)
                    label_str = f" [{labels}]" if labels else ""
                    parts.append(f"- #{issue.number}: {issue.title}{label_str}")
                parts.append("")

            if pull_requests:
                parts.append("### Recent Open Pull Requests")
                for pr in pull_requests:
                    status = "[DRAFT] " if pr.draft else ""
                    parts.append(
                        f"- #{pr.number}: {status}{pr.title} ({pr.head.ref} → {pr.base.ref})"
                    )
                parts.append("")

            return "\n".join(parts)

        except Exception as e:
            return f"Unable to fetch GitHub repository state: {e}"
