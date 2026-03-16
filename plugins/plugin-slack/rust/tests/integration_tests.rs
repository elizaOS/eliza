//! Integration tests for the elizaos-plugin-slack crate.
//!
//! Covers:
//!   - Constants and configuration
//!   - Type construction and serialization/deserialization
//!   - Validation functions (positive + negative cases)
//!   - All 11 action metadata (name, similes, description) and param structs
//!   - All 3 provider metadata and data structure construction
//!   - SlackChannel::channel_type() logic
//!   - SlackUser::display_name() logic
//!   - Error variants
//!   - Message link parsing and formatting

use elizaos_plugin_slack::types::*;
use elizaos_plugin_slack::actions::send_message::*;
use elizaos_plugin_slack::actions::react_to_message::*;
use elizaos_plugin_slack::actions::read_channel::*;
use elizaos_plugin_slack::actions::edit_message::*;
use elizaos_plugin_slack::actions::delete_message::*;
use elizaos_plugin_slack::actions::pin_message::*;
use elizaos_plugin_slack::actions::unpin_message::*;
use elizaos_plugin_slack::actions::list_channels::*;
use elizaos_plugin_slack::actions::get_user_info::*;
use elizaos_plugin_slack::actions::list_pins::*;
use elizaos_plugin_slack::actions::emoji_list::*;
use elizaos_plugin_slack::providers::channel_state::*;
use elizaos_plugin_slack::providers::workspace_info::*;
use elizaos_plugin_slack::providers::member_list::*;
use elizaos_plugin_slack::service::SendMessageResult as ServiceSendMessageResult;

use std::collections::HashMap;

// ===================================================================
// Helper factories
// ===================================================================

fn make_user_profile() -> SlackUserProfile {
    SlackUserProfile {
        display_name: Some("Jane Smith".to_string()),
        real_name: Some("Jane A. Smith".to_string()),
        title: Some("Engineer".to_string()),
        email: Some("jane@example.com".to_string()),
        status_text: Some("Working".to_string()),
        status_emoji: Some(":computer:".to_string()),
        image_72: Some("https://img/72.png".to_string()),
        image_192: Some("https://img/192.png".to_string()),
        ..Default::default()
    }
}

fn make_user() -> SlackUser {
    SlackUser {
        id: "U0123456789".to_string(),
        name: "janesmith".to_string(),
        profile: make_user_profile(),
        team_id: Some("T0123456789".to_string()),
        deleted: false,
        real_name: Some("Jane A. Smith".to_string()),
        tz: Some("America/New_York".to_string()),
        tz_label: Some("Eastern Standard Time".to_string()),
        tz_offset: Some(-18000),
        is_admin: false,
        is_owner: false,
        is_primary_owner: false,
        is_restricted: false,
        is_ultra_restricted: false,
        is_bot: false,
        is_app_user: false,
        updated: 1700000000,
    }
}

fn make_channel() -> SlackChannel {
    SlackChannel {
        id: "C0123456789".to_string(),
        name: "general".to_string(),
        created: 1600000000,
        creator: "U0000000001".to_string(),
        is_channel: true,
        is_group: false,
        is_im: false,
        is_mpim: false,
        is_private: false,
        is_archived: false,
        is_general: true,
        is_shared: false,
        is_org_shared: false,
        is_member: true,
        topic: Some(SlackChannelTopic {
            value: "General discussion".to_string(),
            creator: "U0000000001".to_string(),
            last_set: 1600000000,
        }),
        purpose: Some(SlackChannelPurpose {
            value: "Company-wide channel".to_string(),
            creator: "U0000000001".to_string(),
            last_set: 1600000000,
        }),
        num_members: Some(42),
    }
}

fn make_message() -> SlackMessage {
    SlackMessage {
        msg_type: "message".to_string(),
        ts: "1700000000.000001".to_string(),
        text: "Hello from Slack!".to_string(),
        subtype: None,
        user: Some("U0123456789".to_string()),
        thread_ts: None,
        reply_count: None,
        reply_users_count: None,
        latest_reply: None,
        reactions: None,
        files: None,
        attachments: None,
        blocks: None,
    }
}

// ===================================================================
// Constants
// ===================================================================

#[test]
fn test_service_name_constant() {
    assert_eq!(SLACK_SERVICE_NAME, "slack");
}

#[test]
fn test_max_message_length() {
    assert_eq!(MAX_SLACK_MESSAGE_LENGTH, 4000);
}

#[test]
fn test_max_blocks() {
    assert_eq!(MAX_SLACK_BLOCKS, 50);
}

#[test]
fn test_max_file_size() {
    assert_eq!(MAX_SLACK_FILE_SIZE, 1024 * 1024 * 1024);
}

#[test]
fn test_plugin_metadata() {
    assert_eq!(elizaos_plugin_slack::PLUGIN_NAME, "slack");
    assert!(!elizaos_plugin_slack::PLUGIN_DESCRIPTION.is_empty());
}

// ===================================================================
// SlackEventType
// ===================================================================

