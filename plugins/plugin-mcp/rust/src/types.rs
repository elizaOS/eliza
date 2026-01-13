#![allow(missing_docs)]
//! Type definitions for the MCP plugin.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Status of an MCP server connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionStatus {
    /// Currently connecting to the server.
    Connecting,
    /// Successfully connected to the server.
    Connected,
    /// Disconnected from the server.
    Disconnected,
    /// Connection failed.
    Failed,
}

/// Configuration for a stdio-based MCP server.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StdioServerConfig {
    /// Command to execute.
    pub command: String,
    /// Command arguments.
    #[serde(default)]
    pub args: Vec<String>,
    /// Environment variables.
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// Working directory.
    #[serde(default)]
    pub cwd: Option<String>,
    /// Timeout in milliseconds.
    #[serde(default = "default_timeout")]
    pub timeout_ms: u64,
}

fn default_timeout() -> u64 {
    60000
}

/// Configuration for an HTTP/SSE-based MCP server.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpServerConfig {
    /// Server URL.
    pub url: String,
    /// Timeout in milliseconds.
    #[serde(default = "default_http_timeout")]
    pub timeout_ms: u64,
}

fn default_http_timeout() -> u64 {
    30000
}

/// Configuration for an MCP server.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum McpServerConfig {
    /// Stdio-based server.
    Stdio(StdioServerConfig),
    /// HTTP-based server.
    Http(HttpServerConfig),
    /// SSE-based server (alias for HTTP).
    #[serde(rename = "sse")]
    Sse(HttpServerConfig),
}

/// A JSON Schema property definition.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonSchemaProperty {
    /// The type of the property.
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub property_type: Option<String>,
    /// Description of the property.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Nested properties (for object types).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub properties: Option<HashMap<String, JsonSchemaProperty>>,
    /// Required properties (for object types).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required: Option<Vec<String>>,
    /// Items schema (for array types).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items: Option<Box<JsonSchemaProperty>>,
    /// Enum values.
    #[serde(rename = "enum", skip_serializing_if = "Option::is_none")]
    pub enum_values: Option<Vec<String>>,
    /// Minimum value (for numeric types).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minimum: Option<f64>,
    /// Maximum value (for numeric types).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub maximum: Option<f64>,
    /// Minimum length (for string types).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_length: Option<usize>,
    /// Maximum length (for string types).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_length: Option<usize>,
    /// Pattern (for string types).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    /// Format (for string types).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
}

/// Input schema for an MCP tool.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInputSchema {
    /// The type (always "object").
    #[serde(rename = "type", default = "default_object_type")]
    pub schema_type: String,
    /// Properties of the input object.
    #[serde(default)]
    pub properties: HashMap<String, JsonSchemaProperty>,
    /// Required properties.
    #[serde(default)]
    pub required: Vec<String>,
}

fn default_object_type() -> String {
    "object".to_string()
}

/// An MCP tool definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    /// Name of the tool.
    pub name: String,
    /// Description of the tool.
    #[serde(default)]
    pub description: String,
    /// Input schema for the tool.
    #[serde(default)]
    pub input_schema: McpToolInputSchema,
}

/// An MCP resource definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpResource {
    /// URI of the resource.
    pub uri: String,
    /// Name of the resource.
    pub name: String,
    /// Description of the resource.
    #[serde(default)]
    pub description: String,
    /// MIME type of the resource.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
}

/// An MCP resource template definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceTemplate {
    /// URI template for the resource.
    pub uri_template: String,
    /// Name of the resource template.
    pub name: String,
    /// Description of the resource template.
    #[serde(default)]
    pub description: String,
    /// MIME type of resources from this template.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
}

/// Text content from an MCP tool or resource.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextContent {
    /// Content type (always "text").
    #[serde(rename = "type")]
    pub content_type: String,
    /// The text content.
    pub text: String,
}

/// Image content from an MCP tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageContent {
    /// Content type (always "image").
    #[serde(rename = "type")]
    pub content_type: String,
    /// Base64 encoded image data.
    pub data: String,
    /// MIME type of the image.
    pub mime_type: String,
}

/// Content from an MCP resource.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceContent {
    /// URI of the resource.
    pub uri: String,
    /// MIME type of the resource.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    /// Text content (if text).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Binary content as base64 (if binary).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blob: Option<String>,
}

/// Content item from a tool result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum McpContent {
    /// Text content.
    Text { text: String },
    /// Image content.
    Image {
        data: String,
        #[serde(rename = "mimeType")]
        mime_type: String,
    },
    /// Embedded resource.
    Resource { resource: McpResourceContent },
}

/// Result from calling an MCP tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolResult {
    /// Content items from the tool.
    pub content: Vec<McpContent>,
    /// Whether the result is an error.
    #[serde(default)]
    pub is_error: bool,
}

/// JSON-RPC request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcRequest {
    /// JSON-RPC version (always "2.0").
    pub jsonrpc: String,
    /// Request ID.
    pub id: u64,
    /// Method name.
    pub method: String,
    /// Request parameters.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

impl JsonRpcRequest {
    /// Create a new JSON-RPC request.
    pub fn new(id: u64, method: impl Into<String>, params: Option<serde_json::Value>) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            method: method.into(),
            params,
        }
    }
}

/// JSON-RPC response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcResponse {
    /// JSON-RPC version (always "2.0").
    pub jsonrpc: String,
    /// Request ID.
    pub id: Option<u64>,
    /// Result (if successful).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    /// Error (if failed).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

/// JSON-RPC error.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcError {
    /// Error code.
    pub code: i32,
    /// Error message.
    pub message: String,
    /// Additional error data.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

/// JSON-RPC notification (no response expected).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcNotification {
    /// JSON-RPC version (always "2.0").
    pub jsonrpc: String,
    /// Method name.
    pub method: String,
    /// Notification parameters.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

impl JsonRpcNotification {
    /// Create a new JSON-RPC notification.
    pub fn new(method: impl Into<String>, params: Option<serde_json::Value>) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            method: method.into(),
            params,
        }
    }
}
