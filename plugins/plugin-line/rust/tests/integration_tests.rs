//! Integration tests for the LINE plugin.

use elizaos_plugin_line::*;
use elizaos_plugin_line::service::{LineService, LineServiceConfig};
use elizaos_plugin_line::webhook;

// ===========================================================================
// Config validation
// ===========================================================================

#[test]
fn test_valid_config() {
    let config = LineServiceConfig {
        channel_access_token: "test_token_123".to_string(),
        channel_secret: "test_secret_456".to_string(),
        ..Default::default()
    };

    assert_eq!(config.channel_access_token, "test_token_123");
    assert_eq!(config.channel_secret, "test_secret_456");
    assert!(config.enabled);
}

#[test]
fn test_config_defaults() {
    let config = LineServiceConfig::default();
    assert_eq!(config.channel_access_token, "");
    assert_eq!(config.channel_secret, "");
    assert_eq!(config.webhook_path, Some("/webhooks/line".to_string()));
    assert_eq!(config.dm_policy, Some("pairing".to_string()));
    assert_eq!(config.group_policy, Some("allowlist".to_string()));
    assert!(config.allow_from.is_empty());
    assert!(config.enabled);
}

#[test]
fn test_settings_defaults() {
    let settings = LineSettings::default();
    assert_eq!(settings.webhook_path, "/webhooks/line");
    assert_eq!(settings.dm_policy, "pairing");
    assert_eq!(settings.group_policy, "allowlist");
    assert!(settings.enabled);
    assert!(settings.channel_access_token.is_empty());
    assert!(settings.channel_secret.is_empty());
    assert!(settings.allow_from.is_empty());
}

#[tokio::test]
async fn test_service_rejects_missing_token() {
    let service = LineService::new();
    let config = LineServiceConfig {
        channel_access_token: "".to_string(),
        channel_secret: "some_secret".to_string(),
        ..Default::default()
    };

    let result = service.start(&config).await;
    assert!(result.is_err());
    let err_msg = format!("{}", result.unwrap_err());
    assert!(err_msg.contains("ACCESS_TOKEN"));
}

#[tokio::test]
async fn test_service_rejects_missing_secret() {
    let service = LineService::new();
    let config = LineServiceConfig {
        channel_access_token: "some_token".to_string(),
        channel_secret: "".to_string(),
        ..Default::default()
    };

    let result = service.start(&config).await;
    assert!(result.is_err());
    let err_msg = format!("{}", result.unwrap_err());
    assert!(err_msg.contains("SECRET"));
}

// ===========================================================================
// Type construction and serialization
// ===========================================================================

#[test]
fn test_line_user_serialization() {
    let user = LineUser {
        user_id: "U1234567890abcdef1234567890abcdef".to_string(),
        display_name: "Test User".to_string(),
        picture_url: Some("https://example.com/pic.jpg".to_string()),
        status_message: Some("Hello".to_string()),
        language: Some("ja".to_string()),
    };

    let json = serde_json::to_value(&user).unwrap();
    assert_eq!(json["user_id"], "U1234567890abcdef1234567890abcdef");
    assert_eq!(json["display_name"], "Test User");
    assert_eq!(json["picture_url"], "https://example.com/pic.jpg");
    assert_eq!(json["status_message"], "Hello");
    assert_eq!(json["language"], "ja");
}

#[test]
fn test_line_user_optional_fields_omitted() {
    let user = LineUser {
        user_id: "U1234567890abcdef1234567890abcdef".to_string(),
        display_name: "Test User".to_string(),
        picture_url: None,
        status_message: None,
        language: None,
    };

    let json = serde_json::to_value(&user).unwrap();
    assert!(json.get("picture_url").is_none());
    assert!(json.get("status_message").is_none());
    assert!(json.get("language").is_none());
}

#[test]
fn test_line_group_serialization() {
    let group = LineGroup {
        group_id: "C1234567890abcdef1234567890abcdef".to_string(),
        group_type: LineChatType::Group,
        group_name: Some("Test Group".to_string()),
        picture_url: None,
        member_count: Some(42),
    };

    let json = serde_json::to_value(&group).unwrap();
    assert_eq!(json["group_id"], "C1234567890abcdef1234567890abcdef");
    assert_eq!(json["group_name"], "Test Group");
    assert_eq!(json["member_count"], 42);
}