#[test]
fn test_event_type_as_str() {
    assert_eq!(SlackEventType::MessageReceived.as_str(), "SLACK_MESSAGE_RECEIVED");
    assert_eq!(SlackEventType::MessageSent.as_str(), "SLACK_MESSAGE_SENT");
    assert_eq!(SlackEventType::ReactionAdded.as_str(), "SLACK_REACTION_ADDED");
    assert_eq!(SlackEventType::ReactionRemoved.as_str(), "SLACK_REACTION_REMOVED");
    assert_eq!(SlackEventType::ChannelJoined.as_str(), "SLACK_CHANNEL_JOINED");
    assert_eq!(SlackEventType::ChannelLeft.as_str(), "SLACK_CHANNEL_LEFT");
    assert_eq!(SlackEventType::MemberJoinedChannel.as_str(), "SLACK_MEMBER_JOINED_CHANNEL");
    assert_eq!(SlackEventType::MemberLeftChannel.as_str(), "SLACK_MEMBER_LEFT_CHANNEL");
    assert_eq!(SlackEventType::AppMention.as_str(), "SLACK_APP_MENTION");
    assert_eq!(SlackEventType::SlashCommand.as_str(), "SLACK_SLASH_COMMAND");
    assert_eq!(SlackEventType::FileShared.as_str(), "SLACK_FILE_SHARED");
    assert_eq!(SlackEventType::ThreadReply.as_str(), "SLACK_THREAD_REPLY");
}

#[test]
fn test_event_type_equality() {
    assert_eq!(SlackEventType::MessageReceived, SlackEventType::MessageReceived);
    assert_ne!(SlackEventType::MessageReceived, SlackEventType::MessageSent);
}

#[test]
fn test_event_type_all_prefixed() {
    let all_events = [
        SlackEventType::MessageReceived,
        SlackEventType::MessageSent,
        SlackEventType::ReactionAdded,
        SlackEventType::ReactionRemoved,
        SlackEventType::ChannelJoined,
        SlackEventType::ChannelLeft,
        SlackEventType::MemberJoinedChannel,
        SlackEventType::MemberLeftChannel,
        SlackEventType::AppMention,
        SlackEventType::SlashCommand,
        SlackEventType::FileShared,
        SlackEventType::ThreadReply,
    ];
    for event in &all_events {
        assert!(event.as_str().starts_with("SLACK_"));
    }
    assert_eq!(all_events.len(), 12);
}

// ===================================================================
// SlackChannelType
// ===================================================================

#[test]
fn test_channel_type_as_str() {
    assert_eq!(SlackChannelType::Channel.as_str(), "channel");
    assert_eq!(SlackChannelType::Group.as_str(), "group");
    assert_eq!(SlackChannelType::Im.as_str(), "im");
    assert_eq!(SlackChannelType::Mpim.as_str(), "mpim");
}

// ===================================================================
// Validation functions – positive and negative
// ===================================================================

#[test]
fn test_valid_channel_id_positive() {
    assert!(is_valid_channel_id("C0123456789"));
    assert!(is_valid_channel_id("G0123456789"));
    assert!(is_valid_channel_id("D0123456789"));
    assert!(is_valid_channel_id("C012345678901234"));
    assert!(is_valid_channel_id("c0123456789")); // case-insensitive
}

#[test]
fn test_valid_channel_id_negative() {
    assert!(!is_valid_channel_id(""));
    assert!(!is_valid_channel_id("invalid"));
    assert!(!is_valid_channel_id("C123")); // too short
    assert!(!is_valid_channel_id("U0123456789")); // wrong prefix
    assert!(!is_valid_channel_id("T0123456789")); // wrong prefix
    assert!(!is_valid_channel_id("123456789")); // no prefix
    assert!(!is_valid_channel_id("C")); // only prefix
}

#[test]
fn test_valid_user_id_positive() {
    assert!(is_valid_user_id("U0123456789"));
    assert!(is_valid_user_id("W0123456789"));
    assert!(is_valid_user_id("U012345678901234"));
    assert!(is_valid_user_id("u0123456789")); // case-insensitive
}

#[test]
fn test_valid_user_id_negative() {
    assert!(!is_valid_user_id(""));
    assert!(!is_valid_user_id("invalid"));
    assert!(!is_valid_user_id("U123")); // too short
    assert!(!is_valid_user_id("C0123456789")); // wrong prefix
    assert!(!is_valid_user_id("T0123456789")); // wrong prefix
    assert!(!is_valid_user_id("B0123456789")); // wrong prefix
}

#[test]
fn test_valid_team_id_positive() {
    assert!(is_valid_team_id("T0123456789"));
    assert!(is_valid_team_id("T012345678901234"));
    assert!(is_valid_team_id("t0123456789"));
}

#[test]
fn test_valid_team_id_negative() {
    assert!(!is_valid_team_id(""));
    assert!(!is_valid_team_id("invalid"));
    assert!(!is_valid_team_id("T123")); // too short
    assert!(!is_valid_team_id("C0123456789"));
    assert!(!is_valid_team_id("U0123456789"));
}

#[test]
fn test_valid_message_ts_positive() {
    assert!(is_valid_message_ts("1234567890.123456"));
    assert!(is_valid_message_ts("1700000000.000001"));
    assert!(is_valid_message_ts("9999999999.999999"));
}

