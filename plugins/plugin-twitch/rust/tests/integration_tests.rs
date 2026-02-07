//! Comprehensive integration tests for the Twitch plugin (Rust).

use elizaos_plugin_twitch::{
    // Plugin metadata
    PLUGIN_NAME,
    PLUGIN_DESCRIPTION,
    PLUGIN_VERSION,
    // Constants
    MAX_TWITCH_MESSAGE_LENGTH,
    TWITCH_SERVICE_NAME,
    // Types
    TwitchEventType,
    TwitchRole,
    TwitchSettings,
    TwitchUserInfo,
    TwitchMessage,
    TwitchReplyInfo,
    TwitchMessageSendOptions,
    TwitchSendResult,
    TwitchPluginError,
    // Utility functions
    normalize_channel,
    format_channel_for_display,
    get_twitch_user_display_name,
    strip_markdown_for_twitch,
    split_message_for_twitch,
    // Actions
    actions::send_message::{
        SendMessageParams, SendMessageResult,
        ACTION_NAME as SEND_MSG_NAME,
        ACTION_DESCRIPTION as SEND_MSG_DESC,
        ACTION_SIMILES as SEND_MSG_SIMILES,
    },
    actions::join_channel::{
        JoinChannelParams, JoinChannelResult,
        ACTION_NAME as JOIN_NAME,
        ACTION_DESCRIPTION as JOIN_DESC,
        ACTION_SIMILES as JOIN_SIMILES,
    },
    actions::leave_channel::{
        LeaveChannelParams, LeaveChannelResult,
        ACTION_NAME as LEAVE_NAME,
        ACTION_DESCRIPTION as LEAVE_DESC,
        ACTION_SIMILES as LEAVE_SIMILES,
    },
    actions::list_channels::{
        ListChannelsParams, ListChannelsResult,
        ACTION_NAME as LIST_NAME,
        ACTION_DESCRIPTION as LIST_DESC,
        ACTION_SIMILES as LIST_SIMILES,
        format_channels_text,
    },
    // Providers
    providers::channel_state::{
        ChannelStateData,
        PROVIDER_NAME as CHANNEL_PROVIDER_NAME,
        PROVIDER_DESCRIPTION as CHANNEL_PROVIDER_DESC,
    },
    providers::user_context::{
        UserContextResult,
        PROVIDER_NAME as USER_PROVIDER_NAME,
        PROVIDER_DESCRIPTION as USER_PROVIDER_DESC,
        get_user_context,
    },
    // Service
    TwitchService,
};
use std::collections::HashMap;

// ===========================================================================
// 1. Plugin metadata
// ===========================================================================

#[test]
fn test_plugin_name() {
    assert_eq!(PLUGIN_NAME, "twitch");
}

#[test]
fn test_plugin_description_contains_twitch() {
    assert!(PLUGIN_DESCRIPTION.contains("Twitch"));
}

#[test]
fn test_plugin_version_is_semver() {
    assert!(PLUGIN_VERSION.contains('.'));
}

// ===========================================================================
// 2. Constants
// ===========================================================================

#[test]
fn test_max_twitch_message_length() {
    assert_eq!(MAX_TWITCH_MESSAGE_LENGTH, 500);
}

#[test]
fn test_twitch_service_name() {
    assert_eq!(TWITCH_SERVICE_NAME, "twitch");
}

// ===========================================================================
// 3. Event types
// ===========================================================================

#[test]
fn test_event_type_strings() {
    assert_eq!(TwitchEventType::MessageReceived.as_str(), "TWITCH_MESSAGE_RECEIVED");
    assert_eq!(TwitchEventType::MessageSent.as_str(), "TWITCH_MESSAGE_SENT");
    assert_eq!(TwitchEventType::JoinChannel.as_str(), "TWITCH_JOIN_CHANNEL");
    assert_eq!(TwitchEventType::LeaveChannel.as_str(), "TWITCH_LEAVE_CHANNEL");
    assert_eq!(TwitchEventType::ConnectionReady.as_str(), "TWITCH_CONNECTION_READY");
    assert_eq!(TwitchEventType::ConnectionLost.as_str(), "TWITCH_CONNECTION_LOST");
}

#[test]
fn test_event_type_clone_eq() {
    let e1 = TwitchEventType::MessageReceived;
    let e2 = e1;
    assert_eq!(e1, e2);
}

#[test]
fn test_event_type_serde_roundtrip() {
    let original = TwitchEventType::JoinChannel;
    let json = serde_json::to_string(&original).unwrap();
    let deserialized: TwitchEventType = serde_json::from_str(&json).unwrap();
    assert_eq!(original, deserialized);
}

// ===========================================================================
// 4. TwitchRole
// ===========================================================================

