//! Integration tests for the Google Chat plugin.

use elizaos_plugin_google_chat::{
    extract_resource_id,
    get_space_display_name,
    get_user_display_name,
    is_direct_message,
    is_valid_google_chat_space_name,
    is_valid_google_chat_user_name,
    normalize_space_target,
    normalize_user_target,
    split_message_for_google_chat,
    AttachmentRef,
    GoogleChatAudienceType,
    GoogleChatError,
    GoogleChatEventType,
    GoogleChatMessageSendOptions,
    GoogleChatReaction,
    GoogleChatSendResult,
    GoogleChatSettings,
    GoogleChatSpace,
    GoogleChatUser,
    GoogleChatEvent,
    GoogleChatThread,
    GoogleChatAttachment,
    GOOGLE_CHAT_SERVICE_NAME,
    MAX_GOOGLE_CHAT_MESSAGE_LENGTH,
};
use elizaos_plugin_google_chat::providers::{
    space_state::get_space_state,
    user_context::get_user_context,
};

// ============================================================
// Constants
// ============================================================

#[test]
fn test_max_message_length() {
    assert_eq!(MAX_GOOGLE_CHAT_MESSAGE_LENGTH, 4000);
}

#[test]
fn test_service_name() {
    assert_eq!(GOOGLE_CHAT_SERVICE_NAME, "google-chat");
}

// ============================================================
// Event Types
// ============================================================

#[test]
fn test_event_type_strings() {
    assert_eq!(
        GoogleChatEventType::MessageReceived.as_str(),
        "GOOGLE_CHAT_MESSAGE_RECEIVED"
    );
    assert_eq!(
        GoogleChatEventType::MessageSent.as_str(),
        "GOOGLE_CHAT_MESSAGE_SENT"
    );
    assert_eq!(
        GoogleChatEventType::SpaceJoined.as_str(),
        "GOOGLE_CHAT_SPACE_JOINED"
    );
    assert_eq!(
        GoogleChatEventType::SpaceLeft.as_str(),
        "GOOGLE_CHAT_SPACE_LEFT"
    );
    assert_eq!(
        GoogleChatEventType::ReactionReceived.as_str(),
        "GOOGLE_CHAT_REACTION_RECEIVED"
    );
    assert_eq!(
        GoogleChatEventType::ReactionSent.as_str(),
        "GOOGLE_CHAT_REACTION_SENT"
    );
    assert_eq!(
        GoogleChatEventType::WebhookReady.as_str(),
        "GOOGLE_CHAT_WEBHOOK_READY"
    );
    assert_eq!(
        GoogleChatEventType::ConnectionReady.as_str(),
        "GOOGLE_CHAT_CONNECTION_READY"
    );
}

#[test]
fn test_event_type_equality() {
    assert_eq!(GoogleChatEventType::MessageReceived, GoogleChatEventType::MessageReceived);
    assert_ne!(GoogleChatEventType::MessageReceived, GoogleChatEventType::MessageSent);
}

#[test]
fn test_event_type_serialization() {
    let event_type = GoogleChatEventType::MessageReceived;
    let json = serde_json::to_string(&event_type).unwrap();
    let deserialized: GoogleChatEventType = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized, GoogleChatEventType::MessageReceived);
}

// ============================================================
// Audience Type
// ============================================================

#[test]
fn test_audience_type_from_str() {
    assert_eq!(
        GoogleChatAudienceType::from_str("app-url"),
        Some(GoogleChatAudienceType::AppUrl)
    );
    assert_eq!(
        GoogleChatAudienceType::from_str("app_url"),
        Some(GoogleChatAudienceType::AppUrl)
    );
    assert_eq!(
        GoogleChatAudienceType::from_str("app"),
        Some(GoogleChatAudienceType::AppUrl)
    );
    assert_eq!(
        GoogleChatAudienceType::from_str("project-number"),
        Some(GoogleChatAudienceType::ProjectNumber)
    );
    assert_eq!(
        GoogleChatAudienceType::from_str("project_number"),
        Some(GoogleChatAudienceType::ProjectNumber)
    );
    assert_eq!(
        GoogleChatAudienceType::from_str("project"),
        Some(GoogleChatAudienceType::ProjectNumber)
    );
    assert_eq!(GoogleChatAudienceType::from_str("invalid"), None);
    assert_eq!(GoogleChatAudienceType::from_str(""), None);
}

