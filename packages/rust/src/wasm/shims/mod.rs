//! WebAssembly shims for JavaScript interoperability.
//!
//! These shims provide wrappers for JavaScript callbacks used by WASM bindings.

mod model_handler;

pub use model_handler::JsModelHandler;