#[test]
fn test_line_message_construction() {
    let msg = LineMessage {
        id: "msg123".to_string(),
        message_type: "text".to_string(),
        user_id: "U1234567890abcdef1234567890abcdef".to_string(),
        timestamp: 1234567890,
        text: Some("Hello, world!".to_string()),
        group_id: None,
        room_id: None,
        reply_token: Some("token123".to_string()),
    };

    assert_eq!(msg.id, "msg123");
    assert_eq!(msg.message_type, "text");
    assert_eq!(msg.text, Some("Hello, world!".to_string()));
    assert_eq!(msg.reply_token, Some("token123".to_string()));
    assert!(msg.group_id.is_none());
}

#[test]
fn test_line_send_result_success() {
    let result = LineSendResult::success("msg_id".to_string(), "chat_id".to_string());
    assert!(result.success);
    assert_eq!(result.message_id, Some("msg_id".to_string()));
    assert_eq!(result.chat_id, Some("chat_id".to_string()));
    assert!(result.error.is_none());
}

#[test]
fn test_line_send_result_failure() {
    let result = LineSendResult::failure("Something went wrong");
    assert!(!result.success);
    assert!(result.message_id.is_none());
    assert!(result.chat_id.is_none());
    assert_eq!(result.error, Some("Something went wrong".to_string()));
}

#[test]
fn test_line_send_result_roundtrip_json() {
    let result = LineSendResult::success("id1".to_string(), "chat1".to_string());
    let json_str = serde_json::to_string(&result).unwrap();
    let deserialized: LineSendResult = serde_json::from_str(&json_str).unwrap();
    assert_eq!(deserialized.success, result.success);
    assert_eq!(deserialized.message_id, result.message_id);
}

// ===========================================================================
// Message formatting (flex messages, location messages)
// ===========================================================================

#[test]
fn test_flex_message_construction() {
    let flex = LineFlexMessage {
        alt_text: "Card notification".to_string(),
        contents: serde_json::json!({
            "type": "bubble",
            "body": {
                "type": "box",
                "layout": "vertical",
                "contents": [
                    { "type": "text", "text": "Title", "weight": "bold", "size": "xl" },
                    { "type": "text", "text": "Body text", "margin": "md", "wrap": true }
                ]
            }
        }),
    };

    assert_eq!(flex.alt_text, "Card notification");
    assert_eq!(flex.contents["type"], "bubble");
    assert_eq!(flex.contents["body"]["contents"][0]["text"], "Title");
    assert_eq!(flex.contents["body"]["contents"][1]["text"], "Body text");
}

#[test]
fn test_flex_message_serialization() {
    let flex = LineFlexMessage {
        alt_text: "Test".to_string(),
        contents: serde_json::json!({ "type": "bubble" }),
    };

    let json = serde_json::to_value(&flex).unwrap();
    assert_eq!(json["alt_text"], "Test");
    assert_eq!(json["contents"]["type"], "bubble");
}

#[test]
fn test_location_message_construction() {
    let location = LineLocationMessage {
        title: "Tokyo Tower".to_string(),
        address: "4 Chome-2-8 Shibakoen".to_string(),
        latitude: 35.6586,
        longitude: 139.7454,
    };

    let json = serde_json::to_value(&location).unwrap();
    assert_eq!(json["title"], "Tokyo Tower");
    assert_eq!(json["address"], "4 Chome-2-8 Shibakoen");
    assert!((json["latitude"].as_f64().unwrap() - 35.6586).abs() < 0.0001);
    assert!((json["longitude"].as_f64().unwrap() - 139.7454).abs() < 0.0001);
}

#[test]
fn test_template_message_construction() {
    let template = LineTemplateMessage {
        template_type: "confirm".to_string(),
        alt_text: "Confirm action".to_string(),
        template: serde_json::json!({
            "type": "confirm",
            "text": "Are you sure?",
            "actions": [
                { "type": "message", "label": "Yes", "text": "yes" },
                { "type": "message", "label": "No", "text": "no" }
            ]
        }),
    };

    assert_eq!(template.template_type, "confirm");
    assert_eq!(template.alt_text, "Confirm action");
    assert_eq!(template.template["text"], "Are you sure?");
    assert_eq!(template.template["actions"].as_array().unwrap().len(), 2);
}

