#![allow(missing_docs)]

use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::error::{McpError, McpResult};
use crate::transport::Transport;
use crate::types::{
    ConnectionStatus, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse, McpResource,
    McpResourceContent, McpResourceTemplate, McpTool, McpToolResult,
};

pub struct McpClient {
    transport: Box<dyn Transport>,
    request_id: AtomicU64,
    status: ConnectionStatus,
    server_info: Option<Value>,
}

impl McpClient {
    pub fn new(transport: Box<dyn Transport>) -> Self {
        Self {
            transport,
            request_id: AtomicU64::new(0),
            status: ConnectionStatus::Disconnected,
            server_info: None,
        }
    }

    pub fn status(&self) -> ConnectionStatus {
        self.status
    }

    pub fn server_info(&self) -> Option<&Value> {
        self.server_info.as_ref()
    }

    fn next_id(&self) -> u64 {
        self.request_id.fetch_add(1, Ordering::SeqCst)
    }

    pub async fn connect(&mut self) -> McpResult<()> {
        self.status = ConnectionStatus::Connecting;

        self.transport.connect().await?;

        let init_request = JsonRpcRequest::new(
            self.next_id(),
            "initialize",
            Some(json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {
                    "name": "elizaos-plugin-mcp",
                    "version": "2.0.0-alpha"
                }
            })),
        );

        self.transport
            .send(&serde_json::to_value(&init_request)?)
            .await?;
        let response: JsonRpcResponse = serde_json::from_value(self.transport.receive().await?)?;

        if let Some(error) = response.error {
            self.status = ConnectionStatus::Failed;
            return Err(McpError::server(error.code, error.message));
        }

        self.server_info = response.result;

        let initialized_notification = JsonRpcNotification::new("notifications/initialized", None);
        self.transport
            .send(&serde_json::to_value(&initialized_notification)?)
            .await?;

        self.status = ConnectionStatus::Connected;
        Ok(())
    }

    pub async fn close(&mut self) -> McpResult<()> {
        self.transport.close().await?;
        self.status = ConnectionStatus::Disconnected;
        Ok(())
    }

    pub async fn list_tools(&mut self) -> McpResult<Vec<McpTool>> {
        if self.status != ConnectionStatus::Connected {
            return Err(McpError::NotConnected);
        }

        let request = JsonRpcRequest::new(self.next_id(), "tools/list", None);
        self.transport
            .send(&serde_json::to_value(&request)?)
            .await?;

        let response: JsonRpcResponse = serde_json::from_value(self.transport.receive().await?)?;

        if let Some(error) = response.error {
            return Err(McpError::server(error.code, error.message));
        }

        let result = response
            .result
            .ok_or_else(|| McpError::protocol("Missing result"))?;
        let tools: Vec<McpTool> =
            serde_json::from_value(result.get("tools").cloned().unwrap_or(Value::Array(vec![])))?;

        Ok(tools)
    }

    pub async fn call_tool(&mut self, name: &str, arguments: Value) -> McpResult<McpToolResult> {
        if self.status != ConnectionStatus::Connected {
            return Err(McpError::NotConnected);
        }

        if name.is_empty() {
            return Err(McpError::invalid_argument("Tool name is required"));
        }

        let request = JsonRpcRequest::new(
            self.next_id(),
            "tools/call",
            Some(json!({
                "name": name,
                "arguments": arguments
            })),
        );

        self.transport
            .send(&serde_json::to_value(&request)?)
            .await?;
        let response: JsonRpcResponse = serde_json::from_value(self.transport.receive().await?)?;

        if let Some(error) = response.error {
            return Err(McpError::server(error.code, error.message));
        }

        let result = response
            .result
            .ok_or_else(|| McpError::protocol("Missing result"))?;
        Ok(serde_json::from_value(result)?)
    }

    pub async fn list_resources(&mut self) -> McpResult<Vec<McpResource>> {
        if self.status != ConnectionStatus::Connected {
            return Err(McpError::NotConnected);
        }

        let request = JsonRpcRequest::new(self.next_id(), "resources/list", None);
        self.transport
            .send(&serde_json::to_value(&request)?)
            .await?;

        let response: JsonRpcResponse = serde_json::from_value(self.transport.receive().await?)?;

        if let Some(error) = response.error {
            return Err(McpError::server(error.code, error.message));
        }

        let result = response
            .result
            .ok_or_else(|| McpError::protocol("Missing result"))?;
        let resources: Vec<McpResource> = serde_json::from_value(
            result
                .get("resources")
                .cloned()
                .unwrap_or(Value::Array(vec![])),
        )?;

        Ok(resources)
    }

    pub async fn read_resource(&mut self, uri: &str) -> McpResult<Vec<McpResourceContent>> {
        if self.status != ConnectionStatus::Connected {
            return Err(McpError::NotConnected);
        }

        if uri.is_empty() {
            return Err(McpError::invalid_argument("Resource URI is required"));
        }

        let request = JsonRpcRequest::new(
            self.next_id(),
            "resources/read",
            Some(json!({
                "uri": uri
            })),
        );

        self.transport
            .send(&serde_json::to_value(&request)?)
            .await?;
        let response: JsonRpcResponse = serde_json::from_value(self.transport.receive().await?)?;

        if let Some(error) = response.error {
            return Err(McpError::server(error.code, error.message));
        }

        let result = response
            .result
            .ok_or_else(|| McpError::protocol("Missing result"))?;
        let contents: Vec<McpResourceContent> = serde_json::from_value(
            result
                .get("contents")
                .cloned()
                .unwrap_or(Value::Array(vec![])),
        )?;

        Ok(contents)
    }

    pub async fn list_resource_templates(&mut self) -> McpResult<Vec<McpResourceTemplate>> {
        if self.status != ConnectionStatus::Connected {
            return Err(McpError::NotConnected);
        }

        let request = JsonRpcRequest::new(self.next_id(), "resources/templates/list", None);
        self.transport
            .send(&serde_json::to_value(&request)?)
            .await?;

        let response: JsonRpcResponse = serde_json::from_value(self.transport.receive().await?)?;

        if let Some(error) = response.error {
            return Err(McpError::server(error.code, error.message));
        }

        let result = response
            .result
            .ok_or_else(|| McpError::protocol("Missing result"))?;
        let templates: Vec<McpResourceTemplate> = serde_json::from_value(
            result
                .get("resourceTemplates")
                .cloned()
                .unwrap_or(Value::Array(vec![])),
        )?;

        Ok(templates)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::StdioTransport;
    use crate::types::StdioServerConfig;
    use std::collections::HashMap;

    fn create_test_config() -> StdioServerConfig {
        StdioServerConfig {
            command: "echo".to_string(),
            args: vec![],
            env: HashMap::new(),
            cwd: None,
            timeout_ms: 5000,
        }
    }

    #[test]
    fn test_client_creation() {
        let config = create_test_config();
        let transport = StdioTransport::new(config);
        let client = McpClient::new(Box::new(transport));
        assert_eq!(client.status(), ConnectionStatus::Disconnected);
    }
}
