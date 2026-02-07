use elizaos_plugin_blooio::{
    extract_urls, validate_chat_id, validate_email, validate_group_id, validate_phone,
    verify_webhook_signature, BlooioConfig, BlooioService, ConversationEntry, MessageTarget,
};

use elizaos_plugin_blooio::actions::SendMessageAction;
use elizaos_plugin_blooio::providers::ConversationHistoryProvider;
use elizaos_plugin_blooio::{Action, Provider};

use mockito::Server;
use serde_json::json;

// ===========================================================================
// Phone validation
// ===========================================================================

#[test]
fn test_validate_phone_valid_e164() {
    assert!(validate_phone("+15551234567"));
}

#[test]
fn test_validate_phone_valid_short() {
    assert!(validate_phone("+44"));
}

#[test]
fn test_validate_phone_invalid_no_plus() {
    assert!(!validate_phone("15551234567"));
}

#[test]
fn test_validate_phone_invalid_too_long() {
    // 16 digits after '+' exceeds E.164 limit
    assert!(!validate_phone("+1234567890123456"));
}

#[test]
fn test_validate_phone_invalid_letters() {
    assert!(!validate_phone("+1555abc1234"));
}

// ===========================================================================
// Email validation
// ===========================================================================

#[test]
fn test_validate_email_valid() {
    assert!(validate_email("user@example.com"));
}

#[test]
fn test_validate_email_valid_subdomains() {
    assert!(validate_email("user@mail.example.co.uk"));
}

#[test]
fn test_validate_email_invalid_no_at() {
    assert!(!validate_email("userexample.com"));
}

#[test]
fn test_validate_email_invalid_spaces() {
    assert!(!validate_email("user @example.com"));
}

// ===========================================================================
// Group ID validation
// ===========================================================================

#[test]
fn test_validate_group_id_valid() {
    assert!(validate_group_id("grp_abc123"));
}

#[test]
fn test_validate_group_id_invalid_prefix() {
    assert!(!validate_group_id("group_abc123"));
}

#[test]
fn test_validate_group_id_empty_suffix() {
    assert!(!validate_group_id("grp_"));
}

// ===========================================================================
// Chat ID validation (composite)
// ===========================================================================

#[test]
fn test_validate_chat_id_phone() {
    assert!(validate_chat_id("+15551234567"));
}

#[test]
fn test_validate_chat_id_email() {
    assert!(validate_chat_id("user@example.com"));
}

#[test]
fn test_validate_chat_id_group() {
    assert!(validate_chat_id("grp_abc123"));
}

#[test]
fn test_validate_chat_id_comma_separated() {
    assert!(validate_chat_id("+15551234567,user@example.com"));
}

#[test]
fn test_validate_chat_id_comma_with_spaces() {
    assert!(validate_chat_id("+15551234567 , user@example.com"));
}

#[test]
fn test_validate_chat_id_empty() {
    assert!(!validate_chat_id(""));
}

#[test]
fn test_validate_chat_id_invalid() {
    assert!(!validate_chat_id("not_a_valid_id"));
}

#[test]
fn test_validate_chat_id_mixed_valid_invalid() {
    assert!(!validate_chat_id("+15551234567,invalid"));
}

// ===========================================================================
// Webhook signature verification
// ===========================================================================

#[test]
fn test_verify_webhook_signature_valid() {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    type HmacSha256 = Hmac<Sha256>;

    let secret = "test_secret";
    let payload = b"test payload";
    let timestamp = "1234567890";

    let msg = format!("{}.{}", timestamp, String::from_utf8_lossy(payload));
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(msg.as_bytes());
    let sig = hex::encode(mac.finalize().into_bytes());

    let header = format!("t={},v1={}", timestamp, sig);
    assert!(verify_webhook_signature(payload, &header, secret));
}

#[test]
fn test_verify_webhook_signature_invalid_sig() {
    let bad_sig = "0".repeat(64); // correct length, wrong value
    let header = format!("t=1234567890,v1={}", bad_sig);
    assert!(!verify_webhook_signature(b"payload", &header, "secret"));
}

#[test]
fn test_verify_webhook_signature_malformed_header() {
    assert!(!verify_webhook_signature(b"payload", "malformed_header", "secret"));
}

#[test]
fn test_verify_webhook_signature_raw_hmac() {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    type HmacSha256 = Hmac<Sha256>;

    let secret = "raw_secret";
    let payload = b"raw payload data";

    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(payload);
    let sig = hex::encode(mac.finalize().into_bytes());

    // Passing a raw hex signature (no t=/v1= format) also works.
    assert!(verify_webhook_signature(payload, &sig, secret));
}

// ===========================================================================
// URL extraction
// ===========================================================================

#[test]
fn test_extract_urls_https() {
    let urls = extract_urls("Check https://example.com for info");
    assert_eq!(urls, vec!["https://example.com"]);
}

