//! Comprehensive integration tests for the Feishu plugin.
//!
//! These tests exercise the public API without requiring live Feishu credentials.
//! They cover: config, types, actions, providers, service (creation & message splitting),
//! errors, and serialization.

use elizaos_plugin_feishu::config::{FeishuConfig, FEISHU_DOMAIN, LARK_DOMAIN};
use elizaos_plugin_feishu::error::FeishuError;
use elizaos_plugin_feishu::types::*;
use elizaos_plugin_feishu::{PLUGIN_DESCRIPTION, PLUGIN_NAME, PLUGIN_VERSION};

// ============================================================================
// PLUGIN METADATA
// ============================================================================

#[test]
fn test_plugin_metadata() {
    let plugin = elizaos_plugin_feishu::plugin();
    assert_eq!(plugin.name, "feishu");
    assert!(!plugin.description.is_empty());
    assert!(!plugin.version.is_empty());
}

#[test]
fn test_plugin_constants() {
    assert_eq!(PLUGIN_NAME, "feishu");
    assert!(!PLUGIN_DESCRIPTION.is_empty());
    assert!(!PLUGIN_VERSION.is_empty());
    assert!(PLUGIN_DESCRIPTION.contains("Feishu"));
}

// ============================================================================
// CONFIG: CREATION AND DEFAULTS
// ============================================================================

#[test]
fn test_config_creation_defaults() {
    let config = FeishuConfig::new("cli_test123".to_string(), "secret123".to_string());

    assert_eq!(config.app_id, "cli_test123");
    assert_eq!(config.app_secret, "secret123");
    assert_eq!(config.domain, "feishu");
    assert!(config.allowed_chat_ids.is_empty());
    assert!(config.test_chat_id.is_none());
    assert!(config.should_ignore_bot_messages);
    assert!(!config.should_respond_only_to_mentions);
}

#[test]
fn test_config_builder_pattern() {
    let config = FeishuConfig::new("cli_test123".to_string(), "secret123".to_string())
        .with_domain("lark".to_string())
        .with_allowed_chat_ids(vec!["chat1".to_string(), "chat2".to_string()])
        .with_test_chat_id("test_chat".to_string())
        .with_ignore_bot_messages(false)
        .with_respond_only_to_mentions(true);

    assert_eq!(config.domain, "lark");
    assert_eq!(config.allowed_chat_ids, vec!["chat1", "chat2"]);
    assert_eq!(config.test_chat_id, Some("test_chat".to_string()));
    assert!(!config.should_ignore_bot_messages);
    assert!(config.should_respond_only_to_mentions);
}

// ============================================================================
// CONFIG: API ROOT / DOMAIN
// ============================================================================

#[test]
fn test_config_api_root_feishu() {
    let config = FeishuConfig::new("cli_test123".to_string(), "secret123".to_string());
    assert_eq!(config.api_root(), FEISHU_DOMAIN);
    assert_eq!(config.api_root(), "https://open.feishu.cn");
}

#[test]
fn test_config_api_root_lark() {
    let config = FeishuConfig::new("cli_test123".to_string(), "secret123".to_string())
        .with_domain("lark".to_string());
    assert_eq!(config.api_root(), LARK_DOMAIN);
    assert_eq!(config.api_root(), "https://open.larksuite.com");
}

#[test]
fn test_config_api_root_unknown_domain_defaults_to_feishu() {
    let config = FeishuConfig::new("cli_test123".to_string(), "secret123".to_string())
        .with_domain("unknown".to_string());
    assert_eq!(config.api_root(), FEISHU_DOMAIN);
}

// ============================================================================
// CONFIG: VALIDATION
// ============================================================================

#[test]
fn test_config_validation_valid() {
    let config = FeishuConfig::new("cli_test123".to_string(), "secret123".to_string());
    assert!(config.validate().is_ok());
}

#[test]
fn test_config_validation_valid_lark() {
    let config = FeishuConfig::new("cli_test123".to_string(), "secret123".to_string())
        .with_domain("lark".to_string());
    assert!(config.validate().is_ok());
}

#[test]
fn test_config_validation_empty_app_id() {
    let config = FeishuConfig::new("".to_string(), "secret123".to_string());
    let result = config.validate();
    assert!(result.is_err());
    let err_msg = result.unwrap_err().to_string();
    assert!(
        err_msg.contains("empty") || err_msg.contains("App ID"),
        "Error message should mention empty app ID, got: {}",
        err_msg
    );
}

#[test]
fn test_config_validation_missing_cli_prefix() {
    let config = FeishuConfig::new("test123".to_string(), "secret123".to_string());
    let result = config.validate();
    assert!(result.is_err());
    let err_msg = result.unwrap_err().to_string();
    assert!(
        err_msg.contains("cli_"),
        "Error message should mention cli_ prefix, got: {}",
        err_msg
    );
}

#[test]
fn test_config_validation_empty_app_secret() {
    let config = FeishuConfig::new("cli_test123".to_string(), "".to_string());
    let result = config.validate();
    assert!(result.is_err());
    let err_msg = result.unwrap_err().to_string();
    assert!(
        err_msg.contains("empty") || err_msg.contains("secret"),
        "Error message should mention empty secret, got: {}",
        err_msg
    );
}

#[test]
fn test_config_validation_invalid_domain() {
    let config = FeishuConfig::new("cli_test123".to_string(), "secret123".to_string())
        .with_domain("invalid".to_string());
    let result = config.validate();
    assert!(result.is_err());
    let err_msg = result.unwrap_err().to_string();
    assert!(
        err_msg.contains("feishu") || err_msg.contains("lark") || err_msg.contains("Domain"),
        "Error should mention valid domains, got: {}",
        err_msg
    );
}

