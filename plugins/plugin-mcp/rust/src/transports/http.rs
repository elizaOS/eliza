//! HTTP/SSE transport for MCP connections.

use async_trait::async_trait;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};

use crate::error::{McpError, McpResult};
use crate::transport::Transport;
use crate::types::HttpServerConfig;

/// Transport that communicates with an MCP server via HTTP/SSE.
pub struct HttpTransport {
    config: HttpServerConfig,
    client: Option<reqwest::Client>,
    request_id: AtomicU64,
    pending_responses: Arc<Mutex<HashMap<u64, tokio::sync::oneshot::Sender<Value>>>>,
    sse_task: Option<tokio::task::JoinHandle<()>>,
    connected: bool,
    response_rx: Option<mpsc::Receiver<Value>>,
}

impl HttpTransport {
    /// Create a new HTTP transport.
    pub fn new(config: HttpServerConfig) -> Self {
        Self {
            config,
            client: None,
            request_id: AtomicU64::new(0),
            pending_responses: Arc::new(Mutex::new(HashMap::new())),
            sse_task: None,
            connected: false,
            response_rx: None,
        }
    }

    /// Generate the next request ID.
    fn next_id(&self) -> u64 {
        self.request_id.fetch_add(1, Ordering::SeqCst)
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
        // For simple HTTP transport, we use a request/response pattern
        // This is different from SSE where responses come asynchronously
        Err(McpError::protocol(
            "Direct receive not supported for HTTP transport, use send_request",
        ))
    }

    async fn close(&mut self) -> McpResult<()> {
        self.connected = false;

        if let Some(task) = self.sse_task.take() {
            task.abort();
        }

        self.client = None;
        self.pending_responses.lock().await.clear();

        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.connected
    }
}

impl HttpTransport {
    /// Send a request and receive the response.
    /// This is the primary method for HTTP-based MCP communication.
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



