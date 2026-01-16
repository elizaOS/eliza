use anyhow::Result;
use axum::middleware::Next;
use axum::{
    body::Body,
    extract::State,
    http::{Method, Request, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use clap::{Parser, ValueEnum};
use rmcp::{
    transport::sse_server::SseServer,
    transport::stdio,
    transport::streamable_http_server::{
        session::local::LocalSessionManager, StreamableHttpService,
    },
    ServiceExt,
};
use std::{
    net::SocketAddr,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::SystemTime,
};
use sysinfo::{ProcessesToUpdate, System};
use computeruse_mcp_agent::cancellation::RequestManager;
use computeruse_mcp_agent::child_process;
use computeruse_mcp_agent::server::{self, check_computeruse_source};
use computeruse_mcp_agent::utils::init_logging;
use tower_http::cors::CorsLayer;
use tracing::{debug, error, info};
use uuid::Uuid;

#[derive(Parser, Debug)]
#[command(
    author,
    version,
    about = "ComputerUse MCP Server - Desktop automation via Model Context Protocol"
)]
struct Args {
    /// Transport mode to use
    #[arg(short, long, value_enum, default_value = "stdio")]
    transport: TransportMode,

    /// Port to listen on (only used for SSE and HTTP transports)
    #[arg(short, long, default_value = "3000")]
    port: u16,

    /// Host to bind to (only used for SSE and HTTP transports)
    #[arg(long, default_value = "127.0.0.1")]
    host: String,

    /// Enable CORS for HTTP and SSE transports
    #[arg(long)]
    cors: bool,

    /// Authentication token for HTTP/SSE transports (can also use MCP_AUTH_TOKEN env var)
    /// When set, clients must provide matching Bearer token in Authorization header
    #[arg(long, env = "MCP_AUTH_TOKEN")]
    auth_token: Option<String>,

    /// PID to watch for auto-destruct (Windows only)
    /// When set, the MCP server will automatically shut down if the specified process terminates
    #[arg(long)]
    watch_pid: Option<u32>,

    /// Enforce single instance mode (production mode)
    /// When enabled, kills all other MCP agents to ensure only one instance runs
    /// Default: false (allows multiple instances via smart parent checking)
    #[arg(long)]
    enforce_single_instance: bool,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord, ValueEnum)]
enum TransportMode {
    /// Standard I/O transport (default)
    Stdio,
    /// Server-Sent Events transport for web integrations
    Sse,
    /// Streamable HTTP transport for HTTP-based clients
    Http,
}

#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{CloseHandle, HANDLE, STILL_ACTIVE};
#[cfg(target_os = "windows")]
use windows::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION,
};

#[cfg(target_os = "windows")]
fn is_process_alive(pid: u32) -> bool {
    unsafe {
        // Try PROCESS_QUERY_LIMITED_INFORMATION first (works across privilege boundaries)
        // Fall back to PROCESS_QUERY_INFORMATION if that fails
        let process: HANDLE = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(handle) => handle,
            Err(_) => {
                // Fallback to PROCESS_QUERY_INFORMATION
                match OpenProcess(PROCESS_QUERY_INFORMATION, false, pid) {
                    Ok(handle) => handle,
                    Err(e) => {
                        debug!("Failed to open process with PID ({}) with both LIMITED and FULL query permissions: {:?}", pid, e);
                        return false;
                    }
                }
            }
        };

        if process.is_invalid() {
            return false;
        }

        let mut exit_code: u32 = 0;
        let result = GetExitCodeProcess(process, &mut exit_code);
        let _ = CloseHandle(process);

        if result.is_err() {
            debug!("Failed to get exit code for process with PID ({})", pid);
            return false;
        }

        exit_code == STILL_ACTIVE.0 as u32
    }
}