#[test]
fn test_audience_type_case_insensitive() {
    assert_eq!(
        GoogleChatAudienceType::from_str("APP-URL"),
        Some(GoogleChatAudienceType::AppUrl)
    );
    assert_eq!(
        GoogleChatAudienceType::from_str("PROJECT-NUMBER"),
        Some(GoogleChatAudienceType::ProjectNumber)
    );
}

// ============================================================
// Settings
// ============================================================

#[test]
fn test_settings_default() {
    let settings = GoogleChatSettings::default();
    assert!(settings.service_account.is_none());
    assert!(settings.service_account_file.is_none());
    assert_eq!(settings.audience_type, GoogleChatAudienceType::AppUrl);
    assert!(settings.audience.is_empty());
    assert_eq!(settings.webhook_path, "/googlechat");
    assert!(settings.spaces.is_empty());
    assert!(settings.require_mention);
    assert!(settings.enabled);
    assert!(settings.bot_user.is_none());
}

#[test]
fn test_settings_custom() {
    let settings = GoogleChatSettings {
        service_account: Some("{\"type\": \"service_account\"}".to_string()),
        service_account_file: None,
        audience_type: GoogleChatAudienceType::ProjectNumber,
        audience: "123456789".to_string(),
        webhook_path: "/custom-webhook".to_string(),
        spaces: vec!["spaces/ABC".to_string(), "spaces/DEF".to_string()],
        require_mention: false,
        enabled: true,
        bot_user: Some("users/bot123".to_string()),
    };
    assert!(settings.service_account.is_some());
    assert_eq!(settings.audience, "123456789");
    assert_eq!(settings.spaces.len(), 2);
    assert!(!settings.require_mention);
    assert_eq!(settings.bot_user.as_deref(), Some("users/bot123"));
}

#[test]
fn test_settings_serialization() {
    let settings = GoogleChatSettings::default();
    let json = serde_json::to_string(&settings).unwrap();
    let deserialized: GoogleChatSettings = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.webhook_path, "/googlechat");
    assert!(deserialized.require_mention);
    assert!(deserialized.enabled);
}

// ============================================================
// Space Validation
// ============================================================

#[test]
fn test_valid_space_names() {
    assert!(is_valid_google_chat_space_name("spaces/ABC123"));
    assert!(is_valid_google_chat_space_name("spaces/abc-def"));
    assert!(is_valid_google_chat_space_name("spaces/test_space"));
    assert!(is_valid_google_chat_space_name("spaces/A"));
}

#[test]
fn test_invalid_space_names() {
    assert!(!is_valid_google_chat_space_name(""));
    assert!(!is_valid_google_chat_space_name("spaces/"));
    assert!(!is_valid_google_chat_space_name("ABC123"));
    assert!(!is_valid_google_chat_space_name("users/ABC123"));
    assert!(!is_valid_google_chat_space_name("spaces/abc def"));
    assert!(!is_valid_google_chat_space_name("spaces/abc/def"));
    assert!(!is_valid_google_chat_space_name("spaces/abc.def"));
}

// ============================================================
// User Validation
// ============================================================

#[test]
fn test_valid_user_names() {
    assert!(is_valid_google_chat_user_name("users/ABC123"));
    assert!(is_valid_google_chat_user_name("users/abc-def"));
    assert!(is_valid_google_chat_user_name("users/test_user"));
    assert!(is_valid_google_chat_user_name("users/A"));
}

