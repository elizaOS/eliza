use elizaos_plugin_farcaster::{
    ActionResult, Cast, FarcasterClient, FarcasterConfig, FarcasterError, FarcasterPlugin,
    FarcasterService, Profile, ProfileProvider, ProviderResult, ReplyCastAction, SendCastAction,
    ThreadProvider, TimelineProvider, FARCASTER_SERVICE_NAME, FARCASTER_SOURCE, PLUGIN_DESCRIPTION,
    PLUGIN_NAME, PLUGIN_VERSION,
};
use elizaos_plugin_farcaster::actions::{ActionExample, all_action_names};
use elizaos_plugin_farcaster::client::split_post_content;
use elizaos_plugin_farcaster::config::FarcasterMode;
use elizaos_plugin_farcaster::providers::all_provider_names;
use elizaos_plugin_farcaster::types::{
    CastEmbed, CastId, CastParent, CastStats, EmbedType, FarcasterEventType,
    FarcasterMessageType, FidRequest, GetMentionsResponse, GetTimelineResponse, LastCast,
    NeynarWebhookData, SendCastParams, SendCastResponse, WebhookAuthor, WebhookCastData,
};

fn test_config() -> FarcasterConfig {
    FarcasterConfig::new(12345, "test-signer-uuid", "test-api-key").with_dry_run(true)
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Plugin Metadata
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_plugin_metadata() {
    assert_eq!(PLUGIN_NAME, "farcaster");
    assert!(!PLUGIN_DESCRIPTION.is_empty());
    assert!(!PLUGIN_VERSION.is_empty());
}

#[test]
fn test_plugin_constants() {
    assert_eq!(FARCASTER_SERVICE_NAME, "farcaster");
    assert_eq!(FARCASTER_SOURCE, "farcaster");
}

#[test]
fn test_plugin_descriptor() {
    assert_eq!(FarcasterPlugin::name(), "farcaster");
    assert!(!FarcasterPlugin::description().is_empty());
    assert!(!FarcasterPlugin::version().is_empty());

    let actions = FarcasterPlugin::actions();
    assert_eq!(actions.len(), 2);
    assert_eq!(actions[0].0, "SEND_CAST");
    assert_eq!(actions[1].0, "REPLY_TO_CAST");

    let providers = FarcasterPlugin::providers();
    assert_eq!(providers.len(), 3);
    assert_eq!(providers[0].0, "farcaster_timeline");
    assert_eq!(providers[1].0, "farcaster_thread");
    assert_eq!(providers[2].0, "farcaster_profile");
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Config Creation & Validation
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_config_creation() {
    let config = test_config();
    assert_eq!(config.fid, 12345);
    assert_eq!(config.signer_uuid, "test-signer-uuid");
    assert_eq!(config.neynar_api_key, "test-api-key");
    assert!(config.dry_run);
}

#[test]
fn test_config_defaults() {
    let config = FarcasterConfig::new(1, "s", "k");
    assert!(!config.dry_run);
    assert_eq!(config.max_cast_length, 320);
    assert_eq!(config.poll_interval, 120);
    assert!(config.enable_cast);
    assert_eq!(config.cast_interval_min, 90);
    assert_eq!(config.cast_interval_max, 180);
    assert!(config.enable_action_processing);
    assert!(config.cast_immediately);
    assert_eq!(config.max_actions_processing, 10);
    assert!(config.hub_url.is_none());
}

#[test]
fn test_config_valid() {
    let config = test_config();
    assert!(config.validate().is_ok());
}

#[test]
fn test_config_invalid_fid_zero() {
    let config = FarcasterConfig::new(0, "signer", "key");
    let err = config.validate().unwrap_err();
    assert!(err.to_string().contains("FARCASTER_FID"));
}

#[test]
fn test_config_invalid_empty_signer() {
    let config = FarcasterConfig::new(1, "", "key");
    let err = config.validate().unwrap_err();
    assert!(err.to_string().contains("SIGNER_UUID"));
}

#[test]
fn test_config_invalid_empty_api_key() {
    let config = FarcasterConfig::new(1, "signer", "");
    let err = config.validate().unwrap_err();
    assert!(err.to_string().contains("NEYNAR_API_KEY"));
}

#[test]
fn test_config_invalid_cast_length_zero() {
    let mut config = FarcasterConfig::new(1, "s", "k");
    config.max_cast_length = 0;
    assert!(config.validate().is_err());
}

#[test]
fn test_config_invalid_cast_length_too_large() {
    let mut config = FarcasterConfig::new(1, "s", "k");
    config.max_cast_length = 2000;
    assert!(config.validate().is_err());
}

#[test]
fn test_config_invalid_poll_interval_zero() {
    let mut config = FarcasterConfig::new(1, "s", "k");
    config.poll_interval = 0;
    assert!(config.validate().is_err());
}

#[test]
fn test_config_invalid_interval_order() {
    let mut config = FarcasterConfig::new(1, "s", "k");
    config.cast_interval_min = 200;
    config.cast_interval_max = 100;
    assert!(config.validate().is_err());
}

#[test]
fn test_config_with_dry_run() {
    let config = FarcasterConfig::new(1, "s", "k").with_dry_run(true);
    assert!(config.dry_run);
    let config2 = config.with_dry_run(false);
    assert!(!config2.dry_run);
}

#[test]
fn test_config_with_mode() {
    let config = FarcasterConfig::new(1, "s", "k").with_mode(FarcasterMode::Webhook);
    assert_eq!(config.mode, FarcasterMode::Webhook);
}

#[test]
fn test_mode_parsing() {
    assert_eq!("polling".parse::<FarcasterMode>().unwrap(), FarcasterMode::Polling);
    assert_eq!("webhook".parse::<FarcasterMode>().unwrap(), FarcasterMode::Webhook);
    assert_eq!("POLLING".parse::<FarcasterMode>().unwrap(), FarcasterMode::Polling);
    assert!("invalid".parse::<FarcasterMode>().is_err());
}

#[test]
fn test_config_serialization() {
    let config = test_config();
    let json = serde_json::to_string(&config).unwrap();
    assert!(json.contains("12345"));
    assert!(json.contains("test-signer-uuid"));
    let deserialized: FarcasterConfig = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.fid, config.fid);
    assert_eq!(deserialized.signer_uuid, config.signer_uuid);
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Client Creation & split_post_content
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_client_creation() {
    let config = test_config();
    let client = FarcasterClient::new(config);
    assert!(client.is_ok());
}

#[test]
fn test_client_rejects_invalid_config() {
    let config = FarcasterConfig::new(0, "signer", "key");
    let client = FarcasterClient::new(config);
    assert!(client.is_err());
}

#[test]
fn test_split_post_content_short() {
    let chunks = split_post_content("Hello Farcaster!", 320);
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0], "Hello Farcaster!");
}

