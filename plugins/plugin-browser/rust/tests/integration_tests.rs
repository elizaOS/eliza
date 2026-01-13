//! Integration tests for browser plugin.

use elizaos_browser::{
    ActionResult, BrowserConfig, BrowserSession, CaptchaResult, CaptchaType, ErrorCode,
    ExtractResult, NavigationResult, RateLimitConfig, RetryConfig, ScreenshotResult,
    SecurityConfig,
};
use std::collections::HashMap;

#[test]
fn test_browser_config_default() {
    let config = BrowserConfig::default();
    assert!(config.headless);
    assert_eq!(config.server_port, 3456);
    assert!(config.browserbase_api_key.is_none());
    assert!(config.browserbase_project_id.is_none());
    assert!(config.openai_api_key.is_none());
    assert!(config.anthropic_api_key.is_none());
    assert!(config.capsolver_api_key.is_none());
}

#[test]
fn test_browser_session_new() {
    let session = BrowserSession::new("test-session-id".to_string());
    assert_eq!(session.id, "test-session-id");
    assert!(session.url.is_none());
    assert!(session.title.is_none());
}

#[test]
fn test_action_result_success() {
    let mut data = HashMap::new();
    data.insert("key".to_string(), serde_json::json!("value"));

    let result = ActionResult::success(data.clone());
    assert!(result.success);
    assert!(result.data.is_some());
    assert!(result.error.is_none());
}

#[test]
fn test_action_result_failure() {
    let result = ActionResult::failure("Something went wrong".to_string());
    assert!(!result.success);
    assert!(result.data.is_none());
    assert_eq!(result.error, Some("Something went wrong".to_string()));
}

#[test]
fn test_captcha_type_default() {
    let captcha_type = CaptchaType::default();
    assert_eq!(captcha_type, CaptchaType::None);
}

#[test]
fn test_security_config_default() {
    let config = SecurityConfig::default();
    assert!(config.allowed_domains.is_empty());
    assert!(!config.blocked_domains.is_empty());
    assert_eq!(config.max_url_length, 2048);
    assert!(config.allow_localhost);
    assert!(!config.allow_file_protocol);
}

#[test]
fn test_retry_config_default() {
    let config = RetryConfig::default();
    assert_eq!(config.max_attempts, 3);
    assert_eq!(config.initial_delay_ms, 1000);
    assert_eq!(config.max_delay_ms, 5000);
    assert!((config.backoff_multiplier - 2.0).abs() < f64::EPSILON);
}

#[test]
fn test_rate_limit_config_default() {
    let config = RateLimitConfig::default();
    assert_eq!(config.max_actions_per_minute, 60);
    assert_eq!(config.max_sessions_per_hour, 10);
}

#[test]
fn test_error_code_serialization() {
    let code = ErrorCode::ServiceNotAvailable;
    let json = serde_json::to_string(&code).unwrap();
    assert!(json.contains("SERVICE_NOT_AVAILABLE"));
}

#[test]
fn test_navigation_result_serialization() {
    let result = NavigationResult {
        success: true,
        url: "https://example.com".to_string(),
        title: "Example".to_string(),
        error: None,
    };

    let json = serde_json::to_string(&result).unwrap();
    assert!(json.contains("example.com"));
    assert!(json.contains("Example"));
}

#[test]
fn test_extract_result_serialization() {
    let result = ExtractResult {
        success: true,
        found: true,
        data: Some("extracted data".to_string()),
        error: None,
    };

    let json = serde_json::to_string(&result).unwrap();
    assert!(json.contains("extracted data"));
}

#[test]
fn test_screenshot_result_serialization() {
    let result = ScreenshotResult {
        success: true,
        data: Some("base64data".to_string()),
        mime_type: "image/png".to_string(),
        url: Some("https://example.com".to_string()),
        title: Some("Example".to_string()),
        error: None,
    };

    let json = serde_json::to_string(&result).unwrap();
    assert!(json.contains("base64data"));
    assert!(json.contains("image/png"));
}