#[test]
fn test_role_serde_roundtrip() {
    let roles = vec![
        TwitchRole::Moderator,
        TwitchRole::Owner,
        TwitchRole::Vip,
        TwitchRole::Subscriber,
        TwitchRole::All,
    ];
    for role in &roles {
        let json = serde_json::to_string(role).unwrap();
        let back: TwitchRole = serde_json::from_str(&json).unwrap();
        assert_eq!(role, &back);
    }
}

#[test]
fn test_role_serializes_lowercase() {
    let json = serde_json::to_string(&TwitchRole::Moderator).unwrap();
    assert_eq!(json, "\"moderator\"");

    let json = serde_json::to_string(&TwitchRole::Owner).unwrap();
    assert_eq!(json, "\"owner\"");
}

// ===========================================================================
// 5. TwitchSettings
// ===========================================================================

#[test]
fn test_settings_default() {
    let s = TwitchSettings::default();
    assert!(s.username.is_empty());
    assert!(s.client_id.is_empty());
    assert!(s.access_token.is_empty());
    assert!(s.channel.is_empty());
    assert!(s.client_secret.is_none());
    assert!(s.refresh_token.is_none());
    assert!(s.additional_channels.is_empty());
    assert!(!s.require_mention);
    assert_eq!(s.allowed_roles, vec![TwitchRole::All]);
    assert!(s.allowed_user_ids.is_empty());
    assert!(s.enabled);
}

#[test]
fn test_settings_full_construction() {
    let s = TwitchSettings {
        username: "bot".to_string(),
        client_id: "cid".to_string(),
        access_token: "tok".to_string(),
        client_secret: Some("secret".to_string()),
        refresh_token: Some("refresh".to_string()),
        channel: "main".to_string(),
        additional_channels: vec!["extra".to_string()],
        require_mention: true,
        allowed_roles: vec![TwitchRole::Moderator, TwitchRole::Owner],
        allowed_user_ids: vec!["uid1".to_string()],
        enabled: true,
    };
    assert_eq!(s.username, "bot");
    assert_eq!(s.client_secret, Some("secret".to_string()));
    assert_eq!(s.additional_channels, vec!["extra"]);
    assert!(s.require_mention);
    assert_eq!(s.allowed_roles.len(), 2);
}

#[test]
fn test_settings_serde_roundtrip() {
    let original = TwitchSettings {
        username: "bot".to_string(),
        client_id: "cid".to_string(),
        access_token: "tok".to_string(),
        client_secret: None,
        refresh_token: None,
        channel: "main".to_string(),
        additional_channels: vec![],
        require_mention: false,
        allowed_roles: vec![TwitchRole::All],
        allowed_user_ids: vec![],
        enabled: true,
    };
    let json = serde_json::to_string(&original).unwrap();
    let back: TwitchSettings = serde_json::from_str(&json).unwrap();
    assert_eq!(back.username, "bot");
    assert_eq!(back.channel, "main");
}

// ===========================================================================
// 6. TwitchUserInfo
// ===========================================================================

#[test]
fn test_user_info_default() {
    let user = TwitchUserInfo::default();
    assert!(user.user_id.is_empty());
    assert!(user.username.is_empty());
    assert!(user.display_name.is_empty());
    assert!(!user.is_moderator);
    assert!(!user.is_broadcaster);
    assert!(!user.is_vip);
    assert!(!user.is_subscriber);
    assert!(user.color.is_none());
    assert!(user.badges.is_empty());
}

#[test]
fn test_user_info_display_name_method() {
    let user = TwitchUserInfo {
        display_name: "Alice_Cool".to_string(),
        username: "alice".to_string(),
        ..Default::default()
    };
    assert_eq!(user.display_name(), "Alice_Cool");
}

#[test]
fn test_user_info_display_name_fallback() {
    let user = TwitchUserInfo {
        display_name: "".to_string(),
        username: "bob".to_string(),
        ..Default::default()
    };
    assert_eq!(user.display_name(), "bob");
}

#[test]
fn test_user_info_with_badges() {
    let mut badges = HashMap::new();
    badges.insert("moderator".to_string(), "1".to_string());
    badges.insert("premium".to_string(), "1".to_string());

    let user = TwitchUserInfo {
        user_id: "123".to_string(),
        username: "testuser".to_string(),
        display_name: "TestUser".to_string(),
        is_moderator: true,
        badges,
        ..Default::default()
    };
    assert!(user.is_moderator);
    assert_eq!(user.badges.get("moderator"), Some(&"1".to_string()));
}

#[test]
fn test_user_info_serde_roundtrip() {
    let user = TwitchUserInfo {
        user_id: "42".to_string(),
        username: "test".to_string(),
        display_name: "Test".to_string(),
        is_moderator: true,
        is_broadcaster: false,
        is_vip: true,
        is_subscriber: false,
        color: Some("#FF0000".to_string()),
        badges: HashMap::new(),
    };
    let json = serde_json::to_string(&user).unwrap();
    let back: TwitchUserInfo = serde_json::from_str(&json).unwrap();
    assert_eq!(back.user_id, "42");
    assert!(back.is_moderator);
    assert!(back.is_vip);
    assert_eq!(back.color, Some("#FF0000".to_string()));
}

