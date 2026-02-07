use std::{collections::HashMap, net::SocketAddr, sync::Arc, time::Duration};

use futures_util::{SinkExt, StreamExt};
use once_cell::sync::OnceCell;
use serde::{Deserialize, Serialize};
use tokio::{
    net::TcpListener,
    sync::{mpsc, oneshot, Mutex, RwLock},
    task::JoinHandle,
};
use tokio_tungstenite::{accept_async, connect_async, tungstenite::Message};
use uuid::Uuid;

use crate::AutomationError;

#[derive(Debug, thiserror::Error)]
pub enum ExtensionBridgeError {
    #[error("Failed to bind to port {port}: {source}")]
    PortBindError {
        port: u16,
        #[source]
        source: std::io::Error,
    },
    #[error("Port {port} is in use by another process (PID: {pid})")]
    PortInUse { port: u16, pid: u32 },
    #[error("Failed to kill existing process: {0}")]
    ProcessKillError(String),
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),
}

const DEFAULT_WS_ADDR: &str = "127.0.0.1:17373";

// Reduce type complexity for Clippy
type BridgeResult = Result<serde_json::Value, String>;
type PendingMap = HashMap<String, oneshot::Sender<BridgeResult>>;
type Pending = Arc<Mutex<PendingMap>>;
type Clients = Arc<Mutex<Vec<Client>>>;

#[derive(Debug, Serialize, Deserialize)]
struct EvalRequest {
    id: String,
    action: String,
    code: String,
    #[serde(default)]
    await_promise: bool,
}

#[derive(Debug, Serialize)]
struct ResetRequest {
    action: String,
}

#[derive(Debug, Serialize)]
struct GetHealthRequest {
    action: String,
}

#[derive(Debug, Serialize)]
struct CloseTabRequest {
    id: String,
    action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "tabId")]
    tab_id: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
}

/// Result of closing a browser tab
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloseTabResult {
    pub closed: bool,
    pub tab: ClosedTabInfo,
}

/// Information about a closed tab
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClosedTabInfo {
    pub id: i32,
    pub url: Option<String>,
    pub title: Option<String>,
    #[serde(rename = "windowId")]
    pub window_id: Option<i32>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(untagged)]
enum BridgeIncoming {
    EvalResult {
        id: String,
        ok: bool,
        result: Option<serde_json::Value>,
        error: Option<String>,
    },
    ProxyEval {
        id: String,
        action: String, // "eval" from subprocess
        code: String,
        #[serde(default)]
        await_promise: bool,
    },
    Typed(TypedIncoming),
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
enum TypedIncoming {
    #[serde(rename = "hello")]
    Hello { from: Option<String> },
    #[serde(rename = "pong")]
    Pong,
    #[serde(rename = "console_event")]
    ConsoleEvent {
        id: String,
        level: Option<String>,
        args: Option<serde_json::Value>,
        #[serde(rename = "stackTrace")]
        stack_trace: Option<serde_json::Value>,
        ts: Option<f64>,
    },
    #[serde(rename = "exception_event")]
    ExceptionEvent {
        id: String,
        details: Option<serde_json::Value>,
    },
    #[serde(rename = "log_event")]
    LogEvent {
        id: String,
        entry: Option<serde_json::Value>,
    },
    #[serde(rename = "extension_health")]
    ExtensionHealth {
        extension_id: Option<String>,
        version: Option<String>,
        last_heartbeat: Option<String>,
        recent_logs: Option<Vec<serde_json::Value>>,
        install_reason: Option<String>,
        previous_version: Option<String>,
    },
}

enum ClientType {
    Browser,    // Chrome extension - can execute JavaScript
    Subprocess, // Proxy client from run_command - forwards requests
}

struct Client {
    sender: mpsc::UnboundedSender<Message>,
    connected_at: std::time::Instant,
    client_type: ClientType,
}

pub struct ExtensionBridge {
    _server_task: JoinHandle<()>,
    clients: Clients,
    pending: Pending,
}

// Supervised bridge that can auto-restart if the server task dies
static BRIDGE_SUPERVISOR: OnceCell<Arc<RwLock<Option<Arc<ExtensionBridge>>>>> = OnceCell::new();

impl ExtensionBridge {
    pub async fn global() -> Arc<ExtensionBridge> {
        let supervisor = BRIDGE_SUPERVISOR.get_or_init(|| Arc::new(RwLock::new(None)));

        // Normal server mode (parent process)
        let needs_create = {
            let guard = supervisor.read().await;
            match &*guard {
                None => true,
                Some(bridge) => {
                    // Check if server task is still running
                    bridge._server_task.is_finished()
                }
            }
        };

        if needs_create {
            // Create new bridge
            let mut guard = supervisor.write().await;

            // Double-check after acquiring write lock (another task may have created it)
            let should_create = match &*guard {
                None => true,
                Some(existing) => existing._server_task.is_finished(),
            };

            if should_create {
                if guard.is_some() {
                    tracing::warn!("Extension bridge server task died, recreating...");
                } else {
                    tracing::info!("Creating initial extension bridge...");
                }

                match ExtensionBridge::start(DEFAULT_WS_ADDR).await {
                    Ok(bridge) => {
                        let new_bridge = Arc::new(bridge);
                        *guard = Some(new_bridge.clone());
                        return new_bridge;
                    }
                    Err(ExtensionBridgeError::PortInUse { port, .. }) => {
                        // Port is in use by parent - connect as proxy client instead
                        tracing::info!(
                            "Port {} in use by parent, switching to proxy mode...",
                            port
                        );

                        match ExtensionBridge::start_proxy_client(&port.to_string()).await {
                            Ok(bridge) => {
                                let new_bridge = Arc::new(bridge);
                                *guard = Some(new_bridge.clone());
                                return new_bridge;
                            }
                            Err(e) => {
                                tracing::error!("Failed to connect as proxy client: {}", e);
                                *guard = None;
                                return Arc::new(ExtensionBridge {
                                    _server_task: tokio::spawn(async {}),
                                    clients: Arc::new(Mutex::new(Vec::new())),
                                    pending: Arc::new(Mutex::new(HashMap::new())),
                                });
                            }
                        }
                    }
                    Err(e) => {
                        tracing::error!("Failed to create extension bridge: {}", e);
                        // Don't store anything in the supervisor so we'll retry next time
                        *guard = None;
                        // Create a minimal bridge that will properly report it's not functional
                        // This bridge has no server task and no clients
                        return Arc::new(ExtensionBridge {
                            _server_task: tokio::spawn(async {}), // Immediately finished task
                            clients: Arc::new(Mutex::new(Vec::new())),
                            pending: Arc::new(Mutex::new(HashMap::new())),
                        });
                    }
                }
            }
        }

        // Return existing healthy bridge
        supervisor.read().await.as_ref().unwrap().clone()
    }