#[test]
fn test_extract_urls_http() {
    let urls = extract_urls("Visit http://example.com/page");
    assert_eq!(urls, vec!["http://example.com/page"]);
}

#[test]
fn test_extract_urls_multiple() {
    let urls = extract_urls("See https://a.com and https://b.com");
    assert_eq!(urls.len(), 2);
    assert_eq!(urls[0], "https://a.com");
    assert_eq!(urls[1], "https://b.com");
}

#[test]
fn test_extract_urls_deduplicates() {
    let urls = extract_urls("https://a.com and https://a.com again");
    assert_eq!(urls.len(), 1);
}

#[test]
fn test_extract_urls_empty() {
    assert!(extract_urls("").is_empty());
}

#[test]
fn test_extract_urls_no_urls() {
    assert!(extract_urls("Just plain text here").is_empty());
}

// ===========================================================================
// MessageTarget
// ===========================================================================

#[test]
fn test_message_target_from_phone() {
    let target = MessageTarget::from_str("+15551234567");
    assert!(matches!(target, Some(MessageTarget::Phone(_))));
}

#[test]
fn test_message_target_from_email() {
    let target = MessageTarget::from_str("user@example.com");
    assert!(matches!(target, Some(MessageTarget::Email(_))));
}

#[test]
fn test_message_target_from_group() {
    let target = MessageTarget::from_str("grp_abc123");
    assert!(matches!(target, Some(MessageTarget::GroupId(_))));
}

#[test]
fn test_message_target_from_invalid() {
    assert!(MessageTarget::from_str("invalid").is_none());
}

#[test]
fn test_message_target_as_chat_id() {
    let target = MessageTarget::Phone("+15551234567".to_string());
    assert_eq!(target.as_chat_id(), "+15551234567");
}

// ===========================================================================
// BlooioService — send_message (with mockito)
// ===========================================================================

