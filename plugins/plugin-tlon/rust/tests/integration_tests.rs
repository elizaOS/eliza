//! Integration tests for the elizaos-plugin-tlon crate.
//!
//! Tests cover: plugin metadata, config creation/validation/builder,
//! error Display, type construction & serde roundtrips, action metadata,
//! and provider metadata with default result structure.

use elizaos_plugin_tlon::config::{
    build_channel_nest, format_ship, normalize_ship, parse_channel_nest, TlonConfig,
};
use elizaos_plugin_tlon::error::TlonError;
use elizaos_plugin_tlon::types::*;
use elizaos_plugin_tlon::{plugin, Plugin, PLUGIN_DESCRIPTION, PLUGIN_NAME, PLUGIN_VERSION};

// ===========================================================================
// 1. Plugin metadata
// ===========================================================================

#[test]
fn plugin_name_is_tlon() {
    assert_eq!(PLUGIN_NAME, "tlon");
}

#[test]
fn plugin_description_is_not_empty() {
    assert!(!PLUGIN_DESCRIPTION.is_empty());
    assert!(PLUGIN_DESCRIPTION.contains("Tlon") || PLUGIN_DESCRIPTION.contains("Urbit"));
}

#[test]
fn plugin_version_is_semver_like() {
    // Should contain at least one dot (e.g. "2.0.0")
    assert!(
        PLUGIN_VERSION.contains('.'),
        "PLUGIN_VERSION '{}' doesn't look like semver",
        PLUGIN_VERSION
    );
}

#[test]
fn plugin_factory_returns_correct_metadata() {
    let p = plugin();
    assert_eq!(p.name, PLUGIN_NAME);
    assert_eq!(p.description, PLUGIN_DESCRIPTION);
    assert_eq!(p.version, PLUGIN_VERSION);
}

#[test]
fn plugin_struct_derives_debug_and_clone() {
    let p = plugin();
    let p2 = p.clone();
    assert_eq!(p.name, p2.name);
    assert_eq!(format!("{:?}", p).contains("tlon"), true);
}

// ===========================================================================
// 2. Config creation, validation, defaults, builder
// ===========================================================================

#[test]
fn config_new_normalizes_ship() {
    let config = TlonConfig::new(
        "~sampel-palnet".to_string(),
        "https://example.com".to_string(),
        "lidlut-tabwed".to_string(),
    );
    assert_eq!(config.ship, "sampel-palnet");
}

#[test]
fn config_new_strips_trailing_slash() {
    let config = TlonConfig::new(
        "ship".to_string(),
        "https://example.com/".to_string(),
        "code".to_string(),
    );
    assert!(!config.url.ends_with('/'));
}

#[test]
fn config_new_sets_defaults() {
    let config = TlonConfig::new(
        "ship".to_string(),
        "https://example.com".to_string(),
        "code".to_string(),
    );
    assert!(config.enabled);
    assert!(config.group_channels.is_empty());
    assert!(config.dm_allowlist.is_empty());
    assert!(config.auto_discover_channels);
}

#[test]
fn config_builder_with_group_channels() {
    let config = TlonConfig::new(
        "ship".to_string(),
        "https://example.com".to_string(),
        "code".to_string(),
    )
    .with_group_channels(vec![
        "chat/~host/general".to_string(),
        "chat/~host/random".to_string(),
    ]);

    assert_eq!(config.group_channels.len(), 2);
    assert_eq!(config.group_channels[0], "chat/~host/general");
}

#[test]
fn config_builder_with_dm_allowlist_normalizes_ships() {
    let config = TlonConfig::new(
        "ship".to_string(),
        "https://example.com".to_string(),
        "code".to_string(),
    )
    .with_dm_allowlist(vec!["~allowed-ship".to_string(), "another-ship".to_string()]);

    assert_eq!(config.dm_allowlist, vec!["allowed-ship", "another-ship"]);
}

#[test]
fn config_builder_with_auto_discover_false() {
    let config = TlonConfig::new(
        "ship".to_string(),
        "https://example.com".to_string(),
        "code".to_string(),
    )
    .with_auto_discover(false);

    assert!(!config.auto_discover_channels);
}

#[test]
fn config_builder_with_enabled_false() {
    let config = TlonConfig::new(
        "ship".to_string(),
        "https://example.com".to_string(),
        "code".to_string(),
    )
    .with_enabled(false);

    assert!(!config.enabled);
}

#[test]
fn config_validate_passes_for_valid_config() {
    let config = TlonConfig::new(
        "ship".to_string(),
        "https://example.com".to_string(),
        "code".to_string(),
    );
    assert!(config.validate().is_ok());
}

