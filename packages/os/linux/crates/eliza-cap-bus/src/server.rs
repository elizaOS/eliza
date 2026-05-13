// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

//! Per-app cap-bus server.
//!
//! [`spawn`] listens on the given Unix socket and dispatches JSON-RPC
//! requests to capability handlers in [`crate::handlers`]. Each
//! capability is a method name from `eliza_types::Capability`. The
//! broker rejects calls outside the manifest's `granted` set with
//! [`error_code::CAPABILITY_NOT_GRANTED`] before any handler runs.
//!
//! Capability matrix (locked decision #14, v1 capability set):
//!
//! | method                 | handler                              |
//! |------------------------|--------------------------------------|
//! | `time:read`            | [`crate::handlers::time::read`]      |
//! | `storage:scoped`       | [`crate::handlers::storage::handle`] |
//! | `notifications:write`  | [`crate::handlers::notifications::write`] |
//! | `clipboard:read`       | [`crate::handlers::clipboard::read`] |
//! | `clipboard:write`      | [`crate::handlers::clipboard::write`] |
//! | `network:fetch`        | [`crate::handlers::network::fetch`]  |
//!
//! Methods not in this table return
//! [`error_code::CAPABILITY_NOT_IMPLEMENTED`].
//!
//! The socket file is `chmod 0660`, owned by the user/group that runs
//! `elizad` (typically `eliza:eliza`). Cleanup on shutdown removes the
//! file. **No app-on-app impersonation is possible** because each socket
//! is bind-mounted into one and only one bubblewrap (locked decision
//! #14).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use eliza_types::Capability;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Notify;
use tracing::{debug, error, info, warn};

use crate::handlers::clipboard::ClipboardConfig;
use crate::handlers::network::NetworkConfig;
use crate::handlers::notifications::NotifyConfig;
use crate::{Request, Response, RpcError, error_code};

/// Configuration for a per-app cap-bus server.
#[derive(Debug, Clone)]
pub struct ServerConfig {
    /// App slug — used in logs, the chat-fallback notification line, and
    /// to derive the data dir if `data_dir` is unset.
    pub slug: String,
    /// The capability set this app declared in its manifest. Calls
    /// outside this set return `CAPABILITY_NOT_GRANTED` (-32000).
    pub granted: Vec<Capability>,
    /// Per-app `data/` directory; the only filesystem area
    /// `storage:scoped` is allowed to read or write.
    pub data_dir: PathBuf,
    /// Where to bind the listener. Production:
    /// `/run/eliza/cap-<slug>.sock`. Tests: a temp path.
    pub socket_path: PathBuf,
    /// Optional file mode for the bound socket. Defaults to `0o660`.
    pub socket_mode: Option<u32>,
    /// Optional override for the notifications handler (notify-send
    /// path, elizad URL). Production leaves this `None`; tests inject.
    pub notify: Option<NotifyConfig>,
    /// Optional override for the clipboard handlers (wl-copy / wl-paste
    /// paths). Production leaves this `None`; tests inject.
    pub clipboard: Option<ClipboardConfig>,
    /// Optional request timeout / body-size cap for `network:fetch`.
    /// Production leaves this `None` and the handler picks defaults;
    /// tests inject smaller values.
    pub network: Option<NetworkConfig>,
}

/// A running cap-bus server. Created by [`spawn`]; drop the handle to
/// stop.
#[derive(Debug)]
pub struct ServerHandle {
    /// Path the server is bound to. Cleanup happens on `Drop`.
    pub socket_path: PathBuf,
    shutdown: Arc<Notify>,
    /// `Option` so `join()` can take ownership of the task while `Drop`
    /// remains valid.
    join: Option<tokio::task::JoinHandle<()>>,
}

impl ServerHandle {
    /// Signal the server to stop accepting new connections; the join is
    /// awaited by the caller separately if they want to block on
    /// shutdown.
    pub fn shutdown(&self) {
        self.shutdown.notify_one();
    }

    /// Await the server task's exit. Consumes the handle.
    pub async fn join(mut self) -> Result<()> {
        self.shutdown.notify_one();
        if let Some(task) = self.join.take() {
            task.await
                .map_err(|e| anyhow!("cap-bus server task panicked: {e}"))?;
        }
        Ok(())
    }
}

impl Drop for ServerHandle {
    fn drop(&mut self) {
        // Best-effort cleanup. Caller can `await handle.join()` for a
        // graceful shutdown; otherwise the task is cancelled when the
        // runtime drops.
        self.shutdown.notify_one();
        let _ = std::fs::remove_file(&self.socket_path);
    }
}