#[test]
fn test_split_post_content_long() {
    let text = "A".repeat(700);
    let chunks = split_post_content(&text, 320);
    assert!(chunks.len() > 1);
    for chunk in &chunks {
        assert!(chunk.len() <= 320);
    }
}

#[test]
fn test_split_post_content_paragraphs() {
    let text = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
    let chunks = split_post_content(text, 320);
    assert_eq!(chunks.len(), 1);
    assert!(chunks[0].contains("First paragraph."));
    assert!(chunks[0].contains("Second paragraph."));
}

#[test]
fn test_split_post_content_empty() {
    let chunks = split_post_content("", 320);
    assert!(chunks.is_empty());
}

#[test]
fn test_split_post_content_exact_boundary() {
    let text = "A".repeat(320);
    let chunks = split_post_content(&text, 320);
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].len(), 320);
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Type Definitions & Serialization
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_profile_creation() {
    let profile = Profile::new(12345, "testuser".to_string());
    assert_eq!(profile.fid, 12345);
    assert_eq!(profile.username, "testuser");
    assert!(profile.name.is_empty());
    assert!(profile.pfp.is_none());
    assert!(profile.bio.is_none());
    assert!(profile.url.is_none());
}

#[test]
fn test_profile_serialization() {
    let profile = Profile {
        fid: 42,
        name: "Alice".to_string(),
        username: "alice".to_string(),
        pfp: Some("https://example.com/pfp.png".to_string()),
        bio: Some("Hello world".to_string()),
        url: None,
    };
    let json = serde_json::to_string(&profile).unwrap();
    assert!(json.contains("\"fid\":42"));
    assert!(json.contains("\"username\":\"alice\""));
    assert!(json.contains("pfp"));
    assert!(!json.contains("url")); // skipped when None
    let deserialized: Profile = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.fid, 42);
    assert_eq!(deserialized.bio.as_deref(), Some("Hello world"));
}