#[test]
fn config_validate_fails_for_empty_ship() {
    let config = TlonConfig::new(
        "".to_string(),
        "https://example.com".to_string(),
        "code".to_string(),
    );
    let err = config.validate().unwrap_err();
    match err {
        TlonError::ConfigError(msg) => assert!(msg.contains("Ship")),
        other => panic!("Expected ConfigError, got {:?}", other),
    }
}

#[test]
fn config_validate_fails_for_empty_url() {
    let config = TlonConfig::new(
        "ship".to_string(),
        "".to_string(),
        "code".to_string(),
    );
    let err = config.validate().unwrap_err();
    match err {
        TlonError::ConfigError(msg) => assert!(msg.contains("URL")),
        other => panic!("Expected ConfigError, got {:?}", other),
    }
}

#[test]
fn config_validate_fails_for_empty_code() {
    let config = TlonConfig::new(
        "ship".to_string(),
        "https://example.com".to_string(),
        "".to_string(),
    );
    let err = config.validate().unwrap_err();
    match err {
        TlonError::ConfigError(msg) => assert!(msg.contains("Code")),
        other => panic!("Expected ConfigError, got {:?}", other),
    }
}

#[test]
fn config_validate_fails_for_invalid_url() {
    let mut config = TlonConfig::new(
        "ship".to_string(),
        "https://example.com".to_string(),
        "code".to_string(),
    );
    config.url = "not-a-url".to_string();
    assert!(config.validate().is_err());
}

#[test]
fn config_formatted_ship_adds_tilde() {
    let config = TlonConfig::new(
        "sampel-palnet".to_string(),
        "https://example.com".to_string(),
        "code".to_string(),
    );
    assert_eq!(config.formatted_ship(), "~sampel-palnet");
}

// ---------------------------------------------------------------------------
// is_dm_allowed
// ---------------------------------------------------------------------------

#[test]
fn is_dm_allowed_empty_allowlist_permits_all() {
    let config = TlonConfig::new(
        "ship".to_string(),
        "https://example.com".to_string(),
        "code".to_string(),
    );
    assert!(config.is_dm_allowed("any-ship"));
}

#[test]
fn is_dm_allowed_permits_listed_ship() {
    let config = TlonConfig::new(
        "ship".to_string(),
        "https://example.com".to_string(),
        "code".to_string(),
    )
    .with_dm_allowlist(vec!["allowed-ship".to_string()]);
    assert!(config.is_dm_allowed("allowed-ship"));
}

#[test]
fn is_dm_allowed_blocks_unlisted_ship() {
    let config = TlonConfig::new(
        "ship".to_string(),
        "https://example.com".to_string(),
        "code".to_string(),
    )
    .with_dm_allowlist(vec!["allowed-ship".to_string()]);
    assert!(!config.is_dm_allowed("other-ship"));
}

#[test]
fn is_dm_allowed_normalizes_tilde_prefix() {
    let config = TlonConfig::new(
        "ship".to_string(),
        "https://example.com".to_string(),
        "code".to_string(),
    )
    .with_dm_allowlist(vec!["allowed-ship".to_string()]);
    assert!(config.is_dm_allowed("~allowed-ship"));
}

// ---------------------------------------------------------------------------
// normalize_ship / format_ship
// ---------------------------------------------------------------------------

#[test]
fn normalize_ship_strips_tilde() {
    assert_eq!(normalize_ship("~sampel-palnet"), "sampel-palnet");
}

#[test]
fn normalize_ship_no_op_without_tilde() {
    assert_eq!(normalize_ship("sampel-palnet"), "sampel-palnet");
}

#[test]
fn format_ship_adds_tilde() {
    assert_eq!(format_ship("sampel-palnet"), "~sampel-palnet");
}

#[test]
fn format_ship_does_not_double_tilde() {
    assert_eq!(format_ship("~sampel-palnet"), "~sampel-palnet");
}

// ---------------------------------------------------------------------------
// parse_channel_nest / build_channel_nest
// ---------------------------------------------------------------------------

#[test]
fn parse_channel_nest_valid() {
    let result = parse_channel_nest("chat/~host-ship/channel-name");
    assert!(result.is_some());
    let (kind, host, name) = result.unwrap();
    assert_eq!(kind, "chat");
    assert_eq!(host, "host-ship");
    assert_eq!(name, "channel-name");
}

#[test]
fn parse_channel_nest_normalizes_host() {
    let (_, host, _) = parse_channel_nest("diary/~my-ship/notes").unwrap();
    assert_eq!(host, "my-ship");
}

#[test]
fn parse_channel_nest_returns_none_for_too_few_parts() {
    assert!(parse_channel_nest("single").is_none());
    assert!(parse_channel_nest("only/two").is_none());
}

#[test]
fn parse_channel_nest_returns_none_for_too_many_parts() {
    assert!(parse_channel_nest("a/b/c/d").is_none());
}

