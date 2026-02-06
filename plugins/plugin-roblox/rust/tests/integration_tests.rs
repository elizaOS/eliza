use elizaos_plugin_roblox::{RobloxClient, RobloxConfig, RobloxError};

// ── Config ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_config_creation() {
    let config = RobloxConfig::new("test-api-key", "12345678")
        .with_place_id("87654321")
        .with_messaging_topic("test-topic")
        .with_dry_run(true);

    assert_eq!(config.api_key, "test-api-key");
    assert_eq!(config.universe_id, "12345678");
    assert_eq!(config.place_id, Some("87654321".to_string()));
    assert_eq!(config.messaging_topic, "test-topic");
    assert!(config.dry_run);
}

#[tokio::test]
async fn test_config_builder_full_chain() {
    let config = RobloxConfig::new("key", "uid")
        .with_place_id("pid")
        .with_webhook_secret("secret123")
        .with_messaging_topic("my-topic")
        .with_poll_interval(120)
        .with_dry_run(true);

    assert_eq!(config.place_id, Some("pid".to_string()));
    assert_eq!(config.webhook_secret, Some("secret123".to_string()));
    assert_eq!(config.messaging_topic, "my-topic");
    assert_eq!(config.poll_interval, 120);
    assert!(config.dry_run);
}

#[test]
fn test_config_validate_success() {
    let config = RobloxConfig::new("test-key", "12345");
    assert!(config.validate().is_ok());
}

#[test]
fn test_config_validate_empty_api_key() {
    let config = RobloxConfig::new("", "12345");
    let err = config.validate().unwrap_err();
    assert!(err.to_string().contains("API key"));
}

#[test]
fn test_config_validate_empty_universe_id() {
    let config = RobloxConfig::new("key", "");
    let err = config.validate().unwrap_err();
    assert!(err.to_string().contains("Universe ID"));
}

#[test]
fn test_config_defaults() {
    let config = RobloxConfig::new("key", "uid");
    assert_eq!(config.messaging_topic, elizaos_plugin_roblox::defaults::MESSAGING_TOPIC);
    assert_eq!(config.poll_interval, elizaos_plugin_roblox::defaults::POLL_INTERVAL);
    assert!(!config.dry_run);
    assert!(config.place_id.is_none());
    assert!(config.webhook_secret.is_none());
}

// ── Client ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_client_creation() {
    let config = RobloxConfig::new("test-api-key", "12345678").with_dry_run(true);
    let client = RobloxClient::new(config).expect("Failed to create client");
    assert!(client.is_dry_run());
}

#[tokio::test]
async fn test_client_creation_non_dry_run() {
    let config = RobloxConfig::new("test-api-key", "12345678");
    let client = RobloxClient::new(config).expect("Failed to create client");
    assert!(!client.is_dry_run());
}

#[tokio::test]
async fn test_client_config_reference() {
    let config = RobloxConfig::new("test-api-key", "12345678")
        .with_place_id("99999")
        .with_dry_run(true);
    let client = RobloxClient::new(config).unwrap();

    let cfg = client.config();
    assert_eq!(cfg.api_key, "test-api-key");
    assert_eq!(cfg.universe_id, "12345678");
    assert_eq!(cfg.place_id, Some("99999".to_string()));
}

#[tokio::test]
async fn test_dry_run_message() {
    let config = RobloxConfig::new("test-api-key", "12345678").with_dry_run(true);
    let client = RobloxClient::new(config).expect("Failed to create client");

    let result = client
        .publish_message("test-topic", "Hello from test!", None)
        .await;
    assert!(result.is_ok());
}

// ── Service lifecycle ──────────────────────────────────────────────────

#[tokio::test]
async fn test_service_lifecycle() {
    use elizaos_plugin_roblox::service::RobloxService;
    use uuid::Uuid;

    let config = RobloxConfig::new("test-key", "12345").with_dry_run(true);
    let service = RobloxService::new(config, Uuid::new_v4(), "TestAgent").unwrap();

    assert!(!service.is_running().await);
    assert_eq!(service.agent_name(), "TestAgent");

    service.start().await.unwrap();
    assert!(service.is_running().await);

    // Starting again should be a no-op
    service.start().await.unwrap();
    assert!(service.is_running().await);

    service.stop().await.unwrap();
    assert!(!service.is_running().await);

    // Stopping again should be a no-op
    service.stop().await.unwrap();
    assert!(!service.is_running().await);
}

