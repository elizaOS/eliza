//! Integration tests for the Gmail Watch plugin.

use elizaos_plugin_gmail_watch::{GmailWatchConfig, ServeConfig};

// ---------------------------------------------------------------------------
// Plugin metadata
// ---------------------------------------------------------------------------

#[test]
fn test_plugin_metadata() {
    let plugin = elizaos_plugin_gmail_watch::plugin();
    assert_eq!(plugin.name, "gmail-watch");
    assert!(!plugin.description.is_empty());
    assert!(!plugin.version.is_empty());
}

#[test]
fn test_plugin_constants() {
    assert_eq!(elizaos_plugin_gmail_watch::PLUGIN_NAME, "gmail-watch");
    assert_eq!(elizaos_plugin_gmail_watch::PLUGIN_VERSION, "2.0.0");
}

// ---------------------------------------------------------------------------
// Config creation & defaults
// ---------------------------------------------------------------------------

#[test]
fn test_config_creation() {
    let config = GmailWatchConfig::new("user@gmail.com".to_string());

    assert_eq!(config.account, "user@gmail.com");
    assert_eq!(config.label, "INBOX");
    assert!(config.topic.is_empty());
    assert!(config.subscription.is_none());
    assert!(config.push_token.is_empty());
    assert!(config.include_body);
    assert_eq!(config.max_bytes, 20000);
    assert_eq!(config.renew_every_minutes, 360);
    assert!(config.validate().is_ok());
}

#[test]
fn test_serve_config_defaults() {
    let serve = ServeConfig::default();
    assert_eq!(serve.bind, "127.0.0.1");
    assert_eq!(serve.port, 8788);
    assert_eq!(serve.path, "/gmail-pubsub");
}

