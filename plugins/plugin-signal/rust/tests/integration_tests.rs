//! Comprehensive integration tests for the Signal plugin.
//!
//! Tests cover:
//! - Config/settings creation and validation
//! - E.164 validation (valid numbers, invalid formats, edge cases)
//! - Group ID validation
//! - Number normalization
//! - UUID v4 validation
//! - Contact display name resolution
//! - Action metadata (name, similes, description)
//! - Action parameter serialization
//! - Provider output structure
//! - Formatting functions
//! - Error types and hierarchy
//! - Service creation failure modes

use elizaos_plugin_signal::types::*;
use elizaos_plugin_signal::actions::send_message;
use elizaos_plugin_signal::actions::send_reaction;
use elizaos_plugin_signal::actions::list_contacts;
use elizaos_plugin_signal::actions::list_groups;
use elizaos_plugin_signal::providers::conversation_state;
use elizaos_plugin_signal::{PLUGIN_NAME, PLUGIN_DESCRIPTION, PLUGIN_VERSION};

// =========================================================================
// Plugin-level metadata
// =========================================================================

#[test]
fn plugin_name_is_signal() {
    assert_eq!(PLUGIN_NAME, "signal");
}

#[test]
fn plugin_description_is_nonempty() {
    assert!(!PLUGIN_DESCRIPTION.is_empty());
    assert!(PLUGIN_DESCRIPTION.len() > 20);
}

#[test]
fn plugin_version_follows_semver() {
    assert!(PLUGIN_VERSION.contains('.'));
}

// =========================================================================
// Constants
// =========================================================================

#[test]
fn max_message_length_is_2000() {
    assert_eq!(MAX_SIGNAL_MESSAGE_LENGTH, 2000);
}

#[test]
fn max_attachment_size_is_100mb() {
    assert_eq!(MAX_SIGNAL_ATTACHMENT_SIZE, 100 * 1024 * 1024);
}

#[test]
fn service_name_is_signal() {
    assert_eq!(SIGNAL_SERVICE_NAME, "signal");
}

// =========================================================================
// is_valid_e164
// =========================================================================

mod e164_validation {
    use super::*;

    // --- positive cases ---

    #[test]
    fn valid_us_number() {
        assert!(is_valid_e164("+14155551234"));
    }

    #[test]
    fn valid_uk_number() {
        assert!(is_valid_e164("+447911123456"));
    }

    #[test]
    fn valid_minimum_length() {
        assert!(is_valid_e164("+12"));
    }

    #[test]
    fn valid_maximum_length_fifteen_digits() {
        assert!(is_valid_e164("+123456789012345"));
    }

    #[test]
    fn valid_single_digit_country_code() {
        assert!(is_valid_e164("+11234567890"));
    }

    // --- negative cases ---

    #[test]
    fn invalid_missing_plus() {
        assert!(!is_valid_e164("14155551234"));
    }

    #[test]
    fn invalid_leading_zero_country_code() {
        assert!(!is_valid_e164("+0123456789"));
    }

    #[test]
    fn invalid_empty_string() {
        assert!(!is_valid_e164(""));
    }

    #[test]
    fn invalid_plus_only() {
        assert!(!is_valid_e164("+"));
    }

    #[test]
    fn invalid_too_long() {
        assert!(!is_valid_e164("+1234567890123456")); // 16 digits
    }

    #[test]
    fn invalid_contains_letters() {
        assert!(!is_valid_e164("+1415abc1234"));
    }

    #[test]
    fn invalid_contains_spaces() {
        assert!(!is_valid_e164("+1 415 555 1234"));
    }

    #[test]
    fn invalid_contains_dashes() {
        assert!(!is_valid_e164("+1-415-555-1234"));
    }

    #[test]
    fn invalid_contains_parentheses() {
        assert!(!is_valid_e164("+1(415)5551234"));
    }

    #[test]
    fn invalid_double_plus() {
        assert!(!is_valid_e164("++14155551234"));
    }
}

// =========================================================================
// normalize_e164
// =========================================================================

mod e164_normalization {
    use super::*;

    #[test]
    fn already_valid_unchanged() {
        assert_eq!(normalize_e164("+14155551234"), Some("+14155551234".to_string()));
    }

    #[test]
    fn adds_plus_prefix() {
        assert_eq!(normalize_e164("14155551234"), Some("+14155551234".to_string()));
    }

    #[test]
    fn strips_dashes() {
        assert_eq!(normalize_e164("+1-415-555-1234"), Some("+14155551234".to_string()));
    }

    #[test]
    fn strips_spaces() {
        assert_eq!(normalize_e164("+1 415 555 1234"), Some("+14155551234".to_string()));
    }

