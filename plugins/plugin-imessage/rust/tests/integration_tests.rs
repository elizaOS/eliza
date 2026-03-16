//! Integration tests for the iMessage plugin.
//!
//! These tests verify the public API of the crate works correctly
//! without requiring macOS or iMessage credentials.

use elizaos_plugin_imessage::actions::extract_target_from_text;
use elizaos_plugin_imessage::config::IMessageConfig;
use elizaos_plugin_imessage::error::IMessageError;
use elizaos_plugin_imessage::service::{
    parse_chats_from_applescript, parse_messages_from_applescript,
};
use elizaos_plugin_imessage::types::{
    format_phone_number, is_email, is_phone_number, is_valid_imessage_target,
    normalize_imessage_target, split_message_for_imessage, DmPolicy, GroupPolicy, IMessageChat,
    IMessageChatType, IMessageContact, IMessageMessage, IMessageSendOptions, IMessageSendResult,
    MAX_IMESSAGE_MESSAGE_LENGTH,
};
use elizaos_plugin_imessage::IMESSAGE_SERVICE_NAME;

// ============================================================
// Constants
// ============================================================

#[test]
fn test_service_name() {
    assert_eq!(IMESSAGE_SERVICE_NAME, "imessage");
}

#[test]
fn test_max_message_length() {
    assert_eq!(MAX_IMESSAGE_MESSAGE_LENGTH, 4000);
}

// ============================================================
// is_phone_number
// ============================================================

#[test]
fn test_phone_valid_us() {
    assert!(is_phone_number("+15551234567"));
    assert!(is_phone_number("15551234567"));
}

#[test]
fn test_phone_formatted() {
    assert!(is_phone_number("1-555-123-4567"));
    assert!(is_phone_number("+44 7700 900000"));
}

#[test]
fn test_phone_rejects_email() {
    assert!(!is_phone_number("test@example.com"));
}

#[test]
fn test_phone_rejects_short() {
    assert!(!is_phone_number("12345"));
    assert!(!is_phone_number("123"));
}

#[test]
fn test_phone_rejects_text() {
    assert!(!is_phone_number("hello world"));
    assert!(!is_phone_number(""));
}

// ============================================================
// is_email
// ============================================================

#[test]
fn test_email_valid() {
    assert!(is_email("test@example.com"));
    assert!(is_email("user.name@domain.co.uk"));
    assert!(is_email("admin@sub.domain.org"));
}

#[test]
fn test_email_rejects_phone() {
    assert!(!is_email("+15551234567"));
}

#[test]
fn test_email_rejects_text() {
    assert!(!is_email("not an email"));
    assert!(!is_email("hello"));
    assert!(!is_email(""));
}

// ============================================================
// is_valid_imessage_target
// ============================================================

#[test]
fn test_valid_target_phone() {
    assert!(is_valid_imessage_target("+15551234567"));
}

#[test]
fn test_valid_target_email() {
    assert!(is_valid_imessage_target("user@example.com"));
}

#[test]
fn test_valid_target_chat_id() {
    assert!(is_valid_imessage_target("chat_id:iMessage;+;12345"));
}

#[test]
fn test_invalid_target() {
    assert!(!is_valid_imessage_target("hello world"));
    assert!(!is_valid_imessage_target("123"));
}

#[test]
fn test_valid_target_with_whitespace() {
    assert!(is_valid_imessage_target("  +15551234567  "));
}

// ============================================================
// normalize_imessage_target
// ============================================================

#[test]
fn test_normalize_empty() {
    assert_eq!(normalize_imessage_target(""), None);
    assert_eq!(normalize_imessage_target("   "), None);
}

#[test]
fn test_normalize_chat_id() {
    assert_eq!(
        normalize_imessage_target("chat_id:12345"),
        Some("chat_id:12345".to_string())
    );
}

#[test]
fn test_normalize_imessage_prefix() {
    let result = normalize_imessage_target("imessage:+15551234567");
    assert_eq!(result, Some("+15551234567".to_string()));
}

