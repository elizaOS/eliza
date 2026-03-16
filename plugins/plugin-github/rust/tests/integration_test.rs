//! Integration tests for the GitHub plugin

use elizaos_plugin_github::{
    ActionContext,
    CreateBranchAction,
    CreateCommentAction,
    // Actions
    CreateIssueAction,
    CreatePullRequestAction,
    GitHubAction,
    GitHubConfig,
    MergePullRequestAction,
    PushCodeAction,
    ReviewPullRequestAction,
    PLUGIN_NAME,
    PLUGIN_VERSION,
    // Providers
    GitHubProvider,
    IssueContextProvider,
    RepositoryStateProvider,
    GitHubIssueContextProvider,
    GitHubRepositoryStateProvider,
    ProviderContext,
    // Types
    CreateIssueParams,
    CreatePullRequestParams,
    CreateBranchParams,
    CreateCommentParams,
    MergePullRequestParams,
    CreateReviewParams,
    CreateCommitParams,
    FileChange,
    FileEncoding,
    FileOperation,
    ReviewEvent,
    MergeMethod,
    IssueState,
    PullRequestState,
    ReviewState,
    MergeableState,
    GitHubEventType,
    GitHubUser,
    UserType,
    GitHubLabel,
    GitHubIssue,
    GitHubPullRequest,
    GitHubBranchRef,
    RepositoryRef,
    GitHubRepository,
};

// =============================================================================
// Plugin metadata
// =============================================================================

#[test]
fn test_plugin_metadata() {
    assert_eq!(PLUGIN_NAME, "github");
    assert!(!PLUGIN_VERSION.is_empty());
}

#[test]
fn test_plugin_creation() {
    let p = elizaos_plugin_github::plugin();
    assert_eq!(p.name, PLUGIN_NAME);
    assert_eq!(p.version, PLUGIN_VERSION);
    assert!(!p.description.is_empty());
}

// =============================================================================
// Config tests
// =============================================================================

#[test]
fn test_config_new() {
    let config = GitHubConfig::new("test_token".to_string());
    assert_eq!(config.api_token, "test_token");
    assert_eq!(config.branch, "main");
    assert!(config.owner.is_none());
    assert!(config.repo.is_none());
    assert!(config.webhook_secret.is_none());
    assert!(config.app_id.is_none());
    assert!(config.app_private_key.is_none());
    assert!(config.installation_id.is_none());
}

#[test]
fn test_config_builder() {
    let config = GitHubConfig::new("test_token".to_string())
        .with_owner("test-owner".to_string())
        .with_repo("test-repo".to_string())
        .with_branch("develop".to_string())
        .with_webhook_secret("whsec_123".to_string());

    assert_eq!(config.owner, Some("test-owner".to_string()));
    assert_eq!(config.repo, Some("test-repo".to_string()));
    assert_eq!(config.branch, "develop");
    assert_eq!(config.webhook_secret, Some("whsec_123".to_string()));
}

#[test]
fn test_config_get_repository_ref() {
    let config = GitHubConfig::new("token".to_string())
        .with_owner("default-owner".to_string())
        .with_repo("default-repo".to_string());

    // Use defaults
    let (owner, repo) = config.get_repository_ref(None, None).unwrap();
    assert_eq!(owner, "default-owner");
    assert_eq!(repo, "default-repo");

    // Override both
    let (owner, repo) = config
        .get_repository_ref(Some("override-owner"), Some("override-repo"))
        .unwrap();
    assert_eq!(owner, "override-owner");
    assert_eq!(repo, "override-repo");

    // Partial override - only owner
    let (owner, repo) = config
        .get_repository_ref(Some("override-owner"), None)
        .unwrap();
    assert_eq!(owner, "override-owner");
    assert_eq!(repo, "default-repo");

    // Partial override - only repo
    let (owner, repo) = config
        .get_repository_ref(None, Some("override-repo"))
        .unwrap();
    assert_eq!(owner, "default-owner");
    assert_eq!(repo, "override-repo");
}

#[test]
fn test_config_get_repository_ref_missing_owner() {
    let config = GitHubConfig::new("token".to_string())
        .with_repo("repo".to_string());
    assert!(config.get_repository_ref(None, None).is_err());
}

