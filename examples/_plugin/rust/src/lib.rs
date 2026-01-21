//! elizaOS Rust Plugin Starter
//!
//! This is a template for creating elizaOS plugins in Rust that can be loaded by:
//! - TypeScript runtime (via WASM)
//! - Python runtime (via FFI)
//!
//! ## Building for TypeScript (WASM)
//!
//! ```bash
//! cargo build --target wasm32-unknown-unknown --release --features wasm
//! wasm-bindgen target/wasm32-unknown-unknown/release/elizaos_plugin_starter.wasm --out-dir dist
//! ```
//!
//! ## Building for Python (FFI)
//!
//! ```bash
//! cargo build --release --features ffi
//! # The .so/.dylib/.dll will be in target/release/
//! ```

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ============================================================================
// Plugin Types
// ============================================================================

/// Memory content from the agent
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Content {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actions: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<HashMap<String, serde_json::Value>>,
}

/// Memory from the agent
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub room_id: Option<String>,
    #[serde(default)]
    pub content: Content,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
}

/// State from the agent
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct State {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default)]
    pub values: HashMap<String, serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<HashMap<String, serde_json::Value>>,
}

/// Action result
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<HashMap<String, serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub values: Option<HashMap<String, serde_json::Value>>,
}

impl ActionResult {
    pub fn success() -> Self {
        Self {
            success: true,
            ..Default::default()
        }
    }

    pub fn success_with_text(text: impl Into<String>) -> Self {
        Self {
            success: true,
            text: Some(text.into()),
            ..Default::default()
        }
    }

    pub fn failure(error: impl Into<String>) -> Self {
        Self {
            success: false,
            error: Some(error.into()),
            ..Default::default()
        }
    }
}

/// Provider result
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProviderResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub values: Option<HashMap<String, serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<HashMap<String, serde_json::Value>>,
}