#[test]
fn test_normalize_trims() {
    assert_eq!(
        normalize_imessage_target("  +15551234567  "),
        Some("+15551234567".to_string())
    );
}

#[test]
fn test_normalize_passthrough() {
    assert_eq!(
        normalize_imessage_target("+15551234567"),
        Some("+15551234567".to_string())
    );
    assert_eq!(
        normalize_imessage_target("user@example.com"),
        Some("user@example.com".to_string())
    );
}

// ============================================================
// format_phone_number
// ============================================================

#[test]
fn test_format_removes_formatting() {
    assert_eq!(format_phone_number("+1 (555) 123-4567"), "+15551234567");
}

#[test]
fn test_format_adds_plus_prefix() {
    assert_eq!(format_phone_number("15551234567"), "+15551234567");
}

#[test]
fn test_format_preserves_plus() {
    assert_eq!(format_phone_number("+15551234567"), "+15551234567");
}

#[test]
fn test_format_ten_digits_no_plus() {
    assert_eq!(format_phone_number("5551234567"), "5551234567");
}

// ============================================================
// split_message_for_imessage
// ============================================================

#[test]
fn test_split_short_message() {
    let result = split_message_for_imessage("Hello world", 100);
    assert_eq!(result, vec!["Hello world"]);
}

#[test]
fn test_split_exact_max() {
    let text = "a".repeat(100);
    let result = split_message_for_imessage(&text, 100);
    assert_eq!(result.len(), 1);
    assert_eq!(result[0], text);
}

#[test]
fn test_split_long_at_word_boundary() {
    let words: String = (0..500).map(|i| format!("word{}", i)).collect::<Vec<_>>().join(" ");
    let result = split_message_for_imessage(&words, 100);
    assert!(result.len() > 1);
    for chunk in &result {
        assert!(chunk.len() <= 100);
    }
}

#[test]
fn test_split_prefers_newline() {
    let text = format!("{}\n{}", "a".repeat(60), "b".repeat(30));
    let result = split_message_for_imessage(&text, 80);
    assert_eq!(result.len(), 2);
    assert_eq!(result[0], "a".repeat(60));
    assert_eq!(result[1], "b".repeat(30));
}

#[test]
fn test_split_no_break_points() {
    let text = "a".repeat(200);
    let result = split_message_for_imessage(&text, 100);
    assert!(result.len() > 1);
    assert_eq!(result.join(""), text);
}

#[test]
fn test_split_default_max() {
    let text = "short message";
    let result = split_message_for_imessage(text, MAX_IMESSAGE_MESSAGE_LENGTH);
    assert_eq!(result, vec!["short message"]);
}

// ============================================================
// parse_messages_from_applescript
// ============================================================

#[test]
fn test_parse_messages_single() {
    let input = "msg001\tHello there\t1700000000000\t0\tchat123\t+15551234567";
    let result = parse_messages_from_applescript(input);

    assert_eq!(result.len(), 1);
    let msg = &result[0];
    assert_eq!(msg.id, "msg001");
    assert_eq!(msg.text, "Hello there");
    assert_eq!(msg.timestamp, 1700000000000i64);
    assert!(!msg.is_from_me);
    assert_eq!(msg.chat_id, "chat123");
    assert_eq!(msg.handle, "+15551234567");
    assert!(!msg.has_attachments);
    assert!(msg.attachment_paths.is_empty());
}

#[test]
fn test_parse_messages_multiple() {
    let input = "msg001\tHello\t1700000000000\t0\tchat1\t+15551111111\n\
                  msg002\tWorld\t1700000001000\t1\tchat1\t+15552222222\n\
                  msg003\tTest\t1700000002000\ttrue\tchat2\tuser@test.com";
    let result = parse_messages_from_applescript(input);

    assert_eq!(result.len(), 3);
    assert_eq!(result[0].text, "Hello");
    assert!(!result[0].is_from_me);
    assert_eq!(result[1].text, "World");
    assert!(result[1].is_from_me);
    assert_eq!(result[2].text, "Test");
    assert!(result[2].is_from_me);
}