// ============================================================================
// CONFIG: CHAT FILTERING
// ============================================================================

#[test]
fn test_config_chat_allowed_empty_list_allows_all() {
    let config = FeishuConfig::new("cli_test123".to_string(), "secret123".to_string());
    assert!(config.is_chat_allowed("any_chat_id"));
    assert!(config.is_chat_allowed("oc_test123"));
    assert!(config.is_chat_allowed(""));
}

#[test]
fn test_config_chat_allowed_with_whitelist() {
    let config = FeishuConfig::new("cli_test123".to_string(), "secret123".to_string())
        .with_allowed_chat_ids(vec![
            "oc_chat1".to_string(),
            "oc_chat2".to_string(),
            "oc_chat3".to_string(),
        ]);

    assert!(config.is_chat_allowed("oc_chat1"));
    assert!(config.is_chat_allowed("oc_chat2"));
    assert!(config.is_chat_allowed("oc_chat3"));
    assert!(!config.is_chat_allowed("oc_chat4"));
    assert!(!config.is_chat_allowed("not_in_list"));
}

// ============================================================================
// CONFIG: SERIALIZATION
// ============================================================================

#[test]
fn test_config_serialization_roundtrip() {
    let config = FeishuConfig::new("cli_test123".to_string(), "secret123".to_string())
        .with_domain("lark".to_string())
        .with_allowed_chat_ids(vec!["oc_1".to_string()])
        .with_test_chat_id("oc_test".to_string())
        .with_ignore_bot_messages(false)
        .with_respond_only_to_mentions(true);

    let json_str = serde_json::to_string(&config).unwrap();
    let deserialized: FeishuConfig = serde_json::from_str(&json_str).unwrap();

    assert_eq!(deserialized.app_id, "cli_test123");
    assert_eq!(deserialized.app_secret, "secret123");
    assert_eq!(deserialized.domain, "lark");
    assert_eq!(deserialized.allowed_chat_ids, vec!["oc_1"]);
    assert_eq!(deserialized.test_chat_id, Some("oc_test".to_string()));
    assert!(!deserialized.should_ignore_bot_messages);
    assert!(deserialized.should_respond_only_to_mentions);
}

// ============================================================================
// TYPES: EVENT TYPES
// ============================================================================

#[test]
fn test_event_type_display_all_variants() {
    assert_eq!(FeishuEventType::WorldJoined.to_string(), "FEISHU_WORLD_JOINED");
    assert_eq!(FeishuEventType::WorldConnected.to_string(), "FEISHU_WORLD_CONNECTED");
    assert_eq!(FeishuEventType::WorldLeft.to_string(), "FEISHU_WORLD_LEFT");
    assert_eq!(FeishuEventType::EntityJoined.to_string(), "FEISHU_ENTITY_JOINED");
    assert_eq!(FeishuEventType::EntityLeft.to_string(), "FEISHU_ENTITY_LEFT");
    assert_eq!(FeishuEventType::EntityUpdated.to_string(), "FEISHU_ENTITY_UPDATED");
    assert_eq!(FeishuEventType::MessageReceived.to_string(), "FEISHU_MESSAGE_RECEIVED");
    assert_eq!(FeishuEventType::MessageSent.to_string(), "FEISHU_MESSAGE_SENT");
    assert_eq!(FeishuEventType::ReactionReceived.to_string(), "FEISHU_REACTION_RECEIVED");
    assert_eq!(FeishuEventType::InteractionReceived.to_string(), "FEISHU_INTERACTION_RECEIVED");
    assert_eq!(FeishuEventType::SlashStart.to_string(), "FEISHU_SLASH_START");
}

#[test]
fn test_event_type_serialization() {
    let event = FeishuEventType::MessageReceived;
    let json_val = serde_json::to_value(event).unwrap();
    assert_eq!(json_val, serde_json::json!("MESSAGE_RECEIVED"));

    let deserialized: FeishuEventType = serde_json::from_value(json_val).unwrap();
    assert_eq!(deserialized, FeishuEventType::MessageReceived);
}

#[test]
fn test_event_type_equality() {
    assert_eq!(FeishuEventType::MessageReceived, FeishuEventType::MessageReceived);
    assert_ne!(FeishuEventType::MessageReceived, FeishuEventType::MessageSent);
}

// ============================================================================
// TYPES: CHAT TYPES
// ============================================================================

#[test]
fn test_chat_type_display() {
    assert_eq!(FeishuChatType::P2p.to_string(), "p2p");
    assert_eq!(FeishuChatType::Group.to_string(), "group");
}

#[test]
fn test_chat_type_serialization() {
    let p2p = FeishuChatType::P2p;
    let json_val = serde_json::to_value(p2p).unwrap();
    assert_eq!(json_val, serde_json::json!("p2p"));

    let group = FeishuChatType::Group;
    let json_val = serde_json::to_value(group).unwrap();
    assert_eq!(json_val, serde_json::json!("group"));

    let deserialized: FeishuChatType = serde_json::from_value(serde_json::json!("group")).unwrap();
    assert_eq!(deserialized, FeishuChatType::Group);
}

// ============================================================================
// TYPES: USER
// ============================================================================

#[test]
fn test_user_creation_full() {
    let user = FeishuUser {
        open_id: "ou_test123".to_string(),
        union_id: Some("on_test456".to_string()),
        user_id: Some("user_789".to_string()),
        name: Some("Test User".to_string()),
        avatar_url: Some("https://example.com/avatar.png".to_string()),
        is_bot: false,
    };

    assert_eq!(user.open_id, "ou_test123");
    assert_eq!(user.union_id, Some("on_test456".to_string()));
    assert_eq!(user.user_id, Some("user_789".to_string()));
    assert_eq!(user.name, Some("Test User".to_string()));
    assert_eq!(user.avatar_url, Some("https://example.com/avatar.png".to_string()));
    assert!(!user.is_bot);
}

