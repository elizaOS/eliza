#![allow(missing_docs)]

use regex::Regex;
use serde_json::json;

use super::{GitHubProvider, ProviderContext, ProviderResult};
use crate::error::Result;
use crate::types::ListIssuesParams;
use crate::GitHubService;

/// Extract an issue or PR number from text using common patterns.
pub fn extract_issue_number(text: &str) -> Option<u64> {
    let patterns = [
        r"#(\d+)",
        r"(?i)issue\s*#?(\d+)",
        r"(?i)pr\s*#?(\d+)",
        r"(?i)pull\s*request\s*#?(\d+)",
    ];

    for pattern in &patterns {
        if let Ok(re) = Regex::new(pattern) {
            if let Some(caps) = re.captures(text) {
                if let Some(num) = caps.get(1) {
                    if let Ok(n) = num.as_str().parse::<u64>() {
                        return Some(n);
                    }
                }
            }
        }
    }

    None
}

/// Provides detailed context about a specific GitHub issue or pull request
/// when referenced in a message, or lists recent open issues as fallback.
pub struct IssueContextProvider;

impl GitHubProvider for IssueContextProvider {
    fn name(&self) -> &str {
        "ISSUE_CONTEXT"
    }

    fn description(&self) -> &str {
        "Provides detailed context about a specific GitHub issue or pull request when referenced"
    }

    async fn get(
        &self,
        context: &ProviderContext,
        service: &GitHubService,
    ) -> Result<ProviderResult> {
        let config = service.config();
        let owner = config.owner.as_deref().unwrap_or("");
        let repo = config.repo.as_deref().unwrap_or("");

        if owner.is_empty() || repo.is_empty() {
            return Ok(ProviderResult {
                context: String::new(),
                data: json!(null),
            });
        }

        // Extract issue number from message text
        let text = context
            .message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");

        let issue_number = match extract_issue_number(text) {
            Some(n) => n,
            None => {
                // No issue reference found — return recent open issues as fallback
                return self.fallback_open_issues(service, owner, repo).await;
            }
        };

        // Fetch the specific issue
        match service.get_issue(owner, repo, issue_number).await {
            Ok(issue) => {
                if issue.is_pull_request {
                    self.format_pull_request(service, owner, repo, issue_number)
                        .await
                } else {
                    Ok(self.format_issue(&issue, owner, repo))
                }
            }
            Err(_) => Ok(ProviderResult {
                context: format!(
                    "Issue/PR #{} not found in {}/{}",
                    issue_number, owner, repo
                ),
                data: json!(null),
            }),
        }
    }
}

impl IssueContextProvider {
    async fn fallback_open_issues(
        &self,
        service: &GitHubService,
        owner: &str,
        repo: &str,
    ) -> Result<ProviderResult> {
        let params = ListIssuesParams {
            owner: owner.to_string(),
            repo: repo.to_string(),
            state: crate::types::IssueStateFilter::Open,
            labels: None,
            sort: crate::types::IssueSort::Updated,
            direction: crate::types::SortDirection::Desc,
            assignee: None,
            creator: None,
            per_page: 5,
            page: 1,
        };

        let issues = service.list_issues(params).await?;

        if issues.is_empty() {
            return Ok(ProviderResult {
                context: "No open issues in this repository.".to_string(),
                data: json!(null),
            });
        }

        let issue_list: Vec<String> = issues
            .iter()
            .map(|i| format!("- #{}: {}", i.number, i.title))
            .collect();

        Ok(ProviderResult {
            context: format!("Recent open issues:\n{}", issue_list.join("\n")),
            data: json!({
                "total": issues.len(),
                "issues": issues.iter().map(|i| json!({
                    "number": i.number,
                    "title": i.title,
                    "state": format!("{:?}", i.state).to_lowercase(),
                    "comments": i.comments,
                })).collect::<Vec<_>>(),
            }),
        })
    }