#[test]
fn test_captcha_result_serialization() {
    let result = CaptchaResult {
        detected: true,
        captcha_type: CaptchaType::RecaptchaV2,
        site_key: Some("test-key".to_string()),
        solved: false,
        token: None,
        error: None,
    };

    let json = serde_json::to_string(&result).unwrap();
    assert!(json.contains("detected"));
    assert!(json.contains("recaptcha-v2"));
}

#[test]
fn test_detect_captcha_type_turnstile() {
    use elizaos_browser::detect_captcha_type;

    let html = r#"<div class="cf-turnstile" data-sitekey="test-key-123"></div>"#;
    let (captcha_type, site_key) = detect_captcha_type(html);

    assert_eq!(captcha_type, CaptchaType::Turnstile);
    assert_eq!(site_key, Some("test-key-123".to_string()));
}

#[test]
fn test_detect_captcha_type_recaptcha_v2() {
    use elizaos_browser::detect_captcha_type;

    let html = r#"<div class="g-recaptcha" data-sitekey="recaptcha-key"></div>"#;
    let (captcha_type, site_key) = detect_captcha_type(html);

    assert_eq!(captcha_type, CaptchaType::RecaptchaV2);
    assert_eq!(site_key, Some("recaptcha-key".to_string()));
}

#[test]
fn test_detect_captcha_type_recaptcha_v3() {
    use elizaos_browser::detect_captcha_type;

    let html = r#"<script src="https://www.google.com/recaptcha/api.js?render=v3-key"></script>
                  <div data-sitekey="v3-key"></div>
                  <script>grecaptcha.execute('v3-key')</script>"#;
    let (captcha_type, _) = detect_captcha_type(html);

    assert_eq!(captcha_type, CaptchaType::RecaptchaV3);
}

#[test]
fn test_detect_captcha_type_hcaptcha() {
    use elizaos_browser::detect_captcha_type;

    let html = r#"<div class="h-captcha" data-sitekey="hcaptcha-key"></div>"#;
    let (captcha_type, site_key) = detect_captcha_type(html);

    assert_eq!(captcha_type, CaptchaType::Hcaptcha);
    assert_eq!(site_key, Some("hcaptcha-key".to_string()));
}

#[test]
fn test_detect_captcha_type_none() {
    use elizaos_browser::detect_captcha_type;

    let html = r#"<html><body><p>No captcha here</p></body></html>"#;
    let (captcha_type, site_key) = detect_captcha_type(html);

    assert_eq!(captcha_type, CaptchaType::None);
    assert!(site_key.is_none());
}

#[test]
fn test_generate_captcha_injection_script_turnstile() {
    use elizaos_browser::generate_captcha_injection_script;

    let script = generate_captcha_injection_script(&CaptchaType::Turnstile, "test-token");

    assert!(script.contains("cf-turnstile-response"));
    assert!(script.contains("test-token"));
    assert!(script.contains("turnstileCallback"));
}

#[test]
fn test_generate_captcha_injection_script_recaptcha() {
    use elizaos_browser::generate_captcha_injection_script;

    let script = generate_captcha_injection_script(&CaptchaType::RecaptchaV2, "recaptcha-token");

    assert!(script.contains("g-recaptcha-response"));
    assert!(script.contains("recaptcha-token"));
    assert!(script.contains("onRecaptchaSuccess"));
}

#[test]
fn test_generate_captcha_injection_script_hcaptcha() {
    use elizaos_browser::generate_captcha_injection_script;

    let script = generate_captcha_injection_script(&CaptchaType::Hcaptcha, "hcaptcha-token");

    assert!(script.contains("h-captcha-response"));
    assert!(script.contains("hcaptcha-token"));
    assert!(script.contains("hcaptchaCallback"));
}

#[test]
fn test_generate_captcha_injection_script_none() {
    use elizaos_browser::generate_captcha_injection_script;

    let script = generate_captcha_injection_script(&CaptchaType::None, "token");

    assert!(script.is_empty());
}
