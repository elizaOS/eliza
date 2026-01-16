//! Browser script execution using Chrome extension ONLY
//!
//! Simple and clean - just uses the extension bridge, no DevTools fallback.

use crate::{AutomationError, Desktop};
use std::time::Duration;
use tracing::{debug, error, info, warn};

/// Execute JavaScript in browser using extension bridge ONLY
pub async fn execute_script(
    browser_element: &crate::UIElement,
    script: &str,
) -> Result<String, AutomationError> {
    info!("🚀 Executing JavaScript via extension bridge");
    debug!(
        script_bytes = script.len(),
        script_preview = %script.chars().take(200).collect::<String>(),
        "Preparing to execute browser script"
    );

    // Capture current focus to restore later if we have to open chrome://extensions
    let previously_focused = Desktop::new_default()
        .ok()
        .and_then(|d| d.focused_element().ok());

    // Focus the browser to ensure the extension targets the right tab
    browser_element.focus()?;
    tokio::time::sleep(Duration::from_millis(300)).await;

    // Wait for extension to connect if not already connected (tolerate worker backoff)
    let ext = crate::extension_bridge::ExtensionBridge::global().await;
    if !ext.is_client_connected().await {
        info!("Waiting for extension client to connect...");
        // Wait up to ~30s total for the client to connect after Chrome restart
        // The MV3 service worker will be auto-woken by the content-script handshake on page load/navigation.
        let mut connected = false;
        for i in 0..60 {
            // 30 seconds (60 * 500ms)
            tokio::time::sleep(Duration::from_millis(500)).await;

            if ext.is_client_connected().await {
                info!("Extension client connected after {} ms", (i + 1) * 500);
                connected = true;
                break;
            }

            if i % 6 == 5 {
                info!(
                    "Still waiting for extension client... {}s",
                    ((i + 1) * 500) / 1000
                );
            }
        }
        if !connected {
            // Don't proceed if not connected - return error immediately
            // Use warn! since this is expected when extension is not installed
            warn!("Extension client failed to connect after 30 seconds of waiting");
            if let Some(prev) = previously_focused {
                let _ = prev.activate_window();
            }
            return Err(AutomationError::PlatformError(
                "Chrome extension failed to connect after 30 seconds. Make sure Chrome extension is installed and enabled.".into(),
            ));
        }
    }

    // Ensure browser tab is active right before eval (in case focus was restored earlier)
    let _ = browser_element.focus();
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Execute via extension bridge with retry on connection issues
    // The extension might disconnect and reconnect during execution, so retry a few times
    let mut last_error = None;
    for attempt in 0..3 {
        if attempt > 0 {
            info!(
                "Retrying browser script execution (attempt {}/3)",
                attempt + 1
            );

            // Send reset command before retry to clear any stale debugger state
            info!("Sending reset command to clear debugger state before retry");
            if let Err(e) = ext.send_reset_command().await {
                warn!("Failed to send reset command: {}", e);
            }

            // Wait a bit longer after reset for state to fully clear
            tokio::time::sleep(Duration::from_millis(1500)).await;
        }

        match crate::extension_bridge::try_eval_via_extension(script, Duration::from_secs(120))
            .await
        {
            Ok(Some(result)) => {
                debug!("Received response from extension, validating result...");

                // Fix 1: Handle JavaScript Promise rejections (ERROR: prefix)
                if result.trim_start().starts_with("ERROR:") {
                    let raw = result.trim_start().trim_start_matches("ERROR:").trim();
                    // Try to parse structured JSON error
                    match serde_json::from_str::<serde_json::Value>(raw) {
                        Ok(val) => {
                            let msg = val
                                .get("message")
                                .and_then(|v| v.as_str())
                                .unwrap_or("JavaScript execution error");
                            let code = val
                                .get("code")
                                .and_then(|v| v.as_str())
                                .unwrap_or("EVAL_ERROR");
                            let _details = val
                                .get("details")
                                .and_then(|v| serde_json::to_string(v).ok());
                            error!(message = %msg, code = %code, "Browser script error (Promise rejection)");

                            // Return an actual error for Promise rejections
                            return Err(AutomationError::PlatformError(format!(
                                "JavaScript execution failed: {msg} ({code})"
                            )));
                        }
                        Err(_) => {
                            error!("Browser script error: {}", result);
                            return Err(AutomationError::PlatformError(format!(
                                "JavaScript execution error: {result}"
                            )));
                        }
                    }
                }

                // Fix 2: Handle structured error responses (success: false or status: 'failed')
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&result) {
                    // Check for explicit failure indicators in the JSON response
                    let is_failure = json.get("success") == Some(&serde_json::Value::Bool(false))
                        || json.get("status").and_then(|v| v.as_str()) == Some("failed")
                        || json.get("status").and_then(|v| v.as_str()) == Some("error");

                    if is_failure {
                        // Extract error message from various possible fields
                        let error_msg = json
                            .get("message")
                            .or_else(|| json.get("error"))
                            .or_else(|| json.get("reason"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("JavaScript returned failure status");

                        // Log additional context if available
                        if let Some(details) = json.get("set_env") {
                            debug!("Error context from JavaScript: {:?}", details);
                        }

                        error!("Browser script returned failure: {}", error_msg);

                        // Return an actual error for structured failures
                        return Err(AutomationError::PlatformError(format!(
                            "JavaScript operation failed: {error_msg}"
                        )));
                    }
                }

                // If no errors detected, return the result as success
                info!(
                    "[browser_script] Returning successful result, len={}",
                    result.len()
                );
                return Ok(result);
            }
            Ok(None) => {
                // Extension not connected, will retry
                warn!(
                    "Extension eval returned None (attempt {}/3) - extension may be reconnecting",
                    attempt + 1
                );
                last_error = Some(AutomationError::PlatformError(
                    "Extension bridge not connected. Retrying...".into(),
                ));

                // Proactively reset on connection issues
                if attempt < 2 {
                    info!("Attempting to reset debugger state due to connection issue");
                    let _ = ext.send_reset_command().await;
                }
            }
            Err(e) => {
                // Other error, save it but continue retrying
                warn!("Extension eval failed (attempt {}/3): {}", attempt + 1, e);
                last_error = Some(AutomationError::PlatformError(format!(
                    "Extension bridge error: {e}"
                )));
            }
        }
    }

    // All retries failed, return the last error
    // Use warn! since this often indicates missing extension rather than a code bug
    warn!("All browser script execution attempts failed");
    if let Some(prev) = previously_focused {
        let _ = prev.activate_window();
    }
    Err(last_error.unwrap_or_else(|| {
        AutomationError::PlatformError(
            "Extension bridge not connected after 3 attempts. Make sure Chrome extension is installed.".into(),
        )
    }))
}