#[cfg(target_os = "windows")]
async fn watch_pid(pid: u32) {
    info!(
        "[Auto-Destruct] Starting to watch PID {} for termination",
        pid
    );

    loop {
        if !is_process_alive(pid) {
            info!(
                "[Auto-Destruct] Process {} terminated. Shutting down MCP server...",
                pid
            );
            std::process::exit(0);
        }

        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
}

fn kill_previous_mcp_instances(enforce_single: bool) {
    let current_pid = std::process::id();
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::All, true);

    if enforce_single {
        eprintln!("🔒 Production mode: enforcing single instance");
    } else {
        eprintln!("🔧 Multi-instance mode: allowing multiple instances, only cleaning orphans");
    }

    let mut killed_count = 0;
    for (pid, process) in system.processes() {
        let process_name = process.name().to_string_lossy().to_lowercase();

        // Skip if not an MCP agent or bridge service
        if !process_name.contains("computeruse-mcp-agent")
            && !process_name.contains("computeruse-bridge-service")
        {
            continue;
        }

        // Don't kill ourselves
        if pid.as_u32() == current_pid {
            continue;
        }

        // Default (enforce_single=false): check if parent is alive (allow multiple instances)
        // Production (enforce_single=true): kill all other instances
        if !enforce_single {
            // Multi-instance mode: only kill orphaned processes
            if let Some(parent_pid) = process.parent() {
                #[cfg(target_os = "windows")]
                let parent_alive = is_process_alive(parent_pid.as_u32());

                #[cfg(not(target_os = "windows"))]
                let parent_alive = system.processes().contains_key(&parent_pid);

                if parent_alive {
                    eprintln!(
                        "✅ Skipping {} PID {} (belongs to parent PID {}, still alive)",
                        if process_name.contains("mcp-agent") {
                            "MCP agent"
                        } else {
                            "bridge service"
                        },
                        pid.as_u32(),
                        parent_pid.as_u32()
                    );
                    continue; // Parent alive, leave it alone
                }
            }
        }

        // Single-instance mode: kill all other instances
        // Multi-instance mode: kill orphaned processes only (we reach here if no parent or parent is dead)
        eprintln!(
            "🔴 Killing {} PID {}{}",
            if process_name.contains("mcp-agent") {
                "MCP agent"
            } else {
                "bridge service"
            },
            pid.as_u32(),
            if enforce_single {
                " (enforcing single instance)"
            } else {
                " (orphaned)"
            }
        );
        if process.kill() {
            killed_count += 1;
            eprintln!("✅ Successfully killed PID {}", pid.as_u32());
        } else {
            eprintln!(
                "❌ Failed to kill PID {} (may require elevated permissions)",
                pid.as_u32()
            );
        }
    }

    if killed_count > 0 {
        eprintln!("🧹 Cleaned up {killed_count} process(es), waiting for ports to be released...");
        // Increase wait time to 2 seconds for Windows to properly release ports
        std::thread::sleep(std::time::Duration::from_millis(2000));

        // Verify port 17373 is available
        let mut retries = 0;
        while retries < 5 {
            match std::net::TcpListener::bind("127.0.0.1:17373") {
                Ok(listener) => {
                    drop(listener); // Immediately release the port
                    eprintln!("Port 17373 is now available");
                    break;
                }
                Err(_) => {
                    retries += 1;
                    if retries < 5 {
                        eprintln!("Port 17373 still unavailable, waiting... (attempt {retries}/5)");
                        std::thread::sleep(std::time::Duration::from_millis(1000));
                    } else {
                        eprintln!("WARNING: Port 17373 is still not available after 5 attempts");
                    }
                }
            }
        }
    } else {
        eprintln!("✨ No orphaned or conflicting processes found");
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();

    // Kill any previous MCP instances before starting
    kill_previous_mcp_instances(args.enforce_single_instance);

    // Install panic hook to prevent stdout corruption (used by other MCP servers)
    std::panic::set_hook(Box::new(|panic_info| {
        // CRITICAL: Never write to stdout during panic - it corrupts the JSON-RPC stream
        if let Some(s) = panic_info.payload().downcast_ref::<&str>() {
            eprintln!("MCP Server Panic: {s}");
        } else {
            eprintln!("MCP Server Panic occurred");
        }
        if let Some(location) = panic_info.location() {
            eprintln!("Panic location: {}:{}", location.file(), location.line());
        }
    }));

    // Fix Windows encoding issues (IBM437 -> UTF-8)
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let _ = std::process::Command::new("cmd")
            .args(["/c", "chcp", "65001"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        eprintln!("Set Windows console to UTF-8 mode");
    }

    // Initialize job object for automatic child process cleanup on exit
    // This ensures bun/node processes are killed even if we're force-killed
    child_process::init_job_object();

    let log_capture = init_logging()?;

    // Initialize Sentry if sentry feature is enabled (before OpenTelemetry)
    let _sentry_guard = computeruse_mcp_agent::sentry::init_sentry();

    // Initialize OpenTelemetry if telemetry feature is enabled (after logging is set up)
    computeruse_mcp_agent::telemetry::init_telemetry()?;

    // Initialize execution logger (MCP request/response logging to files)
    computeruse_mcp_agent::execution_logger::init();

    // Add binary identification logging
    tracing::info!("========================================");
    tracing::info!("ComputerUse MCP Server v{}", env!("CARGO_PKG_VERSION"));
    tracing::info!(
        "Build profile: {}",
        if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        }
    );

    // Get executable path and timestamp
    if let Ok(exe_path) = std::env::current_exe() {
        tracing::info!("Binary path: {}", exe_path.display());

        // Get binary modification time
        if let Ok(metadata) = std::fs::metadata(&exe_path) {
            if let Ok(modified) = metadata.modified() {
                if let Ok(duration) = modified.duration_since(SystemTime::UNIX_EPOCH) {
                    let datetime = DateTime::<Utc>::from_timestamp(duration.as_secs() as i64, 0)
                        .unwrap_or_default();
                    tracing::info!("Binary built: {} UTC", datetime.format("%Y-%m-%d %H:%M:%S"));
                }
            }

            // File size can help distinguish builds
            tracing::info!("Binary size: {} bytes", metadata.len());
        }
    }

    // Add git and build info if available
    if let Some(git_hash) = option_env!("GIT_HASH") {
        tracing::info!("Git commit: {}", git_hash);
    }
    if let Some(git_branch) = option_env!("GIT_BRANCH") {
        tracing::info!("Git branch: {}", git_branch);
    }
    if let Some(build_time) = option_env!("BUILD_TIMESTAMP") {
        tracing::info!("Build timestamp: {}", build_time);
    }

    tracing::info!("========================================");

    // Start PID watcher if requested (Windows only auto-destruct feature)
    #[cfg(target_os = "windows")]
    if let Some(pid) = args.watch_pid {
        tokio::spawn(async move {
            watch_pid(pid).await;
        });
    }

    // Check and download computeruse source if needed (for search tools)
    check_computeruse_source();

    tracing::info!("Initializing ComputerUse MCP server...");
    tracing::info!("Transport mode: {:?}", args.transport);
    if args.cors {
        tracing::info!("CORS enabled for web transports");
    }

    match args.transport {
        TransportMode::Stdio => {
            tracing::info!("Starting stdio transport...");

            // Initialize with error recovery (pattern used by other MCP servers)
            let desktop = match server::DesktopWrapper::new_with_log_capture(log_capture.clone()) {
                Ok(d) => d,
                Err(e) => {
                    tracing::error!("Failed to initialize desktop wrapper: {}", e);
                    eprintln!("Fatal: Failed to initialize MCP server: {e}");
                    // Exit with code 1 to signal Cursor to potentially restart
                    std::process::exit(1);
                }
            };

            // Background window polling service removed - we capture explicitly on step 0 instead

            // Serve with better error handling
            let service = desktop.serve(stdio()).await.inspect_err(|e| {
                tracing::error!("Serving error: {:?}", e);
                eprintln!("Fatal: stdio communication error: {e}");
                // Many successful MCP servers exit cleanly on stdio errors
                // This signals to Cursor that the server needs to be restarted
                std::process::exit(1);
            })?;

            // Log periodic stats to help debug disconnections
            tokio::spawn(async {
                let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(60));
                loop {
                    interval.tick().await;
                    eprintln!("MCP server still running (stdio mode)");
                }
            });

            service.waiting().await?;
        }
        TransportMode::Sse => {
            let addr: SocketAddr = format!("{}:{}", args.host, args.port).parse()?;
            tracing::info!("Starting SSE server on http://{}", addr);

            if args.cors {
                error!("SSE transport does not support CORS");
                info!("Use HTTP transport for CORS support:");
                info!(
                    "   computeruse-mcp-agent -t http --cors --port {}",
                    args.port
                );
                info!("   Then connect to: http://{}:{}/mcp", args.host, args.port);
                return Ok(());
            }

            if args.auth_token.is_some() {
                tracing::warn!("⚠️  SSE transport does not support authentication yet");
                tracing::warn!("⚠️  Use HTTP transport for Bearer token authentication");
                tracing::warn!(
                    "   Command: computeruse-mcp-agent -t http --auth-token YOUR_TOKEN --port {}",
                    args.port
                );
            }

            let desktop = server::DesktopWrapper::new_with_log_capture(log_capture.clone())?;

            // Background window polling service removed - we capture explicitly on step 0 instead

            let ct = SseServer::serve(addr)
                .await?
                .with_service(move || desktop.clone());

            info!("SSE server running on http://{addr}");
            info!("Connect your MCP client to:");
            info!("  SSE endpoint: http://{addr}/sse");
            info!("  Message endpoint: http://{addr}/message");
            info!("Press Ctrl+C to stop");

            tokio::signal::ctrl_c().await?;
            ct.cancel();
            // Kill any running child processes (bun/node workflow executors)
            child_process::kill_all();
            tracing::info!("Shutting down SSE server");
        }
        TransportMode::Http => {
            let addr: SocketAddr = format!("{}:{}", args.host, args.port).parse()?;
            tracing::info!("Starting streamable HTTP server on http://{}", addr);

            // Create a single DesktopWrapper instance to share across all requests
            // This ensures recorder state persists between start/stop recording calls
            let desktop_wrapper = Arc::new(tokio::sync::RwLock::new(None));
            let desktop_wrapper_for_service = desktop_wrapper.clone();

            // Lazy-initialize DesktopWrapper on first /mcp use so that /health can succeed on CI
            let service = StreamableHttpService::new(
                {
                    let log_capture = log_capture.clone();
                    move || {
                        // Use async block to handle RwLock
                        let desktop_wrapper = desktop_wrapper_for_service.clone();
                        let log_capture = log_capture.clone();

                        // Block on async to get or create the singleton DesktopWrapper
                        // Use block_in_place to safely block within tokio runtime (fixes crashes with multiple MCP clients)
                        tracing::debug!(
                            "MCP service factory called - using block_in_place for tokio safety"
                        );
                        tokio::task::block_in_place(|| {
                            tokio::runtime::Handle::current().block_on(async move {
                                let mut wrapper_guard = desktop_wrapper.write().await;
                                if wrapper_guard.is_none() {
                                    tracing::info!(
                                        "Creating singleton DesktopWrapper for HTTP mode"
                                    );
                                    match server::DesktopWrapper::new_with_log_capture(log_capture)
                                    {
                                        Ok(wrapper) => {
                                            *wrapper_guard = Some(wrapper.clone());
                                            Ok(wrapper)
                                        }
                                        Err(e) => Err(std::io::Error::other(e.to_string())),
                                    }
                                } else {
                                    Ok(wrapper_guard.as_ref().unwrap().clone())
                                }
                            })
                        })
                    }
                },
                LocalSessionManager::default().into(),
                Default::default(),
            );

            // Busy-aware concurrency state with request tracking
            #[derive(Clone)]
            struct AppState {
                active_requests: Arc<AtomicUsize>,
                last_activity: Arc<Mutex<String>>, // ISO-8601
                max_concurrent: usize,
                request_manager: RequestManager,
                auth_token: Option<String>,
                desktop_wrapper: Arc<tokio::sync::RwLock<Option<server::DesktopWrapper>>>,
            }

            let max_concurrent = std::env::var("MCP_MAX_CONCURRENT")
                .ok()
                .and_then(|s| s.parse::<usize>().ok())
                .unwrap_or(1);

            let app_state = AppState {
                active_requests: Arc::new(AtomicUsize::new(0)),
                last_activity: Arc::new(Mutex::new(chrono::Utc::now().to_rfc3339())),
                max_concurrent,
                request_manager: RequestManager::new(),
                auth_token: args.auth_token.clone(),
                desktop_wrapper: desktop_wrapper.clone(),
            };

            // Log authentication status
            if app_state.auth_token.is_some() {
                tracing::info!("🔒 Authentication enabled - Bearer token required");
            } else {
                tracing::warn!("⚠️  Authentication disabled - server is publicly accessible");
            }

            async fn status_handler(State(state): State<AppState>) -> impl IntoResponse {
                let active = state.active_requests.load(Ordering::SeqCst);
                let busy = active >= state.max_concurrent;
                let last_activity = state
                    .last_activity
                    .lock()
                    .map(|s| s.clone())
                    .unwrap_or_else(|_| chrono::Utc::now().to_rfc3339());
                let code = if busy {
                    StatusCode::SERVICE_UNAVAILABLE
                } else {
                    StatusCode::OK
                };
                let body = serde_json::json!({
                    "busy": busy,
                    "activeRequests": active,
                    "maxConcurrent": state.max_concurrent,
                    "lastActivity": last_activity,
                });
                (code, Json(body))
            }

            // Request body for POST /mode endpoint
            #[derive(serde::Deserialize)]
            struct SetModeRequest {
                /// Client name to set mode for (e.g., "claude-code")
                /// Defaults to "claude-code" for backward compatibility
                #[serde(default = "default_client_name")]
                client_name: String,
                mode: String, // "ask" or "act"
                #[serde(default)]
                blocked_tools: Vec<String>, // Tools to block in this mode
            }

            fn default_client_name() -> String {
                "claude-code".to_string()
            }

            // Handler for POST /mode - sets the mode and blocked tools for a specific client
            async fn set_mode_handler(
                State(state): State<AppState>,
                Json(payload): Json<SetModeRequest>,
            ) -> impl IntoResponse {
                tracing::info!(
                    "[set_mode] Setting mode='{}' for client='{}' with {} blocked tools",
                    payload.mode,
                    payload.client_name,
                    payload.blocked_tools.len()
                );

                if let Some(ref wrapper) = *state.desktop_wrapper.read().await {
                    // Set per-client mode
                    {
                        let mut modes_guard = wrapper.client_modes.lock().await;
                        let state = computeruse_mcp_agent::utils::ClientModeState {
                            mode: payload.mode.clone(),
                            blocked_tools: payload.blocked_tools.iter().cloned().collect(),
                        };
                        modes_guard.insert(payload.client_name.clone(), state);
                    }

                    tracing::debug!(
                        "[set_mode] Mode set successfully: client={}, mode={}, blocked_tools={:?}",
                        payload.client_name,
                        payload.mode,
                        payload.blocked_tools
                    );

                    (
                        StatusCode::OK,
                        Json(serde_json::json!({
                            "success": true,
                            "clientName": payload.client_name,
                            "mode": payload.mode,
                            "blockedToolsCount": payload.blocked_tools.len()
                        })),
                    )
                } else {
                    tracing::error!("[set_mode] Desktop wrapper not available");
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(serde_json::json!({
                            "success": false,
                            "error": "Desktop wrapper not available"
                        })),
                    )
                }
            }

            // Authentication middleware - validates Bearer token if auth is enabled
            async fn auth_middleware(
                State(state): State<AppState>,
                req: Request<Body>,
                next: Next,
            ) -> impl IntoResponse {
                // Skip auth if no token is configured
                if state.auth_token.is_none() {
                    return next.run(req).await;
                }

                // Extract Authorization header
                let auth_header = req
                    .headers()
                    .get(axum::http::header::AUTHORIZATION)
                    .and_then(|v| v.to_str().ok());

                // Validate token
                if let Some(auth_value) = auth_header {
                    if let Some(token) = auth_value.strip_prefix("Bearer ") {
                        if state.auth_token.as_deref() == Some(token) {
                            // Token valid, proceed
                            return next.run(req).await;
                        }
                    }
                }

                // Authentication failed
                debug!("Authentication failed - invalid or missing Bearer token");
                let body = serde_json::json!({
                    "error": {
                        "code": -32001,
                        "message": "Unauthorized - invalid or missing Bearer token"
                    }
                });
                (StatusCode::UNAUTHORIZED, Json(body)).into_response()
            }

            async fn mcp_gate(
                State(state): State<AppState>,
                req: Request<Body>,
                next: Next,
            ) -> impl IntoResponse {
                if req.method() == Method::POST {
                    let active = state.active_requests.load(Ordering::SeqCst);
                    if active >= state.max_concurrent {
                        let last_activity = state
                            .last_activity
                            .lock()
                            .map(|s| s.clone())
                            .unwrap_or_else(|_| chrono::Utc::now().to_rfc3339());
                        let body = serde_json::json!({
                            "busy": true,
                            "activeRequests": active,
                            "maxConcurrent": state.max_concurrent,
                            "lastActivity": last_activity,
                        });
                        return (StatusCode::SERVICE_UNAVAILABLE, Json(body)).into_response();
                    }

                    // Extract request ID from headers or generate one
                    let headers = req.headers();
                    let request_id = headers
                        .get("x-request-id")
                        .and_then(|v| v.to_str().ok())
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| Uuid::new_v4().to_string());

                    // Extract timeout from headers
                    let timeout_ms = headers
                        .get("x-request-timeout-ms")
                        .and_then(|v| v.to_str().ok())
                        .and_then(|s| s.parse::<u64>().ok())
                        .or_else(|| {
                            std::env::var("MCP_DEFAULT_TIMEOUT_MS")
                                .ok()
                                .and_then(|s| s.parse::<u64>().ok())
                        });

                    // Register the request with cancellation support
                    let context = state
                        .request_manager
                        .register(request_id.clone(), timeout_ms)
                        .await;

                    state.active_requests.fetch_add(1, Ordering::SeqCst);
                    if let Ok(mut ts) = state.last_activity.lock() {
                        *ts = chrono::Utc::now().to_rfc3339();
                    }

                    // Clone for cleanup
                    let request_id_cleanup = request_id.clone();
                    let manager_cleanup = state.request_manager.clone();
                    let state_cleanup = state.clone();

                    // Execute the request with cancellation support
                    let response = tokio::select! {
                        res = next.run(req) => res,
                        _ = context.cancellation_token.cancelled() => {
                            debug!("Request {} was cancelled", request_id);
                            let body = serde_json::json!({
                                "error": {
                                    "code": -32001,
                                    "message": format!("Request {} was cancelled", request_id)
                                }
                            });
                            (StatusCode::REQUEST_TIMEOUT, Json(body)).into_response()
                        }
                    };

                    // Cleanup
                    manager_cleanup.unregister(&request_id_cleanup).await;
                    state_cleanup.active_requests.fetch_sub(1, Ordering::SeqCst);
                    if let Ok(mut ts) = state_cleanup.last_activity.lock() {
                        *ts = chrono::Utc::now().to_rfc3339();
                    }

                    return response;
                }

                next.run(req).await
            }

            // Middleware to extract X-Workflow-Dir header and set current_workflow_dir
            async fn workflow_dir_middleware(
                State(state): State<AppState>,
                req: Request<Body>,
                next: Next,
            ) -> impl IntoResponse {
                // Extract X-Workflow-Dir header
                if let Some(workflow_dir) = req
                    .headers()
                    .get("x-workflow-dir")
                    .and_then(|v| v.to_str().ok())
                {
                    // Set current_workflow_dir on the DesktopWrapper
                    if let Some(ref wrapper) = *state.desktop_wrapper.read().await {
                        let mut dir_guard = wrapper.current_workflow_dir.lock().await;
                        *dir_guard = Some(std::path::PathBuf::from(workflow_dir));
                        tracing::debug!(
                            "[workflow_dir_middleware] Set current_workflow_dir={}",
                            workflow_dir
                        );
                    }
                }
                next.run(req).await
            }

            // Build a sub-router for /mcp that uses the service with auth and concurrency gate middleware
            let mcp_router = Router::new()
                .fallback_service(service)
                .layer(axum::middleware::from_fn_with_state(
                    app_state.clone(),
                    workflow_dir_middleware,
                ))
                .layer(axum::middleware::from_fn_with_state(
                    app_state.clone(),
                    mcp_gate,
                ))
                .layer(axum::middleware::from_fn_with_state(
                    app_state.clone(),
                    auth_middleware,
                ));

            let mut router: Router = Router::new()
                .route("/", get(root_handler))
                .route("/health", get(health_check))
                .route("/ready", get(readiness_check))
                .route("/status", get(status_handler))
                .route("/mode", post(set_mode_handler))
                .nest("/mcp", mcp_router)
                .with_state(app_state.clone());

            if args.cors {
                router = router.layer(CorsLayer::permissive());
            }

            let tcp_listener = tokio::net::TcpListener::bind(addr).await?;

            info!("Streamable HTTP server running on http://{addr}");
            if args.cors {
                info!("CORS enabled - accessible from web browsers");
            }
            info!("Available endpoints:");
            info!("  Root (endpoint list): http://{addr}/");
            info!("  MCP client endpoint: http://{addr}/mcp");
            info!("  Status endpoint: http://{addr}/status");
            info!("  Health check: http://{addr}/health");
            info!("  Mode control: POST http://{addr}/mode");
            info!("Press Ctrl+C to stop");

            axum::serve(tcp_listener, router)
                .with_graceful_shutdown(async move {
                    tokio::signal::ctrl_c().await.ok();
                    info!("Received shutdown signal, cancelling active requests...");
                    app_state.request_manager.cancel_all().await;
                    // Kill any running child processes (bun/node workflow executors)
                    child_process::kill_all();
                })
                .await?;

            tracing::info!("Shutting down HTTP server");
        }
    }

    // Kill any remaining child processes (safety net)
    child_process::kill_all();

    // Shutdown telemetry before exiting
    computeruse_mcp_agent::telemetry::shutdown_telemetry();

    // Shutdown Sentry before exiting (flushes pending events)
    computeruse_mcp_agent::sentry::shutdown_sentry();

    Ok(())
}

