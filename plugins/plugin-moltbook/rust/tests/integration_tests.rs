//! Integration tests for moltbook plugin.

use elizaos_plugin_moltbook::constants::{
    content_limits, autonomy_defaults, urls, DEFAULT_SUBMOLT, MOLTBOOK_SERVICE_NAME,
};
use elizaos_plugin_moltbook::error::MoltbookError;
use elizaos_plugin_moltbook::service::MoltbookService;
use elizaos_plugin_moltbook::types::*;

// ==================== Config Tests ====================

#[test]
fn test_moltbook_config_construction() {
    let config = MoltbookConfig {
        agent_name: "TestBot".to_string(),
        moltbook_token: Some("test-token".to_string()),
        autonomous_mode: false,
        autonomy_interval_ms: Some(60_000),
        autonomy_max_steps: Some(100),
    };

    assert_eq!(config.agent_name, "TestBot");
    assert_eq!(config.moltbook_token, Some("test-token".to_string()));
    assert!(!config.autonomous_mode);
    assert_eq!(config.autonomy_interval_ms, Some(60_000));
    assert_eq!(config.autonomy_max_steps, Some(100));
}

#[test]
fn test_moltbook_config_without_token() {
    let config = MoltbookConfig {
        agent_name: "TestBot".to_string(),
        moltbook_token: None,
        autonomous_mode: false,
        autonomy_interval_ms: None,
        autonomy_max_steps: None,
    };

    assert!(config.moltbook_token.is_none());
    assert!(config.autonomy_interval_ms.is_none());
}

// ==================== Constants Tests ====================

#[test]
fn test_service_name() {
    assert_eq!(MOLTBOOK_SERVICE_NAME, "moltbook");
}

#[test]
fn test_urls() {
    assert_eq!(urls::MOLTBOOK, "https://www.moltbook.com/api/v1");
    assert_eq!(urls::OPENROUTER, "https://openrouter.ai/api/v1");
}

#[test]
fn test_autonomy_defaults() {
    assert_eq!(autonomy_defaults::MIN_INTERVAL_MS, 30_000);
    assert_eq!(autonomy_defaults::MAX_INTERVAL_MS, 90_000);
    assert_eq!(autonomy_defaults::MAX_TOOL_CALLS, 5);
    assert_eq!(
        autonomy_defaults::DEFAULT_MODEL,
        "deepseek/deepseek-chat-v3-0324"
    );
}

#[test]
fn test_content_limits() {
    assert_eq!(content_limits::DEFAULT_BROWSE_LIMIT, 10);
    assert_eq!(content_limits::MAX_CONTENT_LENGTH, 10_000);
    assert_eq!(content_limits::MAX_TITLE_LENGTH, 300);
    assert_eq!(content_limits::MAX_COMMENT_LENGTH, 5_000);
}

#[test]
fn test_default_submolt() {
    assert_eq!(DEFAULT_SUBMOLT, "iq");
}

// ==================== Service Tests ====================

#[test]
fn test_service_new_with_valid_config() {
    let config = MoltbookConfig {
        agent_name: "TestAgent".to_string(),
        moltbook_token: Some("token".to_string()),
        autonomous_mode: false,
        autonomy_interval_ms: None,
        autonomy_max_steps: None,
    };

    let service = MoltbookService::new(config);
    assert!(service.is_ok());
}

#[test]
fn test_service_new_with_empty_agent_name() {
    let config = MoltbookConfig {
        agent_name: String::new(),
        moltbook_token: Some("token".to_string()),
        autonomous_mode: false,
        autonomy_interval_ms: None,
        autonomy_max_steps: None,
    };

    let result = MoltbookService::new(config);
    assert!(result.is_err());
    let err = result.err().unwrap();
    assert!(
        matches!(err, MoltbookError::Configuration(_)),
        "Expected Configuration error, got: {:?}",
        err
    );
}

#[test]
fn test_service_new_with_whitespace_agent_name() {
    let config = MoltbookConfig {
        agent_name: "   ".to_string(),
        moltbook_token: Some("token".to_string()),
        autonomous_mode: false,
        autonomy_interval_ms: None,
        autonomy_max_steps: None,
    };

    let result = MoltbookService::new(config);
    assert!(result.is_err());
}

#[test]
fn test_service_without_token() {
    let config = MoltbookConfig {
        agent_name: "TestAgent".to_string(),
        moltbook_token: None,
        autonomous_mode: false,
        autonomy_interval_ms: None,
        autonomy_max_steps: None,
    };

    let service = MoltbookService::new(config).unwrap();
    assert!(service.config().moltbook_token.is_none());
    assert!(!service.is_autonomy_running());
}

#[test]
fn test_service_type_constant() {
    assert_eq!(MoltbookService::SERVICE_TYPE, "moltbook");
}

// ==================== Type Tests ====================

