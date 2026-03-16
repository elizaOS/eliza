//! elizaOS MCP Agent Server - Rust
//!
//! Exposes an elizaOS agent as an MCP server. Any MCP-compatible client
//! (Claude Desktop, VS Code, etc.) can interact with your agent.
//!
//! Uses real elizaOS runtime with OpenAI plugin.

use anyhow::Result;
use elizaos::{
    parse_character,
    runtime::{AgentRuntime, RuntimeOptions},
    types::{Content, Memory, UUID},
    IMessageService,
};
use elizaos_plugin_openai::create_openai_elizaos_plugin;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, Write};
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{error, info};

// ============================================================================
// Configuration
// ============================================================================

const CHARACTER_JSON: &str = r#"{
    "name": "Eliza",
    "bio": "A helpful AI assistant powered by elizaOS, accessible via MCP.",
    "system": "You are a helpful, friendly AI assistant. Be concise and informative."
}"#;

// ============================================================================
// MCP Types (simplified JSON-RPC over stdio)
// ============================================================================

#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    jsonrpc: String,
    id: Option<serde_json::Value>,
    method: String,
    #[serde(default)]
    params: serde_json::Value,
}

#[derive(Debug, Serialize)]
struct JsonRpcResponse {
    jsonrpc: String,
    id: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
}

#[derive(Debug, Serialize)]
struct JsonRpcError {
    code: i32,
    message: String,
}

#[derive(Debug, Serialize)]
struct Tool {
    name: String,
    description: String,
    #[serde(rename = "inputSchema")]
    input_schema: serde_json::Value,
}

#[derive(Debug, Serialize)]
struct ToolsResult {
    tools: Vec<Tool>,
}

#[derive(Debug, Serialize)]
struct TextContent {
    #[serde(rename = "type")]
    content_type: String,
    text: String,
}

#[derive(Debug, Serialize)]
struct CallToolResult {
    content: Vec<TextContent>,
    #[serde(rename = "isError", skip_serializing_if = "Option::is_none")]
    is_error: Option<bool>,
}

#[derive(Debug, Serialize)]
struct ServerInfo {
    name: String,
    version: String,
}

#[derive(Debug, Serialize)]
struct Capabilities {
    tools: serde_json::Value,
}

#[derive(Debug, Serialize)]
struct InitializeResult {
    #[serde(rename = "protocolVersion")]
    protocol_version: String,
    #[serde(rename = "serverInfo")]
    server_info: ServerInfo,
    capabilities: Capabilities,
}

#[derive(Debug, Serialize)]
struct AgentInfo {
    name: String,
    bio: String,
    capabilities: Vec<String>,
}

// ============================================================================
// MCP Server
// ============================================================================

struct McpServer {
    runtime: Arc<Mutex<Option<AgentRuntime>>>,
    room_id: UUID,
}

impl McpServer {
    fn new() -> Self {
        Self {
            runtime: Arc::new(Mutex::new(None)),
            room_id: UUID::new_v4(),
        }
    }

    async fn get_runtime(&self) -> Result<AgentRuntime> {
        let mut guard = self.runtime.lock().await;

        if let Some(ref rt) = *guard {
            // Clone isn't available, so we need to re-create for now
            // In a real implementation, we'd use Arc<AgentRuntime>
            drop(guard);
            return self.create_runtime().await;
        }

        let rt = self.create_runtime().await?;
        *guard = Some(rt.clone());
        Ok(rt)
    }

    async fn create_runtime(&self) -> Result<AgentRuntime> {
        let character = parse_character(CHARACTER_JSON)?;

        let runtime = AgentRuntime::new(RuntimeOptions {
            character: Some(character),
            plugins: vec![create_openai_elizaos_plugin()?],
            ..Default::default()
        })
        .await?;

        runtime.initialize().await?;
        Ok(runtime)
    }