    #[test]
    fn strips_parentheses() {
        assert_eq!(
            normalize_e164("+1 (415) 555-1234"),
            Some("+14155551234".to_string())
        );
    }

    #[test]
    fn strips_dots() {
        assert_eq!(normalize_e164("+1.415.555.1234"), Some("+14155551234".to_string()));
    }

    #[test]
    fn strips_brackets() {
        assert_eq!(normalize_e164("+1[415]5551234"), Some("+14155551234".to_string()));
    }

    #[test]
    fn combined_separators() {
        assert_eq!(
            normalize_e164("1-(415) 555.1234"),
            Some("+14155551234".to_string())
        );
    }

    #[test]
    fn empty_string_returns_none() {
        assert_eq!(normalize_e164(""), None);
    }

    #[test]
    fn all_letters_returns_none() {
        assert_eq!(normalize_e164("invalid"), None);
    }

    #[test]
    fn plus_only_returns_none() {
        assert_eq!(normalize_e164("+"), None);
    }

    #[test]
    fn leading_zero_country_code_returns_none() {
        assert_eq!(normalize_e164("+01234567"), None);
    }

    #[test]
    fn too_many_digits_returns_none() {
        assert_eq!(normalize_e164("+1234567890123456"), None);
    }
}

// =========================================================================
// is_valid_uuid
// =========================================================================

mod uuid_validation {
    use super::*;

    #[test]
    fn valid_lowercase() {
        assert!(is_valid_uuid("a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"));
    }

    #[test]
    fn valid_uppercase() {
        assert!(is_valid_uuid("A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D"));
    }

    #[test]
    fn valid_mixed_case() {
        assert!(is_valid_uuid("a1B2c3D4-e5F6-4a7B-8c9D-0e1F2a3B4c5D"));
    }

    #[test]
    fn invalid_version_not_4() {
        assert!(!is_valid_uuid("a1b2c3d4-e5f6-3a7b-8c9d-0e1f2a3b4c5d"));
    }

    #[test]
    fn invalid_variant_bits() {
        assert!(!is_valid_uuid("a1b2c3d4-e5f6-4a7b-0c9d-0e1f2a3b4c5d"));
    }

    #[test]
    fn invalid_empty() {
        assert!(!is_valid_uuid(""));
    }

    #[test]
    fn invalid_random_string() {
        assert!(!is_valid_uuid("not-a-uuid"));
    }

    #[test]
    fn invalid_no_hyphens() {
        assert!(!is_valid_uuid("a1b2c3d4e5f64a7b8c9d0e1f2a3b4c5d"));
    }
}

// =========================================================================
// is_valid_group_id
// =========================================================================

mod group_id_validation {
    use super::*;

    #[test]
    fn valid_base64_with_padding() {
        assert!(is_valid_group_id("YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo="));
    }

    #[test]
    fn valid_base64_no_padding() {
        assert!(is_valid_group_id("YWJjZGVmZ2hpamtsbW5vcHFy"));
    }

    #[test]
    fn valid_with_plus_and_slash() {
        assert!(is_valid_group_id("YWJjZGVmZ2hp+amtsbW5v/w=="));
    }

    #[test]
    fn valid_exactly_20_chars() {
        assert!(is_valid_group_id("YWJjZGVmZ2hpamtsbW5v")); // 20 chars
    }

    #[test]
    fn invalid_too_short() {
        assert!(!is_valid_group_id("YWJjZGVmZ2hpamts")); // 16 chars
    }

    #[test]
    fn invalid_empty() {
        assert!(!is_valid_group_id(""));
    }

    #[test]
    fn invalid_special_chars() {
        assert!(!is_valid_group_id("YWJjZGVmZ2hpamts!@#$bW5v"));
    }

    #[test]
    fn invalid_19_chars() {
        assert!(!is_valid_group_id("YWJjZGVmZ2hpamtsbW4")); // 19 chars
    }
}

// =========================================================================
// Contact display name
// =========================================================================

mod contact_display_name {
    use super::*;

    #[test]
    fn prefers_name_field() {
        let contact = SignalContact {
            number: "+14155551234".to_string(),
            name: Some("Full Name".to_string()),
            profile_name: Some("Profile".to_string()),
            given_name: Some("Given".to_string()),
            ..Default::default()
        };
        assert_eq!(contact.display_name(), "Full Name");
    }

    #[test]
    fn falls_back_to_profile_name() {
        let contact = SignalContact {
            number: "+14155551234".to_string(),
            profile_name: Some("ProfileName".to_string()),
            given_name: Some("Given".to_string()),
            ..Default::default()
        };
        assert_eq!(contact.display_name(), "ProfileName");
    }

    #[test]
    fn falls_back_to_given_name() {
        let contact = SignalContact {
            number: "+14155551234".to_string(),
            given_name: Some("Alice".to_string()),
            ..Default::default()
        };
        assert_eq!(contact.display_name(), "Alice");
    }