#[test]
fn test_moltbook_post_serialization() {
    let post = MoltbookPost {
        id: "post-1".to_string(),
        title: "Hello World".to_string(),
        content: Some("This is my first post".to_string()),
        body: None,
        submolt: Some(MoltbookSubmoltRef {
            name: "iq".to_string(),
            extra: std::collections::HashMap::new(),
        }),
        author: Some(MoltbookAuthor {
            name: "TestBot".to_string(),
            extra: std::collections::HashMap::new(),
        }),
        upvotes: Some(42),
        comment_count: Some(5),
        created_at: Some("2025-01-01T00:00:00Z".to_string()),
    };

    let json = serde_json::to_string(&post).unwrap();
    assert!(json.contains("post-1"));
    assert!(json.contains("Hello World"));
    assert!(json.contains("TestBot"));
    assert!(json.contains("42"));
}

#[test]
fn test_moltbook_post_deserialization() {
    let json = r#"{
        "id": "abc123",
        "title": "Test Post",
        "content": "Some content",
        "upvotes": 10,
        "comment_count": 3
    }"#;

    let post: MoltbookPost = serde_json::from_str(json).unwrap();
    assert_eq!(post.id, "abc123");
    assert_eq!(post.title, "Test Post");
    assert_eq!(post.content, Some("Some content".to_string()));
    assert_eq!(post.upvotes, Some(10));
    assert_eq!(post.comment_count, Some(3));
    assert!(post.submolt.is_none());
    assert!(post.author.is_none());
}

#[test]
fn test_moltbook_comment_serialization() {
    let comment = MoltbookComment {
        id: "comment-1".to_string(),
        content: "Great post!".to_string(),
        author: Some(MoltbookAuthor {
            name: "Replier".to_string(),
            extra: std::collections::HashMap::new(),
        }),
        created_at: None,
        parent_id: None,
    };

    let json = serde_json::to_string(&comment).unwrap();
    assert!(json.contains("comment-1"));
    assert!(json.contains("Great post!"));
    assert!(json.contains("Replier"));
}

#[test]
fn test_moltbook_comment_with_parent() {
    let comment = MoltbookComment {
        id: "reply-1".to_string(),
        content: "Thanks!".to_string(),
        author: None,
        created_at: None,
        parent_id: Some("comment-1".to_string()),
    };

    let json = serde_json::to_string(&comment).unwrap();
    assert!(json.contains("comment-1"));
    assert!(json.contains("reply-1"));
}

#[test]
fn test_moltbook_submolt_serialization() {
    let submolt = MoltbookSubmolt {
        id: "submolt-1".to_string(),
        name: "technology".to_string(),
        description: Some("Tech discussions".to_string()),
        subscriber_count: Some(1000),
        post_count: Some(500),
        created_at: Some("2024-01-01".to_string()),
        icon_url: None,
    };

    let json = serde_json::to_string(&submolt).unwrap();
    assert!(json.contains("technology"));
    assert!(json.contains("Tech discussions"));
    assert!(json.contains("1000"));
}

#[test]
fn test_moltbook_submolt_deserialization() {
    let json = r#"{
        "id": "s1",
        "name": "iq",
        "description": "IQ discussions",
        "subscriber_count": 500
    }"#;

    let submolt: MoltbookSubmolt = serde_json::from_str(json).unwrap();
    assert_eq!(submolt.id, "s1");
    assert_eq!(submolt.name, "iq");
    assert_eq!(submolt.description, Some("IQ discussions".to_string()));
    assert_eq!(submolt.subscriber_count, Some(500));
    assert!(submolt.post_count.is_none());
}

// ==================== MoltbookResult Tests ====================

#[test]
fn test_moltbook_result_success() {
    let result: MoltbookResult<Vec<String>> = moltbook_success(vec!["a".to_string()]);
    assert!(result.is_success());
    assert_eq!(result.data().unwrap().len(), 1);
    assert!(result.error().is_none());
}

#[test]
fn test_moltbook_result_failure() {
    let result: MoltbookResult<Vec<String>> = moltbook_failure("API error");
    assert!(!result.is_success());
    assert!(result.data().is_none());
    assert_eq!(result.error(), Some("API error"));
}

// ==================== ActionResult Tests ====================

#[test]
fn test_action_result_success() {
    let result = ActionResult::success("Operation completed");
    assert!(result.success);
    assert_eq!(result.text, "Operation completed");
    assert!(result.data.is_none());
}

#[test]
fn test_action_result_success_with_data() {
    let data = serde_json::json!({"postId": "123"});
    let result = ActionResult::success_with_data("Created post", data.clone());
    assert!(result.success);
    assert_eq!(result.text, "Created post");
    assert!(result.data.is_some());
    assert_eq!(result.data.unwrap()["postId"], "123");
}

#[test]
fn test_action_result_error() {
    let result = ActionResult::error("Something went wrong");
    assert!(!result.success);
    assert_eq!(result.text, "Something went wrong");
    assert!(result.data.is_none());
}

// ==================== ProviderResult Tests ====================

#[test]
fn test_provider_result_new() {
    let result = ProviderResult::new("Provider data");
    assert_eq!(result.text, "Provider data");
    assert!(result.data.is_none());
}

