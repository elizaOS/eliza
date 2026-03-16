#![allow(missing_docs)]

use thiserror::Error;

pub type McpResult<T> = Result<T, McpError>;

#[derive(Error, Debug)]
pub enum McpError {
    #[error("Connection error: {message}")]
    Connection { message: String },

    #[error("Transport not connected")]
    NotConnected,

    #[error("Transport already connected")]
    AlreadyConnected,

    #[error("Tool '{tool_name}' not found on server '{server_name}'")]
    ToolNotFound {
        tool_name: String,
        server_name: String,
    },

    #[error("Resource '{uri}' not found on server '{server_name}'")]
    ResourceNotFound { uri: String, server_name: String },

    #[error("Validation error: {details}")]
    Validation { details: String },

    #[error("Operation timed out: {operation}")]
    Timeout { operation: String },

    #[error("Protocol error: {message}")]
    Protocol { message: String },

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Server error ({code}): {message}")]
    Server { code: i32, message: String },

    #[error("Invalid argument: {details}")]
    InvalidArgument { details: String },
}

impl McpError {
    pub fn connection(message: impl Into<String>) -> Self {
        Self::Connection {
            message: message.into(),
        }
    }

    pub fn tool_not_found(tool_name: impl Into<String>, server_name: impl Into<String>) -> Self {
        Self::ToolNotFound {
            tool_name: tool_name.into(),
            server_name: server_name.into(),
        }
    }

    pub fn resource_not_found(uri: impl Into<String>, server_name: impl Into<String>) -> Self {
        Self::ResourceNotFound {
            uri: uri.into(),
            server_name: server_name.into(),
        }
    }

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

    pub fn protocol(message: impl Into<String>) -> Self {
        Self::Protocol {
            message: message.into(),
        }
    }

    pub fn server(code: i32, message: impl Into<String>) -> Self {
        Self::Server {
            code,
            message: message.into(),
        }
    }

    pub fn invalid_argument(details: impl Into<String>) -> Self {
        Self::InvalidArgument {
            details: details.into(),
        }
    }
}