    #[test]
    fn combines_given_and_family_name() {
        let contact = SignalContact {
            number: "+14155551234".to_string(),
            given_name: Some("Alice".to_string()),
            family_name: Some("Smith".to_string()),
            ..Default::default()
        };
        assert_eq!(contact.display_name(), "Alice Smith");
    }

    #[test]
    fn falls_back_to_phone_number() {
        let contact = SignalContact {
            number: "+14155551234".to_string(),
            ..Default::default()
        };
        assert_eq!(contact.display_name(), "+14155551234");
    }

    #[test]
    fn ignores_empty_name() {
        let contact = SignalContact {
            number: "+14155551234".to_string(),
            name: Some(String::new()),
            profile_name: Some("Fallback".to_string()),
            ..Default::default()
        };
        assert_eq!(contact.display_name(), "Fallback");
    }

    #[test]
    fn ignores_empty_profile_name() {
        let contact = SignalContact {
            number: "+14155551234".to_string(),
            profile_name: Some(String::new()),
            given_name: Some("Alice".to_string()),
            ..Default::default()
        };
        assert_eq!(contact.display_name(), "Alice");
    }

    #[test]
    fn ignores_empty_given_name() {
        let contact = SignalContact {
            number: "+14155551234".to_string(),
            given_name: Some(String::new()),
            ..Default::default()
        };
        assert_eq!(contact.display_name(), "+14155551234");
    }

    #[test]
    fn get_signal_contact_display_name_delegates() {
        let contact = SignalContact {
            number: "+14155551234".to_string(),
            name: Some("Delegated".to_string()),
            ..Default::default()
        };
        assert_eq!(get_signal_contact_display_name(&contact), "Delegated");
    }
}

// =========================================================================
// SignalSettings
// =========================================================================

mod settings_tests {
    use super::*;

    #[test]
    fn default_settings() {
        let settings = SignalSettings::default();
        assert!(settings.account_number.is_empty());
        assert!(settings.http_url.is_none());
        assert!(settings.cli_path.is_none());
        assert!(!settings.should_ignore_group_messages);
        assert_eq!(settings.poll_interval_ms, 1000);
        assert!(settings.typing_indicator_enabled);
    }

    #[test]
    fn custom_settings() {
        let settings = SignalSettings {
            account_number: "+14155551234".to_string(),
            http_url: Some("http://localhost:8080".to_string()),
            cli_path: None,
            should_ignore_group_messages: true,
            poll_interval_ms: 2000,
            typing_indicator_enabled: false,
        };
        assert_eq!(settings.account_number, "+14155551234");
        assert_eq!(settings.http_url.as_deref(), Some("http://localhost:8080"));
        assert!(settings.should_ignore_group_messages);
        assert_eq!(settings.poll_interval_ms, 2000);
        assert!(!settings.typing_indicator_enabled);
    }

    #[test]
    fn settings_serialization_roundtrip() {
        let original = SignalSettings {
            account_number: "+14155551234".to_string(),
            http_url: Some("http://localhost:8080".to_string()),
            cli_path: None,
            should_ignore_group_messages: false,
            poll_interval_ms: 1000,
            typing_indicator_enabled: true,
        };
        let json = serde_json::to_string(&original).unwrap();
        let deserialized: SignalSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.account_number, original.account_number);
        assert_eq!(deserialized.http_url, original.http_url);
    }
}

// =========================================================================
// SignalEventType
// =========================================================================

mod event_type_tests {
    use super::*;

    #[test]
    fn message_received_as_str() {
        assert_eq!(
            SignalEventType::MessageReceived.as_str(),
            "SIGNAL_MESSAGE_RECEIVED"
        );
    }

    #[test]
    fn message_sent_as_str() {
        assert_eq!(SignalEventType::MessageSent.as_str(), "SIGNAL_MESSAGE_SENT");
    }

    #[test]
    fn reaction_received_as_str() {
        assert_eq!(
            SignalEventType::ReactionReceived.as_str(),
            "SIGNAL_REACTION_RECEIVED"
        );
    }

    #[test]
    fn group_joined_as_str() {
        assert_eq!(SignalEventType::GroupJoined.as_str(), "SIGNAL_GROUP_JOINED");
    }

    #[test]
    fn group_left_as_str() {
        assert_eq!(SignalEventType::GroupLeft.as_str(), "SIGNAL_GROUP_LEFT");
    }

    #[test]
    fn typing_started_as_str() {
        assert_eq!(
            SignalEventType::TypingStarted.as_str(),
            "SIGNAL_TYPING_STARTED"
        );
    }

