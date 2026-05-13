// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

//! `clipboard:read` + `clipboard:write` handlers.
//!
//! The live ISO ships sway + wlroots and the `wl-clipboard` Debian
//! package (which provides `wl-copy` and `wl-paste`). The handlers shell
//! out to those binaries because Wayland clipboards have no
//! cross-process API and re-implementing the protocol in-process would
//! be 500+ lines of boilerplate.
//!
//! Request shapes:
//!
//! ```json
//! { }                                  // read — no params
//! { "value": "text to copy" }          // write
//! ```
//!
//! Success responses:
//!
//! ```json
//! { "value": "text from clipboard" }   // read
//! { "ok": true }                       // write
//! ```
//!
//! If the binary is missing, the handler returns INTERNAL_ERROR with a
//! human-readable message — generated apps surface that to the user
//! via Eliza, who can suggest installing the package.

use serde::Deserialize;
use tokio::io::AsyncWriteExt;

use crate::{Response, error_code};

use super::{rpc_error, rpc_ok};

/// Configuration the broker hands to the clipboard handlers.
///
/// Env-var fallbacks (`USBELIZA_WL_COPY`, `USBELIZA_WL_PASTE`) let the
/// unit tests substitute fake binaries; production leaves these `None`
/// so PATH lookup finds the real wl-clipboard binaries.
#[derive(Debug, Clone, Default)]
pub struct ClipboardConfig {
    /// Absolute path to a `wl-copy`-shaped binary.
    pub wl_copy: Option<String>,
    /// Absolute path to a `wl-paste`-shaped binary.
    pub wl_paste: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WriteParams {
    value: String,
}

/// Handle `clipboard:read`. Spawns `wl-paste` and returns its stdout
/// (trimmed of the trailing newline wl-paste appends — generated apps
/// generally want the raw value).
pub async fn read(cfg: &ClipboardConfig, id: serde_json::Value) -> Response {
    let bin = match resolve(cfg.wl_paste.as_ref(), "USBELIZA_WL_PASTE", "wl-paste") {
        Some(b) => b,
        None => {
            return rpc_error(
                id,
                error_code::INTERNAL_ERROR,
                "wl-paste not found on PATH — install wl-clipboard",
            );
        }
    };
    let output = tokio::process::Command::new(&bin)
        .arg("--no-newline")
        .output()
        .await;
    match output {
        Ok(o) if o.status.success() => {
            let value = String::from_utf8_lossy(&o.stdout).into_owned();
            rpc_ok(id, serde_json::json!({ "value": value }))
        }
        Ok(o) => rpc_error(
            id,
            error_code::INTERNAL_ERROR,
            &format!(
                "wl-paste exited {}: {}",
                o.status,
                String::from_utf8_lossy(&o.stderr).trim()
            ),
        ),
        Err(e) => rpc_error(
            id,
            error_code::INTERNAL_ERROR,
            &format!("wl-paste failed: {e}"),
        ),
    }
}

/// Handle `clipboard:write`. Spawns `wl-copy` and pipes the requested
/// value into it via stdin.
pub async fn write(
    cfg: &ClipboardConfig,
    id: serde_json::Value,
    params: Option<serde_json::Value>,
) -> Response {
    let Some(params) = params else {
        return rpc_error(id, error_code::INVALID_PARAMS, "missing params");
    };
    let parsed: WriteParams = match serde_json::from_value(params) {
        Ok(p) => p,
        Err(e) => return rpc_error(id, error_code::INVALID_PARAMS, &format!("bad params: {e}")),
    };
    let bin = match resolve(cfg.wl_copy.as_ref(), "USBELIZA_WL_COPY", "wl-copy") {
        Some(b) => b,
        None => {
            return rpc_error(
                id,
                error_code::INTERNAL_ERROR,
                "wl-copy not found on PATH — install wl-clipboard",
            );
        }
    };
    let mut child = match tokio::process::Command::new(&bin)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            return rpc_error(
                id,
                error_code::INTERNAL_ERROR,
                &format!("wl-copy spawn failed: {e}"),
            );
        }
    };
    if let Some(mut stdin) = child.stdin.take() {
        if let Err(e) = stdin.write_all(parsed.value.as_bytes()).await {
            return rpc_error(
                id,
                error_code::INTERNAL_ERROR,
                &format!("wl-copy stdin write failed: {e}"),
            );
        }
        drop(stdin);
    }
    match child.wait_with_output().await {
        Ok(o) if o.status.success() => rpc_ok(id, serde_json::json!({ "ok": true })),
        Ok(o) => rpc_error(
            id,
            error_code::INTERNAL_ERROR,
            &format!(
                "wl-copy exited {}: {}",
                o.status,
                String::from_utf8_lossy(&o.stderr).trim()
            ),
        ),
        Err(e) => rpc_error(
            id,
            error_code::INTERNAL_ERROR,
            &format!("wl-copy wait failed: {e}"),
        ),
    }
}

