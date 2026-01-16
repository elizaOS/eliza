//! Windows-specific health check implementation using UIAutomation API

use crate::health::{HealthCheckResult, PlatformHealthCheck};
use async_trait::async_trait;
use std::time::Instant;
use tracing::{debug, error, warn};
use uiautomation::UIAutomation;
use windows::core::HRESULT;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

/// Windows health checker using UIAutomation API
pub struct WindowsHealthChecker;

impl Default for WindowsHealthChecker {
    fn default() -> Self {
        Self::new()
    }
}

impl WindowsHealthChecker {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl PlatformHealthCheck for WindowsHealthChecker {
    async fn check_health(&self) -> HealthCheckResult {
        let start = Instant::now();

        // Run the check in a blocking task with timeout since UIAutomation uses COM
        let check_future = tokio::task::spawn_blocking(perform_sync_health_check);

        // Apply a 5-second timeout to the health check
        match tokio::time::timeout(std::time::Duration::from_secs(5), check_future).await {
            Ok(Ok(mut result)) => {
                result.check_duration_ms = start.elapsed().as_millis() as u64;
                result
            }
            Ok(Err(e)) => {
                error!("Failed to spawn UIAutomation health check task: {}", e);
                let mut result = HealthCheckResult::unhealthy(
                    "windows",
                    format!("Failed to spawn health check task: {e}"),
                );
                result.check_duration_ms = start.elapsed().as_millis() as u64;
                result
            }
            Err(_) => {
                error!("UIAutomation health check timed out after 5 seconds");
                let mut result = HealthCheckResult::unhealthy(
                    "windows",
                    "Health check timed out after 5 seconds - UIAutomation API may be unresponsive",
                );
                result.check_duration_ms = start.elapsed().as_millis() as u64;
                result
            }
        }
    }
}

fn perform_sync_health_check() -> HealthCheckResult {
    let start = Instant::now();
    let mut result = HealthCheckResult {
        platform: "windows".to_string(),
        ..Default::default()
    };

    // Step 1: Initialize COM
    let com_initialized = unsafe {
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        if hr.is_err() && hr != HRESULT(0x80010106u32 as i32) {
            // 0x80010106 = RPC_E_CHANGED_MODE (already initialized in different mode)
            error!("Failed to initialize COM: {:?}", hr);
            false
        } else {
            true
        }
    };

    result.add_diagnostic("com_initialized", com_initialized);

    if !com_initialized {
        result.error_message = Some("COM initialization failed".to_string());
        result.check_duration_ms = start.elapsed().as_millis() as u64;
        result.update_status();
        return result;
    }

    // Step 2: Create UIAutomation instance
    let automation = match UIAutomation::new_direct() {
        Ok(a) => {
            debug!("UIAutomation instance created successfully");
            result.api_available = true;
            a
        }
        Err(e) => {
            error!("Failed to create UIAutomation instance: {}", e);
            result.error_message = Some(format!("UIAutomation creation failed: {e}"));
            result.check_duration_ms = start.elapsed().as_millis() as u64;
            result.update_status();
            return result;
        }
    };

    // Step 3: Try to get desktop root element
    let root_element = match automation.get_root_element() {
        Ok(root) => {
            debug!("Desktop root element obtained");
            result.desktop_accessible = true;
            root
        }
        Err(e) => {
            error!("Failed to get desktop root element: {}", e);

            // Check if we're in a headless/virtual display environment
            let is_headless = crate::platforms::windows::virtual_display::is_headless_environment();
            result.add_diagnostic("is_headless", is_headless);

            if is_headless {
                result.add_diagnostic("display_info", "Virtual display may be disconnected");
            }

            result.error_message = Some(format!(
                "Cannot access desktop: {e}. This typically indicates RDP disconnection or virtual display issues."
            ));
            result.check_duration_ms = start.elapsed().as_millis() as u64;
            result.update_status();
            return result;
        }
    };

    // Step 4: Try to enumerate desktop children
    match automation.create_true_condition() {
        Ok(condition) => {
            match root_element.find_all(uiautomation::types::TreeScope::Children, &condition) {
                Ok(children) => {
                    let child_count = children.len();
                    result.add_diagnostic("desktop_child_count", child_count);
                    debug!("Found {} desktop children", child_count);

                    if child_count == 0 {
                        warn!("Desktop has no children - possible display issue");
                        result.add_diagnostic("display_warning", "Desktop has no child windows");
                        result.can_enumerate_elements = false;
                        result.error_message = Some(
                            "Desktop has no child windows - display may be disconnected"
                                .to_string(),
                        );
                    } else {
                        result.can_enumerate_elements = true;
                    }
                }
                Err(e) => {
                    error!("Failed to enumerate desktop children: {}", e);
                    result.error_message = Some(format!("Cannot enumerate UI elements: {e}"));
                }
            }
        }
        Err(e) => {
            error!("Failed to create condition for enumeration: {}", e);
            result.error_message = Some(format!("Cannot create enumeration condition: {e}"));
        }
    }

    // Additional diagnostics for virtual display
    let is_headless = crate::platforms::windows::virtual_display::is_headless_environment();
    result.add_diagnostic("is_headless", is_headless);

    if is_headless {
        // Try to get display information
        if let Ok(name) = root_element.get_name() {
            result.add_diagnostic("desktop_name", name);
        }

        // Check if we can get bounding rectangle (indicates display is properly configured)
        match root_element.get_bounding_rectangle() {
            Ok(rect) => {
                result.add_diagnostic("display_width", rect.get_width());
                result.add_diagnostic("display_height", rect.get_height());
                result.add_diagnostic("display_x", rect.get_left());
                result.add_diagnostic("display_y", rect.get_top());

                if rect.get_width() == 0 || rect.get_height() == 0 {
                    warn!("Display has zero dimensions - virtual display may be misconfigured");
                    result.add_diagnostic("display_warning", "Display has zero dimensions");
                }
            }
            Err(e) => {
                warn!(
                    "Cannot get display bounds: {} - display may be disconnected",
                    e
                );
                result.add_diagnostic(
                    "display_bounds_error",
                    format!("Cannot determine display bounds: {e}"),
                );
            }
        }
    }

    result.check_duration_ms = start.elapsed().as_millis() as u64;
    result.update_status();
    result
}