    #[test]
    fn typing_stopped_as_str() {
        assert_eq!(
            SignalEventType::TypingStopped.as_str(),
            "SIGNAL_TYPING_STOPPED"
        );
    }

    #[test]
    fn contact_updated_as_str() {
        assert_eq!(
            SignalEventType::ContactUpdated.as_str(),
            "SIGNAL_CONTACT_UPDATED"
        );
    }

    #[test]
    fn event_types_are_eq_comparable() {
        assert_eq!(SignalEventType::MessageReceived, SignalEventType::MessageReceived);
        assert_ne!(SignalEventType::MessageReceived, SignalEventType::MessageSent);
    }
}

// =========================================================================
// Error types
// =========================================================================

mod error_tests {
    use super::*;

    #[test]
    fn service_not_initialized_message() {
        let err = SignalPluginError::ServiceNotInitialized;
        let msg = err.to_string();
        assert!(msg.contains("not initialized"));
    }

    #[test]
    fn client_not_available_message() {
        let err = SignalPluginError::ClientNotAvailable;
        let msg = err.to_string();
        assert!(msg.contains("not available"));
    }

    #[test]
    fn configuration_error_captures_message() {
        let err = SignalPluginError::Configuration {
            message: "bad config".to_string(),
            setting_name: Some("SIGNAL_HTTP_URL".to_string()),
        };
        let msg = err.to_string();
        assert!(msg.contains("bad config"));
    }

    #[test]
    fn api_error_includes_status() {
        let err = SignalPluginError::Api {
            message: "request failed".to_string(),
            status_code: Some(502),
            response_body: Some("bad gateway".to_string()),
        };
        let msg = err.to_string();
        assert!(msg.contains("request failed"));
        assert!(msg.contains("502"));
    }

    #[test]
    fn invalid_phone_number_error() {
        let err = SignalPluginError::InvalidPhoneNumber("bad-number".to_string());
        let msg = err.to_string();
        assert!(msg.contains("bad-number"));
    }

    #[test]
    fn invalid_group_id_error() {
        let err = SignalPluginError::InvalidGroupId("bad-id".to_string());
        let msg = err.to_string();
        assert!(msg.contains("bad-id"));
    }
}

// =========================================================================
// Dataclass / struct construction and serialization
// =========================================================================

mod struct_tests {
    use super::*;

    #[test]
    fn signal_attachment_defaults() {
        let att = SignalAttachment::default();
        assert!(att.content_type.is_empty());
        assert!(att.filename.is_none());
        assert!(!att.voice_note);
        assert!(att.size.is_none());
    }

    #[test]
    fn signal_message_construction() {
        let msg = SignalMessage {
            timestamp: 1700000000000,
            source: "+14155551234".to_string(),
            text: Some("Hello".to_string()),
            source_uuid: None,
            source_device: None,
            attachments: vec![],
            group_id: None,
            quote: None,
            reaction: None,
            expires_in_seconds: None,
            is_view_once: false,
            sticker: None,
        };
        assert_eq!(msg.timestamp, 1700000000000);
        assert_eq!(msg.source, "+14155551234");
        assert_eq!(msg.text.as_deref(), Some("Hello"));
        assert!(!msg.is_view_once);
    }

    #[test]
    fn signal_reaction_info_construction() {
        let reaction = SignalReactionInfo {
            emoji: "\u{1F44D}".to_string(), // 👍
            target_author: "+14155551234".to_string(),
            target_sent_timestamp: 1700000000000,
            is_remove: false,
        };
        assert_eq!(reaction.emoji, "👍");
        assert!(!reaction.is_remove);
    }

    #[test]
    fn signal_group_default_is_member() {
        let group = SignalGroup::default();
        assert!(group.is_member);
        assert!(!group.is_blocked);
    }

    #[test]
    fn signal_group_member_default_role() {
        let member = SignalGroupMember::default();
        assert_eq!(member.role, "DEFAULT");
    }

    #[test]
    fn signal_message_send_options_defaults() {
        let opts = SignalMessageSendOptions::default();
        assert!(opts.attachments.is_empty());
        assert!(opts.mentions.is_empty());
        assert!(opts.quote_timestamp.is_none());
        assert!(opts.quote_author.is_none());
    }