// ===========================================================================
// Action validation logic
// ===========================================================================

#[test]
fn test_send_message_action_metadata() {
    assert_eq!(SEND_MESSAGE_ACTION_NAME, "LINE_SEND_MESSAGE");
    assert!(!SEND_MESSAGE_ACTION_DESCRIPTION.is_empty());
    assert!(SEND_MESSAGE_ACTION_SIMILES.contains(&"SEND_LINE_MESSAGE"));
    assert!(SEND_MESSAGE_ACTION_SIMILES.contains(&"LINE_MESSAGE"));
    assert!(SEND_MESSAGE_ACTION_SIMILES.contains(&"LINE_TEXT"));
    assert!(SEND_MESSAGE_ACTION_SIMILES.contains(&"MESSAGE_LINE"));
}

#[test]
fn test_send_flex_message_action_metadata() {
    assert_eq!(SEND_FLEX_MESSAGE_ACTION_NAME, "LINE_SEND_FLEX_MESSAGE");
    assert!(!SEND_FLEX_MESSAGE_ACTION_DESCRIPTION.is_empty());
    assert!(SEND_FLEX_MESSAGE_ACTION_SIMILES.contains(&"LINE_FLEX"));
    assert!(SEND_FLEX_MESSAGE_ACTION_SIMILES.contains(&"LINE_CARD"));
    assert!(SEND_FLEX_MESSAGE_ACTION_SIMILES.contains(&"SEND_LINE_CARD"));
    assert!(SEND_FLEX_MESSAGE_ACTION_SIMILES.contains(&"SEND_LINE_FLEX"));
}

#[test]
fn test_send_location_action_metadata() {
    assert_eq!(SEND_LOCATION_ACTION_NAME, "LINE_SEND_LOCATION");
    assert!(!SEND_LOCATION_ACTION_DESCRIPTION.is_empty());
    assert!(SEND_LOCATION_ACTION_SIMILES.contains(&"LINE_LOCATION"));
    assert!(SEND_LOCATION_ACTION_SIMILES.contains(&"LINE_MAP"));
    assert!(SEND_LOCATION_ACTION_SIMILES.contains(&"SEND_LINE_LOCATION"));
    assert!(SEND_LOCATION_ACTION_SIMILES.contains(&"SHARE_LOCATION_LINE"));
}

#[test]
fn test_send_message_params_serialization() {
    let params = SendMessageParams {
        text: "Hello LINE".to_string(),
        to: "U1234567890abcdef1234567890abcdef".to_string(),
    };

    let json = serde_json::to_value(&params).unwrap();
    assert_eq!(json["text"], "Hello LINE");
    assert_eq!(json["to"], "U1234567890abcdef1234567890abcdef");
}

#[test]
fn test_send_flex_message_params_serialization() {
    let params = SendFlexMessageParams {
        alt_text: "Card".to_string(),
        title: "Title".to_string(),
        body: "Body".to_string(),
        to: "U1234567890abcdef1234567890abcdef".to_string(),
    };

    let json = serde_json::to_value(&params).unwrap();
    assert_eq!(json["alt_text"], "Card");
    assert_eq!(json["title"], "Title");
    assert_eq!(json["body"], "Body");
}

#[test]
fn test_send_location_params_serialization() {
    let params = SendLocationParams {
        title: "Tokyo Tower".to_string(),
        address: "Minato".to_string(),
        latitude: 35.6586,
        longitude: 139.7454,
        to: "U1234567890abcdef1234567890abcdef".to_string(),
    };

    let json = serde_json::to_value(&params).unwrap();
    assert_eq!(json["title"], "Tokyo Tower");
    assert!((json["latitude"].as_f64().unwrap() - 35.6586).abs() < 0.0001);
}

// ===========================================================================
// Provider output format
// ===========================================================================