#[tokio::test]
async fn test_send_message_success() {
    let mut server = Server::new_async().await;
    let mock = server
        .mock("POST", "/chats/grp_test123/messages")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(r#"{"success": true, "message_id": "msg_001"}"#)
        .create_async()
        .await;

    let config = BlooioConfig {
        api_key: "test_key".to_string(),
        api_base_url: server.url(),
        webhook_secret: None,
        webhook_port: 3001,
    };
    let service = BlooioService::new(config);
    let target = MessageTarget::GroupId("grp_test123".to_string());
    let result = service.send_message(&target, "Hello", &[]).await;

    assert!(result.is_ok());
    let resp = result.unwrap();
    assert!(resp.success);
    assert_eq!(resp.message_id, Some("msg_001".to_string()));
    mock.assert_async().await;
}

#[tokio::test]
async fn test_send_message_api_error() {
    let mut server = Server::new_async().await;
    let mock = server
        .mock("POST", "/chats/grp_err/messages")
        .with_status(500)
        .with_body("Internal Server Error")
        .create_async()
        .await;

    let config = BlooioConfig {
        api_key: "test_key".to_string(),
        api_base_url: server.url(),
        webhook_secret: None,
        webhook_port: 3001,
    };
    let service = BlooioService::new(config);
    let target = MessageTarget::GroupId("grp_err".to_string());
    let result = service.send_message(&target, "Hello", &[]).await;

    assert!(result.is_err());
    let err = result.unwrap_err();
    assert!(err.to_string().contains("500"));
    mock.assert_async().await;
}

#[tokio::test]
async fn test_send_message_with_attachments() {
    let mut server = Server::new_async().await;
    let mock = server
        .mock("POST", "/chats/grp_attach/messages")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(r#"{"success": true, "message_id": "msg_002"}"#)
        .create_async()
        .await;

    let config = BlooioConfig {
        api_key: "key".to_string(),
        api_base_url: server.url(),
        webhook_secret: None,
        webhook_port: 3001,
    };
    let service = BlooioService::new(config);
    let target = MessageTarget::GroupId("grp_attach".to_string());
    let attachments = vec!["https://img.example.com/photo.jpg".to_string()];
    let result = service
        .send_message(&target, "Check this out", &attachments)
        .await;

    assert!(result.is_ok());
    mock.assert_async().await;
}

#[tokio::test]
async fn test_send_message_invalid_target() {
    let config = BlooioConfig {
        api_key: "key".to_string(),
        api_base_url: "http://localhost".to_string(),
        webhook_secret: None,
        webhook_port: 3001,
    };
    let service = BlooioService::new(config);
    // A target with an invalid chat ID won't pass validate_chat_id.
    let target = MessageTarget::Phone("bad".to_string());
    let result = service.send_message(&target, "Hello", &[]).await;

    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("Invalid chat"));
}

// ===========================================================================
// BlooioService — conversation history
// ===========================================================================

#[test]
fn test_conversation_history_add_and_retrieve() {
    let config = BlooioConfig {
        api_key: "key".to_string(),
        api_base_url: "http://localhost".to_string(),
        webhook_secret: None,
        webhook_port: 3001,
    };
    let mut service = BlooioService::new(config);

    service.add_to_history(
        "chat1",
        ConversationEntry {
            role: "user".to_string(),
            text: "Hello".to_string(),
            timestamp: 1000,
            chat_id: "chat1".to_string(),
        },
    );
    service.add_to_history(
        "chat1",
        ConversationEntry {
            role: "assistant".to_string(),
            text: "Hi there".to_string(),
            timestamp: 2000,
            chat_id: "chat1".to_string(),
        },
    );

    let history = service.get_conversation_history("chat1", 10);
    assert_eq!(history.len(), 2);
    assert_eq!(history[0].text, "Hello");
    assert_eq!(history[1].text, "Hi there");
}

#[test]
fn test_conversation_history_empty() {
    let config = BlooioConfig {
        api_key: "key".to_string(),
        api_base_url: "http://localhost".to_string(),
        webhook_secret: None,
        webhook_port: 3001,
    };
    let service = BlooioService::new(config);
    assert!(service.get_conversation_history("nonexistent", 10).is_empty());
}

#[test]
fn test_conversation_history_with_limit() {
    let config = BlooioConfig {
        api_key: "key".to_string(),
        api_base_url: "http://localhost".to_string(),
        webhook_secret: None,
        webhook_port: 3001,
    };
    let mut service = BlooioService::new(config);

    for i in 0..5 {
        service.add_to_history(
            "chat2",
            ConversationEntry {
                role: "user".to_string(),
                text: format!("Message {}", i),
                timestamp: i as u64 * 1000,
                chat_id: "chat2".to_string(),
            },
        );
    }

    let history = service.get_conversation_history("chat2", 2);
    assert_eq!(history.len(), 2);
    assert_eq!(history[0].text, "Message 3");
    assert_eq!(history[1].text, "Message 4");
}

#[test]
fn test_conversation_history_limit_zero() {
    let config = BlooioConfig {
        api_key: "key".to_string(),
        api_base_url: "http://localhost".to_string(),
        webhook_secret: None,
        webhook_port: 3001,
    };
    let mut service = BlooioService::new(config);

    service.add_to_history(
        "chat3",
        ConversationEntry {
            role: "user".to_string(),
            text: "hello".to_string(),
            timestamp: 100,
            chat_id: "chat3".to_string(),
        },
    );

    assert!(service.get_conversation_history("chat3", 0).is_empty());
}

// ===========================================================================
// BlooioService — webhook verification
// ===========================================================================

#[test]
fn test_service_verify_webhook_with_secret() {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    type HmacSha256 = Hmac<Sha256>;

    let secret = "my_secret";
    let payload = b"request body";
    let timestamp = "1700000000";

    let msg = format!("{}.{}", timestamp, String::from_utf8_lossy(payload));
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(msg.as_bytes());
    let sig = hex::encode(mac.finalize().into_bytes());
    let header = format!("t={},v1={}", timestamp, sig);

    let config = BlooioConfig {
        api_key: "key".to_string(),
        api_base_url: "http://localhost".to_string(),
        webhook_secret: Some(secret.to_string()),
        webhook_port: 3001,
    };
    let service = BlooioService::new(config);
    assert!(service.verify_webhook(payload, &header));
}

#[test]
fn test_service_verify_webhook_no_secret() {
    let config = BlooioConfig {
        api_key: "key".to_string(),
        api_base_url: "http://localhost".to_string(),
        webhook_secret: None,
        webhook_port: 3001,
    };
    let service = BlooioService::new(config);
    // No secret configured ⇒ verification is skipped (returns true).
    assert!(service.verify_webhook(b"anything", "any_sig"));
}

#[test]
fn test_service_verify_webhook_wrong_signature() {
    let config = BlooioConfig {
        api_key: "key".to_string(),
        api_base_url: "http://localhost".to_string(),
        webhook_secret: Some("real_secret".to_string()),
        webhook_port: 3001,
    };
    let service = BlooioService::new(config);
    let bad_sig = format!("t=123,v1={}", "0".repeat(64));
    assert!(!service.verify_webhook(b"body", &bad_sig));
}

// ===========================================================================
// Action — SEND_MESSAGE
// ===========================================================================

#[tokio::test]
async fn test_action_validate_with_phone() {
    let action = SendMessageAction;
    let message = json!({
        "content": { "text": "Send a message to +15551234567 saying hello" }
    });
    assert!(action.validate(&message, &json!({})).await);
}

#[tokio::test]
async fn test_action_validate_with_email() {
    let action = SendMessageAction;
    let message = json!({
        "content": { "text": "Message jane@example.com with greetings" }
    });
    assert!(action.validate(&message, &json!({})).await);
}

#[tokio::test]
async fn test_action_validate_without_chat_id() {
    let action = SendMessageAction;
    let message = json!({
        "content": { "text": "Just a regular message without any recipient" }
    });
    assert!(!action.validate(&message, &json!({})).await);
}

#[tokio::test]
async fn test_action_handler_no_service() {
    let action = SendMessageAction;
    let message = json!({
        "content": { "text": "Send to +15551234567" }
    });
    let result = action.handler(&message, &json!({}), None).await;
    assert!(!result.success);
    assert!(result.error.is_some());
}

#[tokio::test]
async fn test_action_handler_sends_message() {
    let mut server = Server::new_async().await;
    let mock = server
        .mock("POST", "/chats/grp_action/messages")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(r#"{"success":true,"message_id":"msg_action"}"#)
        .create_async()
        .await;

    let config = BlooioConfig {
        api_key: "key".to_string(),
        api_base_url: server.url(),
        webhook_secret: None,
        webhook_port: 3001,
    };
    let mut service = BlooioService::new(config);
    let action = SendMessageAction;
    let message = json!({
        "content": { "text": "Send a message to grp_action saying Hi team!" }
    });

    let result = action
        .handler(&message, &json!({}), Some(&mut service))
        .await;
    assert!(result.success);
    assert!(result.text.contains("grp_action"));
    mock.assert_async().await;
}

// ===========================================================================
// Provider — CONVERSATION_HISTORY
// ===========================================================================

#[tokio::test]
async fn test_provider_no_service() {
    let provider = ConversationHistoryProvider;
    let message = json!({
        "content": { "chatId": "+15551234567" }
    });
    let result = provider.get(&message, &json!({}), None).await;
    assert!(result.text.contains("not initialized"));
}

#[tokio::test]
async fn test_provider_no_chat_id() {
    let config = BlooioConfig {
        api_key: "key".to_string(),
        api_base_url: "http://localhost".to_string(),
        webhook_secret: None,
        webhook_port: 3001,
    };
    let service = BlooioService::new(config);
    let provider = ConversationHistoryProvider;
    let message = json!({
        "content": { "text": "no identifier here" }
    });
    let result = provider.get(&message, &json!({}), Some(&service)).await;
    assert!(result.text.contains("No chat identifier"));
}

#[tokio::test]
async fn test_provider_empty_history() {
    let config = BlooioConfig {
        api_key: "key".to_string(),
        api_base_url: "http://localhost".to_string(),
        webhook_secret: None,
        webhook_port: 3001,
    };
    let service = BlooioService::new(config);
    let provider = ConversationHistoryProvider;
    let message = json!({
        "content": { "chatId": "+15551234567" }
    });
    let result = provider.get(&message, &json!({}), Some(&service)).await;
    assert!(result.text.contains("No recent conversation"));
}

#[tokio::test]
async fn test_provider_with_history() {
    let config = BlooioConfig {
        api_key: "key".to_string(),
        api_base_url: "http://localhost".to_string(),
        webhook_secret: None,
        webhook_port: 3001,
    };
    let mut service = BlooioService::new(config);
    service.add_to_history(
        "+15551234567",
        ConversationEntry {
            role: "user".to_string(),
            text: "Hello".to_string(),
            timestamp: 1000,
            chat_id: "+15551234567".to_string(),
        },
    );
    service.add_to_history(
        "+15551234567",
        ConversationEntry {
            role: "assistant".to_string(),
            text: "Hi there!".to_string(),
            timestamp: 2000,
            chat_id: "+15551234567".to_string(),
        },
    );

    let provider = ConversationHistoryProvider;
    let message = json!({
        "content": { "chatId": "+15551234567" }
    });
    let result = provider.get(&message, &json!({}), Some(&service)).await;
    assert!(result.text.contains("Hello"));
    assert!(result.text.contains("Hi there!"));
    assert!(result.text.contains("+15551234567"));
}

#[tokio::test]
async fn test_provider_extracts_phone_from_text() {
    let config = BlooioConfig {
        api_key: "key".to_string(),
        api_base_url: "http://localhost".to_string(),
        webhook_secret: None,
        webhook_port: 3001,
    };
    let mut service = BlooioService::new(config);
    service.add_to_history(
        "+19998887777",
        ConversationEntry {
            role: "user".to_string(),
            text: "Testing".to_string(),
            timestamp: 3000,
            chat_id: "+19998887777".to_string(),
        },
    );

    let provider = ConversationHistoryProvider;
    let message = json!({
        "content": { "text": "Show conversation with +19998887777" }
    });
    let result = provider.get(&message, &json!({}), Some(&service)).await;
    assert!(result.text.contains("Testing"));
}