    #[test]
    fn signal_message_serialization_roundtrip() {
        let msg = SignalMessage {
            timestamp: 1700000000000,
            source: "+14155551234".to_string(),
            text: Some("Test".to_string()),
            source_uuid: Some("a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d".to_string()),
            source_device: Some(1),
            attachments: vec![],
            group_id: None,
            quote: None,
            reaction: None,
            expires_in_seconds: None,
            is_view_once: false,
            sticker: None,
        };
        let json = serde_json::to_string(&msg).unwrap();
        let deserialized: SignalMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.timestamp, msg.timestamp);
        assert_eq!(deserialized.source, msg.source);
        assert_eq!(deserialized.text, msg.text);
    }

    #[test]
    fn signal_contact_serialization_roundtrip() {
        let contact = SignalContact {
            number: "+14155551234".to_string(),
            name: Some("John Doe".to_string()),
            profile_name: Some("JD".to_string()),
            blocked: false,
            ..Default::default()
        };
        let json = serde_json::to_string(&contact).unwrap();
        let deserialized: SignalContact = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.number, contact.number);
        assert_eq!(deserialized.name, contact.name);
    }

    #[test]
    fn signal_group_serialization_roundtrip() {
        let group = SignalGroup {
            id: "group123".to_string(),
            name: "Test Group".to_string(),
            description: Some("A test group".to_string()),
            members: vec![SignalGroupMember {
                uuid: "u1".to_string(),
                number: Some("+14155551234".to_string()),
                role: "ADMINISTRATOR".to_string(),
            }],
            is_member: true,
            is_blocked: false,
            ..Default::default()
        };
        let json = serde_json::to_string(&group).unwrap();
        let deserialized: SignalGroup = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.id, group.id);
        assert_eq!(deserialized.name, group.name);
        assert_eq!(deserialized.members.len(), 1);
        assert_eq!(deserialized.members[0].role, "ADMINISTRATOR");
    }

    #[test]
    fn send_message_result_types() {
        let result = SendMessageResult { timestamp: 1700000000000 };
        assert_eq!(result.timestamp, 1700000000000);
    }

    #[test]
    fn send_reaction_result_types() {
        let result = SendReactionResult { success: true };
        assert!(result.success);
    }
}

// =========================================================================
// send_message action metadata and params
// =========================================================================

mod send_message_action_tests {
    use super::*;

    #[test]
    fn action_name() {
        assert_eq!(send_message::ACTION_NAME, "SIGNAL_SEND_MESSAGE");
    }

    #[test]
    fn action_description_nonempty() {
        assert!(!send_message::ACTION_DESCRIPTION.is_empty());
        assert!(send_message::ACTION_DESCRIPTION.len() > 10);
    }

    #[test]
    fn action_similes_contains_expected() {
        let similes = send_message::ACTION_SIMILES;
        assert!(similes.contains(&"SEND_SIGNAL_MESSAGE"));
        assert!(similes.contains(&"TEXT_SIGNAL"));
        assert!(similes.contains(&"MESSAGE_SIGNAL"));
        assert!(similes.contains(&"SIGNAL_TEXT"));
    }

    #[test]
    fn params_serialization() {
        let params = send_message::SendMessageParams {
            text: "Hello!".to_string(),
            recipient: "+14155551234".to_string(),
            is_group: false,
            quote_timestamp: None,
            quote_author: None,
        };
        let json = serde_json::to_string(&params).unwrap();
        assert!(json.contains("Hello!"));
        assert!(json.contains("+14155551234"));
    }

    #[test]
    fn params_deserialization() {
        let json = r#"{"text":"Test","recipient":"+14155551234","is_group":true}"#;
        let params: send_message::SendMessageParams = serde_json::from_str(json).unwrap();
        assert_eq!(params.text, "Test");
        assert_eq!(params.recipient, "+14155551234");
        assert!(params.is_group);
    }

    #[test]
    fn params_with_quote() {
        let params = send_message::SendMessageParams {
            text: "Reply".to_string(),
            recipient: "+14155551234".to_string(),
            is_group: false,
            quote_timestamp: Some(1700000000000),
            quote_author: Some("+14155559999".to_string()),
        };
        let json = serde_json::to_string(&params).unwrap();
        assert!(json.contains("1700000000000"));
        assert!(json.contains("+14155559999"));
    }

    #[test]
    fn result_success() {
        let result = send_message::SendMessageResult {
            success: true,
            timestamp: Some(1700000000000),
            recipient: "+14155551234".to_string(),
            error: None,
        };
        assert!(result.success);
        assert_eq!(result.timestamp, Some(1700000000000));
        assert!(result.error.is_none());
    }

    #[test]
    fn result_failure() {
        let result = send_message::SendMessageResult {
            success: false,
            timestamp: None,
            recipient: "bad-number".to_string(),
            error: Some("Invalid phone number format".to_string()),
        };
        assert!(!result.success);
        assert!(result.timestamp.is_none());
        assert!(result.error.as_ref().unwrap().contains("Invalid"));
    }
}

// =========================================================================
// send_reaction action metadata and params
// =========================================================================

mod send_reaction_action_tests {
    use super::*;

    #[test]
    fn action_name() {
        assert_eq!(send_reaction::ACTION_NAME, "SIGNAL_SEND_REACTION");
    }

