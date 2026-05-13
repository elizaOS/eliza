// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

//! `storage:scoped` handler.
//!
//! Read / write / list / delete files within the app's own
//! `<APPS_ROOT>/<slug>/data/` directory only. The bubblewrap sandbox
//! already restricts the app's filesystem view to its data dir; this
//! handler is the second line of defense — it rejects keys with `..`,
//! `/`, or NUL, and prefixes the requested key with the configured
//! `data_dir` so an app can never escape its scope through the cap-bus
//! even if the sandbox were misconfigured.
//!
//! Requests are tagged-union JSON:
//!
//! ```json
//! { "op": "read",   "key": "today.txt" }
//! { "op": "write",  "key": "today.txt", "value": "..." }
//! { "op": "list" }
//! { "op": "delete", "key": "today.txt" }
//! ```
//!
//! Successful results echo the value (`read`), the new key list
//! (`list`), or `{ "ok": true }` (`write`, `delete`).

use std::path::Path;

use serde::Deserialize;

use crate::{Response, error_code};

use super::{rpc_error, rpc_ok};

/// Tagged enum for the four `storage:scoped` operations.
#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
enum Op {
    Read { key: String },
    Write { key: String, value: String },
    List,
    Delete { key: String },
}

/// Reject keys that would escape the data dir or contain forbidden bytes.
///
/// Pulled out as a free function so the test module can hit it
/// directly. Returns `Some(reason)` when the key is invalid, `None`
/// when it's safe to join onto `data_dir`.
#[must_use]
pub fn validate_key(key: &str) -> Option<&'static str> {
    if key.is_empty() {
        return Some("key must not be empty");
    }
    if key.contains("..") || key.contains('/') || key.contains('\0') {
        return Some("key must not contain `..`, `/`, or NUL");
    }
    if key.starts_with('.') {
        return Some("key must not start with `.`");
    }
    if Path::new(key).is_absolute() {
        return Some("key must not be an absolute path");
    }
    None
}

/// Handle the `storage:scoped` method. `data_dir` is the app's scoped
/// directory; the handler creates it on first write.
#[must_use]
pub fn handle(
    data_dir: &Path,
    id: serde_json::Value,
    params: Option<serde_json::Value>,
) -> Response {
    let Some(params) = params else {
        return rpc_error(id, error_code::INVALID_PARAMS, "missing params");
    };
    let op: Op = match serde_json::from_value(params) {
        Ok(o) => o,
        Err(e) => return rpc_error(id, error_code::INVALID_PARAMS, &format!("bad params: {e}")),
    };

    match op {
        Op::Read { key } => read(data_dir, id, &key),
        Op::Write { key, value } => write(data_dir, id, &key, &value),
        Op::List => list(data_dir, id),
        Op::Delete { key } => delete(data_dir, id, &key),
    }
}

fn read(data_dir: &Path, id: serde_json::Value, key: &str) -> Response {
    if let Some(reason) = validate_key(key) {
        return rpc_error(id, error_code::INVALID_PARAMS, reason);
    }
    let path = data_dir.join(key);
    match std::fs::read_to_string(&path) {
        Ok(value) => rpc_ok(id, serde_json::json!({ "value": value })),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            rpc_ok(id, serde_json::json!({ "value": null }))
        }
        Err(e) => rpc_error(id, error_code::INTERNAL_ERROR, &format!("read failed: {e}")),
    }
}

fn write(data_dir: &Path, id: serde_json::Value, key: &str, value: &str) -> Response {
    if let Some(reason) = validate_key(key) {
        return rpc_error(id, error_code::INVALID_PARAMS, reason);
    }
    if let Err(e) = std::fs::create_dir_all(data_dir) {
        return rpc_error(id, error_code::INTERNAL_ERROR, &format!("mkdir data: {e}"));
    }
    let path = data_dir.join(key);
    match std::fs::write(&path, value) {
        Ok(()) => rpc_ok(id, serde_json::json!({ "ok": true })),
        Err(e) => rpc_error(
            id,
            error_code::INTERNAL_ERROR,
            &format!("write failed: {e}"),
        ),
    }
}

fn list(data_dir: &Path, id: serde_json::Value) -> Response {
    match std::fs::read_dir(data_dir) {
        Ok(entries) => {
            let mut keys: Vec<String> = entries
                .filter_map(std::result::Result::ok)
                .filter_map(|e| e.file_name().to_str().map(str::to_owned))
                .filter(|n| !n.starts_with('.'))
                .collect();
            keys.sort();
            rpc_ok(id, serde_json::json!({ "keys": keys }))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            rpc_ok(id, serde_json::json!({ "keys": [] }))
        }
        Err(e) => rpc_error(id, error_code::INTERNAL_ERROR, &format!("list failed: {e}")),
    }
}