#[test]
fn test_user_context_provider_metadata() {
    assert_eq!(USER_CONTEXT_PROVIDER_NAME, "lineUserContext");
    assert!(!USER_CONTEXT_PROVIDER_DESCRIPTION.is_empty());
}

#[test]
fn test_chat_context_provider_metadata() {
    assert_eq!(CHAT_CONTEXT_PROVIDER_NAME, "lineChatContext");
    assert!(!CHAT_CONTEXT_PROVIDER_DESCRIPTION.is_empty());
}

#[test]
fn test_line_user_context_struct() {
    let ctx = LineUserContext {
        user_id: Some("U123".to_string()),
        display_name: Some("Test".to_string()),
        picture_url: None,
        status_message: None,
        language: Some("ja".to_string()),
        connected: true,
    };

    assert!(ctx.connected);
    assert_eq!(ctx.display_name, Some("Test".to_string()));
    assert_eq!(ctx.language, Some("ja".to_string()));

    let json = serde_json::to_value(&ctx).unwrap();
    assert_eq!(json["connected"], true);
    assert_eq!(json["user_id"], "U123");
}

#[test]
fn test_line_chat_context_struct() {
    let ctx = LineChatContext {
        chat_type: "group".to_string(),
        chat_id: "C123".to_string(),
        user_id: Some("U123".to_string()),
        group_id: Some("C123".to_string()),
        room_id: None,
        chat_name: Some("Test Group".to_string()),
        member_count: Some(10),
        connected: true,
    };

    assert_eq!(ctx.chat_type, "group");
    assert!(ctx.connected);
    assert_eq!(ctx.member_count, Some(10));

    let json = serde_json::to_value(&ctx).unwrap();
    assert_eq!(json["chat_type"], "group");
    assert_eq!(json["chat_name"], "Test Group");
}

#[test]
fn test_user_context_response_serialization() {
    let response = UserContextResponse {
        data: LineUserContext {
            user_id: Some("U1".to_string()),
            display_name: Some("User One".to_string()),
            picture_url: None,
            status_message: None,
            language: None,
            connected: true,
        },
        values: serde_json::json!({ "user_id": "U1", "display_name": "User One" }),
        text: "Talking to User One".to_string(),
    };

    let json = serde_json::to_value(&response).unwrap();
    assert_eq!(json["data"]["connected"], true);
    assert_eq!(json["text"], "Talking to User One");
}

// ===========================================================================
// Webhook signature validation
// ===========================================================================

#[test]
fn test_webhook_signature_valid() {
    let secret = "test_secret";
    let body = b"{\"events\":[]}";
    let signature = webhook::compute_signature(body, secret);
    assert!(webhook::validate_signature(body, &signature, secret));
}

#[test]
fn test_webhook_signature_invalid() {
    let body = b"{\"events\":[]}";
    assert!(!webhook::validate_signature(body, "invalid_signature", "test_secret"));
}

#[test]
fn test_webhook_signature_wrong_secret() {
    let secret = "correct_secret";
    let body = b"{\"events\":[]}";
    let signature = webhook::compute_signature(body, secret);

    // Same secret validates
    assert!(webhook::validate_signature(body, &signature, secret));
    // Wrong secret rejects
    assert!(!webhook::validate_signature(body, &signature, "wrong_secret"));
}

#[test]
fn test_webhook_signature_different_body() {
    let secret = "my_secret";
    let body1 = b"body_one";
    let body2 = b"body_two";
    let sig1 = webhook::compute_signature(body1, secret);
    let sig2 = webhook::compute_signature(body2, secret);

    assert_ne!(sig1, sig2);
    assert!(webhook::validate_signature(body1, &sig1, secret));
    assert!(!webhook::validate_signature(body2, &sig1, secret));
}

#[test]
fn test_webhook_signature_empty_body() {
    let secret = "secret";
    let body = b"";
    let sig = webhook::compute_signature(body, secret);
    assert!(webhook::validate_signature(body, &sig, secret));
}

// ===========================================================================
// Event type parsing
// ===========================================================================