#[test]
fn test_config_get_repository_ref_missing_repo() {
    let config = GitHubConfig::new("token".to_string())
        .with_owner("owner".to_string());
    assert!(config.get_repository_ref(None, None).is_err());
}

#[test]
fn test_config_validation_empty_token() {
    let config = GitHubConfig::new("".to_string());
    assert!(config.validate().is_err());
}

#[test]
fn test_config_validation_valid() {
    let config = GitHubConfig::new("valid_token".to_string());
    assert!(config.validate().is_ok());
}

#[test]
fn test_config_validation_app_auth_without_installation() {
    let mut config = GitHubConfig::new("token".to_string());
    config.app_id = Some("123".to_string());
    config.app_private_key = Some("key".to_string());
    assert!(config.validate().is_err());
}

#[test]
fn test_config_validation_app_auth_with_installation() {
    let mut config = GitHubConfig::new("token".to_string());
    config.app_id = Some("123".to_string());
    config.app_private_key = Some("key".to_string());
    config.installation_id = Some("456".to_string());
    assert!(config.validate().is_ok());
}

#[test]
fn test_config_has_app_auth() {
    let mut config = GitHubConfig::new("token".to_string());
    assert!(!config.has_app_auth());

    config.app_id = Some("123".to_string());
    assert!(!config.has_app_auth());

    config.app_private_key = Some("key".to_string());
    assert!(config.has_app_auth());
}

#[test]
fn test_config_serialization() {
    let config = GitHubConfig::new("test_token".to_string())
        .with_owner("org".to_string())
        .with_repo("project".to_string());

    let json = serde_json::to_string(&config).unwrap();
    let parsed: GitHubConfig = serde_json::from_str(&json).unwrap();

    assert_eq!(parsed.api_token, "test_token");
    assert_eq!(parsed.owner, Some("org".to_string()));
    assert_eq!(parsed.repo, Some("project".to_string()));
    assert_eq!(parsed.branch, "main");
}

// =============================================================================
// Action Tests
// =============================================================================

#[test]
fn test_all_actions_have_names() {
    let actions: Vec<Box<dyn GitHubAction>> = vec![
        Box::new(CreateIssueAction),
        Box::new(CreatePullRequestAction),
        Box::new(CreateCommentAction),
        Box::new(CreateBranchAction),
        Box::new(MergePullRequestAction),
        Box::new(PushCodeAction),
        Box::new(ReviewPullRequestAction),
    ];

    let names: Vec<&str> = actions.iter().map(|a| a.name()).collect();
    assert_eq!(names.len(), 7);
    assert!(names.contains(&"CREATE_GITHUB_ISSUE"));
    assert!(names.contains(&"CREATE_GITHUB_PULL_REQUEST"));
    assert!(names.contains(&"CREATE_GITHUB_COMMENT"));
    assert!(names.contains(&"CREATE_GITHUB_BRANCH"));
    assert!(names.contains(&"MERGE_GITHUB_PULL_REQUEST"));
    assert!(names.contains(&"PUSH_GITHUB_CODE"));
    assert!(names.contains(&"REVIEW_GITHUB_PULL_REQUEST"));
}

#[test]
fn test_all_actions_have_descriptions() {
    let actions: Vec<Box<dyn GitHubAction>> = vec![
        Box::new(CreateIssueAction),
        Box::new(CreatePullRequestAction),
        Box::new(CreateCommentAction),
        Box::new(CreateBranchAction),
        Box::new(MergePullRequestAction),
        Box::new(PushCodeAction),
        Box::new(ReviewPullRequestAction),
    ];

    for action in &actions {
        let desc = action.description();
        assert!(!desc.is_empty(), "Action {} has empty description", action.name());
    }
}

#[test]
fn test_all_actions_have_similes() {
    let actions: Vec<Box<dyn GitHubAction>> = vec![
        Box::new(CreateIssueAction),
        Box::new(CreatePullRequestAction),
        Box::new(CreateCommentAction),
        Box::new(CreateBranchAction),
        Box::new(MergePullRequestAction),
        Box::new(PushCodeAction),
        Box::new(ReviewPullRequestAction),
    ];

    for action in &actions {
        let similes = action.similes();
        assert!(
            !similes.is_empty(),
            "Action {} has no similes",
            action.name()
        );
    }
}