#[test]
fn build_channel_nest_correct() {
    assert_eq!(
        build_channel_nest("chat", "host-ship", "general"),
        "chat/~host-ship/general"
    );
}

#[test]
fn build_channel_nest_does_not_double_tilde() {
    assert_eq!(
        build_channel_nest("chat", "~host-ship", "general"),
        "chat/~host-ship/general"
    );
}

// ===========================================================================
// 3. Error variants with Display output
// ===========================================================================

#[test]
fn error_missing_setting_display() {
    let err = TlonError::MissingSetting("TLON_SHIP".to_string());
    let msg = err.to_string();
    assert!(msg.contains("TLON_SHIP"), "got: {}", msg);
    assert!(msg.contains("Missing") || msg.contains("required"), "got: {}", msg);
}

#[test]
fn error_config_error_display() {
    let err = TlonError::ConfigError("Ship name cannot be empty".to_string());
    assert!(err.to_string().contains("Ship name cannot be empty"));
}

#[test]
fn error_authentication_failed_display() {
    let err = TlonError::AuthenticationFailed("401 Unauthorized".to_string());
    assert!(err.to_string().contains("401 Unauthorized"));
}

#[test]
fn error_connection_failed_display() {
    let err = TlonError::ConnectionFailed("timeout".to_string());
    assert!(err.to_string().contains("timeout"));
}

#[test]
fn error_client_not_initialized_display() {
    let err = TlonError::ClientNotInitialized;
    let msg = err.to_string();
    assert!(msg.contains("Client") || msg.contains("not initialized"), "got: {}", msg);
}

#[test]
fn error_already_running_display() {
    let err = TlonError::AlreadyRunning;
    assert!(err.to_string().contains("already running"));
}

#[test]
fn error_api_error_display() {
    let err = TlonError::ApiError("bad request".to_string());
    assert!(err.to_string().contains("bad request"));
}

#[test]
fn error_poke_failed_display() {
    let err = TlonError::PokeFailed("500".to_string());
    assert!(err.to_string().contains("500"));
}

#[test]
fn error_scry_failed_display() {
    let err = TlonError::ScryFailed("404 for /path".to_string());
    assert!(err.to_string().contains("404"));
}

#[test]
fn error_subscribe_failed_display() {
    let err = TlonError::SubscribeFailed("permission denied".to_string());
    assert!(err.to_string().contains("permission denied"));
}

#[test]
fn error_stream_error_display() {
    let err = TlonError::StreamError("connection reset".to_string());
    assert!(err.to_string().contains("connection reset"));
}

#[test]
fn error_invalid_argument_display() {
    let err = TlonError::InvalidArgument("bad nest".to_string());
    assert!(err.to_string().contains("bad nest"));
}

#[test]
fn error_channel_not_found_display() {
    let err = TlonError::ChannelNotFound("chat/~host/missing".to_string());
    assert!(err.to_string().contains("chat/~host/missing"));
}

#[test]
fn error_ship_not_found_display() {
    let err = TlonError::ShipNotFound("~nonexist".to_string());
    assert!(err.to_string().contains("~nonexist"));
}

#[test]
fn error_send_failed_display() {
    let err = TlonError::SendFailed("timeout".to_string());
    assert!(err.to_string().contains("timeout"));
}

#[test]
fn error_serialization_error_display() {
    let err = TlonError::SerializationError("invalid json".to_string());
    assert!(err.to_string().contains("invalid json"));
}

#[test]
fn error_http_error_display() {
    let err = TlonError::HttpError("network unreachable".to_string());
    assert!(err.to_string().contains("network unreachable"));
}

#[test]
fn error_other_display() {
    let err = TlonError::Other("something unexpected".to_string());
    assert_eq!(err.to_string(), "something unexpected");
}

#[test]
fn error_from_serde_json() {
    // Construct a real serde_json error
    let serde_err: std::result::Result<serde_json::Value, _> = serde_json::from_str("{bad");
    let tlon_err: TlonError = serde_err.unwrap_err().into();
    match tlon_err {
        TlonError::SerializationError(msg) => {
            assert!(!msg.is_empty());
        }
        other => panic!("Expected SerializationError, got {:?}", other),
    }
}

#[test]
fn error_from_url_parse_error() {
    let url_err: std::result::Result<url::Url, _> = url::Url::parse("not a url");
    let tlon_err: TlonError = url_err.unwrap_err().into();
    match tlon_err {
        TlonError::InvalidArgument(msg) => {
            assert!(msg.contains("URL"), "got: {}", msg);
        }
        other => panic!("Expected InvalidArgument, got {:?}", other),
    }
}

// ===========================================================================
// 4. Type construction and serde roundtrip
// ===========================================================================

