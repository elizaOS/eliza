//! WebAssembly shims for JavaScript interoperability.
//!
//! This module provides wrappers that allow JavaScript objects/functions to
//! implement Rust interfaces cleanly. These patterns enable type-safe callbacks
//! between JavaScript and Rust code.
//!
//! # Shim Types
//!
//! - [`JsModelHandler`]: Wraps a JS function for model inference calls
//! - [`JsEventHandler`]: Wraps a JS function for event callbacks
//!
//! # Usage from JavaScript
//!
//! ```javascript
//! import { JsModelHandler, WasmAgentRuntime } from 'elizaos';
//!
//! // Create a model handler
//! const handler = new JsModelHandler({
//!     handle: async (params) => {
//!         // Call your LLM API here
//!         const response = await fetch('https://api.openai.com/...', { ... });
//!         return await response.text();
//!     }
//! });
//!
//! // Register it with the runtime
//! runtime.registerModelHandler('TEXT_LARGE', handler);
//! ```

mod model_handler;

pub use model_handler::{create_mock_model_handler, JsModelHandler};