#[test]
fn test_user_display_name_with_name() {
    let user = FeishuUser {
        open_id: "ou_test123".to_string(),
        union_id: None,
        user_id: None,
        name: Some("Alice Smith".to_string()),
        avatar_url: None,
        is_bot: false,
    };
    assert_eq!(user.display_name(), "Alice Smith");
}

#[test]
fn test_user_display_name_without_name() {
    let user = FeishuUser {
        open_id: "ou_test456".to_string(),
        union_id: None,
        user_id: None,
        name: None,
        avatar_url: None,
        is_bot: false,
    };
    assert_eq!(user.display_name(), "ou_test456");
}

#[test]
fn test_user_bot_flag() {
    let bot_user = FeishuUser {
        open_id: "ou_bot123".to_string(),
        union_id: None,
        user_id: None,
        name: Some("My Bot".to_string()),
        avatar_url: None,
        is_bot: true,
    };
    assert!(bot_user.is_bot);
    assert_eq!(bot_user.display_name(), "My Bot");
}

#[test]
fn test_user_serialization_roundtrip() {
    let user = FeishuUser {
        open_id: "ou_test123".to_string(),
        union_id: Some("on_test456".to_string()),
        user_id: None,
        name: Some("Test User".to_string()),
        avatar_url: None,
        is_bot: false,
    };

    let json_str = serde_json::to_string(&user).unwrap();
    let deserialized: FeishuUser = serde_json::from_str(&json_str).unwrap();

    assert_eq!(deserialized.open_id, "ou_test123");
    assert_eq!(deserialized.union_id, Some("on_test456".to_string()));
    assert_eq!(deserialized.user_id, None);
    assert_eq!(deserialized.name, Some("Test User".to_string()));
    assert!(!deserialized.is_bot);
}

// ============================================================================
// TYPES: CHAT
// ============================================================================

#[test]
fn test_chat_creation() {
    let chat = FeishuChat {
        chat_id: "oc_test123".to_string(),
        chat_type: FeishuChatType::Group,
        name: Some("Test Group".to_string()),
        owner_open_id: Some("ou_owner".to_string()),
        description: Some("A test group".to_string()),
        tenant_key: Some("tk_123".to_string()),
    };

    assert_eq!(chat.chat_id, "oc_test123");
    assert_eq!(chat.chat_type, FeishuChatType::Group);
    assert_eq!(chat.name, Some("Test Group".to_string()));
    assert_eq!(chat.owner_open_id, Some("ou_owner".to_string()));
    assert_eq!(chat.description, Some("A test group".to_string()));
}

#[test]
fn test_chat_display_name_with_name() {
    let chat = FeishuChat {
        chat_id: "oc_test123".to_string(),
        chat_type: FeishuChatType::Group,
        name: Some("Team Chat".to_string()),
        owner_open_id: None,
        description: None,
        tenant_key: None,
    };
    assert_eq!(chat.display_name(), "Team Chat");
}

#[test]
fn test_chat_display_name_without_name() {
    let chat = FeishuChat {
        chat_id: "oc_test456".to_string(),
        chat_type: FeishuChatType::P2p,
        name: None,
        owner_open_id: None,
        description: None,
        tenant_key: None,
    };
    assert_eq!(chat.display_name(), "oc_test456");
}

#[test]
fn test_chat_p2p_type() {
    let chat = FeishuChat {
        chat_id: "oc_p2p".to_string(),
        chat_type: FeishuChatType::P2p,
        name: None,
        owner_open_id: None,
        description: None,
        tenant_key: None,
    };
    assert_eq!(chat.chat_type, FeishuChatType::P2p);
}

#[test]
fn test_chat_serialization_roundtrip() {
    let chat = FeishuChat {
        chat_id: "oc_test123".to_string(),
        chat_type: FeishuChatType::Group,
        name: Some("Test Group".to_string()),
        owner_open_id: None,
        description: Some("Description".to_string()),
        tenant_key: None,
    };

    let json_str = serde_json::to_string(&chat).unwrap();
    let deserialized: FeishuChat = serde_json::from_str(&json_str).unwrap();

    assert_eq!(deserialized.chat_id, "oc_test123");
    assert_eq!(deserialized.chat_type, FeishuChatType::Group);
    assert_eq!(deserialized.name, Some("Test Group".to_string()));
}

// ============================================================================
// TYPES: CONTENT
// ============================================================================

#[test]
fn test_content_text() {
    let content = FeishuContent {
        text: Some("Hello, World!".to_string()),
        card: None,
        image_key: None,
        file_key: None,
    };

    assert_eq!(content.text, Some("Hello, World!".to_string()));
    assert!(content.card.is_none());
    assert!(content.image_key.is_none());
    assert!(content.file_key.is_none());
}

#[test]
fn test_content_card() {
    let card_json = serde_json::json!({
        "header": {
            "title": {
                "tag": "plain_text",
                "content": "Card Title"
            }
        },
        "elements": []
    });

    let content = FeishuContent {
        text: None,
        card: Some(card_json.clone()),
        image_key: None,
        file_key: None,
    };

    assert!(content.text.is_none());
    assert_eq!(content.card, Some(card_json));
}

#[test]
fn test_content_image() {
    let content = FeishuContent {
        text: None,
        card: None,
        image_key: Some("img_v2_test123".to_string()),
        file_key: None,
    };

    assert_eq!(content.image_key, Some("img_v2_test123".to_string()));
}

