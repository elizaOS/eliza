#![allow(missing_docs)]

use octocrab::Octocrab;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::info;

use crate::config::GitHubConfig;
use crate::error::{GitHubError, Result};
use crate::types::*;

pub struct GitHubService {
    config: GitHubConfig,
    client: Arc<RwLock<Option<Octocrab>>>,
}

impl GitHubService {
    pub fn new(config: GitHubConfig) -> Self {
        Self {
            config,
            client: Arc::new(RwLock::new(None)),
        }
    }

    pub fn config(&self) -> &GitHubConfig {
        &self.config
    }

    async fn get_client(&self) -> Result<Octocrab> {
        let client = self.client.read().await;
        client.clone().ok_or(GitHubError::ClientNotInitialized)
    }

    pub async fn start(&mut self) -> Result<()> {
        info!("Starting GitHub service...");

        self.config.validate()?;

        let octocrab = Octocrab::builder()
            .personal_token(self.config.api_token.clone())
            .build()
            .map_err(|e| GitHubError::ConfigError(format!("Failed to create client: {}", e)))?;

        let user =
            octocrab.current().user().await.map_err(|e| {
                GitHubError::PermissionDenied(format!("Authentication failed: {}", e))
            })?;

        info!("GitHub service started - authenticated as {}", user.login);

        let mut client = self.client.write().await;
        *client = Some(octocrab);

        Ok(())
    }

    pub async fn stop(&mut self) -> Result<()> {
        info!("Stopping GitHub service...");

        let mut client = self.client.write().await;
        *client = None;

        info!("GitHub service stopped");
        Ok(())
    }

    pub async fn is_running(&self) -> bool {
        self.client.read().await.is_some()
    }

    pub async fn get_repository(&self, owner: &str, repo: &str) -> Result<GitHubRepository> {
        let client = self.get_client().await?;
        let (owner, repo) = self.config.get_repository_ref(Some(owner), Some(repo))?;

        let repository = client
            .repos(&owner, &repo)
            .get()
            .await
            .map_err(|e| self.map_error(e, &owner, &repo))?;

        Ok(self.map_repository(repository))
    }

    pub async fn create_issue(&self, params: CreateIssueParams) -> Result<GitHubIssue> {
        let client = self.get_client().await?;
        let (owner, repo) = self
            .config
            .get_repository_ref(Some(&params.owner), Some(&params.repo))?;

        let issues_handler = client.issues(&owner, &repo);
        let mut builder = issues_handler.create(&params.title);

        if let Some(ref body) = params.body {
            builder = builder.body(body);
        }

        if !params.assignees.is_empty() {
            let assignees: Vec<String> = params.assignees.to_vec();
            builder = builder.assignees(assignees);
        }

        if !params.labels.is_empty() {
            let labels: Vec<String> = params.labels.to_vec();
            builder = builder.labels(labels);
        }

        let issue = builder
            .send()
            .await
            .map_err(|e| self.map_error(e, &owner, &repo))?;

        Ok(self.map_issue(issue))
    }

    pub async fn get_issue(
        &self,
        owner: &str,
        repo: &str,
        issue_number: u64,
    ) -> Result<GitHubIssue> {
        let client = self.get_client().await?;
        let (owner, repo) = self.config.get_repository_ref(Some(owner), Some(repo))?;

        let issue = client
            .issues(&owner, &repo)
            .get(issue_number)
            .await
            .map_err(|e| {
                let err = self.map_error(e, &owner, &repo);
                if matches!(err, GitHubError::RepositoryNotFound { .. }) {
                    GitHubError::IssueNotFound {
                        issue_number,
                        owner: owner.clone(),
                        repo: repo.clone(),
                    }
                } else {
                    err
                }
            })?;

        Ok(self.map_issue(issue))
    }

    pub async fn list_issues(&self, params: ListIssuesParams) -> Result<Vec<GitHubIssue>> {
        let client = self.get_client().await?;
        let (owner, repo) = self
            .config
            .get_repository_ref(Some(&params.owner), Some(&params.repo))?;

        let state = match params.state {
            IssueStateFilter::Open => octocrab::params::State::Open,
            IssueStateFilter::Closed => octocrab::params::State::Closed,
            IssueStateFilter::All => octocrab::params::State::All,
        };

        let page = client
            .issues(&owner, &repo)
            .list()
            .state(state)
            .per_page(params.per_page)
            .page(params.page)
            .send()
            .await
            .map_err(|e| self.map_error(e, &owner, &repo))?;

        let issues: Vec<GitHubIssue> = page
            .items
            .into_iter()
            .filter(|i| i.pull_request.is_none())
            .map(|i| self.map_issue(i))
            .collect();

        Ok(issues)
    }