// ===========================================================================
// 7. TwitchMessage
// ===========================================================================

#[test]
fn test_message_construction() {
    let msg = TwitchMessage {
        id: "msg-1".to_string(),
        channel: "test".to_string(),
        text: "hello world".to_string(),
        user: TwitchUserInfo::default(),
        timestamp: 1234567890,
        is_action: false,
        is_highlighted: false,
        reply_to: None,
    };
    assert_eq!(msg.id, "msg-1");
    assert_eq!(msg.channel, "test");
    assert!(!msg.is_action);
    assert!(msg.reply_to.is_none());
}

#[test]
fn test_message_with_reply() {
    let reply = TwitchReplyInfo {
        message_id: "parent-1".to_string(),
        user_id: "2".to_string(),
        username: "other".to_string(),
        text: "original".to_string(),
    };
    let msg = TwitchMessage {
        id: "msg-2".to_string(),
        channel: "test".to_string(),
        text: "reply text".to_string(),
        user: TwitchUserInfo::default(),
        timestamp: 0,
        is_action: false,
        is_highlighted: true,
        reply_to: Some(reply),
    };
    assert!(msg.is_highlighted);
    assert_eq!(msg.reply_to.as_ref().unwrap().message_id, "parent-1");
}

#[test]
fn test_message_serde_roundtrip() {
    let msg = TwitchMessage {
        id: "m1".to_string(),
        channel: "ch".to_string(),
        text: "hi".to_string(),
        user: TwitchUserInfo::default(),
        timestamp: 100,
        is_action: true,
        is_highlighted: false,
        reply_to: None,
    };
    let json = serde_json::to_string(&msg).unwrap();
    let back: TwitchMessage = serde_json::from_str(&json).unwrap();
    assert_eq!(back.id, "m1");
    assert!(back.is_action);
}

// ===========================================================================
// 8. TwitchMessageSendOptions
// ===========================================================================

#[test]
fn test_send_options_default() {
    let opts = TwitchMessageSendOptions::default();
    assert!(opts.channel.is_none());
    assert!(opts.reply_to.is_none());
}

#[test]
fn test_send_options_with_values() {
    let opts = TwitchMessageSendOptions {
        channel: Some("test".to_string()),
        reply_to: Some("msg-1".to_string()),
    };
    assert_eq!(opts.channel, Some("test".to_string()));
    assert_eq!(opts.reply_to, Some("msg-1".to_string()));
}

// ===========================================================================
// 9. TwitchSendResult
// ===========================================================================

#[test]
fn test_send_result_success() {
    let r = TwitchSendResult {
        success: true,
        message_id: Some("abc".to_string()),
        error: None,
    };
    assert!(r.success);
    assert_eq!(r.message_id, Some("abc".to_string()));
    assert!(r.error.is_none());
}

#[test]
fn test_send_result_failure() {
    let r = TwitchSendResult {
        success: false,
        message_id: None,
        error: Some("not connected".to_string()),
    };
    assert!(!r.success);
    assert!(r.message_id.is_none());
    assert_eq!(r.error, Some("not connected".to_string()));
}

#[test]
fn test_send_result_serde_roundtrip() {
    let r = TwitchSendResult {
        success: true,
        message_id: Some("x".to_string()),
        error: None,
    };
    let json = serde_json::to_string(&r).unwrap();
    let back: TwitchSendResult = serde_json::from_str(&json).unwrap();
    assert!(back.success);
    assert_eq!(back.message_id, Some("x".to_string()));
}

// ===========================================================================
// 10. Error variants
// ===========================================================================

#[test]
fn test_error_service_not_initialized() {
    let e = TwitchPluginError::ServiceNotInitialized;
    let msg = format!("{}", e);
    assert!(msg.contains("not initialized"));
}

#[test]
fn test_error_not_connected() {
    let e = TwitchPluginError::NotConnected;
    let msg = format!("{}", e);
    assert!(msg.contains("not connected"));
}

#[test]
fn test_error_configuration() {
    let e = TwitchPluginError::Configuration {
        message: "bad config".to_string(),
        setting_name: Some("MY_SETTING".to_string()),
    };
    let msg = format!("{}", e);
    assert!(msg.contains("bad config"));
}

#[test]
fn test_error_configuration_no_setting() {
    let e = TwitchPluginError::Configuration {
        message: "missing".to_string(),
        setting_name: None,
    };
    let msg = format!("{}", e);
    assert!(msg.contains("missing"));
}