// =============================================================================
// Action validate tests
// =============================================================================

fn make_context(text: &str) -> ActionContext {
    ActionContext {
        message: serde_json::json!({
            "content": { "text": text }
        }),
        owner: "test".to_string(),
        repo: "test".to_string(),
        state: serde_json::json!({}),
    }
}

#[tokio::test]
async fn test_create_issue_validate() {
    let action = CreateIssueAction;
    assert!(action.validate(&make_context("Create an issue")).await.unwrap());
    assert!(action.validate(&make_context("Found a bug")).await.unwrap());
    assert!(action.validate(&make_context("File a report")).await.unwrap());
    assert!(action.validate(&make_context("Open a ticket")).await.unwrap());
    assert!(!action.validate(&make_context("Hello world")).await.unwrap());
}

#[tokio::test]
async fn test_create_pr_validate() {
    let action = CreatePullRequestAction;
    assert!(action.validate(&make_context("Create a pull request")).await.unwrap());
    assert!(action.validate(&make_context("Open a PR")).await.unwrap());
    assert!(action.validate(&make_context("Merge my branch")).await.unwrap());
    assert!(!action.validate(&make_context("Hello world")).await.unwrap());
}

#[tokio::test]
async fn test_create_comment_validate() {
    let action = CreateCommentAction;
    assert!(action.validate(&make_context("Comment on issue")).await.unwrap());
    assert!(action.validate(&make_context("Reply to this")).await.unwrap());
    assert!(action.validate(&make_context("Respond to feedback")).await.unwrap());
    assert!(!action.validate(&make_context("Hello world")).await.unwrap());
}

#[tokio::test]
async fn test_create_branch_validate() {
    let action = CreateBranchAction;
    assert!(action.validate(&make_context("Create a branch")).await.unwrap());
    assert!(action.validate(&make_context("Checkout new feature")).await.unwrap());
    assert!(!action.validate(&make_context("Hello world")).await.unwrap());
}

#[tokio::test]
async fn test_merge_pr_validate() {
    let action = MergePullRequestAction;
    assert!(action.validate(&make_context("Merge pull request")).await.unwrap());
    assert!(action.validate(&make_context("squash merge")).await.unwrap());
    assert!(!action.validate(&make_context("Hello world")).await.unwrap());
}

#[tokio::test]
async fn test_push_code_validate() {
    let action = PushCodeAction;
    assert!(action.validate(&make_context("Push these changes")).await.unwrap());
    assert!(action.validate(&make_context("Commit this file")).await.unwrap());
    assert!(action.validate(&make_context("Save to repository")).await.unwrap());
    assert!(action.validate(&make_context("Upload the files")).await.unwrap());
    assert!(!action.validate(&make_context("Hello world")).await.unwrap());
}

#[tokio::test]
async fn test_review_pr_validate() {
    let action = ReviewPullRequestAction;
    assert!(action.validate(&make_context("Review this PR")).await.unwrap());
    assert!(action.validate(&make_context("Approve this")).await.unwrap());
    assert!(action.validate(&make_context("LGTM")).await.unwrap());
    assert!(action.validate(&make_context("Request changes")).await.unwrap());
    assert!(!action.validate(&make_context("Hello world")).await.unwrap());
}

#[test]
fn test_push_code_action_similes() {
    let action = PushCodeAction;
    let similes = action.similes();
    assert!(similes.contains(&"COMMIT_CODE"));
    assert!(similes.contains(&"PUSH_CHANGES"));
    assert!(similes.contains(&"GIT_PUSH"));
}

#[test]
fn test_review_pr_action_similes() {
    let action = ReviewPullRequestAction;
    let similes = action.similes();
    assert!(similes.contains(&"APPROVE_PR"));
    assert!(similes.contains(&"CODE_REVIEW"));
    assert!(similes.contains(&"REQUEST_CHANGES"));
}

// =============================================================================
// Provider Tests
// =============================================================================