#[test]
fn test_valid_message_ts_negative() {
    assert!(!is_valid_message_ts(""));
    assert!(!is_valid_message_ts("invalid"));
    assert!(!is_valid_message_ts("1234567890")); // no decimal
    assert!(!is_valid_message_ts("1234567890.12345")); // 5 decimal digits
    assert!(!is_valid_message_ts("1234567890.1234567")); // 7 decimal digits
    assert!(!is_valid_message_ts("abc.123456"));
    assert!(!is_valid_message_ts(".123456"));
    assert!(!is_valid_message_ts("1234567890."));
}

// ===================================================================
// parse_slack_message_link / format_message_ts_for_link
// ===================================================================

#[test]
fn test_parse_slack_message_link_valid() {
    let link = "https://workspace.slack.com/archives/C12345678901/p1234567890123456";
    let result = parse_slack_message_link(link);
    assert!(result.is_some());
    let (channel_id, message_ts) = result.unwrap();
    assert_eq!(channel_id, "C12345678901");
    assert_eq!(message_ts, "1234567890.123456");
}

#[test]
fn test_parse_slack_message_link_invalid() {
    assert!(parse_slack_message_link("https://example.com").is_none());
    assert!(parse_slack_message_link("not a url").is_none());
    assert!(parse_slack_message_link("").is_none());
}

#[test]
fn test_parse_slack_message_link_with_different_channel_prefixes() {
    let link_g = "https://ws.slack.com/archives/G12345678901/p1234567890123456";
    assert!(parse_slack_message_link(link_g).is_some());
    let link_d = "https://ws.slack.com/archives/D12345678901/p1234567890123456";
    assert!(parse_slack_message_link(link_d).is_some());
}

#[test]
fn test_format_message_ts_for_link() {
    assert_eq!(format_message_ts_for_link("1234567890.123456"), "p1234567890123456");
}

#[test]
fn test_format_message_ts_roundtrip() {
    let original_ts = "1234567890.123456";
    let link_ts = format_message_ts_for_link(original_ts);
    // The link format should be a concatenation without the dot
    assert_eq!(link_ts, "p1234567890123456");
}

// ===================================================================
// SlackUser::display_name()
// ===================================================================

#[test]
fn test_user_display_name_prefers_display_name() {
    let user = make_user();
    assert_eq!(user.display_name(), "Jane Smith");
}

#[test]
fn test_user_display_name_falls_back_to_real_name() {
    let mut user = make_user();
    user.profile.display_name = None;
    assert_eq!(user.display_name(), "Jane A. Smith");
}

#[test]
fn test_user_display_name_falls_back_to_name() {
    let mut user = make_user();
    user.profile.display_name = None;
    user.profile.real_name = None;
    assert_eq!(user.display_name(), "janesmith");
}

#[test]
fn test_user_display_name_empty_display_name_falls_through() {
    let mut user = make_user();
    user.profile.display_name = Some("".to_string());
    // Empty string is filtered out, should fall to real_name
    assert_eq!(user.display_name(), "Jane A. Smith");
}

#[test]
fn test_user_display_name_all_none() {
    let mut user = make_user();
    user.profile.display_name = None;
    user.profile.real_name = None;
    user.name = "fallback".to_string();
    assert_eq!(user.display_name(), "fallback");
}

// ===================================================================
// SlackChannel::channel_type()
// ===================================================================

#[test]
fn test_channel_type_public() {
    let ch = make_channel();
    assert_eq!(ch.channel_type(), SlackChannelType::Channel);
}

#[test]
fn test_channel_type_im() {
    let mut ch = make_channel();
    ch.is_im = true;
    ch.is_channel = false;
    assert_eq!(ch.channel_type(), SlackChannelType::Im);
}

#[test]
fn test_channel_type_mpim() {
    let mut ch = make_channel();
    ch.is_mpim = true;
    ch.is_channel = false;
    assert_eq!(ch.channel_type(), SlackChannelType::Mpim);
}

#[test]
fn test_channel_type_group() {
    let mut ch = make_channel();
    ch.is_group = true;
    ch.is_channel = false;
    assert_eq!(ch.channel_type(), SlackChannelType::Group);
}

#[test]
fn test_channel_type_private() {
    let mut ch = make_channel();
    ch.is_private = true;
    ch.is_group = false;
    ch.is_channel = false;
    assert_eq!(ch.channel_type(), SlackChannelType::Group);
}

#[test]
fn test_channel_type_im_takes_precedence_over_group() {
    let mut ch = make_channel();
    ch.is_im = true;
    ch.is_group = true;
    ch.is_channel = false;
    assert_eq!(ch.channel_type(), SlackChannelType::Im);
}

#[test]
fn test_channel_type_mpim_takes_precedence_over_group() {
    let mut ch = make_channel();
    ch.is_mpim = true;
    ch.is_group = true;
    ch.is_im = false;
    ch.is_channel = false;
    assert_eq!(ch.channel_type(), SlackChannelType::Mpim);
}

// ===================================================================
// Type construction and serialization
// ===================================================================

#[test]
fn test_slack_user_profile_default() {
    let p = SlackUserProfile::default();
    assert!(p.title.is_none());
    assert!(p.display_name.is_none());
    assert!(p.email.is_none());
}

