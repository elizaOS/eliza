//! Integration tests for the WhatsApp plugin

use elizaos_plugin_whatsapp::{
    WhatsAppConfig, WhatsAppError, WhatsAppPlugin, WHATSAPP_SERVICE_NAME,
    create_plugin,
    // Types
    MessageType, MessageContent, WhatsAppMessage, WhatsAppMessageResponse,
    WhatsAppContact, WhatsAppMessageId, WhatsAppChatState,
    TextMessage, MediaMessage, LocationMessage, ReactionMessage,
    WhatsAppWebhookEvent, MessageStatus,
    IncomingMessage, TemplateLanguage, TemplateComponent,
};
use elizaos_plugin_whatsapp::actions::SendMessageAction;
use elizaos_plugin_whatsapp::providers::ChatStateProvider;

// ============================================================================
// Config Tests
// ============================================================================

#[test]
fn test_config_new() {
    let config = WhatsAppConfig::new("my-token", "my-phone-id");
    assert_eq!(config.access_token, "my-token");
    assert_eq!(config.phone_number_id, "my-phone-id");
    assert_eq!(config.api_version, "v17.0");
    assert!(config.enabled);
    assert!(config.webhook_verify_token.is_none());
    assert!(config.business_id.is_none());
}

#[test]
fn test_config_validate_ok() {
    let config = WhatsAppConfig::new("token", "phone-id");
    assert!(config.validate().is_ok());
}

#[test]
fn test_config_validate_empty_token() {
    let config = WhatsAppConfig::new("", "phone-id");
    assert!(config.validate().is_err());
}

#[test]
fn test_config_validate_empty_phone_id() {
    let config = WhatsAppConfig::new("token", "");
    assert!(config.validate().is_err());
}

#[test]
fn test_config_builder_webhook_token() {
    let config = WhatsAppConfig::new("token", "phone-id")
        .with_webhook_token("wh-token");
    assert_eq!(config.webhook_verify_token, Some("wh-token".to_string()));
}

#[test]
fn test_config_builder_business_id() {
    let config = WhatsAppConfig::new("token", "phone-id")
        .with_business_id("biz-123");
    assert_eq!(config.business_id, Some("biz-123".to_string()));
}

#[test]
fn test_config_builder_chaining() {
    let config = WhatsAppConfig::new("token", "phone-id")
        .with_webhook_token("wh")
        .with_business_id("biz");
    assert_eq!(config.webhook_verify_token, Some("wh".to_string()));
    assert_eq!(config.business_id, Some("biz".to_string()));
    assert!(config.validate().is_ok());
}

#[test]
fn test_config_api_base_url() {
    let config = WhatsAppConfig::new("token", "phone-id");
    assert_eq!(config.api_base_url(), "https://graph.facebook.com/v17.0");
}

#[test]
fn test_config_serde_roundtrip() {
    let config = WhatsAppConfig::new("my-token", "my-phone")
        .with_webhook_token("wh")
        .with_business_id("biz");

    let json = serde_json::to_string(&config).unwrap();
    let deserialized: WhatsAppConfig = serde_json::from_str(&json).unwrap();

    assert_eq!(deserialized.access_token, "my-token");
    assert_eq!(deserialized.phone_number_id, "my-phone");
    assert_eq!(deserialized.webhook_verify_token, Some("wh".to_string()));
    assert_eq!(deserialized.business_id, Some("biz".to_string()));
    assert!(deserialized.enabled);
}

// ============================================================================
// Error Tests
// ============================================================================

#[test]
fn test_error_config() {
    let err = WhatsAppError::config("missing token");
    assert!(format!("{err}").contains("Configuration error"));
    assert!(format!("{err}").contains("missing token"));
}

#[test]
fn test_error_api() {
    let err = WhatsAppError::api(400, "Bad request");
    let display = format!("{err}");
    assert!(display.contains("400"));
    assert!(display.contains("Bad request"));
}

#[test]
fn test_error_auth() {
    let err = WhatsAppError::auth("invalid token");
    assert!(format!("{err}").contains("Authentication error"));
    assert!(format!("{err}").contains("invalid token"));
}

