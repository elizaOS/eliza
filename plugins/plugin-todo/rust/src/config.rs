#![allow(missing_docs)]
//! Configuration for the Todo Plugin.

use crate::error::{Result, TodoError};
use std::env;

/// Configuration for the Todo plugin.
#[derive(Debug, Clone)]
pub struct TodoConfig {
    /// Database URL
    pub database_url: Option<String>,

    /// Enable reminder notifications
    pub enable_reminders: bool,

    /// Reminder check interval in milliseconds
    pub reminder_interval_ms: u64,

    /// Minimum interval between reminders per task (ms)
    pub min_reminder_interval_ms: u64,

    /// Enable browser notifications
    pub enable_browser_notifications: bool,

    /// Enable sound notifications
    pub enable_sound: bool,

    /// Quiet hours start (hour 0-23)
    pub quiet_hours_start: u8,

    /// Quiet hours end (hour 0-23)
    pub quiet_hours_end: u8,

    /// Maximum cache entries
    pub cache_max_size: usize,

    /// Default cache TTL in milliseconds
    pub cache_default_ttl_ms: u64,

    /// Enable rolodex integration
    pub enable_rolodex_integration: bool,
}

impl Default for TodoConfig {
    fn default() -> Self {
        Self {
            database_url: None,
            enable_reminders: true,
            reminder_interval_ms: 30_000,
            min_reminder_interval_ms: 1_800_000,
            enable_browser_notifications: false,
            enable_sound: true,
            quiet_hours_start: 22,
            quiet_hours_end: 8,
            cache_max_size: 1000,
            cache_default_ttl_ms: 300_000,
            enable_rolodex_integration: true,
        }
    }
}

impl TodoConfig {
    /// Create a new configuration with defaults.
    pub fn new() -> Self {
        Self::default()
    }

    /// Create configuration from environment variables.
    ///
    /// # Environment Variables
    ///
    /// - `DATABASE_URL`: Database connection string
    /// - `TODO_ENABLE_REMINDERS`: Enable reminders (default: true)
    /// - `TODO_REMINDER_INTERVAL_MS`: Reminder interval (default: 30000)
    /// - `TODO_MIN_REMINDER_INTERVAL_MS`: Min reminder interval (default: 1800000)
    /// - `TODO_QUIET_HOURS_START`: Quiet hours start (default: 22)
    /// - `TODO_QUIET_HOURS_END`: Quiet hours end (default: 8)
    /// - `TODO_CACHE_MAX_SIZE`: Max cache entries (default: 1000)
    ///
    /// # Errors
    ///
    /// Returns an error if configuration values are invalid.
    pub fn from_env() -> Result<Self> {
        let config = Self {
            database_url: env::var("DATABASE_URL").ok(),
            enable_reminders: env::var("TODO_ENABLE_REMINDERS")
                .map(|v| v.to_lowercase() == "true")
                .unwrap_or(true),
            reminder_interval_ms: env::var("TODO_REMINDER_INTERVAL_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(30_000),
            min_reminder_interval_ms: env::var("TODO_MIN_REMINDER_INTERVAL_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(1_800_000),
            enable_browser_notifications: env::var("TODO_ENABLE_BROWSER_NOTIFICATIONS")
                .map(|v| v.to_lowercase() == "true")
                .unwrap_or(false),
            enable_sound: env::var("TODO_ENABLE_SOUND")
                .map(|v| v.to_lowercase() == "true")
                .unwrap_or(true),
            quiet_hours_start: env::var("TODO_QUIET_HOURS_START")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(22),
            quiet_hours_end: env::var("TODO_QUIET_HOURS_END")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(8),
            cache_max_size: env::var("TODO_CACHE_MAX_SIZE")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(1000),
            cache_default_ttl_ms: env::var("TODO_CACHE_DEFAULT_TTL_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(300_000),
            enable_rolodex_integration: env::var("TODO_ENABLE_ROLODEX")
                .map(|v| v.to_lowercase() == "true")
                .unwrap_or(true),
        };

        config.validate()?;
        Ok(config)
    }

    /// Validate the configuration.
    ///
    /// # Errors
    ///
    /// Returns an error if configuration is invalid.
    pub fn validate(&self) -> Result<()> {
        if self.reminder_interval_ms < 1000 {
            return Err(TodoError::config(
                "reminder_interval_ms must be at least 1000ms",
            ));
        }

        if self.min_reminder_interval_ms < 60_000 {
            return Err(TodoError::config(
                "min_reminder_interval_ms must be at least 60000ms",
            ));
        }

        if self.quiet_hours_start > 23 {
            return Err(TodoError::config(
                "quiet_hours_start must be between 0 and 23",
            ));
        }

        if self.quiet_hours_end > 23 {
            return Err(TodoError::config(
                "quiet_hours_end must be between 0 and 23",
            ));
        }

        if self.cache_max_size < 10 {
            return Err(TodoError::config("cache_max_size must be at least 10"));
        }

        Ok(())
    }

    /// Builder method to set enable_reminders.
    pub fn with_reminders(mut self, enabled: bool) -> Self {
        self.enable_reminders = enabled;
        self
    }

    /// Builder method to set reminder interval.
    pub fn with_reminder_interval(mut self, ms: u64) -> Self {
        self.reminder_interval_ms = ms;
        self
    }

    /// Builder method to set cache size.
    pub fn with_cache_size(mut self, size: usize) -> Self {
        self.cache_max_size = size;
        self
    }
}