#[test]
fn test_slack_settings_default() {
    let s = SlackSettings::default();
    assert!(s.allowed_channel_ids.is_none());
    assert!(!s.should_ignore_bot_messages);
    assert!(!s.should_respond_only_to_mentions);
}

#[test]
fn test_slack_message_send_options_default() {
    let opts = SlackMessageSendOptions::default();
    assert!(opts.thread_ts.is_none());
    assert!(opts.reply_broadcast.is_none());
    assert!(opts.mrkdwn.is_none());
}

#[test]
fn test_slack_reaction_construction() {
    let r = SlackReaction {
        name: "thumbsup".to_string(),
        count: 3,
        users: vec!["U1".to_string(), "U2".to_string(), "U3".to_string()],
    };
    assert_eq!(r.count, 3);
    assert_eq!(r.users.len(), 3);
}

#[test]
fn test_slack_file_construction() {
    let f = SlackFile {
        id: "F001".to_string(),
        name: "file.txt".to_string(),
        title: "File".to_string(),
        mimetype: "text/plain".to_string(),
        filetype: "txt".to_string(),
        size: 100,
        url_private: "https://files/1".to_string(),
        url_private_download: None,
        permalink: "https://slack.com/files/1".to_string(),
        thumb_64: None,
        thumb_80: None,
        thumb_360: None,
    };
    assert_eq!(f.id, "F001");
    assert!(f.url_private_download.is_none());
}

#[test]
fn test_slack_message_minimal() {
    let m = make_message();
    assert_eq!(m.msg_type, "message");
    assert!(m.thread_ts.is_none());
    assert!(m.reactions.is_none());
}

#[test]
fn test_slack_channel_topic_construction() {
    let t = SlackChannelTopic {
        value: "Topic".to_string(),
        creator: "U001".to_string(),
        last_set: 1000,
    };
    assert_eq!(t.value, "Topic");
}

#[test]
fn test_slack_channel_purpose_construction() {
    let p = SlackChannelPurpose {
        value: "Purpose".to_string(),
        creator: "U001".to_string(),
        last_set: 2000,
    };
    assert_eq!(p.value, "Purpose");
}

#[test]
fn test_user_serialization_roundtrip() {
    let user = make_user();
    let json = serde_json::to_string(&user).unwrap();
    let deserialized: SlackUser = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.id, user.id);
    assert_eq!(deserialized.name, user.name);
    assert_eq!(deserialized.is_admin, user.is_admin);
}

#[test]
fn test_channel_serialization_roundtrip() {
    let ch = make_channel();
    let json = serde_json::to_string(&ch).unwrap();
    let deserialized: SlackChannel = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.id, ch.id);
    assert_eq!(deserialized.name, ch.name);
    assert_eq!(deserialized.is_private, ch.is_private);
}

#[test]
fn test_message_serialization_roundtrip() {
    let msg = make_message();
    let json = serde_json::to_string(&msg).unwrap();
    let deserialized: SlackMessage = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.ts, msg.ts);
    assert_eq!(deserialized.text, msg.text);
}

#[test]
fn test_settings_serialization_roundtrip() {
    let s = SlackSettings {
        allowed_channel_ids: Some(vec!["C001".to_string()]),
        should_ignore_bot_messages: true,
        should_respond_only_to_mentions: false,
    };
    let json = serde_json::to_string(&s).unwrap();
    let deserialized: SlackSettings = serde_json::from_str(&json).unwrap();
    assert!(deserialized.should_ignore_bot_messages);
    assert!(!deserialized.should_respond_only_to_mentions);
    assert_eq!(deserialized.allowed_channel_ids.unwrap().len(), 1);
}

// ===================================================================
// Error variants
// ===================================================================

#[test]
fn test_error_service_not_initialized() {
    let err = SlackError::ServiceNotInitialized;
    let msg = format!("{}", err);
    assert!(msg.to_lowercase().contains("not initialized"));
}

#[test]
fn test_error_client_not_available() {
    let err = SlackError::ClientNotAvailable;
    let msg = format!("{}", err);
    assert!(msg.to_lowercase().contains("not available"));
}

#[test]
fn test_error_configuration() {
    let err = SlackError::ConfigurationError("SLACK_BOT_TOKEN".to_string());
    let msg = format!("{}", err);
    assert!(msg.contains("SLACK_BOT_TOKEN"));
}

#[test]
fn test_error_api_error() {
    let err = SlackError::ApiError {
        message: "rate_limited".to_string(),
        code: Some("ratelimited".to_string()),
    };
    let msg = format!("{}", err);
    assert!(msg.contains("rate_limited"));
}

#[test]
fn test_error_invalid_channel_id() {
    let err = SlackError::InvalidChannelId("BAD".to_string());
    let msg = format!("{}", err);
    assert!(msg.contains("BAD"));
}

#[test]
fn test_error_invalid_user_id() {
    let err = SlackError::InvalidUserId("BAD".to_string());
    let msg = format!("{}", err);
    assert!(msg.contains("BAD"));
}