#[test]
fn test_error_webhook() {
    let err = WhatsAppError::webhook("verification failed");
    assert!(format!("{err}").contains("Webhook verification"));
}

#[test]
fn test_error_send() {
    let err = WhatsAppError::send("rate limited");
    assert!(format!("{err}").contains("Failed to send"));
    assert!(format!("{err}").contains("rate limited"));
}

#[test]
fn test_error_internal() {
    let err = WhatsAppError::internal("unexpected");
    assert!(format!("{err}").contains("Internal error"));
}

#[test]
fn test_error_is_debug() {
    let err = WhatsAppError::config("test");
    let debug = format!("{err:?}");
    assert!(debug.contains("ConfigError"));
}

// ============================================================================
// Action Tests
// ============================================================================

#[test]
fn test_send_message_action_new() {
    let action = SendMessageAction::new();
    assert_eq!(action.name(), "SEND_WHATSAPP_MESSAGE");
}

#[test]
fn test_send_message_action_description() {
    let action = SendMessageAction::new();
    assert!(action.description().contains("WhatsApp"));
}

#[test]
fn test_send_message_action_similes() {
    let action = SendMessageAction::new();
    let similes = action.similes();
    assert!(similes.contains(&"WHATSAPP_SEND"));
    assert!(similes.contains(&"TEXT_WHATSAPP"));
    assert!(similes.contains(&"MESSAGE_WHATSAPP"));
}

#[test]
fn test_send_message_action_validate_without_service() {
    let action = SendMessageAction::new();
    assert!(!action.validate());
}

#[test]
fn test_send_message_action_default() {
    let action = SendMessageAction::default();
    assert_eq!(action.name(), "SEND_WHATSAPP_MESSAGE");
    assert!(!action.validate());
}