#[test]
fn test_cast_is_reply() {
    let profile = Profile::new(1, "user".to_string());

    let cast = Cast {
        hash: "0xabc".to_string(),
        author_fid: 1,
        text: "Hello".to_string(),
        profile: profile.clone(),
        timestamp: chrono::Utc::now(),
        thread_id: None,
        in_reply_to: None,
        stats: None,
        embeds: vec![],
    };
    assert!(!cast.is_reply());
    assert_eq!(cast.message_type(), FarcasterMessageType::Cast);

    let reply = Cast {
        hash: "0xdef".to_string(),
        author_fid: 1,
        text: "Reply".to_string(),
        profile,
        timestamp: chrono::Utc::now(),
        thread_id: None,
        in_reply_to: Some(CastParent {
            hash: "0xabc".to_string(),
            fid: 2,
        }),
        stats: None,
        embeds: vec![],
    };
    assert!(reply.is_reply());
    assert_eq!(reply.message_type(), FarcasterMessageType::Reply);
}

#[test]
fn test_cast_serialization() {
    let cast = Cast {
        hash: "0x123".to_string(),
        author_fid: 100,
        text: "Test cast".to_string(),
        profile: Profile::new(100, "testuser".to_string()),
        timestamp: chrono::Utc::now(),
        thread_id: None,
        in_reply_to: None,
        stats: Some(CastStats {
            recasts: 5,
            replies: 10,
            likes: 42,
        }),
        embeds: vec![],
    };
    let json = serde_json::to_string(&cast).unwrap();
    assert!(json.contains("\"hash\":\"0x123\""));
    assert!(json.contains("\"author_fid\":100"));
    let deserialized: Cast = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.hash, "0x123");
    assert_eq!(
        deserialized.stats.as_ref().map(|s| s.likes),
        Some(42)
    );
}

#[test]
fn test_cast_id() {
    let id = CastId::new("0xabc", 99);
    assert_eq!(id.hash, "0xabc");
    assert_eq!(id.fid, 99);

    let json = serde_json::to_string(&id).unwrap();
    let deserialized: CastId = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.hash, "0xabc");
}

#[test]
fn test_fid_request() {
    let req = FidRequest::new(12345, 25);
    assert_eq!(req.fid, 12345);
    assert_eq!(req.page_size, 25);
}

#[test]
fn test_send_cast_params() {
    let params = SendCastParams::new("Hello!");
    assert_eq!(params.text, "Hello!");
    assert!(params.in_reply_to.is_none());

    let reply_params = SendCastParams::new("Reply!").with_reply_to("0xparent", 42);
    assert_eq!(reply_params.text, "Reply!");
    assert_eq!(reply_params.in_reply_to.as_ref().unwrap().hash, "0xparent");
    assert_eq!(reply_params.in_reply_to.as_ref().unwrap().fid, 42);
}

#[test]
fn test_last_cast() {
    let lc = LastCast {
        hash: "0xlast".to_string(),
        timestamp: 1234567890,
    };
    let json = serde_json::to_string(&lc).unwrap();
    let deserialized: LastCast = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.hash, "0xlast");
    assert_eq!(deserialized.timestamp, 1234567890);
}

