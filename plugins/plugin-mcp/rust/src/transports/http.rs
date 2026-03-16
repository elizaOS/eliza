#![allow(missing_docs)]

use async_trait::async_trait;
use serde_json::Value;

use crate::error::{McpError, McpResult};
use crate::transport::Transport;
use crate::types::HttpServerConfig;

pub struct HttpTransport {
    config: HttpServerConfig,
    client: Option<reqwest::Client>,
    connected: bool,
}

impl HttpTransport {
    pub fn new(config: HttpServerConfig) -> Self {
        Self {
            config,
            client: None,
            connected: false,
        }
    }
}

#[async_trait]
impl Transport for HttpTransport {
    async fn connect(&mut self) -> McpResult<()> {
        if self.connected {
            return Err(McpError::AlreadyConnected);
        }

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(self.config.timeout_ms))
            .build()
            .map_err(|e| McpError::connection(e.to_string()))?;

        self.client = Some(client);
        self.connected = true;

        Ok(())
    }

    async fn send(&mut self, message: &Value) -> McpResult<()> {
        let client = self.client.as_ref().ok_or(McpError::NotConnected)?;

        client
            .post(&self.config.url)
            .header("Content-Type", "application/json")
            .json(message)
            .send()
            .await
            .map_err(|e| McpError::connection(e.to_string()))?
            .error_for_status()
            .map_err(|e| McpError::connection(e.to_string()))?;

        Ok(())
    }

    async fn receive(&mut self) -> McpResult<Value> {
        Err(McpError::protocol(
            "Direct receive not supported for HTTP transport, use send_request",
        ))
    }

    async fn close(&mut self) -> McpResult<()> {
        self.connected = false;
        self.client = None;
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.connected
    }
}

impl HttpTransport {
    pub async fn send_request(&mut self, message: Value) -> McpResult<Value> {
        let client = self.client.as_ref().ok_or(McpError::NotConnected)?;

        let response = client
            .post(&self.config.url)
            .header("Content-Type", "application/json")
            .json(&message)
            .send()
            .await
            .map_err(|e| McpError::connection(e.to_string()))?
            .error_for_status()
            .map_err(|e| McpError::connection(e.to_string()))?
            .json::<Value>()
            .await
            .map_err(|e| McpError::connection(e.to_string()))?;

        Ok(response)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_http_transport_creation() {
        let config = HttpServerConfig {
            url: "http://localhost:8080/mcp".to_string(),
            timeout_ms: 30000,
        };

        let transport = HttpTransport::new(config);
        assert!(!transport.is_connected());
    }
}
