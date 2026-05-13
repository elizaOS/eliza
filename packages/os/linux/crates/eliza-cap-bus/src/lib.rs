// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

//! Per-app capability bus.
//!
//! For every running generated app, `elizad` creates a Unix-domain socket at
//! `/run/eliza/cap-<slug>.sock`, owned `eliza:eliza` mode `0660`, and bind-mounts
//! ONLY that path into the app's bubblewrap. The socket path itself identifies
//! the caller — there is no shared `cap.sock`, and no app-on-app impersonation
//! surface (locked decision #14).
//!
//! The protocol is JSON-RPC 2.0 over newline-delimited frames.

#![deny(missing_docs)]

pub mod handlers;
pub mod server;

pub use server::{ServerConfig, ServerHandle, one_shot_request, spawn};

use std::path::{Path, PathBuf};

use eliza_types::Capability;
use serde::{Deserialize, Serialize};

/// A JSON-RPC 2.0 request frame.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Request {
    /// Always `"2.0"`.
    pub jsonrpc: String,
    /// Either an integer or a string identifier; absent for notifications.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<serde_json::Value>,
    /// Method name. For caps, matches `Capability::rpc_method()`.
    pub method: String,
    /// Method-specific parameters as a JSON object.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

/// A JSON-RPC 2.0 response frame.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Response {
    /// Always `"2.0"`.
    pub jsonrpc: String,
    /// Echoes the request `id`.
    pub id: serde_json::Value,
    /// Result on success.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    /// Error on failure.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

/// A JSON-RPC 2.0 error object.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RpcError {
    /// Numeric error code per JSON-RPC 2.0 spec.
    pub code: i32,
    /// Human-readable short description.
    pub message: String,
    /// Optional structured payload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

/// Standard error codes used by the cap-bus.
#[allow(missing_docs)]
pub mod error_code {
    pub const PARSE_ERROR: i32 = -32700;
    pub const INVALID_REQUEST: i32 = -32600;
    pub const METHOD_NOT_FOUND: i32 = -32601;
    pub const INVALID_PARAMS: i32 = -32602;
    pub const INTERNAL_ERROR: i32 = -32603;
    /// usbeliza extension: the calling app did not declare this capability.
    pub const CAPABILITY_NOT_GRANTED: i32 = -32000;
    /// usbeliza extension: this capability is parsed but not yet implemented.
    pub const CAPABILITY_NOT_IMPLEMENTED: i32 = -32001;
}

/// Compute the cap-bus socket path for a given app slug.
///
/// The directory `/run/eliza` is created and chowned by `elizad` at startup;
/// individual sockets are created on app launch and removed on app exit.
#[must_use]
pub fn socket_path_for(slug: &str) -> PathBuf {
    Path::new("/run/eliza").join(format!("cap-{slug}.sock"))
}

/// Per-app handler context. Carries the slug (which the broker pulled from the
/// socket path) and the declared capability set so a handler can refuse calls
/// outside the manifest's grant.
#[derive(Debug, Clone)]
pub struct HandlerContext {
    /// The app slug, derived from the socket path the connection arrived on.
    pub slug: String,
    /// The capability set this app declared in its manifest. Calls outside
    /// this set return `error_code::CAPABILITY_NOT_GRANTED`.
    pub granted: Vec<Capability>,
}

impl HandlerContext {
    /// Returns true if `method` corresponds to a capability this app declared.
    #[must_use]
    pub fn is_granted(&self, method: &str) -> bool {
        self.granted.iter().any(|cap| cap.rpc_method() == method)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_path_is_deterministic() {
        assert_eq!(
            socket_path_for("calendar"),
            PathBuf::from("/run/eliza/cap-calendar.sock"),
        );
    }

    #[test]
    fn handler_context_grants_only_declared_capabilities() {
        let ctx = HandlerContext {
            slug: "calendar".into(),
            granted: vec![Capability::TimeRead, Capability::StorageScoped],
        };
        assert!(ctx.is_granted("time:read"));
        assert!(ctx.is_granted("storage:scoped"));
        assert!(!ctx.is_granted("network:fetch"));
    }
}
