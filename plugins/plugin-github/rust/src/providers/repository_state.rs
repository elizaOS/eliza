#![allow(missing_docs)]

use serde_json::json;

use super::{GitHubProvider, ProviderContext, ProviderResult};
use crate::error::Result;
use crate::GitHubService;

pub struct RepositoryStateProvider;

impl GitHubProvider for RepositoryStateProvider {
    fn name(&self) -> &str {
        "REPOSITORY_STATE"
    }

    fn description(&self) -> &str {
        "Provides information about the current state of the GitHub repository"
    }

    async fn get(
        &self,
        context: &ProviderContext,
        service: &GitHubService,
    ) -> Result<ProviderResult> {
        let owner = context
            .state
            .get("owner")
            .and_then(|o| o.as_str())
            .unwrap_or("");

        let repo = context
            .state
            .get("repo")
            .and_then(|r| r.as_str())
            .unwrap_or("");

        if owner.is_empty() || repo.is_empty() {
            return Ok(ProviderResult {
                context: "No repository configured.".to_string(),
                data: json!({}),
            });
        }

        let repository = service.get_repository(owner, repo).await?;

        let context_str = format!(
            "Repository: {}/{}\n\
             Description: {}\n\
             Default Branch: {}\n\
             Language: {}\n\
             Stars: {} | Forks: {} | Open Issues: {}",
            repository.owner.login,
            repository.name,
            repository.description.as_deref().unwrap_or("N/A"),
            repository.default_branch,
            repository.language.as_deref().unwrap_or("N/A"),
            repository.stargazers_count,
            repository.forks_count,
            repository.open_issues_count
        );

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
        "Provides information about the current state of the GitHub repository"
    }

    fn get(
        &self,
        context: &ProviderContext,
        service: &GitHubService,
    ) -> impl std::future::Future<Output = Result<ProviderResult>> + Send {
        RepositoryStateProvider.get(context, service)
    }
}