#[test]
fn test_parse_follow_event() {
    let data = serde_json::json!({
        "type": "follow",
        "timestamp": 1234567890000_i64,
        "source": {
            "type": "user",
            "userId": "U1234567890abcdef1234567890abcdef"
        },
        "replyToken": "reply123"
    });

    let event = webhook::parse_webhook_event(&data).unwrap();
    assert_eq!(event.event_type(), "follow");
    assert_eq!(event.timestamp(), 1234567890000);
    assert_eq!(
        event.source().user_id,
        Some("U1234567890abcdef1234567890abcdef".to_string())
    );
}

#[test]
fn test_parse_unfollow_event() {
    let data = serde_json::json!({
        "type": "unfollow",
        "timestamp": 1000,
        "source": {
            "type": "user",
            "userId": "U1234567890abcdef1234567890abcdef"
        }
    });

    let event = webhook::parse_webhook_event(&data).unwrap();
    assert_eq!(event.event_type(), "unfollow");
    assert_eq!(event.source().source_type, "user");
}

#[test]
fn test_parse_join_event() {
    let data = serde_json::json!({
        "type": "join",
        "timestamp": 2000,
        "source": {
            "type": "group",
            "groupId": "C1234567890abcdef1234567890abcdef"
        },
        "replyToken": "reply456"
    });

    let event = webhook::parse_webhook_event(&data).unwrap();
    assert_eq!(event.event_type(), "join");
    assert_eq!(event.source().source_type, "group");
    assert_eq!(
        event.source().group_id,
        Some("C1234567890abcdef1234567890abcdef".to_string())
    );
}

#[test]
fn test_parse_leave_event() {
    let data = serde_json::json!({
        "type": "leave",
        "timestamp": 3000,
        "source": {
            "type": "room",
            "roomId": "R1234567890abcdef1234567890abcdef"
        }
    });

    let event = webhook::parse_webhook_event(&data).unwrap();
    assert_eq!(event.event_type(), "leave");
    assert_eq!(event.source().source_type, "room");
    assert_eq!(
        event.source().room_id,
        Some("R1234567890abcdef1234567890abcdef".to_string())
    );
}

#[test]
fn test_parse_postback_event() {
    let data = serde_json::json!({
        "type": "postback",
        "timestamp": 4000,
        "source": {
            "type": "user",
            "userId": "U1234567890abcdef1234567890abcdef"
        },
        "replyToken": "reply789",
        "postback": {
            "data": "action=buy&itemid=123",
            "params": { "date": "2024-01-01" }
        }
    });

    let event = webhook::parse_webhook_event(&data).unwrap();
    assert_eq!(event.event_type(), "postback");

    if let webhook::WebhookEvent::Postback(pb) = event {
        assert_eq!(pb.data, "action=buy&itemid=123");
        assert!(pb.params.is_some());
        assert_eq!(pb.reply_token, Some("reply789".to_string()));
    } else {
        panic!("Expected PostbackEvent");
    }
}

#[test]
fn test_parse_message_event_text() {
    let data = serde_json::json!({
        "type": "message",
        "timestamp": 5000,
        "source": {
            "type": "user",
            "userId": "U1234567890abcdef1234567890abcdef"
        },
        "replyToken": "reply999",
        "message": {
            "id": "msg456",
            "type": "text",
            "text": "Hello, bot!"
        }
    });

    let event = webhook::parse_webhook_event(&data).unwrap();
    assert_eq!(event.event_type(), "message");

    if let webhook::WebhookEvent::Message(msg) = event {
        assert_eq!(msg.message_id, "msg456");
        assert_eq!(msg.message_type, "text");
        assert_eq!(msg.text, Some("Hello, bot!".to_string()));
        assert_eq!(msg.reply_token, Some("reply999".to_string()));
    } else {
        panic!("Expected MessageEvent");
    }
}

#[test]
fn test_parse_message_event_image() {
    let data = serde_json::json!({
        "type": "message",
        "timestamp": 6000,
        "source": { "type": "group", "groupId": "C123", "userId": "U456" },
        "replyToken": "rt",
        "message": { "id": "img1", "type": "image" }
    });

    let event = webhook::parse_webhook_event(&data).unwrap();
    if let webhook::WebhookEvent::Message(msg) = event {
        assert_eq!(msg.message_type, "image");
        assert!(msg.text.is_none());
    } else {
        panic!("Expected MessageEvent");
    }
}

