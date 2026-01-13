//! Structured WASM error types for JavaScript interoperability.
//!
//! This module provides `WasmError`, a structured error type that exposes
//! rich error information to JavaScript rather than just error strings.
//!
//! # JavaScript Usage
//!
//! ```javascript
//! try {
//!     const runtime = WasmAgentRuntime.create('invalid json');
//! } catch (e) {
//!     console.log(e.code);    // "PARSE_ERROR"
//!     console.log(e.message); // "Failed to parse character: ..."
//!     console.log(e.source);  // "character_json"
//! }
//! ```

use wasm_bindgen::prelude::*;

/// Structured error type for WASM bindings.
///
/// This provides JavaScript-friendly error information with:
/// - `code`: Error code/category for programmatic handling
/// - `message`: Human-readable error description
/// - `source`: Optional source information (parameter name, field, etc.)
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
    ///
    /// Common codes include:
    /// - `PARSE_ERROR`: JSON/data parsing failed
    /// - `VALIDATION_ERROR`: Input validation failed
    /// - `NOT_FOUND`: Resource not found
    /// - `NOT_INITIALIZED`: Runtime not initialized
    /// - `HANDLER_ERROR`: JS handler returned an error
    /// - `INTERNAL_ERROR`: Unexpected internal error
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_wasm_error_creation() {
        let err = WasmError::parse_error("invalid json", Some("character".to_string()));
        assert_eq!(err.code(), "PARSE_ERROR");
        assert_eq!(err.message(), "invalid json");
        assert_eq!(err.source(), Some("character".to_string()));
    }

    #[test]
    fn test_wasm_error_to_string() {
        let err = WasmError::parse_error("invalid json", Some("character".to_string()));
        assert_eq!(err.to_string_js(), "[PARSE_ERROR] character: invalid json");

        let err_no_source = WasmError::internal_error("something went wrong");
        assert_eq!(
            err_no_source.to_string_js(),
            "[INTERNAL_ERROR] something went wrong"
        );
    }
}