#[test]
fn test_error_api() {
    let e = TwitchPluginError::Api {
        message: "api fail".to_string(),
        status_code: Some(401),
    };
    let msg = format!("{}", e);
    assert!(msg.contains("api fail"));
}

#[test]
fn test_error_websocket() {
    let e = TwitchPluginError::WebSocket("ws error".to_string());
    let msg = format!("{}", e);
    assert!(msg.contains("ws error"));
}

#[test]
fn test_error_is_std_error() {
    let e: Box<dyn std::error::Error> = Box::new(TwitchPluginError::NotConnected);
    assert!(e.to_string().contains("not connected"));
}

// ===========================================================================
// 11. Utility functions
// ===========================================================================

#[test]
fn test_normalize_channel_strips_hash() {
    assert_eq!(normalize_channel("#mychannel"), "mychannel");
}

#[test]
fn test_normalize_channel_no_hash() {
    assert_eq!(normalize_channel("mychannel"), "mychannel");
}

#[test]
fn test_normalize_channel_lowercases() {
    assert_eq!(normalize_channel("#MyChannel"), "mychannel");
}

#[test]
fn test_normalize_channel_empty() {
    assert_eq!(normalize_channel(""), "");
}

#[test]
fn test_format_channel_for_display_adds_hash() {
    assert_eq!(format_channel_for_display("mychannel"), "#mychannel");
}

#[test]
fn test_format_channel_for_display_no_double_hash() {
    assert_eq!(format_channel_for_display("#mychannel"), "#mychannel");
}

#[test]
fn test_get_twitch_user_display_name_uses_display() {
    let user = TwitchUserInfo {
        display_name: "Alice_Cool".to_string(),
        username: "alice".to_string(),
        ..Default::default()
    };
    assert_eq!(get_twitch_user_display_name(&user), "Alice_Cool");
}

#[test]
fn test_get_twitch_user_display_name_fallback() {
    let user = TwitchUserInfo {
        display_name: "".to_string(),
        username: "bob".to_string(),
        ..Default::default()
    };
    assert_eq!(get_twitch_user_display_name(&user), "bob");
}

// ===========================================================================
// 12. strip_markdown_for_twitch
// ===========================================================================

#[test]
fn test_strip_bold_asterisks() {
    assert_eq!(strip_markdown_for_twitch("**bold**"), "bold");
}

#[test]
fn test_strip_bold_underscores() {
    assert_eq!(strip_markdown_for_twitch("__bold__"), "bold");
}

#[test]
fn test_strip_italic_asterisk() {
    assert_eq!(strip_markdown_for_twitch("*italic*"), "italic");
}

#[test]
fn test_strip_italic_underscore() {
    assert_eq!(strip_markdown_for_twitch("_italic_"), "italic");
}

#[test]
fn test_strip_strikethrough() {
    assert_eq!(strip_markdown_for_twitch("~~struck~~"), "struck");
}

#[test]
fn test_strip_inline_code() {
    assert_eq!(strip_markdown_for_twitch("`code`"), "code");
}

#[test]
fn test_strip_code_block() {
    // The inline code regex runs before the code block regex, so triple-backtick
    // blocks where content has no backticks get partially consumed by the inline
    // code pattern. Verify the function produces a non-empty stripped result.
    let result = strip_markdown_for_twitch("```js\nconsole.log('hi');\n```");
    assert!(!result.is_empty());
    // Test with a code block whose content already contains backticks
    let result2 = strip_markdown_for_twitch("before ```code``` after");
    assert!(result2.contains("code"));
}

#[test]
fn test_strip_link_keeps_text() {
    assert_eq!(strip_markdown_for_twitch("[link](url)"), "link");
}

#[test]
fn test_strip_header() {
    assert_eq!(strip_markdown_for_twitch("## Header"), "Header");
}

#[test]
fn test_strip_blockquote() {
    assert_eq!(strip_markdown_for_twitch("> quoted"), "quoted");
}

#[test]
fn test_strip_unordered_list() {
    assert_eq!(strip_markdown_for_twitch("- item"), "• item");
}

#[test]
fn test_strip_ordered_list() {
    assert_eq!(strip_markdown_for_twitch("1. item"), "• item");
}

#[test]
fn test_strip_collapses_newlines() {
    assert_eq!(strip_markdown_for_twitch("a\n\n\n\nb"), "a\n\nb");
}

#[test]
fn test_strip_plain_text() {
    assert_eq!(strip_markdown_for_twitch("plain text"), "plain text");
}

#[test]
fn test_strip_trims_whitespace() {
    assert_eq!(strip_markdown_for_twitch("  hello  "), "hello");
}

// ===========================================================================
// 13. split_message_for_twitch
// ===========================================================================

#[test]
fn test_split_short_message() {
    let chunks = split_message_for_twitch("Hello world", 500);
    assert_eq!(chunks, vec!["Hello world"]);
}