// ---------------------------------------------------------------------------
// TlonEventType
// ---------------------------------------------------------------------------

#[test]
fn event_type_display_message_received() {
    assert_eq!(TlonEventType::MessageReceived.to_string(), "TLON_MESSAGE_RECEIVED");
}

#[test]
fn event_type_display_dm_received() {
    assert_eq!(TlonEventType::DmReceived.to_string(), "TLON_DM_RECEIVED");
}

#[test]
fn event_type_display_group_message() {
    assert_eq!(
        TlonEventType::GroupMessageReceived.to_string(),
        "TLON_GROUP_MESSAGE_RECEIVED"
    );
}

#[test]
fn event_type_display_world_events() {
    assert_eq!(TlonEventType::WorldJoined.to_string(), "TLON_WORLD_JOINED");
    assert_eq!(TlonEventType::WorldConnected.to_string(), "TLON_WORLD_CONNECTED");
    assert_eq!(TlonEventType::WorldLeft.to_string(), "TLON_WORLD_LEFT");
}

#[test]
fn event_type_display_entity_events() {
    assert_eq!(TlonEventType::EntityJoined.to_string(), "TLON_ENTITY_JOINED");
    assert_eq!(TlonEventType::EntityLeft.to_string(), "TLON_ENTITY_LEFT");
}

#[test]
fn event_type_display_connection_events() {
    assert_eq!(TlonEventType::ConnectionError.to_string(), "TLON_CONNECTION_ERROR");
    assert_eq!(TlonEventType::Reconnected.to_string(), "TLON_RECONNECTED");
}

#[test]
fn event_type_serde_roundtrip() {
    let original = TlonEventType::MessageReceived;
    let json = serde_json::to_string(&original).unwrap();
    let restored: TlonEventType = serde_json::from_str(&json).unwrap();
    assert_eq!(original, restored);
}

// ---------------------------------------------------------------------------
// TlonChannelType
// ---------------------------------------------------------------------------

#[test]
fn channel_type_display_dm() {
    assert_eq!(TlonChannelType::Dm.to_string(), "dm");
}

#[test]
fn channel_type_display_group() {
    assert_eq!(TlonChannelType::Group.to_string(), "group");
}

#[test]
fn channel_type_display_thread() {
    assert_eq!(TlonChannelType::Thread.to_string(), "thread");
}

#[test]
fn channel_type_serde_roundtrip() {
    for ct in [TlonChannelType::Dm, TlonChannelType::Group, TlonChannelType::Thread] {
        let json = serde_json::to_string(&ct).unwrap();
        let restored: TlonChannelType = serde_json::from_str(&json).unwrap();
        assert_eq!(ct, restored);
    }
}

#[test]
fn channel_type_equality() {
    assert_eq!(TlonChannelType::Dm, TlonChannelType::Dm);
    assert_ne!(TlonChannelType::Dm, TlonChannelType::Group);
    assert_ne!(TlonChannelType::Group, TlonChannelType::Thread);
}

// ---------------------------------------------------------------------------
// TlonShip
// ---------------------------------------------------------------------------

#[test]
fn ship_new_sets_name_only() {
    let ship = TlonShip::new("sampel-palnet");
    assert_eq!(ship.name, "sampel-palnet");
    assert!(ship.display_name.is_none());
    assert!(ship.avatar.is_none());
}

#[test]
fn ship_formatted_adds_tilde() {
    let ship = TlonShip::new("sampel-palnet");
    assert_eq!(ship.formatted(), "~sampel-palnet");
}

#[test]
fn ship_serde_roundtrip() {
    let original = TlonShip {
        name: "zod".to_string(),
        display_name: Some("Zod".to_string()),
        avatar: Some("https://img.com/avatar.png".to_string()),
    };
    let json = serde_json::to_string(&original).unwrap();
    let restored: TlonShip = serde_json::from_str(&json).unwrap();
    assert_eq!(restored.name, "zod");
    assert_eq!(restored.display_name.unwrap(), "Zod");
    assert_eq!(restored.avatar.unwrap(), "https://img.com/avatar.png");
}

#[test]
fn ship_clone() {
    let original = TlonShip::new("zod");
    let cloned = original.clone();
    assert_eq!(original.name, cloned.name);
}

// ---------------------------------------------------------------------------
// TlonChat
// ---------------------------------------------------------------------------

#[test]
fn chat_dm_factory() {
    let chat = TlonChat::dm("sampel-palnet");
    assert_eq!(chat.id, "sampel-palnet");
    assert_eq!(chat.channel_type, TlonChannelType::Dm);
    assert!(chat.name.as_ref().unwrap().contains("sampel-palnet"));
    assert!(chat.host_ship.is_none());
    assert!(chat.description.is_none());
}

