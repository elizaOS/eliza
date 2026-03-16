#![allow(missing_docs)]

use crate::{generate_response, reflect, ElizaClassicPlugin};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub name: String,
    pub description: String,
    pub version: String,
    pub language: String,
    pub interop_protocols: Vec<String>,
    pub actions: Vec<ActionManifest>,
    pub providers: Vec<ProviderManifest>,
    pub evaluators: Vec<EvaluatorManifest>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionManifest {
    pub name: String,
    pub description: String,
    pub similes: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderManifest {
    pub name: String,
    pub description: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluatorManifest {
    pub name: String,
    pub description: String,
}

impl Default for PluginManifest {
    fn default() -> Self {
        Self {
            name: "eliza-classic".to_string(),
            description: "Classic ELIZA pattern matching - no LLM required".to_string(),
            version: "1.0.0".to_string(),
            language: "rust".to_string(),
            interop_protocols: vec!["wasm".to_string(), "ffi".to_string(), "ipc".to_string()],
            actions: vec![ActionManifest {
                name: "generate-response".to_string(),
                description: "Generate an ELIZA response for user input".to_string(),
                similes: vec![
                    "chat".to_string(),
                    "respond".to_string(),
                    "eliza".to_string(),
                    "talk".to_string(),
                ],
            }],
            providers: vec![ProviderManifest {
                name: "eliza-greeting".to_string(),
                description: "Provides the ELIZA greeting message".to_string(),
            }],
            evaluators: vec![],
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<HashMap<String, serde_json::Value>>,
}

impl ActionResult {
    pub fn success_with_text(text: &str) -> Self {
        Self {
            success: true,
            text: Some(text.to_string()),
            error: None,
            data: None,
        }
    }

    pub fn failure(error: &str) -> Self {
        Self {
            success: false,
            text: None,
            error: Some(error.to_string()),
            data: None,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub values: Option<HashMap<String, serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<HashMap<String, serde_json::Value>>,
}

lazy_static::lazy_static! {
    static ref PLUGIN_INSTANCE: Mutex<ElizaClassicPlugin> = Mutex::new(ElizaClassicPlugin::new());
}

pub fn get_manifest_json() -> String {
    serde_json::to_string(&PluginManifest::default())
        .unwrap_or_else(|e| format!(r#"{{"error": "{}"}}"#, e))
}

pub fn init_plugin(config_json: &str) -> Result<(), String> {
    if !config_json.is_empty() && config_json != "null" && config_json != "{}" {
        if let Ok(config) = serde_json::from_str::<crate::ElizaConfig>(config_json) {
            let mut instance = PLUGIN_INSTANCE.lock().map_err(|e| e.to_string())?;
            *instance = ElizaClassicPlugin::with_config(config);
        }
    }
    Ok(())
}

pub fn validate_action(name: &str, _memory_json: &str, _state_json: &str) -> bool {
    name == "generate-response"
}

pub fn invoke_action(
    name: &str,
    memory_json: &str,
    _state_json: &str,
    options_json: &str,
) -> ActionResult {
    if name != "generate-response" {
        return ActionResult::failure(&format!("Unknown action: {}", name));
    }

    // Try to extract user input from memory or options
    let input = extract_user_input(memory_json, options_json);

    if input.is_empty() {
        return ActionResult::failure("No user input provided");
    }

    let instance = match PLUGIN_INSTANCE.lock() {
        Ok(i) => i,
        Err(e) => return ActionResult::failure(&e.to_string()),
    };

    let response = instance.generate_response(&input);
    ActionResult::success_with_text(&response)
}

pub fn get_provider(name: &str, _memory_json: &str, _state_json: &str) -> ProviderResult {
    if name == "eliza-greeting" {
        let instance = match PLUGIN_INSTANCE.lock() {
            Ok(i) => i,
            Err(_) => return ProviderResult::default(),
        };
        ProviderResult {
            text: Some(instance.get_greeting()),
            values: None,
            data: None,
        }
    } else {
        ProviderResult::default()
    }
}

pub fn validate_evaluator(_name: &str, _memory_json: &str, _state_json: &str) -> bool {
    false
}

pub fn invoke_evaluator(
    _name: &str,
    _memory_json: &str,
    _state_json: &str,
) -> Option<ActionResult> {
    None
}

fn extract_user_input(memory_json: &str, options_json: &str) -> String {
    if let Ok(options) = serde_json::from_str::<serde_json::Value>(options_json) {
        if let Some(input) = options.get("input").and_then(|v| v.as_str()) {
            return input.to_string();
        }
        if let Some(prompt) = options.get("prompt").and_then(|v| v.as_str()) {
            return prompt.to_string();
        }
        if let Some(text) = options.get("text").and_then(|v| v.as_str()) {
            return text.to_string();
        }
    }

    if let Ok(memory) = serde_json::from_str::<serde_json::Value>(memory_json) {
        if let Some(content) = memory.get("content") {
            if let Some(text) = content.get("text").and_then(|v| v.as_str()) {
                return text.to_string();
            }
        }
    }

    String::new()
}

#[cfg(feature = "wasm")]
pub mod wasm {
    use super::*;
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen(start)]
    pub fn wasm_init() {
        console_error_panic_hook::set_once();
    }

    #[wasm_bindgen]
    pub fn get_manifest() -> String {
        get_manifest_json()
    }

    #[wasm_bindgen]
    pub fn init(config_json: &str) {
        let _ = init_plugin(config_json);
    }

    #[wasm_bindgen]
    pub fn wasm_validate_action(name: &str, memory_json: &str, state_json: &str) -> bool {
        validate_action(name, memory_json, state_json)
    }

    #[wasm_bindgen]
    pub fn wasm_invoke_action(
        name: &str,
        memory_json: &str,
        state_json: &str,
        options_json: &str,
    ) -> String {
        let result = invoke_action(name, memory_json, state_json, options_json);
        serde_json::to_string(&result)
            .unwrap_or_else(|e| format!(r#"{{"success": false, "error": "{}"}}"#, e))
    }

    #[wasm_bindgen]
    pub fn wasm_get_provider(name: &str, memory_json: &str, state_json: &str) -> String {
        let result = get_provider(name, memory_json, state_json);
        serde_json::to_string(&result).unwrap_or_else(|_| "{}".to_string())
    }

    #[wasm_bindgen]
    pub fn wasm_validate_evaluator(name: &str, memory_json: &str, state_json: &str) -> bool {
        validate_evaluator(name, memory_json, state_json)
    }

    #[wasm_bindgen]
    pub fn wasm_invoke_evaluator(name: &str, memory_json: &str, state_json: &str) -> String {
        match invoke_evaluator(name, memory_json, state_json) {
            Some(result) => serde_json::to_string(&result).unwrap_or_else(|_| "null".to_string()),
            None => "null".to_string(),
        }
    }

    #[wasm_bindgen]
    pub fn generate_eliza_response(input: &str) -> String {
        generate_response(input)
    }

    #[wasm_bindgen]
    pub fn reflect_pronouns(text: &str) -> String {
        reflect(text)
    }

    #[wasm_bindgen]
    pub fn alloc(size: usize) -> *mut u8 {
        let mut buf = Vec::with_capacity(size);
        let ptr = buf.as_mut_ptr();
        std::mem::forget(buf);
        ptr
    }

    /// Deallocates memory previously allocated by `alloc`.
    ///
    /// # Safety
    ///
    /// - `ptr` must have been allocated by `alloc` with the same `size`.
    /// - `ptr` must not have been previously deallocated.
    /// - The memory must not be accessed after this call.
    #[wasm_bindgen]
    pub unsafe fn dealloc(ptr: *mut u8, size: usize) {
        let _ = Vec::from_raw_parts(ptr, 0, size);
    }
}

#[cfg(feature = "ffi")]
pub mod ffi {
    use super::*;
    use std::ffi::{CStr, CString};
    use std::os::raw::{c_char, c_int};

    fn cstr_to_string(ptr: *const c_char) -> Option<String> {
        if ptr.is_null() {
            return None;
        }
        unsafe {
            match CStr::from_ptr(ptr).to_str() {
                Ok(s) => Some(s.to_string()),
                Err(_) => None,
            }
        }
    }

    fn string_to_cstr(s: String) -> *mut c_char {
        match CString::new(s) {
            Ok(cs) => cs.into_raw(),
            Err(_) => std::ptr::null_mut(),
        }
    }

    #[no_mangle]
    pub extern "C" fn elizaos_get_manifest() -> *mut c_char {
        string_to_cstr(get_manifest_json())
    }

    #[no_mangle]
    pub extern "C" fn elizaos_init(config_json: *const c_char) -> c_int {
        let config = cstr_to_string(config_json).unwrap_or_default();
        match init_plugin(&config) {
            Ok(()) => 0,
            Err(_) => -1,
        }
    }

    #[no_mangle]
    pub extern "C" fn elizaos_validate_action(
        name: *const c_char,
        memory_json: *const c_char,
        state_json: *const c_char,
    ) -> c_int {
        let name = match cstr_to_string(name) {
            Some(s) => s,
            None => return 0,
        };
        let memory = cstr_to_string(memory_json).unwrap_or_default();
        let state = cstr_to_string(state_json).unwrap_or_default();

        if validate_action(&name, &memory, &state) {
            1
        } else {
            0
        }
    }

    #[no_mangle]
    pub extern "C" fn elizaos_invoke_action(
        name: *const c_char,
        memory_json: *const c_char,
        state_json: *const c_char,
        options_json: *const c_char,
    ) -> *mut c_char {
        let name = match cstr_to_string(name) {
            Some(s) => s,
            None => {
                return string_to_cstr(r#"{"success": false, "error": "Invalid name"}"#.to_string())
            }
        };
        let memory = cstr_to_string(memory_json).unwrap_or_default();
        let state = cstr_to_string(state_json).unwrap_or_default();
        let options = cstr_to_string(options_json).unwrap_or_else(|| "{}".to_string());

        let result = invoke_action(&name, &memory, &state, &options);
        string_to_cstr(
            serde_json::to_string(&result)
                .unwrap_or_else(|e| format!(r#"{{"success": false, "error": "{}"}}"#, e)),
        )
    }

    #[no_mangle]
    pub extern "C" fn elizaos_get_provider(
        name: *const c_char,
        memory_json: *const c_char,
        state_json: *const c_char,
    ) -> *mut c_char {
        let name = match cstr_to_string(name) {
            Some(s) => s,
            None => return string_to_cstr("{}".to_string()),
        };
        let memory = cstr_to_string(memory_json).unwrap_or_default();
        let state = cstr_to_string(state_json).unwrap_or_default();

        let result = get_provider(&name, &memory, &state);
        string_to_cstr(serde_json::to_string(&result).unwrap_or_else(|_| "{}".to_string()))
    }

    #[no_mangle]
    pub extern "C" fn elizaos_validate_evaluator(
        name: *const c_char,
        memory_json: *const c_char,
        state_json: *const c_char,
    ) -> c_int {
        let name = match cstr_to_string(name) {
            Some(s) => s,
            None => return 0,
        };
        let memory = cstr_to_string(memory_json).unwrap_or_default();
        let state = cstr_to_string(state_json).unwrap_or_default();

        if validate_evaluator(&name, &memory, &state) {
            1
        } else {
            0
        }
    }

    #[no_mangle]
    pub extern "C" fn elizaos_invoke_evaluator(
        name: *const c_char,
        memory_json: *const c_char,
        state_json: *const c_char,
    ) -> *mut c_char {
        let name = match cstr_to_string(name) {
            Some(s) => s,
            None => return string_to_cstr("null".to_string()),
        };
        let memory = cstr_to_string(memory_json).unwrap_or_default();
        let state = cstr_to_string(state_json).unwrap_or_default();

        match invoke_evaluator(&name, &memory, &state) {
            Some(result) => string_to_cstr(
                serde_json::to_string(&result).unwrap_or_else(|_| "null".to_string()),
            ),
            None => string_to_cstr("null".to_string()),
        }
    }

    #[no_mangle]
    pub extern "C" fn eliza_generate_response(input: *const c_char) -> *mut c_char {
        let input = cstr_to_string(input).unwrap_or_default();
        string_to_cstr(generate_response(&input))
    }

    #[no_mangle]
    pub extern "C" fn eliza_reflect(text: *const c_char) -> *mut c_char {
        let text = cstr_to_string(text).unwrap_or_default();
        string_to_cstr(reflect(&text))
    }

    /// Frees a string that was allocated and returned by this library.
    ///
    /// # Safety
    ///
    /// - `ptr` must have been returned by one of the `elizaos_*` functions
    ///   that return `*mut c_char` (e.g., `elizaos_get_manifest`).
    /// - `ptr` must not have been previously freed.
    /// - The string must not be accessed after this call.
    #[no_mangle]
    pub unsafe extern "C" fn elizaos_free_string(ptr: *mut c_char) {
        if !ptr.is_null() {
            let _ = CString::from_raw(ptr);
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IpcRequest {
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IpcResponse {
    pub id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl IpcResponse {
    pub fn success(id: u64, result: serde_json::Value) -> Self {
        Self {
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn error(id: u64, error: &str) -> Self {
        Self {
            id,
            result: None,
            error: Some(error.to_string()),
        }
    }
}

pub fn handle_ipc_request(request: &IpcRequest) -> IpcResponse {
    match request.method.as_str() {
        "getManifest" => {
            let manifest = PluginManifest::default();
            IpcResponse::success(request.id, serde_json::to_value(&manifest).unwrap())
        }
        "init" => {
            let config = request
                .params
                .get("config")
                .map(|v| v.to_string())
                .unwrap_or_else(|| "{}".to_string());
            match init_plugin(&config) {
                Ok(()) => {
                    IpcResponse::success(request.id, serde_json::json!({"initialized": true}))
                }
                Err(e) => IpcResponse::error(request.id, &e),
            }
        }
        "validateAction" => {
            let name = request
                .params
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let memory = request
                .params
                .get("memory")
                .map(|v| v.to_string())
                .unwrap_or_default();
            let state = request
                .params
                .get("state")
                .map(|v| v.to_string())
                .unwrap_or_default();
            let valid = validate_action(name, &memory, &state);
            IpcResponse::success(request.id, serde_json::json!({"valid": valid}))
        }
        "invokeAction" => {
            let name = request
                .params
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let memory = request
                .params
                .get("memory")
                .map(|v| v.to_string())
                .unwrap_or_default();
            let state = request
                .params
                .get("state")
                .map(|v| v.to_string())
                .unwrap_or_default();
            let options = request
                .params
                .get("options")
                .map(|v| v.to_string())
                .unwrap_or_else(|| "{}".to_string());
            let result = invoke_action(name, &memory, &state, &options);
            IpcResponse::success(request.id, serde_json::to_value(&result).unwrap())
        }
        "getProvider" => {
            let name = request
                .params
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let memory = request
                .params
                .get("memory")
                .map(|v| v.to_string())
                .unwrap_or_default();
            let state = request
                .params
                .get("state")
                .map(|v| v.to_string())
                .unwrap_or_default();
            let result = get_provider(name, &memory, &state);
            IpcResponse::success(request.id, serde_json::to_value(&result).unwrap())
        }
        "validateEvaluator" => {
            let name = request
                .params
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let memory = request
                .params
                .get("memory")
                .map(|v| v.to_string())
                .unwrap_or_default();
            let state = request
                .params
                .get("state")
                .map(|v| v.to_string())
                .unwrap_or_default();
            let valid = validate_evaluator(name, &memory, &state);
            IpcResponse::success(request.id, serde_json::json!({"valid": valid}))
        }
        "invokeEvaluator" => {
            let name = request
                .params
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let memory = request
                .params
                .get("memory")
                .map(|v| v.to_string())
                .unwrap_or_default();
            let state = request
                .params
                .get("state")
                .map(|v| v.to_string())
                .unwrap_or_default();
            match invoke_evaluator(name, &memory, &state) {
                Some(result) => {
                    IpcResponse::success(request.id, serde_json::to_value(&result).unwrap())
                }
                None => IpcResponse::success(request.id, serde_json::Value::Null),
            }
        }
        "generateResponse" => {
            let input = request
                .params
                .get("input")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let response = generate_response(input);
            IpcResponse::success(request.id, serde_json::json!({"response": response}))
        }
        "reflect" => {
            let text = request
                .params
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let reflected = reflect(text);
            IpcResponse::success(request.id, serde_json::json!({"reflected": reflected}))
        }
        _ => IpcResponse::error(request.id, &format!("Unknown method: {}", request.method)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_manifest() {
        let manifest = PluginManifest::default();
        assert_eq!(manifest.name, "eliza-classic");
        assert_eq!(manifest.actions.len(), 1);
        assert_eq!(manifest.actions[0].name, "generate-response");
    }

    #[test]
    fn test_validate_action() {
        assert!(validate_action("generate-response", "{}", "{}"));
        assert!(!validate_action("unknown-action", "{}", "{}"));
    }

    #[test]
    fn test_invoke_action() {
        let result = invoke_action("generate-response", "{}", "{}", r#"{"input": "hello"}"#);
        assert!(result.success);
        assert!(result.text.is_some());
    }

    #[test]
    fn test_get_provider() {
        let result = get_provider("eliza-greeting", "{}", "{}");
        assert!(result.text.is_some());
        assert!(result.text.unwrap().to_lowercase().contains("problem"));
    }

    #[test]
    fn test_ipc_request() {
        let request = IpcRequest {
            id: 1,
            method: "generateResponse".to_string(),
            params: serde_json::json!({"input": "I am sad"}),
        };
        let response = handle_ipc_request(&request);
        assert!(response.error.is_none());
        assert!(response.result.is_some());
    }
}