    async fn start(addr: &str) -> Result<ExtensionBridge, ExtensionBridgeError> {
        let clients: Clients = Arc::new(Mutex::new(Vec::new()));
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        // Extract port from address string
        let port: u16 = addr
            .split(':')
            .next_back()
            .and_then(|p| p.parse().ok())
            .unwrap_or(17373);

        // Try to bind the websocket listener; handle port conflicts properly
        let listener = match TcpListener::bind(addr).await {
            Ok(l) => l,
            Err(e) => {
                let kind = e.kind();
                if kind == std::io::ErrorKind::AddrInUse {
                    // Port is in use - check if we can connect to it as a proxy client
                    // This automatically enables subprocess mode when parent has the bridge
                    tracing::info!(
                        "Port {} in use, attempting to connect as proxy client...",
                        port
                    );

                    if let Some(ancestor_pid) = Self::find_computeruse_ancestor().await {
                        tracing::info!(
                            "Detected computeruse-mcp-agent ancestor (PID: {}). \
                            Connecting to parent's Extension Bridge...",
                            ancestor_pid
                        );
                        // Return special error to signal proxy mode
                        return Err(ExtensionBridgeError::PortInUse {
                            port,
                            pid: ancestor_pid,
                        });
                    }

                    // Try to find and kill existing process holding the port
                    if let Some((pid, process_name)) = Self::find_process_on_port(port).await {
                        let name_lower = process_name.to_lowercase();
                        let is_safe_to_kill = name_lower.contains("computeruse")
                            || name_lower.contains("mediar")
                            || name_lower.contains("node")
                            || name_lower.contains("bun");

                        if is_safe_to_kill {
                            tracing::info!(
                                "Found '{}' (PID {}) on port {}, attempting to kill...",
                                process_name,
                                pid,
                                port
                            );
                            if let Err(kill_err) = Self::kill_process(pid).await {
                                tracing::warn!("Failed to kill process {}: {}", pid, kill_err);
                            } else {
                                tracing::info!("Successfully killed '{}' (PID {}), waiting for port to be released...", process_name, pid);
                                tokio::time::sleep(Duration::from_secs(1)).await;
                            }
                        } else {
                            tracing::warn!(
                                "Port {} is held by unexpected process '{}' (PID {}). \
                                Not killing automatically. Please close it manually or restart your machine.",
                                port, process_name, pid
                            );
                        }
                    }

                    // Try binding again after cleanup attempt
                    match TcpListener::bind(addr).await {
                        Ok(l) => l,
                        Err(e2) => {
                            tracing::error!(
                                %addr,
                                ?e2,
                                "Failed to bind after cleanup attempt"
                            );
                            return Err(ExtensionBridgeError::PortBindError { port, source: e2 });
                        }
                    }
                } else {
                    return Err(ExtensionBridgeError::IoError(e));
                }
            }
        };
        let clients_clone = clients.clone();
        let pending_clone = pending.clone();
        let addr_parsed: SocketAddr = listener.local_addr().expect("addr");
        tracing::info!("ComputerUse extension bridge listening on {}", addr_parsed);

        let server_task = tokio::spawn(async move {
            loop {
                let (stream, _peer) = match listener.accept().await {
                    Ok(v) => v,
                    Err(e) => {
                        tracing::warn!("ws accept error: {}", e);
                        continue;
                    }
                };
                let ws_clients = clients_clone.clone();
                let ws_pending = pending_clone.clone();
                tokio::spawn(async move {
                    let ws_stream = match accept_async(stream).await {
                        Ok(s) => s,
                        Err(e) => {
                            tracing::warn!("ws handshake error: {}", e);
                            return;
                        }
                    };
                    let (mut sink, mut stream) = ws_stream.split();
                    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

                    // writer task
                    let writer = tokio::spawn(async move {
                        while let Some(msg) = rx.recv().await {
                            if let Err(e) = sink.send(msg).await {
                                tracing::warn!("ws send error: {}", e);
                                break;
                            }
                        }
                    });

                    // register client (default to Browser, will update if we receive ProxyEval)
                    {
                        ws_clients.lock().await.push(Client {
                            sender: tx.clone(),
                            connected_at: std::time::Instant::now(),
                            client_type: ClientType::Browser,
                        });
                    }

                    // reader loop
                    while let Some(Ok(msg)) = stream.next().await {
                        if !msg.is_text() {
                            continue;
                        }
                        let txt = msg.into_text().unwrap_or_default();
                        match serde_json::from_str::<BridgeIncoming>(&txt) {
                            Ok(BridgeIncoming::ProxyEval {
                                id,
                                action,
                                code,
                                await_promise,
                            }) => {
                                // Subprocess client is requesting eval - forward to browser
                                tracing::info!(id = %id, "Received proxy eval request from subprocess");

                                // Create eval request to send to browser
                                let eval_req = EvalRequest {
                                    id: id.clone(),
                                    action,
                                    code,
                                    await_promise,
                                };
                                let payload = match serde_json::to_string(&eval_req) {
                                    Ok(p) => p,
                                    Err(e) => {
                                        tracing::error!("Failed to serialize eval request: {}", e);
                                        continue;
                                    }
                                };

                                // Broadcast to all clients - browser will execute, subprocess will ignore
                                let clients = ws_clients.lock().await;
                                let mut sent_count = 0;
                                for client in clients.iter() {
                                    if client.sender.send(Message::Text(payload.clone())).is_ok() {
                                        sent_count += 1;
                                    }
                                }
                                tracing::debug!("Forwarded proxy eval to {} client(s)", sent_count);
                            }
                            Ok(BridgeIncoming::EvalResult {
                                id,
                                ok,
                                result,
                                error,
                            }) => {
                                if ok {
                                    let size =
                                        result.as_ref().map(|r| r.to_string().len()).unwrap_or(0);
                                    tracing::info!(id = %id, ok = ok, result_size = size, "Bridge received EvalResult");
                                } else {
                                    let err_str =
                                        error.clone().unwrap_or_else(|| "unknown error".into());
                                    // Try direct JSON parse first
                                    if let Ok(val) =
                                        serde_json::from_str::<serde_json::Value>(&err_str)
                                    {
                                        let code =
                                            val.get("code").and_then(|v| v.as_str()).unwrap_or("");
                                        let msg = val
                                            .get("message")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("");
                                        let details = val
                                            .get("details")
                                            .cloned()
                                            .unwrap_or(serde_json::Value::Null);
                                        tracing::error!(id = %id, code = code, message = msg, details = %details, raw = %err_str, "Bridge received EvalResult error (structured)");
                                    } else {
                                        // Not JSON, just log raw (truncate to avoid log spam)
                                        let head: String = err_str.chars().take(400).collect();
                                        tracing::error!(id = %id, error = %head, "Bridge received EvalResult error (raw)");
                                    }
                                }

                                // Send result to pending requests (could be from parent or subprocess)
                                if let Some(tx) = ws_pending.lock().await.remove(&id) {
                                    let _ = tx.send(if ok {
                                        Ok(result.clone().unwrap_or(serde_json::Value::Null))
                                    } else {
                                        Err(error.clone().unwrap_or_else(|| "unknown error".into()))
                                    });
                                }

                                // Also forward result to subprocess clients (they might be waiting for it)
                                let result_msg = serde_json::json!({
                                    "id": id,
                                    "ok": ok,
                                    "result": result,
                                    "error": error,
                                });
                                let result_payload = result_msg.to_string();
                                {
                                    let clients = ws_clients.lock().await;
                                    for client in clients.iter() {
                                        if matches!(client.client_type, ClientType::Subprocess) {
                                            let _ = client
                                                .sender
                                                .send(Message::Text(result_payload.clone()));
                                        }
                                    }
                                }
                            }
                            Ok(BridgeIncoming::Typed(TypedIncoming::ConsoleEvent {
                                id,
                                level,
                                args,
                                stack_trace,
                                ts,
                            })) => {
                                let level_str = level.unwrap_or_else(|| "log".into());
                                let args_str =
                                    args.map(|v| v.to_string()).unwrap_or_else(|| "[]".into());
                                let ts_ms = ts.unwrap_or(0.0);
                                match level_str.as_str() {
                                    "error" => {
                                        tracing::error!(id = %id, ts = ts_ms, args = %args_str, stack = %stack_trace.as_ref().map(|v| v.to_string()).unwrap_or_default(), "Console error event")
                                    }
                                    "warning" | "warn" => {
                                        tracing::warn!(id = %id, ts = ts_ms, args = %args_str, "Console warn event")
                                    }
                                    "debug" => {
                                        tracing::debug!(id = %id, ts = ts_ms, args = %args_str, "Console debug event")
                                    }
                                    "info" => {
                                        tracing::info!(id = %id, ts = ts_ms, args = %args_str, "Console info event")
                                    }
                                    _ => {
                                        tracing::info!(id = %id, ts = ts_ms, args = %args_str, "Console log event");
                                        eprintln!("[CONSOLE LOG] {args_str}");
                                    }
                                }
                            }
                            Ok(BridgeIncoming::Typed(TypedIncoming::ExceptionEvent {
                                id,
                                details,
                            })) => {
                                let details_val = details.unwrap_or(serde_json::Value::Null);
                                tracing::error!(id = %id, details = %details_val, "Runtime exception event");
                            }
                            Ok(BridgeIncoming::Typed(TypedIncoming::LogEvent { id, entry })) => {
                                let entry_val = entry.unwrap_or(serde_json::Value::Null);
                                tracing::info!(id = %id, entry = %entry_val, "Log.entryAdded event");
                            }
                            Ok(BridgeIncoming::Typed(TypedIncoming::Hello { .. })) => {
                                tracing::info!("Extension connected");
                                // Request extension health info for logging
                                let health_req = GetHealthRequest {
                                    action: "get_extension_health".to_string(),
                                };
                                if let Ok(payload) = serde_json::to_string(&health_req) {
                                    if tx.send(Message::Text(payload)).is_err() {
                                        tracing::warn!(
                                            "Failed to send health request to extension"
                                        );
                                    }
                                }
                            }
                            Ok(BridgeIncoming::Typed(TypedIncoming::ExtensionHealth {
                                extension_id,
                                version,
                                last_heartbeat,
                                recent_logs,
                                install_reason,
                                previous_version,
                            })) => {
                                let ext_id = extension_id.unwrap_or_else(|| "unknown".to_string());
                                let ver = version.unwrap_or_else(|| "unknown".to_string());
                                let heartbeat =
                                    last_heartbeat.unwrap_or_else(|| "never".to_string());
                                let reason =
                                    install_reason.unwrap_or_else(|| "unknown".to_string());
                                let prev_ver =
                                    previous_version.unwrap_or_else(|| "none".to_string());
                                let log_count = recent_logs.as_ref().map(|l| l.len()).unwrap_or(0);

                                tracing::info!(
                                    extension_id = %ext_id,
                                    version = %ver,
                                    last_heartbeat = %heartbeat,
                                    install_reason = %reason,
                                    previous_version = %prev_ver,
                                    recent_log_count = log_count,
                                    "Extension health report"
                                );

                                // Log recent lifecycle events if present
                                if let Some(logs) = recent_logs {
                                    for log_entry in logs.iter().take(5) {
                                        tracing::info!(entry = %log_entry, "Extension lifecycle event");
                                    }
                                }
                            }
                            Ok(BridgeIncoming::Typed(TypedIncoming::Pong)) => {}
                            Err(e) => tracing::warn!("Invalid incoming JSON: {}", e),
                        }
                    }

                    // Clean up disconnected client and pending requests
                    {
                        let mut clients = ws_clients.lock().await;
                        clients.retain(|c| !c.sender.is_closed());
                        let remaining = clients.len();

                        // Clear all pending requests when last client disconnects
                        // This prevents memory leaks and ensures clean state for next connection
                        if remaining == 0 {
                            let mut pending = ws_pending.lock().await;
                            let pending_count = pending.len();
                            if pending_count > 0 {
                                tracing::warn!(
                                    "Last client disconnected with {} pending requests - clearing all",
                                    pending_count
                                );
                                pending.clear();
                            } else {
                                tracing::info!("Last client disconnected, extension bridge idle");
                            }
                        } else {
                            tracing::info!(
                                "Client disconnected, {} client(s) remaining",
                                remaining
                            );
                        }
                    }

                    writer.abort();
                });
            }
        });

        Ok(ExtensionBridge {
            _server_task: server_task,
            clients,
            pending,
        })
    }

