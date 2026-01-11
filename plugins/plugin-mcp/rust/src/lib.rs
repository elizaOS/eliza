#![allow(missing_docs)]
//! elizaOS MCP Plugin - Model Context Protocol client for elizaOS agents.
//!
//! This crate provides a Rust implementation of the MCP client, allowing
//! elizaOS agents to connect to and interact with MCP servers.

pub mod client;
pub mod error;
pub mod transport;
pub mod transports;
pub mod types;

pub use client::McpClient;
pub use error::{McpError, McpResult};
pub use transport::{StdioTransport, Transport};
pub use transports::HttpTransport;
pub use types::{
    ConnectionStatus, HttpServerConfig, McpResource, McpResourceContent, McpResourceTemplate,
    McpServerConfig, McpTool, McpToolInputSchema, McpToolResult, StdioServerConfig, TextContent,
};