    #[test]
    fn action_description_mentions_react_or_emoji() {
        let desc = send_reaction::ACTION_DESCRIPTION.to_lowercase();
        assert!(desc.contains("react") || desc.contains("emoji"));
    }

    #[test]
    fn action_similes_contains_expected() {
        let similes = send_reaction::ACTION_SIMILES;
        assert!(similes.contains(&"REACT_SIGNAL"));
        assert!(similes.contains(&"SIGNAL_REACT"));
        assert!(similes.contains(&"ADD_SIGNAL_REACTION"));
        assert!(similes.contains(&"SIGNAL_EMOJI"));
    }

    #[test]
    fn params_serialization() {
        let params = send_reaction::SendReactionParams {
            emoji: "👍".to_string(),
            target_timestamp: 1700000000000,
            target_author: "+14155551234".to_string(),
            recipient: "+14155551234".to_string(),
            remove: false,
        };
        let json = serde_json::to_string(&params).unwrap();
        assert!(json.contains("👍"));
        assert!(json.contains("1700000000000"));
    }

    #[test]
    fn params_with_remove_flag() {
        let params = send_reaction::SendReactionParams {
            emoji: "👎".to_string(),
            target_timestamp: 1700000000000,
            target_author: "+14155551234".to_string(),
            recipient: "+14155551234".to_string(),
            remove: true,
        };
        let json = serde_json::to_string(&params).unwrap();
        assert!(json.contains("\"remove\":true"));
    }

    #[test]
    fn result_success() {
        let result = send_reaction::SendReactionResult {
            success: true,
            emoji: "👍".to_string(),
            action: "added".to_string(),
            error: None,
        };
        assert!(result.success);
        assert_eq!(result.action, "added");
    }

    #[test]
    fn result_removed() {
        let result = send_reaction::SendReactionResult {
            success: true,
            emoji: "👎".to_string(),
            action: "removed".to_string(),
            error: None,
        };
        assert_eq!(result.action, "removed");
    }
}

// =========================================================================
// list_contacts action metadata and formatting
// =========================================================================

mod list_contacts_action_tests {
    use super::*;

    #[test]
    fn action_name() {
        assert_eq!(list_contacts::ACTION_NAME, "SIGNAL_LIST_CONTACTS");
    }

    #[test]
    fn action_description_mentions_contacts() {
        assert!(list_contacts::ACTION_DESCRIPTION.to_lowercase().contains("contact"));
    }

    #[test]
    fn action_similes() {
        let similes = list_contacts::ACTION_SIMILES;
        assert!(similes.contains(&"LIST_SIGNAL_CONTACTS"));
        assert!(similes.contains(&"SHOW_CONTACTS"));
        assert!(similes.contains(&"GET_CONTACTS"));
        assert!(similes.contains(&"SIGNAL_CONTACTS"));
    }

    #[test]
    fn params_default() {
        let params = list_contacts::ListContactsParams::default();
        assert!(!params.include_blocked);
    }

    #[test]
    fn format_contacts_success() {
        let result = list_contacts::ListContactsResult {
            success: true,
            contact_count: 2,
            contacts: vec![
                list_contacts::ContactInfo {
                    number: "+14155551234".to_string(),
                    name: "Alice".to_string(),
                    uuid: None,
                },
                list_contacts::ContactInfo {
                    number: "+14155555678".to_string(),
                    name: "Bob".to_string(),
                    uuid: Some("uuid-1".to_string()),
                },
            ],
            error: None,
        };
        let text = list_contacts::format_contacts_text(&result);
        assert!(text.contains("Found 2 contacts"));
        assert!(text.contains("Alice"));
        assert!(text.contains("Bob"));
        assert!(text.contains("+14155551234"));
    }

    #[test]
    fn format_contacts_empty() {
        let result = list_contacts::ListContactsResult {
            success: true,
            contact_count: 0,
            contacts: vec![],
            error: None,
        };
        let text = list_contacts::format_contacts_text(&result);
        assert!(text.contains("No contacts found"));
    }

    #[test]
    fn format_contacts_error() {
        let result = list_contacts::ListContactsResult {
            success: false,
            contact_count: 0,
            contacts: vec![],
            error: Some("Network failure".to_string()),
        };
        let text = list_contacts::format_contacts_text(&result);
        assert!(text.contains("Failed"));
        assert!(text.contains("Network failure"));
    }

    #[test]
    fn result_serialization_roundtrip() {
        let result = list_contacts::ListContactsResult {
            success: true,
            contact_count: 1,
            contacts: vec![list_contacts::ContactInfo {
                number: "+14155551234".to_string(),
                name: "Test".to_string(),
                uuid: None,
            }],
            error: None,
        };
        let json = serde_json::to_string(&result).unwrap();
        let deserialized: list_contacts::ListContactsResult =
            serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.contact_count, 1);
        assert_eq!(deserialized.contacts[0].name, "Test");
    }
}

