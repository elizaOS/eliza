//! Integration tests for the BlueBubbles plugin crate.

use elizaos_plugin_bluebubbles::config::{
    is_group_handle_allowed, is_handle_allowed, normalize_handle, BlueBubblesConfig,
    DEFAULT_WEBHOOK_PATH,
};
use elizaos_plugin_bluebubbles::types::{
    BlueBubblesSendResult, DmPolicy, GroupPolicy,
};
use elizaos_plugin_bluebubbles::actions::send_reaction::{
    SendReactionParams, SEND_REACTION_ACTION, SEND_REACTION_DESCRIPTION,
    SEND_REACTION_SIMILES, SEND_REACTION_TEMPLATE,
};
use elizaos_plugin_bluebubbles::create_plugin;

// ----------------------------------------------------------------
// Plugin creation
// ----------------------------------------------------------------

#[test]
fn test_create_plugin_name() {
    let plugin = create_plugin();
    assert_eq!(plugin.name, "bluebubbles");
}

#[test]
fn test_create_plugin_has_two_actions() {
    let plugin = create_plugin();
    assert_eq!(plugin.actions.len(), 2);
}

#[test]
fn test_create_plugin_has_one_provider() {
    let plugin = create_plugin();
    assert_eq!(plugin.providers.len(), 1);
}

#[test]
fn test_create_plugin_has_one_service() {
    let plugin = create_plugin();
    assert_eq!(plugin.services.len(), 1);
}

// ----------------------------------------------------------------
// Config validation
// ----------------------------------------------------------------

#[test]
fn test_valid_config() {
    let config = BlueBubblesConfig::new("http://localhost:1234", "password");
    assert!(config.validate().is_ok());
}

#[test]
fn test_empty_url_fails_validation() {
    let config = BlueBubblesConfig::new("", "password");
    assert!(config.validate().is_err());
}

#[test]
fn test_empty_password_fails_validation() {
    let config = BlueBubblesConfig::new("http://localhost:1234", "");
    assert!(config.validate().is_err());
}

#[test]
fn test_invalid_url_fails_validation() {
    let config = BlueBubblesConfig::new("not a valid url", "password");
    assert!(config.validate().is_err());
}

#[test]
fn test_config_default_values() {
    let config = BlueBubblesConfig::new("http://localhost:1234", "pw");
    assert_eq!(config.webhook_path, DEFAULT_WEBHOOK_PATH);
    assert_eq!(config.dm_policy, DmPolicy::Pairing);
    assert_eq!(config.group_policy, GroupPolicy::Allowlist);
    assert!(config.send_read_receipts);
    assert!(config.enabled);
    assert!(config.allow_from.is_empty());
    assert!(config.group_allow_from.is_empty());
}

#[test]
fn test_config_builder_methods() {
    let config = BlueBubblesConfig::new("http://localhost:1234", "pw")
        .with_dm_policy(DmPolicy::Open)
        .with_group_policy(GroupPolicy::Disabled)
        .with_webhook_path("/custom/webhook")
        .with_allow_from(vec!["+15551234567".to_string()])
        .with_group_allow_from(vec!["group@test.com".to_string()]);

    assert_eq!(config.dm_policy, DmPolicy::Open);
    assert_eq!(config.group_policy, GroupPolicy::Disabled);
    assert_eq!(config.webhook_path, "/custom/webhook");
    assert_eq!(config.allow_from, vec!["+15551234567"]);
    assert_eq!(config.group_allow_from, vec!["group@test.com"]);
}

// ----------------------------------------------------------------
// Handle normalization
// ----------------------------------------------------------------

#[test]
fn test_normalize_handle_phone_with_formatting() {
    assert_eq!(normalize_handle("+1 (555) 123-4567"), "+15551234567");
}

#[test]
fn test_normalize_handle_international() {
    assert_eq!(normalize_handle("+44 7700 900000"), "+447700900000");
}

#[test]
fn test_normalize_handle_email_lowercase() {
    assert_eq!(normalize_handle("User@Example.COM"), "user@example.com");
}

