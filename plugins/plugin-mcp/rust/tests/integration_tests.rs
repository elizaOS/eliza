//! Integration tests for the MCP client.

use elizaos_plugin_mcp::{ConnectionStatus, McpClient, StdioServerConfig, StdioTransport};
use std::collections::HashMap;

fn memory_server_config() -> StdioServerConfig {
    StdioServerConfig {
        command: "npx".to_string(),
        args: vec![
            "-y".to_string(),
            "@modelcontextprotocol/server-memory".to_string(),
        ],
        env: HashMap::new(),
        cwd: None,
        // 120 seconds to allow for package download on first run
        timeout_ms: 120000,
    }
}

fn is_npx_available() -> bool {
    std::process::Command::new("which")
        .arg("npx")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[tokio::test]
async fn test_connect_to_memory_server() {
    if !is_npx_available() {
        eprintln!("Skipping test: npx not available");
        return;
    }

    let config = memory_server_config();
    let transport = StdioTransport::new(config);
    let mut client = McpClient::new(Box::new(transport));

    let result = client.connect().await;
    assert!(result.is_ok(), "Failed to connect: {:?}", result.err());
    assert_eq!(client.status(), ConnectionStatus::Connected);

    let close_result = client.close().await;
    assert!(close_result.is_ok());
}

#[tokio::test]
async fn test_list_tools() {
    if !is_npx_available() {
        eprintln!("Skipping test: npx not available");
        return;
    }

    let config = memory_server_config();
    let transport = StdioTransport::new(config);
    let mut client = McpClient::new(Box::new(transport));

    client.connect().await.expect("Failed to connect");

    let tools = client.list_tools().await.expect("Failed to list tools");
    assert!(!tools.is_empty(), "Expected at least one tool");

    // Memory server should have create_entities tool (knowledge graph based)
    let has_create = tools.iter().any(|t| t.name == "create_entities");
    assert!(has_create, "Expected create_entities tool");

    client.close().await.expect("Failed to close");
}

#[tokio::test]
async fn test_call_tool() {
    if !is_npx_available() {
        eprintln!("Skipping test: npx not available");
        return;
    }

    let config = memory_server_config();
    let transport = StdioTransport::new(config);
    let mut client = McpClient::new(Box::new(transport));

    client.connect().await.expect("Failed to connect");

    // Use read_graph which doesn't require any arguments
    let result = client.call_tool("read_graph", serde_json::json!({})).await;

    assert!(result.is_ok(), "Failed to call tool: {:?}", result.err());

    client.close().await.expect("Failed to close");
}

#[tokio::test]
async fn test_call_tool_not_connected() {
    let config = StdioServerConfig {
        command: "false".to_string(), // Command that fails
        args: vec![],
        env: HashMap::new(),
        cwd: None,
        timeout_ms: 5000,
    };

    let transport = StdioTransport::new(config);
    let mut client = McpClient::new(Box::new(transport));

    let result = client.call_tool("some_tool", serde_json::json!({})).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_call_tool_empty_name() {
    if !is_npx_available() {
        eprintln!("Skipping test: npx not available");
        return;
    }

    let config = memory_server_config();
    let transport = StdioTransport::new(config);
    let mut client = McpClient::new(Box::new(transport));

    client.connect().await.expect("Failed to connect");

    let result = client.call_tool("", serde_json::json!({})).await;
    assert!(result.is_err());

    client.close().await.expect("Failed to close");
}
