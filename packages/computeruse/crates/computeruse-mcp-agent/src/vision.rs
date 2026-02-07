use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::env;
use tracing::{debug, info, warn};

// Re-export from core computeruse crate
pub use computeruse::VisionElement;

/// Element as returned by the vision backend (normalized coordinates)
#[derive(Debug, Deserialize)]
struct BackendElement {
    #[serde(rename = "type")]
    element_type: String,
    bbox: [f64; 4], // normalized 0-1 [x1, y1, x2, y2]
    #[serde(default)]
    interactivity: Option<bool>,
    content: String,
    description: String,
}

/// Response from the vision backend
#[derive(Debug, Deserialize)]
struct BackendResponse {
    elements: Vec<BackendElement>,
    #[allow(dead_code)]
    duration_ms: Option<u64>,
    #[allow(dead_code)]
    model_used: Option<String>,
    error: Option<String>,
}

/// Parse an image using the Gemini vision model via web backend.
///
/// # Arguments
/// * `base64_image` - Base64 encoded PNG image
/// * `image_width` - Width of the image in pixels (for coordinate conversion)
/// * `image_height` - Height of the image in pixels (for coordinate conversion)
///
/// # Returns
/// * `Ok((items, raw_json))` - Parsed items with absolute pixel coordinates
/// * `Err(e)` - If the request fails
pub async fn parse_image_with_gemini(
    base64_image: &str,
    image_width: u32,
    image_height: u32,
) -> Result<(Vec<VisionElement>, String)> {
    let backend_url = env::var("GEMINI_VISION_BACKEND_URL")
        .unwrap_or_else(|_| "https://app.mediar.ai/api/vision/parse".to_string());

    info!(
        "Calling Gemini Vision backend at {} (image: {}x{})",
        backend_url, image_width, image_height
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300)) // 5 minute timeout
        .build()?;

    let payload = serde_json::json!({
        "image": base64_image,
        "model": "gemini",
        "prompt": crate::prompt::get_vision_prompt()
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
        warn!("Gemini Vision backend error: {} - {}", status, text);
        return Err(anyhow!(
            "Gemini Vision backend error ({}): {}",
            status,
            text
        ));
    }

    let response_text = resp.text().await?;
    debug!(
        "Gemini Vision backend response: {}",
        &response_text[..response_text.len().min(500)]
    );

    let backend_response: BackendResponse = serde_json::from_str(&response_text)
        .map_err(|e| anyhow!("Failed to parse backend response: {}", e))?;

    if let Some(error) = backend_response.error {
        return Err(anyhow!("Gemini Vision error: {}", error));
    }

    // Convert backend elements to VisionElement with absolute pixel coordinates
    let items: Vec<VisionElement> = backend_response
        .elements
        .into_iter()
        .map(|elem| {
            // Convert normalized 0-1 coordinates to absolute pixels
            let [x1, y1, x2, y2] = elem.bbox;
            let px_x1 = x1 * image_width as f64;
            let px_y1 = y1 * image_height as f64;
            let px_x2 = x2 * image_width as f64;
            let px_y2 = y2 * image_height as f64;

            VisionElement {
                element_type: elem.element_type,
                content: if elem.content.is_empty() {
                    None
                } else {
                    Some(elem.content)
                },
                description: if elem.description.is_empty() {
                    None
                } else {
                    Some(elem.description)
                },
                box_2d: Some([px_x1, px_y1, px_x2, px_y2]),
                interactivity: elem.interactivity,
            }
        })
        .collect();

    info!("Gemini Vision detected {} elements", items.len());

    Ok((items, response_text))
}

// ===== Computer Use Types and Client =====

/// Function call from Gemini Computer Use model (native API format)
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ComputerUseFunctionCall {
    pub name: String,
    #[serde(default)]
    pub args: serde_json::Value,
    pub id: Option<String>,
}

/// Response from Computer Use - either completed or needs action
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
    pub name: String,
    pub response: ComputerUseActionResponse,
    pub screenshot: String, // base64 PNG
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>, // Current page URL (required by Gemini Computer Use)
}

/// Response for a previous action
#[derive(Debug, Serialize, Clone)]
pub struct ComputerUseActionResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Backend response structure (matches route.ts ComputerUseResponse)
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

/// Call the Gemini Computer Use backend to get the next action.
///
/// Uses the native Gemini Computer Use API with function calling.
///
/// # Arguments
/// * `base64_image` - Base64 encoded PNG screenshot
/// * `goal` - What the user wants to achieve
/// * `previous_actions` - Previous actions taken with their screenshots
///
/// # Returns
/// * `Ok(response)` - Response indicating completion or next action
/// * `Err(e)` - If the request fails
pub async fn call_computer_use_backend(
    base64_image: &str,
    goal: &str,
    previous_actions: Option<&[ComputerUsePreviousAction]>,
) -> Result<ComputerUseResponse> {
    let backend_url = env::var("GEMINI_COMPUTER_USE_BACKEND_URL")
        .unwrap_or_else(|_| "https://app.mediar.ai/api/vision/computer-use".to_string());

    info!(
        "Calling Computer Use backend at {} (goal: {})",
        backend_url,
        &goal[..goal.len().min(50)]
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
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
        warn!("Computer Use backend error: {} - {}", status, text);
        return Err(anyhow!("Computer Use backend error ({}): {}", status, text));
    }

    let response_text = resp.text().await?;
    debug!(
        "Computer Use backend response: {}",
        &response_text[..response_text.len().min(500)]
    );

    let backend_response: ComputerUseBackendResponse = serde_json::from_str(&response_text)
        .map_err(|e| anyhow!("Failed to parse backend response: {}", e))?;

    if let Some(error) = backend_response.error {
        return Err(anyhow!("Computer Use error: {}", error));
    }

    if backend_response.completed {
        info!(
            "Computer Use completed. Text: {}",
            backend_response.text.as_deref().unwrap_or("none")
        );
    } else if let Some(ref fc) = backend_response.function_call {
        info!(
            "Computer Use action: {} (text: {})",
            fc.name,
            backend_response.text.as_deref().unwrap_or("none")
        );
    }

    Ok(ComputerUseResponse {
        completed: backend_response.completed,
        function_call: backend_response.function_call,
        text: backend_response.text,
        safety_decision: backend_response.safety_decision,
    })
}