#[test]
fn test_error_invalid_message_ts() {
    let err = SlackError::InvalidMessageTs("BAD".to_string());
    let msg = format!("{}", err);
    assert!(msg.contains("BAD"));
}

// ===================================================================
// Action metadata – all 11 actions
// ===================================================================

#[test]
fn test_send_message_action_metadata() {
    assert_eq!(SEND_MESSAGE_ACTION, "SLACK_SEND_MESSAGE");
    assert_eq!(SEND_MESSAGE_SIMILES, &["SEND_SLACK_MESSAGE", "POST_TO_SLACK", "MESSAGE_SLACK", "SLACK_POST"]);
    assert_eq!(SEND_MESSAGE_DESCRIPTION, "Send a message to a Slack channel or thread");
}

#[test]
fn test_react_to_message_action_metadata() {
    assert_eq!(REACT_TO_MESSAGE_ACTION, "SLACK_REACT_TO_MESSAGE");
    assert_eq!(REACT_TO_MESSAGE_SIMILES, &["ADD_SLACK_REACTION", "REACT_SLACK", "SLACK_EMOJI"]);
    assert_eq!(REACT_TO_MESSAGE_DESCRIPTION, "Add or remove an emoji reaction to a Slack message");
}

#[test]
fn test_read_channel_action_metadata() {
    assert_eq!(READ_CHANNEL_ACTION, "SLACK_READ_CHANNEL");
    assert_eq!(READ_CHANNEL_SIMILES, &["READ_SLACK_MESSAGES", "GET_CHANNEL_HISTORY", "SLACK_HISTORY"]);
    assert_eq!(READ_CHANNEL_DESCRIPTION, "Read message history from a Slack channel");
}

#[test]
fn test_edit_message_action_metadata() {
    assert_eq!(EDIT_MESSAGE_ACTION, "SLACK_EDIT_MESSAGE");
    assert_eq!(EDIT_MESSAGE_SIMILES, &["UPDATE_SLACK_MESSAGE", "MODIFY_MESSAGE", "CHANGE_MESSAGE"]);
    assert_eq!(EDIT_MESSAGE_DESCRIPTION, "Edit an existing Slack message");
}

#[test]
fn test_delete_message_action_metadata() {
    assert_eq!(DELETE_MESSAGE_ACTION, "SLACK_DELETE_MESSAGE");
    assert_eq!(DELETE_MESSAGE_SIMILES, &["REMOVE_SLACK_MESSAGE", "DELETE_MESSAGE", "SLACK_REMOVE"]);
    assert_eq!(DELETE_MESSAGE_DESCRIPTION, "Delete a Slack message");
}

#[test]
fn test_pin_message_action_metadata() {
    assert_eq!(PIN_MESSAGE_ACTION, "SLACK_PIN_MESSAGE");
    assert_eq!(PIN_MESSAGE_SIMILES, &["PIN_SLACK_MESSAGE", "PIN_MESSAGE", "SLACK_PIN"]);
    assert_eq!(PIN_MESSAGE_DESCRIPTION, "Pin a message in a Slack channel");
}

#[test]
fn test_unpin_message_action_metadata() {
    assert_eq!(UNPIN_MESSAGE_ACTION, "SLACK_UNPIN_MESSAGE");
    assert_eq!(UNPIN_MESSAGE_SIMILES, &["UNPIN_SLACK_MESSAGE", "UNPIN_MESSAGE", "SLACK_UNPIN"]);
    assert_eq!(UNPIN_MESSAGE_DESCRIPTION, "Unpin a message from a Slack channel");
}

#[test]
fn test_list_channels_action_metadata() {
    assert_eq!(LIST_CHANNELS_ACTION, "SLACK_LIST_CHANNELS");
    assert_eq!(LIST_CHANNELS_SIMILES, &["LIST_SLACK_CHANNELS", "SHOW_CHANNELS", "GET_CHANNELS"]);
    assert_eq!(LIST_CHANNELS_DESCRIPTION, "List available Slack channels in the workspace");
}

#[test]
fn test_get_user_info_action_metadata() {
    assert_eq!(GET_USER_INFO_ACTION, "SLACK_GET_USER_INFO");
    assert_eq!(GET_USER_INFO_SIMILES, &["GET_SLACK_USER", "USER_INFO", "SLACK_USER", "WHO_IS"]);
    assert_eq!(GET_USER_INFO_DESCRIPTION, "Get information about a Slack user");
}

#[test]
fn test_list_pins_action_metadata() {
    assert_eq!(LIST_PINS_ACTION, "SLACK_LIST_PINS");
    assert_eq!(LIST_PINS_SIMILES, &["LIST_SLACK_PINS", "SHOW_PINS", "GET_PINNED_MESSAGES"]);
    assert_eq!(LIST_PINS_DESCRIPTION, "List pinned messages in a Slack channel");
}

#[test]
fn test_emoji_list_action_metadata() {
    assert_eq!(EMOJI_LIST_ACTION, "SLACK_EMOJI_LIST");
    assert_eq!(EMOJI_LIST_SIMILES, &["LIST_SLACK_EMOJI", "SHOW_EMOJI", "GET_CUSTOM_EMOJI"]);
    assert_eq!(EMOJI_LIST_DESCRIPTION, "List custom emoji available in the Slack workspace");
}