async fn root_handler() -> impl axum::response::IntoResponse {
    (
        axum::http::StatusCode::OK,
        axum::Json(serde_json::json!({
            "name": "ComputerUse MCP Server",
            "description": "Desktop automation via Model Context Protocol",
            "version": env!("CARGO_PKG_VERSION"),
            "endpoints": {
                "/": "This endpoint - lists available endpoints",
                "/mcp": "MCP protocol endpoint - connect your MCP client here",
                "/health": "Health check endpoint - returns server status",
                "/status": "Status endpoint - shows active requests and concurrency info"
            },
            "usage": {
                "mcp_client": "Connect your MCP client to: /mcp",
                "example": "http://127.0.0.1:3000/mcp"
            },
            "documentation": "https://github.com/mediar-ai/computeruse",
            "timestamp": chrono::Utc::now().to_rfc3339()
        })),
    )
}

async fn health_check() -> impl axum::response::IntoResponse {
    // Lightweight liveness check - confirms process is alive and HTTP server is responding
    // Does NOT perform expensive UIAutomation API checks that can block during workflows
    //
    // Use cases:
    // - Azure Load Balancer health probes (frequent, every 5-15s)
    // - mediar-app health monitoring (every 30s)
    // - Kubernetes liveness probes
    //
    // For deep UIAutomation API validation, use /ready endpoint instead

    let response_body = serde_json::json!({
        "status": "healthy",
        "message": "MCP server process is alive and responding",
        "timestamp": chrono::Utc::now().to_rfc3339(),
        "version": env!("CARGO_PKG_VERSION"),
        "endpoints": {
            "/health": "Liveness check (this endpoint)",
            "/ready": "Readiness check with full UIAutomation validation",
            "/status": "Concurrency and load status"
        }
    });

    (axum::http::StatusCode::OK, axum::Json(response_body))
}