/// Spawn a cap-bus server for one app. Returns a handle that, when
/// dropped, signals shutdown and unlinks the socket file.
pub async fn spawn(config: ServerConfig) -> Result<ServerHandle> {
    if let Some(parent) = config.socket_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("create dir {}", parent.display()))?;
    }
    // Remove any stale socket file from a previous run.
    let _ = tokio::fs::remove_file(&config.socket_path).await;

    let listener = UnixListener::bind(&config.socket_path)
        .with_context(|| format!("bind UnixListener at {}", config.socket_path.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = config.socket_mode.unwrap_or(0o660);
        let perms = std::fs::Permissions::from_mode(mode);
        std::fs::set_permissions(&config.socket_path, perms)
            .with_context(|| format!("chmod {} on {}", mode, config.socket_path.display()))?;
    }

    let shutdown = Arc::new(Notify::new());
    let shutdown_for_task = Arc::clone(&shutdown);
    let socket_path_for_handle = config.socket_path.clone();
    let cfg = Arc::new(config);

    let join = tokio::spawn(async move {
        info!(slug = %cfg.slug, path = %cfg.socket_path.display(), "cap-bus serving");
        loop {
            tokio::select! {
                () = shutdown_for_task.notified() => {
                    debug!(slug = %cfg.slug, "cap-bus shutdown");
                    break;
                }
                accept = listener.accept() => {
                    match accept {
                        Ok((stream, _addr)) => {
                            let cfg = Arc::clone(&cfg);
                            tokio::spawn(async move {
                                if let Err(e) = handle_connection(stream, cfg).await {
                                    warn!("cap-bus conn error: {e:#}");
                                }
                            });
                        }
                        Err(e) => {
                            error!("cap-bus accept failed: {e:#}");
                            break;
                        }
                    }
                }
            }
        }
    });

    Ok(ServerHandle {
        socket_path: socket_path_for_handle,
        shutdown,
        join: Some(join),
    })
}

async fn handle_connection(stream: UnixStream, cfg: Arc<ServerConfig>) -> Result<()> {
    let (read_half, mut write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half).lines();
    while let Some(line) = reader
        .next_line()
        .await
        .context("read cap-bus request line")?
    {
        let response = match serde_json::from_str::<Request>(&line) {
            Ok(req) => process_request(&cfg, req).await,
            Err(e) => Response {
                jsonrpc: "2.0".into(),
                id: serde_json::Value::Null,
                result: None,
                error: Some(RpcError {
                    code: error_code::PARSE_ERROR,
                    message: format!("invalid JSON-RPC request: {e}"),
                    data: None,
                }),
            },
        };
        let mut payload = serde_json::to_vec(&response).context("serialize cap-bus response")?;
        payload.push(b'\n');
        write_half
            .write_all(&payload)
            .await
            .context("write cap-bus response")?;
    }
    Ok(())
}

async fn process_request(cfg: &ServerConfig, req: Request) -> Response {
    let id = req.id.clone().unwrap_or(serde_json::Value::Null);
    if req.jsonrpc != "2.0" {
        return rpc_error(
            id,
            error_code::INVALID_REQUEST,
            "jsonrpc version must be \"2.0\"",
        );
    }
    let method = &req.method;
    let granted = cfg.granted.iter().find(|c| c.rpc_method() == method);
    let Some(granted_cap) = granted else {
        return rpc_error(
            id,
            error_code::CAPABILITY_NOT_GRANTED,
            &format!("`{method}` was not declared in the app's manifest"),
        );
    };

    match method.as_str() {
        "time:read" => crate::handlers::time::read(id),
        "storage:scoped" => crate::handlers::storage::handle(&cfg.data_dir, id, req.params),
        "notifications:write" => {
            let notify_cfg = cfg.notify.clone().unwrap_or_default();
            crate::handlers::notifications::write(&notify_cfg, &cfg.slug, id, req.params).await
        }
        "clipboard:read" => {
            let clip_cfg = cfg.clipboard.clone().unwrap_or_default();
            crate::handlers::clipboard::read(&clip_cfg, id).await
        }
        "clipboard:write" => {
            let clip_cfg = cfg.clipboard.clone().unwrap_or_default();
            crate::handlers::clipboard::write(&clip_cfg, id, req.params).await
        }
        "network:fetch" => {
            // Pull the allowlist out of the matching capability variant.
            let allowlist = match granted_cap {
                Capability::NetworkFetch { allowlist } => allowlist.clone(),
                _ => Vec::new(),
            };
            let base = cfg.network.clone().unwrap_or_default();
            let net_cfg = NetworkConfig {
                allowlist,
                max_body_bytes: base.max_body_bytes,
                timeout: base.timeout.or(Some(Duration::from_secs(10))),
            };
            crate::handlers::network::fetch(&net_cfg, id, req.params).await
        }
        _ => rpc_error(
            id,
            error_code::CAPABILITY_NOT_IMPLEMENTED,
            &format!("`{method}` is parsed but not implemented in this build"),
        ),
    }
}

fn rpc_error(id: serde_json::Value, code: i32, message: &str) -> Response {
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

/// Connect to a server, send one request, await one response. Used by
/// tests and (eventually) by simple host tools that don't need
/// streaming.
pub async fn one_shot_request(socket: &Path, request: &Request) -> Result<Response> {
    let stream = UnixStream::connect(socket)
        .await
        .with_context(|| format!("connect {}", socket.display()))?;
    let (read_half, mut write_half) = stream.into_split();
    let mut payload = serde_json::to_vec(request).context("serialize request")?;
    payload.push(b'\n');
    write_half
        .write_all(&payload)
        .await
        .context("write request")?;
    write_half.shutdown().await.ok();
    let mut reader = BufReader::new(read_half).lines();
    let line = reader
        .next_line()
        .await
        .context("read response line")?
        .ok_or_else(|| anyhow!("server closed without response"))?;
    let response: Response = serde_json::from_str(&line).context("parse response")?;
    Ok(response)
}