fn delete(data_dir: &Path, id: serde_json::Value, key: &str) -> Response {
    if let Some(reason) = validate_key(key) {
        return rpc_error(id, error_code::INVALID_PARAMS, reason);
    }
    let path = data_dir.join(key);
    match std::fs::remove_file(&path) {
        Ok(()) => rpc_ok(id, serde_json::json!({ "ok": true })),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            rpc_ok(id, serde_json::json!({ "ok": true, "absent": true }))
        }
        Err(e) => rpc_error(
            id,
            error_code::INTERNAL_ERROR,
            &format!("delete failed: {e}"),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    fn temp_dir(label: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_or(0, |d| d.subsec_nanos());
        let dir = std::env::temp_dir().join(format!(
            "capbus-storage-{label}-{}-{nanos:x}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn validate_key_rejects_traversal_and_absolute() {
        assert!(validate_key("").is_some());
        assert!(validate_key("..").is_some());
        assert!(validate_key("a/b").is_some());
        assert!(validate_key("/etc/passwd").is_some());
        assert!(validate_key(".hidden").is_some());
        assert!(validate_key("a\0b").is_some());
        // Normal keys pass:
        assert!(validate_key("today.txt").is_none());
        assert!(validate_key("note-2026.md").is_none());
    }

    #[test]
    fn write_then_read_round_trip() {
        let dir = temp_dir("rw");
        let resp = handle(
            &dir,
            serde_json::json!(1),
            Some(serde_json::json!({
                "op": "write", "key": "x.txt", "value": "hello"
            })),
        );
        assert!(resp.error.is_none(), "write error: {:?}", resp.error);

        let read = handle(
            &dir,
            serde_json::json!(2),
            Some(serde_json::json!({ "op": "read", "key": "x.txt" })),
        );
        assert_eq!(read.result.unwrap()["value"].as_str(), Some("hello"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn read_missing_key_returns_null_value_not_error() {
        let dir = temp_dir("missing");
        let resp = handle(
            &dir,
            serde_json::json!(1),
            Some(serde_json::json!({ "op": "read", "key": "ghost.txt" })),
        );
        assert!(resp.error.is_none());
        assert!(resp.result.unwrap()["value"].is_null());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn list_returns_sorted_keys_minus_dotfiles() {
        let dir = temp_dir("list");
        std::fs::write(dir.join("b.txt"), "").unwrap();
        std::fs::write(dir.join("a.txt"), "").unwrap();
        std::fs::write(dir.join(".secret"), "").unwrap();
        let resp = handle(&dir, serde_json::json!(1), Some(serde_json::json!({ "op": "list" })));
        let keys = resp.result.unwrap()["keys"].clone();
        assert_eq!(keys, serde_json::json!(["a.txt", "b.txt"]));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn list_on_missing_dir_returns_empty_not_error() {
        let dir = temp_dir("missingdir").join("nope");
        let resp = handle(&dir, serde_json::json!(1), Some(serde_json::json!({ "op": "list" })));
        assert!(resp.error.is_none());
        assert_eq!(resp.result.unwrap()["keys"], serde_json::json!([]));
    }

    #[test]
    fn delete_then_delete_again_is_idempotent() {
        let dir = temp_dir("del");
        std::fs::write(dir.join("x.txt"), "data").unwrap();
        let first = handle(
            &dir,
            serde_json::json!(1),
            Some(serde_json::json!({ "op": "delete", "key": "x.txt" })),
        );
        assert!(first.error.is_none());
        let second = handle(
            &dir,
            serde_json::json!(2),
            Some(serde_json::json!({ "op": "delete", "key": "x.txt" })),
        );
        assert!(second.error.is_none());
        assert_eq!(second.result.unwrap()["absent"], serde_json::json!(true));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn traversal_attempts_are_rejected() {
        let dir = temp_dir("trav");
        for bad in ["../etc/passwd", "/etc/passwd", "a/b", ".."] {
            let resp = handle(
                &dir,
                serde_json::json!(1),
                Some(serde_json::json!({ "op": "read", "key": bad })),
            );
            assert_eq!(
                resp.error.expect("expected error").code,
                error_code::INVALID_PARAMS,
                "key {bad:?}",
            );
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn missing_params_returns_invalid_params() {
        let dir = temp_dir("noparams");
        let resp = handle(&dir, serde_json::json!(1), None);
        assert_eq!(
            resp.error.expect("error").code,
            error_code::INVALID_PARAMS,
        );
    }
}