#[test]
fn test_all_11_action_names_unique() {
    let names = vec![
        SEND_MESSAGE_ACTION,
        REACT_TO_MESSAGE_ACTION,
        READ_CHANNEL_ACTION,
        EDIT_MESSAGE_ACTION,
        DELETE_MESSAGE_ACTION,
        PIN_MESSAGE_ACTION,
        UNPIN_MESSAGE_ACTION,
        LIST_CHANNELS_ACTION,
        GET_USER_INFO_ACTION,
        LIST_PINS_ACTION,
        EMOJI_LIST_ACTION,
    ];
    let unique: std::collections::HashSet<_> = names.iter().collect();
    assert_eq!(unique.len(), 11);
}

#[test]
fn test_all_action_names_prefixed_with_slack() {
    let names = [
        SEND_MESSAGE_ACTION,
        REACT_TO_MESSAGE_ACTION,
        READ_CHANNEL_ACTION,
        EDIT_MESSAGE_ACTION,
        DELETE_MESSAGE_ACTION,
        PIN_MESSAGE_ACTION,
        UNPIN_MESSAGE_ACTION,
        LIST_CHANNELS_ACTION,
        GET_USER_INFO_ACTION,
        LIST_PINS_ACTION,
        EMOJI_LIST_ACTION,
    ];
    for name in &names {
        assert!(name.starts_with("SLACK_"), "{} doesn't start with SLACK_", name);
    }
}

// ===================================================================
// Action param struct construction and serialization
// ===================================================================

#[test]
fn test_send_message_params() {
    let params = SendMessageParams {
        text: "Hello!".to_string(),
        channel_id: "C0123456789".to_string(),
        thread_ts: Some("1700000000.000001".to_string()),
    };
    let json = serde_json::to_string(&params).unwrap();
    let deserialized: SendMessageParams = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.text, "Hello!");
    assert_eq!(deserialized.channel_id, "C0123456789");
    assert!(deserialized.thread_ts.is_some());
}

#[test]
fn test_react_to_message_params() {
    let params = ReactToMessageParams {
        emoji: "thumbsup".to_string(),
        message_ts: "1700000000.000001".to_string(),
        channel_id: "C0123456789".to_string(),
        remove: false,
    };
    let json = serde_json::to_string(&params).unwrap();
    let deserialized: ReactToMessageParams = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.emoji, "thumbsup");
    assert!(!deserialized.remove);
}

#[test]
fn test_edit_message_params() {
    let params = EditMessageParams {
        message_ts: "1700000000.000001".to_string(),
        new_text: "Updated text".to_string(),
        channel_id: "C0123456789".to_string(),
    };
    assert_eq!(params.new_text, "Updated text");
}

#[test]
fn test_delete_message_params() {
    let params = DeleteMessageParams {
        message_ts: "1700000000.000001".to_string(),
        channel_id: "C0123456789".to_string(),
    };
    assert_eq!(params.message_ts, "1700000000.000001");
}

#[test]
fn test_pin_message_params() {
    let params = PinMessageParams {
        message_ts: "1700000000.000001".to_string(),
        channel_id: "C0123456789".to_string(),
    };
    assert_eq!(params.channel_id, "C0123456789");
}

#[test]
fn test_unpin_message_params() {
    let params = UnpinMessageParams {
        message_ts: "1700000000.000001".to_string(),
        channel_id: "C0123456789".to_string(),
    };
    assert_eq!(params.channel_id, "C0123456789");
}

#[test]
fn test_read_channel_params() {
    let params = ReadChannelParams {
        channel_id: "C0123456789".to_string(),
        limit: Some(20),
        before: None,
        after: None,
    };
    assert_eq!(params.limit, Some(20));
}

#[test]
fn test_get_user_info_params() {
    let params = GetUserInfoParams {
        user_id: "U0123456789".to_string(),
    };
    assert_eq!(params.user_id, "U0123456789");
}

#[test]
fn test_list_pins_params() {
    let params = ListPinsParams {
        channel_id: "C0123456789".to_string(),
    };
    assert_eq!(params.channel_id, "C0123456789");
}

// ===================================================================
// Action result struct construction
// ===================================================================

#[test]
fn test_send_message_result_success() {
    let result = SendMessageResult {
        success: true,
        message_ts: Some("1700000000.000099".to_string()),
        channel_id: Some("C0123456789".to_string()),
        error: None,
    };
    assert!(result.success);
    assert!(result.error.is_none());
}

#[test]
fn test_send_message_result_failure() {
    let result = SendMessageResult {
        success: false,
        message_ts: None,
        channel_id: None,
        error: Some("Slack service not available".to_string()),
    };
    assert!(!result.success);
    assert!(result.error.is_some());
}

#[test]
fn test_delete_message_result() {
    let result = DeleteMessageResult {
        success: true,
        error: None,
    };
    assert!(result.success);
}

#[test]
fn test_edit_message_result() {
    let result = EditMessageResult {
        success: false,
        error: Some("Invalid timestamp".to_string()),
    };
    assert!(!result.success);
}

