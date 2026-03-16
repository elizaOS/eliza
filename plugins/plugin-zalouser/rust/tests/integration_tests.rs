//! Comprehensive integration tests for the Zalo User plugin (Rust).
//!
//! Covers:
//! - Plugin metadata
//! - Config creation, defaults, validation, is_thread_allowed, to_settings
//! - Error variants and Display
//! - Type construction and serde roundtrip
//! - Action metadata (SendMessage - only action in Rust)
//! - Provider metadata and get()

use elizaos_plugin_zalouser::config::{
    ZaloUserConfig, DEFAULT_PROFILE, DEFAULT_TIMEOUT_MS, MAX_MESSAGE_LENGTH, ZCA_BINARY,
};
use elizaos_plugin_zalouser::error::ZaloUserError;
use elizaos_plugin_zalouser::types::*;
use elizaos_plugin_zalouser::{plugin, PLUGIN_DESCRIPTION, PLUGIN_NAME, PLUGIN_VERSION};

// ── Plugin metadata ───────────────────────────────────────────────

#[test]
fn plugin_name_is_zalouser() {
    assert_eq!(PLUGIN_NAME, "zalouser");
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

// ── Constants ─────────────────────────────────────────────────────

#[test]
fn constant_default_profile() {
    assert_eq!(DEFAULT_PROFILE, "default");
}

#[test]
fn constant_default_timeout() {
    assert_eq!(DEFAULT_TIMEOUT_MS, 30000);
}

#[test]
fn constant_max_message_length() {
    assert_eq!(MAX_MESSAGE_LENGTH, 2000);
}

#[test]
fn constant_zca_binary() {
    assert_eq!(ZCA_BINARY, "zca");
}

// ── Config creation & defaults ────────────────────────────────────

#[test]
fn config_default_enabled() {
    let c = ZaloUserConfig::default();
    assert!(c.enabled);
}

#[test]
fn config_default_profile() {
    let c = ZaloUserConfig::default();
    assert_eq!(c.default_profile, DEFAULT_PROFILE);
}

#[test]
fn config_default_listen_timeout() {
    let c = ZaloUserConfig::default();
    assert_eq!(c.listen_timeout, DEFAULT_TIMEOUT_MS);
}

#[test]
fn config_default_dm_policy() {
    let c = ZaloUserConfig::default();
    assert_eq!(c.dm_policy, "pairing");
}

#[test]
fn config_default_group_policy() {
    let c = ZaloUserConfig::default();
    assert_eq!(c.group_policy, "disabled");
}

#[test]
fn config_default_allowed_threads_empty() {
    let c = ZaloUserConfig::default();
    assert!(c.allowed_threads.is_empty());
}

#[test]
fn config_default_optional_fields_none() {
    let c = ZaloUserConfig::default();
    assert!(c.cookie_path.is_none());
    assert!(c.imei.is_none());
    assert!(c.user_agent.is_none());
}

#[test]
fn config_new_with_profile() {
    let c = ZaloUserConfig::new("work".to_string());
    assert_eq!(c.default_profile, "work");
    assert!(c.enabled); // other defaults preserved
}

// ── Config validation ─────────────────────────────────────────────

#[test]
fn config_validate_valid_default() {
    let c = ZaloUserConfig::default();
    assert!(c.validate().is_ok());
}

#[test]
fn config_validate_disabled() {
    let c = ZaloUserConfig {
        enabled: false,
        ..Default::default()
    };
    assert!(c.validate().is_err());
}

#[test]
fn config_validate_invalid_dm_policy() {
    let c = ZaloUserConfig {
        dm_policy: "invalid".to_string(),
        ..Default::default()
    };
    assert!(c.validate().is_err());
}

#[test]
fn config_validate_invalid_group_policy() {
    let c = ZaloUserConfig {
        group_policy: "invalid".to_string(),
        ..Default::default()
    };
    assert!(c.validate().is_err());
}

#[test]
fn config_validate_all_valid_dm_policies() {
    for policy in &["open", "allowlist", "pairing", "disabled"] {
        let c = ZaloUserConfig {
            dm_policy: policy.to_string(),
            ..Default::default()
        };
        assert!(c.validate().is_ok(), "policy '{}' should be valid", policy);
    }
}

#[test]
fn config_validate_all_valid_group_policies() {
    for policy in &["open", "allowlist", "disabled"] {
        let c = ZaloUserConfig {
            group_policy: policy.to_string(),
            ..Default::default()
        };
        assert!(c.validate().is_ok(), "policy '{}' should be valid", policy);
    }
}

// ── Config is_thread_allowed ──────────────────────────────────────

#[test]
fn config_empty_allows_all() {
    let c = ZaloUserConfig::default();
    assert!(c.is_thread_allowed("any"));
}

#[test]
fn config_allowed_thread() {
    let c = ZaloUserConfig {
        allowed_threads: vec!["t1".to_string(), "t2".to_string()],
        ..Default::default()
    };
    assert!(c.is_thread_allowed("t1"));
    assert!(c.is_thread_allowed("t2"));
}

#[test]
fn config_disallowed_thread() {
    let c = ZaloUserConfig {
        allowed_threads: vec!["t1".to_string()],
        ..Default::default()
    };
    assert!(!c.is_thread_allowed("t3"));
}

// ── Config to_settings ────────────────────────────────────────────

#[test]
fn config_to_settings_preserves_values() {
    let c = ZaloUserConfig {
        cookie_path: Some("/tmp/cookie".to_string()),
        dm_policy: "open".to_string(),
        group_policy: "allowlist".to_string(),
        allowed_threads: vec!["t1".to_string()],
        ..Default::default()
    };
    let s = c.to_settings();
    assert_eq!(s.cookie_path, Some("/tmp/cookie".to_string()));
    assert_eq!(s.dm_policy, "open");
    assert_eq!(s.group_policy, "allowlist");
    assert_eq!(s.allowed_threads, vec!["t1"]);
}

// ── Error variants ────────────────────────────────────────────────

#[test]
fn error_zca_not_installed() {
    let e = ZaloUserError::ZcaNotInstalled;
    let s = e.to_string();
    assert!(s.contains("zca-cli"));
    assert!(s.contains("npm install"));
}

#[test]
fn error_not_authenticated() {
    let e = ZaloUserError::NotAuthenticated;
    assert!(e.to_string().contains("Not authenticated"));
}

#[test]
fn error_invalid_config() {
    let e = ZaloUserError::InvalidConfig("bad field".to_string());
    assert!(e.to_string().contains("bad field"));
}

#[test]
fn error_already_running() {
    let e = ZaloUserError::AlreadyRunning;
    assert!(e.to_string().contains("already running"));
}

#[test]
fn error_not_running() {
    let e = ZaloUserError::NotRunning;
    assert!(e.to_string().contains("not running"));
}

#[test]
fn error_client_not_initialized() {
    let e = ZaloUserError::ClientNotInitialized;
    assert!(e.to_string().contains("not initialized"));
}

#[test]
fn error_connection_failed() {
    let e = ZaloUserError::ConnectionFailed("dns".to_string());
    assert!(e.to_string().contains("dns"));
}

#[test]
fn error_command_failed() {
    let e = ZaloUserError::CommandFailed("segfault".to_string());
    assert!(e.to_string().contains("segfault"));
}

#[test]
fn error_timeout() {
    let e = ZaloUserError::Timeout(30000);
    assert!(e.to_string().contains("30000"));
}

#[test]
fn error_api_error() {
    let e = ZaloUserError::ApiError("rate limit".to_string());
    assert!(e.to_string().contains("rate limit"));
}

#[test]
fn error_send_failed() {
    let e = ZaloUserError::SendFailed("network".to_string());
    assert!(e.to_string().contains("network"));
}

#[test]
fn error_chat_not_found() {
    let e = ZaloUserError::ChatNotFound("t-42".to_string());
    assert!(e.to_string().contains("t-42"));
}

#[test]
fn error_user_not_found() {
    let e = ZaloUserError::UserNotFound("u-99".to_string());
    assert!(e.to_string().contains("u-99"));
}

#[test]
fn error_invalid_argument() {
    let e = ZaloUserError::InvalidArgument("empty".to_string());
    assert!(e.to_string().contains("empty"));
}

// ── Type construction ─────────────────────────────────────────────

#[test]
fn event_type_display_all() {
    let cases = vec![
        (ZaloUserEventType::WorldJoined, "ZALOUSER_WORLD_JOINED"),
        (ZaloUserEventType::WorldConnected, "ZALOUSER_WORLD_CONNECTED"),
        (ZaloUserEventType::WorldLeft, "ZALOUSER_WORLD_LEFT"),
        (ZaloUserEventType::EntityJoined, "ZALOUSER_ENTITY_JOINED"),
        (ZaloUserEventType::EntityLeft, "ZALOUSER_ENTITY_LEFT"),
        (ZaloUserEventType::EntityUpdated, "ZALOUSER_ENTITY_UPDATED"),
        (ZaloUserEventType::MessageReceived, "ZALOUSER_MESSAGE_RECEIVED"),
        (ZaloUserEventType::MessageSent, "ZALOUSER_MESSAGE_SENT"),
        (ZaloUserEventType::ReactionReceived, "ZALOUSER_REACTION_RECEIVED"),
        (ZaloUserEventType::ReactionSent, "ZALOUSER_REACTION_SENT"),
        (ZaloUserEventType::QrCodeReady, "ZALOUSER_QR_CODE_READY"),
        (ZaloUserEventType::LoginSuccess, "ZALOUSER_LOGIN_SUCCESS"),
        (ZaloUserEventType::LoginFailed, "ZALOUSER_LOGIN_FAILED"),
        (ZaloUserEventType::ClientStarted, "ZALOUSER_CLIENT_STARTED"),
        (ZaloUserEventType::ClientStopped, "ZALOUSER_CLIENT_STOPPED"),
    ];
    for (variant, expected) in cases {
        assert_eq!(variant.to_string(), expected);
    }
}

#[test]
fn chat_type_display() {
    assert_eq!(ZaloUserChatType::Private.to_string(), "private");
    assert_eq!(ZaloUserChatType::Group.to_string(), "group");
}

#[test]
fn zalo_user_name() {
    let u = ZaloUser {
        id: "123".into(),
        display_name: "Alice".into(),
        username: None,
        avatar: None,
        is_self: false,
    };
    assert_eq!(u.name(), "Alice");
}

#[test]
fn zalo_chat_display_name_with_name() {
    let c = ZaloChat {
        thread_id: "t1".into(),
        chat_type: ZaloUserChatType::Group,
        name: Some("My Group".into()),
        avatar: None,
        member_count: Some(5),
        is_group: true,
    };
    assert_eq!(c.display_name(), "My Group");
}

#[test]
fn zalo_chat_display_name_fallback() {
    let c = ZaloChat {
        thread_id: "t1".into(),
        chat_type: ZaloUserChatType::Private,
        name: None,
        avatar: None,
        member_count: None,
        is_group: false,
    };
    assert_eq!(c.display_name(), "t1");
}

#[test]
fn zalo_friend_construction() {
    let f = ZaloFriend {
        user_id: "f1".into(),
        display_name: "Bob".into(),
        avatar: None,
        phone_number: Some("09123".into()),
    };
    assert_eq!(f.user_id, "f1");
    assert_eq!(f.phone_number, Some("09123".into()));
}

#[test]
fn zalo_group_construction() {
    let g = ZaloGroup {
        group_id: "g1".into(),
        name: "Group A".into(),
        member_count: Some(42),
        avatar: None,
    };
    assert_eq!(g.group_id, "g1");
    assert_eq!(g.member_count, Some(42));
}

#[test]
fn zalo_message_construction() {
    let m = ZaloMessage {
        msg_id: Some("m1".into()),
        cli_msg_id: None,
        thread_id: "t1".into(),
        message_type: 0,
        content: "Hello".into(),
        timestamp: 1700000000,
        metadata: None,
    };
    assert_eq!(m.content, "Hello");
    assert!(m.metadata.is_none());
}

#[test]
fn zalo_message_with_metadata() {
    let meta = ZaloMessageMetadata {
        is_group: true,
        thread_name: Some("Group".into()),
        sender_name: Some("Alice".into()),
        sender_id: Some("u1".into()),
    };
    let m = ZaloMessage {
        msg_id: None,
        cli_msg_id: None,
        thread_id: "t1".into(),
        message_type: 0,
        content: "Hi".into(),
        timestamp: 100,
        metadata: Some(meta),
    };
    assert!(m.metadata.as_ref().unwrap().is_group);
}

#[test]
fn zalo_user_info_construction() {
    let info = ZaloUserInfo {
        user_id: "u1".into(),
        display_name: "Alice".into(),
        avatar: None,
        phone_number: None,
    };
    assert_eq!(info.user_id, "u1");
}

#[test]
fn zalo_user_probe_success() {
    let p = ZaloUserProbe {
        ok: true,
        user: Some(ZaloUser {
            id: "u1".into(),
            display_name: "Alice".into(),
            username: None,
            avatar: None,
            is_self: false,
        }),
        error: None,
        latency_ms: 42,
    };
    assert!(p.ok);
    assert!(p.user.is_some());
}

#[test]
fn zalo_user_probe_failure() {
    let p = ZaloUserProbe {
        ok: false,
        user: None,
        error: Some("timeout".into()),
        latency_ms: 5000,
    };
    assert!(!p.ok);
    assert_eq!(p.error, Some("timeout".into()));
}

#[test]
fn zalo_user_settings_default() {
    let s = ZaloUserSettings::default();
    assert!(s.enabled);
    assert_eq!(s.default_profile, "default");
    assert_eq!(s.listen_timeout, 30000);
    assert_eq!(s.dm_policy, "pairing");
    assert_eq!(s.group_policy, "disabled");
}

#[test]
fn send_message_params_construction() {
    let p = SendMessageParams {
        thread_id: "t1".into(),
        text: "Hello".into(),
        is_group: false,
        profile: None,
    };
    assert_eq!(p.thread_id, "t1");
    assert!(!p.is_group);
}

#[test]
fn send_message_result_success() {
    let r = SendMessageResult {
        success: true,
        thread_id: "t1".into(),
        message_id: Some("m1".into()),
        error: None,
    };
    assert!(r.success);
    assert_eq!(r.message_id, Some("m1".into()));
}

#[test]
fn send_media_params_construction() {
    let p = SendMediaParams {
        thread_id: "t1".into(),
        media_url: "https://img.jpg".into(),
        caption: Some("Photo".into()),
        is_group: true,
        profile: None,
    };
    assert_eq!(p.media_url, "https://img.jpg");
    assert!(p.is_group);
}

#[test]
fn zalo_user_profile_construction() {
    let p = ZaloUserProfile {
        name: "default".into(),
        label: None,
        is_default: true,
        cookie_path: None,
        imei: None,
        user_agent: None,
    };
    assert!(p.is_default);
}

// ── Type serde roundtrip ──────────────────────────────────────────

#[test]
fn zalo_user_serde_roundtrip() {
    let u = ZaloUser {
        id: "u1".into(),
        display_name: "Alice".into(),
        username: Some("alice".into()),
        avatar: None,
        is_self: true,
    };
    let json = serde_json::to_string(&u).unwrap();
    let u2: ZaloUser = serde_json::from_str(&json).unwrap();
    assert_eq!(u.id, u2.id);
    assert_eq!(u.is_self, u2.is_self);
}

#[test]
fn zalo_friend_serde_roundtrip() {
    let f = ZaloFriend {
        user_id: "f1".into(),
        display_name: "Bob".into(),
        avatar: Some("https://avatar.jpg".into()),
        phone_number: None,
    };
    let json = serde_json::to_string(&f).unwrap();
    let f2: ZaloFriend = serde_json::from_str(&json).unwrap();
    assert_eq!(f.user_id, f2.user_id);
}

#[test]
fn zalo_group_serde_roundtrip() {
    let g = ZaloGroup {
        group_id: "g1".into(),
        name: "Group A".into(),
        member_count: Some(42),
        avatar: None,
    };
    let json = serde_json::to_string(&g).unwrap();
    let g2: ZaloGroup = serde_json::from_str(&json).unwrap();
    assert_eq!(g.group_id, g2.group_id);
    assert_eq!(g.member_count, g2.member_count);
}

#[test]
fn send_message_params_serde_roundtrip() {
    let p = SendMessageParams {
        thread_id: "t1".into(),
        text: "Hello".into(),
        is_group: true,
        profile: Some("work".into()),
    };
    let json = serde_json::to_string(&p).unwrap();
    let p2: SendMessageParams = serde_json::from_str(&json).unwrap();
    assert_eq!(p.thread_id, p2.thread_id);
    assert_eq!(p.is_group, p2.is_group);
    assert_eq!(p.profile, p2.profile);
}

#[test]
fn zalo_user_client_status_serde() {
    let s = ZaloUserClientStatus {
        profile: Some("default".into()),
        user: None,
        running: true,
        timestamp: 12345,
    };
    let json = serde_json::to_string(&s).unwrap();
    let s2: ZaloUserClientStatus = serde_json::from_str(&json).unwrap();
    assert_eq!(s.running, s2.running);
}

#[test]
fn zalo_user_qr_code_payload_serde() {
    let p = ZaloUserQrCodePayload {
        qr_data_url: None,
        message: "Scan QR".into(),
        profile: None,
    };
    let json = serde_json::to_string(&p).unwrap();
    let p2: ZaloUserQrCodePayload = serde_json::from_str(&json).unwrap();
    assert_eq!(p.message, p2.message);
}

#[test]
fn zalo_user_settings_serde_roundtrip() {
    let s = ZaloUserSettings {
        enabled: true,
        default_profile: "work".into(),
        listen_timeout: 60000,
        dm_policy: "open".into(),
        group_policy: "allowlist".into(),
        allowed_threads: vec!["t1".into(), "t2".into()],
        ..Default::default()
    };
    let json = serde_json::to_string(&s).unwrap();
    let s2: ZaloUserSettings = serde_json::from_str(&json).unwrap();
    assert_eq!(s.default_profile, s2.default_profile);
    assert_eq!(s.allowed_threads, s2.allowed_threads);
}

// ── Actions (SendMessage - only action in Rust) ───────────────────

#[cfg(feature = "native")]
mod action_tests {
    use elizaos_plugin_zalouser::actions::{
        send_message_action_meta, validate_send_message, SendMessageActionParams,
        SendMessageActionResult, SEND_MESSAGE_ACTION, SEND_MESSAGE_DESCRIPTION,
        SEND_MESSAGE_SIMILES,
    };

    #[test]
    fn action_name_constant() {
        assert_eq!(SEND_MESSAGE_ACTION, "SEND_ZALOUSER_MESSAGE");
    }

    #[test]
    fn action_description_nonempty() {
        assert!(!SEND_MESSAGE_DESCRIPTION.is_empty());
    }

    #[test]
    fn action_similes_nonempty() {
        assert!(!SEND_MESSAGE_SIMILES.is_empty());
        assert!(SEND_MESSAGE_SIMILES.contains(&"ZALOUSER_SEND_MESSAGE"));
    }

    #[test]
    fn action_meta_returns_correct_data() {
        let meta = send_message_action_meta();
        assert_eq!(meta.name, SEND_MESSAGE_ACTION);
        assert!(!meta.similes.is_empty());
        assert!(!meta.description.is_empty());
    }

    #[test]
    fn validate_send_message_zalouser() {
        assert!(validate_send_message(Some("zalouser")));
    }

    #[test]
    fn validate_send_message_zalo() {
        assert!(!validate_send_message(Some("zalo")));
    }

    #[test]
    fn validate_send_message_none() {
        assert!(!validate_send_message(None));
    }

    #[test]
    fn validate_send_message_other() {
        assert!(!validate_send_message(Some("telegram")));
    }

    #[test]
    fn action_params_serde() {
        let p = SendMessageActionParams {
            thread_id: "t1".into(),
            text: "Hello".into(),
            is_group: false,
        };
        let json = serde_json::to_string(&p).unwrap();
        let p2: SendMessageActionParams = serde_json::from_str(&json).unwrap();
        assert_eq!(p.thread_id, p2.thread_id);
    }

    #[test]
    fn action_result_serde() {
        let r = SendMessageActionResult {
            success: true,
            action: SEND_MESSAGE_ACTION.to_string(),
            thread_id: "t1".into(),
            text: "Hello".into(),
            message_id: Some("m1".into()),
            error: None,
        };
        let json = serde_json::to_string(&r).unwrap();
        let r2: SendMessageActionResult = serde_json::from_str(&json).unwrap();
        assert_eq!(r.action, r2.action);
        assert!(r2.success);
    }
}

// ── Providers (ChatState) ─────────────────────────────────────────

#[cfg(feature = "native")]
mod provider_tests {
    use elizaos_plugin_zalouser::providers::{
        chat_state_provider_meta, get_chat_state, ChatStateData, CHAT_STATE_DESCRIPTION,
        CHAT_STATE_PROVIDER,
    };

    #[test]
    fn provider_name_constant() {
        assert_eq!(CHAT_STATE_PROVIDER, "zalouser_chat_state");
    }

    #[test]
    fn provider_description_nonempty() {
        assert!(!CHAT_STATE_DESCRIPTION.is_empty());
    }

    #[test]
    fn provider_meta_correct() {
        let meta = chat_state_provider_meta();
        assert_eq!(meta.name, CHAT_STATE_PROVIDER);
        assert!(meta.dynamic);
    }

    #[test]
    fn get_chat_state_private() {
        let result = get_chat_state(
            Some("t1"),
            Some("u1"),
            Some("s1"),
            Some("r1"),
            Some(false),
        );
        assert!(result.data.is_private);
        assert!(!result.data.is_group);
        assert_eq!(result.data.thread_id, Some("t1".to_string()));
    }

    #[test]
    fn get_chat_state_group() {
        let result = get_chat_state(Some("t1"), None, None, None, Some(true));
        assert!(!result.data.is_private);
        assert!(result.data.is_group);
    }

    #[test]
    fn get_chat_state_defaults_private() {
        let result = get_chat_state(Some("t1"), None, None, None, None);
        assert!(result.data.is_private);
    }

    #[test]
    fn get_chat_state_text_contains_header() {
        let result = get_chat_state(None, None, None, None, None);
        assert!(result.text.contains("Zalo User Chat State"));
    }

    #[test]
    fn get_chat_state_text_contains_thread_id() {
        let result = get_chat_state(Some("t-99"), None, None, None, None);
        assert!(result.text.contains("t-99"));
    }

    #[test]
    fn get_chat_state_values_empty_defaults() {
        let result = get_chat_state(None, None, None, None, None);
        assert_eq!(result.values.get("thread_id").unwrap(), "");
        assert_eq!(result.values.get("user_id").unwrap(), "");
    }

    #[test]
    fn chat_state_data_default() {
        let d = ChatStateData::default();
        assert!(d.thread_id.is_none());
        assert!(!d.is_group);
        assert!(!d.is_private);
    }
}