#[test]
fn test_invalid_user_names() {
    assert!(!is_valid_google_chat_user_name(""));
    assert!(!is_valid_google_chat_user_name("users/"));
    assert!(!is_valid_google_chat_user_name("ABC123"));
    assert!(!is_valid_google_chat_user_name("spaces/ABC123"));
    assert!(!is_valid_google_chat_user_name("users/abc def"));
    assert!(!is_valid_google_chat_user_name("users/abc/def"));
}

// ============================================================
// Normalize Space Target
// ============================================================

#[test]
fn test_normalize_space_already_prefixed() {
    assert_eq!(
        normalize_space_target("spaces/ABC123"),
        Some("spaces/ABC123".to_string())
    );
}

#[test]
fn test_normalize_space_bare_id() {
    assert_eq!(
        normalize_space_target("ABC123"),
        Some("spaces/ABC123".to_string())
    );
    assert_eq!(
        normalize_space_target("my-space"),
        Some("spaces/my-space".to_string())
    );
    assert_eq!(
        normalize_space_target("space_name"),
        Some("spaces/space_name".to_string())
    );
}

#[test]
fn test_normalize_space_empty() {
    assert_eq!(normalize_space_target(""), None);
}

#[test]
fn test_normalize_space_whitespace() {
    assert_eq!(normalize_space_target("   "), None);
}

#[test]
fn test_normalize_space_invalid() {
    assert_eq!(normalize_space_target("abc def"), None);
    assert_eq!(normalize_space_target("abc/def"), None);
    assert_eq!(normalize_space_target("abc.def"), None);
}

#[test]
fn test_normalize_space_trims() {
    assert_eq!(
        normalize_space_target("  spaces/ABC123  "),
        Some("spaces/ABC123".to_string())
    );
    assert_eq!(
        normalize_space_target("  ABC123  "),
        Some("spaces/ABC123".to_string())
    );
}

// ============================================================
// Normalize User Target
// ============================================================

#[test]
fn test_normalize_user_already_prefixed() {
    assert_eq!(
        normalize_user_target("users/ABC123"),
        Some("users/ABC123".to_string())
    );
}

#[test]
fn test_normalize_user_bare_id() {
    assert_eq!(
        normalize_user_target("ABC123"),
        Some("users/ABC123".to_string())
    );
    assert_eq!(
        normalize_user_target("user-name"),
        Some("users/user-name".to_string())
    );
}

#[test]
fn test_normalize_user_empty() {
    assert_eq!(normalize_user_target(""), None);
}

#[test]
fn test_normalize_user_whitespace() {
    assert_eq!(normalize_user_target("   "), None);
}

#[test]
fn test_normalize_user_invalid() {
    assert_eq!(normalize_user_target("abc def"), None);
    assert_eq!(normalize_user_target("abc/def"), None);
}

// ============================================================
// Extract Resource ID
// ============================================================

#[test]
fn test_extract_resource_id_space() {
    assert_eq!(extract_resource_id("spaces/ABC123"), "ABC123");
}

#[test]
fn test_extract_resource_id_user() {
    assert_eq!(extract_resource_id("users/DEF456"), "DEF456");
}

#[test]
fn test_extract_resource_id_message() {
    assert_eq!(
        extract_resource_id("spaces/ABC/messages/MSG123"),
        "MSG123"
    );
}

#[test]
fn test_extract_resource_id_reaction() {
    assert_eq!(
        extract_resource_id("spaces/ABC/messages/MSG/reactions/RXN1"),
        "RXN1"
    );
}

#[test]
fn test_extract_resource_id_no_slash() {
    assert_eq!(extract_resource_id("standalone"), "standalone");
}

// ============================================================
// Display Names
// ============================================================

#[test]
fn test_user_display_name_with_name() {
    let user = GoogleChatUser {
        name: "users/ABC123".to_string(),
        display_name: Some("Jane Doe".to_string()),
        email: Some("jane@example.com".to_string()),
        user_type: Some("HUMAN".to_string()),
        domain_id: None,
        is_anonymous: false,
    };
    assert_eq!(get_user_display_name(&user), "Jane Doe");
}

