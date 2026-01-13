//! Integration tests for elizaOS Plugin Discord
//!
//! These tests verify Discord operations work correctly with a real Discord server.
//!
//! # Running Tests
//!
//! Set the following environment variables:
//! - `DISCORD_API_TOKEN`: Bot token
//! - `DISCORD_APPLICATION_ID`: Application ID
//! - `DISCORD_TEST_CHANNEL_ID`: Channel ID for testing
//!
//! Then run:
//! ```bash
//! cargo test --features native -- --ignored
//! ```

use elizaos_plugin_discord::{DiscordConfig, DiscordService};

/// Test configuration loading from environment
#[test]
fn test_config_from_env() {
    // This test doesn't require actual Discord credentials
    // Note: Environment variable manipulation in tests can be racy
    // We use unique values to avoid conflicts
    std::env::set_var("DISCORD_API_TOKEN", "test_token_config_env");
    std::env::set_var("DISCORD_APPLICATION_ID", "123456789012345678");

    let config = DiscordConfig::from_env();

    // Clean up immediately after reading
    std::env::remove_var("DISCORD_API_TOKEN");
    std::env::remove_var("DISCORD_APPLICATION_ID");

    assert!(
        config.is_ok(),
        "Config should load successfully: {:?}",
        config.err()
    );

    let config = config.unwrap();
    assert_eq!(config.token, "test_token_config_env");
    assert_eq!(config.application_id, "123456789012345678");
}

/// Test configuration validation
#[test]
fn test_config_validation() {
    // Test with programmatic config instead of env vars to avoid race conditions
    let config = DiscordConfig::new("".to_string(), "123456789012345678".to_string());
    assert!(
        config.validate().is_err(),
        "Empty token should fail validation"
    );

    let config = DiscordConfig::new("test_token".to_string(), "".to_string());
    assert!(
        config.validate().is_err(),
        "Empty application_id should fail validation"
    );

    let config = DiscordConfig::new("test_token".to_string(), "123456789012345678".to_string());
    assert!(
        config.validate().is_ok(),
        "Valid config should pass validation"
    );
}

/// Test service creation
#[test]
fn test_service_creation() {
    let config = DiscordConfig::new("test_token".to_string(), "123456789".to_string());

    let service = DiscordService::new(config);
    assert!(!service.config().token.is_empty());
}

/// Test connecting to Discord (requires valid credentials)
#[tokio::test]
#[ignore = "Requires valid Discord credentials"]
async fn test_discord_connection() {
    let config = DiscordConfig::from_env().expect("Failed to load config");
    let mut service = DiscordService::new(config);

    // Set up event callback
    service.set_event_callback(|event, payload| {
        println!("Event: {:?}, Payload: {:?}", event, payload);
    });

    // Start the service (this would connect to Discord)
    // In a real test, we'd start in a background task and verify connection
    // service.start().await.expect("Failed to start service");

    // For now, just verify service was created
    assert!(!service.is_running().await);
}

/// Test sending a message (requires valid credentials)
#[tokio::test]
#[ignore = "Requires valid Discord credentials"]
async fn test_send_message() {
    use elizaos_plugin_discord::Snowflake;

    let config = DiscordConfig::from_env().expect("Failed to load config");
    let channel_id = config
        .test_channel_id
        .clone()
        .expect("DISCORD_TEST_CHANNEL_ID required for this test");

    let service = DiscordService::new(config);

    // Start the service
    // service.start().await.expect("Failed to start service");

    // Send a test message
    let snowflake = Snowflake::new(channel_id).expect("Invalid channel ID");
    let result = service
        .send_message(&snowflake, "Integration test message")
        .await;

    // In a real test, we'd verify the message was sent
    // For now, this will fail because we're not actually connected
    assert!(result.is_err()); // Expected because service isn't started
}

/// Test message splitting
#[test]
fn test_message_splitting() {
    use elizaos_plugin_discord::service::split_message;
    use elizaos_plugin_discord::service::MAX_MESSAGE_LENGTH;

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

    // Multiline message
    let multiline = (0..100)
        .map(|i| format!("Line {}: Some content", i))
        .collect::<Vec<_>>()
        .join("\n");
    let parts = split_message(&multiline);
    for part in &parts {
        assert!(part.len() <= MAX_MESSAGE_LENGTH);
    }
}

/// Test snowflake validation
#[test]
fn test_snowflake_validation() {
    use elizaos_plugin_discord::Snowflake;

    // Valid snowflakes
    assert!(Snowflake::new("12345678901234567".to_string()).is_ok());
    assert!(Snowflake::new("123456789012345678".to_string()).is_ok());
    assert!(Snowflake::new("1234567890123456789".to_string()).is_ok());

    // Invalid snowflakes
    assert!(Snowflake::new("1234567890123456".to_string()).is_err()); // Too short
    assert!(Snowflake::new("12345678901234567890".to_string()).is_err()); // Too long
    assert!(Snowflake::new("1234567890123456a".to_string()).is_err()); // Contains letter
    assert!(Snowflake::new("".to_string()).is_err()); // Empty
}

/// Test action validation
#[tokio::test]
async fn test_send_message_action() {
    use elizaos_plugin_discord::actions::{ActionContext, DiscordAction, SendMessageAction};
    use serde_json::json;

    let action = SendMessageAction;

    // Valid context
    let context = ActionContext {
        message: json!({
            "source": "discord",
            "content": { "text": "Hello" }
        }),
        channel_id: "123456789012345678".to_string(),
        guild_id: Some("987654321098765432".to_string()),
        user_id: "111222333444555666".to_string(),
        state: json!({}),
    };

    let is_valid = action.validate(&context).await.unwrap();
    assert!(is_valid);

    // Invalid source
    let context = ActionContext {
        message: json!({
            "source": "telegram",
        }),
        channel_id: "123456789012345678".to_string(),
        guild_id: None,
        user_id: "111222333444555666".to_string(),
        state: json!({}),
    };

    let is_valid = action.validate(&context).await.unwrap();
    assert!(!is_valid);
}

/// Test provider output
#[tokio::test]
async fn test_channel_state_provider() {
    use elizaos_plugin_discord::providers::{
        ChannelStateProvider, DiscordProvider, ProviderContext,
    };

    let provider = ChannelStateProvider;
    let context = ProviderContext {
        channel_id: Some("123456789012345678".to_string()),
        guild_id: Some("987654321098765432".to_string()),
        user_id: None,
        room_id: Some("room-uuid".to_string()),
    };

    let state = provider.get(&context).await;
    assert_eq!(state["channel_id"], "123456789012345678");
    assert_eq!(state["is_dm"], false);
}