#[test]
fn test_issue_context_provider_name() {
    let provider = IssueContextProvider;
    assert_eq!(provider.name(), "ISSUE_CONTEXT");
    assert!(!provider.description().is_empty());
    assert!(provider.description().contains("issue"));
}

#[test]
fn test_github_issue_context_provider_alias_name() {
    let provider = GitHubIssueContextProvider;
    assert_eq!(provider.name(), "GITHUB_ISSUE_CONTEXT");
    assert!(!provider.description().is_empty());
}

#[test]
fn test_repository_state_provider_name() {
    let provider = RepositoryStateProvider;
    assert_eq!(provider.name(), "REPOSITORY_STATE");
    assert!(!provider.description().is_empty());
    assert!(provider.description().contains("repository"));
}

#[test]
fn test_github_repository_state_provider_alias_name() {
    let provider = GitHubRepositoryStateProvider;
    assert_eq!(provider.name(), "GITHUB_REPOSITORY_STATE");
    assert!(!provider.description().is_empty());
}

#[test]
fn test_extract_issue_number() {
    use elizaos_plugin_github::providers::extract_issue_number;

    // Hash pattern
    assert_eq!(extract_issue_number("Fix #42"), Some(42));
    assert_eq!(extract_issue_number("See #123 for details"), Some(123));

    // Issue keyword
    assert_eq!(extract_issue_number("issue 42"), Some(42));
    assert_eq!(extract_issue_number("Issue #99"), Some(99));
    assert_eq!(extract_issue_number("ISSUE #5"), Some(5));

    // PR keyword
    assert_eq!(extract_issue_number("PR #15"), Some(15));
    assert_eq!(extract_issue_number("pr 10"), Some(10));

    // Pull request keyword
    assert_eq!(extract_issue_number("pull request #5"), Some(5));
    assert_eq!(extract_issue_number("Pull Request 3"), Some(3));

    // No match
    assert_eq!(extract_issue_number("Hello world"), None);
    assert_eq!(extract_issue_number("No numbers"), None);
    assert_eq!(extract_issue_number(""), None);
}

#[test]
fn test_provider_context_serialization() {
    let context = ProviderContext {
        message: serde_json::json!({
            "content": { "text": "Check #42" }
        }),
        state: serde_json::json!({
            "owner": "org",
            "repo": "project",
        }),
    };

    let json = serde_json::to_string(&context).unwrap();
    let parsed: ProviderContext = serde_json::from_str(&json).unwrap();

    assert_eq!(
        parsed.message["content"]["text"].as_str(),
        Some("Check #42")
    );
    assert_eq!(parsed.state["owner"].as_str(), Some("org"));
}

// =============================================================================
// Type Construction & Serialization Tests
// =============================================================================

#[test]
fn test_create_issue_params_serialization() {
    let params = CreateIssueParams {
        owner: "org".to_string(),
        repo: "project".to_string(),
        title: "Bug: Login fails".to_string(),
        body: Some("Steps to reproduce...".to_string()),
        assignees: vec!["user1".to_string()],
        labels: vec!["bug".to_string(), "critical".to_string()],
        milestone: None,
    };

    let json = serde_json::to_string(&params).unwrap();
    let parsed: CreateIssueParams = serde_json::from_str(&json).unwrap();

    assert_eq!(parsed.owner, "org");
    assert_eq!(parsed.title, "Bug: Login fails");
    assert_eq!(parsed.labels.len(), 2);
    assert!(parsed.labels.contains(&"bug".to_string()));
}

#[test]
fn test_create_pull_request_params_serialization() {
    let params = CreatePullRequestParams {
        owner: "org".to_string(),
        repo: "project".to_string(),
        title: "Add dark mode".to_string(),
        body: Some("Implements dark mode support".to_string()),
        head: "feature/dark-mode".to_string(),
        base: "main".to_string(),
        draft: true,
        maintainer_can_modify: true,
    };

    let json = serde_json::to_string(&params).unwrap();
    let parsed: CreatePullRequestParams = serde_json::from_str(&json).unwrap();

    assert_eq!(parsed.head, "feature/dark-mode");
    assert_eq!(parsed.base, "main");
    assert!(parsed.draft);
}

