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
};

#[test]
fn test_plugin_metadata() {
    assert_eq!(PLUGIN_NAME, "github");
    assert!(!PLUGIN_VERSION.is_empty());
}

#[test]
fn test_config_new() {
    let config = GitHubConfig::new("test_token".to_string());
    assert_eq!(config.api_token, "test_token");
    assert_eq!(config.branch, "main");
    assert!(config.owner.is_none());
    assert!(config.repo.is_none());
}

#[test]
fn test_config_builder() {
    let config = GitHubConfig::new("test_token".to_string())
        .with_owner("test-owner".to_string())
        .with_repo("test-repo".to_string())
        .with_branch("develop".to_string());

    assert_eq!(config.owner, Some("test-owner".to_string()));
    assert_eq!(config.repo, Some("test-repo".to_string()));
    assert_eq!(config.branch, "develop");
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

    // Override
    let (owner, repo) = config
        .get_repository_ref(Some("override-owner"), Some("override-repo"))
        .unwrap();
    assert_eq!(owner, "override-owner");
    assert_eq!(repo, "override-repo");

    // Partial override
    let (owner, repo) = config
        .get_repository_ref(Some("override-owner"), None)
        .unwrap();
    assert_eq!(owner, "override-owner");
    assert_eq!(repo, "default-repo");
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
    assert!(names.contains(&"CREATE_GITHUB_ISSUE"));
    assert!(names.contains(&"CREATE_GITHUB_PULL_REQUEST"));
    assert!(names.contains(&"CREATE_GITHUB_COMMENT"));
    assert!(names.contains(&"CREATE_GITHUB_BRANCH"));
    assert!(names.contains(&"MERGE_GITHUB_PULL_REQUEST"));
    assert!(names.contains(&"PUSH_GITHUB_CODE"));
    assert!(names.contains(&"REVIEW_GITHUB_PULL_REQUEST"));
}

#[tokio::test]
async fn test_push_code_action_validate() {
    let action = PushCodeAction;

    let context = ActionContext {
        message: serde_json::json!({
            "content": { "text": "Push these changes to the repository" }
        }),
        owner: "test".to_string(),
        repo: "test".to_string(),
        state: serde_json::json!({}),
    };

    assert!(action.validate(&context).await.unwrap());
}

#[tokio::test]
async fn test_push_code_action_validate_commit() {
    let action = PushCodeAction;

    let context = ActionContext {
        message: serde_json::json!({
            "content": { "text": "Commit this file" }
        }),
        owner: "test".to_string(),
        repo: "test".to_string(),
        state: serde_json::json!({}),
    };

    assert!(action.validate(&context).await.unwrap());
}

#[tokio::test]
async fn test_push_code_action_no_keywords() {
    let action = PushCodeAction;

    let context = ActionContext {
        message: serde_json::json!({
            "content": { "text": "Hello world" }
        }),
        owner: "test".to_string(),
        repo: "test".to_string(),
        state: serde_json::json!({}),
    };

    assert!(!action.validate(&context).await.unwrap());
}

#[tokio::test]
async fn test_review_pr_action_validate() {
    let action = ReviewPullRequestAction;

    let context = ActionContext {
        message: serde_json::json!({
            "content": { "text": "Review this pull request" }
        }),
        owner: "test".to_string(),
        repo: "test".to_string(),
        state: serde_json::json!({}),
    };

    assert!(action.validate(&context).await.unwrap());
}

#[tokio::test]
async fn test_review_pr_action_validate_approve() {
    let action = ReviewPullRequestAction;

    let context = ActionContext {
        message: serde_json::json!({
            "content": { "text": "Approve this PR" }
        }),
        owner: "test".to_string(),
        repo: "test".to_string(),
        state: serde_json::json!({}),
    };

    assert!(action.validate(&context).await.unwrap());
}

#[tokio::test]
async fn test_review_pr_action_validate_lgtm() {
    let action = ReviewPullRequestAction;

    let context = ActionContext {
        message: serde_json::json!({
            "content": { "text": "LGTM on this change" }
        }),
        owner: "test".to_string(),
        repo: "test".to_string(),
        state: serde_json::json!({}),
    };

    assert!(action.validate(&context).await.unwrap());
}

#[tokio::test]
async fn test_review_pr_action_no_keywords() {
    let action = ReviewPullRequestAction;

    let context = ActionContext {
        message: serde_json::json!({
            "content": { "text": "Hello world" }
        }),
        owner: "test".to_string(),
        repo: "test".to_string(),
        state: serde_json::json!({}),
    };

    assert!(!action.validate(&context).await.unwrap());
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