#[test]
fn test_user_display_name_fallback() {
    let user = GoogleChatUser {
        name: "users/FALLBACK".to_string(),
        display_name: None,
        email: None,
        user_type: None,
        domain_id: None,
        is_anonymous: false,
    };
    assert_eq!(get_user_display_name(&user), "FALLBACK");
}

#[test]
fn test_space_display_name_with_name() {
    let space = GoogleChatSpace {
        name: "spaces/ABC123".to_string(),
        display_name: Some("Engineering Team".to_string()),
        space_type: "SPACE".to_string(),
        single_user_bot_dm: false,
        threaded: false,
    };
    assert_eq!(get_space_display_name(&space), "Engineering Team");
}

#[test]
fn test_space_display_name_fallback() {
    let space = GoogleChatSpace {
        name: "spaces/DEF456".to_string(),
        display_name: None,
        space_type: "ROOM".to_string(),
        single_user_bot_dm: false,
        threaded: false,
    };
    assert_eq!(get_space_display_name(&space), "DEF456");
}

// ============================================================
// Is Direct Message
// ============================================================

#[test]
fn test_is_dm_type() {
    let space = GoogleChatSpace {
        name: "spaces/DM123".to_string(),
        display_name: None,
        space_type: "DM".to_string(),
        single_user_bot_dm: false,
        threaded: false,
    };
    assert!(is_direct_message(&space));
}

#[test]
fn test_is_dm_bot_flag() {
    let space = GoogleChatSpace {
        name: "spaces/BOT123".to_string(),
        display_name: None,
        space_type: "SPACE".to_string(),
        single_user_bot_dm: true,
        threaded: false,
    };
    assert!(is_direct_message(&space));
}

#[test]
fn test_is_not_dm() {
    let space = GoogleChatSpace {
        name: "spaces/SPACE123".to_string(),
        display_name: None,
        space_type: "SPACE".to_string(),
        single_user_bot_dm: false,
        threaded: false,
    };
    assert!(!is_direct_message(&space));
}

#[test]
fn test_is_not_dm_room() {
    let space = GoogleChatSpace {
        name: "spaces/ROOM123".to_string(),
        display_name: None,
        space_type: "ROOM".to_string(),
        single_user_bot_dm: false,
        threaded: false,
    };
    assert!(!is_direct_message(&space));
}

// ============================================================
// Split Message
// ============================================================

#[test]
fn test_split_short_text() {
    let result = split_message_for_google_chat("Hello, world!", MAX_GOOGLE_CHAT_MESSAGE_LENGTH);
    assert_eq!(result, vec!["Hello, world!"]);
}

#[test]
fn test_split_at_max_length() {
    let text = "a".repeat(MAX_GOOGLE_CHAT_MESSAGE_LENGTH);
    let result = split_message_for_google_chat(&text, MAX_GOOGLE_CHAT_MESSAGE_LENGTH);
    assert_eq!(result.len(), 1);
    assert_eq!(result[0], text);
}

#[test]
fn test_split_exceeding_max() {
    let text = "a".repeat(MAX_GOOGLE_CHAT_MESSAGE_LENGTH + 100);
    let result = split_message_for_google_chat(&text, MAX_GOOGLE_CHAT_MESSAGE_LENGTH);
    assert!(result.len() > 1);
}

#[test]
fn test_split_at_newline() {
    let part1 = "a".repeat(2500);
    let part2 = "b".repeat(2500);
    let text = format!("{}\n{}", part1, part2);
    let result = split_message_for_google_chat(&text, 3000);
    assert_eq!(result.len(), 2);
    assert_eq!(result[0], part1);
    assert_eq!(result[1], part2);
}

#[test]
fn test_split_at_space() {
    let words: String = (0..200).map(|_| "word").collect::<Vec<_>>().join(" ");
    let result = split_message_for_google_chat(&words, 50);
    assert!(result.len() > 1);
    for chunk in &result {
        assert!(chunk.len() <= 50);
    }
}

#[test]
fn test_split_empty_text() {
    let result = split_message_for_google_chat("", MAX_GOOGLE_CHAT_MESSAGE_LENGTH);
    assert_eq!(result, vec![""]);
}