#[test]
fn test_config_builder_pattern() {
    let config = GmailWatchConfig::new("user@gmail.com".to_string())
        .with_label("STARRED".to_string())
        .with_topic("projects/p/topics/t".to_string())
        .with_hook_token("secret".to_string())
        .with_push_token("push-tok".to_string())
        .with_renew_every_minutes(30)
        .with_include_body(false)
        .with_max_bytes(10000);

    assert_eq!(config.label, "STARRED");
    assert_eq!(config.topic, "projects/p/topics/t");
    assert_eq!(config.hook_token, "secret");
    assert_eq!(config.push_token, "push-tok");
    assert_eq!(config.renew_every_minutes, 30);
    assert!(!config.include_body);
    assert_eq!(config.max_bytes, 10000);
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

#[test]
fn test_config_validation_valid() {
    let config = GmailWatchConfig::new("user@gmail.com".to_string());
    assert!(config.validate().is_ok());
}

#[test]
fn test_config_validation_empty_account() {
    let config = GmailWatchConfig::new("".to_string());
    let err = config.validate().unwrap_err();
    assert!(err.to_string().contains("empty"));
}

#[test]
fn test_config_validation_blank_account() {
    let config = GmailWatchConfig::new("   ".to_string());
    let err = config.validate().unwrap_err();
    assert!(err.to_string().contains("blank"));
}

#[test]
fn test_config_validation_zero_renew() {
    let config = GmailWatchConfig::new("a@b.com".to_string()).with_renew_every_minutes(0);
    assert!(config.validate().is_err());
}

#[test]
fn test_config_validation_zero_port() {
    let config = GmailWatchConfig::new("a@b.com".to_string()).with_serve(ServeConfig {
        port: 0,
        ..ServeConfig::default()
    });
    assert!(config.validate().is_err());
}

// ---------------------------------------------------------------------------
// Config from_settings
// ---------------------------------------------------------------------------

#[test]
fn test_from_settings_full() {
    let settings = serde_json::json!({
        "hooks": {
            "enabled": true,
            "token": "shared-secret",
            "presets": ["gmail"],
            "gmail": {
                "account": "user@gmail.com",
                "label": "INBOX",
                "topic": "projects/p/topics/t",
                "pushToken": "my-push-token",
                "hookUrl": "http://127.0.0.1:18789/hooks/gmail",
                "includeBody": true,
                "maxBytes": 20000,
                "renewEveryMinutes": 360,
                "serve": {
                    "bind": "127.0.0.1",
                    "port": 8788,
                    "path": "/gmail-pubsub"
                }
            }
        }
    });

    let config = GmailWatchConfig::from_settings(&settings).unwrap();
    assert_eq!(config.account, "user@gmail.com");
    assert_eq!(config.label, "INBOX");
    assert_eq!(config.topic, "projects/p/topics/t");
    assert_eq!(config.push_token, "my-push-token");
    assert_eq!(config.hook_token, "shared-secret");
    assert!(config.include_body);
    assert_eq!(config.max_bytes, 20000);
    assert_eq!(config.renew_every_minutes, 360);
    assert_eq!(config.serve.bind, "127.0.0.1");
    assert_eq!(config.serve.port, 8788);
    assert_eq!(config.serve.path, "/gmail-pubsub");
}

#[test]
fn test_from_settings_missing_hooks() {
    let settings = serde_json::json!({});
    assert!(GmailWatchConfig::from_settings(&settings).is_none());
}

#[test]
fn test_from_settings_missing_gmail() {
    let settings = serde_json::json!({"hooks": {}});
    assert!(GmailWatchConfig::from_settings(&settings).is_none());
}

#[test]
fn test_from_settings_missing_account() {
    let settings = serde_json::json!({"hooks": {"gmail": {}}});
    assert!(GmailWatchConfig::from_settings(&settings).is_none());
}

#[test]
fn test_from_settings_empty_account() {
    let settings = serde_json::json!({"hooks": {"gmail": {"account": ""}}});
    assert!(GmailWatchConfig::from_settings(&settings).is_none());
}

#[test]
fn test_from_settings_minimal() {
    let settings = serde_json::json!({"hooks": {"gmail": {"account": "me@x.com"}}});
    let config = GmailWatchConfig::from_settings(&settings).unwrap();
    assert_eq!(config.account, "me@x.com");
    assert_eq!(config.label, "INBOX");
    assert_eq!(config.renew_every_minutes, 360);
    assert_eq!(config.serve.port, 8788);
}

#[test]
fn test_from_settings_include_body_false() {
    let settings = serde_json::json!({
        "hooks": {"gmail": {"account": "a@b.com", "includeBody": false}}
    });
    let config = GmailWatchConfig::from_settings(&settings).unwrap();
    assert!(!config.include_body);
}

// ---------------------------------------------------------------------------
// Backoff / delay calculation
// ---------------------------------------------------------------------------

#[test]
fn test_backoff_first_attempt() {
    use elizaos_plugin_gmail_watch::service::{
        calculate_backoff_delay, INITIAL_RESTART_DELAY_SECS,
    };
    assert!(
        (calculate_backoff_delay(1) - INITIAL_RESTART_DELAY_SECS).abs() < f64::EPSILON
    );
}

#[test]
fn test_backoff_second_attempt() {
    use elizaos_plugin_gmail_watch::service::{
        calculate_backoff_delay, INITIAL_RESTART_DELAY_SECS,
    };
    assert!(
        (calculate_backoff_delay(2) - INITIAL_RESTART_DELAY_SECS * 2.0).abs() < f64::EPSILON
    );
}

#[test]
fn test_backoff_clamped() {
    use elizaos_plugin_gmail_watch::service::{
        calculate_backoff_delay, MAX_RESTART_DELAY_SECS,
    };
    assert!(
        (calculate_backoff_delay(50) - MAX_RESTART_DELAY_SECS).abs() < f64::EPSILON
    );
}

#[test]
fn test_backoff_all_within_bounds() {
    use elizaos_plugin_gmail_watch::service::{
        calculate_backoff_delay, INITIAL_RESTART_DELAY_SECS, MAX_RESTART_ATTEMPTS,
        MAX_RESTART_DELAY_SECS,
    };
    for i in 1..=MAX_RESTART_ATTEMPTS {
        let delay = calculate_backoff_delay(i);
        assert!(delay >= INITIAL_RESTART_DELAY_SECS);
        assert!(delay <= MAX_RESTART_DELAY_SECS);
    }
}

#[test]
fn test_backoff_monotonically_non_decreasing() {
    use elizaos_plugin_gmail_watch::service::calculate_backoff_delay;
    let mut prev = 0.0;
    for i in 1..20 {
        let delay = calculate_backoff_delay(i);
        assert!(delay >= prev);
        prev = delay;
    }
}

// ---------------------------------------------------------------------------
// Build CLI arguments
// ---------------------------------------------------------------------------

#[test]
fn test_build_serve_args_basic() {
    use elizaos_plugin_gmail_watch::service::build_serve_args;
    let config = GmailWatchConfig::new("user@gmail.com".to_string())
        .with_hook_token("secret".to_string());
    let args = build_serve_args(&config);

    assert_eq!(&args[0..3], &["gmail", "watch", "serve"]);
    assert!(args.contains(&"--account".to_string()));
    assert!(args.contains(&"user@gmail.com".to_string()));
    assert!(args.contains(&"--hook-token".to_string()));
    assert!(args.contains(&"secret".to_string()));
}

#[test]
fn test_build_serve_args_include_body() {
    use elizaos_plugin_gmail_watch::service::build_serve_args;
    let config = GmailWatchConfig::new("a@b.com".to_string());
    let args = build_serve_args(&config);
    assert!(args.contains(&"--include-body".to_string()));
}

#[test]
fn test_build_serve_args_no_include_body() {
    use elizaos_plugin_gmail_watch::service::build_serve_args;
    let config = GmailWatchConfig::new("a@b.com".to_string()).with_include_body(false);
    let args = build_serve_args(&config);
    assert!(!args.contains(&"--include-body".to_string()));
}

#[test]
fn test_build_renew_args_with_topic() {
    use elizaos_plugin_gmail_watch::service::build_renew_args;
    let config = GmailWatchConfig::new("a@b.com".to_string())
        .with_topic("projects/p/topics/t".to_string());
    let args = build_renew_args(&config);
    assert_eq!(&args[0..3], &["gmail", "watch", "start"]);
    assert!(args.contains(&"--topic".to_string()));
}

#[test]
fn test_build_renew_args_no_topic() {
    use elizaos_plugin_gmail_watch::service::build_renew_args;
    let config = GmailWatchConfig::new("a@b.com".to_string());
    let args = build_renew_args(&config);
    assert!(!args.contains(&"--topic".to_string()));
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

#[test]
fn test_error_retryable() {
    use elizaos_plugin_gmail_watch::GmailWatchError;

    assert!(GmailWatchError::ProcessError("x".to_string()).is_retryable());
    assert!(GmailWatchError::RenewalError("x".to_string()).is_retryable());
    assert!(!GmailWatchError::ConfigError("x".to_string()).is_retryable());
    assert!(!GmailWatchError::GogBinaryNotFound.is_retryable());
}

// ---------------------------------------------------------------------------
// Service (async tests)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_service_initial_state() {
    use elizaos_plugin_gmail_watch::GmailWatchService;
    let config = GmailWatchConfig::new("user@gmail.com".to_string());
    let service = GmailWatchService::new(config);
    assert!(!service.is_running().await);
    assert_eq!(service.restart_attempts().await, 0);
}

#[tokio::test]
async fn test_service_config_accessible() {
    use elizaos_plugin_gmail_watch::GmailWatchService;
    let config = GmailWatchConfig::new("user@gmail.com".to_string())
        .with_renew_every_minutes(30);
    let service = GmailWatchService::new(config);
    assert_eq!(service.config().account, "user@gmail.com");
    assert_eq!(service.config().renew_every_minutes, 30);
}

#[tokio::test]
async fn test_service_start_invalid_config() {
    use elizaos_plugin_gmail_watch::GmailWatchService;
    let config = GmailWatchConfig::new("".to_string());
    let service = GmailWatchService::new(config);
    assert!(service.start().await.is_err());
    assert!(!service.is_running().await);
}

// ---------------------------------------------------------------------------
// Renewal timing
// ---------------------------------------------------------------------------

#[test]
fn test_renewal_interval_calculation() {
    let config = GmailWatchConfig::new("a@b.com".to_string());
    let interval_s = (config.renew_every_minutes as u64) * 60;
    assert_eq!(interval_s, 21600); // 6 hours
}

#[test]
fn test_custom_renewal_interval() {
    let config = GmailWatchConfig::new("a@b.com".to_string()).with_renew_every_minutes(30);
    let interval_s = (config.renew_every_minutes as u64) * 60;
    assert_eq!(interval_s, 1800);
}

// ---------------------------------------------------------------------------
// Config serialization
// ---------------------------------------------------------------------------

#[test]
fn test_config_serialization_roundtrip() {
    let config = GmailWatchConfig::new("user@gmail.com".to_string())
        .with_topic("projects/p/topics/t".to_string())
        .with_hook_token("secret".to_string());

    let json = serde_json::to_string(&config).unwrap();
    let deserialized: GmailWatchConfig = serde_json::from_str(&json).unwrap();

    assert_eq!(deserialized.account, "user@gmail.com");
    assert_eq!(deserialized.topic, "projects/p/topics/t");
    assert_eq!(deserialized.hook_token, "secret");
}
