//! Comprehensive integration tests for the Zalo OA plugin (Rust).
//!
//! Covers:
//! - Plugin metadata
//! - Config creation, builder pattern, validation, defaults
//! - Error variants and Display
//! - Type construction and serde roundtrip
//! - Action metadata, validate, execute (SendMessageAction)
//! - Provider metadata and get() (ChatStateProvider)

use elizaos_plugin_zalo::config::{
    ZaloConfig, DEFAULT_WEBHOOK_PATH, DEFAULT_WEBHOOK_PORT,
};
use elizaos_plugin_zalo::error::ZaloError;
use elizaos_plugin_zalo::types::*;
use elizaos_plugin_zalo::{plugin, PLUGIN_DESCRIPTION, PLUGIN_NAME, PLUGIN_VERSION};

// ── Plugin metadata ───────────────────────────────────────────────

#[test]
fn plugin_name_is_zalo() {
    assert_eq!(PLUGIN_NAME, "zalo");
}

#[test]
fn plugin_description_is_nonempty() {
    assert!(!PLUGIN_DESCRIPTION.is_empty());
}

#[test]
fn plugin_version_is_semver() {
    let parts: Vec<&str> = PLUGIN_VERSION.split('.').collect();
    assert!(parts.len() >= 2, "version should be semver: {}", PLUGIN_VERSION);
}

#[test]
fn plugin_fn_returns_correct_metadata() {
    let p = plugin();
    assert_eq!(p.name, PLUGIN_NAME);
    assert_eq!(p.description, PLUGIN_DESCRIPTION);
    assert_eq!(p.version, PLUGIN_VERSION);
}

// ── Config creation ───────────────────────────────────────────────

#[test]
fn config_new_sets_required_fields() {
    let c = ZaloConfig::new("app".into(), "sec".into(), "tok".into());
    assert_eq!(c.app_id, "app");
    assert_eq!(c.secret_key, "sec");
    assert_eq!(c.access_token, "tok");
}

#[test]
fn config_new_defaults_enabled_true() {
    let c = ZaloConfig::new("a".into(), "b".into(), "c".into());
    assert!(c.enabled);
}

#[test]
fn config_new_defaults_use_polling_false() {
    let c = ZaloConfig::new("a".into(), "b".into(), "c".into());
    assert!(!c.use_polling);
}

#[test]
fn config_new_defaults_webhook_path() {
    let c = ZaloConfig::new("a".into(), "b".into(), "c".into());
    assert_eq!(c.effective_webhook_path(), DEFAULT_WEBHOOK_PATH);
}

#[test]
fn config_new_defaults_webhook_port() {
    let c = ZaloConfig::new("a".into(), "b".into(), "c".into());
    assert_eq!(c.effective_webhook_port(), DEFAULT_WEBHOOK_PORT);
}

#[test]
fn config_optional_fields_are_none() {
    let c = ZaloConfig::new("a".into(), "b".into(), "c".into());
    assert!(c.refresh_token.is_none());
    assert!(c.webhook_url.is_none());
    assert!(c.proxy_url.is_none());
}

// ── Config builder pattern ────────────────────────────────────────

#[test]
fn config_with_refresh_token() {
    let c = ZaloConfig::new("a".into(), "b".into(), "c".into())
        .with_refresh_token("rt".to_string());
    assert_eq!(c.refresh_token, Some("rt".to_string()));
}

#[test]
fn config_with_webhook_url() {
    let c = ZaloConfig::new("a".into(), "b".into(), "c".into())
        .with_webhook_url("https://example.com".to_string());
    assert_eq!(c.webhook_url, Some("https://example.com".to_string()));
}

#[test]
fn config_with_webhook_path() {
    let c = ZaloConfig::new("a".into(), "b".into(), "c".into())
        .with_webhook_path("/custom".to_string());
    assert_eq!(c.effective_webhook_path(), "/custom");
}

#[test]
fn config_with_webhook_port() {
    let c = ZaloConfig::new("a".into(), "b".into(), "c".into())
        .with_webhook_port(8443);
    assert_eq!(c.effective_webhook_port(), 8443);
}

#[test]
fn config_with_polling() {
    let c = ZaloConfig::new("a".into(), "b".into(), "c".into())
        .with_polling(true);
    assert!(c.use_polling);
    assert_eq!(c.update_mode(), "polling");
}

#[test]
fn config_with_enabled() {
    let c = ZaloConfig::new("a".into(), "b".into(), "c".into())
        .with_enabled(false);
    assert!(!c.enabled);
}

#[test]
fn config_with_proxy_url() {
    let c = ZaloConfig::new("a".into(), "b".into(), "c".into())
        .with_proxy_url("http://proxy:8080".to_string());
    assert_eq!(c.proxy_url, Some("http://proxy:8080".to_string()));
}

