use async_trait::async_trait;

use super::{McpProviderTrait, ProviderContext, ProviderResult};

pub struct McpProvider;

impl McpProvider {
    pub fn new() -> Self {
        Self
    }

    pub fn format_servers(&self, servers: &serde_json::Value) -> String {
        if let Some(servers_arr) = servers.as_array() {
            if servers_arr.is_empty() {
                return "No MCP servers are available.".to_string();
            }

            let mut output = String::new();
            output.push_str("# Connected MCP Servers\n\n");

            for server in servers_arr {
                let name = server.get("name").and_then(|n| n.as_str()).unwrap_or("");
                let status = server.get("status").and_then(|s| s.as_str()).unwrap_or("");

                output.push_str(&format!("## {} ({})\n", name, status));

                if let Some(tools) = server.get("tools").and_then(|t| t.as_array()) {
                    if !tools.is_empty() {
                        output.push_str("\n**Tools:**\n");
                        for tool in tools {
                            let tool_name = tool.get("name").and_then(|n| n.as_str()).unwrap_or("");
                            let description = tool
                                .get("description")
                                .and_then(|d| d.as_str())
                                .unwrap_or("");
                            output.push_str(&format!("- {}: {}\n", tool_name, description));
                        }
                    }
                }

                if let Some(resources) = server.get("resources").and_then(|r| r.as_array()) {
                    if !resources.is_empty() {
                        output.push_str("\n**Resources:**\n");
                        for resource in resources {
                            let uri = resource.get("uri").and_then(|u| u.as_str()).unwrap_or("");
                            let name = resource.get("name").and_then(|n| n.as_str()).unwrap_or("");
                            output.push_str(&format!("- {}: {}\n", uri, name));
                        }
                    }
                }

                output.push('\n');
            }

            output
        } else {
            "No MCP servers are available.".to_string()
        }
    }
}

impl Default for McpProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl McpProviderTrait for McpProvider {
    fn name(&self) -> &'static str {
        "MCP"
    }

    fn description(&self) -> &'static str {
        "Information about connected MCP servers, tools, and resources"
    }

    async fn get(&self, context: &ProviderContext) -> ProviderResult {
        let servers = context
            .state
            .get("mcpServers")
            .cloned()
            .unwrap_or(serde_json::json!([]));

        let text = self.format_servers(&servers);
        let server_count = servers.as_array().map(|a| a.len()).unwrap_or(0);

        ProviderResult {
            values: serde_json::json!({
                "mcpServers": serde_json::to_string(&servers).unwrap_or_default(),
            }),
            data: serde_json::json!({
                "mcpServerCount": server_count,
            }),
            text,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_servers_empty() {
        let provider = McpProvider::new();
        let servers = serde_json::json!([]);
        let formatted = provider.format_servers(&servers);
        assert_eq!(formatted, "No MCP servers are available.");
    }

    #[test]
    fn test_format_servers_with_data() {
        let provider = McpProvider::new();
        let servers = serde_json::json!([{
            "name": "test-server",
            "status": "connected",
            "tools": [{
                "name": "search",
                "description": "Search the web"
            }],
            "resources": [{
                "uri": "file:///docs",
                "name": "Documentation"
            }]
        }]);

        let formatted = provider.format_servers(&servers);
        assert!(formatted.contains("test-server"));
        assert!(formatted.contains("connected"));
        assert!(formatted.contains("search"));
        assert!(formatted.contains("Documentation"));
    }

    #[tokio::test]
    async fn test_get_empty() {
        let provider = McpProvider::new();
        let context = ProviderContext {
            state: serde_json::json!({}),
        };

        let result = provider.get(&context).await;
        assert!(result.text.contains("No MCP servers"));
    }
}
