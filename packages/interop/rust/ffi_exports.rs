//! FFI Exports for elizaOS Rust Plugins
//!
//! This module provides macros and utilities for exposing Rust plugins
//! to Python and other FFI-capable languages.
//!
//! # Example
//!
//! ```rust
//! use elizaos::interop::ffi_exports::*;
//! use elizaos::types::Plugin;
//!
//! // Create your plugin
//! let plugin = Plugin::new("my-plugin", "A cool plugin");
//!
//! // Export it for FFI
//! elizaos_export_plugin!(plugin);
//! ```

use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int};
use std::sync::Mutex;

/// Global plugin instance storage
static PLUGIN_INSTANCE: Mutex<Option<Box<dyn PluginExport>>> = Mutex::new(None);

/// Trait for plugins that can be exported via FFI
pub trait PluginExport: Send + Sync {
    /// Get the plugin manifest as JSON
    fn get_manifest(&self) -> String;

    /// Initialize the plugin with config JSON
    fn init(&self, config_json: &str) -> Result<(), String>;

    /// Validate an action
    fn validate_action(&self, name: &str, memory_json: &str, state_json: &str) -> bool;

    /// Invoke an action and return result JSON
    fn invoke_action(
        &self,
        name: &str,
        memory_json: &str,
        state_json: &str,
        options_json: &str,
    ) -> String;

    /// Get provider data and return result JSON
    fn get_provider(&self, name: &str, memory_json: &str, state_json: &str) -> String;

    /// Validate an evaluator
    fn validate_evaluator(&self, name: &str, memory_json: &str, state_json: &str) -> bool;

    /// Invoke an evaluator and return result JSON
    fn invoke_evaluator(&self, name: &str, memory_json: &str, state_json: &str) -> String;
}

/// Register a plugin for FFI export
pub fn register_plugin<P: PluginExport + 'static>(plugin: P) {
    let mut instance = PLUGIN_INSTANCE.lock().unwrap();
    *instance = Some(Box::new(plugin));
}

/// Helper to convert C string to Rust string
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