#[test]
fn config_chained_builders() {
    let c = ZaloConfig::new("a".into(), "b".into(), "c".into())
        .with_webhook_url("https://hook.io".to_string())
        .with_webhook_port(9000)
        .with_polling(false)
        .with_enabled(true);
    assert_eq!(c.webhook_url, Some("https://hook.io".to_string()));
    assert_eq!(c.effective_webhook_port(), 9000);
    assert!(!c.use_polling);
    assert!(c.enabled);
}

// ── Config update_mode ────────────────────────────────────────────

#[test]
fn config_update_mode_webhook() {
    let c = ZaloConfig::new("a".into(), "b".into(), "c".into());
    assert_eq!(c.update_mode(), "webhook");
}

#[test]
fn config_update_mode_polling() {
    let c = ZaloConfig::new("a".into(), "b".into(), "c".into())
        .with_polling(true);
    assert_eq!(c.update_mode(), "polling");
}

// ── Config validation ─────────────────────────────────────────────

#[test]
fn config_validate_valid_polling() {
    let c = ZaloConfig::new("a".into(), "b".into(), "c".into())
        .with_polling(true);
    assert!(c.validate().is_ok());
}

#[test]
fn config_validate_valid_webhook() {
    let c = ZaloConfig::new("a".into(), "b".into(), "c".into())
        .with_webhook_url("https://example.com".to_string());
    assert!(c.validate().is_ok());
}

#[test]
fn config_validate_empty_app_id() {
    let c = ZaloConfig::new("".into(), "b".into(), "c".into());
    assert!(c.validate().is_err());
}

#[test]
fn config_validate_empty_secret_key() {
    let c = ZaloConfig::new("a".into(), "".into(), "c".into());
    assert!(c.validate().is_err());
}

#[test]
fn config_validate_empty_access_token() {
    let c = ZaloConfig::new("a".into(), "b".into(), "".into());
    assert!(c.validate().is_err());
}

#[test]
fn config_validate_webhook_without_url() {
    let c = ZaloConfig::new("a".into(), "b".into(), "c".into());
    // use_polling=false (default) and no webhook_url
    assert!(c.validate().is_err());
}

// ── Config serde ──────────────────────────────────────────────────

#[test]
fn config_serde_roundtrip() {
    let c = ZaloConfig::new("app".into(), "sec".into(), "tok".into())
        .with_webhook_url("https://hook.com".into())
        .with_polling(true);
    let json = serde_json::to_string(&c).expect("serialize");
    let c2: ZaloConfig = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(c.app_id, c2.app_id);
    assert_eq!(c.use_polling, c2.use_polling);
}

// ── Error variants ────────────────────────────────────────────────

#[test]
fn error_config_display() {
    let e = ZaloError::ConfigError("bad".to_string());
    assert!(e.to_string().contains("bad"));
}

#[test]
fn error_missing_setting_display() {
    let e = ZaloError::MissingSetting("ZALO_APP_ID".to_string());
    assert!(e.to_string().contains("ZALO_APP_ID"));
}

#[test]
fn error_api_display() {
    let e = ZaloError::ApiError("rate limited".to_string());
    assert!(e.to_string().contains("rate limited"));
}

#[test]
fn error_client_not_initialized_display() {
    let e = ZaloError::ClientNotInitialized;
    assert!(e.to_string().contains("not initialized"));
}

#[test]
fn error_already_running_display() {
    let e = ZaloError::AlreadyRunning;
    assert!(e.to_string().contains("already running"));
}

#[test]
fn error_user_not_found_display() {
    let e = ZaloError::UserNotFound("u-99".to_string());
    assert!(e.to_string().contains("u-99"));
}

#[test]
fn error_message_send_failed_display() {
    let e = ZaloError::MessageSendFailed("timeout".to_string());
    assert!(e.to_string().contains("timeout"));
}

#[test]
fn error_token_refresh_failed_display() {
    let e = ZaloError::TokenRefreshFailed("expired".to_string());
    assert!(e.to_string().contains("expired"));
}

#[test]
fn error_invalid_argument_display() {
    let e = ZaloError::InvalidArgument("empty text".to_string());
    assert!(e.to_string().contains("empty text"));
}

#[test]
fn error_connection_failed_display() {
    let e = ZaloError::ConnectionFailed("dns".to_string());
    assert!(e.to_string().contains("dns"));
}

// ── Type construction ─────────────────────────────────────────────

