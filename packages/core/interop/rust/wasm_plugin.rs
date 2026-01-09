//! WASM Plugin Bindings for elizaOS
//!
//! This module provides WASM-specific bindings for creating plugins that can be
//! loaded by the TypeScript runtime.
//!
//! # Example
//!
//! ```rust,ignore
//! use elizaos::interop::wasm_plugin::*;
//! use elizaos::types::*;
//!
//! // Define your plugin
//! struct MyPlugin;
//!
//! impl WasmPlugin for MyPlugin {
//!     fn manifest(&self) -> PluginManifest {
//!         PluginManifest {
//!             name: "my-plugin".to_string(),
//!             description: "A WASM plugin".to_string(),
//!             ..Default::default()
//!         }
//!     }
//!
//!     fn init(&mut self, config: &str) -> Result<(), String> {
//!         Ok(())
//!     }
//!
//!     // ... implement other methods ...
//! }
//!
//! // Export the plugin
//! elizaos_wasm_plugin!(MyPlugin::new());
//! ```

#![cfg(feature = "wasm")]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use wasm_bindgen::prelude::*;

/// Plugin manifest for WASM export
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<HashMap<String, serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dependencies: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actions: Option<Vec<ActionManifest>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub providers: Option<Vec<ProviderManifest>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evaluators: Option<Vec<EvaluatorManifest>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionManifest {
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub similes: Option<Vec<String>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderManifest {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dynamic: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub private: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluatorManifest {
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub always_run: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub similes: Option<Vec<String>>,
}

/// Action result for WASM
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub values: Option<HashMap<String, serde_json::Value>>,
}

impl ActionResult {
    pub fn success() -> Self {
        ActionResult {
            success: true,
            ..Default::default()
        }
    }

    pub fn success_with_text(text: &str) -> Self {
        ActionResult {
            success: true,
            text: Some(text.to_string()),
            ..Default::default()
        }
    }

    pub fn failure(error: &str) -> Self {
        ActionResult {
            success: false,
            error: Some(error.to_string()),
            ..Default::default()
        }
    }
}

/// Provider result for WASM
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

/// Trait for WASM-exportable plugins
pub trait WasmPlugin: Send + Sync {
    /// Get the plugin manifest
    fn manifest(&self) -> PluginManifest;

    /// Initialize the plugin with configuration
    fn init(&mut self, config_json: &str) -> Result<(), String>;

    /// Validate an action
    fn validate_action(&self, name: &str, memory_json: &str, state_json: &str) -> bool;

    /// Invoke an action
    fn invoke_action(
        &self,
        name: &str,
        memory_json: &str,
        state_json: &str,
        options_json: &str,
    ) -> ActionResult;

    /// Get provider data
    fn get_provider(&self, name: &str, memory_json: &str, state_json: &str) -> ProviderResult;

    /// Validate an evaluator
    fn validate_evaluator(&self, name: &str, memory_json: &str, state_json: &str) -> bool;

    /// Invoke an evaluator
    fn invoke_evaluator(
        &self,
        name: &str,
        memory_json: &str,
        state_json: &str,
    ) -> Option<ActionResult>;
}

/// Global plugin instance for WASM
static WASM_PLUGIN: Mutex<Option<Box<dyn WasmPlugin>>> = Mutex::new(None);

/// Register a plugin for WASM export
pub fn register_wasm_plugin<P: WasmPlugin + 'static>(plugin: P) {
    let mut instance = WASM_PLUGIN.lock().unwrap();
    *instance = Some(Box::new(plugin));
}

// ============================================================================
// WASM Export Functions
// ============================================================================

/// Get the plugin manifest as JSON
#[wasm_bindgen]
pub fn get_manifest() -> String {
    let instance = WASM_PLUGIN.lock().unwrap();
    match &*instance {
        Some(plugin) => serde_json::to_string(&plugin.manifest()).unwrap_or_else(|e| {
            format!(r#"{{"error": "{}"}}"#, e)
        }),
        None => r#"{"error": "No plugin registered"}"#.to_string(),
    }
}

/// Initialize the plugin
#[wasm_bindgen]
pub fn init(config_json: &str) {
    let mut instance = WASM_PLUGIN.lock().unwrap();
    if let Some(plugin) = instance.as_mut() {
        let _ = plugin.init(config_json);
    }
}

/// Validate an action
#[wasm_bindgen]
pub fn validate_action(name: &str, memory_json: &str, state_json: &str) -> bool {
    let instance = WASM_PLUGIN.lock().unwrap();
    match &*instance {
        Some(plugin) => plugin.validate_action(name, memory_json, state_json),
        None => false,
    }
}

/// Invoke an action
#[wasm_bindgen]
pub fn invoke_action(
    name: &str,
    memory_json: &str,
    state_json: &str,
    options_json: &str,
) -> String {
    let instance = WASM_PLUGIN.lock().unwrap();
    match &*instance {
        Some(plugin) => {
            let result = plugin.invoke_action(name, memory_json, state_json, options_json);
            serde_json::to_string(&result).unwrap_or_else(|e| {
                format!(r#"{{"success": false, "error": "{}"}}"#, e)
            })
        }
        None => r#"{"success": false, "error": "No plugin registered"}"#.to_string(),
    }
}

/// Get provider data
#[wasm_bindgen]
pub fn get_provider(name: &str, memory_json: &str, state_json: &str) -> String {
    let instance = WASM_PLUGIN.lock().unwrap();
    match &*instance {
        Some(plugin) => {
            let result = plugin.get_provider(name, memory_json, state_json);
            serde_json::to_string(&result).unwrap_or_else(|_| {
                r#"{"text": null, "values": null, "data": null}"#.to_string()
            })
        }
        None => r#"{"text": null, "values": null, "data": null}"#.to_string(),
    }
}

/// Validate an evaluator
#[wasm_bindgen]
pub fn validate_evaluator(name: &str, memory_json: &str, state_json: &str) -> bool {
    let instance = WASM_PLUGIN.lock().unwrap();
    match &*instance {
        Some(plugin) => plugin.validate_evaluator(name, memory_json, state_json),
        None => false,
    }
}

/// Invoke an evaluator
#[wasm_bindgen]
pub fn invoke_evaluator(name: &str, memory_json: &str, state_json: &str) -> String {
    let instance = WASM_PLUGIN.lock().unwrap();
    match &*instance {
        Some(plugin) => match plugin.invoke_evaluator(name, memory_json, state_json) {
            Some(result) => serde_json::to_string(&result).unwrap_or_else(|_| "null".to_string()),
            None => "null".to_string(),
        },
        None => "null".to_string(),
    }
}

// ============================================================================
// Memory Allocation for String Passing
// ============================================================================

/// Allocate memory for string passing
#[wasm_bindgen]
pub fn alloc(size: usize) -> *mut u8 {
    let mut buf = Vec::with_capacity(size);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// Deallocate memory
#[wasm_bindgen]
pub fn dealloc(ptr: *mut u8, size: usize) {
    unsafe {
        let _ = Vec::from_raw_parts(ptr, 0, size);
    }
}

/// Macro to export a WASM plugin
///
/// This macro should be called in your plugin's lib.rs to make it loadable
/// from the TypeScript runtime via WASM.
#[macro_export]
macro_rules! elizaos_wasm_plugin {
    ($plugin:expr) => {
        #[wasm_bindgen(start)]
        pub fn wasm_plugin_init() {
            console_error_panic_hook::set_once();
            $crate::interop::wasm_plugin::register_wasm_plugin($plugin);
        }
    };
}