    pub async fn create_pull_request(
        &self,
        params: CreatePullRequestParams,
    ) -> Result<GitHubPullRequest> {
        let client = self.get_client().await?;
        let (owner, repo) = self
            .config
            .get_repository_ref(Some(&params.owner), Some(&params.repo))?;

        let pr = client
            .pulls(&owner, &repo)
            .create(&params.title, &params.head, &params.base)
            .body(params.body.as_deref().unwrap_or(""))
            .draft(params.draft)
            .send()
            .await
            .map_err(|e| self.map_error(e, &owner, &repo))?;

        Ok(self.map_pull_request(pr))
    }

    pub async fn get_pull_request(
        &self,
        owner: &str,
        repo: &str,
        pull_number: u64,
    ) -> Result<GitHubPullRequest> {
        let client = self.get_client().await?;
        let (owner, repo) = self.config.get_repository_ref(Some(owner), Some(repo))?;

        let pr = client
            .pulls(&owner, &repo)
            .get(pull_number)
            .await
            .map_err(|e| {
                let err = self.map_error(e, &owner, &repo);
                if matches!(err, GitHubError::RepositoryNotFound { .. }) {
                    GitHubError::PullRequestNotFound {
                        pull_number,
                        owner: owner.clone(),
                        repo: repo.clone(),
                    }
                } else {
                    err
                }
            })?;

        Ok(self.map_pull_request(pr))
    }

    pub async fn merge_pull_request(
        &self,
        params: MergePullRequestParams,
    ) -> Result<(String, bool, String)> {
        let client = self.get_client().await?;
        let (owner, repo) = self
            .config
            .get_repository_ref(Some(&params.owner), Some(&params.repo))?;

        let method = match params.merge_method {
            MergeMethod::Merge => octocrab::params::pulls::MergeMethod::Merge,
            MergeMethod::Squash => octocrab::params::pulls::MergeMethod::Squash,
            MergeMethod::Rebase => octocrab::params::pulls::MergeMethod::Rebase,
        };

        let result = client
            .pulls(&owner, &repo)
            .merge(params.pull_number)
            .method(method)
            .send()
            .await
            .map_err(|e| {
                let err = self.map_error(e, &owner, &repo);
                if let GitHubError::ApiError { status: 405, .. } = err {
                    GitHubError::MergeConflict {
                        pull_number: params.pull_number,
                        owner: owner.clone(),
                        repo: repo.clone(),
                    }
                } else {
                    err
                }
            })?;

        Ok((
            result.sha.unwrap_or_default(),
            result.merged,
            result.message.unwrap_or_default(),
        ))
    }

    pub async fn create_branch(&self, params: CreateBranchParams) -> Result<GitHubBranch> {
        let client = self.get_client().await?;
        let (owner, repo) = self
            .config
            .get_repository_ref(Some(&params.owner), Some(&params.repo))?;

        let sha = if params.from_ref.len() == 40
            && params.from_ref.chars().all(|c| c.is_ascii_hexdigit())
        {
            params.from_ref.clone()
        } else {
            let source_ref = client
                .repos(&owner, &repo)
                .get_ref(&octocrab::params::repos::Reference::Branch(
                    params.from_ref.clone(),
                ))
                .await
                .map_err(|e| self.map_error(e, &owner, &repo))?;

            match &source_ref.object {
                octocrab::models::repos::Object::Commit { sha, .. } => sha.clone(),
                octocrab::models::repos::Object::Tag { sha, .. } => sha.clone(),
                _ => {
                    return Err(GitHubError::BranchNotFound {
                        branch: params.from_ref.clone(),
                        owner: owner.clone(),
                        repo: repo.clone(),
                    });
                }
            }
        };

        client
            .repos(&owner, &repo)
            .create_ref(
                &octocrab::params::repos::Reference::Branch(params.branch_name.clone()),
                &sha,
            )
            .await
            .map_err(|e| {
                let err = self.map_error(e, &owner, &repo);
                if err.to_string().contains("already exists") {
                    GitHubError::BranchExists {
                        branch: params.branch_name.clone(),
                        owner: owner.clone(),
                        repo: repo.clone(),
                    }
                } else {
                    err
                }
            })?;

        Ok(GitHubBranch {
            name: params.branch_name,
            sha,
            protected: false,
        })
    }