#[test]
fn test_split_custom_max() {
    let text = "a".repeat(200);
    let result = split_message_for_google_chat(&text, 100);
    assert_eq!(result.len(), 2);
}

#[test]
fn test_split_chunks_trimmed() {
    let text = format!("{}\n{}", "a".repeat(2500), "b".repeat(2500));
    let result = split_message_for_google_chat(&text, 3000);
    for chunk in &result {
        assert_eq!(chunk.as_str(), chunk.trim());
    }
}

// ============================================================
// Send Result
// ============================================================

#[test]
fn test_send_result_ok() {
    let result = GoogleChatSendResult::ok(
        "spaces/ABC/messages/MSG1".to_string(),
        "spaces/ABC".to_string(),
    );
    assert!(result.success);
    assert_eq!(
        result.message_name.as_deref(),
        Some("spaces/ABC/messages/MSG1")
    );
    assert_eq!(result.space.as_deref(), Some("spaces/ABC"));
    assert!(result.error.is_none());
}

#[test]
fn test_send_result_err() {
    let result = GoogleChatSendResult::err("Space is required");
    assert!(!result.success);
    assert!(result.message_name.is_none());
    assert!(result.space.is_none());
    assert_eq!(result.error.as_deref(), Some("Space is required"));
}

#[test]
fn test_send_result_serialization() {
    let result = GoogleChatSendResult::ok(
        "spaces/ABC/messages/MSG1".to_string(),
        "spaces/ABC".to_string(),
    );
    let json = serde_json::to_string(&result).unwrap();
    let deserialized: GoogleChatSendResult = serde_json::from_str(&json).unwrap();
    assert!(deserialized.success);
    assert_eq!(deserialized.message_name, result.message_name);
}

// ============================================================
// Error Types
// ============================================================

#[test]
fn test_error_config() {
    let err = GoogleChatError::config("test error");
    match err {
        GoogleChatError::Configuration { message, setting } => {
            assert_eq!(message, "test error");
            assert!(setting.is_none());
        }
        _ => panic!("Expected Configuration error"),
    }
}

#[test]
fn test_error_config_with_setting() {
    let err = GoogleChatError::config_with_setting("missing value", "GOOGLE_CHAT_AUDIENCE");
    match err {
        GoogleChatError::Configuration { message, setting } => {
            assert_eq!(message, "missing value");
            assert_eq!(setting.as_deref(), Some("GOOGLE_CHAT_AUDIENCE"));
        }
        _ => panic!("Expected Configuration error"),
    }
}

#[test]
fn test_error_api() {
    let err = GoogleChatError::api("api failure");
    match err {
        GoogleChatError::Api { message, status_code } => {
            assert_eq!(message, "api failure");
            assert!(status_code.is_none());
        }
        _ => panic!("Expected Api error"),
    }
}

#[test]
fn test_error_auth() {
    let err = GoogleChatError::auth("auth failed");
    match err {
        GoogleChatError::Authentication { message } => {
            assert_eq!(message, "auth failed");
        }
        _ => panic!("Expected Authentication error"),
    }
}

#[test]
fn test_error_not_initialized() {
    let err = GoogleChatError::NotInitialized;
    assert!(err.to_string().contains("not initialized"));
}

#[test]
fn test_error_not_connected() {
    let err = GoogleChatError::NotConnected;
    assert!(err.to_string().contains("not connected"));
}

#[test]
fn test_error_display() {
    let config_err = GoogleChatError::config("bad config");
    assert!(config_err.to_string().contains("bad config"));

    let api_err = GoogleChatError::api("api down");
    assert!(api_err.to_string().contains("api down"));

    let auth_err = GoogleChatError::auth("no token");
    assert!(auth_err.to_string().contains("no token"));
}

// ============================================================
// Type Serialization
// ============================================================