#[test]
fn test_create_branch_params_serialization() {
    let params = CreateBranchParams {
        owner: "org".to_string(),
        repo: "project".to_string(),
        branch_name: "feature/new".to_string(),
        from_ref: "main".to_string(),
    };

    let json = serde_json::to_string(&params).unwrap();
    let parsed: CreateBranchParams = serde_json::from_str(&json).unwrap();

    assert_eq!(parsed.branch_name, "feature/new");
    assert_eq!(parsed.from_ref, "main");
}

#[test]
fn test_create_comment_params_serialization() {
    let params = CreateCommentParams {
        owner: "org".to_string(),
        repo: "project".to_string(),
        issue_number: 42,
        body: "Great work!".to_string(),
    };

    let json = serde_json::to_string(&params).unwrap();
    let parsed: CreateCommentParams = serde_json::from_str(&json).unwrap();

    assert_eq!(parsed.issue_number, 42);
    assert_eq!(parsed.body, "Great work!");
}

#[test]
fn test_merge_pull_request_params_serialization() {
    let params = MergePullRequestParams {
        owner: "org".to_string(),
        repo: "project".to_string(),
        pull_number: 99,
        commit_title: Some("Merge PR #99".to_string()),
        commit_message: None,
        merge_method: MergeMethod::Squash,
        sha: None,
    };

    let json = serde_json::to_string(&params).unwrap();
    let parsed: MergePullRequestParams = serde_json::from_str(&json).unwrap();

    assert_eq!(parsed.pull_number, 99);
    assert_eq!(parsed.merge_method, MergeMethod::Squash);
}

#[test]
fn test_create_review_params_serialization() {
    let params = CreateReviewParams {
        owner: "org".to_string(),
        repo: "project".to_string(),
        pull_number: 10,
        body: Some("LGTM!".to_string()),
        event: ReviewEvent::Approve,
        commit_id: None,
        comments: vec![],
    };

    let json = serde_json::to_string(&params).unwrap();
    let parsed: CreateReviewParams = serde_json::from_str(&json).unwrap();

    assert_eq!(parsed.event, ReviewEvent::Approve);
    assert_eq!(parsed.body, Some("LGTM!".to_string()));
}

#[test]
fn test_create_commit_params_serialization() {
    let params = CreateCommitParams {
        owner: "org".to_string(),
        repo: "project".to_string(),
        message: "Initial commit".to_string(),
        files: vec![FileChange {
            path: "README.md".to_string(),
            content: "# Hello".to_string(),
            encoding: FileEncoding::Utf8,
            operation: FileOperation::Add,
        }],
        branch: "main".to_string(),
        parent_sha: None,
        author_name: Some("Bot".to_string()),
        author_email: Some("bot@example.com".to_string()),
    };

    let json = serde_json::to_string(&params).unwrap();
    let parsed: CreateCommitParams = serde_json::from_str(&json).unwrap();

    assert_eq!(parsed.files.len(), 1);
    assert_eq!(parsed.files[0].path, "README.md");
    assert_eq!(parsed.author_name, Some("Bot".to_string()));
}

#[test]
fn test_github_issue_serialization() {
    let user = GitHubUser {
        id: 1,
        login: "author".to_string(),
        name: Some("Author Name".to_string()),
        avatar_url: "https://example.com/avatar".to_string(),
        html_url: "https://github.com/author".to_string(),
        user_type: UserType::User,
    };

    let issue = GitHubIssue {
        number: 42,
        title: "Test Issue".to_string(),
        body: Some("Description".to_string()),
        state: IssueState::Open,
        state_reason: None,
        user: user.clone(),
        assignees: vec![user.clone()],
        labels: vec![GitHubLabel {
            id: 1,
            name: "bug".to_string(),
            color: "d73a4a".to_string(),
            description: None,
            default: false,
        }],
        milestone: None,
        created_at: "2024-01-01T00:00:00Z".to_string(),
        updated_at: "2024-01-02T00:00:00Z".to_string(),
        closed_at: None,
        html_url: "https://github.com/org/repo/issues/42".to_string(),
        comments: 5,
        is_pull_request: false,
    };

    let json = serde_json::to_string(&issue).unwrap();
    let parsed: GitHubIssue = serde_json::from_str(&json).unwrap();

    assert_eq!(parsed.number, 42);
    assert_eq!(parsed.state, IssueState::Open);
    assert_eq!(parsed.labels.len(), 1);
    assert_eq!(parsed.labels[0].name, "bug");
}