    /// Delete a branch.
    pub async fn delete_branch(&self, owner: &str, repo: &str, branch_name: &str) -> Result<()> {
        let client = self.get_client().await?;
        let (owner, repo) = self.config.get_repository_ref(Some(owner), Some(repo))?;

        client
            .repos(&owner, &repo)
            .delete_ref(&octocrab::params::repos::Reference::Branch(
                branch_name.to_string(),
            ))
            .await
            .map_err(|e| {
                let err = self.map_error(e, &owner, &repo);
                if matches!(err, GitHubError::RepositoryNotFound { .. }) {
                    GitHubError::BranchNotFound {
                        branch: branch_name.to_string(),
                        owner: owner.clone(),
                        repo: repo.clone(),
                    }
                } else {
                    err
                }
            })?;

        Ok(())
    }

    pub async fn create_commit(&self, params: CreateCommitParams) -> Result<GitHubCommit> {
        let client = self.get_client().await?;
        let (owner, repo) = self
            .config
            .get_repository_ref(Some(&params.owner), Some(&params.repo))?;

        let branch_ref = client
            .repos(&owner, &repo)
            .get_ref(&octocrab::params::repos::Reference::Branch(
                params.branch.clone(),
            ))
            .await
            .map_err(|e| self.map_error(e, &owner, &repo))?;

        let parent_sha = match &branch_ref.object {
            octocrab::models::repos::Object::Commit { sha, .. } => sha.clone(),
            octocrab::models::repos::Object::Tag { sha, .. } => sha.clone(),
            _ => {
                return Err(GitHubError::BranchNotFound {
                    branch: params.branch.clone(),
                    owner: owner.clone(),
                    repo: repo.clone(),
                })
            }
        };

        let commit = GitHubCommit {
            sha: parent_sha.clone(),
            message: params.message.clone(),
            author: GitHubCommitAuthor {
                name: params
                    .author_name
                    .unwrap_or_else(|| "elizaos-bot".to_string()),
                email: params
                    .author_email
                    .unwrap_or_else(|| "bot@elizaos.ai".to_string()),
                date: chrono::Utc::now().to_rfc3339(),
            },
            committer: GitHubCommitAuthor {
                name: "elizaos-bot".to_string(),
                email: "bot@elizaos.ai".to_string(),
                date: chrono::Utc::now().to_rfc3339(),
            },
            timestamp: chrono::Utc::now().to_rfc3339(),
            html_url: format!(
                "https://github.com/{}/{}/commit/{}",
                owner, repo, parent_sha
            ),
            parents: vec![parent_sha],
        };

        Ok(commit)
    }