#[test]
fn test_parse_messages_empty() {
    assert!(parse_messages_from_applescript("").is_empty());
}

#[test]
fn test_parse_messages_whitespace_only() {
    assert!(parse_messages_from_applescript("   \n  \n  ").is_empty());
}

#[test]
fn test_parse_messages_skips_incomplete() {
    let input = "partial\tdata\nmsg001\tHello\t1700000000000\t0\tchat1\t+15551234567";
    let result = parse_messages_from_applescript(input);
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].id, "msg001");
}

#[test]
fn test_parse_messages_is_from_me_variations() {
    let input = "m1\ttext\t1000\t1\tchat\tsender\n\
                  m2\ttext\t1000\ttrue\tchat\tsender\n\
                  m3\ttext\t1000\tTrue\tchat\tsender\n\
                  m4\ttext\t1000\t0\tchat\tsender\n\
                  m5\ttext\t1000\tfalse\tchat\tsender";
    let result = parse_messages_from_applescript(input);
    assert!(result[0].is_from_me);
    assert!(result[1].is_from_me);
    assert!(result[2].is_from_me);
    assert!(!result[3].is_from_me);
    assert!(!result[4].is_from_me);
}

#[test]
fn test_parse_messages_invalid_date() {
    let input = "msg001\tHello\tinvalid_date\t0\tchat1\tsender";
    let result = parse_messages_from_applescript(input);
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].timestamp, 0);
}

#[test]
fn test_parse_messages_empty_fields() {
    let input = "\t\t1000\t0\t\t";
    let result = parse_messages_from_applescript(input);
    assert_eq!(result.len(), 1);
    assert!(result[0].id.is_empty());
    assert!(result[0].text.is_empty());
    assert!(result[0].chat_id.is_empty());
    assert!(result[0].handle.is_empty());
}

#[test]
fn test_parse_messages_extra_fields() {
    let input = "msg001\tHello\t1000\t1\tchat1\tsender\textra1\textra2";
    let result = parse_messages_from_applescript(input);
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].id, "msg001");
}

// ============================================================
// parse_chats_from_applescript
// ============================================================

#[test]
fn test_parse_chats_group() {
    let input = "chat123\tWork Group\t5\t1700000000000";
    let result = parse_chats_from_applescript(input);

    assert_eq!(result.len(), 1);
    assert_eq!(result[0].chat_id, "chat123");
    assert_eq!(result[0].display_name, Some("Work Group".to_string()));
    assert_eq!(result[0].chat_type, IMessageChatType::Group);
    assert!(result[0].participants.is_empty());
}

#[test]
fn test_parse_chats_direct() {
    let input = "chat456\tJohn\t1\t1700000000000";
    let result = parse_chats_from_applescript(input);

    assert_eq!(result.len(), 1);
    assert_eq!(result[0].chat_type, IMessageChatType::Direct);
}

#[test]
fn test_parse_chats_multiple() {
    let input = "chat1\tWork\t5\t1000\nchat2\tFamily\t3\t2000\nchat3\t\t1\t3000";
    let result = parse_chats_from_applescript(input);

    assert_eq!(result.len(), 3);
    assert_eq!(result[0].chat_type, IMessageChatType::Group);
    assert_eq!(result[1].chat_type, IMessageChatType::Group);
    assert_eq!(result[2].chat_type, IMessageChatType::Direct);
}

#[test]
fn test_parse_chats_empty() {
    assert!(parse_chats_from_applescript("").is_empty());
}

#[test]
fn test_parse_chats_whitespace_only() {
    assert!(parse_chats_from_applescript("  \n  \n  ").is_empty());
}

#[test]
fn test_parse_chats_two_participants_is_group() {
    let input = "chat1\tTeam\t2\t1000";
    let result = parse_chats_from_applescript(input);
    assert_eq!(result[0].chat_type, IMessageChatType::Group);
}