#[tokio::test]
async fn test_service_dry_run_send_message() {
    use elizaos_plugin_roblox::service::RobloxService;
    use uuid::Uuid;

    let config = RobloxConfig::new("test-key", "12345").with_dry_run(true);
    let service = RobloxService::new(config, Uuid::new_v4(), "Agent").unwrap();
    service.start().await.unwrap();

    // In dry-run mode this should succeed without a real API call
    let result = service.send_message("Hello players!", None).await;
    assert!(result.is_ok());
}

#[tokio::test]
async fn test_service_dry_run_execute_action() {
    use elizaos_plugin_roblox::service::RobloxService;
    use uuid::Uuid;

    let config = RobloxConfig::new("test-key", "12345").with_dry_run(true);
    let service = RobloxService::new(config, Uuid::new_v4(), "Agent").unwrap();
    service.start().await.unwrap();

    let params = serde_json::json!({ "amount": 100 });
    let result = service.execute_action("give_coins", params, Some(vec![42])).await;
    assert!(result.is_ok());
}

// ── Action handlers ────────────────────────────────────────────────────

mod action_handlers {
    use elizaos_plugin_roblox::actions::{
        Action, ExecuteGameActionAction, GetPlayerInfoAction, SendGameMessageAction,
    };
    use serde_json::json;

    // ─── SEND_ROBLOX_MESSAGE ───

    #[tokio::test]
    async fn send_message_handler_with_content_and_targets() {
        let action = SendGameMessageAction;
        let params = json!({
            "content": "Event starting!",
            "target_player_ids": [10, 20, 30]
        });

        let result = action.handler(params).await.unwrap();

        assert_eq!(result["action"], "SEND_ROBLOX_MESSAGE");
        assert_eq!(result["content"], "Event starting!");
        assert_eq!(result["status"], "pending");
        let ids = result["target_player_ids"].as_array().unwrap();
        assert_eq!(ids.len(), 3);
        assert_eq!(ids[0], 10);
    }

    #[tokio::test]
    async fn send_message_handler_broadcast() {
        let action = SendGameMessageAction;
        let params = json!({ "content": "Hello everyone!" });
        let result = action.handler(params).await.unwrap();

        assert_eq!(result["content"], "Hello everyone!");
        assert!(result["target_player_ids"].is_null());
    }

    #[tokio::test]
    async fn send_message_handler_missing_content() {
        let action = SendGameMessageAction;
        let params = json!({});
        let err = action.handler(params).await.unwrap_err();

        assert!(err.contains("content"));
    }

    // ─── EXECUTE_ROBLOX_ACTION ───

    #[tokio::test]
    async fn execute_action_handler_with_params() {
        let action = ExecuteGameActionAction;
        let params = json!({
            "action_name": "give_coins",
            "parameters": { "player_id": 42, "amount": 100 }
        });

        let result = action.handler(params).await.unwrap();

        assert_eq!(result["action"], "EXECUTE_ROBLOX_ACTION");
        assert_eq!(result["action_name"], "give_coins");
        assert_eq!(result["parameters"]["amount"], 100);
        assert_eq!(result["status"], "pending");
    }

    #[tokio::test]
    async fn execute_action_handler_default_params() {
        let action = ExecuteGameActionAction;
        let params = json!({ "action_name": "start_event" });
        let result = action.handler(params).await.unwrap();

        assert_eq!(result["action_name"], "start_event");
        assert!(result["parameters"].is_object());
    }

    #[tokio::test]
    async fn execute_action_handler_missing_name() {
        let action = ExecuteGameActionAction;
        let params = json!({ "parameters": {} });
        let err = action.handler(params).await.unwrap_err();

        assert!(err.contains("action_name"));
    }

    // ─── GET_ROBLOX_PLAYER_INFO ───

    #[tokio::test]
    async fn get_player_info_handler_numeric_id() {
        let action = GetPlayerInfoAction;
        let params = json!({ "identifier": 12345 });
        let result = action.handler(params).await.unwrap();

        assert_eq!(result["action"], "GET_ROBLOX_PLAYER_INFO");
        assert_eq!(result["identifier"], 12345);
        assert_eq!(result["status"], "pending");
    }

