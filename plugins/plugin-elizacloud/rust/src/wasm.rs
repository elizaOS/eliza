#![allow(missing_docs)]

use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub fn plugin_name() -> String {
    crate::PLUGIN_NAME.to_string()
}

#[wasm_bindgen]
pub fn plugin_version() -> String {
    crate::PLUGIN_VERSION.to_string()
}