#[test]
fn zalo_event_type_display_all() {
    let cases = vec![
        (ZaloEventType::BotStarted, "ZALO_BOT_STARTED"),
        (ZaloEventType::BotStopped, "ZALO_BOT_STOPPED"),
        (ZaloEventType::MessageReceived, "ZALO_MESSAGE_RECEIVED"),
        (ZaloEventType::MessageSent, "ZALO_MESSAGE_SENT"),
        (ZaloEventType::WebhookRegistered, "ZALO_WEBHOOK_REGISTERED"),
        (ZaloEventType::UserFollowed, "ZALO_USER_FOLLOWED"),
        (ZaloEventType::UserUnfollowed, "ZALO_USER_UNFOLLOWED"),
        (ZaloEventType::TokenRefreshed, "ZALO_TOKEN_REFRESHED"),
    ];
    for (variant, expected) in cases {
        assert_eq!(variant.to_string(), expected);
    }
}

#[test]
fn zalo_user_display_name_with_name() {
    let u = ZaloUser {
        id: "123".into(),
        name: Some("Alice".into()),
        avatar: None,
    };
    assert_eq!(u.display_name(), "Alice");
}

#[test]
fn zalo_user_display_name_fallback() {
    let u = ZaloUser {
        id: "123".into(),
        name: None,
        avatar: None,
    };
    assert_eq!(u.display_name(), "123");
}

#[test]
fn zalo_chat_default() {
    let c = ZaloChat::default();
    assert_eq!(c.chat_type, "PRIVATE");
    assert!(c.id.is_empty());
}

#[test]
fn zalo_message_construction() {
    let m = ZaloMessage {
        message_id: "m1".into(),
        from: ZaloUser { id: "u1".into(), name: None, avatar: None },
        chat: ZaloChat::default(),
        date: 1700000000,
        text: Some("hi".into()),
        photo: None,
        caption: None,
        sticker: None,
    };
    assert_eq!(m.message_id, "m1");
    assert_eq!(m.text, Some("hi".into()));
}

#[test]
fn zalo_oa_info_construction() {
    let oa = ZaloOAInfo {
        oa_id: "oa1".into(),
        name: "Test OA".into(),
        description: None,
        avatar: None,
        cover: None,
    };
    assert_eq!(oa.oa_id, "oa1");
    assert!(oa.description.is_none());
}

#[test]
fn zalo_bot_probe_success() {
    let p = ZaloBotProbe {
        ok: true,
        oa: Some(ZaloOAInfo {
            oa_id: "oa".into(),
            name: "OA".into(),
            description: None,
            avatar: None,
            cover: None,
        }),
        error: None,
        latency_ms: 42,
    };
    assert!(p.ok);
    assert!(p.oa.is_some());
}

#[test]
fn zalo_bot_probe_failure() {
    let p = ZaloBotProbe {
        ok: false,
        oa: None,
        error: Some("timeout".into()),
        latency_ms: 5000,
    };
    assert!(!p.ok);
    assert_eq!(p.error, Some("timeout".into()));
}

#[test]
fn zalo_settings_default() {
    let s = ZaloSettings::default();
    assert!(s.app_id.is_empty());
    assert!(!s.enabled);
}

// ── Type serde roundtrip ──────────────────────────────────────────

#[test]
fn zalo_user_serde_roundtrip() {
    let u = ZaloUser {
        id: "u1".into(),
        name: Some("Alice".into()),
        avatar: Some("https://avatar.jpg".into()),
    };
    let json = serde_json::to_string(&u).unwrap();
    let u2: ZaloUser = serde_json::from_str(&json).unwrap();
    assert_eq!(u.id, u2.id);
    assert_eq!(u.name, u2.name);
}

#[test]
fn zalo_oa_info_serde_roundtrip() {
    let oa = ZaloOAInfo {
        oa_id: "oa1".into(),
        name: "Test".into(),
        description: Some("desc".into()),
        avatar: None,
        cover: None,
    };
    let json = serde_json::to_string(&oa).unwrap();
    let oa2: ZaloOAInfo = serde_json::from_str(&json).unwrap();
    assert_eq!(oa.oa_id, oa2.oa_id);
    assert_eq!(oa.description, oa2.description);
}

#[test]
fn zalo_send_message_params_serde() {
    let p = ZaloSendMessageParams {
        user_id: "u1".into(),
        text: "hi".into(),
    };
    let json = serde_json::to_string(&p).unwrap();
    let p2: ZaloSendMessageParams = serde_json::from_str(&json).unwrap();
    assert_eq!(p.user_id, p2.user_id);
}

#[test]
fn zalo_send_image_params_serde() {
    let p = ZaloSendImageParams {
        user_id: "u1".into(),
        image_url: "https://img.jpg".into(),
        caption: Some("cap".into()),
    };
    let json = serde_json::to_string(&p).unwrap();
    let p2: ZaloSendImageParams = serde_json::from_str(&json).unwrap();
    assert_eq!(p.caption, p2.caption);
}

