//! Screenshot Logging for ComputerUse
//!
//! Saves screenshots to %LOCALAPPDATA%\mediar\workflows\{workflow_id}\executions\ (when workflow_id is set)
//! or %LOCALAPPDATA%\mediar\executions\ (standalone SDK usage).
//! Used by both MCP agent and SDK bindings.

use crate::ScreenshotResult;
use chrono::Local;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tracing::{debug, info, warn};

/// Whether screenshot logging is enabled (can be disabled via env var)
static LOGGING_ENABLED: AtomicBool = AtomicBool::new(true);
static INITIALIZED: AtomicBool = AtomicBool::new(false);

/// Get the executions directory path
/// Uses COMPUTERUSE_WORKFLOW_ID env var to determine workflow-specific folder
pub fn get_executions_dir() -> PathBuf {
    let base = dirs::data_local_dir().unwrap_or_else(std::env::temp_dir);
    match std::env::var("COMPUTERUSE_WORKFLOW_ID") {
        Ok(wf_id) => {
            debug!("[screenshot_logger] Using workflow folder: {}", wf_id);
            base.join("mediar")
                .join("workflows")
                .join(wf_id)
                .join("executions")
        }
        Err(_) => base.join("mediar").join("executions"),
    }
}

/// Initialize screenshot logging (create dir, check env var)
/// Call once at startup. Safe to call multiple times.
pub fn init() {
    if INITIALIZED.swap(true, Ordering::Relaxed) {
        return; // Already initialized
    }

    // Check if logging is disabled via env var
    if std::env::var("COMPUTERUSE_DISABLE_EXECUTION_LOGS")
        .map(|v| v == "1" || v.to_lowercase() == "true")
        .unwrap_or(false)
    {
        LOGGING_ENABLED.store(false, Ordering::Relaxed);
        info!(
            "[screenshot_logger] Screenshot logging disabled via COMPUTERUSE_DISABLE_EXECUTION_LOGS"
        );
        return;
    }

    let dir = get_executions_dir();
    if let Err(e) = fs::create_dir_all(&dir) {
        warn!("[screenshot_logger] Failed to create executions dir: {}", e);
        LOGGING_ENABLED.store(false, Ordering::Relaxed);
        return;
    }

    info!(
        "[screenshot_logger] Screenshots will be saved to: {}",
        dir.display()
    );
}

/// Check if logging is enabled
pub fn is_enabled() -> bool {
    LOGGING_ENABLED.load(Ordering::Relaxed)
}

/// Generate a timestamp-based file prefix
/// Format: YYYYMMDD_HHMMSS_context_operation
pub fn generate_prefix(context: Option<&str>, operation: &str) -> String {
    let timestamp = Local::now().format("%Y%m%d_%H%M%S").to_string();
    let ctx = context.unwrap_or("sdk");
    // Sanitize operation name
    let clean_op = operation
        .replace("::", "_")
        .replace(" ", "_")
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '_')
        .collect::<String>();
    format!("{}_{}_{}", timestamp, ctx, clean_op)
}

/// Screenshot save result
#[derive(Debug, Clone)]
pub struct SavedScreenshot {
    /// Full path to the saved file
    pub path: PathBuf,
    /// Just the filename
    pub filename: String,
}

/// Save a screenshot to the executions directory
/// Returns the path to the saved file, or None if saving failed/disabled
pub fn save_screenshot(
    screenshot: &ScreenshotResult,
    prefix: &str,
    suffix: &str,
    max_dimension: Option<u32>,
) -> Option<SavedScreenshot> {
    if !is_enabled() {
        return None;
    }

    // Ensure initialized
    if !INITIALIZED.load(Ordering::Relaxed) {
        init();
    }

    let dir = get_executions_dir();
    let filename = format!("{}_{}.jpg", prefix, suffix);
    let path = dir.join(&filename);

    // Get JPEG bytes (with optional resize) - ~4x smaller than PNG
    let jpeg_bytes = match screenshot.to_jpeg_resized(max_dimension, None) {
        Ok(bytes) => bytes,
        Err(e) => {
            warn!("[screenshot_logger] Failed to encode JPEG: {}", e);
            return None;
        }
    };

    // Write to file
    if let Err(e) = fs::write(&path, &jpeg_bytes) {
        warn!(
            "[screenshot_logger] Failed to save {}: {}",
            path.display(),
            e
        );
        return None;
    }

    info!(
        "[screenshot_logger] Saved screenshot: {} ({}KB)",
        filename,
        jpeg_bytes.len() / 1024
    );

    Some(SavedScreenshot { path, filename })
}

/// Save multiple monitor screenshots
/// Returns a vector of saved screenshot info
pub fn save_monitor_screenshots(
    screenshots: &[(crate::Monitor, ScreenshotResult)],
    prefix: &str,
    max_dimension: Option<u32>,
) -> Vec<SavedScreenshot> {
    let mut saved = Vec::new();

    for (i, (monitor, screenshot)) in screenshots.iter().enumerate() {
        let suffix = if screenshots.len() == 1 {
            "monitor".to_string()
        } else {
            format!("monitor_{}", i + 1)
        };

        if let Some(result) = save_screenshot(screenshot, prefix, &suffix, max_dimension) {
            info!(
                "[screenshot_logger] Saved monitor '{}' screenshot",
                monitor.name
            );
            saved.push(result);
        }
    }

    saved
}

/// Save a window screenshot with standard naming
pub fn save_window_screenshot(
    screenshot: &ScreenshotResult,
    prefix: &str,
    max_dimension: Option<u32>,
) -> Option<SavedScreenshot> {
    save_screenshot(screenshot, prefix, "window", max_dimension)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_prefix() {
        let prefix = generate_prefix(Some("workflow123"), "get_window_tree");
        assert!(prefix.contains("workflow123"));
        assert!(prefix.contains("get_window_tree"));

        let prefix_sdk = generate_prefix(None, "capture");
        assert!(prefix_sdk.contains("sdk"));
        assert!(prefix_sdk.contains("capture"));
    }

    #[test]
    fn test_get_executions_dir() {
        let dir = get_executions_dir();
        assert!(dir.to_string_lossy().contains("mediar"));
        assert!(dir.to_string_lossy().contains("executions"));
    }
}
