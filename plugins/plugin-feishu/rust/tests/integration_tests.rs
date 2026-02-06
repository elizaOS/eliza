//! Integration tests for the Feishu plugin.

use elizaos_plugin_feishu::{
    FeishuChatType, FeishuConfig, FeishuContent, FeishuEventType, FeishuUser,
};

#[test]
fn test_plugin_metadata() {
    let plugin = elizaos_plugin_feishu::plugin();
    assert_eq!(plugin.name, "feishu");
    assert!(!plugin.description.is_empty());
    assert!(!plugin.version.is_empty());
}

#[test]
fn test_config_creation() {
    let config = FeishuConfig::new("cli_test123".to_string(), "secret123".to_string());

    assert_eq!(config.app_id, "cli_test123");
    assert_eq!(config.app_secret, "secret123");
    assert_eq!(config.domain, "feishu");
    assert!(config.allowed_chat_ids.is_empty());
    assert!(config.validate().is_ok());
}

#[test]
fn test_config_lark_domain() {
    let config = FeishuConfig::new("cli_test123".to_string(), "secret123".to_string())
        .with_domain("lark".to_string());

    assert_eq!(config.domain, "lark");
    assert_eq!(config.api_root(), "https://open.larksuite.com");
}

#[test]
fn test_config_feishu_domain() {
    let config = FeishuConfig::new("cli_test123".to_string(), "secret123".to_string());
    assert_eq!(config.api_root(), "https://open.feishu.cn");
}

#[test]
fn test_config_validation() {
    // Valid config
    let valid = FeishuConfig::new("cli_test123".to_string(), "secret123".to_string());
    assert!(valid.validate().is_ok());

    // Invalid: empty app_id
    let invalid_id = FeishuConfig::new("".to_string(), "secret123".to_string());
    assert!(invalid_id.validate().is_err());

    // Invalid: app_id doesn't start with cli_
    let invalid_prefix = FeishuConfig::new("test123".to_string(), "secret123".to_string());
    assert!(invalid_prefix.validate().is_err());

    // Invalid: empty app_secret
    let invalid_secret = FeishuConfig::new("cli_test123".to_string(), "".to_string());
    assert!(invalid_secret.validate().is_err());
}

#[test]
fn test_chat_allowed() {
    let config = FeishuConfig::new("cli_test123".to_string(), "secret123".to_string())
        .with_allowed_chat_ids(vec!["oc_chat1".to_string(), "oc_chat2".to_string()]);

    assert!(config.is_chat_allowed("oc_chat1"));
    assert!(config.is_chat_allowed("oc_chat2"));
    assert!(!config.is_chat_allowed("oc_chat3"));

    // Empty list allows all
    let config_all = FeishuConfig::new("cli_test123".to_string(), "secret123".to_string());
    assert!(config_all.is_chat_allowed("any_chat"));
}

#[test]
fn test_event_type_display() {
    assert_eq!(
        FeishuEventType::MessageReceived.to_string(),
        "FEISHU_MESSAGE_RECEIVED"
    );
    assert_eq!(
        FeishuEventType::WorldJoined.to_string(),
        "FEISHU_WORLD_JOINED"
    );
    assert_eq!(
        FeishuEventType::WorldConnected.to_string(),
        "FEISHU_WORLD_CONNECTED"
    );
}

#[test]
fn test_chat_type_display() {
    assert_eq!(FeishuChatType::P2p.to_string(), "p2p");
    assert_eq!(FeishuChatType::Group.to_string(), "group");
}

#[test]
fn test_user_display_name() {
    let user_with_name = FeishuUser {
        open_id: "ou_test123".to_string(),
        union_id: None,
        user_id: None,
        name: Some("Test User".to_string()),
        avatar_url: None,
        is_bot: false,
    };
    assert_eq!(user_with_name.display_name(), "Test User");

    let user_without_name = FeishuUser {
        open_id: "ou_test456".to_string(),
        union_id: None,
        user_id: None,
        name: None,
        avatar_url: None,
        is_bot: false,
    };
    assert_eq!(user_without_name.display_name(), "ou_test456");
}

#[test]
fn test_content_serialization() {
    let content = FeishuContent {
        text: Some("Hello, World!".to_string()),
        card: None,
        image_key: None,
        file_key: None,
    };

    let json = serde_json::to_string(&content).unwrap();
    assert!(json.contains("Hello, World!"));

    let deserialized: FeishuContent = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.text, Some("Hello, World!".to_string()));
}