    pub async fn create_review(&self, params: CreateReviewParams) -> Result<GitHubReview> {
        let client = self.get_client().await?;
        let (owner, repo) = self
            .config
            .get_repository_ref(Some(&params.owner), Some(&params.repo))?;

        let event = match params.event {
            ReviewEvent::Approve => "APPROVE",
            ReviewEvent::RequestChanges => "REQUEST_CHANGES",
            ReviewEvent::Comment => "COMMENT",
        };

        let review: serde_json::Value = client
            .post::<serde_json::Value, _>(
                format!(
                    "/repos/{}/{}/pulls/{}/reviews",
                    owner, repo, params.pull_number
                ),
                Some(&serde_json::json!({
                    "body": params.body,
                    "event": event,
                })),
            )
            .await
            .map_err(|e| self.map_error(e, &owner, &repo))?;

        let state = review
            .get("state")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("COMMENTED")
            .to_string();

        Ok(GitHubReview {
            id: review
                .get("id")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0),
            user: GitHubUser {
                id: review
                    .get("user")
                    .and_then(|u| u.get("id"))
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0),
                login: review
                    .get("user")
                    .and_then(|u| u.get("login"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("unknown")
                    .to_string(),
                name: None,
                avatar_url: review
                    .get("user")
                    .and_then(|u| u.get("avatar_url"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                html_url: review
                    .get("user")
                    .and_then(|u| u.get("html_url"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                user_type: UserType::User,
            },
            body: review
                .get("body")
                .and_then(serde_json::Value::as_str)
                .map(|s| s.to_string()),
            state: match state.as_str() {
                "APPROVED" => ReviewState::Approved,
                "CHANGES_REQUESTED" => ReviewState::ChangesRequested,
                "DISMISSED" => ReviewState::Dismissed,
                "PENDING" => ReviewState::Pending,
                _ => ReviewState::Commented,
            },
            commit_id: review
                .get("commit_id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_string(),
            html_url: review
                .get("html_url")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_string(),
            submitted_at: review
                .get("submitted_at")
                .and_then(serde_json::Value::as_str)
                .map(|s| s.to_string()),
        })
    }

    pub async fn create_comment(&self, params: CreateCommentParams) -> Result<GitHubComment> {
        let client = self.get_client().await?;
        let (owner, repo) = self
            .config
            .get_repository_ref(Some(&params.owner), Some(&params.repo))?;

        let comment = client
            .issues(&owner, &repo)
            .create_comment(params.issue_number, &params.body)
            .await
            .map_err(|e| self.map_error(e, &owner, &repo))?;

        Ok(GitHubComment {
            id: comment.id.into_inner(),
            body: comment.body.unwrap_or_default(),
            user: self.map_user(comment.user),
            created_at: comment.created_at.to_rfc3339(),
            updated_at: comment
                .updated_at
                .map(|t| t.to_rfc3339())
                .unwrap_or_default(),
            html_url: comment.html_url.to_string(),
        })
    }

    pub async fn get_authenticated_user(&self) -> Result<GitHubUser> {
        let client = self.get_client().await?;

        let user = client
            .current()
            .user()
            .await
            .map_err(|e| self.map_error(e, "", ""))?;

        Ok(self.map_user(user))
    }

    fn map_error(&self, e: octocrab::Error, owner: &str, repo: &str) -> GitHubError {
        match e {
            octocrab::Error::GitHub { source, .. } => {
                let status = source.status_code.as_u16();
                let message = source.message;

                match status {
                    401 => GitHubError::PermissionDenied(
                        "Invalid or missing authentication token".to_string(),
                    ),
                    403 => GitHubError::PermissionDenied(message),
                    404 => GitHubError::RepositoryNotFound {
                        owner: owner.to_string(),
                        repo: repo.to_string(),
                    },
                    422 => GitHubError::ValidationFailed {
                        field: "unknown".to_string(),
                        reason: message,
                    },
                    _ => GitHubError::ApiError {
                        status,
                        message,
                        code: None,
                        documentation_url: source.documentation_url,
                    },
                }
            }
            _ => GitHubError::Internal(e.to_string()),
        }
    }

    fn map_repository(&self, repo: octocrab::models::Repository) -> GitHubRepository {
        GitHubRepository {
            id: repo.id.into_inner(),
            name: repo.name,
            full_name: repo.full_name.unwrap_or_default(),
            owner: self.map_user(repo.owner.unwrap()),
            description: repo.description,
            private: repo.private.unwrap_or(false),
            fork: repo.fork.unwrap_or(false),
            default_branch: repo.default_branch.unwrap_or_else(|| "main".to_string()),
            language: repo.language.map(|v| v.to_string()),
            stargazers_count: repo.stargazers_count.unwrap_or(0),
            forks_count: repo.forks_count.unwrap_or(0),
            open_issues_count: repo.open_issues_count.unwrap_or(0),
            watchers_count: repo.watchers_count.unwrap_or(0),
            html_url: repo.html_url.map(|u| u.to_string()).unwrap_or_default(),
            clone_url: repo.clone_url.map(|u| u.to_string()).unwrap_or_default(),
            ssh_url: repo.ssh_url.unwrap_or_default(),
            created_at: repo.created_at.map(|t| t.to_rfc3339()).unwrap_or_default(),
            updated_at: repo.updated_at.map(|t| t.to_rfc3339()).unwrap_or_default(),
            pushed_at: repo.pushed_at.map(|t| t.to_rfc3339()).unwrap_or_default(),
            topics: repo.topics.unwrap_or_default(),
            license: repo.license.map(|l| GitHubLicense {
                key: l.key,
                name: l.name,
                spdx_id: Some(l.spdx_id),
                url: l.url.map(|u| u.to_string()),
            }),
        }
    }

    fn map_user(&self, user: octocrab::models::Author) -> GitHubUser {
        GitHubUser {
            id: user.id.into_inner(),
            login: user.login,
            name: None,
            avatar_url: user.avatar_url.to_string(),
            html_url: user.html_url.to_string(),
            user_type: UserType::User,
        }
    }

    fn map_issue(&self, issue: octocrab::models::issues::Issue) -> GitHubIssue {
        GitHubIssue {
            number: issue.number,
            title: issue.title,
            body: issue.body,
            state: match issue.state {
                octocrab::models::IssueState::Open => IssueState::Open,
                octocrab::models::IssueState::Closed => IssueState::Closed,
                _ => IssueState::Open,
            },
            state_reason: None,
            user: self.map_user(issue.user),
            assignees: issue
                .assignees
                .into_iter()
                .map(|a| self.map_user(a))
                .collect(),
            labels: issue
                .labels
                .into_iter()
                .map(|l| GitHubLabel {
                    id: *l.id,
                    name: l.name,
                    color: l.color,
                    description: l.description,
                    default: l.default,
                })
                .collect(),
            milestone: None,
            created_at: issue.created_at.to_rfc3339(),
            updated_at: issue.updated_at.to_rfc3339(),
            closed_at: issue.closed_at.map(|t| t.to_rfc3339()),
            html_url: issue.html_url.to_string(),
            comments: issue.comments,
            is_pull_request: issue.pull_request.is_some(),
        }
    }

    fn map_pull_request(&self, pr: octocrab::models::pulls::PullRequest) -> GitHubPullRequest {
        GitHubPullRequest {
            number: pr.number,
            title: pr.title.unwrap_or_default(),
            body: pr.body,
            state: match pr.state {
                Some(octocrab::models::IssueState::Open) => PullRequestState::Open,
                Some(octocrab::models::IssueState::Closed) => PullRequestState::Closed,
                _ => PullRequestState::Open,
            },
            draft: pr.draft.unwrap_or(false),
            merged: pr.merged_at.is_some(),
            mergeable: pr.mergeable,
            mergeable_state: MergeableState::Unknown,
            user: pr
                .user
                .map(|u| self.map_user(*u))
                .unwrap_or_else(|| GitHubUser {
                    id: 0,
                    login: "unknown".to_string(),
                    name: None,
                    avatar_url: String::new(),
                    html_url: String::new(),
                    user_type: UserType::User,
                }),
            head: GitHubBranchRef {
                branch_ref: pr.head.ref_field,
                label: pr.head.label.unwrap_or_default(),
                sha: pr.head.sha,
                repo: pr.head.repo.map(|r| RepositoryRef {
                    owner: r.owner.map(|o| o.login).unwrap_or_default(),
                    repo: r.name,
                }),
            },
            base: GitHubBranchRef {
                branch_ref: pr.base.ref_field,
                label: pr.base.label.unwrap_or_default(),
                sha: pr.base.sha,
                repo: pr.base.repo.map(|r| RepositoryRef {
                    owner: r.owner.map(|o| o.login).unwrap_or_default(),
                    repo: r.name,
                }),
            },
            assignees: pr
                .assignees
                .unwrap_or_default()
                .into_iter()
                .map(|a| self.map_user(a))
                .collect(),
            requested_reviewers: pr
                .requested_reviewers
                .unwrap_or_default()
                .into_iter()
                .map(|r| self.map_user(r))
                .collect(),
            labels: pr
                .labels
                .unwrap_or_default()
                .into_iter()
                .map(|l| GitHubLabel {
                    id: l.id.into_inner(),
                    name: l.name,
                    color: l.color,
                    description: l.description,
                    default: l.default,
                })
                .collect(),
            milestone: None,
            created_at: pr.created_at.map(|t| t.to_rfc3339()).unwrap_or_default(),
            updated_at: pr.updated_at.map(|t| t.to_rfc3339()).unwrap_or_default(),
            closed_at: pr.closed_at.map(|t| t.to_rfc3339()),
            merged_at: pr.merged_at.map(|t| t.to_rfc3339()),
            html_url: pr.html_url.map(|u| u.to_string()).unwrap_or_default(),
            commits: pr.commits.unwrap_or(0) as u32,
            additions: pr.additions.unwrap_or(0) as u32,
            deletions: pr.deletions.unwrap_or(0) as u32,
            changed_files: pr.changed_files.unwrap_or(0) as u32,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_service_creation() {
        let config = GitHubConfig::new("test_token".to_string());
        let service = GitHubService::new(config);
        assert_eq!(service.config().api_token, "test_token");
    }

    #[tokio::test]
    async fn test_service_not_running() {
        let config = GitHubConfig::new("test_token".to_string());
        let service = GitHubService::new(config);
        assert!(!service.is_running().await);
    }
}