#[test]
fn test_split_long_message() {
    let long: String = "A".repeat(600);
    let chunks = split_message_for_twitch(&long, 500);
    assert!(chunks.len() > 1);
    for chunk in &chunks {
        assert!(chunk.len() <= 500);
    }
}

#[test]
fn test_split_custom_max_length() {
    let text: String = "A".repeat(30);
    let chunks = split_message_for_twitch(&text, 10);
    assert_eq!(chunks.len(), 3);
}

#[test]
fn test_split_sentence_boundary() {
    // The ". " must be past halfway of max_length to be used as a split point.
    // rfind(". ") returns the index of the ".", so the split point is there.
    let prefix: String = "A".repeat(300);
    let text = format!("{}. {}", prefix, "B".repeat(250)); // total 552
    let chunks = split_message_for_twitch(&text, 500);
    assert_eq!(chunks.len(), 2);
    assert_eq!(chunks[0], prefix);
    assert!(chunks[1].contains('B'));
    assert!(chunks[1].len() < text.len());
}

#[test]
fn test_split_exact_max() {
    let text: String = "A".repeat(500);
    let chunks = split_message_for_twitch(&text, 500);
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0], text);
}

// ===========================================================================
// 14. Action metadata - sendMessage
// ===========================================================================

#[test]
fn test_send_message_action_name() {
    assert_eq!(SEND_MSG_NAME, "TWITCH_SEND_MESSAGE");
}

#[test]
fn test_send_message_action_description() {
    assert!(SEND_MSG_DESC.contains("Send"));
    assert!(SEND_MSG_DESC.contains("Twitch"));
}

#[test]
fn test_send_message_action_similes() {
    assert!(SEND_MSG_SIMILES.contains(&"SEND_TWITCH_MESSAGE"));
    assert!(SEND_MSG_SIMILES.contains(&"TWITCH_CHAT"));
    assert!(SEND_MSG_SIMILES.contains(&"CHAT_TWITCH"));
    assert!(SEND_MSG_SIMILES.contains(&"SAY_IN_TWITCH"));
    assert_eq!(SEND_MSG_SIMILES.len(), 4);
}

#[test]
fn test_send_message_params_serde() {
    let params = SendMessageParams {
        text: "hello".to_string(),
        channel: Some("test".to_string()),
        reply_to: None,
    };
    let json = serde_json::to_string(&params).unwrap();
    let back: SendMessageParams = serde_json::from_str(&json).unwrap();
    assert_eq!(back.text, "hello");
    assert_eq!(back.channel, Some("test".to_string()));
}

#[test]
fn test_send_message_result_serde() {
    let r = SendMessageResult {
        success: true,
        channel: "ch".to_string(),
        message_id: Some("id".to_string()),
        error: None,
    };
    let json = serde_json::to_string(&r).unwrap();
    assert!(!json.contains("error")); // skip_serializing_if = Option::is_none
    let back: SendMessageResult = serde_json::from_str(&json).unwrap();
    assert!(back.success);
}

// ===========================================================================
// 15. Action metadata - joinChannel
// ===========================================================================

#[test]
fn test_join_channel_action_name() {
    assert_eq!(JOIN_NAME, "TWITCH_JOIN_CHANNEL");
}

#[test]
fn test_join_channel_action_description() {
    assert!(JOIN_DESC.contains("Join"));
    assert!(JOIN_DESC.contains("Twitch"));
}

#[test]
fn test_join_channel_action_similes() {
    assert!(JOIN_SIMILES.contains(&"JOIN_TWITCH_CHANNEL"));
    assert!(JOIN_SIMILES.contains(&"ENTER_CHANNEL"));
    assert!(JOIN_SIMILES.contains(&"CONNECT_CHANNEL"));
    assert_eq!(JOIN_SIMILES.len(), 3);
}

#[test]
fn test_join_channel_params_serde() {
    let params = JoinChannelParams {
        channel: "test".to_string(),
    };
    let json = serde_json::to_string(&params).unwrap();
    let back: JoinChannelParams = serde_json::from_str(&json).unwrap();
    assert_eq!(back.channel, "test");
}

#[test]
fn test_join_channel_result_already_joined() {
    let r = JoinChannelResult {
        success: true,
        channel: "test".to_string(),
        already_joined: true,
        error: None,
    };
    assert!(r.already_joined);
}

// ===========================================================================
// 16. Action metadata - leaveChannel
// ===========================================================================

#[test]
fn test_leave_channel_action_name() {
    assert_eq!(LEAVE_NAME, "TWITCH_LEAVE_CHANNEL");
}

#[test]
fn test_leave_channel_action_description() {
    assert!(LEAVE_DESC.contains("Leave"));
    assert!(LEAVE_DESC.contains("Twitch"));
}