#[test]
fn test_content_file() {
    let content = FeishuContent {
        text: None,
        card: None,
        image_key: None,
        file_key: Some("file_v2_test123".to_string()),
    };

    assert_eq!(content.file_key, Some("file_v2_test123".to_string()));
}

#[test]
fn test_content_default() {
    let content = FeishuContent::default();
    assert!(content.text.is_none());
    assert!(content.card.is_none());
    assert!(content.image_key.is_none());
    assert!(content.file_key.is_none());
}

#[test]
fn test_content_serialization_text() {
    let content = FeishuContent {
        text: Some("Hello, World!".to_string()),
        card: None,
        image_key: None,
        file_key: None,
    };

    let json_str = serde_json::to_string(&content).unwrap();
    assert!(json_str.contains("Hello, World!"));

    let deserialized: FeishuContent = serde_json::from_str(&json_str).unwrap();
    assert_eq!(deserialized.text, Some("Hello, World!".to_string()));
}

#[test]
fn test_content_serialization_card() {
    let content = FeishuContent {
        text: None,
        card: Some(serde_json::json!({"type": "interactive"})),
        image_key: None,
        file_key: None,
    };

    let json_str = serde_json::to_string(&content).unwrap();
    let deserialized: FeishuContent = serde_json::from_str(&json_str).unwrap();
    assert_eq!(deserialized.card, Some(serde_json::json!({"type": "interactive"})));
}

// ============================================================================
// TYPES: MESSAGE PAYLOAD
// ============================================================================

#[test]
fn test_message_payload_construction() {
    let payload = FeishuMessagePayload {
        message_id: "msg_test123".to_string(),
        root_id: None,
        parent_id: None,
        msg_type: "text".to_string(),
        content: r#"{"text":"Hello"}"#.to_string(),
        create_time: "1700000000000".to_string(),
        chat: FeishuChat {
            chat_id: "oc_test".to_string(),
            chat_type: FeishuChatType::Group,
            name: Some("Test Chat".to_string()),
            owner_open_id: None,
            description: None,
            tenant_key: None,
        },
        sender: Some(FeishuUser {
            open_id: "ou_sender".to_string(),
            union_id: None,
            user_id: None,
            name: Some("Sender".to_string()),
            avatar_url: None,
            is_bot: false,
        }),
        mentions: None,
    };

    assert_eq!(payload.message_id, "msg_test123");
    assert_eq!(payload.msg_type, "text");
    assert_eq!(payload.chat.chat_id, "oc_test");
    assert_eq!(
        payload.sender.as_ref().unwrap().name,
        Some("Sender".to_string())
    );
}

#[test]
fn test_message_payload_with_thread() {
    let payload = FeishuMessagePayload {
        message_id: "msg_reply".to_string(),
        root_id: Some("msg_root".to_string()),
        parent_id: Some("msg_parent".to_string()),
        msg_type: "text".to_string(),
        content: r#"{"text":"Reply"}"#.to_string(),
        create_time: "1700000000000".to_string(),
        chat: FeishuChat {
            chat_id: "oc_test".to_string(),
            chat_type: FeishuChatType::Group,
            name: None,
            owner_open_id: None,
            description: None,
            tenant_key: None,
        },
        sender: None,
        mentions: None,
    };

    assert_eq!(payload.root_id, Some("msg_root".to_string()));
    assert_eq!(payload.parent_id, Some("msg_parent".to_string()));
}

#[test]
fn test_message_payload_with_mentions() {
    let payload = FeishuMessagePayload {
        message_id: "msg_test".to_string(),
        root_id: None,
        parent_id: None,
        msg_type: "text".to_string(),
        content: r#"{"text":"@bot hello"}"#.to_string(),
        create_time: "1700000000000".to_string(),
        chat: FeishuChat {
            chat_id: "oc_test".to_string(),
            chat_type: FeishuChatType::Group,
            name: None,
            owner_open_id: None,
            description: None,
            tenant_key: None,
        },
        sender: None,
        mentions: Some(vec![FeishuMention {
            key: "@_user_1".to_string(),
            id: "ou_bot123".to_string(),
            id_type: "open_id".to_string(),
            name: "MyBot".to_string(),
            tenant_key: None,
        }]),
    };

    let mentions = payload.mentions.unwrap();
    assert_eq!(mentions.len(), 1);
    assert_eq!(mentions[0].name, "MyBot");
    assert_eq!(mentions[0].id, "ou_bot123");
}

#[test]
fn test_message_payload_serialization() {
    let payload = FeishuMessagePayload {
        message_id: "msg_test".to_string(),
        root_id: None,
        parent_id: None,
        msg_type: "text".to_string(),
        content: r#"{"text":"Hello"}"#.to_string(),
        create_time: "1700000000000".to_string(),
        chat: FeishuChat {
            chat_id: "oc_test".to_string(),
            chat_type: FeishuChatType::P2p,
            name: None,
            owner_open_id: None,
            description: None,
            tenant_key: None,
        },
        sender: None,
        mentions: None,
    };

    let json_str = serde_json::to_string(&payload).unwrap();
    let deserialized: FeishuMessagePayload = serde_json::from_str(&json_str).unwrap();

    assert_eq!(deserialized.message_id, "msg_test");
    assert_eq!(deserialized.chat.chat_type, FeishuChatType::P2p);
}

// ============================================================================
// TYPES: REACTION PAYLOAD
// ============================================================================

