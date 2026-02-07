//! Gemini Computer Use - AI-powered autonomous desktop automation
//!
//! This crate provides types and utilities for the Gemini Computer Use feature,
//! which uses vision models to autonomously control desktop applications.
//!
//! The actual Desktop integration lives in `computeruse-rs`, which re-exports
//! and extends this crate's functionality.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::env;
use std::time::Duration;
use tracing::{debug, info, warn};

// ===== Public Types =====

/// Function call from Gemini Computer Use model
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ComputerUseFunctionCall {
    /// Name of the action (e.g., "click_at", "type_text_at", "scroll_document")
    pub name: String,
    /// Arguments for the action
    #[serde(default)]
    pub args: serde_json::Value,
    /// Optional ID for the function call
    pub id: Option<String>,
}

/// Response from Computer Use backend
#[derive(Debug, Clone)]
pub struct ComputerUseResponse {
    /// True if task is complete (no more actions needed)
    pub completed: bool,
    /// Function call if action is needed
    pub function_call: Option<ComputerUseFunctionCall>,
    /// Text response from model (reasoning or final answer)
    pub text: Option<String>,
    /// Safety decision if confirmation required
    pub safety_decision: Option<String>,
}

/// Previous action to send back with screenshot (for multi-step)
#[derive(Debug, Serialize, Clone)]
pub struct ComputerUsePreviousAction {
    /// Action name that was executed
    pub name: String,
    /// Result of the action
    pub response: ComputerUseActionResponse,
    /// Screenshot after action (base64 PNG)
    pub screenshot: String,
    /// Current page URL (for browser contexts)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// Response for a previous action
#[derive(Debug, Serialize, Clone)]
pub struct ComputerUseActionResponse {
    /// Whether the action succeeded
    pub success: bool,
    /// Error message if action failed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// A single step in the computer use execution
#[derive(Debug, Clone, Serialize)]
pub struct ComputerUseStep {
    /// Step number (1-indexed)
    pub step: u32,
    /// Action that was executed
    pub action: String,
    /// Arguments passed to the action
    pub args: serde_json::Value,
    /// Whether the action succeeded
    pub success: bool,
    /// Error message if action failed
    pub error: Option<String>,
    /// Model's reasoning text for this step
    pub text: Option<String>,
}

/// Result of the computer use execution
#[derive(Debug, Clone, Serialize)]
pub struct ComputerUseResult {
    /// Status: "success", "failed", "needs_confirmation", "max_steps_reached"
    pub status: String,
    /// The goal that was attempted
    pub goal: String,
    /// Number of steps executed
    pub steps_executed: u32,
    /// Last action performed
    pub final_action: String,
    /// Final text response from model
    pub final_text: Option<String>,
    /// History of all steps
    pub steps: Vec<ComputerUseStep>,
    /// Pending confirmation info if status is "needs_confirmation"
    pub pending_confirmation: Option<serde_json::Value>,
    /// Execution ID for finding screenshots (e.g., "20251205_134500_geminiComputerUse_msedge")
    pub execution_id: Option<String>,
}

/// Callback for progress updates during computer use execution
pub type ProgressCallback = Box<dyn Fn(&ComputerUseStep) + Send + Sync>;

// ===== Internal Types =====

/// Backend response structure
#[derive(Debug, Deserialize)]
struct ComputerUseBackendResponse {
    completed: bool,
    #[serde(default)]
    function_call: Option<ComputerUseFunctionCall>,
    text: Option<String>,
    safety_decision: Option<String>,
    #[allow(dead_code)]
    duration_ms: Option<u64>,
    #[allow(dead_code)]
    model_used: Option<String>,
    error: Option<String>,
}

// ===== Backend API =====

/// Call the Gemini Computer Use backend to get the next action.
///
/// This is the main API for communicating with the vision model backend.
/// It sends a screenshot and goal, optionally with previous actions,
/// and receives either a completion signal or the next action to take.
///
/// # Arguments
/// * `base64_image` - Base64 encoded PNG screenshot
/// * `goal` - The task to accomplish
/// * `previous_actions` - History of previous actions with their results
///
/// # Returns
/// * `Ok(ComputerUseResponse)` - The model's response
/// * `Err(e)` - If the backend call fails
pub async fn call_computer_use_backend(
    base64_image: &str,
    goal: &str,
    previous_actions: Option<&[ComputerUsePreviousAction]>,
) -> Result<ComputerUseResponse> {
    let backend_url = env::var("GEMINI_COMPUTER_USE_BACKEND_URL")
        .unwrap_or_else(|_| "https://app.mediar.ai/api/vision/computer-use".to_string());

    info!(
        "[computer_use] Calling backend at {} (goal: {})",
        backend_url,
        &goal[..goal.len().min(50)]
    );

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()?;

    let payload = serde_json::json!({
        "image": base64_image,
        "goal": goal,
        "previous_actions": previous_actions.unwrap_or(&[])
    });

    let resp = client
        .post(&backend_url)
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        warn!("[computer_use] Backend error: {} - {}", status, text);
        return Err(anyhow!("Computer Use backend error ({}): {}", status, text));
    }

