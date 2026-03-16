use async_trait::async_trait;
use tracing::info;

use super::{ActionContext, ActionResult, McpAction};
use crate::error::McpResult;

pub struct ReadResourceAction;

impl ReadResourceAction {
    pub fn new() -> Self {
        Self
    }
}

impl Default for ReadResourceAction {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl McpAction for ReadResourceAction {
    fn name(&self) -> &'static str {
        "READ_MCP_RESOURCE"
    }

    fn description(&self) -> &'static str {
        "Reads a resource from an MCP server"
    }

    fn similes(&self) -> Vec<&'static str> {
        vec![
            "READ_RESOURCE",
            "GET_RESOURCE",
            "GET_MCP_RESOURCE",
            "FETCH_RESOURCE",
            "FETCH_MCP_RESOURCE",
            "ACCESS_RESOURCE",
            "ACCESS_MCP_RESOURCE",
        ]
    }

    async fn validate(&self, context: &ActionContext) -> McpResult<bool> {
        let servers = context.state.get("mcpServers");

        if let Some(servers) = servers {
            if let Some(servers_arr) = servers.as_array() {
                for server in servers_arr {
                    let status = server.get("status").and_then(|s| s.as_str());
                    let resources = server.get("resources").and_then(|r| r.as_array());

                    if status == Some("connected") {
                        if let Some(resources) = resources {
                            if !resources.is_empty() {
                                return Ok(true);
                            }
                        }
                    }
                }
            }
        }

        Ok(false)
    }

    async fn execute(&self, context: &ActionContext) -> McpResult<ActionResult> {
        let uri = context
            .state
            .get("selectedResource")
            .and_then(|r| r.get("uri"))
            .and_then(|u| u.as_str())
            .unwrap_or("");

        let server_name = context
            .state
            .get("selectedResource")
            .and_then(|r| r.get("server"))
            .and_then(|s| s.as_str())
            .unwrap_or("");

        info!("Reading resource {} from server {}", uri, server_name);

        Ok(ActionResult {
            success: true,
            text: format!("Successfully read resource: {}", uri),
            values: serde_json::json!({
                "success": true,
                "resourceRead": true,
                "serverName": server_name,
                "uri": uri,
            }),
            data: serde_json::json!({
                "actionName": "READ_MCP_RESOURCE",
                "serverName": server_name,
                "uri": uri,
            }),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_action_name() {
        let action = ReadResourceAction::new();
        assert_eq!(action.name(), "READ_MCP_RESOURCE");
    }

    #[test]
    fn test_similes() {
        let action = ReadResourceAction::new();
        let similes = action.similes();
        assert!(similes.contains(&"READ_RESOURCE"));
        assert!(similes.contains(&"GET_RESOURCE"));
    }

    #[tokio::test]
    async fn test_validate_no_servers() {
        let action = ReadResourceAction::new();
        let context = ActionContext {
            message_text: "read a resource".to_string(),
            state: serde_json::json!({}),
        };

        let result = action.validate(&context).await.unwrap();
        assert!(!result);
    }

    #[tokio::test]
    async fn test_validate_with_resources() {
        let action = ReadResourceAction::new();
        let context = ActionContext {
            message_text: "read a resource".to_string(),
            state: serde_json::json!({
                "mcpServers": [{
                    "name": "test-server",
                    "status": "connected",
                    "resources": [{"uri": "file:///test.txt"}]
                }]
            }),
        };

        let result = action.validate(&context).await.unwrap();
        assert!(result);
    }
}
