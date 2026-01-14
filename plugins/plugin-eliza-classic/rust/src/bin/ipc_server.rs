#![allow(missing_docs)]

use elizaos_plugin_eliza_classic::interop::{handle_ipc_request, IpcRequest, IpcResponse};
use std::io::{self, BufRead, Write};

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::stdout();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };

        if line.trim().is_empty() {
            continue;
        }

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

        let response = handle_ipc_request(&request);

        if let Ok(output) = serde_json::to_string(&response) {
            writeln!(stdout, "{}", output).ok();
            stdout.flush().ok();
        }
    }
}