#[test]
fn test_reaction_payload() {
    let payload = FeishuReactionPayload {
        message_id: "msg_123".to_string(),
        chat: FeishuChat {
            chat_id: "oc_test".to_string(),
            chat_type: FeishuChatType::Group,
            name: None,
            owner_open_id: None,
            description: None,
            tenant_key: None,
        },
        user: Some(FeishuUser {
            open_id: "ou_user".to_string(),
            union_id: None,
            user_id: None,
            name: Some("Reactor".to_string()),
            avatar_url: None,
            is_bot: false,
        }),
        reaction_type: "thumbsup".to_string(),
    };

    assert_eq!(payload.message_id, "msg_123");
    assert_eq!(payload.reaction_type, "thumbsup");
    assert_eq!(payload.user.unwrap().display_name(), "Reactor");
}

// ============================================================================
// TYPES: WORLD PAYLOAD
// ============================================================================

#[test]
fn test_world_payload() {
    let payload = FeishuWorldPayload {
        chat: FeishuChat {
            chat_id: "oc_world".to_string(),
            chat_type: FeishuChatType::Group,
            name: Some("World Chat".to_string()),
            owner_open_id: None,
            description: None,
            tenant_key: None,
        },
        bot_open_id: Some("ou_bot123".to_string()),
    };

    assert_eq!(payload.chat.chat_id, "oc_world");
    assert_eq!(payload.bot_open_id, Some("ou_bot123".to_string()));
}

// ============================================================================
// TYPES: ENTITY PAYLOAD
// ============================================================================

#[test]
fn test_entity_payload_actions() {
    let joined = EntityAction::Joined;
    let left = EntityAction::Left;
    let updated = EntityAction::Updated;

    assert_eq!(joined, EntityAction::Joined);
    assert_eq!(left, EntityAction::Left);
    assert_ne!(joined, left);
    assert_ne!(updated, left);
}

#[test]
fn test_entity_payload_serialization() {
    let payload = FeishuEntityPayload {
        user: FeishuUser {
            open_id: "ou_user123".to_string(),
            union_id: None,
            user_id: None,
            name: Some("Test User".to_string()),
            avatar_url: None,
            is_bot: false,
        },
        chat: FeishuChat {
            chat_id: "oc_test".to_string(),
            chat_type: FeishuChatType::Group,
            name: None,
            owner_open_id: None,
            description: None,
            tenant_key: None,
        },
        action: EntityAction::Joined,
    };

    let json_str = serde_json::to_string(&payload).unwrap();
    let deserialized: FeishuEntityPayload = serde_json::from_str(&json_str).unwrap();

    assert_eq!(deserialized.user.open_id, "ou_user123");
    assert_eq!(deserialized.action, EntityAction::Joined);
}

// ============================================================================
// TYPES: INTERACTION PAYLOAD
// ============================================================================

#[test]
fn test_interaction_payload() {
    let payload = FeishuInteractionPayload {
        interaction_type: "card_action".to_string(),
        action_tag: "button_click".to_string(),
        action_value: Some(serde_json::json!({"key": "approve", "value": true})),
        user: FeishuUser {
            open_id: "ou_user123".to_string(),
            union_id: None,
            user_id: None,
            name: Some("Clicker".to_string()),
            avatar_url: None,
            is_bot: false,
        },
        chat: Some(FeishuChat {
            chat_id: "oc_test".to_string(),
            chat_type: FeishuChatType::Group,
            name: None,
            owner_open_id: None,
            description: None,
            tenant_key: None,
        }),
        token: Some("token_123".to_string()),
    };

    assert_eq!(payload.interaction_type, "card_action");
    assert_eq!(payload.action_tag, "button_click");
    assert!(payload.action_value.is_some());
    assert_eq!(payload.token, Some("token_123".to_string()));
}

// ============================================================================
// TYPES: SETTINGS
// ============================================================================

#[test]
fn test_settings_default() {
    let settings = FeishuSettings::default();
    assert!(settings.allowed_chat_ids.is_empty());
    assert!(!settings.should_ignore_bot_messages);
    assert!(!settings.should_respond_only_to_mentions);
}

#[test]
fn test_settings_serialization() {
    let settings = FeishuSettings {
        allowed_chat_ids: vec!["oc_1".to_string(), "oc_2".to_string()],
        should_ignore_bot_messages: true,
        should_respond_only_to_mentions: false,
    };

    let json_str = serde_json::to_string(&settings).unwrap();
    let deserialized: FeishuSettings = serde_json::from_str(&json_str).unwrap();

    assert_eq!(deserialized.allowed_chat_ids.len(), 2);
    assert!(deserialized.should_ignore_bot_messages);
}

// ============================================================================
// TYPES: TENANT ACCESS TOKEN
// ============================================================================

#[test]
fn test_tenant_access_token_serialization() {
    let token = TenantAccessToken {
        tenant_access_token: "t-abc123".to_string(),
        expire: 7200,
    };

    let json_str = serde_json::to_string(&token).unwrap();
    let deserialized: TenantAccessToken = serde_json::from_str(&json_str).unwrap();

    assert_eq!(deserialized.tenant_access_token, "t-abc123");
    assert_eq!(deserialized.expire, 7200);
}

// ============================================================================
// TYPES: API RESPONSE
// ============================================================================

#[test]
fn test_api_response_success() {
    let response: FeishuApiResponse<serde_json::Value> = FeishuApiResponse {
        code: 0,
        msg: "success".to_string(),
        data: Some(serde_json::json!({"result": "ok"})),
    };

    assert_eq!(response.code, 0);
    assert_eq!(response.msg, "success");
    assert!(response.data.is_some());
}

#[test]
fn test_api_response_error() {
    let response: FeishuApiResponse<serde_json::Value> = FeishuApiResponse {
        code: 99991663,
        msg: "token is invalid".to_string(),
        data: None,
    };

    assert_ne!(response.code, 0);
    assert!(response.data.is_none());
}