// =========================================================================
// list_groups action metadata and formatting
// =========================================================================

mod list_groups_action_tests {
    use super::*;

    #[test]
    fn action_name() {
        assert_eq!(list_groups::ACTION_NAME, "SIGNAL_LIST_GROUPS");
    }

    #[test]
    fn action_description_mentions_groups() {
        assert!(list_groups::ACTION_DESCRIPTION.to_lowercase().contains("group"));
    }

    #[test]
    fn action_similes() {
        let similes = list_groups::ACTION_SIMILES;
        assert!(similes.contains(&"LIST_SIGNAL_GROUPS"));
        assert!(similes.contains(&"SHOW_GROUPS"));
        assert!(similes.contains(&"GET_GROUPS"));
        assert!(similes.contains(&"SIGNAL_GROUPS"));
    }

    #[test]
    fn params_default() {
        let params = list_groups::ListGroupsParams::default();
        assert!(!params.include_left);
    }

    #[test]
    fn format_groups_success() {
        let result = list_groups::ListGroupsResult {
            success: true,
            group_count: 2,
            groups: vec![
                list_groups::GroupInfo {
                    id: "g1".to_string(),
                    name: "Family".to_string(),
                    description: Some("Family group".to_string()),
                    member_count: 5,
                },
                list_groups::GroupInfo {
                    id: "g2".to_string(),
                    name: "Work".to_string(),
                    description: None,
                    member_count: 10,
                },
            ],
            error: None,
        };
        let text = list_groups::format_groups_text(&result);
        assert!(text.contains("Found 2 groups"));
        assert!(text.contains("Family"));
        assert!(text.contains("5 members"));
        assert!(text.contains("Work"));
        assert!(text.contains("10 members"));
        assert!(text.contains("Family group"));
    }

    #[test]
    fn format_groups_truncates_long_description() {
        let long_desc = "x".repeat(100);
        let result = list_groups::ListGroupsResult {
            success: true,
            group_count: 1,
            groups: vec![list_groups::GroupInfo {
                id: "g1".to_string(),
                name: "Test".to_string(),
                description: Some(long_desc),
                member_count: 3,
            }],
            error: None,
        };
        let text = list_groups::format_groups_text(&result);
        assert!(text.contains("..."));
        // Should only contain 50 chars + "..."
        assert!(!text.contains(&"x".repeat(51)));
    }

    #[test]
    fn format_groups_empty() {
        let result = list_groups::ListGroupsResult {
            success: true,
            group_count: 0,
            groups: vec![],
            error: None,
        };
        let text = list_groups::format_groups_text(&result);
        assert!(text.contains("No groups found"));
    }

    #[test]
    fn format_groups_error() {
        let result = list_groups::ListGroupsResult {
            success: false,
            group_count: 0,
            groups: vec![],
            error: Some("API timeout".to_string()),
        };
        let text = list_groups::format_groups_text(&result);
        assert!(text.contains("Failed"));
        assert!(text.contains("API timeout"));
    }

    #[test]
    fn result_serialization_roundtrip() {
        let result = list_groups::ListGroupsResult {
            success: true,
            group_count: 1,
            groups: vec![list_groups::GroupInfo {
                id: "g1".to_string(),
                name: "Test".to_string(),
                description: None,
                member_count: 2,
            }],
            error: None,
        };
        let json = serde_json::to_string(&result).unwrap();
        let deserialized: list_groups::ListGroupsResult =
            serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.group_count, 1);
        assert_eq!(deserialized.groups[0].name, "Test");
    }
}

// =========================================================================
// Provider metadata and output structure
// =========================================================================

mod provider_tests {
    use super::*;

    #[test]
    fn provider_name() {
        assert_eq!(conversation_state::PROVIDER_NAME, "signalConversationState");
    }

    #[test]
    fn provider_description_mentions_conversation() {
        assert!(
            conversation_state::PROVIDER_DESCRIPTION
                .to_lowercase()
                .contains("conversation")
        );
    }

    #[test]
    fn default_result_has_unknown_type() {
        let result = conversation_state::ConversationStateResult::default();
        assert_eq!(result.data.conversation_type, "unknown");
        assert_eq!(result.values.conversation_type, "unknown");
        assert!(result.text.is_empty());
    }

    #[test]
    fn default_result_has_no_room() {
        let result = conversation_state::ConversationStateResult::default();
        assert!(result.data.room.is_none());
        assert!(result.data.account_number.is_none());
    }

