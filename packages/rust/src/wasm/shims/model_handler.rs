//! JavaScript model handler shim.

use js_sys::{Function, Object, Promise, Reflect};
use std::fmt::{self, Debug};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

use crate::wasm::error::WasmError;

/// A shim that wraps a JavaScript object implementing a model handler.
///
/// The JavaScript object must have a `handle(params: string): Promise<string>` method
/// that returns the generated text response as a string.
#[wasm_bindgen]
#[derive(Clone)]
pub struct JsModelHandler {
    js_object: Object,
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
    #[wasm_bindgen(constructor)]
    pub fn new(js_object: Object) -> Result<JsModelHandler, JsValue> {
        let handle_prop = Reflect::get(&js_object, &JsValue::from_str("handle")).map_err(|_| {
            WasmError::validation_error(
                "Object must have a 'handle' property",
                Some("handle".to_string()),
            )
            .into_js_value()
        })?;

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

    /// Calls the handler with the given parameters.
    #[wasm_bindgen(js_name = "handle")]
    pub fn handle_js(&self, params_json: &str) -> Result<Promise, JsValue> {
        let params = JsValue::from_str(params_json);
        let result = self.handle_func.call1(&self.js_object, &params)?;

        if result.is_instance_of::<Promise>() {
            Ok(Promise::from(result))
        } else {
            Ok(Promise::resolve(&result))
        }
    }
}

impl JsModelHandler {
    /// Calls the handler asynchronously and awaits the result.
    pub async fn call(&self, params: &serde_json::Value) -> Result<String, WasmError> {
        let params_json = serde_json::to_string(params).map_err(|e| {
            WasmError::parse_error(
                format!("Failed to serialize params: {}", e),
                Some("params".to_string()),
            )
        })?;

        let result = self
            .handle_func
            .call1(&self.js_object, &JsValue::from_str(&params_json))
            .map_err(|e| {
                WasmError::handler_error(
                    format!("JS handler call failed: {:?}", e),
                    Some("handle".to_string()),
                )
            })?;

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

        result.as_string().ok_or_else(|| {
            WasmError::validation_error(
                "JS handler must return a string",
                Some("handle".to_string()),
            )
        })
    }
}