    #[tokio::test]
    async fn get_player_info_handler_username() {
        let action = GetPlayerInfoAction;
        let params = json!({ "identifier": "CoolPlayer42" });
        let result = action.handler(params).await.unwrap();

        assert_eq!(result["identifier"], "CoolPlayer42");
    }

    #[tokio::test]
    async fn get_player_info_handler_missing_identifier() {
        let action = GetPlayerInfoAction;
        let params = json!({});
        let err = action.handler(params).await.unwrap_err();

        assert!(err.contains("identifier"));
    }
}

// ── Action metadata ────────────────────────────────────────────────────

mod action_metadata {
    use elizaos_plugin_roblox::actions::{
        get_roblox_action_names, Action, ExecuteGameActionAction, GetPlayerInfoAction,
        SendGameMessageAction, AVAILABLE_GAME_ACTION_NAMES,
    };

    #[test]
    fn action_names_list() {
        let names = get_roblox_action_names();
        assert_eq!(names.len(), 3);
        assert!(names.contains(&"SEND_ROBLOX_MESSAGE"));
        assert!(names.contains(&"EXECUTE_ROBLOX_ACTION"));
        assert!(names.contains(&"GET_ROBLOX_PLAYER_INFO"));
    }

    #[test]
    fn available_game_actions() {
        assert!(AVAILABLE_GAME_ACTION_NAMES.contains(&"give_coins"));
        assert!(AVAILABLE_GAME_ACTION_NAMES.contains(&"teleport"));
        assert!(AVAILABLE_GAME_ACTION_NAMES.contains(&"spawn_entity"));
        assert!(AVAILABLE_GAME_ACTION_NAMES.contains(&"start_event"));
    }

    #[test]
    fn send_message_similes() {
        let action = SendGameMessageAction;
        let similes = action.similes();
        assert!(!similes.is_empty());
        assert!(similes.contains(&"GAME_MESSAGE"));
    }

    #[test]
    fn send_message_examples() {
        let action = SendGameMessageAction;
        let examples = action.examples();
        assert!(examples.len() >= 2);
        assert!(!examples[0].input.is_empty());
        assert!(!examples[0].output.is_empty());
    }

    #[test]
    fn execute_action_metadata() {
        let action = ExecuteGameActionAction;
        assert_eq!(action.name(), "EXECUTE_ROBLOX_ACTION");
        assert!(!action.description().is_empty());
        assert!(!action.similes().is_empty());
    }

    #[test]
    fn get_player_info_metadata() {
        let action = GetPlayerInfoAction;
        assert_eq!(action.name(), "GET_ROBLOX_PLAYER_INFO");
        assert!(!action.description().is_empty());
        assert!(action.similes().contains(&"LOOKUP_PLAYER"));
    }
}

// ── Action validate ────────────────────────────────────────────────────

mod action_validate {
    use elizaos_plugin_roblox::actions::{
        Action, ExecuteGameActionAction, GetPlayerInfoAction, SendGameMessageAction,
    };

    #[tokio::test]
    async fn send_message_positive() {
        let a = SendGameMessageAction;
        assert!(a.validate("send a message to game players").await);
        assert!(a.validate("tell everyone in roblox").await);
        assert!(a.validate("broadcast to the game").await);
    }

    #[tokio::test]
    async fn send_message_negative() {
        let a = SendGameMessageAction;
        assert!(!a.validate("hello world").await);
        assert!(!a.validate("what is the weather").await);
    }

    #[tokio::test]
    async fn execute_action_positive() {
        let a = ExecuteGameActionAction;
        assert!(a.validate("trigger an event in the game").await);
        assert!(a.validate("spawn a monster in roblox").await);
        assert!(a.validate("give coins to player in game").await);
        assert!(a.validate("teleport to game spawn").await);
        assert!(a.validate("start event in roblox").await);
    }

    #[tokio::test]
    async fn execute_action_negative() {
        let a = ExecuteGameActionAction;
        assert!(!a.validate("hello world").await);
        assert!(!a.validate("just chatting").await);
    }

    #[tokio::test]
    async fn get_player_info_positive() {
        let a = GetPlayerInfoAction;
        assert!(a.validate("who is player 42").await);
        assert!(a.validate("lookup player info").await);
        assert!(a.validate("find player CoolDude").await);
    }

    #[tokio::test]
    async fn get_player_info_negative() {
        let a = GetPlayerInfoAction;
        assert!(!a.validate("hello world").await);
        assert!(!a.validate("send a message to everyone").await);
    }
}