#[test]
fn test_react_to_message_result() {
    let result = ReactToMessageResult {
        success: true,
        action: Some("added".to_string()),
        error: None,
    };
    assert_eq!(result.action.unwrap(), "added");
}

#[test]
fn test_emoji_list_result() {
    let mut emoji = HashMap::new();
    emoji.insert("party".to_string(), "https://emoji/party.png".to_string());
    let result = EmojiListResult {
        success: true,
        emoji,
        emoji_count: 1,
        error: None,
    };
    assert_eq!(result.emoji_count, 1);
}

#[test]
fn test_list_channels_result() {
    let result = ListChannelsResult {
        success: true,
        channels: vec![ChannelInfo {
            id: "C001".to_string(),
            name: "general".to_string(),
            is_private: false,
            num_members: Some(42),
            topic: Some("Discussion".to_string()),
            purpose: None,
        }],
        channel_count: 1,
        error: None,
    };
    assert_eq!(result.channel_count, 1);
    assert_eq!(result.channels[0].name, "general");
}

#[test]
fn test_channel_info_from_slack_channel() {
    let ch = make_channel();
    let info = ChannelInfo::from(ch);
    assert_eq!(info.id, "C0123456789");
    assert_eq!(info.name, "general");
    assert!(!info.is_private);
    assert_eq!(info.num_members, Some(42));
    assert!(info.topic.is_some());
    assert!(info.purpose.is_some());
}

#[test]
fn test_pin_info_from_slack_message() {
    let msg = make_message();
    let info = PinInfo::from(msg);
    assert_eq!(info.ts, "1700000000.000001");
    assert_eq!(info.text, "Hello from Slack!");
    assert_eq!(info.user.unwrap(), "U0123456789");
}

#[test]
fn test_list_pins_result() {
    let result = ListPinsResult {
        success: true,
        pins: vec![PinInfo {
            ts: "1700000000.000001".to_string(),
            user: Some("U001".to_string()),
            text: "Pinned message".to_string(),
        }],
        pin_count: 1,
        error: None,
    };
    assert_eq!(result.pin_count, 1);
}

#[test]
fn test_get_user_info_result_success() {
    let result = GetUserInfoResult {
        success: true,
        user_id: Some("U001".to_string()),
        name: Some("janesmith".to_string()),
        display_name: Some("Jane Smith".to_string()),
        real_name: Some("Jane A. Smith".to_string()),
        title: Some("Engineer".to_string()),
        email: Some("jane@example.com".to_string()),
        timezone: Some("America/New_York".to_string()),
        is_admin: Some(false),
        is_owner: Some(false),
        is_bot: Some(false),
        status_text: None,
        status_emoji: None,
        avatar: Some("https://img/192.png".to_string()),
        error: None,
    };
    assert!(result.success);
    assert_eq!(result.display_name.unwrap(), "Jane Smith");
}

#[test]
fn test_get_user_info_result_failure() {
    let result = GetUserInfoResult {
        success: false,
        user_id: None,
        name: None,
        display_name: None,
        real_name: None,
        title: None,
        email: None,
        timezone: None,
        is_admin: None,
        is_owner: None,
        is_bot: None,
        status_text: None,
        status_emoji: None,
        avatar: None,
        error: Some("Invalid user ID format".to_string()),
    };
    assert!(!result.success);
    assert!(result.error.is_some());
}

#[test]
fn test_read_channel_result() {
    let result = ReadChannelResult {
        success: true,
        messages: vec![make_message()],
        message_count: 1,
        error: None,
    };
    assert_eq!(result.message_count, 1);
    assert_eq!(result.messages[0].text, "Hello from Slack!");
}

// ===================================================================
// Provider metadata
// ===================================================================

#[test]
fn test_channel_state_provider_metadata() {
    assert_eq!(CHANNEL_STATE_PROVIDER, "slackChannelState");
    assert!(!CHANNEL_STATE_DESCRIPTION.is_empty());
    assert!(CHANNEL_STATE_DESCRIPTION.to_lowercase().contains("channel"));
}

#[test]
fn test_workspace_info_provider_metadata() {
    assert_eq!(WORKSPACE_INFO_PROVIDER, "slackWorkspaceInfo");
    assert!(!WORKSPACE_INFO_DESCRIPTION.is_empty());
    assert!(WORKSPACE_INFO_DESCRIPTION.to_lowercase().contains("workspace"));
}

#[test]
fn test_member_list_provider_metadata() {
    assert_eq!(MEMBER_LIST_PROVIDER, "slackMemberList");
    assert!(!MEMBER_LIST_DESCRIPTION.is_empty());
    assert!(MEMBER_LIST_DESCRIPTION.to_lowercase().contains("member"));
}

#[test]
fn test_all_3_provider_names_unique() {
    let names = vec![CHANNEL_STATE_PROVIDER, WORKSPACE_INFO_PROVIDER, MEMBER_LIST_PROVIDER];
    let unique: std::collections::HashSet<_> = names.iter().collect();
    assert_eq!(unique.len(), 3);
}

// ===================================================================
// Provider data structures
// ===================================================================