#[test]
fn test_embed_type_serialization() {
    let types = vec![
        (EmbedType::Image, "\"image\""),
        (EmbedType::Video, "\"video\""),
        (EmbedType::Audio, "\"audio\""),
        (EmbedType::Url, "\"url\""),
        (EmbedType::Cast, "\"cast\""),
        (EmbedType::Frame, "\"frame\""),
        (EmbedType::Unknown, "\"unknown\""),
    ];
    for (embed_type, expected) in types {
        let json = serde_json::to_string(&embed_type).unwrap();
        assert_eq!(json, expected);
    }
}

#[test]
fn test_message_type_serialization() {
    let cast_type = FarcasterMessageType::Cast;
    let json = serde_json::to_string(&cast_type).unwrap();
    assert_eq!(json, "\"CAST\"");

    let reply_type = FarcasterMessageType::Reply;
    let json = serde_json::to_string(&reply_type).unwrap();
    assert_eq!(json, "\"REPLY\"");
}

#[test]
fn test_event_type_serialization() {
    let events = vec![
        (
            FarcasterEventType::CastGenerated,
            "\"FARCASTER_CAST_GENERATED\"",
        ),
        (
            FarcasterEventType::MentionReceived,
            "\"FARCASTER_MENTION_RECEIVED\"",
        ),
        (
            FarcasterEventType::ThreadCastCreated,
            "\"FARCASTER_THREAD_CAST_CREATED\"",
        ),
    ];
    for (event, expected) in events {
        let json = serde_json::to_string(&event).unwrap();
        assert_eq!(json, expected);
    }
}

#[test]
fn test_webhook_data_serialization() {
    let data = NeynarWebhookData {
        event_type: "cast.created".to_string(),
        data: Some(WebhookCastData {
            hash: "0xwhook".to_string(),
            text: Some("Hello from webhook".to_string()),
            author: Some(WebhookAuthor {
                fid: 42,
                username: Some("webhookuser".to_string()),
            }),
            mentioned_profiles: vec![],
            parent_hash: None,
            parent_author: None,
        }),
    };
    let json = serde_json::to_string(&data).unwrap();
    assert!(json.contains("cast.created"));
    assert!(json.contains("0xwhook"));
    let deserialized: NeynarWebhookData = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.event_type, "cast.created");
    assert_eq!(
        deserialized.data.as_ref().unwrap().hash,
        "0xwhook"
    );
}

#[test]
fn test_cast_embed_serialization() {
    let embed = CastEmbed {
        embed_type: EmbedType::Image,
        url: "https://example.com/img.png".to_string(),
        cast_hash: None,
        metadata: None,
    };
    let json = serde_json::to_string(&embed).unwrap();
    assert!(json.contains("\"type\":\"image\""));
    assert!(json.contains("img.png"));
}

#[test]
fn test_send_cast_response_serialization() {
    let resp = SendCastResponse {
        hash: "0xresphash".to_string(),
        author_fid: 42,
        text: "Response cast".to_string(),
        timestamp: chrono::Utc::now(),
        success: true,
    };
    let json = serde_json::to_string(&resp).unwrap();
    assert!(json.contains("\"success\":true"));
    let deserialized: SendCastResponse = serde_json::from_str(&json).unwrap();
    assert!(deserialized.success);
}

#[test]
fn test_timeline_response_serialization() {
    let resp = GetTimelineResponse {
        timeline: vec![],
        cursor: Some("next_page".to_string()),
        count: 0,
    };
    let json = serde_json::to_string(&resp).unwrap();
    assert!(json.contains("\"cursor\":\"next_page\""));
}