#[test]
fn test_github_pull_request_serialization() {
    let user = GitHubUser {
        id: 1,
        login: "dev".to_string(),
        name: None,
        avatar_url: String::new(),
        html_url: String::new(),
        user_type: UserType::User,
    };

    let pr = GitHubPullRequest {
        number: 99,
        title: "Feature PR".to_string(),
        body: Some("Adds new feature".to_string()),
        state: PullRequestState::Open,
        draft: false,
        merged: false,
        mergeable: Some(true),
        mergeable_state: MergeableState::Mergeable,
        user: user.clone(),
        head: GitHubBranchRef {
            branch_ref: "feature/new".to_string(),
            label: "user:feature/new".to_string(),
            sha: "abc123".to_string(),
            repo: Some(RepositoryRef {
                owner: "org".to_string(),
                repo: "project".to_string(),
            }),
        },
        base: GitHubBranchRef {
            branch_ref: "main".to_string(),
            label: "org:main".to_string(),
            sha: "def456".to_string(),
            repo: None,
        },
        assignees: vec![],
        requested_reviewers: vec![user],
        labels: vec![],
        milestone: None,
        created_at: "2024-06-01T00:00:00Z".to_string(),
        updated_at: "2024-06-02T00:00:00Z".to_string(),
        closed_at: None,
        merged_at: None,
        html_url: "https://github.com/org/project/pull/99".to_string(),
        commits: 3,
        additions: 100,
        deletions: 20,
        changed_files: 5,
    };

    let json = serde_json::to_string(&pr).unwrap();
    let parsed: GitHubPullRequest = serde_json::from_str(&json).unwrap();

    assert_eq!(parsed.number, 99);
    assert_eq!(parsed.state, PullRequestState::Open);
    assert_eq!(parsed.head.branch_ref, "feature/new");
    assert_eq!(parsed.base.branch_ref, "main");
    assert_eq!(parsed.mergeable_state, MergeableState::Mergeable);
    assert_eq!(parsed.requested_reviewers.len(), 1);
}

#[test]
fn test_github_repository_serialization() {
    let owner = GitHubUser {
        id: 1,
        login: "org".to_string(),
        name: Some("Organization".to_string()),
        avatar_url: String::new(),
        html_url: String::new(),
        user_type: UserType::Organization,
    };

    let repo = GitHubRepository {
        id: 100,
        name: "project".to_string(),
        full_name: "org/project".to_string(),
        owner,
        description: Some("A great project".to_string()),
        private: false,
        fork: false,
        default_branch: "main".to_string(),
        language: Some("Rust".to_string()),
        stargazers_count: 500,
        forks_count: 50,
        open_issues_count: 10,
        watchers_count: 100,
        html_url: "https://github.com/org/project".to_string(),
        clone_url: "https://github.com/org/project.git".to_string(),
        ssh_url: "git@github.com:org/project.git".to_string(),
        created_at: "2023-01-01T00:00:00Z".to_string(),
        updated_at: "2024-01-01T00:00:00Z".to_string(),
        pushed_at: "2024-01-01T00:00:00Z".to_string(),
        topics: vec!["rust".to_string(), "ai".to_string()],
        license: None,
    };

    let json = serde_json::to_string(&repo).unwrap();
    let parsed: GitHubRepository = serde_json::from_str(&json).unwrap();

    assert_eq!(parsed.name, "project");
    assert_eq!(parsed.language, Some("Rust".to_string()));
    assert_eq!(parsed.owner.user_type, UserType::Organization);
    assert_eq!(parsed.topics.len(), 2);
}