#[test]
fn test_space_serialization() {
    let space = GoogleChatSpace {
        name: "spaces/ABC123".to_string(),
        display_name: Some("Engineering".to_string()),
        space_type: "SPACE".to_string(),
        single_user_bot_dm: false,
        threaded: true,
    };

    let json = serde_json::to_string(&space).unwrap();
    assert!(json.contains("ABC123"));
    assert!(json.contains("Engineering"));

    let deserialized: GoogleChatSpace = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.name, "spaces/ABC123");
    assert_eq!(deserialized.display_name.as_deref(), Some("Engineering"));
    assert!(deserialized.threaded);
}

#[test]
fn test_user_serialization() {
    let user = GoogleChatUser {
        name: "users/USER123".to_string(),
        display_name: Some("Jane Doe".to_string()),
        email: Some("jane@example.com".to_string()),
        user_type: Some("HUMAN".to_string()),
        domain_id: None,
        is_anonymous: false,
    };

    let json = serde_json::to_string(&user).unwrap();
    assert!(json.contains("Jane Doe"));
    assert!(json.contains("jane@example.com"));

    let deserialized: GoogleChatUser = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.name, "users/USER123");
    assert_eq!(deserialized.email.as_deref(), Some("jane@example.com"));
    assert!(!deserialized.is_anonymous);
}

#[test]
fn test_message_send_options_serialization() {
    let opts = GoogleChatMessageSendOptions {
        space: Some("spaces/ABC".to_string()),
        thread: Some("spaces/ABC/threads/T1".to_string()),
        text: Some("Hello!".to_string()),
        attachments: vec![AttachmentRef {
            attachment_upload_token: "tok1".to_string(),
            content_name: Some("file.txt".to_string()),
        }],
    };

    let json = serde_json::to_string(&opts).unwrap();
    let deserialized: GoogleChatMessageSendOptions = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.space.as_deref(), Some("spaces/ABC"));
    assert_eq!(deserialized.text.as_deref(), Some("Hello!"));
    assert_eq!(deserialized.attachments.len(), 1);
    assert_eq!(deserialized.attachments[0].attachment_upload_token, "tok1");
}

#[test]
fn test_message_send_options_default() {
    let opts = GoogleChatMessageSendOptions::default();
    assert!(opts.space.is_none());
    assert!(opts.thread.is_none());
    assert!(opts.text.is_none());
    assert!(opts.attachments.is_empty());
}

#[test]
fn test_reaction_serialization() {
    let reaction = GoogleChatReaction {
        name: Some("spaces/ABC/messages/MSG/reactions/RXN1".to_string()),
        user: None,
        emoji: Some("👍".to_string()),
    };

    let json = serde_json::to_string(&reaction).unwrap();
    let deserialized: GoogleChatReaction = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.emoji.as_deref(), Some("👍"));
    assert!(deserialized.user.is_none());
}

#[test]
fn test_thread_serialization() {
    let thread = GoogleChatThread {
        name: "spaces/ABC/threads/T1".to_string(),
        thread_key: Some("my-key".to_string()),
    };

    let json = serde_json::to_string(&thread).unwrap();
    let deserialized: GoogleChatThread = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.name, "spaces/ABC/threads/T1");
    assert_eq!(deserialized.thread_key.as_deref(), Some("my-key"));
}

#[test]
fn test_attachment_serialization() {
    let attachment = GoogleChatAttachment {
        name: Some("attachment1".to_string()),
        content_name: Some("photo.jpg".to_string()),
        content_type: Some("image/jpeg".to_string()),
        thumbnail_uri: None,
        download_uri: Some("https://example.com/photo.jpg".to_string()),
        resource_name: None,
        attachment_upload_token: None,
    };

    let json = serde_json::to_string(&attachment).unwrap();
    let deserialized: GoogleChatAttachment = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.content_name.as_deref(), Some("photo.jpg"));
    assert_eq!(deserialized.content_type.as_deref(), Some("image/jpeg"));
}

