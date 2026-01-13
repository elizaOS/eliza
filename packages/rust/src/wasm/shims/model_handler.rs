//! JavaScript model handler shim.
//!
//! Wraps a JavaScript object with a `handle(params)` method to enable
//! clean model inference callbacks from Rust to JavaScript.

use js_sys::{Function, Object, Promise, Reflect};
use std::fmt::{self, Debug};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

use crate::wasm::error::WasmError;

/// A shim that wraps a JavaScript object implementing the model handler interface.
///
/// The JavaScript object must have a `handle(params: string): Promise<string>` method.
/// The params are passed as a JSON string and the response should be a JSON string.
///
/// # Example
///
/// ```javascript
/// const handler = new JsModelHandler({
///     handle: async function(paramsJson) {
///         const params = JSON.parse(paramsJson);
///         // Call your model API
///         const response = await myModelCall(params);
///         return JSON.stringify(response);
///     }
/// });
///
/// // Register with runtime
/// runtime.registerModelHandler('TEXT_LARGE', handler);
/// ```
#[wasm_bindgen]
#[derive(Clone)]
pub struct JsModelHandler {
    /// The original JavaScript object reference.
    js_object: Object,
    /// Cached reference to the handle function for performance.
    handle_func: Function,
}

impl Debug for JsModelHandler {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("JsModelHandler")
            .field("js_object", &"[Object]")
            .finish()
    }
}

#[wasm_bindgen]
impl JsModelHandler {
    /// Creates a new JsModelHandler from a JavaScript object.
    ///
    /// # Arguments
    ///
    /// * `js_object` - A JavaScript object with a `handle(params: string): Promise<string>` method.
    ///
    /// # Errors
    ///
    /// Returns an error if:
    /// - The object doesn't have a `handle` property
    /// - The `handle` property is not a function
    #[wasm_bindgen(constructor)]
    pub fn new(js_object: Object) -> Result<JsModelHandler, JsValue> {
        // Get the handle property from the object
        let handle_prop = Reflect::get(&js_object, &JsValue::from_str("handle")).map_err(|_| {
            WasmError::validation_error(
                "Object must have a 'handle' property",
                Some("handle".to_string()),
            )
            .into_js_value()
        })?;

        // Verify it's a function
        let handle_func = handle_prop.dyn_into::<Function>().map_err(|_| {
            WasmError::validation_error(
                "The 'handle' property must be a function with signature (params: string) => Promise<string>",
                Some("handle".to_string()),
            )
            .into_js_value()
        })?;

        Ok(JsModelHandler {
            js_object,
            handle_func,
        })
    }

    /// Returns the underlying JavaScript object.
    #[wasm_bindgen(getter, js_name = "jsObject")]
    pub fn js_object(&self) -> Object {
        self.js_object.clone()
    }

    /// Calls the handler with the given parameters (synchronous, for testing).
    ///
    /// Returns a Promise that resolves to the response string.
    #[wasm_bindgen(js_name = "handle")]
    pub fn handle_js(&self, params_json: &str) -> Result<Promise, JsValue> {
        let params = JsValue::from_str(params_json);
        let result = self.handle_func.call1(&self.js_object, &params)?;

        // If result is already a Promise, return it
        if result.is_instance_of::<Promise>() {
            Ok(Promise::from(result))
        } else {
            // Wrap synchronous result in a resolved Promise
            Ok(Promise::resolve(&result))
        }
    }
}

impl JsModelHandler {
    /// Calls the handler asynchronously and awaits the result.
    ///
    /// This is the primary method for Rust code to call the JS handler.
    pub async fn call(&self, params: &serde_json::Value) -> Result<String, WasmError> {
        // Serialize params to JSON
        let params_json = serde_json::to_string(params).map_err(|e| {
            WasmError::parse_error(
                format!("Failed to serialize params: {}", e),
                Some("params".to_string()),
            )
        })?;

        // Call the JS function
        let result = self
            .handle_func
            .call1(&self.js_object, &JsValue::from_str(&params_json))
            .map_err(|e| {
                WasmError::handler_error(
                    format!("JS handler call failed: {:?}", e),
                    Some("handle".to_string()),
                )
            })?;

        // Await if it's a Promise
        let result = if result.is_instance_of::<Promise>() {
            let promise = Promise::from(result);
            wasm_bindgen_futures::JsFuture::from(promise)
                .await
                .map_err(|e| {
                    WasmError::handler_error(
                        format!("JS Promise rejected: {:?}", e),
                        Some("handle".to_string()),
                    )
                })?
        } else {
            result
        };

        // Convert result to string
        result.as_string().ok_or_else(|| {
            WasmError::handler_error(
                "Handler must return a string (or Promise<string>)",
                Some("handle".to_string()),
            )
        })
    }
}

/// Creates a default model handler that returns a placeholder response.
///
/// This is useful for testing when no real model is available.
#[wasm_bindgen(js_name = "createMockModelHandler")]
pub fn create_mock_model_handler() -> Result<JsModelHandler, JsValue> {
    let code = r#"
        ({
            handle: async function(paramsJson) {
                const params = JSON.parse(paramsJson);
                return JSON.stringify({
                    text: "[Mock Response] Received prompt: " + (params.prompt || "").substring(0, 50) + "...",
                    usage: { prompt_tokens: 10, completion_tokens: 20 }
                });
            }
        })
    "#;

    let result = js_sys::eval(code).map_err(|e| {
        WasmError::internal_error(format!("Failed to create mock handler: {:?}", e)).into_js_value()
    })?;

    let obj = result.dyn_into::<Object>().map_err(|_| {
        WasmError::internal_error("Failed to create mock handler: result is not an object")
            .into_js_value()
    })?;

    JsModelHandler::new(obj)
}

#[cfg(test)]
mod tests {
    // Tests would use wasm_bindgen_test here
    // See wasm/tests/shims_test.rs for WASM-specific tests
}