// ── Provider ───────────────────────────────────────────────────────────

mod provider_tests {
    use elizaos_plugin_roblox::providers::{
        get_roblox_provider_names, GameStateInfo, GameStateProvider, Provider, ProviderParams,
    };

    #[test]
    fn provider_names() {
        let names = get_roblox_provider_names();
        assert_eq!(names, vec!["roblox-game-state"]);
    }

    #[test]
    fn provider_metadata() {
        let p = GameStateProvider;
        assert_eq!(p.name(), "roblox-game-state");
        assert_eq!(p.position(), 50);
        assert!(!p.description().is_empty());
    }

    #[tokio::test]
    async fn provider_get_disconnected() {
        let p = GameStateProvider;
        let params = ProviderParams {
            conversation_id: "conv-1".to_string(),
            agent_id: "agent-1".to_string(),
        };
        let result = p.get(params).await;

        assert!(result.text.contains("not connected"));
        assert_eq!(result.data["connected"], false);
        assert_eq!(result.values["universeId"], "N/A");
        assert_eq!(result.values["placeId"], "N/A");
    }

    #[test]
    fn game_state_full_context() {
        let state = GameStateInfo {
            universe_id: "12345".to_string(),
            place_id: Some("67890".to_string()),
            experience_name: Some("Epic Game".to_string()),
            active_players: Some(500),
            total_visits: Some(1_000_000),
            creator_name: Some("GameDev".to_string()),
            messaging_topic: "custom-topic".to_string(),
            dry_run: true,
        };

        let ctx = state.to_context_string();
        assert!(ctx.contains("12345"));
        assert!(ctx.contains("67890"));
        assert!(ctx.contains("Epic Game"));
        assert!(ctx.contains("500"));
        assert!(ctx.contains("1000000"));
        assert!(ctx.contains("GameDev"));
        assert!(ctx.contains("custom-topic"));
        assert!(ctx.contains("Dry run"));
    }

    #[test]
    fn game_state_minimal_context() {
        let state = GameStateInfo {
            universe_id: "999".to_string(),
            place_id: None,
            experience_name: None,
            active_players: None,
            total_visits: None,
            creator_name: None,
            messaging_topic: "eliza-agent".to_string(),
            dry_run: false,
        };

        let ctx = state.to_context_string();
        assert!(ctx.contains("999"));
        assert!(ctx.contains("eliza-agent"));
        assert!(!ctx.contains("Place ID"));
        assert!(!ctx.contains("Experience Name"));
        assert!(!ctx.contains("Active Players"));
        assert!(!ctx.contains("Dry run"));
    }
}

// ── Error variants ─────────────────────────────────────────────────────

mod error_tests {
    use elizaos_plugin_roblox::RobloxError;

    #[test]
    fn config_error() {
        let err = RobloxError::config("missing field");
        assert!(err.to_string().contains("Configuration error"));
        assert!(err.to_string().contains("missing field"));
    }

    #[test]
    fn api_error() {
        let err = RobloxError::api("bad request", 400, "/v1/test");
        let msg = err.to_string();
        assert!(msg.contains("API error"));
        assert!(msg.contains("400"));
        assert!(msg.contains("/v1/test"));
    }

    #[test]
    fn validation_error() {
        let err = RobloxError::validation("invalid input");
        assert!(err.to_string().contains("Validation error"));
    }

    #[test]
    fn not_found_error() {
        let err = RobloxError::not_found("user 42");
        assert!(err.to_string().contains("Not found"));
        assert!(err.to_string().contains("user 42"));
    }

    #[test]
    fn auth_error() {
        let err = RobloxError::auth("invalid token");
        assert!(err.to_string().contains("Authentication error"));
    }

    #[test]
    fn internal_error() {
        let err = RobloxError::internal("something broke");
        assert!(err.to_string().contains("Internal error"));
    }

    #[test]
    fn is_rate_limit() {
        let err = RobloxError::RateLimit("too fast".to_string());
        assert!(err.is_rate_limit());
        assert!(!err.is_not_found());
        assert!(!err.is_auth());
    }

    #[test]
    fn is_not_found() {
        let err = RobloxError::not_found("missing");
        assert!(err.is_not_found());
        assert!(!err.is_rate_limit());
        assert!(!err.is_auth());
    }