#[test]
fn test_channel_state_data_construction() {
    let data = ChannelStateData {
        channel_type: "PUBLIC_CHANNEL".to_string(),
        workspace_name: "Test".to_string(),
        channel_name: "general".to_string(),
        channel_id: "C001".to_string(),
        thread_ts: None,
        is_thread: false,
        topic: Some("Discussion".to_string()),
        purpose: Some("Company".to_string()),
        is_private: Some(false),
        num_members: Some(42),
    };
    assert_eq!(data.channel_type, "PUBLIC_CHANNEL");
    assert!(!data.is_thread);
}

#[test]
fn test_channel_state_data_thread() {
    let data = ChannelStateData {
        channel_type: "PUBLIC_CHANNEL".to_string(),
        workspace_name: "Test".to_string(),
        channel_name: "general".to_string(),
        channel_id: "C001".to_string(),
        thread_ts: Some("1700000000.000050".to_string()),
        is_thread: true,
        topic: None,
        purpose: None,
        is_private: None,
        num_members: None,
    };
    assert!(data.is_thread);
    assert!(data.thread_ts.is_some());
}

#[test]
fn test_channel_state_values_construction() {
    let values = ChannelStateValues {
        channel_type: "DM".to_string(),
        workspace_name: "".to_string(),
        channel_name: "".to_string(),
        channel_id: "D001".to_string(),
        is_thread: false,
    };
    assert_eq!(values.channel_type, "DM");
}

#[test]
fn test_channel_state_result_construction() {
    let result = ChannelStateResult {
        data: ChannelStateData {
            channel_type: "PUBLIC_CHANNEL".to_string(),
            workspace_name: String::new(),
            channel_name: "general".to_string(),
            channel_id: "C001".to_string(),
            thread_ts: None,
            is_thread: false,
            topic: None,
            purpose: None,
            is_private: Some(false),
            num_members: Some(10),
        },
        values: ChannelStateValues {
            channel_type: "PUBLIC_CHANNEL".to_string(),
            workspace_name: String::new(),
            channel_name: "general".to_string(),
            channel_id: "C001".to_string(),
            is_thread: false,
        },
        text: "Bot is in #general".to_string(),
    };
    assert!(!result.text.is_empty());
    assert_eq!(result.data.channel_name, "general");
}

#[test]
fn test_workspace_info_data_construction() {
    let data = WorkspaceInfoData {
        team_id: Some("T001".to_string()),
        bot_user_id: Some("U_BOT".to_string()),
        workspace_name: "Test Workspace".to_string(),
        domain: "test".to_string(),
        is_connected: true,
        public_channel_count: 5,
        private_channel_count: 2,
        member_channel_count: 4,
        has_channel_restrictions: false,
    };
    assert!(data.is_connected);
    assert_eq!(data.public_channel_count, 5);
}

#[test]
fn test_workspace_info_result_construction() {
    let result = WorkspaceInfoResult {
        data: WorkspaceInfoData {
            team_id: Some("T001".to_string()),
            bot_user_id: None,
            workspace_name: String::new(),
            domain: String::new(),
            is_connected: false,
            public_channel_count: 0,
            private_channel_count: 0,
            member_channel_count: 0,
            has_channel_restrictions: false,
        },
        text: "Connected".to_string(),
    };
    assert!(!result.text.is_empty());
}

#[test]
fn test_member_info_construction() {
    let m = MemberInfo {
        id: "U001".to_string(),
        name: "jane".to_string(),
        display_name: "Jane Smith".to_string(),
        is_bot: false,
        is_admin: true,
    };
    assert!(m.is_admin);
    assert!(!m.is_bot);
}

#[test]
fn test_member_list_data_construction() {
    let data = MemberListData {
        channel_id: "C001".to_string(),
        channel_name: "general".to_string(),
        member_count: 10,
        members: vec![],
        has_more_members: false,
    };
    assert_eq!(data.member_count, 10);
    assert!(data.members.is_empty());
}

#[test]
fn test_member_list_result_construction() {
    let result = MemberListResult {
        data: MemberListData {
            channel_id: "C001".to_string(),
            channel_name: "general".to_string(),
            member_count: 2,
            members: vec![
                MemberInfo {
                    id: "U001".to_string(),
                    name: "jane".to_string(),
                    display_name: "Jane".to_string(),
                    is_bot: false,
                    is_admin: false,
                },
            ],
            has_more_members: true,
        },
        text: "Members in #general".to_string(),
    };
    assert!(result.data.has_more_members);
    assert_eq!(result.data.members.len(), 1);
}

// ===================================================================
// Service result types
// ===================================================================

#[test]
fn test_service_send_message_result() {
    let result = ServiceSendMessageResult {
        ts: "1700000000.000099".to_string(),
        channel_id: "C0123456789".to_string(),
    };
    assert_eq!(result.ts, "1700000000.000099");
    assert_eq!(result.channel_id, "C0123456789");
}

#[test]
fn test_service_send_message_result_serialization() {
    let result = ServiceSendMessageResult {
        ts: "1700000000.000099".to_string(),
        channel_id: "C0123456789".to_string(),
    };
    let json = serde_json::to_string(&result).unwrap();
    let deserialized: ServiceSendMessageResult = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.ts, result.ts);
    assert_eq!(deserialized.channel_id, result.channel_id);
}