    async fn format_pull_request(
        &self,
        service: &GitHubService,
        owner: &str,
        repo: &str,
        pull_number: u64,
    ) -> Result<ProviderResult> {
        match service.get_pull_request(owner, repo, pull_number).await {
            Ok(pr) => {
                let labels: String = pr
                    .labels
                    .iter()
                    .map(|l| l.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ");
                let assignees: String = pr
                    .assignees
                    .iter()
                    .map(|a| a.login.as_str())
                    .collect::<Vec<_>>()
                    .join(", ");
                let reviewers: String = pr
                    .requested_reviewers
                    .iter()
                    .map(|r| r.login.as_str())
                    .collect::<Vec<_>>()
                    .join(", ");

                let mut parts = vec![
                    format!("## Pull Request #{}: {}", pr.number, pr.title),
                    String::new(),
                    format!(
                        "**State:** {:?}{}{}",
                        pr.state,
                        if pr.draft { " (Draft)" } else { "" },
                        if pr.merged { " (Merged)" } else { "" }
                    ),
                    format!("**Author:** {}", pr.user.login),
                    format!(
                        "**Branch:** {} → {}",
                        pr.head.branch_ref, pr.base.branch_ref
                    ),
                    format!("**Created:** {}", pr.created_at),
                    format!("**Updated:** {}", pr.updated_at),
                ];

                if !labels.is_empty() {
                    parts.push(format!("**Labels:** {}", labels));
                }
                if !assignees.is_empty() {
                    parts.push(format!("**Assignees:** {}", assignees));
                }
                if !reviewers.is_empty() {
                    parts.push(format!("**Reviewers Requested:** {}", reviewers));
                }

                parts.push(String::new());
                parts.push(format!(
                    "**Changes:** +{} / -{} ({} files)",
                    pr.additions, pr.deletions, pr.changed_files
                ));
                parts.push(String::new());
                parts.push("### Description".to_string());
                parts.push(
                    pr.body
                        .as_deref()
                        .unwrap_or("_No description provided_")
                        .to_string(),
                );
                parts.push(String::new());
                parts.push(format!("**URL:** {}", pr.html_url));

                Ok(ProviderResult {
                    context: parts.join("\n"),
                    data: json!({
                        "type": "pull_request",
                        "number": pr.number,
                        "title": pr.title,
                        "state": format!("{:?}", pr.state),
                        "draft": pr.draft,
                        "merged": pr.merged,
                    }),
                })
            }
            Err(_) => Ok(ProviderResult {
                context: format!(
                    "Issue/PR #{} not found in {}/{}",
                    pull_number, owner, repo
                ),
                data: json!(null),
            }),
        }
    }

    fn format_issue(
        &self,
        issue: &crate::types::GitHubIssue,
        owner: &str,
        repo: &str,
    ) -> ProviderResult {
        let labels: String = issue
            .labels
            .iter()
            .map(|l| l.name.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        let assignees: String = issue
            .assignees
            .iter()
            .map(|a| a.login.as_str())
            .collect::<Vec<_>>()
            .join(", ");

        let state_str = match issue.state_reason {
            Some(reason) => format!("{:?} ({:?})", issue.state, reason),
            None => format!("{:?}", issue.state),
        };

        let mut parts = vec![
            format!("## Issue #{}: {}", issue.number, issue.title),
            String::new(),
            format!("**State:** {}", state_str),
            format!("**Author:** {}", issue.user.login),
            format!("**Created:** {}", issue.created_at),
            format!("**Updated:** {}", issue.updated_at),
            format!("**Comments:** {}", issue.comments),
        ];

        if !labels.is_empty() {
            parts.push(format!("**Labels:** {}", labels));
        }
        if !assignees.is_empty() {
            parts.push(format!("**Assignees:** {}", assignees));
        }
        if let Some(ref milestone) = issue.milestone {
            parts.push(format!("**Milestone:** {}", milestone.title));
        }

        parts.push(String::new());
        parts.push("### Description".to_string());
        parts.push(
            issue
                .body
                .as_deref()
                .unwrap_or("_No description provided_")
                .to_string(),
        );
        parts.push(String::new());
        parts.push(format!("**URL:** {}", issue.html_url));

        let _ = (owner, repo); // used in error paths above

        ProviderResult {
            context: parts.join("\n"),
            data: json!({
                "type": "issue",
                "number": issue.number,
                "title": issue.title,
                "state": format!("{:?}", issue.state),
                "comments": issue.comments,
            }),
        }
    }
}

/// TS-parity alias provider (name: `GITHUB_ISSUE_CONTEXT`).
pub struct GitHubIssueContextProvider;

impl GitHubProvider for GitHubIssueContextProvider {
    fn name(&self) -> &str {
        "GITHUB_ISSUE_CONTEXT"
    }

    fn description(&self) -> &str {
        "Provides detailed context about a specific GitHub issue or pull request when referenced"
    }

    fn get(
        &self,
        context: &ProviderContext,
        service: &GitHubService,
    ) -> impl std::future::Future<Output = Result<ProviderResult>> + Send {
        IssueContextProvider.get(context, service)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_issue_number_hash() {
        assert_eq!(extract_issue_number("Fix #42"), Some(42));
        assert_eq!(extract_issue_number("See #123 for details"), Some(123));
    }

    #[test]
    fn test_extract_issue_number_issue_keyword() {
        assert_eq!(extract_issue_number("issue 42"), Some(42));
        assert_eq!(extract_issue_number("Issue #99"), Some(99));
        assert_eq!(extract_issue_number("issue#7"), Some(7));
    }

    #[test]
    fn test_extract_issue_number_pr_keyword() {
        assert_eq!(extract_issue_number("PR #15"), Some(15));
        assert_eq!(extract_issue_number("pr 10"), Some(10));
    }

    #[test]
    fn test_extract_issue_number_pull_request_keyword() {
        assert_eq!(extract_issue_number("pull request #5"), Some(5));
        assert_eq!(extract_issue_number("Pull Request 3"), Some(3));
    }

    #[test]
    fn test_extract_issue_number_none() {
        assert_eq!(extract_issue_number("Hello world"), None);
        assert_eq!(extract_issue_number("No numbers here"), None);
        assert_eq!(extract_issue_number(""), None);
    }

    #[test]
    fn test_provider_names() {
        let provider = IssueContextProvider;
        assert_eq!(provider.name(), "ISSUE_CONTEXT");
        assert!(!provider.description().is_empty());

        let alias = GitHubIssueContextProvider;
        assert_eq!(alias.name(), "GITHUB_ISSUE_CONTEXT");
    }
}