#[tokio::test]
async fn test_send_message_action_send_without_service() {
    let action = SendMessageAction::new();
    let result: elizaos_plugin_whatsapp::Result<Option<serde_json::Value>> =
        action.send("15551234567", "Hello").await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_send_message_action_send_empty_text() {
    // Without service, it fails at the service check before empty-text check
    let action = SendMessageAction::new();
    let result: elizaos_plugin_whatsapp::Result<Option<serde_json::Value>> =
        action.send("15551234567", "   ").await;
    assert!(result.is_err());
}

// ============================================================================
// Provider Tests
// ============================================================================

#[test]
fn test_chat_state_provider_new() {
    let provider = ChatStateProvider::new();
    assert_eq!(provider.name(), "WHATSAPP_CHAT_STATE");
}

#[test]
fn test_chat_state_provider_description() {
    let provider = ChatStateProvider::new();
    assert!(provider.description().contains("WhatsApp"));
}

#[test]
fn test_chat_state_provider_default() {
    let provider = ChatStateProvider::default();
    assert_eq!(provider.name(), "WHATSAPP_CHAT_STATE");
}

#[tokio::test]
async fn test_chat_state_provider_get_without_service() {
    let provider = ChatStateProvider::new();
    let result: Option<String> = provider.get_chat_state("15551234567").await;
    assert!(result.is_none());
}

// ============================================================================
// Type Construction and Serde Tests
// ============================================================================

#[test]
fn test_message_type_serde() {
    let json = serde_json::to_string(&MessageType::Text).unwrap();
    assert_eq!(json, "\"text\"");

    let deserialized: MessageType = serde_json::from_str("\"image\"").unwrap();
    assert_eq!(deserialized, MessageType::Image);
}

#[test]
fn test_message_type_all_variants() {
    let variants = vec![
        MessageType::Text, MessageType::Image, MessageType::Audio,
        MessageType::Video, MessageType::Document, MessageType::Sticker,
        MessageType::Location, MessageType::Contacts, MessageType::Template,
        MessageType::Interactive, MessageType::Reaction,
    ];
    for variant in variants {
        let json = serde_json::to_string(&variant).unwrap();
        let back: MessageType = serde_json::from_str(&json).unwrap();
        assert_eq!(back, variant);
    }
}

#[test]
fn test_whatsapp_message_text() {
    let msg = WhatsAppMessage {
        to: "15551234567".to_string(),
        message_type: MessageType::Text,
        content: MessageContent::Text { body: "Hello!".to_string() },
    };
    assert_eq!(msg.to, "15551234567");
    assert_eq!(msg.message_type, MessageType::Text);
}

#[test]
fn test_whatsapp_message_location() {
    let msg = WhatsAppMessage {
        to: "15551234567".to_string(),
        message_type: MessageType::Location,
        content: MessageContent::Location {
            latitude: 37.7749,
            longitude: -122.4194,
            name: Some("SF".to_string()),
            address: None,
        },
    };
    if let MessageContent::Location { latitude, longitude, name, address } = &msg.content {
        assert!((latitude - 37.7749).abs() < 0.001);
        assert!((longitude + 122.4194).abs() < 0.001);
        assert_eq!(name.as_deref(), Some("SF"));
        assert!(address.is_none());
    } else {
        panic!("Expected Location content");
    }
}

#[test]
fn test_whatsapp_message_reaction() {
    let msg = WhatsAppMessage {
        to: "15551234567".to_string(),
        message_type: MessageType::Reaction,
        content: MessageContent::Reaction {
            message_id: "msg-123".to_string(),
            emoji: "👍".to_string(),
        },
    };
    if let MessageContent::Reaction { message_id, emoji } = &msg.content {
        assert_eq!(message_id, "msg-123");
        assert_eq!(emoji, "👍");
    } else {
        panic!("Expected Reaction content");
    }
}

#[test]
fn test_whatsapp_message_response() {
    let resp = WhatsAppMessageResponse {
        messaging_product: "whatsapp".to_string(),
        contacts: vec![WhatsAppContact {
            input: "15551234567".to_string(),
            wa_id: "15551234567".to_string(),
        }],
        messages: vec![WhatsAppMessageId {
            id: "wamid.abc123".to_string(),
        }],
    };
    assert_eq!(resp.messaging_product, "whatsapp");
    assert_eq!(resp.contacts.len(), 1);
    assert_eq!(resp.messages[0].id, "wamid.abc123");
}

#[test]
fn test_whatsapp_message_response_serde() {
    let json = r#"{
        "messaging_product": "whatsapp",
        "contacts": [{"input": "15551234567", "wa_id": "15551234567"}],
        "messages": [{"id": "wamid.xyz"}]
    }"#;
    let resp: WhatsAppMessageResponse = serde_json::from_str(json).unwrap();
    assert_eq!(resp.messages[0].id, "wamid.xyz");
}

#[test]
fn test_text_message() {
    let msg = TextMessage { body: "Hello".to_string() };
    assert_eq!(msg.body, "Hello");
}

#[test]
fn test_media_message() {
    let msg = MediaMessage {
        id: "media-1".to_string(),
        mime_type: Some("image/jpeg".to_string()),
        sha256: Some("abc123".to_string()),
        caption: Some("A photo".to_string()),
    };
    assert_eq!(msg.id, "media-1");
    assert_eq!(msg.mime_type.unwrap(), "image/jpeg");
}

#[test]
fn test_location_message() {
    let msg = LocationMessage {
        latitude: 40.7128,
        longitude: -74.0060,
        name: Some("NYC".to_string()),
        address: Some("New York, NY".to_string()),
    };
    assert!((msg.latitude - 40.7128).abs() < 0.001);
    assert_eq!(msg.name.unwrap(), "NYC");
}

#[test]
fn test_reaction_message() {
    let msg = ReactionMessage {
        message_id: "msg-abc".to_string(),
        emoji: "❤️".to_string(),
    };
    assert_eq!(msg.emoji, "❤️");
}