#[test]
fn test_api_response_serialization_roundtrip() {
    let json_str = r#"{"code":0,"msg":"success","data":{"message_id":"msg_123"}}"#;
    let response: FeishuApiResponse<serde_json::Value> = serde_json::from_str(json_str).unwrap();

    assert_eq!(response.code, 0);
    assert_eq!(
        response.data.unwrap()["message_id"],
        serde_json::json!("msg_123")
    );
}

// ============================================================================
// ERRORS: DISPLAY AND CLASSIFICATION
// ============================================================================

#[test]
fn test_error_display_messages() {
    let err = FeishuError::MissingSetting("FEISHU_APP_ID".to_string());
    assert!(err.to_string().contains("FEISHU_APP_ID"));

    let err = FeishuError::ConfigError("invalid domain".to_string());
    assert!(err.to_string().contains("invalid domain"));

    let err = FeishuError::ApiError("unauthorized".to_string());
    assert!(err.to_string().contains("unauthorized"));

    let err = FeishuError::MessageTooLong {
        length: 5000,
        max: 4000,
    };
    assert!(err.to_string().contains("5000"));
    assert!(err.to_string().contains("4000"));

    let err = FeishuError::InvalidChatId("bad_id".to_string());
    assert!(err.to_string().contains("bad_id"));

    let err = FeishuError::ChatNotFound("oc_missing".to_string());
    assert!(err.to_string().contains("oc_missing"));

    let err = FeishuError::UserNotFound("ou_missing".to_string());
    assert!(err.to_string().contains("ou_missing"));

    let err = FeishuError::PermissionDenied("not admin".to_string());
    assert!(err.to_string().contains("not admin"));

    let err = FeishuError::ClientNotInitialized;
    assert!(err.to_string().contains("not initialized"));

    let err = FeishuError::AlreadyRunning;
    assert!(err.to_string().contains("already running"));

    let err = FeishuError::TokenExpired;
    assert!(err.to_string().contains("expired"));

    let err = FeishuError::ValidationFailed("missing chat_id".to_string());
    assert!(err.to_string().contains("missing chat_id"));

    let err = FeishuError::SerializationError("parse failed".to_string());
    assert!(err.to_string().contains("parse failed"));

    let err = FeishuError::WebSocketError("connection lost".to_string());
    assert!(err.to_string().contains("connection lost"));

    let err = FeishuError::Internal("unexpected state".to_string());
    assert!(err.to_string().contains("unexpected state"));
}

#[test]
fn test_error_retryable_classification() {
    // Retryable errors
    assert!(FeishuError::RateLimited { retry_after_secs: 10 }.is_retryable());
    assert!(FeishuError::Timeout { timeout_ms: 5000 }.is_retryable());
    assert!(FeishuError::TokenExpired.is_retryable());
    assert!(FeishuError::ConnectionFailed("timeout".to_string()).is_retryable());

    // Non-retryable errors
    assert!(!FeishuError::ClientNotInitialized.is_retryable());
    assert!(!FeishuError::AlreadyRunning.is_retryable());
    assert!(!FeishuError::ConfigError("bad".to_string()).is_retryable());
    assert!(!FeishuError::MissingSetting("key".to_string()).is_retryable());
    assert!(!FeishuError::InvalidChatId("id".to_string()).is_retryable());
    assert!(!FeishuError::PermissionDenied("denied".to_string()).is_retryable());
    assert!(!FeishuError::ValidationFailed("bad".to_string()).is_retryable());
    assert!(!FeishuError::ApiError("error".to_string()).is_retryable());
}

#[test]
fn test_error_retry_after_secs() {
    let rate_limited = FeishuError::RateLimited { retry_after_secs: 10 };
    assert_eq!(rate_limited.retry_after_secs(), Some(10));

    let timeout = FeishuError::Timeout { timeout_ms: 6000 };
    assert_eq!(timeout.retry_after_secs(), Some(3)); // 6000 / 2000

    let expired = FeishuError::TokenExpired;
    assert_eq!(expired.retry_after_secs(), Some(1));

    let non_retryable = FeishuError::ClientNotInitialized;
    assert_eq!(non_retryable.retry_after_secs(), None);

    let api_err = FeishuError::ApiError("error".to_string());
    assert_eq!(api_err.retry_after_secs(), None);
}

#[test]
fn test_error_from_serde_json() {
    let json_err: std::result::Result<serde_json::Value, _> = serde_json::from_str("invalid json");
    let feishu_err: FeishuError = json_err.unwrap_err().into();
    assert!(matches!(feishu_err, FeishuError::SerializationError(_)));
}

#[test]
fn test_error_from_io() {
    let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "file not found");
    let feishu_err: FeishuError = io_err.into();
    assert!(matches!(feishu_err, FeishuError::Internal(_)));
    assert!(feishu_err.to_string().contains("I/O error"));
}

// ============================================================================
// SERVICE: CREATION (no network required)
// ============================================================================

#[cfg(feature = "native")]
mod native_tests {
    use super::*;
    use elizaos_plugin_feishu::service::{split_message, FeishuService, MAX_MESSAGE_LENGTH};
    use elizaos_plugin_feishu::actions::{ActionContext, FeishuAction, SendMessageAction};
    use elizaos_plugin_feishu::providers::{ChatStateProvider, FeishuProvider, ProviderContext};

    #[test]
    fn test_service_creation() {
        let config = FeishuConfig::new("cli_test123".to_string(), "secret123".to_string());
        let service = FeishuService::new(config);
        assert_eq!(service.config().app_id, "cli_test123");
        assert_eq!(service.config().app_secret, "secret123");
        assert_eq!(service.config().domain, "feishu");
    }

