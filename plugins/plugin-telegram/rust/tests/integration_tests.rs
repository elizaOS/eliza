//! Integration tests for elizaOS Plugin Telegram
//!
//! These tests verify Telegram operations work correctly.
//!
//! # Running Tests
//!
//! Set the following environment variables:
//! - `TELEGRAM_BOT_TOKEN`: Bot token from BotFather
//! - `TELEGRAM_TEST_CHAT_ID`: Chat ID for testing
//!
//! Then run:
//! ```bash
//! cargo test --features native -- --ignored
//! ```

use elizaos_plugin_telegram::{TelegramConfig, TelegramService};

/// Test configuration loading from environment
#[test]
fn test_config_from_env() {
    std::env::set_var("TELEGRAM_BOT_TOKEN", "123456:ABC-DEF");

    let config = TelegramConfig::from_env();

    std::env::remove_var("TELEGRAM_BOT_TOKEN");

    assert!(
        config.is_ok(),
        "Config should load successfully: {:?}",
        config.err()
    );

    let config = config.unwrap();
    assert_eq!(config.bot_token, "123456:ABC-DEF");
}

/// Test configuration validation
#[test]
fn test_config_validation() {
    let config = TelegramConfig::new("".to_string());
    assert!(
        config.validate().is_err(),
        "Empty token should fail validation"
    );

    let config = TelegramConfig::new("invalid_token".to_string());
    assert!(
        config.validate().is_err(),
        "Invalid token format should fail validation"
    );

    let config = TelegramConfig::new("123456:ABC-DEF".to_string());
    assert!(
        config.validate().is_ok(),
        "Valid config should pass validation"
    );
}

/// Test service creation
#[test]
fn test_service_creation() {
    let config = TelegramConfig::new("123456:ABC-DEF".to_string());
    let service = TelegramService::new(config);
    assert!(!service.config().bot_token.is_empty());
}

/// Test message splitting
#[test]
fn test_message_splitting() {
    use elizaos_plugin_telegram::service::{split_message, MAX_MESSAGE_LENGTH};

    // Short message - no splitting needed
    let short_msg = "Hello, world!";
    let parts = split_message(short_msg);
    assert_eq!(parts.len(), 1);
    assert_eq!(parts[0], short_msg);

    // Long message - should be split
    let long_msg = "a".repeat(MAX_MESSAGE_LENGTH + 500);
    let parts = split_message(&long_msg);
    assert!(parts.len() > 1);
    for part in &parts {
        assert!(part.len() <= MAX_MESSAGE_LENGTH);
    }
}

/// Test chat allowed check
#[test]
fn test_chat_allowed() {
    let config =
        TelegramConfig::new("123456:ABC-DEF".to_string()).with_allowed_chat_ids(vec![12345, 67890]);

    assert!(config.is_chat_allowed(12345));
    assert!(config.is_chat_allowed(67890));
    assert!(!config.is_chat_allowed(99999));

    // Empty allowed list = all allowed
    let config_all = TelegramConfig::new("123456:ABC-DEF".to_string());
    assert!(config_all.is_chat_allowed(99999));
}

/// Test service is not running initially
#[tokio::test]
async fn test_service_not_running() {
    let config = TelegramConfig::new("123456:ABC-DEF".to_string());
    let service = TelegramService::new(config);
    assert!(!service.is_running().await);
}

/// Test action validation
#[tokio::test]
async fn test_send_message_action() {
    use elizaos_plugin_telegram::actions::{ActionContext, SendMessageAction, TelegramAction};
    use serde_json::json;

    let action = SendMessageAction;

    // Valid context
    let context = ActionContext {
        message: json!({
            "source": "telegram",
            "text": "Hello"
        }),
        chat_id: 12345,
        user_id: 67890,
        thread_id: None,
        state: json!({}),
    };

    let is_valid = action.validate(&context).await.unwrap();
    assert!(is_valid);

    // Invalid source
    let context = ActionContext {
        message: json!({
            "source": "discord",
        }),
        chat_id: 12345,
        user_id: 67890,
        thread_id: None,
        state: json!({}),
    };

    let is_valid = action.validate(&context).await.unwrap();
    assert!(!is_valid);
}

/// Test provider output
#[tokio::test]
async fn test_chat_state_provider() {
    use elizaos_plugin_telegram::providers::{
        ChatStateProvider, ProviderContext, TelegramProvider,
    };

    let provider = ChatStateProvider;
    let context = ProviderContext {
        chat_id: Some(12345),
        user_id: Some(67890),
        thread_id: None,
        room_id: Some("room-uuid".to_string()),
    };

    let state = provider.get(&context).await;
    assert_eq!(state["chat_id"], 12345);
    assert_eq!(state["is_private"], true);
}
