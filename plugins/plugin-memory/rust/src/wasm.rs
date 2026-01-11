//! WebAssembly bindings for the Memory Plugin.

#![cfg(feature = "wasm")]

use wasm_bindgen::prelude::*;

use crate::types::{LongTermMemoryCategory, MemoryExtraction, SummaryResult};
use crate::config::MemoryConfig;

/// Initialize WASM module.
#[wasm_bindgen(start)]
pub fn init() {
    // Set up panic hook for better error messages
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

/// Create default memory configuration.
#[wasm_bindgen]
pub fn create_default_config() -> JsValue {
    let config = MemoryConfig::default();
    serde_wasm_bindgen::to_value(&config).unwrap_or(JsValue::NULL)
}

/// Parse memory category from string.
#[wasm_bindgen]
pub fn parse_memory_category(category: &str) -> Result<JsValue, JsValue> {
    category
        .parse::<LongTermMemoryCategory>()
        .map(|c| serde_wasm_bindgen::to_value(&c).unwrap_or(JsValue::NULL))
        .map_err(|e| JsValue::from_str(&e))
}

/// Create a memory extraction result.
#[wasm_bindgen]
pub fn create_memory_extraction(
    category: &str,
    content: &str,
    confidence: f64,
) -> Result<JsValue, JsValue> {
    let cat = category
        .parse::<LongTermMemoryCategory>()
        .map_err(|e| JsValue::from_str(&e))?;

    let extraction = MemoryExtraction {
        category: cat,
        content: content.to_string(),
        confidence,
        metadata: serde_json::json!({}),
    };

    serde_wasm_bindgen::to_value(&extraction).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Create a summary result.
#[wasm_bindgen]
pub fn create_summary_result(
    summary: &str,
    topics: Vec<JsValue>,
    key_points: Vec<JsValue>,
) -> Result<JsValue, JsValue> {
    let topics: Vec<String> = topics
        .into_iter()
        .filter_map(|v| v.as_string())
        .collect();

    let key_points: Vec<String> = key_points
        .into_iter()
        .filter_map(|v| v.as_string())
        .collect();

    let result = SummaryResult {
        summary: summary.to_string(),
        topics,
        key_points,
    };

    serde_wasm_bindgen::to_value(&result).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Get plugin metadata.
#[wasm_bindgen]
pub fn get_plugin_info() -> JsValue {
    let info = serde_json::json!({
        "name": crate::PLUGIN_NAME,
        "description": crate::PLUGIN_DESCRIPTION,
        "version": crate::PLUGIN_VERSION,
    });
    serde_wasm_bindgen::to_value(&info).unwrap_or(JsValue::NULL)
}