async fn readiness_check() -> impl axum::response::IntoResponse {
    use computeruse::health::{check_automation_health, HealthStatus};

    // Deep readiness check - validates UIAutomation API is functional and ready to serve requests
    // This performs expensive checks (500ms-5s) and may be slow during heavy automation workloads
    //
    // Use cases:
    // - Pre-deployment validation
    // - Diagnostics and troubleshooting
    // - Kubernetes readiness probes (less frequent)
    // - Manual health verification
    //
    // NOT recommended for frequent automated monitoring - use /health instead

    // Get bridge health status
    let bridge_health = computeruse::extension_bridge::ExtensionBridge::health_status().await;

    // Check platform-specific automation API health
    let automation_health = check_automation_health().await;

    // Build response body
    let response_body = serde_json::json!({
        "status": match automation_health.status {
            HealthStatus::Healthy => "ready",
            HealthStatus::Degraded => "degraded",
            HealthStatus::Unhealthy => "not_ready",
        },
        "extension_bridge": bridge_health,
        "automation": {
            "api_available": automation_health.api_available,
            "desktop_accessible": automation_health.desktop_accessible,
            "can_enumerate_elements": automation_health.can_enumerate_elements,
            "check_duration_ms": automation_health.check_duration_ms,
            "error_message": automation_health.error_message,
            "diagnostics": automation_health.diagnostics,
        },
        "platform": automation_health.platform,
        "timestamp": chrono::Utc::now().to_rfc3339()
    });

    // Return appropriate HTTP status based on health
    let http_status = match automation_health.status.to_http_status() {
        200 => axum::http::StatusCode::OK,
        206 => axum::http::StatusCode::PARTIAL_CONTENT,
        503 => axum::http::StatusCode::SERVICE_UNAVAILABLE,
        _ => axum::http::StatusCode::INTERNAL_SERVER_ERROR,
    };

    (http_status, axum::Json(response_body))
}