#[test]
fn chat_group_factory() {
    let chat = TlonChat::group(
        "chat/~host/general",
        Some("general".to_string()),
        Some("host".to_string()),
    );
    assert_eq!(chat.id, "chat/~host/general");
    assert_eq!(chat.channel_type, TlonChannelType::Group);
    assert_eq!(chat.name.unwrap(), "general");
    assert_eq!(chat.host_ship.unwrap(), "host");
}

#[test]
fn chat_group_factory_minimal() {
    let chat = TlonChat::group("chat/~h/c", None, None);
    assert!(chat.name.is_none());
    assert!(chat.host_ship.is_none());
}

#[test]
fn chat_serde_roundtrip() {
    let original = TlonChat::dm("zod");
    let json = serde_json::to_string(&original).unwrap();
    let restored: TlonChat = serde_json::from_str(&json).unwrap();
    assert_eq!(restored.id, "zod");
    assert_eq!(restored.channel_type, TlonChannelType::Dm);
}

// ---------------------------------------------------------------------------
// TlonMessagePayload
// ---------------------------------------------------------------------------

#[test]
fn message_payload_construction() {
    let payload = TlonMessagePayload {
        message_id: "msg-001".to_string(),
        chat: TlonChat::dm("zod"),
        from_ship: TlonShip::new("zod"),
        text: "Hello!".to_string(),
        timestamp: 1700000000000,
        reply_to_id: None,
    };
    assert_eq!(payload.message_id, "msg-001");
    assert_eq!(payload.text, "Hello!");
    assert!(payload.reply_to_id.is_none());
}

#[test]
fn message_payload_with_reply() {
    let payload = TlonMessagePayload {
        message_id: "msg-002".to_string(),
        chat: TlonChat::group("chat/~h/c", Some("c".to_string()), Some("h".to_string())),
        from_ship: TlonShip::new("sender"),
        text: "Thread reply".to_string(),
        timestamp: 1700000000000,
        reply_to_id: Some("parent-id".to_string()),
    };
    assert_eq!(payload.reply_to_id.unwrap(), "parent-id");
}

#[test]
fn message_payload_serde_roundtrip() {
    let original = TlonMessagePayload {
        message_id: "rt-001".to_string(),
        chat: TlonChat::dm("zod"),
        from_ship: TlonShip::new("zod"),
        text: "Roundtrip".to_string(),
        timestamp: 12345,
        reply_to_id: None,
    };
    let json = serde_json::to_string(&original).unwrap();
    let restored: TlonMessagePayload = serde_json::from_str(&json).unwrap();
    assert_eq!(restored.message_id, "rt-001");
    assert_eq!(restored.text, "Roundtrip");
}

// ---------------------------------------------------------------------------
// TlonMessageSentPayload
// ---------------------------------------------------------------------------

#[test]
fn message_sent_payload_default_not_reply() {
    let payload = TlonMessageSentPayload {
        message_id: "sent-001".to_string(),
        chat: TlonChat::dm("zod"),
        text: "Sent msg".to_string(),
        is_reply: false,
    };
    assert!(!payload.is_reply);
}

#[test]
fn message_sent_payload_serde_roundtrip() {
    let original = TlonMessageSentPayload {
        message_id: "sent-002".to_string(),
        chat: TlonChat::group("chat/~h/c", None, None),
        text: "Reply".to_string(),
        is_reply: true,
    };
    let json = serde_json::to_string(&original).unwrap();
    let restored: TlonMessageSentPayload = serde_json::from_str(&json).unwrap();
    assert!(restored.is_reply);
    assert_eq!(restored.message_id, "sent-002");
}

// ---------------------------------------------------------------------------
// TlonWorldPayload
// ---------------------------------------------------------------------------

#[test]
fn world_payload_empty_lists() {
    let payload = TlonWorldPayload {
        ship: TlonShip::new("zod"),
        dm_conversations: Vec::new(),
        group_channels: Vec::new(),
    };
    assert!(payload.dm_conversations.is_empty());
    assert!(payload.group_channels.is_empty());
}

#[test]
fn world_payload_with_data() {
    let payload = TlonWorldPayload {
        ship: TlonShip::new("zod"),
        dm_conversations: vec!["ship-a".to_string(), "ship-b".to_string()],
        group_channels: vec!["chat/~h/c".to_string()],
    };
    assert_eq!(payload.dm_conversations.len(), 2);
    assert_eq!(payload.group_channels.len(), 1);
}

#[test]
fn world_payload_serde_roundtrip() {
    let original = TlonWorldPayload {
        ship: TlonShip::new("zod"),
        dm_conversations: vec!["ship-a".to_string()],
        group_channels: vec!["chat/~h/c".to_string()],
    };
    let json = serde_json::to_string(&original).unwrap();
    let restored: TlonWorldPayload = serde_json::from_str(&json).unwrap();
    assert_eq!(restored.dm_conversations.len(), 1);
}