    #[test]
    fn default_result_empty_names() {
        let result = conversation_state::ConversationStateResult::default();
        assert!(result.data.contact_name.is_empty());
        assert!(result.data.group_name.is_empty());
        assert!(result.values.contact_name.is_empty());
        assert!(result.values.group_name.is_empty());
    }

    #[test]
    fn room_info_construction() {
        let room = conversation_state::RoomInfo {
            channel_id: "+14155551234".to_string(),
            name: Some("DM Room".to_string()),
            metadata: std::collections::HashMap::new(),
        };
        assert_eq!(room.channel_id, "+14155551234");
        assert_eq!(room.name.as_deref(), Some("DM Room"));
    }

    #[test]
    fn conversation_state_data_construction() {
        let data = conversation_state::ConversationStateData {
            room: None,
            conversation_type: "DM".to_string(),
            contact_name: "Alice".to_string(),
            group_name: String::new(),
            channel_id: "+14155551234".to_string(),
            is_group: false,
            account_number: Some("+14155550100".to_string()),
        };
        assert_eq!(data.conversation_type, "DM");
        assert_eq!(data.contact_name, "Alice");
        assert!(!data.is_group);
        assert_eq!(data.account_number.as_deref(), Some("+14155550100"));
    }

    #[test]
    fn conversation_state_values_construction() {
        let values = conversation_state::ConversationStateValues {
            conversation_type: "GROUP".to_string(),
            contact_name: String::new(),
            group_name: "Family".to_string(),
            channel_id: "group_id".to_string(),
            is_group: true,
        };
        assert!(values.is_group);
        assert_eq!(values.group_name, "Family");
    }

    #[test]
    fn result_serialization_roundtrip() {
        let result = conversation_state::ConversationStateResult {
            data: conversation_state::ConversationStateData {
                room: None,
                conversation_type: "DM".to_string(),
                contact_name: "Test".to_string(),
                group_name: String::new(),
                channel_id: "+14155551234".to_string(),
                is_group: false,
                account_number: None,
            },
            values: conversation_state::ConversationStateValues {
                conversation_type: "DM".to_string(),
                contact_name: "Test".to_string(),
                group_name: String::new(),
                channel_id: "+14155551234".to_string(),
                is_group: false,
            },
            text: "Test text".to_string(),
        };
        let json = serde_json::to_string(&result).unwrap();
        let deserialized: conversation_state::ConversationStateResult =
            serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.data.conversation_type, "DM");
        assert_eq!(deserialized.text, "Test text");
    }
}

// =========================================================================
// Service creation failures (no network required)
// =========================================================================

mod service_creation_tests {
    use super::*;
    use elizaos_plugin_signal::service::SignalService;

    #[tokio::test]
    async fn fails_with_empty_account_number() {
        let settings = SignalSettings {
            account_number: String::new(),
            http_url: Some("http://localhost:8080".to_string()),
            ..Default::default()
        };
        let result = SignalService::new(settings).await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        match err {
            SignalPluginError::Configuration { message, setting_name } => {
                assert!(message.contains("SIGNAL_ACCOUNT_NUMBER"));
                assert_eq!(setting_name.as_deref(), Some("SIGNAL_ACCOUNT_NUMBER"));
            }
            other => panic!("Expected Configuration error, got: {:?}", other),
        }
    }

    #[tokio::test]
    async fn fails_with_invalid_phone_number() {
        let settings = SignalSettings {
            account_number: "not-a-number".to_string(),
            http_url: Some("http://localhost:8080".to_string()),
            ..Default::default()
        };
        let result = SignalService::new(settings).await;
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(err_msg.to_lowercase().contains("invalid") || err_msg.contains("phone"));
    }

    #[tokio::test]
    async fn fails_without_http_url_or_cli_path() {
        let settings = SignalSettings {
            account_number: "+14155551234".to_string(),
            http_url: None,
            cli_path: None,
            ..Default::default()
        };
        let result = SignalService::new(settings).await;
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("SIGNAL_HTTP_URL") || err_msg.contains("SIGNAL_CLI_PATH")
        );
    }

    #[tokio::test]
    async fn fails_with_cli_path_only_in_rust() {
        // Rust implementation requires HTTP URL
        let settings = SignalSettings {
            account_number: "+14155551234".to_string(),
            http_url: None,
            cli_path: Some("/usr/bin/signal-cli".to_string()),
            ..Default::default()
        };
        let result = SignalService::new(settings).await;
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(err_msg.contains("HTTP"));
    }

    #[tokio::test]
    async fn fails_with_invalid_http_url() {
        let settings = SignalSettings {
            account_number: "+14155551234".to_string(),
            http_url: Some("not a valid url %%%".to_string()),
            ..Default::default()
        };
        let result = SignalService::new(settings).await;
        assert!(result.is_err());
    }
}