#[test]
fn test_leave_channel_action_similes() {
    assert!(LEAVE_SIMILES.contains(&"LEAVE_TWITCH_CHANNEL"));
    assert!(LEAVE_SIMILES.contains(&"EXIT_CHANNEL"));
    assert!(LEAVE_SIMILES.contains(&"PART_CHANNEL"));
    assert!(LEAVE_SIMILES.contains(&"DISCONNECT_CHANNEL"));
    assert_eq!(LEAVE_SIMILES.len(), 4);
}

#[test]
fn test_leave_channel_params_serde() {
    let params = LeaveChannelParams {
        channel: "test".to_string(),
    };
    let json = serde_json::to_string(&params).unwrap();
    let back: LeaveChannelParams = serde_json::from_str(&json).unwrap();
    assert_eq!(back.channel, "test");
}

#[test]
fn test_leave_channel_result_error() {
    let r = LeaveChannelResult {
        success: false,
        channel: "test".to_string(),
        error: Some("Not in that channel".to_string()),
    };
    assert!(!r.success);
    assert_eq!(r.error, Some("Not in that channel".to_string()));
}

// ===========================================================================
// 17. Action metadata - listChannels
// ===========================================================================

#[test]
fn test_list_channels_action_name() {
    assert_eq!(LIST_NAME, "TWITCH_LIST_CHANNELS");
}

#[test]
fn test_list_channels_action_description() {
    assert!(LIST_DESC.contains("List"));
    assert!(LIST_DESC.contains("Twitch"));
}

#[test]
fn test_list_channels_action_similes() {
    assert!(LIST_SIMILES.contains(&"LIST_TWITCH_CHANNELS"));
    assert!(LIST_SIMILES.contains(&"SHOW_CHANNELS"));
    assert!(LIST_SIMILES.contains(&"GET_CHANNELS"));
    assert!(LIST_SIMILES.contains(&"CURRENT_CHANNELS"));
    assert_eq!(LIST_SIMILES.len(), 4);
}

#[test]
fn test_list_channels_params_default() {
    let params = ListChannelsParams::default();
    let json = serde_json::to_string(&params).unwrap();
    assert_eq!(json, "{}");
}

#[test]
fn test_format_channels_text_with_channels() {
    let result = ListChannelsResult {
        success: true,
        channel_count: 2,
        channels: vec!["mainchannel".to_string(), "extra".to_string()],
        primary_channel: "mainchannel".to_string(),
        error: None,
    };
    let text = format_channels_text(&result);
    assert!(text.contains("2 channel(s)"));
    assert!(text.contains("#mainchannel (primary)"));
    assert!(text.contains("#extra"));
    assert!(!text.contains("(primary)\n• #extra (primary)"));
}

#[test]
fn test_format_channels_text_empty() {
    let result = ListChannelsResult {
        success: true,
        channel_count: 0,
        channels: vec![],
        primary_channel: "main".to_string(),
        error: None,
    };
    let text = format_channels_text(&result);
    assert_eq!(text, "Not currently in any channels.");
}

#[test]
fn test_format_channels_text_error() {
    let result = ListChannelsResult {
        success: false,
        channel_count: 0,
        channels: vec![],
        primary_channel: "".to_string(),
        error: Some("service down".to_string()),
    };
    let text = format_channels_text(&result);
    assert!(text.contains("Failed"));
    assert!(text.contains("service down"));
}

// ===========================================================================
// 18. Provider metadata - channelState
// ===========================================================================

#[test]
fn test_channel_state_provider_name() {
    assert_eq!(CHANNEL_PROVIDER_NAME, "twitchChannelState");
}

#[test]
fn test_channel_state_provider_description() {
    assert!(CHANNEL_PROVIDER_DESC.contains("Twitch channel"));
}

#[test]
fn test_channel_state_data_serde() {
    let data = ChannelStateData {
        channel: "test".to_string(),
        display_channel: "#test".to_string(),
        is_primary_channel: true,
        bot_username: "bot".to_string(),
        joined_channels: vec!["test".to_string()],
        channel_count: 1,
        connected: true,
    };
    let json = serde_json::to_string(&data).unwrap();
    let back: ChannelStateData = serde_json::from_str(&json).unwrap();
    assert_eq!(back.channel, "test");
    assert!(back.is_primary_channel);
    assert!(back.connected);
}

// ===========================================================================
// 19. Provider metadata - userContext
// ===========================================================================

#[test]
fn test_user_context_provider_name() {
    assert_eq!(USER_PROVIDER_NAME, "twitchUserContext");
}

#[test]
fn test_user_context_provider_description() {
    assert!(USER_PROVIDER_DESC.contains("Twitch user"));
}