#[test]
fn test_parse_unknown_event_type() {
    let data = serde_json::json!({
        "type": "beacon",
        "timestamp": 0,
        "source": { "type": "user" }
    });

    assert!(webhook::parse_webhook_event(&data).is_none());
}

#[test]
fn test_parse_webhook_body_multiple_events() {
    let body = serde_json::json!({
        "events": [
            {
                "type": "follow",
                "timestamp": 1000,
                "source": { "type": "user", "userId": "U1234567890abcdef1234567890abcdef" }
            },
            {
                "type": "message",
                "timestamp": 2000,
                "source": { "type": "user", "userId": "U1234567890abcdef1234567890abcdef" },
                "replyToken": "rt",
                "message": { "id": "m1", "type": "text", "text": "Hi" }
            },
            {
                "type": "unfollow",
                "timestamp": 3000,
                "source": { "type": "user", "userId": "U1234567890abcdef1234567890abcdef" }
            }
        ]
    });

    let events = webhook::parse_webhook_body(&body);
    assert_eq!(events.len(), 3);
    assert_eq!(events[0].event_type(), "follow");
    assert_eq!(events[1].event_type(), "message");
    assert_eq!(events[2].event_type(), "unfollow");
}

#[test]
fn test_parse_webhook_body_empty() {
    let body = serde_json::json!({ "events": [] });
    assert!(webhook::parse_webhook_body(&body).is_empty());
}

#[test]
fn test_parse_webhook_body_no_events_key() {
    let body = serde_json::json!({});
    assert!(webhook::parse_webhook_body(&body).is_empty());
}

// ===========================================================================
// Message splitting for LINE's character limits
// ===========================================================================

#[test]
fn test_split_short_message() {
    let chunks = split_message_for_line("Hello", None);
    assert_eq!(chunks, vec!["Hello"]);
}

#[test]
fn test_split_empty_message() {
    let chunks = split_message_for_line("", None);
    assert_eq!(chunks, vec![""]);
}

#[test]
fn test_split_exact_limit_message() {
    let text = "a".repeat(MAX_LINE_MESSAGE_LENGTH);
    let chunks = split_message_for_line(&text, None);
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].len(), MAX_LINE_MESSAGE_LENGTH);
}

#[test]
fn test_split_over_limit_message() {
    let text = "a".repeat(6000);
    let chunks = split_message_for_line(&text, Some(1000));
    assert!(chunks.len() > 1);
    for chunk in &chunks {
        assert!(chunk.len() <= 1000);
    }
    // All characters preserved
    let total: usize = chunks.iter().map(|c| c.len()).sum();
    assert_eq!(total, 6000);
}

#[test]
fn test_split_at_newline() {
    let first_part = "a".repeat(600);
    let second_part = "b".repeat(200);
    let text = format!("{}\n{}", first_part, second_part);
    let chunks = split_message_for_line(&text, Some(700));
    assert_eq!(chunks.len(), 2);
    assert_eq!(chunks[0], first_part);
    assert_eq!(chunks[1], second_part);
}

#[test]
fn test_split_at_space() {
    let first_part = "a".repeat(600);
    let second_part = "b".repeat(200);
    let text = format!("{} {}", first_part, second_part);
    let chunks = split_message_for_line(&text, Some(700));
    assert_eq!(chunks.len(), 2);
}

#[test]
fn test_split_custom_limit() {
    let text = "Hello World, this is a test message.";
    let chunks = split_message_for_line(text, Some(15));
    assert!(chunks.len() >= 2);
    for chunk in &chunks {
        assert!(chunk.len() <= 15);
    }
}

// ===========================================================================
// ID validation
// ===========================================================================

#[test]
fn test_valid_user_ids() {
    assert!(is_valid_line_user_id("U1234567890abcdef1234567890abcdef"));
    assert!(is_valid_line_user_id("Uabcdefabcdefabcdefabcdefabcdefab"));
    assert!(is_valid_line_user_id("UABCDEF1234567890ABCDEF1234567890"));
}

