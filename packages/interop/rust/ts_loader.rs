//! TypeScript Plugin Loader for elizaOS Rust Runtime
//!
//! This module provides utilities for loading TypeScript plugins into the Rust runtime
//! via subprocess IPC communication.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

/// Plugin manifest from TypeScript
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeScriptManifest {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub version: Option<String>,
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
    #[serde(default)]
    pub always_run: Option<bool>,
    #[serde(default)]
    pub similes: Option<Vec<String>>,
}

/// Action result from TypeScript
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

/// Provider result from TypeScript
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

/// IPC Request types
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum IpcRequest {
    #[serde(rename = "plugin.init")]
    PluginInit {
        id: String,
        config: HashMap<String, String>,
    },
    #[serde(rename = "action.validate")]
    ActionValidate {
        id: String,
        action: String,
        memory: serde_json::Value,
        state: Option<serde_json::Value>,
    },
    #[serde(rename = "action.invoke")]
    ActionInvoke {
        id: String,
        action: String,
        memory: serde_json::Value,
        state: Option<serde_json::Value>,
        options: Option<serde_json::Value>,
    },
    #[serde(rename = "provider.get")]
    ProviderGet {
        id: String,
        provider: String,
        memory: serde_json::Value,
        state: serde_json::Value,
    },
    #[serde(rename = "evaluator.invoke")]
    EvaluatorInvoke {
        id: String,
        evaluator: String,
        memory: serde_json::Value,
        state: Option<serde_json::Value>,
    },
}

/// IPC Response types
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum IpcResponse {
    Ready {
        manifest: TypeScriptManifest,
    },
    #[serde(rename = "plugin.init.result")]
    PluginInitResult {
        id: String,
        success: bool,
    },
    #[serde(rename = "validate.result")]
    ValidateResult {
        id: String,
        valid: bool,
    },
    #[serde(rename = "action.result")]
    ActionResult {
        id: String,
        result: Option<ActionResult>,
    },
    #[serde(rename = "provider.result")]
    ProviderResult {
        id: String,
        result: ProviderResult,
    },
    Error {
        id: String,
        error: String,
    },
}

/// TypeScript plugin bridge that communicates via subprocess
pub struct TypeScriptPluginBridge {
    process: Child,
    manifest: TypeScriptManifest,
    request_counter: AtomicU64,
    stdin_mutex: Mutex<()>,
}

impl TypeScriptPluginBridge {
    /// Create a new TypeScript plugin bridge
    ///
    /// # Arguments
    /// * `plugin_path` - Path to the TypeScript plugin (directory or entry file)
    /// * `node_path` - Path to Node.js executable (defaults to "node")
    ///
    /// # Returns
    /// The bridge instance with the plugin loaded
    pub fn new<P: AsRef<Path>>(plugin_path: P, node_path: Option<&str>) -> Result<Self> {
        let node = node_path.unwrap_or("node");
        let bridge_script = Self::get_bridge_script()?;

        let mut process = Command::new(node)
            .arg(&bridge_script)
            .arg(plugin_path.as_ref())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;

        // Wait for ready message
        let stdout = process.stdout.take().ok_or_else(|| anyhow!("No stdout"))?;
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        reader.read_line(&mut line)?;

        let response: IpcResponse = serde_json::from_str(&line)?;
        let manifest = match response {
            IpcResponse::Ready { manifest } => manifest,
            _ => return Err(anyhow!("Expected ready message, got: {:?}", response)),
        };

        // Put stdout back for later reads
        process.stdout = Some(reader.into_inner());

        Ok(Self {
            process,
            manifest,
            request_counter: AtomicU64::new(0),
            stdin_mutex: Mutex::new(()),
        })
    }

    fn get_bridge_script() -> Result<String> {
        // For now, use inline script via node -e
        // In production, this would be a separate file
        let script = r#"
const { createInterface } = require('readline');

const pluginPath = process.argv[2];

(async () => {
    const module = require(pluginPath);
    const plugin = module.default || module.plugin || module;

    const actions = {};
    const providers = {};
    const evaluators = {};

    for (const a of plugin.actions || []) actions[a.name] = a;
    for (const p of plugin.providers || []) providers[p.name] = p;
    for (const e of plugin.evaluators || []) evaluators[e.name] = e;

    const manifest = {
        name: plugin.name,
        description: plugin.description,
        version: plugin.version || '1.0.0',
        actions: Object.values(actions).map(a => ({ name: a.name, description: a.description, similes: a.similes })),
        providers: Object.values(providers).map(p => ({ name: p.name, description: p.description, dynamic: p.dynamic, position: p.position, private: p.private })),
        evaluators: Object.values(evaluators).map(e => ({ name: e.name, description: e.description, alwaysRun: e.alwaysRun, similes: e.similes })),
    };

    console.log(JSON.stringify({ type: 'ready', manifest }));

    const rl = createInterface({ input: process.stdin });
    rl.on('line', async (line) => {
        try {
            const req = JSON.parse(line);
            let res;
            switch (req.type) {
                case 'plugin.init':
                    if (plugin.init) await plugin.init(req.config, null);
                    res = { type: 'plugin.init.result', id: req.id, success: true };
                    break;
                case 'action.validate':
                    const a = actions[req.action];
                    res = { type: 'validate.result', id: req.id, valid: a ? await a.validate(null, req.memory, req.state) : false };
                    break;
                case 'action.invoke':
                    const act = actions[req.action];
                    if (!act) { res = { type: 'action.result', id: req.id, result: { success: false, error: 'Not found' }}; break; }
                    const r = await act.handler(null, req.memory, req.state, req.options);
                    res = { type: 'action.result', id: req.id, result: r ? { success: r.success, text: r.text, error: r.error?.message || r.error, data: r.data, values: r.values } : { success: true } };
                    break;
                case 'provider.get':
                    const prov = providers[req.provider];
                    res = { type: 'provider.result', id: req.id, result: prov ? await prov.get(null, req.memory, req.state) : {} };
                    break;
                case 'evaluator.invoke':
                    const ev = evaluators[req.evaluator];
                    if (!ev) { res = { type: 'action.result', id: req.id, result: null }; break; }
                    const er = await ev.handler(null, req.memory, req.state);
                    res = { type: 'action.result', id: req.id, result: er ? { success: er.success, text: er.text, data: er.data, values: er.values } : null };
                    break;
                default:
                    res = { type: 'error', id: req.id, error: 'Unknown type' };
            }
            console.log(JSON.stringify(res));
        } catch (e) {
            console.log(JSON.stringify({ type: 'error', id: '', error: e.message }));
        }
    });
})();
"#;
        // Write to temp file
        let temp_path = std::env::temp_dir().join("elizaos_ts_bridge.js");
        std::fs::write(&temp_path, script)?;
        Ok(temp_path.to_string_lossy().to_string())
    }

