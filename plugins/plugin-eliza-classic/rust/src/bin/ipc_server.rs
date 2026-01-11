#![allow(missing_docs)]
//! IPC Server for ELIZA Classic Plugin
//!
//! This binary runs as a subprocess and handles JSON-RPC requests over stdin/stdout.
//! It allows any language runtime (TypeScript, Python, Go, etc.) to use the Rust
//! ELIZA implementation via subprocess communication.
//!
//! ## Usage
//!
//! ```bash
//! # Build with IPC feature
//! cargo build --features ipc --bin eliza-classic-ipc
//!
//! # Run as subprocess (from another process)
//! ./eliza-classic-ipc
//! ```
//!
//! ## Protocol
//!
//! The server reads JSON-RPC requests from stdin (one per line) and writes
//! JSON-RPC responses to stdout (one per line).
//!
//! ### Example Request
//! ```json
//! {"id": 1, "method": "generateResponse", "params": {"input": "Hello"}}
//! ```
//!
//! ### Example Response
//! ```json
//! {"id": 1, "result": {"response": "How do you do. Please state your problem."}}
//! ```

use elizaos_plugin_eliza_classic::interop::{handle_ipc_request, IpcRequest, IpcResponse};
use std::io::{self, BufRead, Write};

fn main() {
    // Print ready signal
    eprintln!("[eliza-classic-ipc] Server started, waiting for requests...");
    
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[eliza-classic-ipc] Error reading input: {}", e);
                continue;
            }
        };
        
        // Skip empty lines
        if line.trim().is_empty() {
            continue;
        }
        
        // Parse request
        let request: IpcRequest = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                let error_response = IpcResponse {
                    id: 0,
                    result: None,
                    error: Some(format!("Invalid JSON: {}", e)),
                };
                let output = serde_json::to_string(&error_response).unwrap();
                writeln!(stdout, "{}", output).ok();
                stdout.flush().ok();
                continue;
            }
        };
        
        // Handle request
        let response = handle_ipc_request(&request);
        
        // Write response
        match serde_json::to_string(&response) {
            Ok(output) => {
                writeln!(stdout, "{}", output).ok();
                stdout.flush().ok();
            }
            Err(e) => {
                eprintln!("[eliza-classic-ipc] Error serializing response: {}", e);
            }
        }
    }
    
    eprintln!("[eliza-classic-ipc] Server shutting down");
}