    fn get_tools(&self) -> Vec<Tool> {
        vec![
            Tool {
                name: "chat".to_string(),
                description: "Send a message to the Eliza agent and receive a response"
                    .to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "message": {
                            "type": "string",
                            "description": "The message to send to the agent"
                        },
                        "userId": {
                            "type": "string",
                            "description": "Optional user identifier for conversation context"
                        }
                    },
                    "required": ["message"]
                }),
            },
            Tool {
                name: "get_agent_info".to_string(),
                description: "Get information about the Eliza agent".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {}
                }),
            },
        ]
    }

    async fn handle_chat(&self, message: &str, _user_id: Option<&str>) -> Result<String> {
        let runtime = self.get_runtime().await?;
        let user_id = UUID::new_v4();

        let content = Content {
            text: Some(message.to_string()),
            ..Default::default()
        };
        let mut msg = Memory::new(user_id.clone(), self.room_id.clone(), content);

        let result = runtime
            .message_service()
            .handle_message(&runtime, &mut msg, None, None)
            .await?;

        if let Some(response) = result.response_content.and_then(|c| c.text) {
            Ok(response)
        } else {
            Ok("I didn't generate a response. Please try again.".to_string())
        }
    }

    fn get_agent_info(&self) -> AgentInfo {
        AgentInfo {
            name: "Eliza".to_string(),
            bio: "A helpful AI assistant powered by elizaOS, accessible via MCP.".to_string(),
            capabilities: vec![
                "Natural language conversation".to_string(),
                "Helpful responses".to_string(),
                "Context-aware dialogue".to_string(),
            ],
        }
    }

    async fn handle_request(&self, request: JsonRpcRequest) -> JsonRpcResponse {
        let id = request.id.unwrap_or(serde_json::Value::Null);

        match request.method.as_str() {
            "initialize" => JsonRpcResponse {
                jsonrpc: "2.0".to_string(),
                id,
                result: Some(serde_json::to_value(InitializeResult {
                    protocol_version: "2024-11-05".to_string(),
                    server_info: ServerInfo {
                        name: "eliza-mcp-server".to_string(),
                        version: "1.0.0".to_string(),
                    },
                    capabilities: Capabilities {
                        tools: serde_json::json!({}),
                    },
                }).unwrap()),
                error: None,
            },

            "tools/list" => JsonRpcResponse {
                jsonrpc: "2.0".to_string(),
                id,
                result: Some(
                    serde_json::to_value(ToolsResult {
                        tools: self.get_tools(),
                    })
                    .unwrap(),
                ),
                error: None,
            },

            "tools/call" => {
                let tool_name = request.params.get("name").and_then(|v| v.as_str());
                let arguments = request.params.get("arguments").cloned().unwrap_or_default();

                match tool_name {
                    Some("chat") => {
                        let message = arguments.get("message").and_then(|v| v.as_str());
                        let user_id = arguments.get("userId").and_then(|v| v.as_str());

                        match message {
                            Some(msg) => match self.handle_chat(msg, user_id).await {
                                Ok(response) => JsonRpcResponse {
                                    jsonrpc: "2.0".to_string(),
                                    id,
                                    result: Some(
                                        serde_json::to_value(CallToolResult {
                                            content: vec![TextContent {
                                                content_type: "text".to_string(),
                                                text: response,
                                            }],
                                            is_error: None,
                                        })
                                        .unwrap(),
                                    ),
                                    error: None,
                                },
                                Err(e) => JsonRpcResponse {
                                    jsonrpc: "2.0".to_string(),
                                    id,
                                    result: Some(
                                        serde_json::to_value(CallToolResult {
                                            content: vec![TextContent {
                                                content_type: "text".to_string(),
                                                text: format!("Error: {}", e),
                                            }],
                                            is_error: Some(true),
                                        })
                                        .unwrap(),
                                    ),
                                    error: None,
                                },
                            },
                            None => JsonRpcResponse {
                                jsonrpc: "2.0".to_string(),
                                id,
                                result: Some(
                                    serde_json::to_value(CallToolResult {
                                        content: vec![TextContent {
                                            content_type: "text".to_string(),
                                            text: "Error: message is required".to_string(),
                                        }],
                                        is_error: Some(true),
                                    })
                                    .unwrap(),
                                ),
                                error: None,
                            },
                        }
                    }

                    Some("get_agent_info") => {
                        let info = self.get_agent_info();
                        JsonRpcResponse {
                            jsonrpc: "2.0".to_string(),
                            id,
                            result: Some(
                                serde_json::to_value(CallToolResult {
                                    content: vec![TextContent {
                                        content_type: "text".to_string(),
                                        text: serde_json::to_string_pretty(&info).unwrap(),
                                    }],
                                    is_error: None,
                                })
                                .unwrap(),
                            ),
                            error: None,
                        }
                    }

                    _ => JsonRpcResponse {
                        jsonrpc: "2.0".to_string(),
                        id,
                        result: None,
                        error: Some(JsonRpcError {
                            code: -32601,
                            message: format!("Unknown tool: {:?}", tool_name),
                        }),
                    },
                }
            }

            "notifications/initialized" => {
                // This is a notification, no response needed
                return JsonRpcResponse {
                    jsonrpc: "2.0".to_string(),
                    id: serde_json::Value::Null,
                    result: None,
                    error: None,
                };
            }

            _ => JsonRpcResponse {
                jsonrpc: "2.0".to_string(),
                id,
                result: None,
                error: Some(JsonRpcError {
                    code: -32601,
                    message: format!("Method not found: {}", request.method),
                }),
            },
        }
    }
}

// ============================================================================
// Main
// ============================================================================

#[tokio::main]
async fn main() -> Result<()> {
    let _ = dotenvy::dotenv();

    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("eliza_mcp_server=info".parse().unwrap()),
        )
        .init();

    eprintln!("🌐 elizaOS MCP Server starting on stdio");
    eprintln!("📚 Available tools: chat, get_agent_info");

    let server = McpServer::new();
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                error!("Failed to read line: {}", e);
                continue;
            }
        };

        if line.trim().is_empty() {
            continue;
        }

        let request: JsonRpcRequest = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                error!("Failed to parse request: {} - line: {}", e, line);
                continue;
            }
        };

        // Skip notification responses
        if request.method == "notifications/initialized" {
            continue;
        }

        let response = server.handle_request(request).await;

        // Don't send response for null id (notifications)
        if response.id == serde_json::Value::Null && response.result.is_none() && response.error.is_none() {
            continue;
        }

        let response_json = serde_json::to_string(&response)?;
        writeln!(stdout, "{}", response_json)?;
        stdout.flush()?;
    }

    Ok(())
}

