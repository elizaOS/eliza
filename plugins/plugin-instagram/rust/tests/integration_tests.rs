//! Integration tests for elizaOS Plugin Instagram
//!
//! These tests verify Instagram operations work correctly.

use elizaos_plugin_instagram::{InstagramConfig, InstagramService, MAX_DM_LENGTH};
use elizaos_plugin_instagram::service::split_message;

/// Test configuration loading from environment
#[test]
fn test_config_from_env() {
    std::env::set_var("INSTAGRAM_USERNAME", "testuser");
    std::env::set_var("INSTAGRAM_PASSWORD", "testpass");

    let config = InstagramConfig::from_env();

    std::env::remove_var("INSTAGRAM_USERNAME");
    std::env::remove_var("INSTAGRAM_PASSWORD");

    assert!(config.is_ok(), "Config should load successfully: {:?}", config.err());

    let config = config.unwrap();
    assert_eq!(config.username, "testuser");
}

/// Test configuration validation
#[test]
fn test_config_validation() {
    let config = InstagramConfig::new("".to_string(), "testpass".to_string());
    assert!(config.validate().is_err(), "Empty username should fail validation");

    let config = InstagramConfig::new("testuser".to_string(), "".to_string());
    assert!(config.validate().is_err(), "Empty password should fail validation");

    let config = InstagramConfig::new("test@user".to_string(), "testpass".to_string());
    assert!(config.validate().is_err(), "Username with @ should fail validation");

    let config = InstagramConfig::new("testuser".to_string(), "testpass".to_string());
    assert!(config.validate().is_ok(), "Valid config should pass validation");
}

/// Test service creation
#[test]
fn test_service_creation() {
    let config = InstagramConfig::new("testuser".to_string(), "testpass".to_string());
    let service = InstagramService::new(config);
    assert!(!service.config().username.is_empty());
}

/// Test message splitting
#[test]
fn test_message_splitting() {
    // Short message - no splitting needed
    let short_msg = "Hello, world!";
    let parts = split_message(short_msg, MAX_DM_LENGTH);
    assert_eq!(parts.len(), 1);
    assert_eq!(parts[0], short_msg);

    // Long message - should be split
    let long_msg = "a".repeat(MAX_DM_LENGTH + 500);
    let parts = split_message(&long_msg, MAX_DM_LENGTH);
    assert!(parts.len() > 1);
    for part in &parts {
        assert!(part.len() <= MAX_DM_LENGTH);
    }
}

/// Test service start/stop
#[tokio::test]
async fn test_service_lifecycle() {
    let config = InstagramConfig::new("testuser".to_string(), "testpass".to_string());
    let mut service = InstagramService::new(config);

    assert!(!service.is_running().await);

    service.start().await.unwrap();
    assert!(service.is_running().await);

    let user = service.logged_in_user().await;
    assert!(user.is_some());
    assert_eq!(user.unwrap().username, "testuser");

    service.stop().await.unwrap();
    assert!(!service.is_running().await);
    assert!(service.logged_in_user().await.is_none());
}

/// Test service operations without running
#[tokio::test]
async fn test_operations_without_running() {
    let config = InstagramConfig::new("testuser".to_string(), "testpass".to_string());
    let service = InstagramService::new(config);

    let result = service.send_direct_message("thread-1", "Hello").await;
    assert!(result.is_err());

    let result = service.post_comment(12345, "Nice!").await;
    assert!(result.is_err());

    let result = service.like_media(12345).await;
    assert!(result.is_err());

    let result = service.follow_user(12345).await;
    assert!(result.is_err());
}

/// Test action validation
#[tokio::test]
async fn test_send_dm_action() {
    use elizaos_plugin_instagram::actions::{ActionContext, InstagramAction, SendDmAction};
    use serde_json::json;

    let action = SendDmAction;

    // Valid context
    let context = ActionContext {
        message: json!({
            "source": "instagram",
            "text": "Hello"
        }),
        user_id: 12345,
        thread_id: Some("thread-1".to_string()),
        media_id: None,
        state: json!({}),
    };

    let is_valid = action.validate(&context).await.unwrap();
    assert!(is_valid);

    // Invalid source
    let context = ActionContext {
        message: json!({
            "source": "telegram",
        }),
        user_id: 12345,
        thread_id: Some("thread-1".to_string()),
        media_id: None,
        state: json!({}),
    };

    let is_valid = action.validate(&context).await.unwrap();
    assert!(!is_valid);
}

/// Test provider output
#[tokio::test]
async fn test_user_state_provider() {
    use elizaos_plugin_instagram::providers::{InstagramProvider, ProviderContext, UserStateProvider};

    let provider = UserStateProvider;
    let context = ProviderContext {
        user_id: Some(12345),
        thread_id: Some("thread-1".to_string()),
        media_id: None,
        room_id: Some("room-uuid".to_string()),
    };

    let state = provider.get(&context).await;
    assert_eq!(state["user_id"], 12345);
    assert_eq!(state["is_dm"], true);
}