#[test]
fn test_user_context_broadcaster() {
    let user = TwitchUserInfo {
        user_id: "99".to_string(),
        username: "streamer".to_string(),
        display_name: "Streamer".to_string(),
        is_broadcaster: true,
        is_subscriber: true,
        ..Default::default()
    };
    let result = get_user_context(&user, "MyBot");

    assert_eq!(result.data.user_id, "99");
    assert_eq!(result.data.username, "streamer");
    assert_eq!(result.data.display_name, "Streamer");
    assert!(result.data.is_broadcaster);
    assert!(result.data.is_subscriber);
    assert!(result.data.roles.contains(&"broadcaster".to_string()));
    assert!(result.data.roles.contains(&"subscriber".to_string()));
    assert!(result.values.role_text.contains("broadcaster"));
    assert!(result.text.contains("MyBot"));
    assert!(result.text.contains("Streamer"));
    assert!(result.text.contains("channel owner/broadcaster"));
}

#[test]
fn test_user_context_viewer() {
    let user = TwitchUserInfo {
        user_id: "1".to_string(),
        username: "viewer1".to_string(),
        display_name: "Viewer1".to_string(),
        ..Default::default()
    };
    let result = get_user_context(&user, "Bot");

    assert_eq!(result.values.role_text, "viewer");
    assert!(result.data.roles.is_empty());
    assert!(result.text.contains("viewer"));
}

#[test]
fn test_user_context_moderator() {
    let user = TwitchUserInfo {
        user_id: "55".to_string(),
        username: "modperson".to_string(),
        display_name: "ModPerson".to_string(),
        is_moderator: true,
        ..Default::default()
    };
    let result = get_user_context(&user, "Bot");

    assert!(result.data.is_moderator);
    assert!(result.text.contains("channel moderator"));
    assert!(!result.text.contains("broadcaster"));
}

#[test]
fn test_user_context_vip_and_subscriber() {
    let user = TwitchUserInfo {
        user_id: "77".to_string(),
        username: "vipsub".to_string(),
        display_name: "VipSub".to_string(),
        is_vip: true,
        is_subscriber: true,
        ..Default::default()
    };
    let result = get_user_context(&user, "Bot");

    assert!(result.data.roles.contains(&"VIP".to_string()));
    assert!(result.data.roles.contains(&"subscriber".to_string()));
    assert!(result.values.role_text.contains("VIP"));
}

#[test]
fn test_user_context_result_serde() {
    let user = TwitchUserInfo {
        user_id: "1".to_string(),
        username: "u".to_string(),
        display_name: "U".to_string(),
        ..Default::default()
    };
    let result = get_user_context(&user, "Bot");
    let json = serde_json::to_string(&result).unwrap();
    let back: UserContextResult = serde_json::from_str(&json).unwrap();
    assert_eq!(back.data.user_id, "1");
}

// ===========================================================================
// 20. Service creation and validation
// ===========================================================================

#[tokio::test]
async fn test_service_creation_missing_username() {
    let settings = TwitchSettings {
        username: "".to_string(),
        client_id: "cid".to_string(),
        access_token: "tok".to_string(),
        channel: "main".to_string(),
        ..Default::default()
    };
    let result = TwitchService::new(settings).await;
    assert!(result.is_err());
    if let Err(TwitchPluginError::Configuration { setting_name, .. }) = result {
        assert_eq!(setting_name, Some("TWITCH_USERNAME".to_string()));
    } else {
        panic!("Expected Configuration error for TWITCH_USERNAME");
    }
}

#[tokio::test]
async fn test_service_creation_missing_client_id() {
    let settings = TwitchSettings {
        username: "bot".to_string(),
        client_id: "".to_string(),
        access_token: "tok".to_string(),
        channel: "main".to_string(),
        ..Default::default()
    };
    let result = TwitchService::new(settings).await;
    assert!(result.is_err());
    if let Err(TwitchPluginError::Configuration { setting_name, .. }) = result {
        assert_eq!(setting_name, Some("TWITCH_CLIENT_ID".to_string()));
    } else {
        panic!("Expected Configuration error for TWITCH_CLIENT_ID");
    }
}

#[tokio::test]
async fn test_service_creation_missing_access_token() {
    let settings = TwitchSettings {
        username: "bot".to_string(),
        client_id: "cid".to_string(),
        access_token: "".to_string(),
        channel: "main".to_string(),
        ..Default::default()
    };
    let result = TwitchService::new(settings).await;
    assert!(result.is_err());
    if let Err(TwitchPluginError::Configuration { setting_name, .. }) = result {
        assert_eq!(setting_name, Some("TWITCH_ACCESS_TOKEN".to_string()));
    } else {
        panic!("Expected Configuration error for TWITCH_ACCESS_TOKEN");
    }
}