#[test]
fn test_incoming_message_serde() {
    let json = r#"{
        "from": "15551234567",
        "id": "msg-123",
        "timestamp": "1700000000",
        "type": "text",
        "text": {"body": "Hi there"}
    }"#;
    let msg: IncomingMessage = serde_json::from_str(json).unwrap();
    assert_eq!(msg.from, "15551234567");
    assert_eq!(msg.message_type, "text");
    assert_eq!(msg.text.unwrap().body, "Hi there");
}

#[test]
fn test_message_status_serde() {
    let status = MessageStatus {
        id: "msg-1".to_string(),
        status: "delivered".to_string(),
        timestamp: "1700000000".to_string(),
        recipient_id: "15551234567".to_string(),
    };
    let json = serde_json::to_string(&status).unwrap();
    let back: MessageStatus = serde_json::from_str(&json).unwrap();
    assert_eq!(back.status, "delivered");
}

#[test]
fn test_chat_state_construction() {
    let state = WhatsAppChatState {
        phone_number_id: "phone-123".to_string(),
        contact_wa_id: "15559999999".to_string(),
        contact_name: Some("Alice".to_string()),
        last_message_at: Some(1700000000),
    };
    assert_eq!(state.contact_wa_id, "15559999999");
    assert_eq!(state.contact_name.unwrap(), "Alice");
}

#[test]
fn test_chat_state_serde() {
    let state = WhatsAppChatState {
        phone_number_id: "phone-1".to_string(),
        contact_wa_id: "wa-1".to_string(),
        contact_name: None,
        last_message_at: None,
    };
    let json = serde_json::to_string(&state).unwrap();
    let back: WhatsAppChatState = serde_json::from_str(&json).unwrap();
    assert_eq!(back.phone_number_id, "phone-1");
    assert!(back.contact_name.is_none());
}

#[test]
fn test_webhook_event_serde() {
    let json = r#"{
        "object": "whatsapp_business_account",
        "entry": [{
            "id": "entry-1",
            "changes": [{
                "value": {
                    "messaging_product": "whatsapp",
                    "metadata": {
                        "display_phone_number": "15551234567",
                        "phone_number_id": "phone-123"
                    }
                },
                "field": "messages"
            }]
        }]
    }"#;
    let event: WhatsAppWebhookEvent = serde_json::from_str(json).unwrap();
    assert_eq!(event.object, "whatsapp_business_account");
    assert_eq!(event.entry[0].changes[0].field, "messages");
    assert_eq!(event.entry[0].changes[0].value.metadata.phone_number_id, "phone-123");
}

#[test]
fn test_template_language() {
    let lang = TemplateLanguage { code: "en_US".to_string() };
    let json = serde_json::to_string(&lang).unwrap();
    assert!(json.contains("en_US"));
}

#[test]
fn test_template_component() {
    let comp = TemplateComponent {
        component_type: "body".to_string(),
        parameters: vec![serde_json::json!({"type": "text", "text": "Hello"})],
    };
    assert_eq!(comp.component_type, "body");
    assert_eq!(comp.parameters.len(), 1);
}

// ============================================================================
// Plugin Metadata Tests
// ============================================================================

#[test]
fn test_plugin_name() {
    assert_eq!(WHATSAPP_SERVICE_NAME, "whatsapp");
}

#[test]
fn test_create_plugin() {
    let plugin = create_plugin();
    assert_eq!(plugin.name, WHATSAPP_SERVICE_NAME);
    assert!(plugin.description.contains("WhatsApp"));
}

#[test]
fn test_plugin_new() {
    let plugin = WhatsAppPlugin::new();
    assert_eq!(plugin.name, "whatsapp");
}

#[test]
fn test_plugin_default() {
    let plugin = WhatsAppPlugin::default();
    assert_eq!(plugin.name, "whatsapp");
}

#[test]
fn test_plugin_debug() {
    let plugin = create_plugin();
    let debug = format!("{plugin:?}");
    assert!(debug.contains("WhatsAppPlugin"));
}

#[test]
fn test_plugin_clone() {
    let plugin = create_plugin();
    let cloned = plugin.clone();
    assert_eq!(cloned.name, plugin.name);
    assert_eq!(cloned.description, plugin.description);
}
