#![allow(missing_docs)]

use once_cell::sync::Lazy;
use regex::Regex;

use crate::error::{BlueSkyError, Result};

pub const SERVICE_URL: &str = "https://bsky.social";
pub const MAX_POST_LENGTH: usize = 300;
pub const POLL_INTERVAL: u64 = 60;
pub const POST_INTERVAL_MIN: u64 = 1800;
pub const POST_INTERVAL_MAX: u64 = 3600;
pub const ACTION_INTERVAL: u64 = 120;
pub const MAX_ACTIONS: u32 = 5;
pub const CHAT_SERVICE_DID: &str = "did:web:api.bsky.chat";

static HANDLE_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$").unwrap()
});

#[derive(Debug, Clone)]
pub struct BlueSkyConfig {
    handle: String,
    password: String,
    service: String,
    dry_run: bool,
    poll_interval: u64,
    enable_posting: bool,
    post_interval_min: u64,
    post_interval_max: u64,
    enable_action_processing: bool,
    action_interval: u64,
    max_actions: u32,
    enable_dms: bool,
    timeout: u64,
}

impl BlueSkyConfig {
    pub fn new(handle: impl Into<String>, password: impl Into<String>) -> Result<Self> {
        let handle = handle.into();
        let password = password.into();

        if handle.is_empty() {
            return Err(BlueSkyError::config("Handle required"));
        }
        if !HANDLE_REGEX.is_match(&handle) {
            return Err(BlueSkyError::config("Invalid handle format"));
        }
        if password.is_empty() {
            return Err(BlueSkyError::config("Password required"));
        }

        Ok(Self {
            handle,
            password,
            service: SERVICE_URL.to_string(),
            dry_run: false,
            poll_interval: POLL_INTERVAL,
            enable_posting: true,
            post_interval_min: POST_INTERVAL_MIN,
            post_interval_max: POST_INTERVAL_MAX,
            enable_action_processing: true,
            action_interval: ACTION_INTERVAL,
            max_actions: MAX_ACTIONS,
            enable_dms: true,
            timeout: 30,
        })
    }

    pub fn from_env() -> Result<Self> {
        let handle = std::env::var("BLUESKY_HANDLE")
            .map_err(|_| BlueSkyError::config("BLUESKY_HANDLE not set"))?;
        let password = std::env::var("BLUESKY_PASSWORD")
            .map_err(|_| BlueSkyError::config("BLUESKY_PASSWORD not set"))?;

        let mut cfg = Self::new(handle, password)?;

        if let Ok(s) = std::env::var("BLUESKY_SERVICE") {
            cfg.service = s.trim_end_matches('/').to_string();
        }
        if let Ok(v) = std::env::var("BLUESKY_DRY_RUN") {
            cfg.dry_run = v.eq_ignore_ascii_case("true");
        }
        if let Ok(v) = std::env::var("BLUESKY_POLL_INTERVAL") {
            cfg.poll_interval = v.parse().unwrap_or(POLL_INTERVAL);
        }
        if let Ok(v) = std::env::var("BLUESKY_ENABLE_POSTING") {
            cfg.enable_posting = !v.eq_ignore_ascii_case("false");
        }
        if let Ok(v) = std::env::var("BLUESKY_ENABLE_DMS") {
            cfg.enable_dms = !v.eq_ignore_ascii_case("false");
        }

        Ok(cfg)
    }

    pub fn handle(&self) -> &str {
        &self.handle
    }
    pub fn password(&self) -> &str {
        &self.password
    }
    pub fn service(&self) -> &str {
        &self.service
    }
    pub fn dry_run(&self) -> bool {
        self.dry_run
    }
    pub fn poll_interval(&self) -> u64 {
        self.poll_interval
    }
    pub fn enable_posting(&self) -> bool {
        self.enable_posting
    }
    pub fn post_interval_min(&self) -> u64 {
        self.post_interval_min
    }
    pub fn post_interval_max(&self) -> u64 {
        self.post_interval_max
    }
    pub fn enable_action_processing(&self) -> bool {
        self.enable_action_processing
    }
    pub fn action_interval(&self) -> u64 {
        self.action_interval
    }
    pub fn max_actions(&self) -> u32 {
        self.max_actions
    }
    pub fn enable_dms(&self) -> bool {
        self.enable_dms
    }
    pub fn timeout(&self) -> u64 {
        self.timeout
    }

    pub fn with_service(mut self, service: impl Into<String>) -> Self {
        self.service = service.into().trim_end_matches('/').to_string();
        self
    }

    pub fn with_dry_run(mut self, dry_run: bool) -> Self {
        self.dry_run = dry_run;
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_valid_config() {
        let cfg = BlueSkyConfig::new("test.bsky.social", "password").unwrap();
        assert_eq!(cfg.handle(), "test.bsky.social");
    }

    #[test]
    fn test_invalid_handle() {
        assert!(BlueSkyConfig::new("invalid", "password").is_err());
    }
}
