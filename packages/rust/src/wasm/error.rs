//! Structured WASM error types for JavaScript interoperability.

use wasm_bindgen::prelude::*;

/// Structured error type for WASM bindings.
///
/// Provides a JavaScript-friendly error object with a code, message, and source.
#[wasm_bindgen]
#[derive(Clone, Debug)]
pub struct WasmError {
    code: String,
    message: String,
    source: Option<String>,
}

#[wasm_bindgen]
impl WasmError {
    /// Returns the error code for programmatic error handling.
    #[wasm_bindgen(getter)]
    pub fn code(&self) -> String {
        self.code.clone()
    }

    /// Returns the human-readable error message.
    #[wasm_bindgen(getter)]
    pub fn message(&self) -> String {
        self.message.clone()
    }

    /// Returns the source of the error (parameter name, field, etc.), if available.
    #[wasm_bindgen(getter)]
    pub fn source(&self) -> Option<String> {
        self.source.clone()
    }

    /// Returns a formatted string representation of the error.
    #[wasm_bindgen(js_name = "toString")]
    pub fn to_string_js(&self) -> String {
        if let Some(ref src) = self.source {
            format!("[{}] {}: {}", self.code, src, self.message)
        } else {
            format!("[{}] {}", self.code, self.message)
        }
    }
}

impl WasmError {
    /// Creates a new WasmError with all fields.
    pub fn new(
        code: impl Into<String>,
        message: impl Into<String>,
        source: Option<String>,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            source,
        }
    }

    /// Creates a parse error.
    pub fn parse_error(message: impl Into<String>, source: Option<String>) -> Self {
        Self::new("PARSE_ERROR", message, source)
    }

    /// Creates a validation error.
    pub fn validation_error(message: impl Into<String>, source: Option<String>) -> Self {
        Self::new("VALIDATION_ERROR", message, source)
    }

    /// Creates a not found error.
    pub fn not_found(message: impl Into<String>, source: Option<String>) -> Self {
        Self::new("NOT_FOUND", message, source)
    }

    /// Creates a not initialized error.
    pub fn not_initialized(message: impl Into<String>) -> Self {
        Self::new("NOT_INITIALIZED", message, None)
    }

    /// Creates a handler error (JS callback failed).
    pub fn handler_error(message: impl Into<String>, source: Option<String>) -> Self {
        Self::new("HANDLER_ERROR", message, source)
    }

    /// Creates an internal error.
    pub fn internal_error(message: impl Into<String>) -> Self {
        Self::new("INTERNAL_ERROR", message, None)
    }

    /// Creates an error from a serde_json::Error.
    pub fn from_json_error(err: &serde_json::Error, source: Option<String>) -> Self {
        Self::parse_error(format!("JSON parse error: {}", err), source)
    }

    /// Converts this error to a JsValue for throwing in WASM.
    pub fn into_js_value(self) -> JsValue {
        JsValue::from(self)
    }
}

impl std::fmt::Display for WasmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.to_string_js())
    }
}

impl std::error::Error for WasmError {}

/// Extension trait for converting Results to WASM-friendly errors.
pub trait WasmResultExt<T> {
    /// Converts the error to a WasmError and returns as JsValue.
    fn to_wasm_err(self) -> Result<T, JsValue>;

    /// Converts the error to a WasmError with additional source context.
    fn to_wasm_err_with_source(self, source: &str) -> Result<T, JsValue>;
}

impl<T, E: std::fmt::Display> WasmResultExt<T> for Result<T, E> {
    fn to_wasm_err(self) -> Result<T, JsValue> {
        self.map_err(|e| WasmError::internal_error(e.to_string()).into_js_value())
    }

    fn to_wasm_err_with_source(self, source: &str) -> Result<T, JsValue> {
        self.map_err(|e| {
            WasmError::new("ERROR", e.to_string(), Some(source.to_string())).into_js_value()
        })
    }
}
