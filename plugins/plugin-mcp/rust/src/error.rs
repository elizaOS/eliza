//! Error types for the MCP plugin.

use thiserror::Error;

/// Result type for MCP operations.
pub type McpResult<T> = Result<T, McpError>;

/// Errors that can occur when using the MCP client.
#[derive(Error, Debug)]
pub enum McpError {
    /// Connection to the server failed.
    #[error("Connection error: {message}")]
    Connection { message: String },

    /// The transport is not connected.
    #[error("Transport not connected")]
    NotConnected,

    /// The transport is already connected.
    #[error("Transport already connected")]
    AlreadyConnected,

    /// A tool was not found on the server.
    #[error("Tool '{tool_name}' not found on server '{server_name}'")]
    ToolNotFound {
        tool_name: String,
        server_name: String,
    },

    /// A resource was not found on the server.
    #[error("Resource '{uri}' not found on server '{server_name}'")]
    ResourceNotFound { uri: String, server_name: String },

    /// Validation of input data failed.
    #[error("Validation error: {details}")]
    Validation { details: String },

    /// An operation timed out.
    #[error("Operation timed out: {operation}")]
    Timeout { operation: String },

    /// Protocol error in JSON-RPC communication.
    #[error("Protocol error: {message}")]
    Protocol { message: String },

    /// JSON serialization/deserialization error.
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    /// IO error.
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    /// Server returned an error.
    #[error("Server error ({code}): {message}")]
    Server { code: i32, message: String },

    /// Invalid argument provided.
    #[error("Invalid argument: {details}")]
    InvalidArgument { details: String },
}

impl McpError {
    /// Create a connection error.
    pub fn connection(message: impl Into<String>) -> Self {
        Self::Connection {
            message: message.into(),
        }
    }

    /// Create a tool not found error.
    pub fn tool_not_found(tool_name: impl Into<String>, server_name: impl Into<String>) -> Self {
        Self::ToolNotFound {
            tool_name: tool_name.into(),
            server_name: server_name.into(),
        }
    }

    /// Create a resource not found error.
    pub fn resource_not_found(uri: impl Into<String>, server_name: impl Into<String>) -> Self {
        Self::ResourceNotFound {
            uri: uri.into(),
            server_name: server_name.into(),
        }
    }

    /// Create a validation error.
    pub fn validation(details: impl Into<String>) -> Self {
        Self::Validation {
            details: details.into(),
        }
    }

    /// Create a timeout error.
    pub fn timeout(operation: impl Into<String>) -> Self {
        Self::Timeout {
            operation: operation.into(),
        }
    }

    /// Create a protocol error.
    pub fn protocol(message: impl Into<String>) -> Self {
        Self::Protocol {
            message: message.into(),
        }
    }

    /// Create a server error.
    pub fn server(code: i32, message: impl Into<String>) -> Self {
        Self::Server {
            code,
            message: message.into(),
        }
    }

    /// Create an invalid argument error.
    pub fn invalid_argument(details: impl Into<String>) -> Self {
        Self::InvalidArgument {
            details: details.into(),
        }
    }
}


