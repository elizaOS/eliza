#![allow(missing_docs)]
#![cfg(feature = "wasm")]

use js_sys;
use wasm_bindgen::prelude::*;

use crate::config::MemoryConfig;
use crate::types::{LongTermMemoryCategory, MemoryExtraction, SummaryResult};

#[wasm_bindgen(start)]
pub fn init() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub fn create_default_config() -> JsValue {
    let config = MemoryConfig::default();
    serde_json::to_string(&config)
        .ok()
        .and_then(|s| js_sys::JSON::parse(&s).ok())
        .unwrap_or(JsValue::NULL)
}

#[wasm_bindgen]
pub fn parse_memory_category(category: &str) -> Result<JsValue, JsValue> {
    category
        .parse::<LongTermMemoryCategory>()
        .map(|c| {
            serde_json::to_string(&c)
                .ok()
                .and_then(|s| js_sys::JSON::parse(&s).ok())
                .unwrap_or(JsValue::NULL)
        })
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

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

    serde_json::to_string(&extraction)
        .map_err(|_| JsValue::from_str("Failed to serialize extraction"))
        .and_then(|s| {
            js_sys::JSON::parse(&s).map_err(|_| JsValue::from_str("Failed to parse JSON"))
        })
}

#[wasm_bindgen]
pub fn create_summary_result(
    summary: &str,
    topics: Vec<JsValue>,
    key_points: Vec<JsValue>,
) -> Result<JsValue, JsValue> {
    let topics: Vec<String> = topics.into_iter().filter_map(|v| v.as_string()).collect();

    let key_points: Vec<String> = key_points
        .into_iter()
        .filter_map(|v| v.as_string())
        .collect();

    let result = SummaryResult {
        summary: summary.to_string(),
        topics,
        key_points,
    };

    serde_json::to_string(&result)
        .map_err(|_| JsValue::from_str("Failed to serialize result"))
        .and_then(|s| {
            js_sys::JSON::parse(&s).map_err(|_| JsValue::from_str("Failed to parse JSON"))
        })
}

#[wasm_bindgen]
pub fn get_plugin_info() -> JsValue {
    let info = serde_json::json!({
        "name": crate::PLUGIN_NAME,
        "description": crate::PLUGIN_DESCRIPTION,
        "version": crate::PLUGIN_VERSION,
    });
    serde_json::to_string(&info)
        .ok()
        .and_then(|s| js_sys::JSON::parse(&s).ok())
        .unwrap_or(JsValue::NULL)
}
