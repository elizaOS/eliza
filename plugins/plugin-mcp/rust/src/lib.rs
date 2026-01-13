#![allow(missing_docs)]

pub mod actions;
pub mod client;
pub mod error;
pub mod providers;
pub mod service;
pub mod transport;
pub mod transports;
pub mod types;

pub use actions::{ActionContext, ActionResult, CallToolAction, McpAction, ReadResourceAction};
pub use client::McpClient;
pub use error::{McpError, McpResult};
pub use providers::{McpProvider, McpProviderTrait, ProviderContext, ProviderResult};
pub use service::McpService;
pub use transport::{StdioTransport, Transport};
pub use transports::HttpTransport;
pub use types::{
    ConnectionStatus, HttpServerConfig, McpResource, McpResourceContent, McpResourceTemplate,
    McpServerConfig, McpTool, McpToolInputSchema, McpToolResult, StdioServerConfig, TextContent,
};
