#![allow(missing_docs)]
//! WASM bindings for elizaOS plugin-n8n

#![cfg(feature = "wasm")]

use wasm_bindgen::prelude::*;

/// Initialize the WASM module with panic hook for better error messages
#[wasm_bindgen(start)]
pub fn init_wasm() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}