#[test]
fn zalo_bot_status_payload_serde() {
    let p = ZaloBotStatusPayload {
        oa_id: Some("oa1".into()),
        oa_name: Some("Test".into()),
        update_mode: "webhook".into(),
        timestamp: 12345,
    };
    let json = serde_json::to_string(&p).unwrap();
    let p2: ZaloBotStatusPayload = serde_json::from_str(&json).unwrap();
    assert_eq!(p.update_mode, p2.update_mode);
}

#[test]
fn zalo_follow_payload_serde() {
    let p = ZaloFollowPayload {
        user_id: "u1".into(),
        action: "follow".into(),
        timestamp: 100,
    };
    let json = serde_json::to_string(&p).unwrap();
    let p2: ZaloFollowPayload = serde_json::from_str(&json).unwrap();
    assert_eq!(p.action, p2.action);
}

// ── Actions (SendMessageAction) ───────────────────────────────────

#[cfg(feature = "native")]
mod action_tests {
    use elizaos_plugin_zalo::actions::{
        builtin_actions, ActionContext, SendMessageAction, ZaloAction,
    };

    #[test]
    fn send_message_action_name() {
        let a = SendMessageAction;
        assert_eq!(a.name(), "SEND_ZALO_MESSAGE");
    }

    #[test]
    fn send_message_action_description_nonempty() {
        let a = SendMessageAction;
        assert!(!a.description().is_empty());
    }

    #[tokio::test]
    async fn send_message_validate_zalo_source() {
        let a = SendMessageAction;
        let ctx = ActionContext {
            message: serde_json::json!({"source": "zalo"}),
            user_id: "u1".to_string(),
            state: serde_json::json!({}),
        };
        assert!(a.validate(&ctx).await.unwrap());
    }

    #[tokio::test]
    async fn send_message_validate_non_zalo_source() {
        let a = SendMessageAction;
        let ctx = ActionContext {
            message: serde_json::json!({"source": "telegram"}),
            user_id: "u1".to_string(),
            state: serde_json::json!({}),
        };
        assert!(!a.validate(&ctx).await.unwrap());
    }

    #[tokio::test]
    async fn send_message_validate_missing_source() {
        let a = SendMessageAction;
        let ctx = ActionContext {
            message: serde_json::json!({"text": "hello"}),
            user_id: "u1".to_string(),
            state: serde_json::json!({}),
        };
        assert!(!a.validate(&ctx).await.unwrap());
    }

    #[tokio::test]
    async fn send_message_execute_returns_action_name() {
        let a = SendMessageAction;
        let ctx = ActionContext {
            message: serde_json::json!({"source": "zalo"}),
            user_id: "user-42".to_string(),
            state: serde_json::json!({
                "response": {"text": "Bot reply"}
            }),
        };
        let result = a.execute(&ctx).await.unwrap();
        assert_eq!(result["action"], "SEND_ZALO_MESSAGE");
        assert_eq!(result["user_id"], "user-42");
        assert_eq!(result["text"], "Bot reply");
    }

    #[tokio::test]
    async fn send_message_execute_empty_response() {
        let a = SendMessageAction;
        let ctx = ActionContext {
            message: serde_json::json!({"source": "zalo"}),
            user_id: "u1".to_string(),
            state: serde_json::json!({}),
        };
        let result = a.execute(&ctx).await.unwrap();
        assert_eq!(result["text"], "");
    }

    #[test]
    fn builtin_actions_includes_send_message() {
        let actions = builtin_actions();
        assert!(!actions.is_empty());
        assert_eq!(actions[0].name(), "SEND_ZALO_MESSAGE");
    }
}

// ── Providers (ChatStateProvider) ─────────────────────────────────

#[cfg(feature = "native")]
mod provider_tests {
    use elizaos_plugin_zalo::providers::{
        builtin_providers, ChatStateProvider, ProviderContext, ZaloProvider,
    };

    #[test]
    fn chat_state_provider_name() {
        let p = ChatStateProvider;
        assert_eq!(p.name(), "zalo_chat_state");
    }

    #[tokio::test]
    async fn chat_state_with_user() {
        let p = ChatStateProvider;
        let ctx = ProviderContext {
            user_id: Some("u1".to_string()),
            room_id: Some("room1".to_string()),
        };
        let state = p.get(&ctx).await;
        assert_eq!(state["user_id"], "u1");
        assert_eq!(state["platform"], "zalo");
        assert_eq!(state["is_private"], true);
    }

    #[tokio::test]
    async fn chat_state_empty_context() {
        let p = ChatStateProvider;
        let ctx = ProviderContext::default();
        let state = p.get(&ctx).await;
        assert!(state["user_id"].is_null());
        assert_eq!(state["platform"], "zalo");
    }

    #[test]
    fn builtin_providers_includes_chat_state() {
        let providers = builtin_providers();
        assert!(!providers.is_empty());
        assert_eq!(providers[0].name(), "zalo_chat_state");
    }
}