#[test]
fn test_event_serialization() {
    let event = GoogleChatEvent {
        event_type: "MESSAGE".to_string(),
        event_time: Some("2024-01-01T00:00:00Z".to_string()),
        space: Some(GoogleChatSpace {
            name: "spaces/ABC".to_string(),
            display_name: None,
            space_type: "SPACE".to_string(),
            single_user_bot_dm: false,
            threaded: false,
        }),
        user: None,
        message: None,
    };

    let json = serde_json::to_string(&event).unwrap();
    assert!(json.contains("MESSAGE"));
    let deserialized: GoogleChatEvent = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.event_type, "MESSAGE");
    assert!(deserialized.space.is_some());
}

// ============================================================
// Providers
// ============================================================

#[test]
fn test_space_state_provider_dm() {
    let space = GoogleChatSpace {
        name: "spaces/DM123".to_string(),
        display_name: None,
        space_type: "DM".to_string(),
        single_user_bot_dm: true,
        threaded: false,
    };

    let result = get_space_state(Some(&space), "TestBot");
    assert!(result.text.contains("TestBot"));
    assert!(result.text.contains("direct message"));
    assert!(result.data.is_direct);
    assert!(result.data.connected);
}

#[test]
fn test_space_state_provider_regular_space() {
    let space = GoogleChatSpace {
        name: "spaces/SPACE456".to_string(),
        display_name: Some("Engineering".to_string()),
        space_type: "SPACE".to_string(),
        single_user_bot_dm: false,
        threaded: false,
    };

    let result = get_space_state(Some(&space), "AgentX");
    assert!(result.text.contains("AgentX"));
    assert!(result.text.contains("Engineering"));
    assert!(!result.data.is_direct);
    assert_eq!(
        result.data.space_display_name.as_deref(),
        Some("Engineering")
    );
}

#[test]
fn test_space_state_provider_threaded() {
    let space = GoogleChatSpace {
        name: "spaces/THREAD789".to_string(),
        display_name: Some("Threaded Room".to_string()),
        space_type: "SPACE".to_string(),
        single_user_bot_dm: false,
        threaded: true,
    };

    let result = get_space_state(Some(&space), "Bot");
    assert!(result.text.contains("threaded"));
    assert!(result.data.is_threaded);
}

#[test]
fn test_space_state_provider_no_space() {
    let result = get_space_state(None, "Bot");
    assert!(!result.data.is_direct);
    assert!(!result.data.is_threaded);
    assert!(result.data.space_name.is_none());
}

#[test]
fn test_user_context_provider_human() {
    let user = GoogleChatUser {
        name: "users/USER123".to_string(),
        display_name: Some("Jane Doe".to_string()),
        email: Some("jane@example.com".to_string()),
        user_type: Some("HUMAN".to_string()),
        domain_id: None,
        is_anonymous: false,
    };

    let result = get_user_context(&user, "TestBot");
    assert!(result.text.contains("TestBot"));
    assert!(result.text.contains("Jane Doe"));
    assert!(result.text.contains("jane@example.com"));
    assert!(result.text.contains("Google Chat"));
    assert_eq!(result.data.user_name, "users/USER123");
    assert_eq!(result.data.user_id, "USER123");
    assert_eq!(result.data.display_name, "Jane Doe");
    assert!(!result.data.is_bot);
}

#[test]
fn test_user_context_provider_bot() {
    let user = GoogleChatUser {
        name: "users/BOT456".to_string(),
        display_name: Some("Other Bot".to_string()),
        email: None,
        user_type: Some("BOT".to_string()),
        domain_id: None,
        is_anonymous: false,
    };

    let result = get_user_context(&user, "TestBot");
    assert!(result.text.contains("bot"));
    assert!(result.data.is_bot);
    assert_eq!(result.data.user_type, "BOT");
}

#[test]
fn test_user_context_provider_no_display_name() {
    let user = GoogleChatUser {
        name: "users/NOIDUSER".to_string(),
        display_name: None,
        email: None,
        user_type: None,
        domain_id: None,
        is_anonymous: false,
    };

    let result = get_user_context(&user, "Agent");
    assert_eq!(result.data.display_name, "NOIDUSER");
    assert_eq!(result.data.user_id, "NOIDUSER");
    assert_eq!(result.data.user_type, "HUMAN");
    assert!(!result.data.is_bot);
}