#[test]
fn test_invalid_user_ids() {
    assert!(!is_valid_line_user_id("C1234567890abcdef1234567890abcdef"));
    assert!(!is_valid_line_user_id("U123"));
    assert!(!is_valid_line_user_id(""));
    assert!(!is_valid_line_user_id("invalid"));
    assert!(!is_valid_line_user_id("u1234567890abcdef1234567890abcdef")); // lowercase u
}

#[test]
fn test_valid_group_ids() {
    assert!(is_valid_line_group_id("C1234567890abcdef1234567890abcdef"));
}

#[test]
fn test_invalid_group_ids() {
    assert!(!is_valid_line_group_id("U1234567890abcdef1234567890abcdef"));
    assert!(!is_valid_line_group_id("C123"));
    assert!(!is_valid_line_group_id(""));
}

#[test]
fn test_valid_room_ids() {
    assert!(is_valid_line_room_id("R1234567890abcdef1234567890abcdef"));
}

#[test]
fn test_invalid_room_ids() {
    assert!(!is_valid_line_room_id("U1234567890abcdef1234567890abcdef"));
    assert!(!is_valid_line_room_id("R123"));
}

#[test]
fn test_is_valid_line_id_any() {
    assert!(is_valid_line_id("U1234567890abcdef1234567890abcdef"));
    assert!(is_valid_line_id("C1234567890abcdef1234567890abcdef"));
    assert!(is_valid_line_id("R1234567890abcdef1234567890abcdef"));
    assert!(!is_valid_line_id("X1234567890abcdef1234567890abcdef"));
    assert!(!is_valid_line_id(""));
}

#[test]
fn test_is_valid_line_id_whitespace_trimmed() {
    assert!(is_valid_line_id(" U1234567890abcdef1234567890abcdef "));
}

#[test]
fn test_normalize_line_target_plain_id() {
    let result = normalize_line_target("U1234567890abcdef1234567890abcdef");
    assert_eq!(result, Some("U1234567890abcdef1234567890abcdef".to_string()));
}

#[test]
fn test_normalize_line_target_with_prefix() {
    let result = normalize_line_target("line:user:U1234567890abcdef1234567890abcdef");
    assert_eq!(result, Some("U1234567890abcdef1234567890abcdef".to_string()));
}

#[test]
fn test_normalize_line_target_empty() {
    assert!(normalize_line_target("").is_none());
    assert!(normalize_line_target("   ").is_none());
}

#[test]
fn test_get_chat_type_from_id() {
    assert_eq!(
        get_chat_type_from_id("U1234567890abcdef1234567890abcdef"),
        Some(LineChatType::User)
    );
    assert_eq!(
        get_chat_type_from_id("C1234567890abcdef1234567890abcdef"),
        Some(LineChatType::Group)
    );
    assert_eq!(
        get_chat_type_from_id("R1234567890abcdef1234567890abcdef"),
        Some(LineChatType::Room)
    );
    assert_eq!(get_chat_type_from_id("invalid"), None);
}

// ===========================================================================
// Event type and chat type display
// ===========================================================================

#[test]
fn test_line_event_type_display() {
    assert_eq!(LineEventType::MessageReceived.to_string(), "LINE_MESSAGE_RECEIVED");
    assert_eq!(LineEventType::MessageSent.to_string(), "LINE_MESSAGE_SENT");
    assert_eq!(LineEventType::Follow.to_string(), "LINE_FOLLOW");
    assert_eq!(LineEventType::Unfollow.to_string(), "LINE_UNFOLLOW");
    assert_eq!(LineEventType::JoinGroup.to_string(), "LINE_JOIN_GROUP");
    assert_eq!(LineEventType::LeaveGroup.to_string(), "LINE_LEAVE_GROUP");
    assert_eq!(LineEventType::Postback.to_string(), "LINE_POSTBACK");
    assert_eq!(LineEventType::WebhookVerified.to_string(), "LINE_WEBHOOK_VERIFIED");
    assert_eq!(LineEventType::ConnectionReady.to_string(), "LINE_CONNECTION_READY");
}

