//! Python Plugin Loader for elizaOS Rust Runtime
//!
//! This module provides utilities for loading Python plugins into the Rust runtime
//! via subprocess IPC communication.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

/// Plugin manifest from Python
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonManifest {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub config: Option<HashMap<String, serde_json::Value>>,
    #[serde(default)]
    pub dependencies: Option<Vec<String>>,
    #[serde(default)]
    pub actions: Vec<ActionManifest>,
    #[serde(default)]
    pub providers: Vec<ProviderManifest>,
    #[serde(default)]
    pub evaluators: Vec<EvaluatorManifest>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionManifest {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub similes: Option<Vec<String>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderManifest {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub dynamic: Option<bool>,
    #[serde(default)]
    pub position: Option<i32>,
    #[serde(default)]
    pub private: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluatorManifest {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(rename = "alwaysRun", default)]
    pub always_run: Option<bool>,
    #[serde(default)]
    pub similes: Option<Vec<String>>,
}

/// Action result from Python
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

/// Provider result from Python
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

/// IPC Request to Python
#[derive(Clone, Debug, Serialize)]
struct IpcRequest {
    #[serde(rename = "type")]
    msg_type: String,
    id: String,
    #[serde(flatten)]
    payload: serde_json::Value,
}

/// IPC Response from Python
#[derive(Clone, Debug, Deserialize)]
struct IpcResponse {
    #[serde(rename = "type")]
    msg_type: String,
    id: String,
    #[serde(flatten)]
    payload: serde_json::Value,
}

/// Python plugin bridge that communicates via subprocess
pub struct PythonPluginBridge {
    process: Child,
    manifest: PythonManifest,
    request_counter: AtomicU64,
    stdin_mutex: Mutex<()>,
}

impl PythonPluginBridge {
    /// Create a new Python plugin bridge
    ///
    /// # Arguments
    /// * `module_name` - The Python module name to load
    /// * `python_path` - Path to Python executable (defaults to "python3")
    /// * `cwd` - Working directory for the subprocess
    ///
    /// # Returns
    /// The bridge instance with the plugin loaded
    pub fn new(
        module_name: &str,
        python_path: Option<&str>,
        cwd: Option<&Path>,
    ) -> Result<Self> {
        let python = python_path.unwrap_or("python3");
        let bridge_script = Self::get_bridge_script()?;

        let mut cmd = Command::new(python);
        cmd.arg("-u")
            .arg(&bridge_script)
            .arg("--module")
            .arg(module_name)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());

        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }

        let mut process = cmd.spawn()?;

        // Wait for ready message
        let stdout = process.stdout.take().ok_or_else(|| anyhow!("No stdout"))?;
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        reader.read_line(&mut line)?;

        let response: serde_json::Value = serde_json::from_str(&line)?;
        if response.get("type").and_then(|t| t.as_str()) != Some("ready") {
            return Err(anyhow!("Expected ready message, got: {}", line));
        }

        let manifest: PythonManifest = serde_json::from_value(
            response.get("manifest").cloned().unwrap_or_default()
        )?;

        // Put stdout back
        process.stdout = Some(reader.into_inner());

        Ok(Self {
            process,
            manifest,
            request_counter: AtomicU64::new(0),
            stdin_mutex: Mutex::new(()),
        })
    }

    fn get_bridge_script() -> Result<String> {
        // Use the existing bridge_server.py from the interop package
        // For now, look in common locations
        let possible_paths = [
            // Relative to interop package
            "packages/interop/python/bridge_server.py",
            "../interop/python/bridge_server.py",
            // In Python package
            "packages/python/elizaos/interop/bridge_server.py",
        ];

        for path in possible_paths {
            let p = Path::new(path);
            if p.exists() {
                return Ok(p.to_string_lossy().to_string());
            }
        }

        // Fall back to using -m to run as module
        Err(anyhow!("Could not find bridge_server.py"))
    }

    /// Get the plugin manifest
    pub fn manifest(&self) -> &PythonManifest {
        &self.manifest
    }

    fn next_id(&self) -> String {
        format!("req_{}", self.request_counter.fetch_add(1, Ordering::SeqCst))
    }

    /// Send a request and get response
    fn send_request(&mut self, msg_type: &str, payload: serde_json::Value) -> Result<IpcResponse> {
        let _lock = self.stdin_mutex.lock().unwrap();

        let request = IpcRequest {
            msg_type: msg_type.to_string(),
            id: self.next_id(),
            payload,
        };

        let stdin = self.process.stdin.as_mut().ok_or_else(|| anyhow!("No stdin"))?;
        let json = serde_json::to_string(&request)?;
        writeln!(stdin, "{}", json)?;
        stdin.flush()?;

        let stdout = self.process.stdout.as_mut().ok_or_else(|| anyhow!("No stdout"))?;
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        reader.read_line(&mut line)?;

        Ok(serde_json::from_str(&line)?)
    }

    /// Initialize the plugin
    pub fn init(&mut self, config: HashMap<String, String>) -> Result<()> {
        let payload = serde_json::json!({ "config": config });
        let response = self.send_request("plugin.init", payload)?;

        if response.msg_type == "error" {
            return Err(anyhow!(
                "Init failed: {}",
                response.payload.get("error").and_then(|e| e.as_str()).unwrap_or("Unknown")
            ));
        }

        Ok(())
    }

    /// Validate an action
    pub fn validate_action(
        &mut self,
        name: &str,
        memory: &serde_json::Value,
        state: Option<&serde_json::Value>,
    ) -> Result<bool> {
        let payload = serde_json::json!({
            "action": name,
            "memory": memory,
            "state": state,
        });
        let response = self.send_request("action.validate", payload)?;

        if response.msg_type == "error" {
            return Err(anyhow!(
                "Validate failed: {}",
                response.payload.get("error").and_then(|e| e.as_str()).unwrap_or("Unknown")
            ));
        }

        Ok(response.payload.get("valid").and_then(|v| v.as_bool()).unwrap_or(false))
    }

    /// Invoke an action
    pub fn invoke_action(
        &mut self,
        name: &str,
        memory: &serde_json::Value,
        state: Option<&serde_json::Value>,
        options: Option<&serde_json::Value>,
    ) -> Result<Option<ActionResult>> {
        let payload = serde_json::json!({
            "action": name,
            "memory": memory,
            "state": state,
            "options": options,
        });
        let response = self.send_request("action.invoke", payload)?;

        if response.msg_type == "error" {
            return Err(anyhow!(
                "Invoke failed: {}",
                response.payload.get("error").and_then(|e| e.as_str()).unwrap_or("Unknown")
            ));
        }

        let result = response.payload.get("result");
        if let Some(r) = result {
            if r.is_null() {
                return Ok(None);
            }
            return Ok(Some(serde_json::from_value(r.clone())?));
        }

        Ok(None)
    }

    /// Get provider data
    pub fn get_provider(
        &mut self,
        name: &str,
        memory: &serde_json::Value,
        state: &serde_json::Value,
    ) -> Result<ProviderResult> {
        let payload = serde_json::json!({
            "provider": name,
            "memory": memory,
            "state": state,
        });
        let response = self.send_request("provider.get", payload)?;

        if response.msg_type == "error" {
            return Err(anyhow!(
                "Provider failed: {}",
                response.payload.get("error").and_then(|e| e.as_str()).unwrap_or("Unknown")
            ));
        }

        let result = response.payload.get("result").cloned().unwrap_or_default();
        Ok(serde_json::from_value(result)?)
    }

    /// Invoke an evaluator
    pub fn invoke_evaluator(
        &mut self,
        name: &str,
        memory: &serde_json::Value,
        state: Option<&serde_json::Value>,
    ) -> Result<Option<ActionResult>> {
        let payload = serde_json::json!({
            "evaluator": name,
            "memory": memory,
            "state": state,
        });
        let response = self.send_request("evaluator.invoke", payload)?;

        if response.msg_type == "error" {
            return Err(anyhow!(
                "Evaluator failed: {}",
                response.payload.get("error").and_then(|e| e.as_str()).unwrap_or("Unknown")
            ));
        }

        let result = response.payload.get("result");
        if let Some(r) = result {
            if r.is_null() {
                return Ok(None);
            }
            return Ok(Some(serde_json::from_value(r.clone())?));
        }

        Ok(None)
    }
}

impl Drop for PythonPluginBridge {
    fn drop(&mut self) {
        let _ = self.process.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_manifest_deserialize() {
        let json = r#"{
            "name": "test-plugin",
            "description": "A test plugin",
            "language": "python",
            "actions": [{"name": "test_action"}],
            "providers": [],
            "evaluators": []
        }"#;

        let manifest: PythonManifest = serde_json::from_str(json).unwrap();
        assert_eq!(manifest.name, "test-plugin");
        assert_eq!(manifest.language, Some("python".to_string()));
        assert_eq!(manifest.actions.len(), 1);
    }

    #[test]
    fn test_action_result_deserialize() {
        let json = r#"{"success": true, "text": "Done"}"#;
        let result: ActionResult = serde_json::from_str(json).unwrap();
        assert!(result.success);
        assert_eq!(result.text, Some("Done".to_string()));
    }
}