// ============================================================
// Action Parameter Types
// ============================================================

#[test]
fn test_send_message_params_serialization() {
    use elizaos_plugin_google_chat::actions::send_message::SendMessageParams;

    let params = SendMessageParams {
        text: "Hello!".to_string(),
        space: Some("spaces/ABC".to_string()),
        thread: None,
    };

    let json = serde_json::to_string(&params).unwrap();
    let deserialized: SendMessageParams = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.text, "Hello!");
    assert_eq!(deserialized.space.as_deref(), Some("spaces/ABC"));
    assert!(deserialized.thread.is_none());
}

#[test]
fn test_send_message_result_serialization() {
    use elizaos_plugin_google_chat::actions::send_message::SendMessageResult;

    let result = SendMessageResult {
        success: true,
        message_name: Some("spaces/ABC/messages/MSG1".to_string()),
        space: Some("spaces/ABC".to_string()),
        chunks_count: 1,
        error: None,
    };

    let json = serde_json::to_string(&result).unwrap();
    let deserialized: SendMessageResult = serde_json::from_str(&json).unwrap();
    assert!(deserialized.success);
    assert_eq!(deserialized.chunks_count, 1);
}

#[test]
fn test_send_reaction_params_serialization() {
    use elizaos_plugin_google_chat::actions::send_reaction::SendReactionParams;

    let params = SendReactionParams {
        emoji: "👍".to_string(),
        message_name: "spaces/ABC/messages/MSG1".to_string(),
        remove: false,
    };

    let json = serde_json::to_string(&params).unwrap();
    let deserialized: SendReactionParams = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.emoji, "👍");
    assert!(!deserialized.remove);
}

#[test]
fn test_send_reaction_result_serialization() {
    use elizaos_plugin_google_chat::actions::send_reaction::SendReactionResult;

    let result = SendReactionResult {
        success: true,
        reaction_name: Some("spaces/ABC/messages/MSG/reactions/RXN1".to_string()),
        emoji: "👍".to_string(),
        removed_count: None,
        error: None,
    };

    let json = serde_json::to_string(&result).unwrap();
    let deserialized: SendReactionResult = serde_json::from_str(&json).unwrap();
    assert!(deserialized.success);
    assert_eq!(deserialized.emoji, "👍");
}

#[test]
fn test_list_spaces_result_serialization() {
    use elizaos_plugin_google_chat::actions::list_spaces::{ListSpacesResult, SpaceInfo};

    let result = ListSpacesResult {
        success: true,
        space_count: 2,
        spaces: vec![
            SpaceInfo {
                name: "spaces/A".to_string(),
                display_name: Some("Space A".to_string()),
                space_type: "SPACE".to_string(),
                threaded: false,
            },
            SpaceInfo {
                name: "spaces/B".to_string(),
                display_name: None,
                space_type: "DM".to_string(),
                threaded: false,
            },
        ],
        formatted_text: "Currently in 2 space(s)".to_string(),
        error: None,
    };

    let json = serde_json::to_string(&result).unwrap();
    let deserialized: ListSpacesResult = serde_json::from_str(&json).unwrap();
    assert!(deserialized.success);
    assert_eq!(deserialized.space_count, 2);
    assert_eq!(deserialized.spaces.len(), 2);
}

#[test]
fn test_space_info_from_google_chat_space() {
    use elizaos_plugin_google_chat::actions::list_spaces::SpaceInfo;

    let space = GoogleChatSpace {
        name: "spaces/ABC".to_string(),
        display_name: Some("Engineering".to_string()),
        space_type: "SPACE".to_string(),
        single_user_bot_dm: false,
        threaded: true,
    };

    let info: SpaceInfo = space.into();
    assert_eq!(info.name, "spaces/ABC");
    assert_eq!(info.display_name.as_deref(), Some("Engineering"));
    assert_eq!(info.space_type, "SPACE");
    assert!(info.threaded);
}
