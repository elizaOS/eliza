use wasm_bindgen::prelude::*;

/// Initializes the WebAssembly module.
///
/// This function is automatically called when the WASM module is loaded.
/// It sets up the panic hook for better error messages in the browser console.
#[wasm_bindgen(start)]
pub fn init_wasm() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}