/// Handler options
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HandlerOptions {
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

// ============================================================================
// Plugin Implementation
// ============================================================================

/// The main plugin struct
pub struct StarterPlugin {
    config: HashMap<String, String>,
    initialized: bool,
}

impl Default for StarterPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl StarterPlugin {
    /// Create a new plugin instance
    pub fn new() -> Self {
        Self {
            config: HashMap::new(),
            initialized: false,
        }
    }

    /// Get the plugin manifest
    pub fn manifest(&self) -> serde_json::Value {
        serde_json::json!({
            "name": "rust-plugin-starter",
            "description": "A starter template for Rust plugins",
            "version": "2.0.0-alpha",
            "language": "rust",
            "actions": [
                {
                    "name": "HELLO_RUST",
                    "description": "Says hello from Rust",
                    "similes": ["GREET_RUST", "RUST_HELLO"]
                }
            ],
            "providers": [
                {
                    "name": "RUST_INFO",
                    "description": "Provides info about the Rust plugin"
                }
            ]
        })
    }

    /// Initialize the plugin
    pub fn init(&mut self, config_json: &str) -> Result<(), String> {
        let config: HashMap<String, String> =
            serde_json::from_str(config_json).map_err(|e| e.to_string())?;
        self.config = config;
        self.initialized = true;
        Ok(())
    }

    /// Validate an action
    pub fn validate_action(&self, name: &str, _memory: &Memory, _state: Option<&State>) -> bool {
        matches!(name, "HELLO_RUST")
    }

    /// Invoke an action
    pub fn invoke_action(
        &self,
        name: &str,
        memory: &Memory,
        _state: Option<&State>,
        _options: Option<&HandlerOptions>,
    ) -> ActionResult {
        match name {
            "HELLO_RUST" => {
                let greeting = memory
                    .content
                    .text
                    .as_deref()
                    .unwrap_or("friend");
                ActionResult::success_with_text(format!("Hello from Rust, {}! 🦀", greeting))
            }
            _ => ActionResult::failure(format!("Unknown action: {}", name)),
        }
    }

    /// Get provider data
    pub fn get_provider(&self, name: &str, _memory: &Memory, _state: &State) -> ProviderResult {
        match name {
            "RUST_INFO" => ProviderResult {
                text: Some("This is a Rust plugin running via interop!".to_string()),
                values: Some({
                    let mut map = HashMap::new();
                    map.insert("language".to_string(), serde_json::json!("rust"));
                    map.insert("initialized".to_string(), serde_json::json!(self.initialized));
                    map
                }),
                data: None,
            },
            _ => ProviderResult::default(),
        }
    }

    /// Validate an evaluator
    pub fn validate_evaluator(
        &self,
        _name: &str,
        _memory: &Memory,
        _state: Option<&State>,
    ) -> bool {
        false
    }

    /// Invoke an evaluator
    pub fn invoke_evaluator(
        &self,
        _name: &str,
        _memory: &Memory,
        _state: Option<&State>,
    ) -> Option<ActionResult> {
        None
    }
}

// ============================================================================
// FFI Exports (for Python)
// ============================================================================

#[cfg(feature = "ffi")]
mod ffi {
    use super::*;
    use std::ffi::{CStr, CString};
    use std::os::raw::{c_char, c_int};
    use std::sync::Mutex;

    static PLUGIN: Mutex<Option<StarterPlugin>> = Mutex::new(None);

    fn ensure_plugin() -> std::sync::MutexGuard<'static, Option<StarterPlugin>> {
        let mut guard = PLUGIN.lock().unwrap();
        if guard.is_none() {
            *guard = Some(StarterPlugin::new());
        }
        guard
    }

    fn cstr_to_string(ptr: *const c_char) -> Option<String> {
        if ptr.is_null() {
            return None;
        }
        unsafe { CStr::from_ptr(ptr).to_str().ok().map(String::from) }
    }

    fn string_to_cstr(s: String) -> *mut c_char {
        CString::new(s).map(|cs| cs.into_raw()).unwrap_or(std::ptr::null_mut())
    }

    #[no_mangle]
    pub extern "C" fn elizaos_get_manifest() -> *mut c_char {
        let plugin = ensure_plugin();
        let manifest = plugin.as_ref().unwrap().manifest();
        string_to_cstr(serde_json::to_string(&manifest).unwrap_or_default())
    }

    #[no_mangle]
    pub extern "C" fn elizaos_init(config_json: *const c_char) -> c_int {
        let config = cstr_to_string(config_json).unwrap_or_else(|| "{}".to_string());
        let mut plugin = ensure_plugin();
        match plugin.as_mut().unwrap().init(&config) {
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
        let name = cstr_to_string(name).unwrap_or_default();
        let memory: Memory = serde_json::from_str(
            &cstr_to_string(memory_json).unwrap_or_else(|| "{}".to_string()),
        )
        .unwrap_or_default();
        let state: Option<State> = cstr_to_string(state_json)
            .and_then(|s| serde_json::from_str(&s).ok());

        let plugin = ensure_plugin();
        if plugin.as_ref().unwrap().validate_action(&name, &memory, state.as_ref()) {
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
        let name = cstr_to_string(name).unwrap_or_default();
        let memory: Memory = serde_json::from_str(
            &cstr_to_string(memory_json).unwrap_or_else(|| "{}".to_string()),
        )
        .unwrap_or_default();
        let state: Option<State> = cstr_to_string(state_json)
            .and_then(|s| serde_json::from_str(&s).ok());
        let options: Option<HandlerOptions> = cstr_to_string(options_json)
            .and_then(|s| serde_json::from_str(&s).ok());

        let plugin = ensure_plugin();
        let result = plugin.as_ref().unwrap().invoke_action(
            &name,
            &memory,
            state.as_ref(),
            options.as_ref(),
        );
        string_to_cstr(serde_json::to_string(&result).unwrap_or_default())
    }

    #[no_mangle]
    pub extern "C" fn elizaos_get_provider(
        name: *const c_char,
        memory_json: *const c_char,
        state_json: *const c_char,
    ) -> *mut c_char {
        let name = cstr_to_string(name).unwrap_or_default();
        let memory: Memory = serde_json::from_str(
            &cstr_to_string(memory_json).unwrap_or_else(|| "{}".to_string()),
        )
        .unwrap_or_default();
        let state: State = serde_json::from_str(
            &cstr_to_string(state_json).unwrap_or_else(|| "{}".to_string()),
        )
        .unwrap_or_default();

        let plugin = ensure_plugin();
        let result = plugin.as_ref().unwrap().get_provider(&name, &memory, &state);
        string_to_cstr(serde_json::to_string(&result).unwrap_or_default())
    }

    #[no_mangle]
    pub extern "C" fn elizaos_validate_evaluator(
        name: *const c_char,
        memory_json: *const c_char,
        state_json: *const c_char,
    ) -> c_int {
        let name = cstr_to_string(name).unwrap_or_default();
        let memory: Memory = serde_json::from_str(
            &cstr_to_string(memory_json).unwrap_or_else(|| "{}".to_string()),
        )
        .unwrap_or_default();
        let state: Option<State> = cstr_to_string(state_json)
            .and_then(|s| serde_json::from_str(&s).ok());

        let plugin = ensure_plugin();
        if plugin.as_ref().unwrap().validate_evaluator(&name, &memory, state.as_ref()) {
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
        let name = cstr_to_string(name).unwrap_or_default();
        let memory: Memory = serde_json::from_str(
            &cstr_to_string(memory_json).unwrap_or_else(|| "{}".to_string()),
        )
        .unwrap_or_default();
        let state: Option<State> = cstr_to_string(state_json)
            .and_then(|s| serde_json::from_str(&s).ok());

        let plugin = ensure_plugin();
        let result = plugin.as_ref().unwrap().invoke_evaluator(&name, &memory, state.as_ref());
        match result {
            Some(r) => string_to_cstr(serde_json::to_string(&r).unwrap_or_default()),
            None => string_to_cstr("null".to_string()),
        }
    }

    #[no_mangle]
    pub extern "C" fn elizaos_free_string(ptr: *mut c_char) {
        if !ptr.is_null() {
            unsafe {
                let _ = CString::from_raw(ptr);
            }
        }
    }
}

// ============================================================================
// WASM Exports (for TypeScript)
// ============================================================================

#[cfg(feature = "wasm")]
mod wasm {
    use super::*;
    use std::sync::Mutex;
    use wasm_bindgen::prelude::*;

    static PLUGIN: Mutex<Option<StarterPlugin>> = Mutex::new(None);

    fn ensure_plugin() -> std::sync::MutexGuard<'static, Option<StarterPlugin>> {
        let mut guard = PLUGIN.lock().unwrap();
        if guard.is_none() {
            *guard = Some(StarterPlugin::new());
        }
        guard
    }

    #[wasm_bindgen(start)]
    pub fn wasm_init() {
        console_error_panic_hook::set_once();
    }

    #[wasm_bindgen]
    pub fn get_manifest() -> String {
        let plugin = ensure_plugin();
        serde_json::to_string(&plugin.as_ref().unwrap().manifest()).unwrap_or_default()
    }

    #[wasm_bindgen]
    pub fn init(config_json: &str) {
        let mut plugin = ensure_plugin();
        let _ = plugin.as_mut().unwrap().init(config_json);
    }

    #[wasm_bindgen]
    pub fn validate_action(name: &str, memory_json: &str, state_json: &str) -> bool {
        let memory: Memory = serde_json::from_str(memory_json).unwrap_or_default();
        let state: Option<State> = serde_json::from_str(state_json).ok();

        let plugin = ensure_plugin();
        plugin.as_ref().unwrap().validate_action(name, &memory, state.as_ref())
    }

    #[wasm_bindgen]
    pub fn invoke_action(
        name: &str,
        memory_json: &str,
        state_json: &str,
        options_json: &str,
    ) -> String {
        let memory: Memory = serde_json::from_str(memory_json).unwrap_or_default();
        let state: Option<State> = serde_json::from_str(state_json).ok();
        let options: Option<HandlerOptions> = serde_json::from_str(options_json).ok();

        let plugin = ensure_plugin();
        let result = plugin.as_ref().unwrap().invoke_action(
            name,
            &memory,
            state.as_ref(),
            options.as_ref(),
        );
        serde_json::to_string(&result).unwrap_or_default()
    }

    #[wasm_bindgen]
    pub fn get_provider(name: &str, memory_json: &str, state_json: &str) -> String {
        let memory: Memory = serde_json::from_str(memory_json).unwrap_or_default();
        let state: State = serde_json::from_str(state_json).unwrap_or_default();

        let plugin = ensure_plugin();
        let result = plugin.as_ref().unwrap().get_provider(name, &memory, &state);
        serde_json::to_string(&result).unwrap_or_default()
    }

    #[wasm_bindgen]
    pub fn validate_evaluator(name: &str, memory_json: &str, state_json: &str) -> bool {
        let memory: Memory = serde_json::from_str(memory_json).unwrap_or_default();
        let state: Option<State> = serde_json::from_str(state_json).ok();

        let plugin = ensure_plugin();
        plugin.as_ref().unwrap().validate_evaluator(name, &memory, state.as_ref())
    }

    #[wasm_bindgen]
    pub fn invoke_evaluator(name: &str, memory_json: &str, state_json: &str) -> String {
        let memory: Memory = serde_json::from_str(memory_json).unwrap_or_default();
        let state: Option<State> = serde_json::from_str(state_json).ok();

        let plugin = ensure_plugin();
        match plugin.as_ref().unwrap().invoke_evaluator(name, &memory, state.as_ref()) {
            Some(r) => serde_json::to_string(&r).unwrap_or_default(),
            None => "null".to_string(),
        }
    }

    #[wasm_bindgen]
    pub fn alloc(size: usize) -> *mut u8 {
        let mut buf = Vec::with_capacity(size);
        let ptr = buf.as_mut_ptr();
        std::mem::forget(buf);
        ptr
    }

    #[wasm_bindgen]
    pub fn dealloc(ptr: *mut u8, size: usize) {
        unsafe {
            let _ = Vec::from_raw_parts(ptr, 0, size);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_plugin_creation() {
        let plugin = StarterPlugin::new();
        assert!(!plugin.initialized);
    }

    #[test]
    fn test_plugin_init() {
        let mut plugin = StarterPlugin::new();
        let result = plugin.init("{}");
        assert!(result.is_ok());
        assert!(plugin.initialized);
    }

    #[test]
    fn test_action_validation() {
        let plugin = StarterPlugin::new();
        let memory = Memory::default();
        assert!(plugin.validate_action("HELLO_RUST", &memory, None));
        assert!(!plugin.validate_action("UNKNOWN_ACTION", &memory, None));
    }

    #[test]
    fn test_action_invocation() {
        let plugin = StarterPlugin::new();
        let mut memory = Memory::default();
        memory.content.text = Some("World".to_string());

        let result = plugin.invoke_action("HELLO_RUST", &memory, None, None);
        assert!(result.success);
        assert!(result.text.unwrap().contains("Hello from Rust"));
    }

    #[test]
    fn test_provider() {
        let plugin = StarterPlugin::new();
        let memory = Memory::default();
        let state = State::default();

        let result = plugin.get_provider("RUST_INFO", &memory, &state);
        assert!(result.text.is_some());
    }
}

