//! Rust Runtime Loading Plugins from All Languages
//!
//! This example demonstrates how the Rust runtime can load:
//! - Native Rust plugins directly
//! - TypeScript plugins via IPC subprocess
//! - Python plugins via IPC subprocess
//!
//! # Usage
//!
//! ```bash
//! cargo run --example rust_loads_all
//! ```

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};

// ============================================================================
// IPC Types
// ============================================================================

#[derive(Debug, Serialize)]
struct IpcRequest {
    id: u64,
    method: String,
    params: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct IpcResponse {
    id: u64,
    result: Option<serde_json::Value>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PluginManifest {
    name: String,
    description: String,
    actions: Option<Vec<ActionManifest>>,
}

#[derive(Debug, Deserialize)]
struct ActionManifest {
    name: String,
    description: String,
}

#[derive(Debug, Deserialize)]
struct ActionResult {
    success: bool,
    text: Option<String>,
    error: Option<String>,
}

// ============================================================================
// IPC Bridge
// ============================================================================

struct IpcPluginBridge {
    process: Child,
    request_id: u64,
}

impl IpcPluginBridge {
    fn spawn_python(plugin_path: &str) -> Result<Self, Box<dyn std::error::Error>> {
        let process = Command::new("python3")
            .args(["-m", "elizaos.interop.bridge_server", plugin_path])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;

        Ok(Self {
            process,
            request_id: 0,
        })
    }

    fn spawn_typescript(plugin_path: &str) -> Result<Self, Box<dyn std::error::Error>> {
        let process = Command::new("npx")
            .args(["ts-node", "-e", &format!(
                r#"
                const {{ runBridgeServer }} = require('@elizaos/interop/typescript/ts-bridge-server');
                runBridgeServer('{}');
                "#,
                plugin_path
            )])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;

        Ok(Self {
            process,
            request_id: 0,
        })
    }

    fn spawn_rust_ipc(binary_path: &str) -> Result<Self, Box<dyn std::error::Error>> {
        let process = Command::new(binary_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;

        Ok(Self {
            process,
            request_id: 0,
        })
    }

    fn send_request(
        &mut self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
        self.request_id += 1;
        let request = IpcRequest {
            id: self.request_id,
            method: method.to_string(),
            params,
        };

        let stdin = self.process.stdin.as_mut().ok_or("No stdin")?;
        let request_json = serde_json::to_string(&request)?;
        writeln!(stdin, "{}", request_json)?;
        stdin.flush()?;

        let stdout = self.process.stdout.as_mut().ok_or("No stdout")?;
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        reader.read_line(&mut line)?;

        let response: IpcResponse = serde_json::from_str(&line)?;

        if let Some(error) = response.error {
            return Err(error.into());
        }

        Ok(response.result.unwrap_or(serde_json::Value::Null))
    }

    fn get_manifest(&mut self) -> Result<PluginManifest, Box<dyn std::error::Error>> {
        let result = self.send_request("getManifest", serde_json::json!({}))?;
        Ok(serde_json::from_value(result)?)
    }

    fn invoke_action(
        &mut self,
        name: &str,
        memory: &serde_json::Value,
        state: &serde_json::Value,
        options: &serde_json::Value,
    ) -> Result<ActionResult, Box<dyn std::error::Error>> {
        let result = self.send_request(
            "invokeAction",
            serde_json::json!({
                "name": name,
                "memory": memory,
                "state": state,
                "options": options,
            }),
        )?;
        Ok(serde_json::from_value(result)?)
    }
}

impl Drop for IpcPluginBridge {
    fn drop(&mut self) {
        let _ = self.process.kill();
    }
}

// ============================================================================
// Example 1: Load Native Rust Plugin
// ============================================================================

fn load_native_rust() {
    println!("\n=== Loading Native Rust Plugin ===\n");

    // Direct usage of Rust plugin - no interop needed!
    use elizaos_plugin_eliza_classic::ElizaClassicPlugin;

    let plugin = ElizaClassicPlugin::new();

    println!("Plugin: eliza-classic (native Rust)");
    println!("Greeting: {}", plugin.get_greeting());

    let test_inputs = [
        "I am feeling sad",
        "Why don't you help me?",
        "My computer is broken",
        "Hello",
    ];

    println!("\nTest responses:");
    for input in &test_inputs {
        let response = plugin.generate_response(input);
        println!("  User: {}", input);
        println!("  ELIZA: {}\n", response);
    }
}

// ============================================================================
// Example 2: Load TypeScript Plugin via IPC
// ============================================================================

fn load_typescript_via_ipc() {
    println!("\n=== Loading TypeScript Plugin via IPC ===\n");

    match IpcPluginBridge::spawn_typescript("./plugins/plugin-eliza-classic/typescript") {
        Ok(mut bridge) => {
            match bridge.get_manifest() {
                Ok(manifest) => {
                    println!("Plugin: {}", manifest.name);
                    println!("Description: {}", manifest.description);

                    if let Some(actions) = &manifest.actions {
                        println!("Actions: {:?}", actions.iter().map(|a| &a.name).collect::<Vec<_>>());
                    }

                    // Test action invocation
                    let memory = serde_json::json!({
                        "content": {"text": "I am feeling anxious"}
                    });
                    let state = serde_json::json!({});
                    let options = serde_json::json!({});

                    println!("\nInvoking action with: \"I am feeling anxious\"");
                    match bridge.invoke_action("generate-response", &memory, &state, &options) {
                        Ok(result) => {
                            println!("Response: {}", result.text.unwrap_or_default());
                        }
                        Err(e) => println!("Action failed: {}", e),
                    }
                }
                Err(e) => println!("Failed to get manifest: {}", e),
            }
        }
        Err(e) => {
            println!("TypeScript IPC loading skipped: {}", e);
            println!("(Ensure Node.js and ts-node are installed)");
        }
    }
}

// ============================================================================
// Example 3: Load Python Plugin via IPC
// ============================================================================

fn load_python_via_ipc() {
    println!("\n=== Loading Python Plugin via IPC ===\n");

    match IpcPluginBridge::spawn_python("./plugins/plugin-eliza-classic/python") {
        Ok(mut bridge) => {
            match bridge.get_manifest() {
                Ok(manifest) => {
                    println!("Plugin: {}", manifest.name);
                    println!("Description: {}", manifest.description);

                    if let Some(actions) = &manifest.actions {
                        println!("Actions: {:?}", actions.iter().map(|a| &a.name).collect::<Vec<_>>());
                    }

                    // Test action invocation
                    let memory = serde_json::json!({
                        "content": {"text": "I dream about success"}
                    });
                    let state = serde_json::json!({});
                    let options = serde_json::json!({});

                    println!("\nInvoking action with: \"I dream about success\"");
                    match bridge.invoke_action("generate-response", &memory, &state, &options) {
                        Ok(result) => {
                            println!("Response: {}", result.text.unwrap_or_default());
                        }
                        Err(e) => println!("Action failed: {}", e),
                    }
                }
                Err(e) => println!("Failed to get manifest: {}", e),
            }
        }
        Err(e) => {
            println!("Python IPC loading skipped: {}", e);
            println!("(Ensure Python 3 is installed)");
        }
    }
}

// ============================================================================
// Example 4: Load Another Rust Plugin via IPC
// ============================================================================

fn load_rust_via_ipc() {
    println!("\n=== Loading Rust Plugin via IPC ===\n");

    let binary_path = "./target/release/eliza-classic-ipc";

    match IpcPluginBridge::spawn_rust_ipc(binary_path) {
        Ok(mut bridge) => {
            match bridge.get_manifest() {
                Ok(manifest) => {
                    println!("Plugin: {}", manifest.name);
                    println!("Description: {}", manifest.description);

                    if let Some(actions) = &manifest.actions {
                        println!("Actions: {:?}", actions.iter().map(|a| &a.name).collect::<Vec<_>>());
                    }

                    // Test action invocation
                    let memory = serde_json::json!({
                        "content": {"text": "Everyone hates me"}
                    });
                    let state = serde_json::json!({});
                    let options = serde_json::json!({});

                    println!("\nInvoking action with: \"Everyone hates me\"");
                    match bridge.invoke_action("generate-response", &memory, &state, &options) {
                        Ok(result) => {
                            println!("Response: {}", result.text.unwrap_or_default());
                        }
                        Err(e) => println!("Action failed: {}", e),
                    }
                }
                Err(e) => println!("Failed to get manifest: {}", e),
            }
        }
        Err(e) => {
            println!("Rust IPC loading skipped: {}", e);
            println!("(Build IPC server first with: cargo build --release --features ipc --bin eliza-classic-ipc)");
        }
    }
}

// ============================================================================
// Interop Matrix
// ============================================================================

fn print_interop_matrix() {
    println!("\n{}", "=".repeat(60));
    println!("elizaOS Cross-Language Interop Matrix (from Rust)");
    println!("{}", "=".repeat(60));

    let matrix = r#"
    ┌──────────────┬──────────────┬──────────┬─────────────────┐
    │ Host Runtime │ Plugin Lang  │ Method   │ Status          │
    ├──────────────┼──────────────┼──────────┼─────────────────┤
    │ Rust         │ Rust         │ Direct   │ ✓ Native        │
    │ Rust         │ Rust         │ IPC      │ ✓ Subprocess    │
    │ Rust         │ TypeScript   │ IPC      │ ✓ Subprocess    │
    │ Rust         │ Python       │ IPC      │ ✓ Subprocess    │
    └──────────────┴──────────────┴──────────┴─────────────────┘

    Note: Rust can also load WASM modules directly using wasmtime,
    but for Rust-to-Rust this is typically overkill.
    "#;
    println!("{}", matrix);
}

// ============================================================================
// Main
// ============================================================================

fn main() {
    println!("{}", "=".repeat(60));
    println!("Rust Runtime - Cross-Language Plugin Loading Demo");
    println!("{}", "=".repeat(60));

    print_interop_matrix();

    load_native_rust();
    load_rust_via_ipc();
    load_typescript_via_ipc();
    load_python_via_ipc();

    println!("\n{}", "=".repeat(60));
    println!("Demo complete!");
    println!("{}", "=".repeat(60));
}