// ---------------------------------------------------------------------------
// TlonEntityPayload
// ---------------------------------------------------------------------------

#[test]
fn entity_payload_joined() {
    let payload = TlonEntityPayload {
        ship: TlonShip::new("zod"),
        chat: TlonChat::dm("zod"),
        action: EntityAction::Joined,
    };
    assert_eq!(payload.action, EntityAction::Joined);
}

#[test]
fn entity_payload_serde_roundtrip() {
    for action in [EntityAction::Joined, EntityAction::Left, EntityAction::Updated] {
        let payload = TlonEntityPayload {
            ship: TlonShip::new("zod"),
            chat: TlonChat::dm("zod"),
            action,
        };
        let json = serde_json::to_string(&payload).unwrap();
        let restored: TlonEntityPayload = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.action, action);
    }
}

// ---------------------------------------------------------------------------
// TlonContent
// ---------------------------------------------------------------------------

#[test]
fn content_default_all_none() {
    let content = TlonContent::default();
    assert!(content.text.is_none());
    assert!(content.ship.is_none());
    assert!(content.channel_nest.is_none());
    assert!(content.reply_to_id.is_none());
}

#[test]
fn content_full_construction() {
    let content = TlonContent {
        text: Some("Hello".to_string()),
        ship: Some("sampel-palnet".to_string()),
        channel_nest: Some("chat/~h/c".to_string()),
        reply_to_id: Some("parent".to_string()),
    };
    assert_eq!(content.text.unwrap(), "Hello");
    assert_eq!(content.ship.unwrap(), "sampel-palnet");
}

#[test]
fn content_serde_roundtrip() {
    let original = TlonContent {
        text: Some("Test".to_string()),
        ship: Some("zod".to_string()),
        channel_nest: None,
        reply_to_id: None,
    };
    let json = serde_json::to_string(&original).unwrap();
    let restored: TlonContent = serde_json::from_str(&json).unwrap();
    assert_eq!(restored.text.unwrap(), "Test");
}

// ---------------------------------------------------------------------------
// TlonSettings
// ---------------------------------------------------------------------------

#[test]
fn settings_default_is_empty() {
    let settings = TlonSettings::default();
    assert!(settings.ship.is_empty());
    assert!(settings.dm_allowlist.is_empty());
    assert!(settings.group_channels.is_empty());
    assert!(!settings.auto_discover_channels);
}

#[test]
fn settings_serde_roundtrip() {
    let original = TlonSettings {
        ship: "zod".to_string(),
        dm_allowlist: vec!["ship-a".to_string()],
        group_channels: vec!["chat/~h/c".to_string()],
        auto_discover_channels: true,
    };
    let json = serde_json::to_string(&original).unwrap();
    let restored: TlonSettings = serde_json::from_str(&json).unwrap();
    assert_eq!(restored.ship, "zod");
    assert!(restored.auto_discover_channels);
}

// ---------------------------------------------------------------------------
// TlonSubscription
// ---------------------------------------------------------------------------

#[test]
fn subscription_construction() {
    let sub = TlonSubscription {
        id: 42,
        app: "chat".to_string(),
        path: "/dm/sampel-palnet".to_string(),
    };
    assert_eq!(sub.id, 42);
    assert_eq!(sub.app, "chat");
    assert_eq!(sub.path, "/dm/sampel-palnet");
}

#[test]
fn subscription_serde_roundtrip() {
    let original = TlonSubscription {
        id: 1,
        app: "channels".to_string(),
        path: "/chat/~h/c".to_string(),
    };
    let json = serde_json::to_string(&original).unwrap();
    let restored: TlonSubscription = serde_json::from_str(&json).unwrap();
    assert_eq!(restored.id, 1);
    assert_eq!(restored.app, "channels");
}

// ---------------------------------------------------------------------------
// TlonVerse / TlonInline / TlonBlock types
// ---------------------------------------------------------------------------

#[test]
fn verse_with_inline_text() {
    let verse = TlonVerse {
        inline: Some(vec![TlonInline::Text("Hello world".to_string())]),
        block: None,
    };
    let json = serde_json::to_string(&verse).unwrap();
    let restored: TlonVerse = serde_json::from_str(&json).unwrap();
    assert!(restored.inline.is_some());
    match &restored.inline.unwrap()[0] {
        TlonInline::Text(t) => assert_eq!(t, "Hello world"),
        _ => panic!("Expected Text variant"),
    }
}