    let response_text = resp.text().await?;
    debug!(
        "[computer_use] Backend response: {}",
        &response_text[..response_text.len().min(500)]
    );

    let backend_response: ComputerUseBackendResponse = serde_json::from_str(&response_text)
        .map_err(|e| anyhow!("Failed to parse backend response: {}", e))?;

    if let Some(error) = backend_response.error {
        return Err(anyhow!("Computer Use error: {}", error));
    }

    Ok(ComputerUseResponse {
        completed: backend_response.completed,
        function_call: backend_response.function_call,
        text: backend_response.text,
        safety_decision: backend_response.safety_decision,
    })
}

// ===== Key Translation =====

/// Translate Gemini Computer Use key format to uiautomation format.
///
/// Gemini format: "enter", "control+a", "Meta+Shift+T"
/// uiautomation format: "{Enter}", "{Ctrl}a", "{Win}{Shift}t"
///
/// # Arguments
/// * `gemini_keys` - Key combination in Gemini format
///
/// # Returns
/// * `Ok(String)` - Translated key string for uiautomation
/// * `Err(String)` - If the key format is invalid
pub fn translate_gemini_keys(gemini_keys: &str) -> Result<String, String> {
    let parts: Vec<&str> = gemini_keys.split('+').collect();
    let mut result = String::new();

    for (i, part) in parts.iter().enumerate() {
        let lower = part.trim().to_lowercase();
        let is_last = i == parts.len() - 1;

        let translated: &str = match lower.as_str() {
            // Modifiers
            "control" | "ctrl" => "{Ctrl}",
            "alt" => "{Alt}",
            "shift" => "{Shift}",
            "meta" | "cmd" | "command" | "win" | "windows" | "super" => "{Win}",

            // Common special keys
            "enter" | "return" => "{Enter}",
            "tab" => "{Tab}",
            "escape" | "esc" => "{Escape}",
            "backspace" | "back" => "{Backspace}",
            "delete" | "del" => "{Delete}",
            "space" => "{Space}",
            "insert" | "ins" => "{Insert}",
            "home" => "{Home}",
            "end" => "{End}",
            "pageup" | "pgup" => "{PageUp}",
            "pagedown" | "pgdown" | "pgdn" => "{PageDown}",
            "printscreen" | "prtsc" => "{PrintScreen}",

            // Arrow keys
            "up" | "arrowup" => "{Up}",
            "down" | "arrowdown" => "{Down}",
            "left" | "arrowleft" => "{Left}",
            "right" | "arrowright" => "{Right}",

            // Function keys - check for f1-f24
            s if s.starts_with('f') && s.len() >= 2 => {
                if let Ok(num) = s[1..].parse::<u8>() {
                    if (1..=24).contains(&num) {
                        match num {
                            1 => "{F1}",
                            2 => "{F2}",
                            3 => "{F3}",
                            4 => "{F4}",
                            5 => "{F5}",
                            6 => "{F6}",
                            7 => "{F7}",
                            8 => "{F8}",
                            9 => "{F9}",
                            10 => "{F10}",
                            11 => "{F11}",
                            12 => "{F12}",
                            13 => "{F13}",
                            14 => "{F14}",
                            15 => "{F15}",
                            16 => "{F16}",
                            17 => "{F17}",
                            18 => "{F18}",
                            19 => "{F19}",
                            20 => "{F20}",
                            21 => "{F21}",
                            22 => "{F22}",
                            23 => "{F23}",
                            24 => "{F24}",
                            _ => unreachable!(),
                        }
                    } else {
                        return Err(format!(
                            "Invalid function key '{}' in '{}'. Use f1-f24.",
                            part, gemini_keys
                        ));
                    }
                } else {
                    return Err(format!(
                        "Invalid function key '{}' in '{}'. Use f1-f24.",
                        part, gemini_keys
                    ));
                }
            }

            // Single character (a-z, 0-9) - only valid as last part of combination
            s if s.len() == 1 && is_last => {
                result.push_str(s);
                continue;
            }

            // Unknown key
            unknown => {
                return Err(format!(
                    "Unknown key '{}' in combination '{}'. Valid: enter, tab, escape, \
                     backspace, delete, space, up/down/left/right, home, end, pageup, \
                     pagedown, f1-f24, or modifiers (ctrl, alt, shift, meta) with letters.",
                    unknown, gemini_keys
                ));
            }
        };

        result.push_str(translated);
    }

    Ok(result)
}

// ===== Coordinate Conversion =====

/// Convert normalized coordinates (0-999) to absolute screen coordinates.
///
/// The Gemini model outputs coordinates in a normalized 0-999 range.
/// This function converts them to actual screen pixel coordinates,
/// accounting for window position, DPI scaling, and any resize scaling.
///
/// # Arguments
/// * `norm_x` - Normalized X coordinate (0-999)
/// * `norm_y` - Normalized Y coordinate (0-999)
/// * `window_x` - Window X position on screen
/// * `window_y` - Window Y position on screen
/// * `screenshot_w` - Screenshot width in pixels
/// * `screenshot_h` - Screenshot height in pixels
/// * `dpi_scale` - DPI scale factor
/// * `resize_scale` - Resize scale factor (if image was resized for model)
///
/// # Returns
/// Tuple of (screen_x, screen_y) absolute coordinates
#[allow(clippy::too_many_arguments)]
pub fn convert_normalized_to_screen(
    norm_x: f64,
    norm_y: f64,
    window_x: f64,
    window_y: f64,
    screenshot_w: f64,
    screenshot_h: f64,
    dpi_scale: f64,
    resize_scale: f64,
) -> (f64, f64) {
    // Convert 0-999 to screenshot pixels
    let px_x = (norm_x / 1000.0) * screenshot_w;
    let px_y = (norm_y / 1000.0) * screenshot_h;
    // Apply inverse resize scale
    let px_x = px_x / resize_scale;
    let px_y = px_y / resize_scale;
    // Apply DPI conversion (physical to logical)
    let logical_x = px_x / dpi_scale;
    let logical_y = px_y / dpi_scale;
    // Add window offset
    let screen_x = window_x + logical_x;
    let screen_y = window_y + logical_y;
    (screen_x, screen_y)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_translate_gemini_keys_simple() {
        assert_eq!(translate_gemini_keys("enter").unwrap(), "{Enter}");
        assert_eq!(translate_gemini_keys("tab").unwrap(), "{Tab}");
        assert_eq!(translate_gemini_keys("escape").unwrap(), "{Escape}");
    }

    #[test]
    fn test_translate_gemini_keys_modifiers() {
        assert_eq!(translate_gemini_keys("control+a").unwrap(), "{Ctrl}a");
        assert_eq!(translate_gemini_keys("ctrl+c").unwrap(), "{Ctrl}c");
        assert_eq!(
            translate_gemini_keys("Meta+Shift+T").unwrap(),
            "{Win}{Shift}t"
        );
    }

    #[test]
    fn test_translate_gemini_keys_function() {
        assert_eq!(translate_gemini_keys("f1").unwrap(), "{F1}");
        assert_eq!(translate_gemini_keys("f12").unwrap(), "{F12}");
        assert_eq!(translate_gemini_keys("alt+f4").unwrap(), "{Alt}{F4}");
    }

    #[test]
    fn test_convert_normalized_coords() {
        // Simple case: no scaling, window at origin
        let (x, y) = convert_normalized_to_screen(500.0, 500.0, 0.0, 0.0, 1000.0, 1000.0, 1.0, 1.0);
        assert!((x - 500.0).abs() < 0.001);
        assert!((y - 500.0).abs() < 0.001);

        // With window offset
        let (x, y) =
            convert_normalized_to_screen(500.0, 500.0, 100.0, 200.0, 1000.0, 1000.0, 1.0, 1.0);
        assert!((x - 600.0).abs() < 0.001);
        assert!((y - 700.0).abs() < 0.001);
    }
}