#[test]
fn test_mentions_response_serialization() {
    let resp = GetMentionsResponse {
        mentions: vec![],
        count: 0,
    };
    let json = serde_json::to_string(&resp).unwrap();
    assert!(json.contains("\"count\":0"));
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Error Types
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_error_config() {
    let err = FarcasterError::config("missing key");
    assert!(err.to_string().contains("missing key"));
    assert!(err.is_config());
    assert!(!err.is_rate_limit());
    assert!(!err.is_network());
}

#[test]
fn test_error_validation() {
    let err = FarcasterError::validation("bad value");
    assert!(err.to_string().contains("bad value"));
}

#[test]
fn test_error_api() {
    let err = FarcasterError::api("Not found", Some(404), Some("not_found".to_string()));
    assert!(err.to_string().contains("Not found"));
    assert!(err.to_string().contains("404"));
}

#[test]
fn test_error_rate_limit() {
    let err = FarcasterError::rate_limit(Some(60));
    assert!(err.is_rate_limit());
    assert!(err.to_string().contains("60"));
}

#[test]
fn test_error_rate_limit_none() {
    let err = FarcasterError::rate_limit(None);
    assert!(err.is_rate_limit());
}

#[test]
fn test_error_cast() {
    let err = FarcasterError::cast("publish failed");
    assert!(err.to_string().contains("publish failed"));
}

#[test]
fn test_error_profile() {
    let err = FarcasterError::profile("user not found");
    assert!(err.to_string().contains("user not found"));
}

#[test]
fn test_error_env() {
    let err = FarcasterError::env("var missing");
    assert!(err.to_string().contains("var missing"));
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. Service Lifecycle
// ═══════════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn test_service_creation() {
    let service = FarcasterService::new(test_config());
    assert!(!service.is_running().await);
    assert_eq!(service.fid(), 12345);
}

#[tokio::test]
async fn test_service_start_stop() {
    let service = FarcasterService::new(test_config());
    assert!(!service.is_running().await);

    service.start().await.unwrap();
    assert!(service.is_running().await);

    service.stop().await;
    assert!(!service.is_running().await);
}

#[tokio::test]
async fn test_service_double_start() {
    let service = FarcasterService::new(test_config());
    service.start().await.unwrap();
    // Second start should be a no-op
    service.start().await.unwrap();
    assert!(service.is_running().await);
    service.stop().await;
}

#[tokio::test]
async fn test_service_double_stop() {
    let service = FarcasterService::new(test_config());
    service.start().await.unwrap();
    service.stop().await;
    // Second stop should be a no-op
    service.stop().await;
    assert!(!service.is_running().await);
}

#[tokio::test]
async fn test_service_config_accessor() {
    let service = FarcasterService::new(test_config());
    let config = service.config();
    assert_eq!(config.fid, 12345);
    assert!(config.dry_run);
}

#[tokio::test]
async fn test_service_start_validates_config() {
    let bad_config = FarcasterConfig::new(0, "signer", "key");
    let service = FarcasterService::new(bad_config);
    let result = service.start().await;
    assert!(result.is_err());
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. Dry-run Cast Operations
// ═══════════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn test_send_cast_dry_run() {
    let config = test_config();
    let client = FarcasterClient::new(config).unwrap();
    let casts = client.send_cast("Hello Farcaster!", None).await.unwrap();
    assert_eq!(casts.len(), 1);
    assert_eq!(casts[0].hash, "dry_run_hash");
    assert_eq!(casts[0].text, "Hello Farcaster!");
    assert_eq!(casts[0].author_fid, 12345);
}

#[tokio::test]
async fn test_send_empty_cast() {
    let client = FarcasterClient::new(test_config()).unwrap();
    let casts = client.send_cast("", None).await.unwrap();
    assert!(casts.is_empty());
}

#[tokio::test]
async fn test_send_whitespace_cast() {
    let client = FarcasterClient::new(test_config()).unwrap();
    let casts = client.send_cast("   ", None).await.unwrap();
    assert!(casts.is_empty());
}

#[tokio::test]
async fn test_service_send_cast_dry_run() {
    let service = FarcasterService::new(test_config());
    service.start().await.unwrap();
    let casts = service.send_cast("Hello via service!", None).await.unwrap();
    assert_eq!(casts.len(), 1);
    assert_eq!(casts[0].text, "Hello via service!");
    service.stop().await;
}

#[tokio::test]
async fn test_service_send_cast_before_start() {
    let service = FarcasterService::new(test_config());
    let result = service.send_cast("Should fail", None).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_client_cache_clear() {
    let client = FarcasterClient::new(test_config()).unwrap();
    // Populate cache via dry-run send
    client.send_cast("cache test", None).await.unwrap();
    // clear_cache should not panic
    client.clear_cache();
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. SendCastAction
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_send_cast_action_metadata() {
    let action = SendCastAction::new();
    assert_eq!(action.name, "SEND_CAST");
    assert!(!action.description.is_empty());
    assert!(action.similes.contains(&"POST_CAST"));
    assert!(action.similes.contains(&"FARCASTER_POST"));
    assert!(action.similes.contains(&"CAST"));
    assert!(action.similes.contains(&"SHARE_ON_FARCASTER"));
    assert!(action.similes.contains(&"ANNOUNCE"));
    assert_eq!(action.similes.len(), 5);
}

#[test]
fn test_send_cast_action_examples() {
    let action = SendCastAction::new();
    assert_eq!(action.examples.len(), 2);
    for example_set in &action.examples {
        assert_eq!(example_set.len(), 2); // User + Agent
        assert_eq!(example_set[0].name, "User");
        assert_eq!(example_set[1].name, "Agent");
        assert!(example_set[0].content.contains_key("text"));
        assert!(example_set[1].content.contains_key("actions"));
    }
}

#[test]
fn test_send_cast_validate_keywords() {
    let action = SendCastAction::new();
    assert!(action.validate("post this on farcaster", true));
    assert!(action.validate("Please cast my message", true));
    assert!(action.validate("share this announcement", true));
    assert!(action.validate("I want to announce something", true));
    assert!(action.validate("use farcaster to say hi", true));
}

#[test]
fn test_send_cast_validate_no_keyword() {
    let action = SendCastAction::new();
    assert!(!action.validate("hello world", true));
    assert!(!action.validate("do something", true));
    assert!(!action.validate("", true));
}

#[test]
fn test_send_cast_validate_service_not_running() {
    let action = SendCastAction::new();
    assert!(!action.validate("post this on farcaster", false));
}

#[test]
fn test_send_cast_validate_case_insensitive() {
    let action = SendCastAction::new();
    assert!(action.validate("POST THIS ON FARCASTER", true));
    assert!(action.validate("Share This", true));
    assert!(action.validate("CaSt ThIs", true));
}

#[tokio::test]
async fn test_send_cast_execute_dry_run() {
    let action = SendCastAction::new();
    let service = FarcasterService::new(test_config());
    service.start().await.unwrap();

    let result = action.execute("Hello from action!", &service).await.unwrap();
    assert!(result.success);
    assert_eq!(result.text.as_deref(), Some("Cast posted successfully!"));
    assert_eq!(result.data.get("cast_hash").map(String::as_str), Some("dry_run_hash"));
    assert_eq!(result.data.get("text").map(String::as_str), Some("Hello from action!"));

    service.stop().await;
}

#[tokio::test]
async fn test_send_cast_execute_truncation() {
    let action = SendCastAction::new();
    let service = FarcasterService::new(test_config());
    service.start().await.unwrap();

    let long_text = "X".repeat(400);
    let result = action.execute(&long_text, &service).await.unwrap();
    assert!(result.success);
    let cast_text = result.data.get("text").unwrap();
    assert!(cast_text.len() <= 320);
    assert!(cast_text.ends_with("..."));

    service.stop().await;
}

#[tokio::test]
async fn test_send_cast_execute_service_not_running() {
    let action = SendCastAction::new();
    let service = FarcasterService::new(test_config());
    // Don't start the service
    let result = action.execute("Hello", &service).await.unwrap();
    assert!(!result.success);
    assert!(result.error.as_deref().unwrap().contains("not running"));
}

// ═══════════════════════════════════════════════════════════════════════════
// 9. ReplyCastAction
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_reply_cast_action_metadata() {
    let action = ReplyCastAction::new();
    assert_eq!(action.name, "REPLY_TO_CAST");
    assert!(!action.description.is_empty());
    assert!(action.similes.contains(&"REPLY_CAST"));
    assert!(action.similes.contains(&"RESPOND_CAST"));
    assert!(action.similes.contains(&"ANSWER_CAST"));
    assert!(action.similes.contains(&"COMMENT_CAST"));
    assert_eq!(action.similes.len(), 4);
}

#[test]
fn test_reply_cast_action_examples() {
    let action = ReplyCastAction::new();
    assert_eq!(action.examples.len(), 2);
    for example_set in &action.examples {
        assert_eq!(example_set.len(), 2);
        assert_eq!(example_set[0].name, "User");
        assert_eq!(example_set[1].name, "Agent");
    }
}

#[test]
fn test_reply_cast_validate_all_conditions() {
    let action = ReplyCastAction::new();
    assert!(action.validate("reply to this", Some("0xabc"), true));
    assert!(action.validate("respond to the thread", Some("0xdef"), true));
    assert!(action.validate("answer their question", Some("0x123"), true));
    assert!(action.validate("comment on this cast", Some("0x456"), true));
}

#[test]
fn test_reply_cast_validate_missing_parent() {
    let action = ReplyCastAction::new();
    assert!(!action.validate("reply to this", None, true));
}

#[test]
fn test_reply_cast_validate_service_not_running() {
    let action = ReplyCastAction::new();
    assert!(!action.validate("reply to this", Some("0xabc"), false));
}

#[test]
fn test_reply_cast_validate_no_keyword() {
    let action = ReplyCastAction::new();
    assert!(!action.validate("hello world", Some("0xabc"), true));
    assert!(!action.validate("", Some("0xabc"), true));
}

#[tokio::test]
async fn test_reply_cast_execute_dry_run() {
    let action = ReplyCastAction::new();
    let service = FarcasterService::new(test_config());
    service.start().await.unwrap();

    let result = action
        .execute("Great point!", "0xparenthash", &service)
        .await
        .unwrap();
    assert!(result.success);
    assert_eq!(result.text.as_deref(), Some("Reply posted successfully!"));
    assert_eq!(
        result.data.get("parent_hash").map(String::as_str),
        Some("0xparenthash")
    );
    assert_eq!(result.data.get("cast_hash").map(String::as_str), Some("dry_run_hash"));

    service.stop().await;
}

#[tokio::test]
async fn test_reply_cast_execute_truncation() {
    let action = ReplyCastAction::new();
    let service = FarcasterService::new(test_config());
    service.start().await.unwrap();

    let long_text = "R".repeat(400);
    let result = action.execute(&long_text, "0xparent", &service).await.unwrap();
    assert!(result.success);
    let cast_text = result.data.get("text").unwrap();
    assert!(cast_text.len() <= 320);
    assert!(cast_text.ends_with("..."));

    service.stop().await;
}

#[tokio::test]
async fn test_reply_cast_execute_service_not_running() {
    let action = ReplyCastAction::new();
    let service = FarcasterService::new(test_config());
    let result = action.execute("Reply", "0xparent", &service).await.unwrap();
    assert!(!result.success);
    assert!(result.error.as_deref().unwrap().contains("not running"));
}

// ═══════════════════════════════════════════════════════════════════════════
// 10. ActionResult
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_action_result_ok() {
    let mut data = std::collections::HashMap::new();
    data.insert("key".to_string(), "value".to_string());
    let result = ActionResult::ok("Success!", data);
    assert!(result.success);
    assert_eq!(result.text.as_deref(), Some("Success!"));
    assert!(result.error.is_none());
    assert_eq!(result.data.get("key").map(String::as_str), Some("value"));
}

#[test]
fn test_action_result_err() {
    let result = ActionResult::err("something failed");
    assert!(!result.success);
    assert!(result.text.is_none());
    assert_eq!(result.error.as_deref(), Some("something failed"));
    assert!(result.data.is_empty());
}

#[test]
fn test_action_result_serialization() {
    let result = ActionResult::ok("done", std::collections::HashMap::new());
    let json = serde_json::to_string(&result).unwrap();
    assert!(json.contains("\"success\":true"));
    assert!(json.contains("\"text\":\"done\""));
    let deserialized: ActionResult = serde_json::from_str(&json).unwrap();
    assert!(deserialized.success);
    assert_eq!(deserialized.text.as_deref(), Some("done"));
}

// ═══════════════════════════════════════════════════════════════════════════
// 11. all_action_names / all_provider_names
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_all_action_names() {
    let names = all_action_names();
    assert_eq!(names.len(), 2);
    assert_eq!(names[0].0, "SEND_CAST");
    assert_eq!(names[1].0, "REPLY_TO_CAST");
    // Descriptions should be non-empty
    for (_, desc) in &names {
        assert!(!desc.is_empty());
    }
}

#[test]
fn test_all_provider_names() {
    let names = all_provider_names();
    assert_eq!(names.len(), 3);
    assert_eq!(names[0].0, "farcaster_timeline");
    assert_eq!(names[1].0, "farcaster_thread");
    assert_eq!(names[2].0, "farcaster_profile");
    for (_, desc) in &names {
        assert!(!desc.is_empty());
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 12. Provider Constants & ProviderResult
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_timeline_provider_constants() {
    assert_eq!(TimelineProvider::NAME, "farcaster_timeline");
    assert_eq!(TimelineProvider::TS_NAME, "farcasterTimeline");
    assert!(!TimelineProvider::DESCRIPTION.is_empty());
}

#[test]
fn test_thread_provider_constants() {
    assert_eq!(ThreadProvider::NAME, "farcaster_thread");
    assert_eq!(ThreadProvider::TS_NAME, "farcasterThread");
    assert!(!ThreadProvider::DESCRIPTION.is_empty());
}

#[test]
fn test_profile_provider_constants() {
    assert_eq!(ProfileProvider::NAME, "farcaster_profile");
    assert_eq!(ProfileProvider::TS_NAME, "farcasterProfile");
    assert!(!ProfileProvider::DESCRIPTION.is_empty());
}

#[test]
fn test_provider_result_unavailable() {
    let result = ProviderResult::unavailable("not available");
    assert_eq!(result.text, "not available");
    assert_eq!(
        result.data.get("available"),
        Some(&serde_json::json!(false))
    );
    assert!(result.values.is_empty());
}

#[test]
fn test_provider_result_error() {
    let result = ProviderResult::error("failed", "details");
    assert_eq!(result.text, "failed");
    assert_eq!(
        result.data.get("available"),
        Some(&serde_json::json!(false))
    );
    assert_eq!(
        result.data.get("error"),
        Some(&serde_json::json!("details"))
    );
}

#[test]
fn test_provider_result_serialization() {
    let result = ProviderResult::unavailable("test");
    let json = serde_json::to_string(&result).unwrap();
    assert!(json.contains("\"text\":\"test\""));
    let deserialized: ProviderResult = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.text, "test");
}

// ═══════════════════════════════════════════════════════════════════════════
// 13. ActionExample serialization
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_action_example_serialization() {
    let example = ActionExample {
        name: "User".to_string(),
        content: std::collections::HashMap::from([
            ("text".to_string(), serde_json::json!("Post to farcaster")),
            ("source".to_string(), serde_json::json!("user")),
        ]),
    };
    let json = serde_json::to_string(&example).unwrap();
    assert!(json.contains("\"name\":\"User\""));
    assert!(json.contains("Post to farcaster"));
    let deserialized: ActionExample = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.name, "User");
}

// ═══════════════════════════════════════════════════════════════════════════
// 14. Defaults module
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_defaults() {
    use elizaos_plugin_farcaster::defaults;
    assert_eq!(defaults::MAX_CAST_LENGTH, 320);
    assert_eq!(defaults::POLL_INTERVAL, 120);
    assert_eq!(defaults::CAST_INTERVAL_MIN, 90);
    assert_eq!(defaults::CAST_INTERVAL_MAX, 180);
    assert_eq!(defaults::CAST_CACHE_TTL, 1000 * 30 * 60);
    assert_eq!(defaults::CAST_CACHE_SIZE, 9000);
}
