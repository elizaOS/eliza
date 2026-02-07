//! Cross-platform health check system for monitoring automation API availability
//!
//! This module provides a unified health checking interface that works across
//! all platforms, with platform-specific implementations for checking the
//! underlying automation APIs (UIAutomation on Windows, AX on macOS, etc.)

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Overall system health status
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HealthStatus {
    /// Everything is working correctly
    Healthy,
    /// Some functionality is degraded but system is operational
    Degraded,
    /// System is not operational
    Unhealthy,
}

impl HealthStatus {
    /// Convert to HTTP status code for health endpoints
    pub fn to_http_status(&self) -> u16 {
        match self {
            HealthStatus::Healthy => 200,   // OK
            HealthStatus::Degraded => 206,  // Partial Content
            HealthStatus::Unhealthy => 503, // Service Unavailable
        }
    }
}

/// Common health check result structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthCheckResult {
    /// Overall health status
    pub status: HealthStatus,

    /// Whether the automation API is available
    pub api_available: bool,

    /// Whether we can access the desktop/screen
    pub desktop_accessible: bool,

    /// Whether we can enumerate UI elements
    pub can_enumerate_elements: bool,

    /// Time taken to perform the health check in milliseconds
    pub check_duration_ms: u64,

    /// Platform name (e.g., "windows", "macos", "linux")
    pub platform: String,

    /// Error message if any check failed
    pub error_message: Option<String>,

    /// Additional platform-specific diagnostics
    pub diagnostics: HashMap<String, serde_json::Value>,
}

impl Default for HealthCheckResult {
    fn default() -> Self {
        Self {
            status: HealthStatus::Unhealthy,
            api_available: false,
            desktop_accessible: false,
            can_enumerate_elements: false,
            check_duration_ms: 0,
            platform: std::env::consts::OS.to_string(),
            error_message: Some("Health check not performed".to_string()),
            diagnostics: HashMap::new(),
        }
    }
}

impl HealthCheckResult {
    /// Create a new healthy result
    pub fn healthy(platform: impl Into<String>) -> Self {
        Self {
            status: HealthStatus::Healthy,
            api_available: true,
            desktop_accessible: true,
            can_enumerate_elements: true,
            check_duration_ms: 0,
            platform: platform.into(),
            error_message: None,
            diagnostics: HashMap::new(),
        }
    }

    /// Create a new unhealthy result with error
    pub fn unhealthy(platform: impl Into<String>, error: impl Into<String>) -> Self {
        Self {
            status: HealthStatus::Unhealthy,
            api_available: false,
            desktop_accessible: false,
            can_enumerate_elements: false,
            check_duration_ms: 0,
            platform: platform.into(),
            error_message: Some(error.into()),
            diagnostics: HashMap::new(),
        }
    }

    /// Update the overall status based on component health
    pub fn update_status(&mut self) {
        self.status =
            if self.api_available && self.desktop_accessible && self.can_enumerate_elements {
                HealthStatus::Healthy
            } else if self.api_available {
                HealthStatus::Degraded
            } else {
                HealthStatus::Unhealthy
            };
    }

    /// Add a diagnostic value
    pub fn add_diagnostic(&mut self, key: impl Into<String>, value: impl Serialize) {
        if let Ok(json_value) = serde_json::to_value(value) {
            self.diagnostics.insert(key.into(), json_value);
        }
    }
}

/// Trait for platform-specific health check implementations
#[async_trait]
pub trait PlatformHealthCheck: Send + Sync {
    /// Perform a health check of the platform's automation API
    async fn check_health(&self) -> HealthCheckResult;

    /// Quick health check (just basic availability)
    async fn quick_check(&self) -> bool {
        self.check_health().await.api_available
    }
}

/// Get the platform-specific health checker
pub async fn get_platform_health_checker() -> Box<dyn PlatformHealthCheck> {
    #[cfg(target_os = "windows")]
    {
        Box::new(super::platforms::windows::health::WindowsHealthChecker::new())
    }

    #[cfg(target_os = "macos")]
    {
        Box::new(MacOSHealthChecker)
    }

    #[cfg(target_os = "linux")]
    {
        Box::new(LinuxHealthChecker)
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Box::new(UnsupportedPlatformHealthChecker)
    }
}

/// Convenience function to perform a health check on the current platform
pub async fn check_automation_health() -> HealthCheckResult {
    let checker = get_platform_health_checker().await;
    checker.check_health().await
}

/// macOS health checker
#[cfg(target_os = "macos")]
struct MacOSHealthChecker;

#[cfg(target_os = "macos")]
#[async_trait]
impl PlatformHealthCheck for MacOSHealthChecker {
    async fn check_health(&self) -> HealthCheckResult {
        // For now, return a healthy status for macOS
        // TODO: Implement actual Accessibility API checks
        let mut result = HealthCheckResult::healthy("macos");
        result.add_diagnostic(
            "note",
            "Accessibility API health checks not yet implemented",
        );
        result
    }
}

/// Linux health checker
#[cfg(target_os = "linux")]
struct LinuxHealthChecker;

#[cfg(target_os = "linux")]
#[async_trait]
impl PlatformHealthCheck for LinuxHealthChecker {
    async fn check_health(&self) -> HealthCheckResult {
        // For now, return a healthy status for Linux
        // TODO: Implement actual AT-SPI or X11 accessibility checks
        let mut result = HealthCheckResult::healthy("linux");
        result.add_diagnostic("note", "AT-SPI health checks not yet implemented");
        result
    }
}

/// Health checker for unsupported platforms
#[allow(dead_code)]
struct UnsupportedPlatformHealthChecker;

#[async_trait]
impl PlatformHealthCheck for UnsupportedPlatformHealthChecker {
    async fn check_health(&self) -> HealthCheckResult {
        HealthCheckResult {
            status: HealthStatus::Healthy,
            api_available: true,
            desktop_accessible: true,
            can_enumerate_elements: true,
            check_duration_ms: 0,
            platform: std::env::consts::OS.to_string(),
            error_message: None,
            diagnostics: {
                let mut diag = HashMap::new();
                diag.insert(
                    "note".to_string(),
                    serde_json::Value::String(
                        "Platform-specific health checks not implemented".to_string(),
                    ),
                );
                diag
            },
        }
    }
}