#[test]
fn link_serde_roundtrip() {
    let link = TlonLink {
        href: "https://example.com".to_string(),
        content: "Example".to_string(),
    };
    let json = serde_json::to_string(&link).unwrap();
    let restored: TlonLink = serde_json::from_str(&json).unwrap();
    assert_eq!(restored.href, "https://example.com");
    assert_eq!(restored.content, "Example");
}

#[test]
fn image_block_serde_roundtrip() {
    let image = TlonImage {
        src: "https://img.com/pic.png".to_string(),
        alt: Some("A picture".to_string()),
        width: Some(800),
        height: Some(600),
    };
    let json = serde_json::to_string(&image).unwrap();
    let restored: TlonImage = serde_json::from_str(&json).unwrap();
    assert_eq!(restored.src, "https://img.com/pic.png");
    assert_eq!(restored.alt.unwrap(), "A picture");
    assert_eq!(restored.width.unwrap(), 800);
}

#[test]
fn code_block_serde_roundtrip() {
    let code = TlonCodeBlock {
        code: "fn main() {}".to_string(),
        lang: Some("rust".to_string()),
    };
    let json = serde_json::to_string(&code).unwrap();
    let restored: TlonCodeBlock = serde_json::from_str(&json).unwrap();
    assert_eq!(restored.code, "fn main() {}");
    assert_eq!(restored.lang.unwrap(), "rust");
}

// ===========================================================================
// 5. Action metadata (via the TlonAction trait)
// ===========================================================================

#[cfg(feature = "native")]
mod action_tests {
    use elizaos_plugin_tlon::actions::{ActionContext, SendMessageAction, TlonAction};

    #[test]
    fn send_message_action_name() {
        let action = SendMessageAction;
        assert_eq!(action.name(), "SEND_TLON_MESSAGE");
    }

    #[test]
    fn send_message_action_description_mentions_tlon() {
        let action = SendMessageAction;
        let desc = action.description().to_lowercase();
        assert!(desc.contains("tlon") || desc.contains("urbit"));
    }

    #[tokio::test]
    async fn validate_accepts_tlon_source() {
        let action = SendMessageAction;
        let ctx = ActionContext {
            message: serde_json::json!({"source": "tlon", "text": "hello"}),
            ship: Some("sampel-palnet".to_string()),
            channel_nest: None,
            reply_to_id: None,
            state: serde_json::json!({}),
        };
        assert!(action.validate(&ctx).await.unwrap());
    }

    #[tokio::test]
    async fn validate_accepts_urbit_source() {
        let action = SendMessageAction;
        let ctx = ActionContext {
            message: serde_json::json!({"source": "urbit"}),
            ship: None,
            channel_nest: Some("chat/~h/c".to_string()),
            reply_to_id: None,
            state: serde_json::json!({}),
        };
        assert!(action.validate(&ctx).await.unwrap());
    }

    #[tokio::test]
    async fn validate_rejects_other_source() {
        let action = SendMessageAction;
        let ctx = ActionContext {
            message: serde_json::json!({"source": "discord"}),
            ship: None,
            channel_nest: None,
            reply_to_id: None,
            state: serde_json::json!({}),
        };
        assert!(!action.validate(&ctx).await.unwrap());
    }

    #[tokio::test]
    async fn validate_rejects_missing_source() {
        let action = SendMessageAction;
        let ctx = ActionContext {
            message: serde_json::json!({"text": "no source"}),
            ship: None,
            channel_nest: None,
            reply_to_id: None,
            state: serde_json::json!({}),
        };
        assert!(!action.validate(&ctx).await.unwrap());
    }

    #[tokio::test]
    async fn execute_dm_returns_ship_target() {
        let action = SendMessageAction;
        let ctx = ActionContext {
            message: serde_json::json!({"source": "tlon"}),
            ship: Some("sampel-palnet".to_string()),
            channel_nest: None,
            reply_to_id: None,
            state: serde_json::json!({"response": {"text": "Hello!"}}),
        };
        let result = action.execute(&ctx).await.unwrap();
        assert_eq!(result["action"], "SEND_TLON_MESSAGE");
        assert_eq!(result["target"]["ship"], "sampel-palnet");
        assert_eq!(result["text"], "Hello!");
    }

    #[tokio::test]
    async fn execute_channel_returns_nest_target() {
        let action = SendMessageAction;
        let ctx = ActionContext {
            message: serde_json::json!({"source": "tlon"}),
            ship: None,
            channel_nest: Some("chat/~host/general".to_string()),
            reply_to_id: None,
            state: serde_json::json!({"response": {"text": "Group msg"}}),
        };
        let result = action.execute(&ctx).await.unwrap();
        assert_eq!(result["target"]["channel_nest"], "chat/~host/general");
        assert_eq!(result["text"], "Group msg");
    }