#[test]
fn test_provider_result_with_data() {
    let data = serde_json::json!({"available": true, "posts": []});
    let result = ProviderResult::with_data("Moltbook state", data.clone());
    assert_eq!(result.text, "Moltbook state");
    assert!(result.data.is_some());
    assert_eq!(result.data.unwrap()["available"], true);
}

// ==================== Event Types Tests ====================

#[test]
fn test_event_types() {
    assert_eq!(event_types::POST_CREATED, "moltbook.post.created");
    assert_eq!(event_types::COMMENT_CREATED, "moltbook.comment.created");
    assert_eq!(event_types::POSTS_BROWSED, "moltbook.posts.browsed");
    assert_eq!(event_types::POST_READ, "moltbook.post.read");
    assert_eq!(
        event_types::AUTONOMY_STEP_COMPLETED,
        "moltbook.autonomy.step.completed"
    );
    assert_eq!(
        event_types::AUTONOMY_STARTED,
        "moltbook.autonomy.started"
    );
    assert_eq!(
        event_types::AUTONOMY_STOPPED,
        "moltbook.autonomy.stopped"
    );
}

// ==================== Payload Tests ====================

#[test]
fn test_post_payload_serialization() {
    let payload = MoltbookPostPayload {
        post_id: "post-123".to_string(),
        submolt: "iq".to_string(),
        title: "Test Post".to_string(),
    };

    let json = serde_json::to_string(&payload).unwrap();
    assert!(json.contains("post-123"));
    assert!(json.contains("iq"));
    assert!(json.contains("Test Post"));
}

#[test]
fn test_comment_payload_serialization() {
    let payload = MoltbookCommentPayload {
        comment_id: "comment-456".to_string(),
        post_id: "post-123".to_string(),
        parent_id: Some("comment-100".to_string()),
    };

    let json = serde_json::to_string(&payload).unwrap();
    assert!(json.contains("comment-456"));
    assert!(json.contains("post-123"));
    assert!(json.contains("comment-100"));
}

#[test]
fn test_comment_payload_without_parent() {
    let payload = MoltbookCommentPayload {
        comment_id: "comment-789".to_string(),
        post_id: "post-456".to_string(),
        parent_id: None,
    };

    let json = serde_json::to_string(&payload).unwrap();
    assert!(json.contains("comment-789"));
    assert!(!json.contains("parent_id"));
}

#[test]
fn test_autonomy_step_payload_serialization() {
    let payload = MoltbookAutonomyStepPayload {
        step_number: 5,
        action: "POST".to_string(),
        result: "Success".to_string(),
        timestamp: "2025-01-01T00:00:00Z".to_string(),
    };

    let json = serde_json::to_string(&payload).unwrap();
    assert!(json.contains("5"));
    assert!(json.contains("POST"));
    assert!(json.contains("Success"));
}

// ==================== Plugin Tests ====================

#[test]
fn test_plugin_metadata() {
    let plugin = &elizaos_plugin_moltbook::PLUGIN;
    assert_eq!(plugin.name, "@elizaos/plugin-moltbook-rs");
    assert!(plugin.description.contains("Moltbook"));
}

#[test]
fn test_plugin_actions() {
    let actions = elizaos_plugin_moltbook::MoltbookPlugin::actions();
    assert_eq!(actions.len(), 5);
    assert!(actions.contains(&"MOLTBOOK_POST"));
    assert!(actions.contains(&"MOLTBOOK_BROWSE"));
    assert!(actions.contains(&"MOLTBOOK_COMMENT"));
    assert!(actions.contains(&"MOLTBOOK_READ"));
    assert!(actions.contains(&"MOLTBOOK_SUBMOLTS"));
}

#[test]
fn test_plugin_providers() {
    let providers = elizaos_plugin_moltbook::MoltbookPlugin::providers();
    assert_eq!(providers.len(), 1);
    assert!(providers.contains(&"MOLTBOOK_STATE"));
}

#[test]
fn test_plugin_default() {
    let plugin = elizaos_plugin_moltbook::MoltbookPlugin::default();
    assert_eq!(plugin.name, "@elizaos/plugin-moltbook-rs");
}

// ==================== PostWithComments Tests ====================

#[test]
fn test_post_with_comments() {
    let pwc = PostWithComments {
        post: MoltbookPost {
            id: "p1".to_string(),
            title: "Test".to_string(),
            content: Some("Content".to_string()),
            body: None,
            submolt: None,
            author: None,
            upvotes: Some(5),
            comment_count: Some(2),
            created_at: None,
        },
        comments: vec![
            MoltbookComment {
                id: "c1".to_string(),
                content: "Nice!".to_string(),
                author: None,
                created_at: None,
                parent_id: None,
            },
            MoltbookComment {
                id: "c2".to_string(),
                content: "Thanks!".to_string(),
                author: None,
                created_at: None,
                parent_id: Some("c1".to_string()),
            },
        ],
    };

    assert_eq!(pwc.post.id, "p1");
    assert_eq!(pwc.comments.len(), 2);
    assert_eq!(pwc.comments[1].parent_id, Some("c1".to_string()));
}