#[test]
fn test_normalize_handle_email_trimmed() {
    assert_eq!(normalize_handle("  test@test.com  "), "test@test.com");
}

// ----------------------------------------------------------------
// Access policies
// ----------------------------------------------------------------

#[test]
fn test_dm_open_allows_all() {
    assert!(is_handle_allowed("anyone", &[], DmPolicy::Open));
}

#[test]
fn test_dm_disabled_denies_all() {
    assert!(!is_handle_allowed("anyone", &[], DmPolicy::Disabled));
}

#[test]
fn test_dm_pairing_empty_allows_first() {
    assert!(is_handle_allowed(
        "first@contact.com",
        &[],
        DmPolicy::Pairing,
    ));
}

#[test]
fn test_dm_allowlist_match() {
    let allow = vec!["+15551234567".to_string()];
    assert!(is_handle_allowed(
        "+1 (555) 123-4567",
        &allow,
        DmPolicy::Allowlist,
    ));
}

#[test]
fn test_dm_allowlist_reject() {
    let allow = vec!["+15551234567".to_string()];
    assert!(!is_handle_allowed("+15559876543", &allow, DmPolicy::Allowlist));
}

#[test]
fn test_group_open_allows_all() {
    assert!(is_group_handle_allowed("anyone", &[], GroupPolicy::Open));
}

#[test]
fn test_group_disabled_denies_all() {
    assert!(!is_group_handle_allowed(
        "anyone",
        &[],
        GroupPolicy::Disabled,
    ));
}

#[test]
fn test_group_allowlist_match() {
    let allow = vec!["+15551234567".to_string()];
    assert!(is_group_handle_allowed(
        "+1 555 123 4567",
        &allow,
        GroupPolicy::Allowlist,
    ));
}

// ----------------------------------------------------------------
// Send reaction types & constants
// ----------------------------------------------------------------

#[test]
fn test_send_reaction_params_serialize() {
    let params = SendReactionParams {
        chat_guid: "iMessage;-;+15551234567".to_string(),
        message_guid: "msg-guid-1".to_string(),
        emoji: "❤️".to_string(),
        remove: false,
    };
    let json = serde_json::to_string(&params).unwrap();
    assert!(json.contains("iMessage;-;+15551234567"));
    assert!(json.contains("msg-guid-1"));
}

#[test]
fn test_send_reaction_params_remove_default() {
    let json = r#"{"chat_guid":"c","message_guid":"m","emoji":"👍"}"#;
    let params: SendReactionParams = serde_json::from_str(json).unwrap();
    assert!(!params.remove);
}

#[test]
fn test_send_reaction_action_constant() {
    assert_eq!(SEND_REACTION_ACTION, "BLUEBUBBLES_SEND_REACTION");
}

#[test]
fn test_send_reaction_similes_not_empty() {
    assert!(!SEND_REACTION_SIMILES.is_empty());
    assert!(SEND_REACTION_SIMILES.contains(&"BLUEBUBBLES_REACT"));
}

#[test]
fn test_send_reaction_description_not_empty() {
    assert!(!SEND_REACTION_DESCRIPTION.is_empty());
}

#[test]
fn test_send_reaction_template_has_placeholder() {
    assert!(SEND_REACTION_TEMPLATE.contains("{{recentMessages}}"));
}

// ----------------------------------------------------------------
// SendResult helpers
// ----------------------------------------------------------------

#[test]
fn test_send_result_success() {
    let res = BlueBubblesSendResult::success(
        Some("msg-1".to_string()),
        Some("chat-1".to_string()),
    );
    assert!(res.success);
    assert_eq!(res.message_id, Some("msg-1".to_string()));
    assert!(res.error.is_none());
}

#[test]
fn test_send_result_failure() {
    let res = BlueBubblesSendResult::failure("something went wrong");
    assert!(!res.success);
    assert!(res.message_id.is_none());
    assert_eq!(res.error, Some("something went wrong".to_string()));
}