#[test]
fn test_line_chat_type_display() {
    assert_eq!(LineChatType::User.to_string(), "user");
    assert_eq!(LineChatType::Group.to_string(), "group");
    assert_eq!(LineChatType::Room.to_string(), "room");
}

#[test]
fn test_line_event_type_equality() {
    assert_eq!(LineEventType::Follow, LineEventType::Follow);
    assert_ne!(LineEventType::Follow, LineEventType::Unfollow);
}

// ===========================================================================
// Error types
// ===========================================================================

#[test]
fn test_configuration_error() {
    let err = LinePluginError::configuration("Missing config");
    assert!(format!("{}", err).contains("Missing config"));
}

#[test]
fn test_configuration_error_with_setting() {
    let err = LinePluginError::configuration_with_setting(
        "Token required",
        "LINE_CHANNEL_ACCESS_TOKEN",
    );
    assert!(format!("{}", err).contains("Token required"));

    if let LinePluginError::Configuration { setting, .. } = &err {
        assert_eq!(*setting, Some("LINE_CHANNEL_ACCESS_TOKEN".to_string()));
    } else {
        panic!("Expected Configuration error");
    }
}

#[test]
fn test_api_error() {
    let err = LinePluginError::api("Bad request");
    assert!(format!("{}", err).contains("Bad request"));
}

#[test]
fn test_api_error_with_status() {
    let err = LinePluginError::api_with_status("Not found", 404);
    if let LinePluginError::Api { status_code, .. } = &err {
        assert_eq!(*status_code, Some(404));
    } else {
        panic!("Expected Api error");
    }
}

#[test]
fn test_not_initialized_error() {
    let err = LinePluginError::NotInitialized;
    assert!(format!("{}", err).contains("not initialized"));
}

// ===========================================================================
// Webhook middleware
// ===========================================================================

#[test]
fn test_create_webhook_middleware_valid() {
    let secret = "my_secret";
    let middleware = webhook::create_webhook_middleware(secret.to_string());

    let body = b"test body content";
    let signature = webhook::compute_signature(body, secret);

    assert!(middleware(body, &signature));
}

#[test]
fn test_create_webhook_middleware_invalid() {
    let middleware = webhook::create_webhook_middleware("secret".to_string());
    assert!(!middleware(b"body", "wrong_sig"));
}

// ===========================================================================
// Constants
// ===========================================================================

#[test]
fn test_constants() {
    assert_eq!(MAX_LINE_MESSAGE_LENGTH, 5000);
    assert_eq!(MAX_LINE_BATCH_SIZE, 5);
    assert_eq!(LINE_SERVICE_NAME, "line");
}

// ===========================================================================
// Service lifecycle
// ===========================================================================

#[tokio::test]
async fn test_service_not_connected_by_default() {
    let service = LineService::new();
    assert!(!service.is_connected().await);
}

#[tokio::test]
async fn test_service_start_and_stop() {
    let service = LineService::new();
    let config = LineServiceConfig {
        channel_access_token: "test_token".to_string(),
        channel_secret: "test_secret".to_string(),
        ..Default::default()
    };

    service.start(&config).await.unwrap();
    assert!(service.is_connected().await);

    service.stop().await;
    assert!(!service.is_connected().await);
}

#[tokio::test]
async fn test_service_channel_secret() {
    let service = LineService::new();

    // No secret before start
    assert!(service.get_channel_secret().await.is_none());

    let config = LineServiceConfig {
        channel_access_token: "token".to_string(),
        channel_secret: "my_channel_secret".to_string(),
        ..Default::default()
    };

    service.start(&config).await.unwrap();
    assert_eq!(
        service.get_channel_secret().await,
        Some("my_channel_secret".to_string())
    );
}

#[tokio::test]
async fn test_service_webhook_validation() {
    let service = LineService::new();
    let config = LineServiceConfig {
        channel_access_token: "token".to_string(),
        channel_secret: "webhook_secret".to_string(),
        ..Default::default()
    };

    service.start(&config).await.unwrap();

    let body = b"{\"events\":[]}";
    let sig = webhook::compute_signature(body, "webhook_secret");

    assert!(service.validate_webhook_signature(body, &sig).await);
    assert!(!service.validate_webhook_signature(body, "bad_sig").await);
}