/// Resolve a binary path: explicit cfg → env var → PATH lookup → None.
fn resolve(explicit: Option<&String>, env_key: &str, basename: &str) -> Option<String> {
    if let Some(p) = explicit
        && !p.is_empty()
    {
        return Some(p.clone());
    }
    if let Ok(v) = std::env::var(env_key)
        && !v.is_empty()
    {
        return Some(v);
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(':') {
            if dir.is_empty() {
                continue;
            }
            let candidate = std::path::Path::new(dir).join(basename);
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokio_test_block<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(f)
    }

    fn mktemp(label: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::SystemTime::UNIX_EPOCH)
            .map_or(0, |d| d.subsec_nanos());
        let dir = std::env::temp_dir().join(format!(
            "capbus-clipboard-{label}-{}-{nanos:x}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn chmod_exec(path: &std::path::Path) {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(path, perms).unwrap();
    }

    fn write_stub(dir: &std::path::Path, name: &str, body: &str) -> std::path::PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        chmod_exec(&path);
        path
    }

    #[test]
    fn read_returns_stdout_of_wl_paste_stub() {
        let dir = mktemp("read");
        // wl-paste --no-newline → echo without trailing newline.
        let stub = write_stub(&dir, "wl-paste", "#!/bin/sh\nprintf '%s' 'hello clip'\nexit 0\n");
        let cfg = ClipboardConfig {
            wl_copy: None,
            wl_paste: Some(stub.to_string_lossy().into_owned()),
        };
        let resp = tokio_test_block(read(&cfg, serde_json::json!(1)));
        assert!(resp.error.is_none());
        assert_eq!(resp.result.unwrap()["value"].as_str(), Some("hello clip"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn read_surfaces_internal_error_when_wl_paste_missing() {
        let cfg = ClipboardConfig {
            wl_copy: None,
            wl_paste: Some("/nonexistent/wl-paste-please-fail".into()),
        };
        let resp = tokio_test_block(read(&cfg, serde_json::json!(1)));
        let err = resp.error.expect("error");
        assert_eq!(err.code, error_code::INTERNAL_ERROR);
    }

    #[test]
    fn write_pipes_value_to_wl_copy_stdin() {
        let dir = mktemp("write");
        let log = dir.join("stdin.log");
        let stub = write_stub(
            &dir,
            "wl-copy",
            &format!(
                "#!/bin/sh\n# stub wl-copy: dump stdin to a file we can read\ncat > {log:?}\nexit 0\n",
                log = log
            ),
        );
        let cfg = ClipboardConfig {
            wl_copy: Some(stub.to_string_lossy().into_owned()),
            wl_paste: None,
        };
        let resp = tokio_test_block(write(
            &cfg,
            serde_json::json!(1),
            Some(serde_json::json!({ "value": "remember the milk" })),
        ));
        assert!(resp.error.is_none(), "write error: {:?}", resp.error);
        let captured = std::fs::read_to_string(&log).unwrap();
        assert_eq!(captured, "remember the milk");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn write_rejects_missing_params() {
        let cfg = ClipboardConfig::default();
        let resp = tokio_test_block(write(&cfg, serde_json::json!(1), None));
        assert_eq!(resp.error.unwrap().code, error_code::INVALID_PARAMS);
    }

    #[test]
    fn write_rejects_bad_params() {
        let cfg = ClipboardConfig::default();
        let resp = tokio_test_block(write(
            &cfg,
            serde_json::json!(1),
            Some(serde_json::json!({ "other": 42 })),
        ));
        assert_eq!(resp.error.unwrap().code, error_code::INVALID_PARAMS);
    }
}