/// Helper to convert Rust string to C string (caller must free)
fn string_to_cstr(s: String) -> *mut c_char {
    match CString::new(s) {
        Ok(cs) => cs.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

// ============================================================================
// FFI Export Functions
// ============================================================================

/// Get the plugin manifest as JSON
///
/// # Safety
/// The returned string must be freed with `elizaos_free_string`
#[no_mangle]
pub extern "C" fn elizaos_get_manifest() -> *mut c_char {
    let instance = PLUGIN_INSTANCE.lock().unwrap();
    match &*instance {
        Some(plugin) => string_to_cstr(plugin.get_manifest()),
        None => string_to_cstr(r#"{"error": "No plugin registered"}"#.to_string()),
    }
}

/// Initialize the plugin with configuration
///
/// # Safety
/// `config_json` must be a valid null-terminated C string
#[no_mangle]
pub extern "C" fn elizaos_init(config_json: *const c_char) -> c_int {
    let config = match cstr_to_string(config_json) {
        Some(s) => s,
        None => return -1,
    };

    let instance = PLUGIN_INSTANCE.lock().unwrap();
    match &*instance {
        Some(plugin) => match plugin.init(&config) {
            Ok(()) => 0,
            Err(_) => -1,
        },
        None => -1,
    }
}

/// Validate an action
///
/// # Safety
/// All string parameters must be valid null-terminated C strings
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
    let memory = cstr_to_string(memory_json).unwrap_or_else(|| "null".to_string());
    let state = cstr_to_string(state_json).unwrap_or_else(|| "null".to_string());

    let instance = PLUGIN_INSTANCE.lock().unwrap();
    match &*instance {
        Some(plugin) => {
            if plugin.validate_action(&name, &memory, &state) {
                1
            } else {
                0
            }
        }
        None => 0,
    }
}

/// Invoke an action
///
/// # Safety
/// All string parameters must be valid null-terminated C strings.
/// The returned string must be freed with `elizaos_free_string`
#[no_mangle]
pub extern "C" fn elizaos_invoke_action(
    name: *const c_char,
    memory_json: *const c_char,
    state_json: *const c_char,
    options_json: *const c_char,
) -> *mut c_char {
    let name = match cstr_to_string(name) {
        Some(s) => s,
        None => return string_to_cstr(r#"{"success": false, "error": "Invalid action name"}"#.to_string()),
    };
    let memory = cstr_to_string(memory_json).unwrap_or_else(|| "null".to_string());
    let state = cstr_to_string(state_json).unwrap_or_else(|| "null".to_string());
    let options = cstr_to_string(options_json).unwrap_or_else(|| "{}".to_string());

    let instance = PLUGIN_INSTANCE.lock().unwrap();
    match &*instance {
        Some(plugin) => string_to_cstr(plugin.invoke_action(&name, &memory, &state, &options)),
        None => string_to_cstr(r#"{"success": false, "error": "No plugin registered"}"#.to_string()),
    }
}

/// Get provider data
///
/// # Safety
/// All string parameters must be valid null-terminated C strings.
/// The returned string must be freed with `elizaos_free_string`
#[no_mangle]
pub extern "C" fn elizaos_get_provider(
    name: *const c_char,
    memory_json: *const c_char,
    state_json: *const c_char,
) -> *mut c_char {
    let name = match cstr_to_string(name) {
        Some(s) => s,
        None => return string_to_cstr(r#"{"text": null, "values": null, "data": null}"#.to_string()),
    };
    let memory = cstr_to_string(memory_json).unwrap_or_else(|| "null".to_string());
    let state = cstr_to_string(state_json).unwrap_or_else(|| "{}".to_string());

    let instance = PLUGIN_INSTANCE.lock().unwrap();
    match &*instance {
        Some(plugin) => string_to_cstr(plugin.get_provider(&name, &memory, &state)),
        None => string_to_cstr(r#"{"text": null, "values": null, "data": null}"#.to_string()),
    }
}

/// Validate an evaluator
///
/// # Safety
/// All string parameters must be valid null-terminated C strings
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
    let memory = cstr_to_string(memory_json).unwrap_or_else(|| "null".to_string());
    let state = cstr_to_string(state_json).unwrap_or_else(|| "null".to_string());

    let instance = PLUGIN_INSTANCE.lock().unwrap();
    match &*instance {
        Some(plugin) => {
            if plugin.validate_evaluator(&name, &memory, &state) {
                1
            } else {
                0
            }
        }
        None => 0,
    }
}

/// Invoke an evaluator
///
/// # Safety
/// All string parameters must be valid null-terminated C strings.
/// The returned string must be freed with `elizaos_free_string`
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
    let memory = cstr_to_string(memory_json).unwrap_or_else(|| "null".to_string());
    let state = cstr_to_string(state_json).unwrap_or_else(|| "null".to_string());

    let instance = PLUGIN_INSTANCE.lock().unwrap();
    match &*instance {
        Some(plugin) => string_to_cstr(plugin.invoke_evaluator(&name, &memory, &state)),
        None => string_to_cstr("null".to_string()),
    }
}

/// Free a string returned by any of the above functions
///
/// # Safety
/// `ptr` must be a string allocated by this library
#[no_mangle]
pub extern "C" fn elizaos_free_string(ptr: *mut c_char) {
    if !ptr.is_null() {
        unsafe {
            let _ = CString::from_raw(ptr);
        }
    }
}

// ============================================================================
// Helper Macro for Plugin Export
// ============================================================================

/// Macro to export a plugin for FFI
///
/// This macro should be called in your plugin's lib.rs to make it loadable
/// via FFI from Python or other languages.
///
/// # Example
///
/// ```rust,ignore
/// use elizaos::interop::ffi_exports::*;
///
/// struct MyPlugin { /* ... */ }
///
/// impl PluginExport for MyPlugin {
///     // ... implement trait methods ...
/// }
///
/// #[no_mangle]
/// pub extern "C" fn elizaos_plugin_init() {
///     let plugin = MyPlugin::new();
///     register_plugin(plugin);
/// }
/// ```
#[macro_export]
macro_rules! elizaos_export_plugin {
    ($plugin:expr) => {
        #[no_mangle]
        pub extern "C" fn elizaos_plugin_init() {
            $crate::interop::ffi_exports::register_plugin($plugin);
        }
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestPlugin {
        name: String,
    }

    impl PluginExport for TestPlugin {
        fn get_manifest(&self) -> String {
            format!(r#"{{"name": "{}", "description": "Test plugin"}}"#, self.name)
        }

        fn init(&self, _config: &str) -> Result<(), String> {
            Ok(())
        }

        fn validate_action(&self, _name: &str, _memory: &str, _state: &str) -> bool {
            true
        }

        fn invoke_action(&self, _name: &str, _memory: &str, _state: &str, _options: &str) -> String {
            r#"{"success": true, "text": "Hello from test"}"#.to_string()
        }

        fn get_provider(&self, _name: &str, _memory: &str, _state: &str) -> String {
            r#"{"text": "Provider data"}"#.to_string()
        }

        fn validate_evaluator(&self, _name: &str, _memory: &str, _state: &str) -> bool {
            true
        }

        fn invoke_evaluator(&self, _name: &str, _memory: &str, _state: &str) -> String {
            r#"{"success": true}"#.to_string()
        }
    }

    #[test]
    fn test_plugin_registration() {
        let plugin = TestPlugin {
            name: "test".to_string(),
        };
        register_plugin(plugin);

        let manifest_ptr = elizaos_get_manifest();
        assert!(!manifest_ptr.is_null());

        unsafe {
            let manifest = CStr::from_ptr(manifest_ptr).to_str().unwrap();
            assert!(manifest.contains("test"));
            elizaos_free_string(manifest_ptr);
        }
    }
}

