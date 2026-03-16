use async_trait::async_trait;
use tracing::info;

use super::{ActionContext, ActionResult, McpAction};
use crate::error::McpResult;

pub struct CallToolAction;

impl CallToolAction {
    pub fn new() -> Self {
        Self
    }
}

impl Default for CallToolAction {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl McpAction for CallToolAction {
    fn name(&self) -> &'static str {
        "CALL_MCP_TOOL"
    }

    fn description(&self) -> &'static str {
        "Calls a tool from an MCP server to perform a specific task"
    }

    fn similes(&self) -> Vec<&'static str> {
        vec![
            "CALL_TOOL",
            "USE_TOOL",
            "USE_MCP_TOOL",
            "EXECUTE_TOOL",
            "EXECUTE_MCP_TOOL",
            "RUN_TOOL",
            "RUN_MCP_TOOL",
            "INVOKE_TOOL",
            "INVOKE_MCP_TOOL",
        ]
    }

    async fn validate(&self, context: &ActionContext) -> McpResult<bool> {
        let servers = context.state.get("mcpServers");

        if let Some(servers) = servers {
            if let Some(servers_arr) = servers.as_array() {
                for server in servers_arr {
                    let status = server.get("status").and_then(|s| s.as_str());
                    let tools = server.get("tools").and_then(|t| t.as_array());

                    if status == Some("connected") {
                        if let Some(tools) = tools {
                            if !tools.is_empty() {
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
        let tool_name = context
            .state
            .get("selectedTool")
            .and_then(|t| t.get("name"))
            .and_then(|n| n.as_str())
            .unwrap_or("");

        let server_name = context
            .state
            .get("selectedTool")
            .and_then(|t| t.get("server"))
            .and_then(|s| s.as_str())
            .unwrap_or("");

        info!("Calling tool {} on server {}", tool_name, server_name);

        Ok(ActionResult {
            success: true,
            text: format!("Successfully called tool: {}/{}", server_name, tool_name),
            values: serde_json::json!({
                "success": true,
                "toolExecuted": true,
                "serverName": server_name,
                "toolName": tool_name,
            }),
            data: serde_json::json!({
                "actionName": "CALL_MCP_TOOL",
                "serverName": server_name,
                "toolName": tool_name,
            }),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_action_name() {
        let action = CallToolAction::new();
        assert_eq!(action.name(), "CALL_MCP_TOOL");
    }

    #[test]
    fn test_similes() {
        let action = CallToolAction::new();
        let similes = action.similes();
        assert!(similes.contains(&"CALL_TOOL"));
        assert!(similes.contains(&"USE_TOOL"));
    }

    #[tokio::test]
    async fn test_validate_no_servers() {
        let action = CallToolAction::new();
        let context = ActionContext {
            message_text: "call a tool".to_string(),
            state: serde_json::json!({}),
        };

        let result = action.validate(&context).await.unwrap();
        assert!(!result);
    }

    #[tokio::test]
    async fn test_validate_with_tools() {
        let action = CallToolAction::new();
        let context = ActionContext {
            message_text: "call a tool".to_string(),
            state: serde_json::json!({
                "mcpServers": [{
                    "name": "test-server",
                    "status": "connected",
                    "tools": [{"name": "search"}]
                }]
            }),
        };

        let result = action.validate(&context).await.unwrap();
        assert!(result);
    }
}