    #[test]
    fn is_auth() {
        let err = RobloxError::auth("unauthorized");
        assert!(err.is_auth());
        assert!(!err.is_rate_limit());
        assert!(!err.is_not_found());
    }

    #[test]
    fn json_error_from_serde() {
        let bad = serde_json::from_str::<serde_json::Value>("not json");
        let serde_err = bad.unwrap_err();
        let roblox_err: RobloxError = serde_err.into();
        assert!(roblox_err.to_string().contains("JSON error"));
    }
}

// ── Types ──────────────────────────────────────────────────────────────

mod type_tests {
    use elizaos_plugin_roblox::types::*;

    #[test]
    fn roblox_user_serialization() {
        let user = RobloxUser {
            id: 42,
            username: "hero".to_string(),
            display_name: "The Hero".to_string(),
            avatar_url: Some("https://img.example.com/42.png".to_string()),
            created_at: None,
            is_banned: false,
        };

        let json = serde_json::to_string(&user).unwrap();
        assert!(json.contains("hero"));
        assert!(json.contains("42"));

        let deser: RobloxUser = serde_json::from_str(&json).unwrap();
        assert_eq!(deser.id, 42);
        assert_eq!(deser.username, "hero");
    }

    #[test]
    fn event_type_all_variants() {
        assert_eq!(RobloxEventType::PlayerJoined.as_str(), "roblox:player_joined");
        assert_eq!(RobloxEventType::PlayerLeft.as_str(), "roblox:player_left");
        assert_eq!(RobloxEventType::PlayerMessage.as_str(), "roblox:player_message");
        assert_eq!(RobloxEventType::GameEvent.as_str(), "roblox:game_event");
        assert_eq!(RobloxEventType::WebhookReceived.as_str(), "roblox:webhook_received");
    }

    #[test]
    fn creator_type_equality() {
        assert_eq!(CreatorType::User, CreatorType::User);
        assert_ne!(CreatorType::User, CreatorType::Group);
    }

    #[test]
    fn messaging_service_message_with_sender() {
        let msg = MessagingServiceMessage {
            topic: "eliza-agent".to_string(),
            data: serde_json::json!({ "type": "agent_message", "content": "hi" }),
            sender: Some(MessageSender {
                agent_id: uuid::Uuid::nil(),
                agent_name: "Bot".to_string(),
            }),
        };

        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("eliza-agent"));
        assert!(json.contains("Bot"));
    }

    #[test]
    fn roblox_game_action() {
        let action = RobloxGameAction {
            name: "give_coins".to_string(),
            parameters: serde_json::json!({ "amount": 100 }),
            target_player_ids: Some(vec![1, 2, 3]),
        };

        assert_eq!(action.name, "give_coins");
        assert_eq!(action.target_player_ids.unwrap().len(), 3);
    }

    #[test]
    fn server_info_optional_fields() {
        let info = RobloxServerInfo {
            job_id: "job-1".to_string(),
            place_id: "place-1".to_string(),
            player_count: 10,
            max_players: 50,
            region: None,
            uptime: Some(3600),
        };

        assert_eq!(info.player_count, 10);
        assert!(info.region.is_none());
        assert_eq!(info.uptime, Some(3600));
    }

    #[test]
    fn experience_info_construction() {
        let info = RobloxExperienceInfo {
            universe_id: "12345".to_string(),
            name: "Cool Game".to_string(),
            description: Some("A cool game".to_string()),
            creator: ExperienceCreator {
                id: 1,
                creator_type: CreatorType::User,
                name: "Dev".to_string(),
            },
            playing: Some(100),
            visits: Some(50000),
            root_place_id: "67890".to_string(),
        };

        assert_eq!(info.name, "Cool Game");
        assert_eq!(info.creator.creator_type, CreatorType::User);
    }
}

// ── Plugin-level constants ─────────────────────────────────────────────

#[test]
fn plugin_constants() {
    assert_eq!(elizaos_plugin_roblox::PLUGIN_NAME, "roblox");
    assert_eq!(elizaos_plugin_roblox::ROBLOX_SERVICE_NAME, "roblox");
    assert!(!elizaos_plugin_roblox::PLUGIN_DESCRIPTION.is_empty());
    assert!(!elizaos_plugin_roblox::PLUGIN_VERSION.is_empty());
}