#[test]
fn test_enum_values() {
    // Issue states
    let open: IssueState = serde_json::from_str("\"open\"").unwrap();
    assert_eq!(open, IssueState::Open);
    let closed: IssueState = serde_json::from_str("\"closed\"").unwrap();
    assert_eq!(closed, IssueState::Closed);

    // PR states
    let open: PullRequestState = serde_json::from_str("\"open\"").unwrap();
    assert_eq!(open, PullRequestState::Open);

    // Review states
    let approved: ReviewState = serde_json::from_str("\"APPROVED\"").unwrap();
    assert_eq!(approved, ReviewState::Approved);
    let changes: ReviewState = serde_json::from_str("\"CHANGES_REQUESTED\"").unwrap();
    assert_eq!(changes, ReviewState::ChangesRequested);

    // Merge methods
    let merge: MergeMethod = serde_json::from_str("\"merge\"").unwrap();
    assert_eq!(merge, MergeMethod::Merge);
    let squash: MergeMethod = serde_json::from_str("\"squash\"").unwrap();
    assert_eq!(squash, MergeMethod::Squash);
    let rebase: MergeMethod = serde_json::from_str("\"rebase\"").unwrap();
    assert_eq!(rebase, MergeMethod::Rebase);

    // Mergeable states
    let mergeable: MergeableState = serde_json::from_str("\"mergeable\"").unwrap();
    assert_eq!(mergeable, MergeableState::Mergeable);
    let conflicting: MergeableState = serde_json::from_str("\"conflicting\"").unwrap();
    assert_eq!(conflicting, MergeableState::Conflicting);

    // Review events
    let approve: ReviewEvent = serde_json::from_str("\"APPROVE\"").unwrap();
    assert_eq!(approve, ReviewEvent::Approve);

    // Event types
    let push: GitHubEventType = serde_json::from_str("\"push\"").unwrap();
    assert_eq!(push, GitHubEventType::Push);
    let pr: GitHubEventType = serde_json::from_str("\"pull_request\"").unwrap();
    assert_eq!(pr, GitHubEventType::PullRequest);
}

// =============================================================================
// Error Tests
// =============================================================================

#[test]
fn test_error_types() {
    use elizaos_plugin_github::GitHubError;

    let err = GitHubError::MissingSetting("TOKEN".to_string());
    assert!(err.to_string().contains("TOKEN"));
    assert!(!err.is_retryable());
    assert!(err.retry_after_ms().is_none());

    let err = GitHubError::ConfigError("bad config".to_string());
    assert!(err.to_string().contains("bad config"));
    assert!(!err.is_retryable());

    let err = GitHubError::ClientNotInitialized;
    assert!(!err.is_retryable());
}

#[test]
fn test_retryable_errors() {
    use elizaos_plugin_github::GitHubError;

    let err = GitHubError::RateLimited {
        retry_after_ms: 5000,
        remaining: 0,
        reset_at: chrono::Utc::now(),
    };
    assert!(err.is_retryable());
    assert_eq!(err.retry_after_ms(), Some(5000));

    let err = GitHubError::SecondaryRateLimit {
        retry_after_ms: 30000,
    };
    assert!(err.is_retryable());
    assert_eq!(err.retry_after_ms(), Some(30000));

    let err = GitHubError::Timeout {
        timeout_ms: 10000,
        operation: "test".to_string(),
    };
    assert!(err.is_retryable());
    assert_eq!(err.retry_after_ms(), Some(5000)); // half

    let err = GitHubError::NetworkError("connection refused".to_string());
    assert!(err.is_retryable());
}

// =============================================================================
// Service Tests (without credentials)
// =============================================================================

#[test]
fn test_service_creation() {
    use elizaos_plugin_github::GitHubService;

    let config = GitHubConfig::new("test_token".to_string());
    let service = GitHubService::new(config);
    assert_eq!(service.config().api_token, "test_token");
    assert_eq!(service.config().branch, "main");
}

#[tokio::test]
async fn test_service_not_running() {
    use elizaos_plugin_github::GitHubService;

    let config = GitHubConfig::new("test_token".to_string());
    let service = GitHubService::new(config);
    assert!(!service.is_running().await);
}

#[tokio::test]
async fn test_service_get_repo_fails_without_start() {
    use elizaos_plugin_github::GitHubService;

    let config = GitHubConfig::new("test_token".to_string())
        .with_owner("org".to_string())
        .with_repo("repo".to_string());
    let service = GitHubService::new(config);

    let result = service.get_repository("org", "repo").await;
    assert!(result.is_err());
}
