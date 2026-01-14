#![allow(missing_docs)]

use serde_json::json;

use super::{GitHubProvider, ProviderContext, ProviderResult};
use crate::error::Result;
use crate::types::ListIssuesParams;
use crate::GitHubService;

pub struct IssueContextProvider;

impl GitHubProvider for IssueContextProvider {
    fn name(&self) -> &str {
        "ISSUE_CONTEXT"
    }

    fn description(&self) -> &str {
        "Provides information about issues in the repository"
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

        let params = ListIssuesParams {
            owner: owner.to_string(),
            repo: repo.to_string(),
            state: crate::types::IssueStateFilter::Open,
            labels: None,
            sort: crate::types::IssueSort::Updated,
            direction: crate::types::SortDirection::Desc,
            assignee: None,
            creator: None,
            per_page: 10,
            page: 1,
        };

        let issues = service.list_issues(params).await?;

        let context_str = if issues.is_empty() {
            "No open issues in this repository.".to_string()
        } else {
            let issue_list: Vec<String> = issues
                .iter()
                .take(5)
                .map(|i| format!("- #{}: {}", i.number, i.title))
                .collect();
            format!("Recent open issues:\n{}", issue_list.join("\n"))
        };

        Ok(ProviderResult {
            context: context_str,
            data: json!({
                "total": issues.len(),
                "issues": issues.iter().take(5).map(|i| json!({
                    "number": i.number,
                    "title": i.title,
                    "state": format!("{:?}", i.state).to_lowercase(),
                    "comments": i.comments,
                })).collect::<Vec<_>>(),
            }),
        })
    }
}

/// TS-parity alias provider (name: `GITHUB_ISSUE_CONTEXT`).
pub struct GitHubIssueContextProvider;

impl GitHubProvider for GitHubIssueContextProvider {
    fn name(&self) -> &str {
        "GITHUB_ISSUE_CONTEXT"
    }

    fn description(&self) -> &str {
        "Provides information about issues in the repository"
    }

    fn get(
        &self,
        context: &ProviderContext,
        service: &GitHubService,
    ) -> impl std::future::Future<Output = Result<ProviderResult>> + Send {
        IssueContextProvider.get(context, service)
    }
}
