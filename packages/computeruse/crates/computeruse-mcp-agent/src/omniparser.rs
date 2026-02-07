use anyhow::{anyhow, Result};
use serde::Deserialize;
use std::env;
use tracing::{debug, info, warn};

// Re-export from core computeruse crate
pub use computeruse::OmniparserItem;

/// Element as returned by the web backend (normalized coordinates)
#[derive(Debug, Deserialize)]
struct BackendElement {
    #[serde(rename = "type")]
    element_type: String,
    bbox: [f64; 4], // normalized 0-1 [x1, y1, x2, y2]
    #[allow(dead_code)]
    interactivity: bool,
    content: String,
}

/// Response from the web backend
#[derive(Debug, Deserialize)]
struct BackendResponse {
    elements: Vec<BackendElement>,
    #[allow(dead_code)]
    annotated_image_url: Option<String>,
    #[allow(dead_code)]
    prediction_id: Option<String>,
    #[allow(dead_code)]
    duration_ms: Option<u64>,
    error: Option<String>,
}

/// Parse an image using the OmniParser web backend.
///
/// # Arguments
/// * `base64_image` - Base64 encoded PNG image
/// * `image_width` - Width of the image in pixels (for coordinate conversion)
/// * `image_height` - Height of the image in pixels (for coordinate conversion)
/// * `imgsz` - Optional icon detection image size (640-1920, default 640). Higher = better detection but slower.
///
/// # Returns
/// * `Ok((items, raw_json))` - Parsed items with absolute pixel coordinates
/// * `Err(e)` - If the request fails
pub async fn parse_image_with_backend(
    base64_image: &str,
    image_width: u32,
    image_height: u32,
    imgsz: Option<u32>,
) -> Result<(Vec<OmniparserItem>, String)> {
    let backend_url = env::var("OMNIPARSER_BACKEND_URL")
        .unwrap_or_else(|_| "https://app.mediar.ai/api/omniparser/parse".to_string());

    let imgsz_val = imgsz.unwrap_or(1920).clamp(640, 1920);

    info!(
        "Calling OmniParser backend at {} (image: {}x{}, imgsz: {})",
        backend_url, image_width, image_height, imgsz_val
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300)) // 5 minute timeout to match backend
        .build()?;

    let payload = serde_json::json!({
        "image": base64_image,
        "imgsz": imgsz_val
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
        warn!("OmniParser backend error: {} - {}", status, text);
        return Err(anyhow!("OmniParser backend error ({}): {}", status, text));
    }

    let response_text = resp.text().await?;
    debug!(
        "OmniParser backend response: {}",
        &response_text[..response_text.len().min(500)]
    );

    let backend_response: BackendResponse = serde_json::from_str(&response_text)
        .map_err(|e| anyhow!("Failed to parse backend response: {}", e))?;

    if let Some(error) = backend_response.error {
        return Err(anyhow!("OmniParser error: {}", error));
    }

    // Convert backend elements to OmniparserItem with absolute pixel coordinates
    let items: Vec<OmniparserItem> = backend_response
        .elements
        .into_iter()
        .map(|elem| {
            // Convert normalized 0-1 coordinates to absolute pixels
            let [x1, y1, x2, y2] = elem.bbox;
            let px_x1 = x1 * image_width as f64;
            let px_y1 = y1 * image_height as f64;
            let px_x2 = x2 * image_width as f64;
            let px_y2 = y2 * image_height as f64;

            OmniparserItem {
                label: elem.element_type,
                content: Some(elem.content),
                box_2d: Some([px_x1, px_y1, px_x2, px_y2]),
            }
        })
        .collect();

    info!("OmniParser detected {} elements", items.len());

    Ok((items, response_text))
}

/// Legacy function for backward compatibility - calls the new backend
/// Uses default image dimensions if not known (will need actual dimensions for accuracy)
#[allow(dead_code)]
pub async fn parse_image_with_replicate(
    base64_image: &str,
) -> Result<(Vec<OmniparserItem>, String)> {
    // Default to common screen resolution - caller should use parse_image_with_backend directly
    warn!("parse_image_with_replicate is deprecated, use parse_image_with_backend with image dimensions");
    parse_image_with_backend(base64_image, 1920, 1080, None).await
}
