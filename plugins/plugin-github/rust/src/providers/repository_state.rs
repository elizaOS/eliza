#![allow(missing_docs)]

use serde_json::json;

use super::{GitHubProvider, ProviderContext, ProviderResult};
use crate::error::Result;
use crate::types::{ListIssuesParams, ListPullRequestsParams};
use crate::GitHubService;

/// Provides context about the current GitHub repository including
/// recent issues and pull requests for agent conversations.
pub struct RepositoryStateProvider;

impl GitHubProvider for RepositoryStateProvider {
    fn name(&self) -> &str {
        "REPOSITORY_STATE"
    }

    fn description(&self) -> &str {
        "Provides context about the current GitHub repository including recent activity"
    }

    async fn get(
        &self,
        _context: &ProviderContext,
        service: &GitHubService,
    ) -> Result<ProviderResult> {
        let config = service.config();
        let owner = config.owner.as_deref().unwrap_or("");
        let repo = config.repo.as_deref().unwrap_or("");

        if owner.is_empty() || repo.is_empty() {
            return Ok(ProviderResult {
                context: "GitHub repository not configured. Please set GITHUB_OWNER and GITHUB_REPO.".to_string(),
                data: json!({}),
            });
        }

        let repository = service.get_repository(owner, repo).await?;

        // Fetch recent open issues (limit 5)
        let issues = service
            .list_issues(ListIssuesParams {
                owner: owner.to_string(),
                repo: repo.to_string(),
                state: crate::types::IssueStateFilter::Open,
                labels: None,
                sort: crate::types::IssueSort::Created,
                direction: crate::types::SortDirection::Desc,
                assignee: None,
                creator: None,
                per_page: 5,
                page: 1,
            })
            .await?;

        // Fetch recent open PRs (limit 5)
        let pull_requests = service
            .list_pull_requests(ListPullRequestsParams {
                owner: owner.to_string(),
                repo: repo.to_string(),
                state: crate::types::PullRequestStateFilter::Open,
                head: None,
                base: None,
                sort: crate::types::PullRequestSort::Created,
                direction: crate::types::SortDirection::Desc,
                per_page: 5,
                page: 1,
            })
            .await?;

        let mut parts = vec![
            format!("## GitHub Repository: {}", repository.full_name),
            String::new(),
            format!(
                "**Description:** {}",
                repository
                    .description
                    .as_deref()
                    .unwrap_or("No description")
            ),
            format!("**Default Branch:** {}", repository.default_branch),
            format!(
                "**Language:** {}",
                repository.language.as_deref().unwrap_or("Not specified")
            ),
            format!(
                "**Stars:** {} | **Forks:** {}",
                repository.stargazers_count, repository.forks_count
            ),
            format!("**Open Issues:** {}", repository.open_issues_count),
            String::new(),
        ];

        if !issues.is_empty() {
            parts.push("### Recent Open Issues".to_string());
            for issue in &issues {
                let labels: String = issue
                    .labels
                    .iter()
                    .map(|l| l.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ");
                let label_str = if labels.is_empty() {
                    String::new()
                } else {
                    format!(" [{}]", labels)
                };
                parts.push(format!(
                    "- #{}: {}{}",
                    issue.number, issue.title, label_str
                ));
            }
            parts.push(String::new());
        }

        if !pull_requests.is_empty() {
            parts.push("### Recent Open Pull Requests".to_string());
            for pr in &pull_requests {
                let status = if pr.draft { "[DRAFT] " } else { "" };
                parts.push(format!(
                    "- #{}: {}{} ({} → {})",
                    pr.number, status, pr.title, pr.head.branch_ref, pr.base.branch_ref
                ));
            }
            parts.push(String::new());
        }

        let context_str = parts.join("\n");

        Ok(ProviderResult {
            context: context_str,
            data: json!({
                "name": repository.name,
                "full_name": repository.full_name,
                "default_branch": repository.default_branch,
                "language": repository.language,
                "stars": repository.stargazers_count,
                "forks": repository.forks_count,
                "open_issues": repository.open_issues_count,
                "recent_issues": issues.iter().map(|i| json!({
                    "number": i.number,
                    "title": i.title,
                })).collect::<Vec<_>>(),
                "recent_prs": pull_requests.iter().map(|pr| json!({
                    "number": pr.number,
                    "title": pr.title,
                    "draft": pr.draft,
                })).collect::<Vec<_>>(),
            }),
        })
    }
}

/// TS-parity alias provider (name: `GITHUB_REPOSITORY_STATE`).
pub struct GitHubRepositoryStateProvider;

impl GitHubProvider for GitHubRepositoryStateProvider {
    fn name(&self) -> &str {
        "GITHUB_REPOSITORY_STATE"
    }

    fn description(&self) -> &str {
        "Provides context about the current GitHub repository including recent activity"
    }

    fn get(
        &self,
        context: &ProviderContext,
        service: &GitHubService,
    ) -> impl std::future::Future<Output = Result<ProviderResult>> + Send {
        RepositoryStateProvider.get(context, service)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_provider_names() {
        let provider = RepositoryStateProvider;
        assert_eq!(provider.name(), "REPOSITORY_STATE");
        assert!(!provider.description().is_empty());
        assert!(
            provider.description().contains("repository"),
            "Description should mention repository"
        );

        let alias = GitHubRepositoryStateProvider;
        assert_eq!(alias.name(), "GITHUB_REPOSITORY_STATE");
    }
}