    #[tokio::test]
    async fn execute_with_reply_to_id() {
        let action = SendMessageAction;
        let ctx = ActionContext {
            message: serde_json::json!({"source": "tlon"}),
            ship: None,
            channel_nest: Some("chat/~host/ch".to_string()),
            reply_to_id: Some("parent-123".to_string()),
            state: serde_json::json!({"response": {"text": "Thread reply"}}),
        };
        let result = action.execute(&ctx).await.unwrap();
        assert_eq!(result["reply_to_id"], "parent-123");
    }

    #[tokio::test]
    async fn execute_empty_context_returns_empty_target() {
        let action = SendMessageAction;
        let ctx = ActionContext {
            message: serde_json::json!({}),
            ship: None,
            channel_nest: None,
            reply_to_id: None,
            state: serde_json::json!({}),
        };
        let result = action.execute(&ctx).await.unwrap();
        assert!(result["target"].as_object().unwrap().is_empty());
        assert_eq!(result["text"], "");
    }
}

// ===========================================================================
// 6. Provider metadata and default result structure
// ===========================================================================

#[cfg(feature = "native")]
mod provider_tests {
    use elizaos_plugin_tlon::providers::{ChatStateProvider, ProviderContext, TlonProvider};

    #[test]
    fn chat_state_provider_name() {
        let provider = ChatStateProvider;
        assert_eq!(provider.name(), "tlon_chat_state");
    }

    #[tokio::test]
    async fn dm_state_result_structure() {
        let provider = ChatStateProvider;
        let ctx = ProviderContext {
            ship: Some("sampel-palnet".to_string()),
            channel_nest: None,
            reply_to_id: None,
            room_id: Some("room-1".to_string()),
        };
        let result = provider.get(&ctx).await;
        assert_eq!(result["ship"], "sampel-palnet");
        assert_eq!(result["chat_type"], "dm");
        assert_eq!(result["is_dm"], true);
        assert_eq!(result["is_group"], false);
        assert_eq!(result["is_thread"], false);
        assert_eq!(result["room_id"], "room-1");
    }

    #[tokio::test]
    async fn group_state_result_structure() {
        let provider = ChatStateProvider;
        let ctx = ProviderContext {
            ship: Some("sampel-palnet".to_string()),
            channel_nest: Some("chat/~host/general".to_string()),
            reply_to_id: None,
            room_id: Some("room-2".to_string()),
        };
        let result = provider.get(&ctx).await;
        assert_eq!(result["chat_type"], "group");
        assert_eq!(result["is_group"], true);
        assert_eq!(result["is_dm"], false);
        assert_eq!(result["channel_nest"], "chat/~host/general");
    }

    #[tokio::test]
    async fn thread_state_result_structure() {
        let provider = ChatStateProvider;
        let ctx = ProviderContext {
            ship: Some("sampel-palnet".to_string()),
            channel_nest: Some("chat/~host/general".to_string()),
            reply_to_id: Some("parent-id".to_string()),
            room_id: Some("room-3".to_string()),
        };
        let result = provider.get(&ctx).await;
        assert_eq!(result["chat_type"], "thread");
        assert_eq!(result["is_thread"], true);
        assert_eq!(result["reply_to_id"], "parent-id");
    }

    #[tokio::test]
    async fn null_fields_in_result() {
        let provider = ChatStateProvider;
        let ctx = ProviderContext {
            ship: None,
            channel_nest: None,
            reply_to_id: None,
            room_id: None,
        };
        let result = provider.get(&ctx).await;
        assert!(result["ship"].is_null());
        assert!(result["channel_nest"].is_null());
        assert_eq!(result["chat_type"], "dm"); // default when no nest
    }
}

// ===========================================================================
// 7. Config serialization (it derives Serialize/Deserialize)
// ===========================================================================

#[test]
fn config_serde_roundtrip() {
    let original = TlonConfig::new(
        "sampel-palnet".to_string(),
        "https://example.com".to_string(),
        "lidlut-tabwed".to_string(),
    )
    .with_group_channels(vec!["chat/~h/c".to_string()])
    .with_dm_allowlist(vec!["~allowed".to_string()])
    .with_auto_discover(false)
    .with_enabled(true);

    let json = serde_json::to_string(&original).unwrap();
    let restored: TlonConfig = serde_json::from_str(&json).unwrap();

    assert_eq!(restored.ship, "sampel-palnet");
    assert_eq!(restored.url, "https://example.com");
    assert_eq!(restored.code, "lidlut-tabwed");
    assert!(restored.enabled);
    assert_eq!(restored.group_channels, vec!["chat/~h/c"]);
    assert_eq!(restored.dm_allowlist, vec!["allowed"]);
    assert!(!restored.auto_discover_channels);
}
