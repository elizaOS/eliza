//! WebAssembly bindings for ElizaOS Cloud Plugin.
//!
//! This module provides JavaScript-friendly bindings for use in browser environments.

use wasm_bindgen::prelude::*;

/// Initialize panic hook for better error messages in the browser console.
#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
}

/// Plugin metadata - name
#[wasm_bindgen]
pub fn plugin_name() -> String {
    crate::PLUGIN_NAME.to_string()
}

/// Plugin metadata - version
#[wasm_bindgen]
pub fn plugin_version() -> String {
    crate::PLUGIN_VERSION.to_string()
}

