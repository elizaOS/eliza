// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

//! Per-capability handler modules.
//!
//! Each handler is a free function that takes the request id, the
//! per-server config it might need (for `data_dir`, `granted`, the notify
//! URL fallback, etc.), and the request params. Handlers return a
//! [`Response`] — never panic, never return `Result` — so the broker can
//! stay a simple `match method { ... }` dispatch.
//!
//! Layout by capability:
//!
//! | module          | JSON-RPC method(s)                                |
//! |-----------------|---------------------------------------------------|
//! | [`time`]        | `time:read`                                       |
//! | [`storage`]     | `storage:scoped` (read / write / list / delete)   |
//! | [`notifications`] | `notifications:write`                           |
//! | [`clipboard`]   | `clipboard:read`, `clipboard:write`               |
//! | [`network`]     | `network:fetch`                                   |
//!
//! The broker dispatches by method name; capability gating happens BEFORE
//! a handler runs (see `server::process_request`). Each handler can
//! therefore assume the capability is declared. It must still validate
//! per-call invariants (`storage` rejects path traversal, `network`
//! rejects hosts not in the allowlist, `notifications` truncates very
//! long bodies).

pub mod clipboard;
pub mod network;
pub mod notifications;
pub mod storage;
pub mod time;

use crate::{Response, RpcError};

/// Build an error response for the given request id with the given code.
///
/// Pulled up to module scope so every handler emits identically-shaped
/// errors without copying the `Response { jsonrpc: "2.0".into(), .. }`
/// builder around.
#[must_use]
pub(crate) fn rpc_error(id: serde_json::Value, code: i32, message: &str) -> Response {
    Response {
        jsonrpc: "2.0".into(),
        id,
        result: None,
        error: Some(RpcError {
            code,
            message: message.to_owned(),
            data: None,
        }),
    }
}

/// Build a success response for the given request id with a JSON result.
#[must_use]
pub(crate) fn rpc_ok(id: serde_json::Value, result: serde_json::Value) -> Response {
    Response {
        jsonrpc: "2.0".into(),
        id,
        result: Some(result),
        error: None,
    }
}
