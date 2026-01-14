#![allow(missing_docs)]

use std::collections::HashMap;

use crate::client::McpClient;

/// Minimal service wrapper for MCP server connections (TS parity: `McpService`).
pub struct McpService {
    clients: HashMap<String, McpClient>,
}

impl McpService {
    pub const SERVICE_TYPE: &'static str = "mcp";
    pub const CAPABILITY_DESCRIPTION: &'static str =
        "Enables the agent to interact with MCP (Model Context Protocol) servers";

    pub fn new() -> Self {
        Self {
            clients: HashMap::new(),
        }
    }

    pub fn insert_client(&mut self, name: impl Into<String>, client: McpClient) {
        self.clients.insert(name.into(), client);
    }

    pub fn client(&self, name: &str) -> Option<&McpClient> {
        self.clients.get(name)
    }

    pub fn remove_client(&mut self, name: &str) -> Option<McpClient> {
        self.clients.remove(name)
    }

    pub async fn stop(&mut self) {
        self.clients.clear();
    }
}

impl Default for McpService {
    fn default() -> Self {
        Self::new()
    }
}