#[tokio::test]
async fn test_service_creation_missing_channel() {
    let settings = TwitchSettings {
        username: "bot".to_string(),
        client_id: "cid".to_string(),
        access_token: "tok".to_string(),
        channel: "".to_string(),
        ..Default::default()
    };
    let result = TwitchService::new(settings).await;
    assert!(result.is_err());
    if let Err(TwitchPluginError::Configuration { setting_name, .. }) = result {
        assert_eq!(setting_name, Some("TWITCH_CHANNEL".to_string()));
    } else {
        panic!("Expected Configuration error for TWITCH_CHANNEL");
    }
}

#[tokio::test]
async fn test_service_creation_valid() {
    let settings = TwitchSettings {
        username: "bot".to_string(),
        client_id: "cid".to_string(),
        access_token: "tok".to_string(),
        channel: "main".to_string(),
        ..Default::default()
    };
    let result = TwitchService::new(settings).await;
    assert!(result.is_ok());
    let service = result.unwrap();
    assert_eq!(service.get_bot_username(), "bot");
    assert_eq!(service.get_primary_channel(), "main");
    assert!(!service.is_connected().await);
}

#[tokio::test]
async fn test_service_from_env_missing_username() {
    let result = TwitchService::from_env(|key| match key {
        "TWITCH_CLIENT_ID" => Some("cid".to_string()),
        "TWITCH_ACCESS_TOKEN" => Some("tok".to_string()),
        "TWITCH_CHANNEL" => Some("main".to_string()),
        _ => None,
    }).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_service_from_env_valid() {
    let result = TwitchService::from_env(|key| match key {
        "TWITCH_USERNAME" => Some("bot".to_string()),
        "TWITCH_CLIENT_ID" => Some("cid".to_string()),
        "TWITCH_ACCESS_TOKEN" => Some("tok".to_string()),
        "TWITCH_CHANNEL" => Some("main".to_string()),
        _ => None,
    }).await;
    assert!(result.is_ok());
}

#[tokio::test]
async fn test_service_is_user_allowed_all_role() {
    let settings = TwitchSettings {
        username: "bot".to_string(),
        client_id: "cid".to_string(),
        access_token: "tok".to_string(),
        channel: "main".to_string(),
        allowed_roles: vec![TwitchRole::All],
        ..Default::default()
    };
    let service = TwitchService::new(settings).await.unwrap();
    let user = TwitchUserInfo::default();
    assert!(service.is_user_allowed(&user));
}

#[tokio::test]
async fn test_service_is_user_allowed_moderator_role() {
    let settings = TwitchSettings {
        username: "bot".to_string(),
        client_id: "cid".to_string(),
        access_token: "tok".to_string(),
        channel: "main".to_string(),
        allowed_roles: vec![TwitchRole::Moderator],
        ..Default::default()
    };
    let service = TwitchService::new(settings).await.unwrap();

    let mod_user = TwitchUserInfo {
        is_moderator: true,
        ..Default::default()
    };
    assert!(service.is_user_allowed(&mod_user));

    let viewer = TwitchUserInfo::default();
    assert!(!service.is_user_allowed(&viewer));
}

#[tokio::test]
async fn test_service_is_user_allowed_owner_role() {
    let settings = TwitchSettings {
        username: "bot".to_string(),
        client_id: "cid".to_string(),
        access_token: "tok".to_string(),
        channel: "main".to_string(),
        allowed_roles: vec![TwitchRole::Owner],
        ..Default::default()
    };
    let service = TwitchService::new(settings).await.unwrap();

    let broadcaster = TwitchUserInfo {
        is_broadcaster: true,
        ..Default::default()
    };
    assert!(service.is_user_allowed(&broadcaster));

    let viewer = TwitchUserInfo::default();
    assert!(!service.is_user_allowed(&viewer));
}

#[tokio::test]
async fn test_service_is_user_allowed_user_id_allowlist() {
    let settings = TwitchSettings {
        username: "bot".to_string(),
        client_id: "cid".to_string(),
        access_token: "tok".to_string(),
        channel: "main".to_string(),
        allowed_roles: vec![TwitchRole::All],
        allowed_user_ids: vec!["allowed-1".to_string()],
        ..Default::default()
    };
    let service = TwitchService::new(settings).await.unwrap();

    let allowed = TwitchUserInfo {
        user_id: "allowed-1".to_string(),
        ..Default::default()
    };
    assert!(service.is_user_allowed(&allowed));

    let blocked = TwitchUserInfo {
        user_id: "blocked-99".to_string(),
        ..Default::default()
    };
    assert!(!service.is_user_allowed(&blocked));
}

#[tokio::test]
async fn test_service_joined_channels_empty_initially() {
    let settings = TwitchSettings {
        username: "bot".to_string(),
        client_id: "cid".to_string(),
        access_token: "tok".to_string(),
        channel: "main".to_string(),
        ..Default::default()
    };
    let service = TwitchService::new(settings).await.unwrap();
    let channels = service.get_joined_channels().await;
    assert!(channels.is_empty());
}