    #[test]
    fn test_service_config_access() {
        let config = FeishuConfig::new("cli_test123".to_string(), "secret123".to_string())
            .with_domain("lark".to_string())
            .with_allowed_chat_ids(vec!["oc_1".to_string()]);

        let service = FeishuService::new(config);
        assert_eq!(service.config().domain, "lark");
        assert_eq!(service.config().allowed_chat_ids, vec!["oc_1"]);
        assert_eq!(service.config().api_root(), LARK_DOMAIN);
    }

    #[tokio::test]
    async fn test_service_not_running_initially() {
        let config = FeishuConfig::new("cli_test123".to_string(), "secret123".to_string());
        let service = FeishuService::new(config);
        assert!(!service.is_running().await);
        assert!(service.bot_open_id().await.is_none());
    }

    // ════════════════════════════════════════════════════════════════
    // SERVICE: MESSAGE SPLITTING
    // ════════════════════════════════════════════════════════════════

    #[test]
    fn test_split_message_short() {
        let msg = "Hello, world!";
        let parts = split_message(msg);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0], "Hello, world!");
    }

    #[test]
    fn test_split_message_empty() {
        let parts = split_message("");
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0], "");
    }

    #[test]
    fn test_split_message_exactly_max() {
        let msg = "a".repeat(MAX_MESSAGE_LENGTH);
        let parts = split_message(&msg);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].len(), MAX_MESSAGE_LENGTH);
    }

    #[test]
    fn test_split_message_over_max() {
        let msg = "a".repeat(MAX_MESSAGE_LENGTH + 500);
        let parts = split_message(&msg);
        assert!(parts.len() > 1);
        for part in &parts {
            assert!(part.len() <= MAX_MESSAGE_LENGTH);
        }
    }

    #[test]
    fn test_split_message_multiline() {
        let line = "This is a test line. ".repeat(50);
        let msg = format!("{}\n{}\n{}", line, line, line);
        let parts = split_message(&msg);
        for part in &parts {
            assert!(
                part.len() <= MAX_MESSAGE_LENGTH,
                "Part length {} exceeds max {}",
                part.len(),
                MAX_MESSAGE_LENGTH
            );
        }
    }

    #[test]
    fn test_split_message_preserves_content() {
        let msg = "Line 1\nLine 2\nLine 3";
        let parts = split_message(msg);
        let rejoined = parts.join("");
        assert!(rejoined.contains("Line 1"));
        assert!(rejoined.contains("Line 2"));
        assert!(rejoined.contains("Line 3"));
    }

    #[test]
    fn test_max_message_length_constant() {
        assert_eq!(MAX_MESSAGE_LENGTH, 4000);
    }

    // ════════════════════════════════════════════════════════════════
    // ACTIONS: SEND MESSAGE
    // ════════════════════════════════════════════════════════════════

    #[test]
    fn test_send_message_action_name() {
        let action = SendMessageAction;
        assert_eq!(action.name(), "SEND_FEISHU_MESSAGE");
    }

    #[test]
    fn test_send_message_action_description() {
        let action = SendMessageAction;
        let desc = action.description();
        assert!(!desc.is_empty());
        assert!(desc.contains("Feishu") || desc.contains("message") || desc.contains("Lark"));
    }

    #[tokio::test]
    async fn test_send_message_validate_feishu_source() {
        let action = SendMessageAction;
        let context = ActionContext {
            message: serde_json::json!({
                "source": "feishu",
                "text": "Hello"
            }),
            chat_id: "oc_test123".to_string(),
            user_id: "ou_test456".to_string(),
            state: serde_json::json!({}),
        };

        assert!(action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_send_message_validate_non_feishu_source() {
        let action = SendMessageAction;

        let telegram_ctx = ActionContext {
            message: serde_json::json!({"source": "telegram"}),
            chat_id: "oc_test".to_string(),
            user_id: "ou_test".to_string(),
            state: serde_json::json!({}),
        };
        assert!(!action.validate(&telegram_ctx).await.unwrap());

        let discord_ctx = ActionContext {
            message: serde_json::json!({"source": "discord"}),
            chat_id: "oc_test".to_string(),
            user_id: "ou_test".to_string(),
            state: serde_json::json!({}),
        };
        assert!(!action.validate(&discord_ctx).await.unwrap());
    }

    #[tokio::test]
    async fn test_send_message_validate_missing_source() {
        let action = SendMessageAction;
        let context = ActionContext {
            message: serde_json::json!({"text": "no source field"}),
            chat_id: "oc_test".to_string(),
            user_id: "ou_test".to_string(),
            state: serde_json::json!({}),
        };

        assert!(!action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_send_message_execute_with_response() {
        let action = SendMessageAction;
        let context = ActionContext {
            message: serde_json::json!({
                "source": "feishu",
                "message_id": "msg_123"
            }),
            chat_id: "oc_test123".to_string(),
            user_id: "ou_test456".to_string(),
            state: serde_json::json!({
                "response": {
                    "text": "Hello, World!"
                }
            }),
        };

        let result = action.execute(&context).await.unwrap();
        assert_eq!(result["action"], "SEND_FEISHU_MESSAGE");
        assert_eq!(result["chat_id"], "oc_test123");
        assert_eq!(result["text"], "Hello, World!");
        assert_eq!(result["reply_to_message_id"], "msg_123");
    }

    #[tokio::test]
    async fn test_send_message_execute_empty_response() {
        let action = SendMessageAction;
        let context = ActionContext {
            message: serde_json::json!({"source": "feishu"}),
            chat_id: "oc_test".to_string(),
            user_id: "ou_test".to_string(),
            state: serde_json::json!({}),
        };

        let result = action.execute(&context).await.unwrap();
        assert_eq!(result["action"], "SEND_FEISHU_MESSAGE");
        assert_eq!(result["text"], "");
    }

    #[tokio::test]
    async fn test_send_message_execute_no_message_id() {
        let action = SendMessageAction;
        let context = ActionContext {
            message: serde_json::json!({"source": "feishu"}),
            chat_id: "oc_test".to_string(),
            user_id: "ou_test".to_string(),
            state: serde_json::json!({
                "response": {"text": "Reply"}
            }),
        };

        let result = action.execute(&context).await.unwrap();
        assert!(result["reply_to_message_id"].is_null());
    }

    // ════════════════════════════════════════════════════════════════
    // PROVIDERS: CHAT STATE
    // ════════════════════════════════════════════════════════════════

    #[test]
    fn test_chat_state_provider_name() {
        let provider = ChatStateProvider;
        assert_eq!(provider.name(), "FEISHU_CHAT_STATE");
    }

    #[test]
    fn test_chat_state_provider_description() {
        let provider = ChatStateProvider;
        let desc = provider.description();
        assert!(!desc.is_empty());
        assert!(desc.contains("Feishu") || desc.contains("chat") || desc.contains("state"));
    }

    #[test]
    fn test_chat_state_provider_feishu_source() {
        let provider = ChatStateProvider;
        let context = ProviderContext {
            message: serde_json::json!({"source": "feishu"}),
            chat_id: Some("oc_test123".to_string()),
            message_id: Some("msg_456".to_string()),
            state: serde_json::json!({}),
        };

        let result = provider.get(&context);
        assert!(result.is_some());
        let text = result.unwrap();
        assert!(text.contains("Feishu/Lark"));
        assert!(text.contains("oc_test123"));
        assert!(text.contains("msg_456"));
    }

    #[test]
    fn test_chat_state_provider_non_feishu_source() {
        let provider = ChatStateProvider;
        let context = ProviderContext {
            message: serde_json::json!({"source": "telegram"}),
            chat_id: Some("oc_test".to_string()),
            message_id: None,
            state: serde_json::json!({}),
        };

        assert!(provider.get(&context).is_none());
    }

    #[test]
    fn test_chat_state_provider_no_chat_id() {
        let provider = ChatStateProvider;
        let context = ProviderContext {
            message: serde_json::json!({"source": "feishu"}),
            chat_id: None,
            message_id: None,
            state: serde_json::json!({}),
        };

        assert!(provider.get(&context).is_none());
    }

    #[test]
    fn test_chat_state_provider_with_chat_type() {
        let provider = ChatStateProvider;
        let context = ProviderContext {
            message: serde_json::json!({"source": "feishu"}),
            chat_id: Some("oc_test123".to_string()),
            message_id: None,
            state: serde_json::json!({
                "feishu_chat_type": "group",
                "feishu_chat_name": "Team Chat"
            }),
        };

        let result = provider.get(&context);
        assert!(result.is_some());
        let text = result.unwrap();
        assert!(text.contains("group"), "Expected 'group' in output: {}", text);
        assert!(text.contains("Team Chat"), "Expected 'Team Chat' in output: {}", text);
    }

    #[test]
    fn test_chat_state_provider_no_message_id() {
        let provider = ChatStateProvider;
        let context = ProviderContext {
            message: serde_json::json!({"source": "feishu"}),
            chat_id: Some("oc_test123".to_string()),
            message_id: None,
            state: serde_json::json!({}),
        };

        let result = provider.get(&context);
        assert!(result.is_some());
        let text = result.unwrap();
        assert!(text.contains("oc_test123"));
        assert!(!text.contains("Message ID"));
    }

    #[test]
    fn test_chat_state_provider_output_format() {
        let provider = ChatStateProvider;
        let context = ProviderContext {
            message: serde_json::json!({"source": "feishu"}),
            chat_id: Some("oc_format_test".to_string()),
            message_id: Some("msg_format_test".to_string()),
            state: serde_json::json!({}),
        };

        let result = provider.get(&context).unwrap();
        let lines: Vec<&str> = result.lines().collect();

        // Should have Platform, Chat ID, and Message ID lines
        assert!(lines.len() >= 2, "Expected at least 2 lines, got {}", lines.len());
        assert!(lines[0].contains("Platform"));
        assert!(lines[1].contains("Chat ID"));
    }
}

// ============================================================================
// TYPES: MENTION
// ============================================================================

#[test]
fn test_mention_construction() {
    let mention = FeishuMention {
        key: "@_user_1".to_string(),
        id: "ou_user123".to_string(),
        id_type: "open_id".to_string(),
        name: "Test User".to_string(),
        tenant_key: Some("tk_123".to_string()),
    };

    assert_eq!(mention.key, "@_user_1");
    assert_eq!(mention.id, "ou_user123");
    assert_eq!(mention.id_type, "open_id");
    assert_eq!(mention.name, "Test User");
    assert_eq!(mention.tenant_key, Some("tk_123".to_string()));
}

#[test]
fn test_mention_serialization() {
    let mention = FeishuMention {
        key: "@_user_1".to_string(),
        id: "ou_test".to_string(),
        id_type: "open_id".to_string(),
        name: "Bot".to_string(),
        tenant_key: None,
    };

    let json_str = serde_json::to_string(&mention).unwrap();
    let deserialized: FeishuMention = serde_json::from_str(&json_str).unwrap();

    assert_eq!(deserialized.key, "@_user_1");
    assert_eq!(deserialized.name, "Bot");
}

// ============================================================================
// DOMAIN CONSTANTS
// ============================================================================

#[test]
fn test_domain_constants() {
    assert_eq!(FEISHU_DOMAIN, "https://open.feishu.cn");
    assert_eq!(LARK_DOMAIN, "https://open.larksuite.com");
}