    /// Start bridge in proxy client mode - connects to parent's WebSocket server
    /// This is used when running from run_command subprocess context
    async fn start_proxy_client(port: &str) -> Result<ExtensionBridge, ExtensionBridgeError> {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let pending_clone = pending.clone();

        let url = format!("ws://127.0.0.1:{port}");
        tracing::info!("Subprocess connecting to parent bridge at {}", url);

        // Connect to parent's WebSocket server
        let (ws_stream, _) = connect_async(&url).await.map_err(|e| {
            ExtensionBridgeError::IoError(std::io::Error::new(
                std::io::ErrorKind::ConnectionRefused,
                format!("Failed to connect to parent bridge: {e}"),
            ))
        })?;

        tracing::info!("Subprocess successfully connected to parent bridge");

        let (mut sink, mut stream) = ws_stream.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

        // Writer task - sends eval requests to parent
        let writer_task = tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if let Err(e) = sink.send(msg).await {
                    tracing::error!("Proxy client send error: {}", e);
                    break;
                }
            }
            tracing::info!("Proxy client writer task ended");
        });

        // Reader task - receives eval results from parent
        let reader_task = tokio::spawn(async move {
            while let Some(Ok(msg)) = stream.next().await {
                if !msg.is_text() {
                    continue;
                }
                let txt = msg.into_text().unwrap_or_default();

                // Parse eval results from parent
                match serde_json::from_str::<BridgeIncoming>(&txt) {
                    Ok(BridgeIncoming::EvalResult {
                        id,
                        ok,
                        result,
                        error,
                    }) => {
                        tracing::debug!("Proxy client received eval result for id: {}", id);
                        if let Some(tx) = pending_clone.lock().await.remove(&id) {
                            let _ = tx.send(if ok {
                                Ok(result.unwrap_or(serde_json::Value::Null))
                            } else {
                                Err(error.unwrap_or_else(|| "unknown error".into()))
                            });
                        }
                    }
                    Ok(_) => {
                        // Ignore other message types (Hello, Pong, etc.)
                    }
                    Err(e) => {
                        tracing::warn!("Proxy client invalid JSON: {}", e);
                    }
                }
            }
            tracing::info!("Proxy client reader task ended - connection closed");
        });

        // Combine both tasks into one
        let combined_task = tokio::spawn(async move {
            tokio::select! {
                _ = writer_task => {
                    tracing::info!("Proxy client writer finished first");
                }
                _ = reader_task => {
                    tracing::info!("Proxy client reader finished first");
                }
            }
        });

        // Create a fake clients list with our sender
        // This allows eval_in_active_tab to work without modification
        let clients: Clients = Arc::new(Mutex::new(vec![Client {
            sender: tx,
            connected_at: std::time::Instant::now(),
            client_type: ClientType::Subprocess,
        }]));

        Ok(ExtensionBridge {
            _server_task: combined_task,
            clients,
            pending,
        })
    }

    /// Find process holding a port and return (PID, process_name)
    async fn find_process_on_port(port: u16) -> Option<(u32, String)> {
        use tokio::process::Command;

        // Use netstat to find the process
        let output = Command::new("cmd")
            .args([
                "/C",
                &format!("netstat -ano | findstr :{port} | findstr LISTENING"),
            ])
            .output()
            .await
            .ok()?;

        let output_str = String::from_utf8_lossy(&output.stdout);
        // Parse output like: "  TCP    127.0.0.1:17373        0.0.0.0:0              LISTENING       6728"
        for line in output_str.lines() {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if let Some(pid_str) = parts.last() {
                if let Ok(pid) = pid_str.parse::<u32>() {
                    // Get process name for this PID
                    let process_name = Self::get_process_name(pid).await.unwrap_or_default();
                    tracing::info!(
                        "Found process on port {}: PID={}, name='{}'",
                        port,
                        pid,
                        process_name
                    );
                    return Some((pid, process_name));
                }
            }
        }
        None
    }

    /// Get process name by PID using sysinfo (replaces deprecated wmic)
    async fn get_process_name(pid: u32) -> Option<String> {
        use sysinfo::{Pid, ProcessesToUpdate, System};

        let mut system = System::new();
        system.refresh_processes(ProcessesToUpdate::All, true);
        system
            .process(Pid::from_u32(pid))
            .map(|p| p.name().to_string_lossy().to_string())
    }

    /// Find any computeruse-mcp-agent or mediar process in our parent chain
    /// Returns the PID if found, None otherwise
    /// Uses sysinfo crate instead of deprecated wmic command
    async fn find_computeruse_ancestor() -> Option<u32> {
        use sysinfo::{Pid, ProcessesToUpdate, System};

        // Get current process ID
        let current_pid = std::process::id();

        // Initialize sysinfo and refresh process list
        let mut system = System::new();
        system.refresh_processes(ProcessesToUpdate::All, true);

        // Traverse the parent chain
        let mut checking_pid = current_pid;
        tracing::info!("[sysinfo] Starting parent chain traversal from PID {current_pid}");

        for iteration in 0..10 {
            tracing::debug!("[sysinfo] Iteration {iteration}: checking PID {checking_pid}");

            // Get process info from sysinfo
            let process = system.process(Pid::from_u32(checking_pid))?;
            let process_name = process.name().to_string_lossy().to_lowercase();

            tracing::debug!("[sysinfo] PID {checking_pid} name: {process_name}");

            // Check if current process is computeruse-mcp-agent or mediar
            // (mediar.exe also hosts the extension bridge)
            if process_name.contains("computeruse-mcp-agent") || process_name.contains("mediar") {
                tracing::info!(
                    "[sysinfo] Found bridge host '{}' at PID {} (current_pid={}, iteration={})",
                    process_name,
                    checking_pid,
                    current_pid,
                    iteration
                );
                return Some(checking_pid);
            }

            // Get parent PID
            let parent_pid = process.parent()?;
            let parent_pid_u32 = parent_pid.as_u32();

            if parent_pid_u32 == 0 || parent_pid_u32 == checking_pid {
                // Reached root or circular reference
                tracing::debug!("[sysinfo] Reached root process, stopping traversal");
                break;
            }

            checking_pid = parent_pid_u32;
        }

        tracing::debug!("[sysinfo] No bridge host found in parent chain");
        None
    }

    /// Check if the given PID is our parent process or an ancestor
    /// Uses sysinfo instead of deprecated wmic command
    #[allow(dead_code)]
    async fn is_parent_or_ancestor_process(target_pid: u32) -> bool {
        use sysinfo::{Pid, ProcessesToUpdate, System};

        // Get current process ID
        let current_pid = std::process::id();

        // Initialize sysinfo and refresh process list
        let mut system = System::new();
        system.refresh_processes(ProcessesToUpdate::All, true);

        // Traverse the parent chain
        let mut checking_pid = current_pid;
        for _ in 0..10 {
            // Get process info from sysinfo
            let Some(process) = system.process(Pid::from_u32(checking_pid)) else {
                break;
            };

            // Get parent PID
            let Some(parent_pid) = process.parent() else {
                break;
            };
            let parent_pid_u32 = parent_pid.as_u32();

            if parent_pid_u32 == target_pid {
                tracing::debug!(
                    "[sysinfo] Found target PID {} in parent chain (current_pid={}, checking_pid={})",
                    target_pid,
                    current_pid,
                    checking_pid
                );
                return true;
            }

            if parent_pid_u32 == 0 || parent_pid_u32 == checking_pid {
                // Reached root or circular reference
                break;
            }

            checking_pid = parent_pid_u32;
        }

        false
    }

    /// Kill a process by PID using taskkill (more reliable than deprecated wmic)
    async fn kill_process(pid: u32) -> Result<(), ExtensionBridgeError> {
        use tokio::process::Command;

        // Use taskkill which is available on all Windows versions
        let output = Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .output()
            .await
            .map_err(|e| ExtensionBridgeError::ProcessKillError(e.to_string()))?;

        if output.status.success() {
            Ok(())
        } else {
            Err(ExtensionBridgeError::ProcessKillError(
                String::from_utf8_lossy(&output.stderr).to_string(),
            ))
        }
    }

    pub async fn is_client_connected(&self) -> bool {
        !self.clients.lock().await.is_empty()
    }

    /// Get health status of the bridge for monitoring
    pub async fn health_status() -> serde_json::Value {
        let supervisor = BRIDGE_SUPERVISOR.get_or_init(|| Arc::new(RwLock::new(None)));

        let guard = supervisor.read().await;
        match &*guard {
            None => serde_json::json!({
                "connected": false,
                "status": "not_initialized",
                "clients": 0
            }),
            Some(bridge) => {
                let is_alive = !bridge._server_task.is_finished();
                let client_count = if is_alive {
                    bridge.clients.lock().await.len()
                } else {
                    0
                };

                serde_json::json!({
                    "connected": is_alive && client_count > 0,
                    "status": if !is_alive { "dead" } else if client_count > 0 { "healthy" } else { "waiting_for_clients" },
                    "clients": client_count,
                    "server_task_alive": is_alive
                })
            }
        }
    }

    pub async fn send_reset_command(&self) -> Result<(), AutomationError> {
        let req = ResetRequest {
            action: "reset".into(),
        };
        let payload = serde_json::to_string(&req)
            .map_err(|e| AutomationError::PlatformError(format!("serialize reset: {e}")))?;

        let mut clients = self.clients.lock().await;
        // Clean up dead clients first
        clients.retain(|c| !c.sender.is_closed());

        // Use the most recent client (last connected)
        if let Some(c) = clients.last() {
            if c.sender.send(Message::Text(payload)).is_ok() {
                tracing::info!("Sent reset command to extension");
                // Give the extension time to reset
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
        Ok(())
    }

    pub async fn eval_in_active_tab(
        &self,
        code: &str,
        timeout: Duration,
    ) -> Result<Option<String>, AutomationError> {
        // Auto-retry logic: retry for up to 10 seconds if no clients connected
        const MAX_RETRY_DURATION: Duration = Duration::from_secs(10);
        const RETRY_INTERVAL: Duration = Duration::from_millis(500);
        let start_time = tokio::time::Instant::now();

        loop {
            let client_count = self.clients.lock().await.len();
            if client_count > 0 {
                // Clients connected, proceed with evaluation
                tracing::debug!("ExtensionBridge: {} client(s) connected", client_count);
                break;
            }

            // No clients connected yet
            if start_time.elapsed() >= MAX_RETRY_DURATION {
                tracing::warn!("ExtensionBridge: no clients connected after {} seconds; extension not available",
                    MAX_RETRY_DURATION.as_secs());
                return Ok(None);
            }

            // Log retry attempt
            tracing::info!(
                "ExtensionBridge: no clients connected, retrying in {}ms... (elapsed: {:.1}s)",
                RETRY_INTERVAL.as_millis(),
                start_time.elapsed().as_secs_f32()
            );

            // Wait before retrying
            tokio::time::sleep(RETRY_INTERVAL).await;
        }

        // Now we have clients, continue with original logic
        tracing::debug!(
            "ExtensionBridge: proceeding with evaluation after {:.1}s",
            start_time.elapsed().as_secs_f32()
        );
        let id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel::<BridgeResult>();
        self.pending.lock().await.insert(id.clone(), tx);
        let req = EvalRequest {
            id: id.clone(),
            action: "eval".into(),
            code: code.to_string(),
            await_promise: true,
        };
        let payload = serde_json::to_string(&req)
            .map_err(|e| AutomationError::PlatformError(format!("bridge serialize: {e}")))?;

        // Clean up dead clients and send to most recent client
        let mut ok = false;
        {
            let mut clients = self.clients.lock().await;
            // Remove dead clients before attempting to send
            clients.retain(|c| !c.sender.is_closed());

            tracing::info!(clients = clients.len(), preview = %payload.chars().take(120).collect::<String>(), "Sending eval to extension");

            // Use the most recent client (last connected) instead of first
            if let Some(c) = clients.last() {
                ok = c.sender.send(Message::Text(payload)).is_ok();
                if ok {
                    tracing::debug!(
                        "Successfully sent eval to most recent client (connected at {:?})",
                        c.connected_at
                    );
                }
            }
        }
        if !ok {
            self.pending.lock().await.remove(&id);
            tracing::warn!("ExtensionBridge: failed to send eval - no active clients available");
            return Ok(None);
        }

        let res = tokio::time::timeout(timeout, rx).await;
        match res {
            Ok(Ok(Ok(val))) => Ok(Some(match val {
                serde_json::Value::String(s) => s,
                other => other.to_string(),
            })),
            Ok(Ok(Err(err))) => Ok(Some(format!("ERROR: {err}"))),
            Ok(Err(_canceled)) => {
                tracing::warn!("ExtensionBridge: oneshot canceled by receiver");
                Ok(None)
            }
            Err(_elapsed) => {
                // timeout
                let _ = self.pending.lock().await.remove(&id);
                tracing::warn!(
                    "ExtensionBridge: timed out waiting for EvalResult (id={})",
                    id
                );
                Ok(None)
            }
        }
    }

    /// Close a browser tab safely
    ///
    /// Identification priority:
    /// 1. tab_id - if provided, close that specific tab
    /// 2. url - find tab by URL match
    /// 3. title - find tab by title match  
    /// 4. active tab - fallback to currently active tab
    ///
    /// Returns info about the closed tab for verification
    pub async fn close_tab(
        &self,
        tab_id: Option<i32>,
        url: Option<&str>,
        title: Option<&str>,
        timeout: Duration,
    ) -> Result<Option<CloseTabResult>, AutomationError> {
        // Check for connected clients
        if !self.is_client_connected().await {
            tracing::warn!("ExtensionBridge: no clients connected for close_tab");
            return Ok(None);
        }

        let id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel::<BridgeResult>();
        self.pending.lock().await.insert(id.clone(), tx);

        let req = CloseTabRequest {
            id: id.clone(),
            action: "close_tab".into(),
            tab_id,
            url: url.map(|s| s.to_string()),
            title: title.map(|s| s.to_string()),
        };
        let payload = serde_json::to_string(&req)
            .map_err(|e| AutomationError::PlatformError(format!("bridge serialize: {e}")))?;

        // Send to most recent client
        let mut ok = false;
        {
            let mut clients = self.clients.lock().await;
            clients.retain(|c| !c.sender.is_closed());

            tracing::info!(clients = clients.len(), "Sending close_tab to extension");

            if let Some(c) = clients.last() {
                ok = c.sender.send(Message::Text(payload)).is_ok();
            }
        }
        if !ok {
            self.pending.lock().await.remove(&id);
            tracing::warn!("ExtensionBridge: failed to send close_tab - no active clients");
            return Ok(None);
        }

        let res = tokio::time::timeout(timeout, rx).await;
        match res {
            Ok(Ok(Ok(val))) => {
                // Parse the result into CloseTabResult
                match serde_json::from_value::<CloseTabResult>(val) {
                    Ok(result) => Ok(Some(result)),
                    Err(e) => {
                        tracing::warn!("Failed to parse close_tab result: {}", e);
                        Ok(None)
                    }
                }
            }
            Ok(Ok(Err(err))) => Err(AutomationError::PlatformError(format!(
                "close_tab error: {err}"
            ))),
            Ok(Err(_canceled)) => {
                tracing::warn!("ExtensionBridge: close_tab oneshot canceled");
                Ok(None)
            }
            Err(_elapsed) => {
                let _ = self.pending.lock().await.remove(&id);
                tracing::warn!("ExtensionBridge: close_tab timed out (id={})", id);
                Ok(None)
            }
        }
    }
}

pub async fn try_eval_via_extension(
    code: &str,
    timeout: Duration,
) -> Result<Option<String>, AutomationError> {
    let bridge = ExtensionBridge::global().await;
    if bridge._server_task.is_finished() {
        tracing::error!(
            "Extension bridge server task is not running - attempting to recreate bridge"
        );

        // Clear the broken bridge from supervisor
        let supervisor = BRIDGE_SUPERVISOR.get_or_init(|| Arc::new(RwLock::new(None)));
        {
            let mut guard = supervisor.write().await;
            *guard = None;
        }

        // Try to create a new bridge
        let new_bridge = ExtensionBridge::global().await;
        if new_bridge._server_task.is_finished() {
            tracing::error!(
                "Failed to recreate extension bridge - WebSocket server still unavailable"
            );
            return Ok(None);
        }

        tracing::info!("Successfully recreated extension bridge");
        return new_bridge.eval_in_active_tab(code, timeout).await;
    }
    bridge.eval_in_active_tab(code, timeout).await
}

pub async fn try_close_tab(
    tab_id: Option<i32>,
    url: Option<&str>,
    title: Option<&str>,
    timeout: Duration,
) -> Result<Option<CloseTabResult>, AutomationError> {
    let bridge = ExtensionBridge::global().await;
    if bridge._server_task.is_finished() {
        tracing::error!("Extension bridge server task is not running for close_tab");
        return Ok(None);
    }
    bridge.close_tab(tab_id, url, title, timeout).await
}