    /// Get the plugin manifest
    pub fn manifest(&self) -> &TypeScriptManifest {
        &self.manifest
    }

    /// Send a request and get response
    fn send_request(&mut self, request: IpcRequest) -> Result<IpcResponse> {
        let _lock = self.stdin_mutex.lock().unwrap();

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

    fn next_id(&self) -> String {
        format!("req_{}", self.request_counter.fetch_add(1, Ordering::SeqCst))
    }

    /// Initialize the plugin
    pub fn init(&mut self, config: HashMap<String, String>) -> Result<()> {
        let id = self.next_id();
        let response = self.send_request(IpcRequest::PluginInit { id, config })?;

        match response {
            IpcResponse::PluginInitResult { success, .. } if success => Ok(()),
            IpcResponse::Error { error, .. } => Err(anyhow!("Init failed: {}", error)),
            _ => Err(anyhow!("Unexpected response")),
        }
    }

    /// Validate an action
    pub fn validate_action(
        &mut self,
        name: &str,
        memory: &serde_json::Value,
        state: Option<&serde_json::Value>,
    ) -> Result<bool> {
        let id = self.next_id();
        let response = self.send_request(IpcRequest::ActionValidate {
            id,
            action: name.to_string(),
            memory: memory.clone(),
            state: state.cloned(),
        })?;

        match response {
            IpcResponse::ValidateResult { valid, .. } => Ok(valid),
            IpcResponse::Error { error, .. } => Err(anyhow!("Validate failed: {}", error)),
            _ => Err(anyhow!("Unexpected response")),
        }
    }

    /// Invoke an action
    pub fn invoke_action(
        &mut self,
        name: &str,
        memory: &serde_json::Value,
        state: Option<&serde_json::Value>,
        options: Option<&serde_json::Value>,
    ) -> Result<Option<ActionResult>> {
        let id = self.next_id();
        let response = self.send_request(IpcRequest::ActionInvoke {
            id,
            action: name.to_string(),
            memory: memory.clone(),
            state: state.cloned(),
            options: options.cloned(),
        })?;

        match response {
            IpcResponse::ActionResult { result, .. } => Ok(result),
            IpcResponse::Error { error, .. } => Err(anyhow!("Invoke failed: {}", error)),
            _ => Err(anyhow!("Unexpected response")),
        }
    }

    /// Get provider data
    pub fn get_provider(
        &mut self,
        name: &str,
        memory: &serde_json::Value,
        state: &serde_json::Value,
    ) -> Result<ProviderResult> {
        let id = self.next_id();
        let response = self.send_request(IpcRequest::ProviderGet {
            id,
            provider: name.to_string(),
            memory: memory.clone(),
            state: state.clone(),
        })?;

        match response {
            IpcResponse::ProviderResult { result, .. } => Ok(result),
            IpcResponse::Error { error, .. } => Err(anyhow!("Provider failed: {}", error)),
            _ => Err(anyhow!("Unexpected response")),
        }
    }

    /// Invoke an evaluator
    pub fn invoke_evaluator(
        &mut self,
        name: &str,
        memory: &serde_json::Value,
        state: Option<&serde_json::Value>,
    ) -> Result<Option<ActionResult>> {
        let id = self.next_id();
        let response = self.send_request(IpcRequest::EvaluatorInvoke {
            id,
            evaluator: name.to_string(),
            memory: memory.clone(),
            state: state.cloned(),
        })?;

        match response {
            IpcResponse::ActionResult { result, .. } => Ok(result),
            IpcResponse::Error { error, .. } => Err(anyhow!("Evaluator failed: {}", error)),
            _ => Err(anyhow!("Unexpected response")),
        }
    }
}

impl Drop for TypeScriptPluginBridge {
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
            "actions": [{"name": "test_action"}],
            "providers": [],
            "evaluators": []
        }"#;

        let manifest: TypeScriptManifest = serde_json::from_str(json).unwrap();
        assert_eq!(manifest.name, "test-plugin");
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






