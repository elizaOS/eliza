#![allow(missing_docs)]
//! WASM helpers for elizaOS plugin-sql
//!
//! Note: Higher-level typed row bindings were previously defined here, but the
//! underlying `schema` module currently exposes `*Record` structs intended for
//! database operations rather than stable JSON row DTOs. Until those DTOs exist,
//! we keep WASM exports minimal and correct.

#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;

/// Initialize the WASM module with panic hook for better error messages
#[cfg(feature = "wasm")]
#[wasm_bindgen(start)]
pub fn init_wasm() {
    console_error_panic_hook::set_once();
}

/// Simple JSON round-trip helper for interop tests.
#[cfg(feature = "wasm")]
#[wasm_bindgen(js_name = "testJsonRoundTrip")]
pub fn test_json_round_trip(json: &str) -> Result<bool, JsValue> {
    let value: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse JSON: {e}")))?;
    let serialized =
        serde_json::to_string(&value).map_err(|e| JsValue::from_str(&format!("Failed to serialize JSON: {e}")))?;
    let reparsed: serde_json::Value = serde_json::from_str(&serialized)
        .map_err(|e| JsValue::from_str(&format!("Failed to reparse JSON: {e}")))?;
    Ok(value == reparsed)
}

/// Get the version of the plugin
#[cfg(feature = "wasm")]
#[wasm_bindgen(js_name = "getVersion")]
pub fn get_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
