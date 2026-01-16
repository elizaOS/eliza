#![cfg(target_arch = "wasm32")]

use elizaos::wasm::{error::WasmError, shims::JsModelHandler, WasmMemory};
use js_sys::{Function, Object, Reflect};
use wasm_bindgen::JsCast;
use wasm_bindgen::JsValue;
use wasm_bindgen_futures::JsFuture;
use wasm_bindgen_test::wasm_bindgen_test;

#[wasm_bindgen_test]
fn test_wasm_error_fields() {
    let err = WasmError::parse_error("invalid json", Some("character".to_string()));
    assert_eq!(err.code(), "PARSE_ERROR");
    assert_eq!(err.message(), "invalid json");
    assert_eq!(err.source(), Some("character".to_string()));
}

#[wasm_bindgen_test]
fn test_wasm_error_to_string() {
    let err = WasmError::validation_error("bad input", Some("field".to_string()));
    assert_eq!(err.to_string_js(), "[VALIDATION_ERROR] field: bad input");
}

#[wasm_bindgen_test(async)]
async fn test_js_model_handler_call() {
    let obj = Object::new();
    let handler = Function::new_with_args("params", "return `ok:${params}`;");
    Reflect::set(&obj, &JsValue::from_str("handle"), &handler).unwrap();

    let shim = JsModelHandler::new(obj).unwrap();
    let promise = shim.handle_js("{\"prompt\":\"hello\"}").unwrap();
    let result = JsFuture::from(promise).await.unwrap();
    let result_str = result.as_string().unwrap_or_default();
    assert!(result_str.contains("ok:"));
}

#[wasm_bindgen_test]
fn test_wasm_memory_round_trip() {
    let json = r#"{"entityId":"entity-1","roomId":"room-1","content":{"text":"hi"}}"#;
    let memory = WasmMemory::from_json(json).unwrap();
    let serialized = memory.to_json().unwrap();
    assert!(serialized.contains("\"entityId\""));
}