#[test]
fn test_parse_chats_zero_participants_is_direct() {
    let input = "chat1\tUnknown\t0\t1000";
    let result = parse_chats_from_applescript(input);
    assert_eq!(result[0].chat_type, IMessageChatType::Direct);
}

#[test]
fn test_parse_chats_empty_display_name() {
    let input = "chat1\t\t1\t1000";
    let result = parse_chats_from_applescript(input);
    assert_eq!(result[0].display_name, None);
}

#[test]
fn test_parse_chats_invalid_participant_count() {
    let input = "chat1\tTest\tnotanumber\t1000";
    let result = parse_chats_from_applescript(input);
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].chat_type, IMessageChatType::Direct);
}

#[test]
fn test_parse_chats_skips_incomplete() {
    let input = "incomplete\tdata\nchat1\tTest\t3\t1000";
    let result = parse_chats_from_applescript(input);
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].chat_id, "chat1");
}

// ============================================================
// extract_target_from_text
// ============================================================

#[test]
fn test_extract_phone_from_text() {
    let target = extract_target_from_text("Send hello to +15551234567 please");
    assert!(target.is_some());
    assert_eq!(target.unwrap(), "+15551234567");
}

#[test]
fn test_extract_formatted_phone_from_text() {
    let target = extract_target_from_text("Text 1-555-123-4567 saying hi");
    assert!(target.is_some());
    let t = target.unwrap();
    assert!(t.contains("15551234567"));
}

#[test]
fn test_extract_email_from_text() {
    let target = extract_target_from_text("Message user@example.com about the meeting");
    assert!(target.is_some());
    assert_eq!(target.unwrap(), "user@example.com");
}

#[test]
fn test_extract_no_target() {
    let target = extract_target_from_text("Send a message to John about lunch");
    assert!(target.is_none());
}

#[test]
fn test_extract_empty_text() {
    assert!(extract_target_from_text("").is_none());
}

#[test]
fn test_extract_phone_preferred_over_email() {
    // If both are present, phone should be found first (it's tried first)
    let target = extract_target_from_text("Call +15551234567 or email user@test.com");
    assert!(target.is_some());
    assert_eq!(target.unwrap(), "+15551234567");
}

// ============================================================
// IMessageSendResult
// ============================================================

#[test]
fn test_send_result_success() {
    let result = IMessageSendResult::success("msg123".into(), "chat456".into());
    assert!(result.success);
    assert_eq!(result.message_id, Some("msg123".to_string()));
    assert_eq!(result.chat_id, Some("chat456".to_string()));
    assert!(result.error.is_none());
}

#[test]
fn test_send_result_failure() {
    let result = IMessageSendResult::failure("Something went wrong");
    assert!(!result.success);
    assert!(result.message_id.is_none());
    assert!(result.chat_id.is_none());
    assert_eq!(result.error, Some("Something went wrong".to_string()));
}

// ============================================================
// IMessageConfig
// ============================================================

#[test]
fn test_config_default() {
    let config = IMessageConfig::default();
    assert_eq!(config.cli_path, "imsg");
    assert!(config.enabled);
    assert_eq!(config.poll_interval_ms, 5000);
    assert_eq!(config.dm_policy, DmPolicy::Pairing);
    assert_eq!(config.group_policy, GroupPolicy::Allowlist);
    assert!(config.allow_from.is_empty());
}

#[test]
fn test_config_builders() {
    let config = IMessageConfig::default()
        .with_cli_path("/usr/local/bin/imsg")
        .with_db_path("/tmp/chat.db")
        .with_poll_interval(10000)
        .with_dm_policy(DmPolicy::Open)
        .with_group_policy(GroupPolicy::Disabled);

    assert_eq!(config.cli_path, "/usr/local/bin/imsg");
    assert_eq!(config.db_path, Some("/tmp/chat.db".to_string()));
    assert_eq!(config.poll_interval_ms, 10000);
    assert_eq!(config.dm_policy, DmPolicy::Open);
    assert_eq!(config.group_policy, GroupPolicy::Disabled);
}

