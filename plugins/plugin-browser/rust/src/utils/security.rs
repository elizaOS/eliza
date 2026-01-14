use crate::types::{RateLimitConfig, RateLimitEntry, SecurityConfig};
use crate::utils::errors::{security_error, BrowserError};
use regex::Regex;
use std::collections::HashMap;
use std::sync::RwLock;
use std::time::{SystemTime, UNIX_EPOCH};
use url::Url;

#[derive(Debug)]
pub struct ValidationResult {
    pub valid: bool,
    pub sanitized: Option<String>,
    pub error: Option<String>,
}

pub struct UrlValidator {
    config: SecurityConfig,
}

impl UrlValidator {
    pub fn new(config: SecurityConfig) -> Self {
        Self { config }
    }

    pub fn validate(&self, url: &str) -> ValidationResult {
        if url.len() > self.config.max_url_length {
            return ValidationResult {
                valid: false,
                sanitized: None,
                error: Some("URL is too long".to_string()),
            };
        }

        let parsed = match Url::parse(url) {
            Ok(u) => u,
            Err(_) => {
                let url_with_scheme = format!("https://{}", url);
                match Url::parse(&url_with_scheme) {
                    Ok(u) => u,
                    Err(_) => {
                        return ValidationResult {
                            valid: false,
                            sanitized: None,
                            error: Some("Invalid URL format".to_string()),
                        };
                    }
                }
            }
        };

        let scheme = parsed.scheme();
        if scheme == "file" && !self.config.allow_file_protocol {
            return ValidationResult {
                valid: false,
                sanitized: None,
                error: Some("File protocol is not allowed".to_string()),
            };
        }

        if !["http", "https", "file"].contains(&scheme) {
            return ValidationResult {
                valid: false,
                sanitized: None,
                error: Some("Only HTTP(S) protocols are allowed".to_string()),
            };
        }

        if let Some(host) = parsed.host_str() {
            let is_localhost = ["localhost", "127.0.0.1", "::1"].contains(&host);
            if is_localhost && !self.config.allow_localhost {
                return ValidationResult {
                    valid: false,
                    sanitized: None,
                    error: Some("Localhost URLs are not allowed".to_string()),
                };
            }

            for blocked in &self.config.blocked_domains {
                if host.contains(blocked) {
                    return ValidationResult {
                        valid: false,
                        sanitized: None,
                        error: Some(format!("Domain {} is blocked", blocked)),
                    };
                }
            }

            if !self.config.allowed_domains.is_empty() {
                let allowed = self
                    .config
                    .allowed_domains
                    .iter()
                    .any(|domain| host == domain || host.ends_with(&format!(".{}", domain)));
                if !allowed {
                    return ValidationResult {
                        valid: false,
                        sanitized: None,
                        error: Some("Domain is not in the allowed list".to_string()),
                    };
                }
            }
        }

        ValidationResult {
            valid: true,
            sanitized: Some(parsed.to_string()),
            error: None,
        }
    }

    pub fn update_config(&mut self, config: SecurityConfig) {
        self.config = config;
    }
}

impl Default for UrlValidator {
    fn default() -> Self {
        Self::new(SecurityConfig::default())
    }
}

pub struct InputSanitizer;

impl InputSanitizer {
    pub fn sanitize_text(input: &str) -> String {
        let re_tags = Regex::new(r"[<>]").unwrap();
        let re_js = Regex::new(r"(?i)javascript:").unwrap();
        let re_handlers = Regex::new(r"(?i)on\w+\s*=").unwrap();

        let result = re_tags.replace_all(input, "");
        let result = re_js.replace_all(&result, "");
        let result = re_handlers.replace_all(&result, "");
        result.trim().to_string()
    }

    pub fn sanitize_selector(selector: &str) -> String {
        let re_quotes = Regex::new(r#"['"]"#).unwrap();
        let re_tags = Regex::new(r"[<>]").unwrap();

        let result = re_quotes.replace_all(selector, "");
        let result = re_tags.replace_all(&result, "");
        result.trim().to_string()
    }

    pub fn sanitize_file_path(path: &str) -> String {
        let re_traversal = Regex::new(r"\.\.").unwrap();
        let re_invalid = Regex::new(r#"[<>:"|?\*]"#).unwrap();

        let result = re_traversal.replace_all(path, "");
        let result = re_invalid.replace_all(&result, "");
        result.trim().to_string()
    }
}

pub fn validate_secure_action(
    url: Option<&str>,
    validator: &UrlValidator,
) -> Result<(), BrowserError> {
    if let Some(url) = url {
        let result = validator.validate(url);
        if !result.valid {
            return Err(security_error(format!(
                "URL validation failed: {}",
                result.error.unwrap_or_default()
            )));
        }
    }
    Ok(())
}

pub struct RateLimiter {
    config: RateLimitConfig,
    action_counts: RwLock<HashMap<String, RateLimitEntry>>,
    session_counts: RwLock<HashMap<String, RateLimitEntry>>,
}

impl RateLimiter {
    pub fn new(config: RateLimitConfig) -> Self {
        Self {
            config,
            action_counts: RwLock::new(HashMap::new()),
            session_counts: RwLock::new(HashMap::new()),
        }
    }

    fn current_time() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
    }

    pub fn check_action_limit(&self, user_id: &str) -> bool {
        let now = Self::current_time();
        let mut counts = self.action_counts.write().unwrap();

        let entry = counts.entry(user_id.to_string()).or_insert(RateLimitEntry {
            count: 0,
            reset_time: now + 60,
        });

        if now > entry.reset_time {
            entry.count = 1;
            entry.reset_time = now + 60;
            return true;
        }

        if entry.count >= self.config.max_actions_per_minute {
            return false;
        }

        entry.count += 1;
        true
    }

    pub fn check_session_limit(&self, user_id: &str) -> bool {
        let now = Self::current_time();
        let mut counts = self.session_counts.write().unwrap();

        let entry = counts.entry(user_id.to_string()).or_insert(RateLimitEntry {
            count: 0,
            reset_time: now + 3600,
        });

        if now > entry.reset_time {
            entry.count = 1;
            entry.reset_time = now + 3600;
            return true;
        }

        if entry.count >= self.config.max_sessions_per_hour {
            return false;
        }

        entry.count += 1;
        true
    }
}

pub fn default_url_validator() -> UrlValidator {
    UrlValidator::default()
}
