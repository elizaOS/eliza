#![allow(missing_docs)]

use async_trait::async_trait;
use serde_json::Value;
use std::collections::HashMap;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};

use crate::error::{McpError, McpResult};
use crate::types::StdioServerConfig;

#[async_trait]
pub trait Transport: Send + Sync {
    async fn connect(&mut self) -> McpResult<()>;
    async fn send(&mut self, message: &Value) -> McpResult<()>;
    async fn receive(&mut self) -> McpResult<Value>;
    async fn close(&mut self) -> McpResult<()>;
    fn is_connected(&self) -> bool;
}

pub struct StdioTransport {
    config: StdioServerConfig,
    process: Option<Child>,
    stdin: Option<tokio::process::ChildStdin>,
    stdout: Option<BufReader<tokio::process::ChildStdout>>,
    connected: bool,
}

impl StdioTransport {
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

        let mut env: HashMap<String, String> = std::env::vars().collect();
        env.extend(self.config.env.clone());

        let mut cmd = Command::new(&self.config.command);
        cmd.args(&self.config.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .envs(&env);

        if let Some(ref cwd) = self.config.cwd {
            cmd.current_dir(cwd);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| McpError::connection(e.to_string()))?;

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
        let stdin = self.stdin.as_mut().ok_or(McpError::NotConnected)?;

        let json_str = serde_json::to_string(message)?;
        let content = format!("{}\n", json_str);

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
        let stdout = self.stdout.as_mut().ok_or(McpError::NotConnected)?;

        let timeout = tokio::time::Duration::from_millis(self.config.timeout_ms);

        loop {
            let mut line = String::new();
            let read_result = tokio::time::timeout(timeout, stdout.read_line(&mut line)).await;

            match read_result {
                Ok(Ok(0)) => return Err(McpError::connection("Connection closed by server")),
                Ok(Ok(_)) => {}
                Ok(Err(e)) => return Err(McpError::connection(e.to_string())),
                Err(_) => return Err(McpError::timeout("receive")),
            }

            let trimmed = line.trim();

            if trimmed.is_empty() || !trimmed.starts_with('{') {
                continue;
            }

            match serde_json::from_str(trimmed) {
                Ok(value) => return Ok(value),
                Err(_) => continue,
            }
        }
    }

    async fn close(&mut self) -> McpResult<()> {
        self.connected = false;

        if let Some(mut process) = self.process.take() {
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