#[test]
fn test_config_is_allowed_open() {
    let config = IMessageConfig::default().with_dm_policy(DmPolicy::Open);
    assert!(config.is_allowed("anyone"));
    assert!(config.is_allowed("+15551234567"));
}

#[test]
fn test_config_is_allowed_disabled() {
    let config = IMessageConfig::default().with_dm_policy(DmPolicy::Disabled);
    assert!(!config.is_allowed("anyone"));
}

#[test]
fn test_config_is_allowed_pairing() {
    let config = IMessageConfig::default().with_dm_policy(DmPolicy::Pairing);
    assert!(config.is_allowed("anyone"));
}

#[test]
fn test_config_is_allowed_allowlist() {
    let mut config = IMessageConfig::default().with_dm_policy(DmPolicy::Allowlist);
    config.allow_from = vec!["+15551234567".to_string()];

    assert!(config.is_allowed("+15551234567"));
    assert!(!config.is_allowed("+15559876543"));
}

#[test]
fn test_config_allowlist_case_insensitive() {
    let mut config = IMessageConfig::default().with_dm_policy(DmPolicy::Allowlist);
    config.allow_from = vec!["User@Test.com".to_string()];

    assert!(config.is_allowed("user@test.com"));
}

// ============================================================
// IMessageError
// ============================================================

#[test]
fn test_error_not_supported() {
    let err = IMessageError::NotSupported;
    let msg = format!("{}", err);
    assert!(msg.contains("macOS"));
}

#[test]
fn test_error_config() {
    let err = IMessageError::config("bad setting");
    let msg = format!("{}", err);
    assert!(msg.contains("bad setting"));
}

#[test]
fn test_error_applescript() {
    let err = IMessageError::applescript("script failed");
    let msg = format!("{}", err);
    assert!(msg.contains("script failed"));
}

#[test]
fn test_error_cli() {
    let err = IMessageError::cli("command failed", Some(1));
    let msg = format!("{}", err);
    assert!(msg.contains("command failed"));
}

#[test]
fn test_error_send() {
    let err = IMessageError::send("delivery failed");
    let msg = format!("{}", err);
    assert!(msg.contains("delivery failed"));
}

#[test]
fn test_error_invalid_target() {
    let err = IMessageError::invalid_target("bad_target");
    let msg = format!("{}", err);
    assert!(msg.contains("bad_target"));
}

#[test]
fn test_error_permission_denied() {
    let err = IMessageError::permission_denied("no access");
    let msg = format!("{}", err);
    assert!(msg.contains("no access"));
}

// ============================================================
// Type construction
// ============================================================

#[test]
fn test_imessage_contact() {
    let contact = IMessageContact {
        handle: "+15551234567".to_string(),
        display_name: Some("John".to_string()),
        is_phone_number: true,
    };
    assert_eq!(contact.handle, "+15551234567");
    assert_eq!(contact.display_name, Some("John".to_string()));
    assert!(contact.is_phone_number);
}

#[test]
fn test_imessage_send_options_default() {
    let opts = IMessageSendOptions::default();
    assert!(opts.media_url.is_none());
    assert!(opts.max_bytes.is_none());
}

#[test]
fn test_dm_policy_default() {
    assert_eq!(DmPolicy::default(), DmPolicy::Pairing);
}

#[test]
fn test_group_policy_default() {
    assert_eq!(GroupPolicy::default(), GroupPolicy::Allowlist);
}

// ============================================================
// Plugin creation
// ============================================================

#[test]
fn test_create_plugin() {
    let plugin = elizaos_plugin_imessage::create_plugin();
    assert_eq!(plugin.name, "imessage");
    assert!(!plugin.description.is_empty());
}

#[test]
fn test_is_macos() {
    let result = elizaos_plugin_imessage::is_macos();
    #[cfg(target_os = "macos")]
    assert!(result);
    #[cfg(not(target_os = "macos"))]
    assert!(!result);
}
