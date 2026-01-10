//! Transport implementations for MCP connections.

use async_trait::async_trait;
use serde_json::Value;
use std::collections::HashMap;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::error::{McpError, McpResult};
use crate::types::StdioServerConfig;

/// Trait for MCP transports.
#[async_trait]
pub trait Transport: Send + Sync {
    /// Connect to the MCP server.
    async fn connect(&mut self) -> McpResult<()>;

    /// Send a JSON-RPC message to the server.
    async fn send(&mut self, message: &Value) -> McpResult<()>;

    /// Receive a JSON-RPC message from the server.
    async fn receive(&mut self) -> McpResult<Value>;

    /// Close the connection.
    async fn close(&mut self) -> McpResult<()>;

    /// Check if the transport is connected.
    fn is_connected(&self) -> bool;
}

/// Transport that communicates with an MCP server via stdio.
pub struct StdioTransport {
    config: StdioServerConfig,
    process: Option<Child>,
    stdin: Option<tokio::process::ChildStdin>,
    stdout: Option<BufReader<tokio::process::ChildStdout>>,
    connected: bool,
}

impl StdioTransport {
    /// Create a new stdio transport.
    pub fn new(config: StdioServerConfig) -> Self {
        Self {
            config,
            process: None,
            stdin: None,
            stdout: None,
            connected: false,
        }
    }
}

#[async_trait]
impl Transport for StdioTransport {
    async fn connect(&mut self) -> McpResult<()> {
        if self.connected {
            return Err(McpError::AlreadyConnected);
        }

        // Build environment
        let mut env: HashMap<String, String> = std::env::vars().collect();
        env.extend(self.config.env.clone());

        // Start the subprocess
        let mut cmd = Command::new(&self.config.command);
        cmd.args(&self.config.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .envs(&env);

        if let Some(ref cwd) = self.config.cwd {
            cmd.current_dir(cwd);
        }

        let mut child = cmd.spawn().map_err(|e| McpError::connection(e.to_string()))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| McpError::connection("Failed to get stdin"))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| McpError::connection("Failed to get stdout"))?;

        self.process = Some(child);
        self.stdin = Some(stdin);
        self.stdout = Some(BufReader::new(stdout));
        self.connected = true;

        Ok(())
    }

    async fn send(&mut self, message: &Value) -> McpResult<()> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or(McpError::NotConnected)?;

        let json_str = serde_json::to_string(message)?;
        let content = format!("Content-Length: {}\r\n\r\n{}", json_str.len(), json_str);

        stdin
            .write_all(content.as_bytes())
            .await
            .map_err(|e| McpError::connection(e.to_string()))?;

        stdin
            .flush()
            .await
            .map_err(|e| McpError::connection(e.to_string()))?;

        Ok(())
    }

    async fn receive(&mut self) -> McpResult<Value> {
        let stdout = self
            .stdout
            .as_mut()
            .ok_or(McpError::NotConnected)?;

        // Read the Content-Length header
        let mut header_line = String::new();
        let timeout = tokio::time::Duration::from_millis(self.config.timeout_ms);

        let read_result = tokio::time::timeout(timeout, stdout.read_line(&mut header_line)).await;

        match read_result {
            Ok(Ok(0)) => return Err(McpError::connection("Connection closed by server")),
            Ok(Ok(_)) => {}
            Ok(Err(e)) => return Err(McpError::connection(e.to_string())),
            Err(_) => return Err(McpError::timeout("receive")),
        }

        let header = header_line.trim();
        if !header.starts_with("Content-Length:") {
            return Err(McpError::protocol(format!("Invalid header: {}", header)));
        }

        let content_length: usize = header
            .split(':')
            .nth(1)
            .ok_or_else(|| McpError::protocol("Missing content length value"))?
            .trim()
            .parse()
            .map_err(|_| McpError::protocol("Invalid content length"))?;

        // Read the empty line
        let mut empty_line = String::new();
        stdout
            .read_line(&mut empty_line)
            .await
            .map_err(|e| McpError::connection(e.to_string()))?;

        // Read the content
        let mut content = vec![0u8; content_length];
        let read_result =
            tokio::time::timeout(timeout, tokio::io::AsyncReadExt::read_exact(stdout, &mut content))
                .await;

        match read_result {
            Ok(Ok(_)) => {}
            Ok(Err(e)) => return Err(McpError::connection(e.to_string())),
            Err(_) => return Err(McpError::timeout("receive content")),
        }

        let json_str = String::from_utf8(content).map_err(|e| McpError::protocol(e.to_string()))?;

        serde_json::from_str(&json_str).map_err(McpError::from)
    }

    async fn close(&mut self) -> McpResult<()> {
        self.connected = false;

        if let Some(mut process) = self.process.take() {
            // Try to terminate gracefully
            let _ = process.kill().await;
        }

        self.stdin = None;
        self.stdout = None;

        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.connected
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_stdio_transport_creation() {
        let config = StdioServerConfig {
            command: "echo".to_string(),
            args: vec!["hello".to_string()],
            env: HashMap::new(),
            cwd: None,
            timeout_ms: 5000,
        };

        let transport = StdioTransport::new(config);
        assert!(!transport.is_connected());
    }
}


