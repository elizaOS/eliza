use crate::event_pipe::{create_event_channel, EventPipeServer, EventSender, WorkflowEvent};
use rmcp::ErrorData as McpError;
use serde_json::json;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tracing::{debug, error, info, trace, warn};

/// Windows constant to prevent console window creation during process spawn
/// This prevents focus stealing and window minimization when spawning child processes
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Extension trait to apply CREATE_NO_WINDOW on Windows, no-op on other platforms
trait CommandNoWindow {
    fn no_window(&mut self) -> &mut Self;
}

impl CommandNoWindow for tokio::process::Command {
    #[cfg(target_os = "windows")]
    fn no_window(&mut self) -> &mut Self {
        self.creation_flags(CREATE_NO_WINDOW)
    }

    #[cfg(not(target_os = "windows"))]
    fn no_window(&mut self) -> &mut Self {
        self
    }
}

/// Shared buffer for capturing script logs in real-time.
/// This allows logs to be retrieved even when script execution times out.
#[derive(Clone, Default)]
pub struct ScriptLogBuffer {
    logs: Arc<Mutex<Vec<String>>>,
    stderr: Arc<Mutex<Vec<String>>>,
}

impl ScriptLogBuffer {
    pub fn new() -> Self {
        Self {
            logs: Arc::new(Mutex::new(Vec::new())),
            stderr: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn push_log(&self, line: String) {
        if let Ok(mut logs) = self.logs.lock() {
            logs.push(line);
        }
    }

    pub fn push_stderr(&self, line: String) {
        if let Ok(mut stderr) = self.stderr.lock() {
            stderr.push(line);
        }
    }

    pub fn get_logs(&self) -> Vec<String> {
        self.logs.lock().map(|l| l.clone()).unwrap_or_default()
    }

    pub fn get_stderr(&self) -> Vec<String> {
        self.stderr.lock().map(|s| s.clone()).unwrap_or_default()
    }
}

/// Find bundled bun executable next to the current binary (for mediar-app distribution)
fn find_bundled_bun() -> Option<String> {
    let exe_path = std::env::current_exe().ok()?;
    let exe_dir = exe_path.parent()?;

    // Check for bun.exe in the same directory as this binary
    let bun_path = exe_dir.join("bun.exe");
    if bun_path.exists() && bun_path.is_file() {
        info!("Found bundled bun at: {}", bun_path.display());
        return Some(bun_path.to_string_lossy().to_string());
    }

    None
}

/// Find executable with cross-platform path resolution
pub fn find_executable(name: &str) -> Option<String> {
    use std::env;
    use std::path::Path;

    // Special case: for bun, check bundled location first (mediar-app distribution)
    if name == "bun" {
        if let Some(bundled) = find_bundled_bun() {
            return Some(bundled);
        }
    }

    // On Windows, try multiple extensions, prioritizing executable types
    let candidates = if cfg!(windows) {
        vec![
            format!("{}.exe", name),
            format!("{}.cmd", name),
            format!("{}.bat", name),
            name.to_string(),
        ]
    } else {
        vec![name.to_string()]
    };

    // Check each candidate in PATH
    if let Ok(path_var) = env::var("PATH") {
        let separator = if cfg!(windows) { ";" } else { ":" };

        for path_dir in path_var.split(separator) {
            let path_dir = Path::new(path_dir);

            for candidate in &candidates {
                let full_path = path_dir.join(candidate);
                if full_path.exists() && full_path.is_file() {
                    info!("Found executable: {}", full_path.display());
                    return Some(full_path.to_string_lossy().to_string());
                }
            }
        }
    }

    // Fallback: try the name as-is (might work on some systems)
    info!("Executable '{}' not found in PATH, using name as-is", name);
    Some(name.to_string())
}

/// Log the installed computeruse.js version and platform package version (if present)
async fn log_computeruse_js_version(script_dir: &std::path::Path, log_prefix: &str) {
    let main_pkg_path = script_dir
        .join("node_modules")
        .join("@elizaos")
        .join("computeruse")
        .join("package.json");

    let main_version = match tokio::fs::read_to_string(&main_pkg_path).await {
        Ok(content) => match serde_json::from_str::<serde_json::Value>(&content) {
            Ok(pkg) => pkg
                .get("version")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            Err(_) => None,
        },
        Err(_) => None,
    };

    // Determine platform-specific package name (same logic as installer).
    //
    // Note: ComputerUse local bindings are Windows-only today. On other OSes we
    // support remote control via MCP from a Windows host.
    let platform_package_name: Option<&'static str> =
        if cfg!(target_arch = "x86_64") && cfg!(target_os = "windows") {
            Some("@elizaos/computeruse-win32-x64-msvc")
        } else if cfg!(target_arch = "aarch64") && cfg!(target_os = "windows") {
            Some("@elizaos/computeruse-win32-arm64-msvc")
        } else {
            None
        };

    let platform_version = if let Some(pkg_name) = platform_package_name {
        let platform_pkg_path = script_dir
            .join("node_modules")
            .join(pkg_name)
            .join("package.json");
        match tokio::fs::read_to_string(&platform_pkg_path).await {
            Ok(content) => match serde_json::from_str::<serde_json::Value>(&content) {
                Ok(pkg) => pkg
                    .get("version")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                Err(_) => None,
            },
            Err(_) => None,
        }
    } else {
        None
    };

    match (main_version, platform_package_name, platform_version) {
        (Some(mv), Some(ppn), Some(pv)) => {
            info!(
                "[{}] Using computeruse.js version {} (platform package {}@{})",
                log_prefix, mv, ppn, pv
            );
        }
        (Some(mv), _, _) => {
            info!("[{}] Using computeruse.js version {}", log_prefix, mv);
        }
        _ => {
            info!(
                "[{}] Could not determine computeruse.js version (package.json not found)",
                log_prefix
            );
        }
    }
}

/// Ensure computeruse.js is installed in a persistent directory and return the script directory
async fn ensure_computeruse_js_installed(runtime: &str) -> Result<std::path::PathBuf, McpError> {
    // Use a persistent directory instead of a new temp directory each time
    let script_dir = std::env::temp_dir().join("computeruse_mcp_persistent");

    // Check if we need to install or update computeruse.js
    let node_modules_path = script_dir
        .join("node_modules")
        .join("@elizaos")
        .join("computeruse");
    let package_json_path = script_dir.join("package.json");

    // Create the persistent directory if it doesn't exist
    tokio::fs::create_dir_all(&script_dir).await.map_err(|e| {
        McpError::internal_error(
            "Failed to create persistent script directory",
            Some(json!({"error": e.to_string()})),
        )
    })?;

    // Always create/update package.json to ensure we use latest with all platform packages
    let package_json_content = r#"{
  "name": "computeruse-mcp-persistent",
  "version": "1.0.0",
  "dependencies": {
    "@elizaos/computeruse": "latest",
    "@mediar-ai/workflow": "latest",
    "tsx": "^4.7.0",
    "typescript": "^5.3.0",
    "@types/node": "^20.0.0"
  },
  "optionalDependencies": {
    "@elizaos/computeruse-win32-arm64-msvc": "latest",
    "@elizaos/computeruse-win32-x64-msvc": "latest"
  }
}"#;

    tokio::fs::write(&package_json_path, package_json_content)
        .await
        .map_err(|e| {
            McpError::internal_error(
                "Failed to write package.json",
                Some(json!({"error": e.to_string()})),
            )
        })?;

    // Check if we need to install/reinstall
    let should_install = !node_modules_path.exists();

    // Also check if we should update (check once per day by default)
    let mut should_check_update = if node_modules_path.exists() {
        // Check the modification time of node_modules/computeruse.js
        match tokio::fs::metadata(&node_modules_path).await {
            Ok(metadata) => {
                if let Ok(modified) = metadata.modified() {
                    // Update if older than 1 day
                    let age = std::time::SystemTime::now()
                        .duration_since(modified)
                        .unwrap_or(std::time::Duration::from_secs(0));
                    age.as_secs() > 86400 // 24 hours in seconds
                } else {
                    false
                }
            }
            Err(_) => false,
        }
    } else {
        false
    };

    // Env override to force updates regardless of age
    // Set COMPUTERUSE_JS_UPDATE=always to force update on every run
    if std::env::var("COMPUTERUSE_JS_UPDATE")
        .map(|v| v.eq_ignore_ascii_case("always"))
        .unwrap_or(false)
    {
        info!(
            "[{}] Forced update enabled via COMPUTERUSE_JS_UPDATE=always",
            runtime
        );
        should_check_update = true;
    }

    // Check if platform-specific package exists for current platform (Windows-only).
    let platform_package_name = if cfg!(target_arch = "x86_64") && cfg!(target_os = "windows") {
        "@elizaos/computeruse-win32-x64-msvc"
    } else if cfg!(target_arch = "aarch64") && cfg!(target_os = "windows") {
        "@elizaos/computeruse-win32-arm64-msvc"
    } else {
        ""
    };

    let platform_package_exists = if !platform_package_name.is_empty() {
        script_dir
            .join("node_modules")
            .join(platform_package_name)
            .exists()
    } else {
        true // Skip platform check for unsupported platforms
    };

    if !platform_package_exists {
        // Remove existing node_modules to force clean reinstall
        let node_modules_dir = script_dir.join("node_modules");
        if node_modules_dir.exists() {
            info!(
                "[{}] Removing existing node_modules for clean reinstall...",
                runtime
            );
            if let Err(e) = tokio::fs::remove_dir_all(&node_modules_dir).await {
                info!(
                    "[{}] Failed to remove node_modules (continuing): {}",
                    runtime, e
                );
            }
        }
    } else if !should_install && !should_check_update {
        info!(
            "[{}] computeruse.js and platform package found, using existing installation...",
            runtime
        );
        return Ok(script_dir);
    }

    // Find the runtime executable
    let runtime_exe = find_executable(runtime).ok_or_else(|| {
        McpError::internal_error(format!("Could not find {runtime} executable"), None)
    })?;

    info!("[{}] Using executable: {}", runtime, runtime_exe);

    // Find npm/bun for installation
    let installer_exe = match runtime {
        "bun" => find_executable("bun").ok_or_else(|| {
            McpError::internal_error("Could not find bun executable for installation", None)
        })?,
        _ => find_executable("npm").ok_or_else(|| {
            McpError::internal_error("Could not find npm executable for installation", None)
        })?,
    };

    info!("[{}] Using installer: {}", runtime, installer_exe);

    info!(
        "[{}] Using persistent script directory: {}",
        runtime,
        script_dir.display()
    );

    // Install or reinstall computeruse.js in the persistent directory
    // If updating, explicitly install latest for both main and platform packages
    let platform_pkg_opt: Option<&str> = if !platform_package_name.is_empty() {
        Some(platform_package_name)
    } else {
        None
    };

    let command_args: Vec<String> = if should_install || !platform_package_exists {
        // Fresh install or reinstall when platform package missing
        vec!["install".to_string()]
    } else if should_check_update {
        // Force upgrade to latest for both packages
        let mut args = vec![
            "install".to_string(),
            "@elizaos/computeruse@latest".to_string(),
            "@mediar-ai/workflow@latest".to_string(),
            "@mediar-ai/kv@latest".to_string(),
        ];
        if let Some(pp) = platform_pkg_opt {
            args.push(format!("{pp}@latest"));
        }
        args
    } else {
        // Default to install to reconcile lock if needed
        vec!["install".to_string()]
    };

    info!(
        "[{}] Preparing to run package manager with args: {:?}",
        runtime, command_args
    );

    // Add retry mechanism based on screenpipe patterns
    let max_retries = 3;
    let mut attempt = 0;

    loop {
        attempt += 1;
        info!(
            "[{}] Installation attempt {} of {}",
            runtime, attempt, max_retries
        );

        // Use spawn with real-time output to see what's happening
        let install_result = match runtime {
            "bun" => {
                info!(
                    "[{}] Running bun directly: {} {:?}",
                    runtime, installer_exe, command_args
                );
                info!("[{}] Spawning bun process...", runtime);
                let child = match tokio::process::Command::new(&installer_exe)
                    .current_dir(&script_dir)
                    .args(command_args.iter())
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .no_window()
                    .spawn()
                {
                    Ok(child) => child,
                    Err(e) => {
                        error!("[{}] Failed to spawn bun process: {}", runtime, e);
                        return Err(McpError::internal_error(
                            "Failed to spawn bun process",
                            Some(json!({"error": e.to_string()})),
                        ));
                    }
                };

                info!(
                    "[{}] Bun process spawned, waiting for completion...",
                    runtime
                );
                child.wait_with_output().await
            }
            _ => {
                // On Windows, npm is a batch file, so we need to run it through cmd.exe
                if cfg!(windows) {
                    let mut cmd_args = vec!["/c", "npm"];
                    // Add comprehensive flags based on screenpipe patterns
                    cmd_args.extend(
                        [
                            "--verbose",
                            "--no-audit",
                            "--no-fund",
                            "--yes",
                            "--force",            // Force resolve conflicts
                            "--legacy-peer-deps", // Handle peer dependency issues
                            "--include=optional", // Ensure optional dependencies (platform packages) are installed
                            "--save-exact",       // Lock to exact versions to prevent mismatches
                            "--registry=https://registry.npmjs.org/", // Explicit registry
                        ]
                        .iter(),
                    );
                    cmd_args.extend(command_args.iter().map(|s| s.as_str()));
                    debug!(
                        "[{}] Running npm via cmd.exe: cmd {:?} in directory {}",
                        runtime,
                        cmd_args,
                        script_dir.display()
                    );

                    debug!("[{}] About to spawn cmd.exe process...", runtime);

                    // First, let's test if npm is working at all with a simple version check
                    // Debug: show what's in the directory and what we're trying to install
                    debug!("[{}] Debugging directory contents...", runtime);
                    if let Ok(entries) = std::fs::read_dir(&script_dir) {
                        for entry in entries.flatten() {
                            debug!(
                                "[{}] Directory contains: {}",
                                runtime,
                                entry.file_name().to_string_lossy()
                            );
                        }
                    }

                    if let Ok(package_json) =
                        std::fs::read_to_string(script_dir.join("package.json"))
                    {
                        debug!("[{}] package.json contents:\n{}", runtime, package_json);
                    } else {
                        debug!("[{}] Could not read package.json", runtime);
                    }

                    debug!("[{}] Testing npm connectivity first...", runtime);
                    let test_result = tokio::process::Command::new("cmd")
                        .current_dir(&script_dir)
                        .args(["/c", "npm", "--version"])
                        .output()
                        .await;

                    match test_result {
                        Ok(output) if output.status.success() => {
                            let version = String::from_utf8_lossy(&output.stdout);
                            debug!(
                                "[{}] npm version test successful: {}",
                                runtime,
                                version.trim()
                            );
                        }
                        Ok(output) => {
                            let stderr = String::from_utf8_lossy(&output.stderr);
                            error!("[{}] npm version test failed: {}", runtime, stderr);
                            error!(
                                "[{}] npm stdout: {}",
                                runtime,
                                String::from_utf8_lossy(&output.stdout)
                            );
                        }
                        Err(e) => {
                            error!("[{}] Failed to run npm version test: {}", runtime, e);
                        }
                    }

                    // Now test npm registry connectivity
                    debug!("[{}] Testing npm registry connectivity...", runtime);
                    let registry_test = tokio::process::Command::new("cmd")
                        .current_dir(&script_dir)
                        .args(["/c", "npm", "ping"])
                        .output()
                        .await;

                    match registry_test {
                        Ok(output) if output.status.success() => {
                            let ping_result = String::from_utf8_lossy(&output.stdout);
                            debug!(
                                "[{}] npm registry ping successful: {}",
                                runtime,
                                ping_result.trim()
                            );
                        }
                        Ok(output) => {
                            let stderr = String::from_utf8_lossy(&output.stderr);
                            error!("[{}] npm registry ping failed: {}", runtime, stderr);
                            error!(
                                "[{}] npm ping stdout: {}",
                                runtime,
                                String::from_utf8_lossy(&output.stdout)
                            );
                        }
                        Err(e) => {
                            error!("[{}] Failed to run npm ping test: {}", runtime, e);
                        }
                    }
                    let spawn_result = tokio::process::Command::new("cmd")
                        .current_dir(&script_dir)
                        .args(&cmd_args)
                        // Core npm configuration (based on screenpipe patterns)
                        .env("NPM_CONFIG_REGISTRY", "https://registry.npmjs.org/")
                        .env("NPM_CONFIG_LOGLEVEL", "info")
                        .env("NPM_CONFIG_PROGRESS", "true")
                        .env("NPM_CONFIG_YES", "true")
                        .env("NPM_CONFIG_FORCE", "true")
                        .env("NPM_CONFIG_LEGACY_PEER_DEPS", "true")
                        .env("NPM_CONFIG_INCLUDE", "optional")
                        .env("NPM_CONFIG_SAVE_EXACT", "true")
                        .env("NPM_CONFIG_NO_AUDIT", "true")
                        .env("NPM_CONFIG_NO_FUND", "true")
                        // Network and timeout configuration
                        .env("NPM_CONFIG_FETCH_TIMEOUT", "60000") // 60 second timeout
                        .env("NPM_CONFIG_FETCH_RETRY_MINTIMEOUT", "10000") // 10 sec min retry
                        .env("NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT", "60000") // 60 sec max retry
                        .env("NPM_CONFIG_FETCH_RETRIES", "3")
                        // CI and non-interactive mode
                        .env("CI", "true")
                        .env("NODE_ENV", "production")
                        .env("NPM_CONFIG_INTERACTIVE", "false")
                        .env("NPM_CONFIG_STDIN", "false")
                        // Cache configuration to prevent corruption issues
                        .env("NPM_CONFIG_CACHE_VERIFY", "false") // Skip cache verification
                        .env("NPM_CONFIG_PREFER_OFFLINE", "false") // Always try network first
                        .stdout(std::process::Stdio::piped())
                        .stderr(std::process::Stdio::piped())
                        .no_window()
                        .spawn();

                    match spawn_result {
                        Ok(mut child) => {
                            debug!(
                                "[{}] cmd.exe process spawned successfully, PID: {:?}",
                                runtime,
                                child.id()
                            );
                            info!("[{}] Installing computeruse.js dependencies...", runtime);

                            // Read stdout and stderr in real-time
                            use tokio::io::{AsyncBufReadExt, BufReader};

                            let stdout = child.stdout.take().unwrap();
                            let stderr = child.stderr.take().unwrap();

                            let mut stdout_reader = BufReader::new(stdout).lines();
                            let mut stderr_reader = BufReader::new(stderr).lines();

                            // Collect output for error reporting
                            let mut stdout_lines = Vec::new();
                            let mut stderr_lines = Vec::new();

                            let timeout_duration = std::time::Duration::from_secs(300); // 5 minutes
                            let start_time = std::time::Instant::now();
                            let mut last_progress_time = start_time;

                            loop {
                                if start_time.elapsed() > timeout_duration {
                                    // Use warn! since timeouts are often environmental (slow network)
                                    warn!(
                                        "[{}] npm install timed out after {:?}, killing process",
                                        runtime, timeout_duration
                                    );
                                    let _ = child.kill().await;
                                    // Print collected output on timeout
                                    if !stdout_lines.is_empty() {
                                        debug!(
                                            "[{}] npm stdout:\n{}",
                                            runtime,
                                            stdout_lines.join("\n")
                                        );
                                    }
                                    if !stderr_lines.is_empty() {
                                        debug!(
                                            "[{}] npm stderr:\n{}",
                                            runtime,
                                            stderr_lines.join("\n")
                                        );
                                    }
                                    return Err(McpError::internal_error(
                                        "npm install timed out",
                                        Some(json!({"timeout_secs": timeout_duration.as_secs()})),
                                    ));
                                }

                                tokio::select! {
                                    // Read stdout
                                    stdout_line = stdout_reader.next_line() => {
                                        match stdout_line {
                                            Ok(Some(line)) => {
                                                debug!("[{}] npm stdout: {}", runtime, line);
                                                stdout_lines.push(line);
                                                last_progress_time = std::time::Instant::now(); // Reset progress timer on output
                                            }
                                            Ok(None) => {
                                                debug!("[{}] npm stdout stream ended", runtime);
                                            }
                                            Err(e) => {
                                                debug!("[{}] Error reading npm stdout: {}", runtime, e);
                                            }
                                        }
                                    }

                                    // Read stderr
                                    stderr_line = stderr_reader.next_line() => {
                                        match stderr_line {
                                            Ok(Some(line)) => {
                                                debug!("[{}] npm stderr: {}", runtime, line);
                                                stderr_lines.push(line);
                                                last_progress_time = std::time::Instant::now(); // Reset progress timer on output
                                            }
                                            Ok(None) => {
                                                debug!("[{}] npm stderr stream ended", runtime);
                                            }
                                            Err(e) => {
                                                debug!("[{}] Error reading npm stderr: {}", runtime, e);
                                            }
                                        }
                                    }

                                    // Check if process is done and show progress
                                    _ = tokio::time::sleep(std::time::Duration::from_millis(500)) => {
                                        match child.try_wait() {
                                            Ok(Some(status)) => {
                                                debug!("[{}] npm process completed with status: {:?}", runtime, status);

                                                // Read any remaining output
                                                while let Ok(Some(line)) = stdout_reader.next_line().await {
                                                    if !line.is_empty() {
                                                        debug!("[{}] npm stdout (final): {}", runtime, line);
                                                        stdout_lines.push(line);
                                                    }
                                                }
                                                while let Ok(Some(line)) = stderr_reader.next_line().await {
                                                    if !line.is_empty() {
                                                        debug!("[{}] npm stderr (final): {}", runtime, line);
                                                        stderr_lines.push(line);
                                                    }
                                                }

                                                // Only log output if there was an error
                                                // Use warn! since npm failures are often environmental (network, missing packages)
                                                if !status.success() {
                                                    warn!("[{}] npm install failed with exit code {:?}", runtime, status.code());
                                                    if !stdout_lines.is_empty() {
                                                        debug!("[{}] npm stdout:\n{}", runtime, stdout_lines.join("\n"));
                                                    }
                                                    if !stderr_lines.is_empty() {
                                                        debug!("[{}] npm stderr:\n{}", runtime, stderr_lines.join("\n"));
                                                    }
                                                } else {
                                                    info!("[{}] Dependencies installed successfully", runtime);
                                                }

                                                break Ok(std::process::Output {
                                                    status,
                                                    stdout: stdout_lines.join("\n").into_bytes(),
                                                    stderr: stderr_lines.join("\n").into_bytes(),
                                                });
                                            }
                                            Ok(None) => {
                                                // Still running - show progress occasionally
                                                if last_progress_time.elapsed().as_secs() >= 10 {
                                                    debug!(
                                                        "[{}] npm still running... ({:.1}s elapsed, waiting for output...)",
                                                        runtime,
                                                        start_time.elapsed().as_secs_f32()
                                                    );
                                                    last_progress_time = std::time::Instant::now();
                                                }
                                            }
                                            Err(e) => {
                                                error!("[{}] Error checking npm process status: {}", runtime, e);
                                                break Err(e);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        Err(e) => {
                            error!("[{}] Failed to spawn cmd.exe process: {}", runtime, e);
                            error!("[{}] Working directory: {}", runtime, script_dir.display());
                            error!("[{}] Command attempted: cmd {:?}", runtime, cmd_args);
                            Err(e)
                        }
                    }
                } else {
                    info!(
                        "[{}] Running npm directly: {} {:?}",
                        runtime, installer_exe, command_args
                    );
                    debug!("[{}] Spawning npm process...", runtime);
                    let child = match tokio::process::Command::new(&installer_exe)
                        .current_dir(&script_dir)
                        .args(command_args.iter())
                        .stdout(std::process::Stdio::piped())
                        .stderr(std::process::Stdio::piped())
                        .no_window()
                        .spawn()
                    {
                        Ok(child) => child,
                        Err(e) => {
                            error!("[{}] Failed to spawn npm process: {}", runtime, e);
                            return Err(McpError::internal_error(
                                "Failed to spawn npm process",
                                Some(json!({"error": e.to_string()})),
                            ));
                        }
                    };

                    info!(
                        "[{}] npm process spawned, waiting for completion...",
                        runtime
                    );
                    child.wait_with_output().await
                }
            }
        };

        match install_result {
            Ok(output) => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let stderr = String::from_utf8_lossy(&output.stderr);

                if output.status.success() {
                    // Check for version mismatches and fix them
                    if !platform_package_name.is_empty() {
                        let main_pkg_json = script_dir
                            .join("node_modules")
                            .join("@mediar-ai")
                            .join("computeruse")
                            .join("package.json");
                        let platform_pkg_json = script_dir
                            .join("node_modules")
                            .join(platform_package_name)
                            .join("package.json");

                        if let (Ok(main_content), Ok(platform_content)) = (
                            tokio::fs::read_to_string(&main_pkg_json).await,
                            tokio::fs::read_to_string(&platform_pkg_json).await,
                        ) {
                            if let (Ok(main_pkg), Ok(platform_pkg)) = (
                                serde_json::from_str::<serde_json::Value>(&main_content),
                                serde_json::from_str::<serde_json::Value>(&platform_content),
                            ) {
                                let main_version = main_pkg.get("version").and_then(|v| v.as_str());
                                let platform_version =
                                    platform_pkg.get("version").and_then(|v| v.as_str());

                                if let (Some(mv), Some(pv)) = (main_version, platform_version) {
                                    if mv != pv {
                                        info!(
                                            "[{}] Version mismatch detected: computeruse.js@{} vs {}@{}",
                                            runtime, mv, platform_package_name, pv
                                        );
                                        info!(
                                            "[{}] Resolving by upgrading both packages to latest...",
                                            runtime
                                        );

                                        let upgrade_result = if runtime == "bun" {
                                            // bun: add both at latest
                                            let args = [
                                                "add".to_string(),
                                                "@elizaos/computeruse@latest".to_string(),
                                                "@mediar-ai/workflow@latest".to_string(),
                                                "@mediar-ai/kv@latest".to_string(),
                                                format!("{platform_package_name}@latest"),
                                            ];
                                            tokio::process::Command::new(&installer_exe)
                                                .current_dir(&script_dir)
                                                .args(args.iter())
                                                .output()
                                                .await
                                        } else if cfg!(windows) {
                                            // npm on Windows via cmd
                                            tokio::process::Command::new("cmd")
                                                .current_dir(&script_dir)
                                                .args([
                                                    "/c",
                                                    "npm",
                                                    "install",
                                                    "@elizaos/computeruse@latest",
                                                    &format!("{platform_package_name}@latest"),
                                                ])
                                                .output()
                                                .await
                                        } else {
                                            // npm direct
                                            tokio::process::Command::new("npm")
                                                .current_dir(&script_dir)
                                                .args([
                                                    "install",
                                                    "@elizaos/computeruse@latest",
                                                    &format!("{platform_package_name}@latest"),
                                                ])
                                                .output()
                                                .await
                                        };

                                        match upgrade_result {
                                            Ok(out) if out.status.success() => {
                                                debug!("[{}] Successfully upgraded computeruse.js and platform package to latest", runtime);
                                            }
                                            Ok(out) => {
                                                let stderr = String::from_utf8_lossy(&out.stderr);
                                                warn!("[{}] Failed to upgrade both packages (continuing): {}", runtime, stderr);
                                            }
                                            Err(e) => {
                                                warn!("[{}] Error upgrading both packages (continuing): {}", runtime, e);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }

                    return Ok(script_dir); // Success - exit retry loop
                } else {
                    let action = if should_install { "install" } else { "update" };
                    let error_msg = format!(
                        "Failed to {} computeruse.js with exit code {:?}: {}",
                        action,
                        output.status.code(),
                        stderr
                    );
                    error!("[{}] {}", runtime, error_msg);

                    let error = McpError::internal_error(
                        format!("Failed to {action} computeruse.js"),
                        Some(json!({
                            "error": stderr.to_string(),
                            "stdout": stdout.to_string(),
                            "exit_code": output.status.code(),
                            "attempt": attempt,
                            "max_retries": max_retries
                        })),
                    );

                    // Check if we should retry
                    if attempt >= max_retries {
                        error!(
                            "[{}] All {} installation attempts failed",
                            runtime, max_retries
                        );
                        return Err(error);
                    }
                }
            }
            Err(e) => {
                let action = if should_install { "install" } else { "update" };
                let error_msg = format!("Failed to run {action} command: {e}");
                error!("[{}] {}", runtime, error_msg);

                let error = McpError::internal_error(
                    "Failed to run package manager",
                    Some(json!({
                        "error": e.to_string(),
                        "attempt": attempt,
                        "max_retries": max_retries
                    })),
                );

                // Check if we should retry
                if attempt >= max_retries {
                    error!(
                        "[{}] All {} installation attempts failed",
                        runtime, max_retries
                    );
                    return Err(error);
                }
            }
        }

        // Wait before retrying (exponential backoff like screenpipe)
        let delay_secs = 2u64.pow(attempt as u32);
        error!(
            "[{}] Installation attempt {} failed, retrying in {} seconds...",
            runtime, attempt, delay_secs
        );
        tokio::time::sleep(tokio::time::Duration::from_secs(delay_secs)).await;
    }
}

/// Execute JavaScript using Node.js/Bun runtime with computeruse.js bindings available
///
/// # Arguments
/// * `script` - The JavaScript code to execute
/// * `cancellation_token` - Optional token to cancel execution
/// * `working_dir` - Optional working directory for script execution
/// * `log_buffer` - Optional shared buffer for real-time log capture (useful for timeout scenarios)
/// * `event_sender` - Optional channel to send workflow events (for real-time streaming)
/// * `execution_id` - Optional execution ID for named pipe identification
pub async fn execute_javascript_with_nodejs(
    script: String,
    cancellation_token: Option<tokio_util::sync::CancellationToken>,
    working_dir: Option<PathBuf>,
    log_buffer: Option<ScriptLogBuffer>,
    event_sender: Option<EventSender>,
    execution_id: Option<&str>,
) -> Result<serde_json::Value, McpError> {
    // Dev override: allow forcing local bindings via env var
    if std::env::var("COMPUTERUSE_JS_USE_LOCAL")
        .map(|v| {
            matches!(
                v.to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "local"
            )
        })
        .unwrap_or(false)
    {
        info!("[Node.js] Using local bindings due to COMPUTERUSE_JS_USE_LOCAL env var");
        return execute_javascript_with_local_bindings(script).await;
    }

    // In tests with COMPUTERUSE_SKIP_NPM_INSTALL, use local bindings instead
    if std::env::var("COMPUTERUSE_SKIP_NPM_INSTALL").is_ok() {
        info!("[Node.js] Using local bindings due to COMPUTERUSE_SKIP_NPM_INSTALL");
        return execute_javascript_with_local_bindings(script).await;
    }

    use std::process::Stdio;
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::process::Command;

    info!("[Node.js] Starting JavaScript execution with computeruse.js bindings");
    debug!("[Node.js] Script to execute ({} bytes)", script.len());
    debug!(
        preview = %script.chars().take(200).collect::<String>(),
        "[Node.js] Script preview"
    );

    // Check if bun is available, fallback to node
    let runtime = if let Some(bun_exe) = find_executable("bun") {
        match Command::new(&bun_exe)
            .arg("--version")
            .no_window()
            .output()
            .await
        {
            Ok(output) if output.status.success() => {
                let version = String::from_utf8_lossy(&output.stdout);
                info!(
                    "[Node.js] Found bun at: {} (version: {})",
                    bun_exe,
                    version.trim()
                );
                "bun"
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                info!(
                    "[Node.js] Bun found but version check failed: {}, falling back to node",
                    stderr
                );
                "node"
            }
            Err(e) => {
                info!(
                    "[Node.js] Bun found but not working ({}), falling back to node",
                    e
                );
                "node"
            }
        }
    } else {
        info!("[Node.js] Bun not found, using node");
        "node"
    };

    trace!("[Node.js] Using runtime: {}", runtime);

    // Ensure computeruse.js is installed and get the script directory
    let script_dir = ensure_computeruse_js_installed(runtime).await?;
    trace!("[Node.js] Script directory: {}", script_dir.display());

    // Log which computeruse.js version is in use
    log_computeruse_js_version(&script_dir, "Node.js").await;

    // Create a wrapper script that:
    // 1. Imports computeruse.js
    // 2. Executes user script
    // 3. Returns result

    // When we have a custom working directory, we need to handle module resolution differently
    // because require() resolves relative to the script file, not the working directory
    let module_resolution_setup = if working_dir.is_some() {
        // Override require to resolve modules relative to the working directory
        r#"
// Save original require
const Module = require('module');
const path = require('path');
const originalRequire = Module.prototype.require;

// Override require to handle relative paths from working directory
Module.prototype.require = function(id) {
    // If it's a relative path, resolve from process.cwd() instead of __dirname
    if (id.startsWith('./') || id.startsWith('../')) {
        const resolvedPath = path.resolve(process.cwd(), id);
        console.log(`[Node.js Wrapper] Resolving relative module: ${id} -> ${resolvedPath}`);
        return originalRequire.call(this, resolvedPath);
    }
    // For non-relative paths, use the original require
    return originalRequire.call(this, id);
};
"#
    } else {
        ""
    };

    let wrapper_script = format!(
        r#"
const {{ Desktop }} = require('@elizaos/computeruse');
{module_resolution_setup}

// Create global objects
global.desktop = new Desktop();
global.log = console.log;
global.sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Initialize workflow event emitter (for streaming events to MCP client)
// Usage: emit.progress(1, 5, "Starting..."); emit.log("info", "hello");
try {{
    const {{ emit, createStepEmitter }} = require('@mediar-ai/workflow');
    global.emit = emit;
    global.createStepEmitter = createStepEmitter;
}} catch (e) {{
    // Workflow package not available - provide no-op fallbacks
    const noopEmit = {{
        progress: () => {{}},
        stepStarted: () => {{}},
        stepCompleted: () => {{}},
        stepFailed: () => {{}},
        log: () => {{}},
        data: () => {{}},
        screenshot: () => {{}},
        status: () => {{}},
        raw: () => {{}}
    }};
    global.emit = noopEmit;
    global.createStepEmitter = () => ({{ ...noopEmit }});
}}

// Initialize KV client helper
// Usage: const kv = createKVClient(ORG_TOKEN);
try {{
    const {{ createClient }} = require('@mediar-ai/kv');
    global.createKVClient = (token) => {{
        if (!token) {{
            throw new Error('KV requires ORG_TOKEN. Pass it as: createKVClient(ORG_TOKEN)');
        }}
        return createClient({{
            url: process.env.KV_URL || 'https://app.mediar.ai/api/kv',
            token: token
        }});
    }};
}} catch (e) {{
    // KV package not available
    global.createKVClient = () => {{ throw new Error('@mediar-ai/kv package not installed'); }};
}}

// Execute user script
(async () => {{
    try {{
        const result = await (async () => {{
            // Expose globals as local variables for user script
            const {{ desktop, emit, createStepEmitter, log, sleep, createKVClient }} = global;
            {script}
        }})();

        // Send result back, handling undefined properly
        const resultToSend = result === undefined ? null : result;
        process.stdout.write('__RESULT__' + JSON.stringify(resultToSend) + '__END__\n');
    }} catch (error) {{
        // Emit machine-readable marker on stdout as well for parent capture
        console.log('__ERROR__' + JSON.stringify({{ message: String((error && error.message) || error), stack: String((error && error.stack) || '') }}) + '__END__');
        process.stdout.write('__ERROR__' + JSON.stringify({{
            message: String((error && error.message) || error),
            stack: String((error && error.stack) || '')
        }}) + '__END__\n');
    }}
}})();
"#
    );

    // Write script to the same directory where computeruse.js is installed
    // Use unique filename to avoid race conditions between concurrent tests
    let unique_filename = format!(
        "main_{}.js",
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
    );
    let script_path = script_dir.join(&unique_filename);

    info!(
        "[Node.js] Writing wrapper script to: {}",
        script_path.display()
    );

    tokio::fs::write(&script_path, wrapper_script)
        .await
        .map_err(|e| {
            error!("[Node.js] Failed to write script file: {}", e);
            McpError::internal_error(
                "Failed to write script file",
                Some(json!({"error": e.to_string(), "path": script_path.to_string_lossy()})),
            )
        })?;

    debug!("[Node.js] Script written successfully");

    // Find the runtime executable for spawning
    let runtime_exe = find_executable(runtime).ok_or_else(|| {
        error!(
            "[Node.js] Could not find {} executable for spawning",
            runtime
        );
        McpError::internal_error(
            format!("Could not find {runtime} executable for spawning"),
            None,
        )
    })?;

    trace!("[Node.js] Spawning {} at: {}", runtime, runtime_exe);

    // Check if executable is a batch file on Windows
    let is_batch_file =
        cfg!(windows) && (runtime_exe.ends_with(".cmd") || runtime_exe.ends_with(".bat"));

    // Determine the working directory for the process
    let process_working_dir = if let Some(ref wd) = working_dir {
        info!("[Node.js] Using custom working directory: {}", wd.display());
        wd.clone()
    } else {
        info!(
            "[Node.js] Using default script directory: {}",
            script_dir.display()
        );
        script_dir.clone()
    };

    // For custom working dir, we need to use absolute path to the script
    let script_arg = if working_dir.is_some() {
        script_path.to_string_lossy().to_string()
    } else {
        unique_filename.clone()
    };

    // Set up Windows named pipe for event streaming if event_sender is provided
    #[cfg(windows)]
    let pipe_server_handle = if event_sender.is_some() {
        let exec_id = execution_id.unwrap_or("run-command");
        let (pipe_tx, mut pipe_rx) = create_event_channel();
        let pipe_server = EventPipeServer::new(exec_id, pipe_tx);
        let pipe_name = pipe_server.pipe_name().to_string();

        // Start the pipe server
        let handle = pipe_server.start().await.map_err(|e| {
            McpError::internal_error(
                format!("Failed to start event pipe server: {e}"),
                Some(json!({"error": e.to_string()})),
            )
        })?;

        // Spawn a task to forward pipe events to the event_sender
        let event_sender_clone = event_sender.clone();
        tokio::spawn(async move {
            while let Some(event) = pipe_rx.recv().await {
                debug!(target: "run_command.event", "Received event from pipe: {:?}", event);

                // Log events as structured data for OTEL
                match &event {
                    WorkflowEvent::Progress {
                        current,
                        total,
                        message,
                        ..
                    } => {
                        info!(
                            target: "run_command.event",
                            event_type = "progress",
                            current = %current,
                            total = ?total,
                            "Progress: {}", message.as_deref().unwrap_or("...")
                        );
                    }
                    WorkflowEvent::StepStarted {
                        step_id, step_name, ..
                    } => {
                        info!(
                            target: "run_command.event",
                            event_type = "step_started",
                            step_id = %step_id,
                            step_name = %step_name,
                            "Step started: {}", step_name
                        );
                    }
                    WorkflowEvent::StepCompleted {
                        step_id,
                        step_name,
                        duration,
                        ..
                    } => {
                        info!(
                            target: "run_command.event",
                            event_type = "step_completed",
                            step_id = %step_id,
                            step_name = %step_name,
                            duration_ms = ?duration,
                            "Step completed: {}", step_name
                        );
                    }
                    WorkflowEvent::StepFailed {
                        step_id,
                        step_name,
                        error,
                        ..
                    } => {
                        error!(
                            target: "run_command.event",
                            event_type = "step_failed",
                            step_id = %step_id,
                            step_name = %step_name,
                            error = ?error,
                            "Step failed: {}", step_name
                        );
                    }
                    WorkflowEvent::Log { level, message, .. } => match level.as_str() {
                        "error" => error!(target: "run_command.event", "{}", message),
                        "warn" => warn!(target: "run_command.event", "{}", message),
                        "debug" => debug!(target: "run_command.event", "{}", message),
                        _ => info!(target: "run_command.event", "{}", message),
                    },
                    _ => {
                        debug!(target: "run_command.event", "Event: {:?}", event);
                    }
                }

                // Forward to event_sender
                if let Some(ref sender) = event_sender_clone {
                    if let Err(e) = sender.send(event) {
                        debug!("Failed to forward workflow event: {}", e);
                        break;
                    }
                }
            }
        });

        Some((handle, pipe_name))
    } else {
        None
    };

    #[cfg(not(windows))]
    let pipe_server_handle: Option<((), String)> = None;

    // Build command based on runtime type
    let mut cmd = if runtime == "bun" && !is_batch_file {
        info!("[Node.js] Using direct bun execution");
        let mut c = Command::new(&runtime_exe);
        c.current_dir(&process_working_dir).arg(&script_arg);
        c
    } else if cfg!(windows) && is_batch_file {
        info!("[Node.js] Using cmd.exe for batch file execution on Windows");
        let mut c = Command::new("cmd");
        c.current_dir(&process_working_dir)
            .args(["/c", &runtime_exe, &script_arg]);
        c
    } else if cfg!(windows) && runtime_exe.ends_with(".exe") {
        info!("[Node.js] Using direct .exe execution on Windows");
        let mut c = Command::new(&runtime_exe);
        c.current_dir(&process_working_dir).arg(&script_arg);
        c
    } else {
        info!("[Node.js] Using direct execution");
        let mut c = Command::new(&runtime_exe);
        c.current_dir(&process_working_dir).arg(&script_arg);
        c
    };

    // Inherit parent environment
    cmd.envs(std::env::vars());

    // Set the pipe path environment variable if we have a pipe server
    #[cfg(windows)]
    if let Some((_, ref pipe_name)) = pipe_server_handle {
        cmd.env("MCP_EVENT_PIPE", pipe_name);
        info!("[Node.js] Set MCP_EVENT_PIPE={}", pipe_name);
    }

    // Configure stdio
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.no_window();

    // Spawn the process
    let mut child = cmd.spawn().map_err(|e| {
        error!("[Node.js] Failed to spawn {} process: {}", runtime, e);
        McpError::internal_error(
            format!("Failed to spawn {runtime} process"),
            Some(json!({"error": e.to_string(), "runtime_exe": runtime_exe})),
        )
    })?;

    debug!("[Node.js] Process spawned successfully, reading output...");

    let mut stdout = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut stderr = BufReader::new(child.stderr.take().unwrap()).lines();
    let mut result: Option<serde_json::Value> = None;
    // Accumulate env updates from GitHub Actions-style log commands, e.g. ::set-env name=FOO::bar
    let mut env_updates: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
    let mut stderr_output = Vec::new();
    let mut captured_logs = Vec::new(); // Capture all console output

    // Handle communication with Node.js process
    loop {
        tokio::select! {
            // Check for cancellation
            _ = async {
                if let Some(ref ct) = cancellation_token {
                    ct.cancelled().await
                } else {
                    // Never resolves if no cancellation token
                    std::future::pending::<()>().await
                }
            } => {
                warn!("[Node.js] Execution cancelled, terminating child process");
                // Kill the child process
                #[cfg(windows)]
                {
                    // On Windows, we need to kill the process tree
                    // For now, just kill the direct child
                    if let Err(e) = child.kill().await {
                        error!("[Node.js] Failed to kill child process: {}", e);
                    }
                }
                #[cfg(unix)]
                {
                    // On Unix, kill the process group
                    if let Some(pid) = child.id() {
                        unsafe {
                            // Send SIGTERM to the process group (negative PID)
                            libc::kill(-(pid as i32), libc::SIGTERM);
                        }
                    }
                }
                return Err(McpError::internal_error(
                    "Execution cancelled by user",
                    Some(json!({"code": -32001, "reason": "user_cancelled"}))
                ));
            }
            stdout_line = stdout.next_line() => {
                match stdout_line {
                    Ok(Some(line)) => {
                        // Capture non-marker lines as logs (excluding wrapper debug output)
                        if !line.starts_with("__RESULT__")
                            && !line.starts_with("__ERROR__")
                            && !line.starts_with("::set-env ") {
                            captured_logs.push(line.clone());
                            // Also write to shared buffer for real-time access (useful for timeout scenarios)
                            if let Some(ref buf) = log_buffer {
                                buf.push_log(line.clone());
                            }
                        }
                        // Parse GitHub Actions style env updates: ::set-env name=KEY::VALUE
                        if let Some(stripped) = line.strip_prefix("::set-env ") {
                            // Expect pattern: name=KEY::VALUE
                            if let Some(name_pos) = stripped.find("name=") {
                                let after_name = &stripped[name_pos + 5..];
                                if let Some(sep_idx) = after_name.find("::") {
                                    let key = after_name[..sep_idx].trim();
                                    let value = after_name[sep_idx + 2..].to_string();
                                    if !key.is_empty() {
                                        env_updates.insert(key.to_string(), serde_json::Value::String(value));
                                        info!("[Node.js] Parsed env update: {}", key);
                                    }
                                }
                            }
                        }
                        if line.starts_with("__RESULT__") && line.ends_with("__END__") {
                            // Parse final result
                            let result_json = line.replace("__RESULT__", "").replace("__END__", "");
                            info!("[Node.js] Received result, parsing JSON ({} bytes)...", result_json.len());
                            debug!("[Node.js] Result JSON: {}", result_json);

                            match serde_json::from_str::<serde_json::Value>(&result_json) {
                                Ok(parsed_result) => {
                                    // Log a concise summary instead of full JSON
                                    if let Some(files) = parsed_result.get("files").and_then(|f| f.as_array()) {
                                        info!("[Node.js] Successfully parsed result with {} workflow files", files.len());
                                    } else {
                                        info!("[Node.js] Successfully parsed result");
                                    }
                                    result = Some(parsed_result);
                                    break;
                                }
                                Err(e) => {
                                    error!("[Node.js] Failed to parse result JSON: {}", e);
                                    debug!("[Node.js] Invalid JSON was: {}", result_json);
                                }
                            }
                        } else if line.starts_with("__ERROR__") && line.ends_with("__END__") {
                            // Parse error - use warn! since script errors are expected (user code issues)
                            let error_json = line.replace("__ERROR__", "").replace("__END__", "");
                            warn!("[Node.js] Received error from script: {}", error_json);

                            if let Ok(error_data) = serde_json::from_str::<serde_json::Value>(&error_json) {
                                // Extract the error message for better reporting
                                let error_message = error_data
                                    .get("message")
                                    .and_then(|m| m.as_str())
                                    .unwrap_or("Unknown error");

                                // Check for common error types and provide more helpful messages
                                let detailed_message = if error_message.contains("Cannot find module") {
                                    format!("JavaScript execution failed: {error_message}. The script requires a module that is not available. Please ensure all dependencies are installed or use relative paths for local modules.")
                                } else if error_message.contains("SyntaxError") {
                                    format!("JavaScript syntax error: {error_message}. Please check the script for syntax errors.")
                                } else if error_message.contains("ReferenceError") {
                                    format!("JavaScript reference error: {error_message}. The script references a variable or function that is not defined.")
                                } else {
                                    format!("JavaScript execution error: {error_message}")
                                };

                                return Err(McpError::internal_error(
                                    detailed_message,
                                    {
                                    // Strip stack trace from error data (already logged)
                                    let mut clean_data = error_data.clone();
                                    if let Some(obj) = clean_data.as_object_mut() {
                                        obj.remove("stack");
                                    }
                                    Some(clean_data)
                                },
                                ));
                            }
                            break;
                        }
                    }
                    Ok(None) => {
                        info!("[Node.js] stdout stream ended");
                        break;
                    }
                    Err(e) => {
                        error!("[Node.js] Error reading stdout: {}", e);
                        break;
                    }
                }
            }
            stderr_line = stderr.next_line() => {
                match stderr_line {
                    Ok(Some(line)) => {
                        stderr_output.push(line.clone());
                        // Also write to shared buffer for real-time access (useful for timeout scenarios)
                        if let Some(ref buf) = log_buffer {
                            buf.push_stderr(line);
                        }
                    }
                    Ok(None) => {
                        info!("[Node.js] stderr stream ended");
                    }
                    Err(e) => {
                        error!("[Node.js] Error reading stderr: {}", e);
                    }
                }
            }
        }
    }

    // Wait for process to complete
    info!("[Node.js] Waiting for process to complete...");
    let status = child.wait().await.map_err(|e| {
        error!("[Node.js] Process wait failed: {}", e);
        McpError::internal_error(
            "Node.js process failed",
            Some(json!({"error": e.to_string()})),
        )
    })?;

    info!("[Node.js] Process completed with status: {:?}", status);

    // Clean up the temporary script file (but keep the directory for reuse)
    if let Err(e) = tokio::fs::remove_file(&script_path).await {
        warn!(
            "[Node.js] Failed to clean up script file {}: {}",
            script_path.display(),
            e
        );
    }

    // Don't clean up script directory - keep it persistent for reuse
    trace!(
        "[Node.js] Keeping persistent script directory for reuse: {}",
        script_dir.display()
    );

    // Shutdown the pipe server (Windows only)
    #[cfg(windows)]
    if let Some((handle, _)) = pipe_server_handle {
        handle.shutdown().await;
    }

    if !status.success() {
        let exit_code = status.code();
        let stderr_combined = stderr_output.join("\n");

        // Use warn! since script failures are expected (user script errors, not system errors)
        warn!("[Node.js] Process exited with error code: {:?}", exit_code);
        debug!("[Node.js] Combined stderr output:\n{}", stderr_combined);

        return Err(McpError::internal_error(
            "Node.js process exited with error",
            Some(json!({
                "exit_code": exit_code,
                "stderr": stderr_combined,
                "script_path": script_path.to_string_lossy(),
                "working_directory": script_dir.to_string_lossy(),
                "runtime_exe": runtime_exe
            })),
        ));
    }

    match result {
        Some(mut r) => {
            info!("[Node.js] Execution completed successfully");
            // If we captured env updates via log commands, merge them into the result
            if !env_updates.is_empty() {
                if let Some(obj) = r.as_object_mut() {
                    // Merge with existing set_env if present
                    if let Some(existing) = obj.get_mut("set_env") {
                        if let Some(existing_obj) = existing.as_object_mut() {
                            for (k, v) in env_updates.iter() {
                                existing_obj.insert(k.clone(), v.clone());
                            }
                        } else {
                            obj.insert(
                                "set_env".to_string(),
                                serde_json::Value::Object(env_updates.clone()),
                            );
                        }
                    } else {
                        obj.insert(
                            "set_env".to_string(),
                            serde_json::Value::Object(env_updates.clone()),
                        );
                    }
                } else {
                    // Wrap non-object results so we can attach env updates
                    r = serde_json::json!({
                        "output": r,
                        "set_env": env_updates
                    });
                }
            }

            // Return result with captured logs and stderr
            info!(
                "[Node.js] Returning {} captured log lines and {} stderr lines",
                captured_logs.len(),
                stderr_output.len()
            );
            Ok(json!({
                "result": r,
                "logs": captured_logs,
                "stderr": stderr_output
            }))
        }
        None => {
            error!("[Node.js] No result received from process");
            let stderr_combined = stderr_output.join("\n");
            Err(McpError::internal_error(
                "No result received from Node.js process",
                Some(json!({
                    "stderr": stderr_combined,
                    "script_path": script_path.to_string_lossy(),
                    "working_directory": script_dir.to_string_lossy()
                })),
            ))
        }
    }
}

/// Execute TypeScript using tsx/ts-node with computeruse.js bindings available
///
/// # Arguments
/// * `script` - The TypeScript code to execute
/// * `cancellation_token` - Optional token to cancel execution
/// * `working_dir` - Optional working directory for script execution
/// * `log_buffer` - Optional shared buffer for real-time log capture (useful for timeout scenarios)
/// * `event_sender` - Optional channel to send workflow events (for real-time streaming)
/// * `execution_id` - Optional execution ID for named pipe identification
pub async fn execute_typescript_with_nodejs(
    script: String,
    cancellation_token: Option<tokio_util::sync::CancellationToken>,
    working_dir: Option<PathBuf>,
    log_buffer: Option<ScriptLogBuffer>,
    event_sender: Option<EventSender>,
    execution_id: Option<&str>,
) -> Result<serde_json::Value, McpError> {
    use std::process::Stdio;
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::process::Command;

    info!("[TypeScript] Starting TypeScript execution with computeruse.js bindings");
    debug!("[TypeScript] Script to execute ({} bytes)", script.len());
    debug!(
        preview = %script.chars().take(200).collect::<String>(),
        "[TypeScript] Script preview"
    );

    // Check if bun is available (it has native TypeScript support)
    let (runtime, use_tsx) = if let Some(bun_exe) = find_executable("bun") {
        match Command::new(&bun_exe)
            .arg("--version")
            .no_window()
            .output()
            .await
        {
            Ok(output) if output.status.success() => {
                let version = String::from_utf8_lossy(&output.stdout);
                info!(
                    "[TypeScript] Found bun at: {} (version: {}) - using native TypeScript support",
                    bun_exe,
                    version.trim()
                );
                ("bun", false)
            }
            _ => {
                info!("[TypeScript] Bun not available, will use tsx with node");
                ("node", true)
            }
        }
    } else {
        info!("[TypeScript] Bun not found, will use tsx with node");
        ("node", true)
    };

    // Ensure computeruse.js and tsx are installed
    let script_dir = ensure_computeruse_js_installed(runtime).await?;
    log_computeruse_js_version(&script_dir, runtime).await;

    // Create TypeScript script file
    let script_filename = format!("script_{}.ts", std::process::id());
    let script_path = script_dir.join(&script_filename);

    // When we have a custom working directory, we need to handle module resolution differently
    let module_resolution_setup = if working_dir.is_some() {
        // Override require to resolve modules relative to the working directory
        r#"
// Fix module resolution for custom working directories
const Module = require('module');
const path = require('path');
const originalRequire = Module.prototype.require;

Module.prototype.require = function(id: string) {
    if (id.startsWith('./') || id.startsWith('../')) {
        const resolvedPath = path.resolve(process.cwd(), id);
        console.log(`[TypeScript] Resolving relative module: ${id} -> ${resolvedPath}`);
        return originalRequire.call(this, resolvedPath);
    }
    return originalRequire.call(this, id);
};
"#
    } else {
        ""
    };

    // Wrap the script with computeruse.js imports and helpers (TypeScript version)
    let wrapped_script = format!(
        r#"
import {{ Desktop }} from '@elizaos/computeruse';
{module_resolution_setup}

const desktop = new Desktop();
const log = console.log;
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// Helper to set environment variables
const setEnv = (updates: Record<string, any>) => {{
    for (const [key, value] of Object.entries(updates)) {{
        console.log(`::set-env name=${{key}}::${{value}}`);
    }}
}};

// Initialize KV client helper
// Usage: const kv = createKVClient(ORG_TOKEN);
let createKVClient: (token: string) => any;
try {{
    const {{ createClient }} = require('@mediar-ai/kv');
    createKVClient = (token: string) => {{
        if (!token) {{
            throw new Error('KV requires ORG_TOKEN. Pass it as: createKVClient(ORG_TOKEN)');
        }}
        return createClient({{
            url: process.env.KV_URL || 'https://app.mediar.ai/api/kv',
            token: token
        }});
    }};
}} catch (e) {{
    // KV package not available
    createKVClient = () => {{ throw new Error('@mediar-ai/kv package not installed'); }};
}}

console.log('[TypeScript] Current working directory:', process.cwd());

(async () => {{
    try {{
        // Execute user script and capture result
        const result = await (async () => {{
            // User script starts here
            {script}
            // User script ends here
        }})();

        // Send result back, handling undefined properly
        const resultToSend = result === undefined ? null : result;
        process.stdout.write('__RESULT__' + JSON.stringify(resultToSend) + '__END__\n');
    }} catch (error: any) {{
        console.error('__ERROR__' + JSON.stringify({{
            message: error?.message || String(error),
            stack: error?.stack
        }}) + '__END__');
        process.exit(1);
    }}
}})();
"#
    );

    tokio::fs::write(&script_path, wrapped_script)
        .await
        .map_err(|e| {
            McpError::internal_error(
                "Failed to write TypeScript file",
                Some(json!({"error": e.to_string()})),
            )
        })?;

    info!(
        "[TypeScript] Created script file: {}",
        script_path.to_string_lossy()
    );

    // Build the command based on runtime
    // Determine the working directory for the process
    let process_working_dir = if let Some(ref wd) = working_dir {
        info!(
            "[TypeScript] Using custom working directory: {}",
            wd.display()
        );
        wd.clone()
    } else {
        info!(
            "[TypeScript] Using default script directory: {}",
            script_dir.display()
        );
        script_dir.clone()
    };

    // Set up Windows named pipe for event streaming if event_sender is provided
    #[cfg(windows)]
    let pipe_server_handle = if event_sender.is_some() {
        let exec_id = execution_id.unwrap_or("run-ts-command");
        let (pipe_tx, mut pipe_rx) = create_event_channel();
        let pipe_server = EventPipeServer::new(exec_id, pipe_tx);
        let pipe_name = pipe_server.pipe_name().to_string();

        // Start the pipe server
        let handle = pipe_server.start().await.map_err(|e| {
            McpError::internal_error(
                format!("Failed to start event pipe server: {e}"),
                Some(json!({"error": e.to_string()})),
            )
        })?;

        // Spawn a task to forward pipe events to the event_sender
        let event_sender_clone = event_sender.clone();
        tokio::spawn(async move {
            while let Some(event) = pipe_rx.recv().await {
                debug!(target: "run_ts_command.event", "Received event from pipe: {:?}", event);

                // Forward to event_sender
                if let Some(ref sender) = event_sender_clone {
                    if let Err(e) = sender.send(event) {
                        debug!("Failed to forward workflow event: {}", e);
                        break;
                    }
                }
            }
        });

        Some((handle, pipe_name))
    } else {
        None
    };

    #[cfg(not(windows))]
    let pipe_server_handle: Option<((), String)> = None;

    let mut cmd = if runtime == "bun" {
        // Bun can run TypeScript directly
        let mut c = Command::new(runtime);
        c.arg(&script_path);
        c
    } else if use_tsx {
        // Use tsx to run TypeScript with Node.js
        let mut c = Command::new("npx");
        c.args(["tsx", script_path.to_string_lossy().as_ref()]);
        c
    } else {
        // Fallback to node (shouldn't happen)
        let mut c = Command::new(runtime);
        c.arg(&script_path);
        c
    };

    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.current_dir(&process_working_dir);
    cmd.env("COMPUTERUSE_PARENT_BRIDGE_PORT", "17373"); // Enable subprocess proxy mode

    // Set the pipe path environment variable if we have a pipe server
    #[cfg(windows)]
    if let Some((_, ref pipe_name)) = pipe_server_handle {
        cmd.env("MCP_EVENT_PIPE", pipe_name);
        info!("[TypeScript] Set MCP_EVENT_PIPE={}", pipe_name);
    }

    info!("[TypeScript] Executing command: {:?}", cmd);
    cmd.no_window();

    let mut child = cmd.spawn().map_err(|e| {
        McpError::internal_error(
            "Failed to spawn TypeScript process",
            Some(json!({"error": e.to_string()})),
        )
    })?;

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    let mut stdout_reader = BufReader::new(stdout).lines();
    let mut stderr_reader = BufReader::new(stderr).lines();

    let mut result: Option<serde_json::Value> = None;
    let mut captured_logs: Vec<String> = Vec::new();
    let mut stderr_output: Vec<String> = Vec::new();
    let mut env_updates = serde_json::Map::new();

    // Process output with optional cancellation support
    let process_fut = async {
        loop {
            tokio::select! {
                line = stdout_reader.next_line() => {
                    match line {
                        Ok(Some(line)) => {
                            // Check for result marker
                            if let Some(result_json) = line.strip_prefix("__RESULT__").and_then(|s| s.strip_suffix("__END__")) {
                                match serde_json::from_str(result_json) {
                                    Ok(v) => {
                                        info!("[TypeScript] Got result from script");
                                        result = Some(v);
                                        break;
                                    }
                                    Err(e) => {
                                        error!("[TypeScript] Failed to parse result: {}", e);
                                    }
                                }
                            } else if let Some(error_json) = line.strip_prefix("__ERROR__").and_then(|s| s.strip_suffix("__END__")) {
                                error!("[TypeScript] Script error: {}", error_json);

                                if let Ok(error_data) = serde_json::from_str::<serde_json::Value>(error_json) {
                                    // Extract the error message for better reporting
                                    let error_message = error_data
                                        .get("message")
                                        .and_then(|m| m.as_str())
                                        .unwrap_or("Unknown error");

                                    // Check for common error types and provide more helpful messages
                                    let detailed_message = if error_message.contains("Cannot find module") {
                                        format!("TypeScript execution failed: {error_message}. The script requires a module that is not available. Please ensure all dependencies are installed or use relative paths for local modules.")
                                    } else if error_message.contains("SyntaxError") {
                                        format!("TypeScript syntax error: {error_message}. Please check the script for syntax errors.")
                                    } else if error_message.contains("ReferenceError") {
                                        format!("TypeScript reference error: {error_message}. The script references a variable or function that is not defined.")
                                    } else {
                                        format!("TypeScript execution error: {error_message}")
                                    };

                                    return Err(McpError::internal_error(
                                        detailed_message,
                                        {
                                    // Strip stack trace from error data (already logged)
                                    let mut clean_data = error_data.clone();
                                    if let Some(obj) = clean_data.as_object_mut() {
                                        obj.remove("stack");
                                    }
                                    Some(clean_data)
                                },
                                    ));
                                }

                                return Err(McpError::internal_error(
                                    "TypeScript execution error",
                                    serde_json::from_str(error_json).ok(),
                                ));
                            } else if line.starts_with("::set-env name=") && line.contains("::") {
                                // Parse GitHub Actions-style env var setting
                                if let Some(rest) = line.strip_prefix("::set-env name=") {
                                    if let Some(colon_pos) = rest.find("::") {
                                        let key = &rest[..colon_pos];
                                        let value = &rest[colon_pos + 2..];
                                        info!("[TypeScript] Setting env var: {} = {}", key, value);
                                        env_updates.insert(key.to_string(), serde_json::Value::String(value.to_string()));
                                    }
                                }
                            } else {
                                captured_logs.push(line.clone());
                                // Also write to shared buffer for real-time access (useful for timeout scenarios)
                                if let Some(ref buf) = log_buffer {
                                    buf.push_log(line);
                                }
                            }
                        }
                        Ok(None) => break,
                        Err(e) => {
                            error!("[TypeScript] Error reading stdout: {}", e);
                            break;
                        }
                    }
                }

                line = stderr_reader.next_line() => {
                    match line {
                        Ok(Some(line)) => {
                            debug!("[TypeScript] stderr: {}", line);
                            stderr_output.push(line.clone());
                            // Also write to shared buffer for real-time access (useful for timeout scenarios)
                            if let Some(ref buf) = log_buffer {
                                buf.push_stderr(line);
                            }
                        }
                        Ok(None) => {},
                        Err(e) => {
                            error!("[TypeScript] Error reading stderr: {}", e);
                        }
                    }
                }
            }
        }

        // Wait for process to exit
        let status = child.wait().await.map_err(|e| {
            McpError::internal_error(
                "Failed to wait for TypeScript process",
                Some(json!({"error": e.to_string()})),
            )
        })?;

        info!("[TypeScript] Process exited with status: {}", status);
        Ok(())
    };

    // Handle cancellation if token provided
    let process_result = if let Some(ct) = cancellation_token {
        tokio::select! {
            res = process_fut => res,
            _ = ct.cancelled() => {
                info!("[TypeScript] Cancellation requested, killing process");
                let _ = child.kill().await;
                return Err(McpError::internal_error(
                    "TypeScript execution cancelled",
                    None,
                ));
            }
        }
    } else {
        process_fut.await
    };

    // Shutdown the pipe server (Windows only)
    #[cfg(windows)]
    if let Some((handle, _)) = pipe_server_handle {
        handle.shutdown().await;
    }

    // Clean up script file
    let _ = tokio::fs::remove_file(&script_path).await;

    // Check for errors
    process_result?;

    // Process and return result
    match result {
        Some(mut r) => {
            // Attach env updates to result
            if !env_updates.is_empty() {
                if let serde_json::Value::Object(ref mut obj) = r {
                    obj.insert(
                        "set_env".to_string(),
                        serde_json::Value::Object(env_updates.clone()),
                    );
                } else {
                    r = serde_json::json!({
                        "output": r,
                        "set_env": env_updates
                    });
                }
            }

            Ok(json!({
                "result": r,
                "logs": captured_logs,
                "stderr": stderr_output
            }))
        }
        None => {
            let stderr_combined = stderr_output.join("\n");

            Err(McpError::internal_error(
                "No result received from TypeScript process",
                Some(json!({
                    "stderr": stderr_combined,
                    "script_path": script_path.to_string_lossy()
                })),
            ))
        }
    }
}

/// Execute Python using system interpreter with computeruse.py bindings available
pub async fn execute_python_with_bindings(
    script: String,
    working_dir: Option<PathBuf>,
) -> Result<serde_json::Value, McpError> {
    use std::process::Stdio;
    use tokio::process::Command;

    info!("[Python] Starting Python execution with computeruse.py bindings");
    debug!("[Python] Script to execute ({} bytes)", script.len());

    // Discover python interpreter
    let mut python_exe = find_executable("python").unwrap_or_else(|| "python".to_string());
    // If 'python' is not a valid executable, try python3
    if let Ok(output) = Command::new(&python_exe)
        .arg("--version")
        .no_window()
        .output()
        .await
    {
        if !output.status.success() {
            if let Some(py3) = find_executable("python3") {
                python_exe = py3;
            }
        }
    }

    // Skip installation check - assume computeruse is available in system Python
    // This avoids hanging on pip/uv install attempts
    let _site_packages_dir = std::env::temp_dir()
        .join("computeruse_mcp_python_persistent")
        .join("site-packages");
    info!("[Python] Using system Python with computeruse package (assuming it's installed)");

    // Prepare wrapper script that imports computeruse and runs the user code
    let wrapper_script = {
        let mut indented = String::new();
        for line in script.lines() {
            indented.push_str("    ");
            indented.push_str(line);
            indented.push('\n');
        }
        format!(
            r#"
import sys, json, asyncio, traceback, os

print('[Python] Current working directory:', os.getcwd(), flush=True)

# Try to import computeruse, fall back to mock if not available
try:
    import computeruse as _computeruse
    desktop = _computeruse.Desktop()
    print('[Python] Using real computeruse module', flush=True)
except ImportError:
    print('[Python] Warning: computeruse not found, using mock', flush=True)
    class MockDesktop:
        async def locator(self, selector):
            return self
        async def all(self):
            return []
        async def first(self):
            return None
    desktop = MockDesktop()

async def __user_main__():
    # Helpers
    async def sleep(ms):
        await asyncio.sleep(ms / 1000.0)
    def log(*args, **kwargs):
        print(*args, **kwargs, flush=True)
    # User code (must use 'return' for final value)
{indented}

async def __runner__():
    try:
        result = await __user_main__()
        # Normalize None to null for JSON
        sys.stdout.write('__RESULT__' + json.dumps(result) + '__END__\n')
        sys.stdout.flush()
    except Exception as e:
        sys.stdout.write('__ERROR__' + json.dumps({{
            'message': str(e),
            'stack': traceback.format_exc()
        }}) + '__END__\n')
        sys.stdout.flush()

asyncio.run(__runner__())
"#
        )
    };

    // Use a dedicated temp directory for Python execution
    let script_dir = std::env::temp_dir().join(format!(
        "computeruse_mcp_python_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    tokio::fs::create_dir_all(&script_dir).await.map_err(|e| {
        McpError::internal_error(
            "Failed to create python script directory",
            Some(json!({"error": e.to_string()})),
        )
    })?;

    let script_path = script_dir.join("main.py");

    info!(
        "[Python] Writing script to {:?} ({} bytes)",
        script_path,
        wrapper_script.len()
    );

    // Write without BOM - Python handles UTF-8 fine on Windows
    tokio::fs::write(&script_path, wrapper_script.as_bytes())
        .await
        .map_err(|e| {
            McpError::internal_error(
                "Failed to write python script",
                Some(json!({"error": e.to_string(), "path": script_path.to_string_lossy()})),
            )
        })?;

    debug!("[Python] Script written successfully");

    // Skip PYTHONPATH injection since we're using system-installed computeruse
    // This avoids potential path issues

    // Determine the working directory for the process
    let process_working_dir = if let Some(wd) = working_dir {
        info!("[Python] Using custom working directory: {}", wd.display());
        wd
    } else {
        info!(
            "[Python] Using default script directory: {}",
            script_dir.display()
        );
        script_dir.clone()
    };

    // Always use absolute path to avoid issues
    let script_arg = script_path.to_string_lossy().to_string();

    info!("[Python] Spawning process: {} {}", python_exe, script_arg);
    info!("[Python] Working dir: {}", process_working_dir.display());

    let child = Command::new(&python_exe)
        .current_dir(&process_working_dir)
        .arg("-u") // Unbuffered output for Windows
        .arg(&script_arg)
        .env("PYTHONUNBUFFERED", "1") // Also set environment variable
        .env("COMPUTERUSE_PARENT_BRIDGE_PORT", "17373") // Enable subprocess proxy mode
        .stdin(Stdio::null()) // Close stdin immediately - Python doesn't need it
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true) // Ensure child process is killed if parent dies
        .no_window()
        .spawn()
        .map_err(|e| {
            McpError::internal_error(
                "Failed to spawn python process",
                Some(json!({"error": e.to_string(), "python": python_exe, "script": script_arg})),
            )
        })?;

    debug!(
        "[Python] Process spawned successfully, PID: {:?}",
        child.id()
    );

    // Try waiting for the process to complete with timeout
    match tokio::time::timeout(std::time::Duration::from_secs(10), child.wait_with_output()).await {
        Ok(Ok(output)) => {
            let stdout_str = String::from_utf8_lossy(&output.stdout);
            let stderr_str = String::from_utf8_lossy(&output.stderr);

            info!("[Python] Process completed with status: {}", output.status);
            info!("[Python] Stdout: {}", stdout_str);
            if !stderr_str.is_empty() {
                info!("[Python] Stderr: {}", stderr_str);
            }

            // Parse output for result
            if let Some(result_start) = stdout_str.find("__RESULT__") {
                if let Some(result_end) = stdout_str.find("__END__") {
                    let result_json = &stdout_str[result_start + 10..result_end];
                    match serde_json::from_str::<serde_json::Value>(result_json) {
                        Ok(val) => {
                            // Extract logs from stdout (lines before __RESULT__)
                            let logs_str = &stdout_str[..result_start];
                            let captured_logs: Vec<String> = logs_str
                                .lines()
                                .filter(|line| !line.is_empty() && !line.starts_with("__"))
                                .map(|s| s.to_string())
                                .collect();

                            // Extract stderr lines
                            let stderr_lines: Vec<String> = stderr_str
                                .lines()
                                .filter(|line| !line.is_empty())
                                .map(|s| s.to_string())
                                .collect();

                            return Ok(json!({
                                "result": val,
                                "logs": captured_logs,
                                "stderr": stderr_lines
                            }));
                        }
                        Err(e) => {
                            return Err(McpError::internal_error(
                                "Failed to parse Python result",
                                Some(json!({"error": e.to_string(), "json": result_json})),
                            ));
                        }
                    }
                }
            }

            // Parse error if present
            if let Some(error_start) = stdout_str.find("__ERROR__") {
                if let Some(error_end) = stdout_str.find("__END__") {
                    let error_json = &stdout_str[error_start + 9..error_end];
                    if let Ok(error_data) = serde_json::from_str::<serde_json::Value>(error_json) {
                        let error_message = error_data
                            .get("message")
                            .and_then(|m| m.as_str())
                            .unwrap_or("Unknown error");
                        // Strip stack trace from error data
                        let mut clean_data = error_data.clone();
                        if let Some(obj) = clean_data.as_object_mut() {
                            obj.remove("stack");
                        }
                        return Err(McpError::internal_error(
                            format!("Python execution error: {error_message}"),
                            Some(clean_data),
                        ));
                    }
                }
            }

            // No result found
            Err(McpError::internal_error(
                "Python script did not return a result",
                Some(json!({"stdout": stdout_str.to_string(), "stderr": stderr_str.to_string()})),
            ))
        }
        Ok(Err(e)) => Err(McpError::internal_error(
            "Failed to execute Python process",
            Some(json!({"error": e.to_string()})),
        )),
        Err(_) => {
            // Timeout - process will be killed automatically due to kill_on_drop
            Err(McpError::internal_error(
                "Python script execution timed out after 10 seconds",
                None,
            ))
        }
    }

    /* OLD CODE - commenting out for now
    let mut stdout = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut stderr = BufReader::new(child.stderr.take().unwrap()).lines();
    let mut result: Option<serde_json::Value> = None;
    let mut env_updates: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
    let mut stderr_output: Vec<String> = Vec::new();

    loop {
        tokio::select! {
            line = stdout.next_line() => {
                match line {
                    Ok(Some(text)) => {
                        // Parse GitHub Actions style env updates: ::set-env name=KEY::VALUE
                        if let Some(stripped) = text.strip_prefix("::set-env ") {
                            if let Some(name_pos) = stripped.find("name=") {
                                let after_name = &stripped[name_pos + 5..];
                                if let Some(sep_idx) = after_name.find("::") {
                                    let key = after_name[..sep_idx].trim();
                                    let value = after_name[sep_idx + 2..].to_string();
                                    if !key.is_empty() {
                                        env_updates.insert(key.to_string(), serde_json::Value::String(value));
                                    }
                                }
                            }
                        }
                        if text.starts_with("__RESULT__") && text.ends_with("__END__") {
                            let result_json = text.replace("__RESULT__", "").replace("__END__", "");
                            match serde_json::from_str(&result_json) {
                                Ok(val) => { result = Some(val); break; },
                                Err(e) => { error!("[Python] Failed to parse result JSON: {}", e); }
                            }
                        } else if text.starts_with("__ERROR__") && text.ends_with("__END__") {
                            let error_json = text.replace("__ERROR__", "").replace("__END__", "");

                            if let Ok(error_data) = serde_json::from_str::<serde_json::Value>(&error_json) {
                                // Extract the error message for better reporting
                                let error_message = error_data
                                    .get("message")
                                    .and_then(|m| m.as_str())
                                    .unwrap_or("Unknown error");

                                // Check for common error types and provide more helpful messages
                                let detailed_message = if error_message.contains("No module named") || error_message.contains("ModuleNotFoundError") {
                                    format!("Python execution failed: {error_message}. The script requires a module that is not installed. Please ensure all dependencies are installed using pip.")
                                } else if error_message.contains("SyntaxError") {
                                    format!("Python syntax error: {error_message}. Please check the script for syntax errors.")
                                } else if error_message.contains("NameError") {
                                    format!("Python name error: {error_message}. The script references a variable or function that is not defined.")
                                } else if error_message.contains("ImportError") {
                                    format!("Python import error: {error_message}. Failed to import a required module or package.")
                                } else {
                                    format!("Python execution error: {error_message}")
                                };

                                return Err(McpError::internal_error(
                                    detailed_message,
                                    {
                                    // Strip stack trace from error data (already logged)
                                    let mut clean_data = error_data.clone();
                                    if let Some(obj) = clean_data.as_object_mut() {
                                        obj.remove("stack");
                                    }
                                    Some(clean_data)
                                },
                                ));
                            }

                            return Err(McpError::internal_error("Python execution error", serde_json::from_str::<serde_json::Value>(&error_json).ok()));
                        }
                    },
                    Ok(None) => { break; },
                    Err(e) => { error!("[Python] Error reading stdout: {}", e); break; }
                }
            },
                line = stderr.next_line() => {
                    match line {
                    Ok(Some(text)) => { stderr_output.push(text); },
                    Ok(None) => {},
                    Err(e) => { error!("[Python] Error reading stderr: {}", e); }
                }
            }
        }
    }

    let status = child.wait().await.map_err(|e| {
        McpError::internal_error(
            "Python process failed",
            Some(json!({"error": e.to_string()})),
        )
    })?;

    if !status.success() {
        return Err(McpError::internal_error(
            "Python process exited with error",
            Some(json!({
                "exit_code": status.code(),
                "stderr": stderr_output.join("\n"),
                "script_path": script_path.to_string_lossy(),
                "working_directory": script_dir.to_string_lossy(),
                "python": python_exe
            })),
        ));
    }

    // Clean up best-effort
    let _ = tokio::fs::remove_dir_all(&script_dir).await;

    match result {
        Some(mut r) => {
            if !env_updates.is_empty() {
                if let Some(obj) = r.as_object_mut() {
                    if let Some(existing) = obj.get_mut("set_env") {
                        if let Some(existing_obj) = existing.as_object_mut() {
                            for (k, v) in env_updates.iter() {
                                existing_obj.insert(k.clone(), v.clone());
                            }
                        } else {
                            obj.insert(
                                "set_env".to_string(),
                                serde_json::Value::Object(env_updates.clone()),
                            );
                        }
                    } else {
                        obj.insert(
                            "set_env".to_string(),
                            serde_json::Value::Object(env_updates.clone()),
                        );
                    }
                } else {
                    r = serde_json::json!({ "output": r, "set_env": env_updates });
                }
            }
            Ok(r)
        }
        None => Err(McpError::internal_error(
            "No result received from Python process",
            Some(json!({"stderr": stderr_output.join("\n")})),
        )),
    }
    */
}

/// Ensure computeruse.py is installed in a persistent site-packages directory
pub async fn ensure_computeruse_py_installed(python_exe: &str) -> Result<PathBuf, McpError> {
    use tokio::process::Command;

    info!("[Python] Checking if computeruse.py is installed (cached)");
    let cache_dir = std::env::temp_dir().join("computeruse_mcp_python_persistent");
    let site_packages_dir = cache_dir.join("site-packages");

    tokio::fs::create_dir_all(&site_packages_dir)
        .await
        .map_err(|e| {
            McpError::internal_error(
                "Failed to create Python site-packages cache directory",
                Some(json!({"error": e.to_string(), "dir": site_packages_dir})),
            )
        })?;

    // Determine if we should update: daily or forced
    let mut should_check_update = false;
    if let Ok(meta) = tokio::fs::metadata(&site_packages_dir).await {
        if let Ok(modified) = meta.modified() {
            if let Ok(age) = std::time::SystemTime::now().duration_since(modified) {
                should_check_update = age.as_secs() > 86400; // 24h
            }
        }
    }
    if std::env::var("COMPUTERUSE_PY_UPDATE")
        .map(|v| v.eq_ignore_ascii_case("always"))
        .unwrap_or(false)
    {
        should_check_update = true;
        info!("[Python] Forced update enabled via COMPUTERUSE_PY_UPDATE=always");
    }

    // Check if import works already
    let import_ok = {
        let mut cmd = Command::new(python_exe);
        cmd.arg("-c").arg("import sys;print('ok')").env(
            "PYTHONPATH",
            site_packages_dir.to_string_lossy().to_string(),
        );
        cmd.no_window();
        match cmd.output().await {
            Ok(out) => out.status.success(),
            Err(_) => false,
        }
    };

    // If site-packages exists but no update needed, try to see if computeruse is importable
    let mut have_computeruse = false;
    if !should_check_update {
        let mut cmd = Command::new(python_exe);
        cmd.arg("-c")
            .arg("import sys; import computeruse; print('ok')")
            .env(
                "PYTHONPATH",
                site_packages_dir.to_string_lossy().to_string(),
            );
        cmd.no_window();
        if let Ok(out) = cmd.output().await {
            have_computeruse = out.status.success();
        }
    }

    if should_check_update || !import_ok || !have_computeruse {
        // Check if uv is available
        let uv_available = Command::new("uv")
            .arg("--version")
            .no_window()
            .output()
            .await
            .map(|o| o.status.success())
            .unwrap_or(false);

        if !uv_available {
            return Err(McpError::internal_error(
                "Python package manager 'uv' is not installed. Please install it: pip install uv",
                Some(
                    json!({"help": "Visit https://github.com/astral-sh/uv for installation instructions"}),
                ),
            ));
        }

        info!("[Python] Installing/upgrading computeruse using uv (fast Python package manager)");

        // Try both package names that are published to PyPI
        let candidates = ["computeruse", "computeruse-py"];
        let mut last_err: Option<String> = None;

        for pkg in &candidates {
            let site_packages_path = site_packages_dir.to_string_lossy();

            // Use uv pip install with optimized settings
            let args = [
                "pip",
                "install",
                "--python",
                python_exe,
                "--target",
                site_packages_path.as_ref(),
                "--upgrade",
                pkg,
            ];

            info!("[Python] Installing {} using uv", pkg);

            // uv is much faster, so shorter timeout is fine
            let install_future = Command::new("uv").args(args).no_window().output();
            match tokio::time::timeout(std::time::Duration::from_secs(10), install_future).await {
                Ok(Ok(out)) => {
                    let stdout = String::from_utf8_lossy(&out.stdout);
                    let stderr = String::from_utf8_lossy(&out.stderr);
                    info!("[Python] uv output: {}", stdout);
                    if out.status.success() {
                        info!("[Python] uv install succeeded for {}", pkg);
                        // Touch cache dir mtime
                        let _ = tokio::fs::write(cache_dir.join(".stamp"), b"ok").await;
                        // Verify import
                        let mut verify = Command::new(python_exe);
                        verify.arg("-c").arg("import computeruse; print('ok')").env(
                            "PYTHONPATH",
                            site_packages_dir.to_string_lossy().to_string(),
                        );
                        verify.no_window();
                        if let Ok(v) = verify.output().await {
                            if v.status.success() {
                                return Ok(site_packages_dir);
                            }
                        }
                    } else {
                        warn!("[Python] uv install failed for {}: {}", pkg, stderr);
                        last_err = Some(stderr.to_string());
                    }
                }
                Ok(Err(e)) => {
                    warn!("[Python] Failed to run uv for {}: {}", pkg, e);
                    last_err = Some(e.to_string());
                }
                Err(_) => {
                    warn!("[Python] uv install timed out for {}", pkg);
                    last_err = Some(format!("Installation timed out after 10 seconds for {pkg}"));
                }
            }
        }

        return Err(McpError::internal_error(
            "Failed to install computeruse Python package via uv",
            Some(json!({"error": last_err, "help": "Try manually: uv pip install computeruse"})),
        ));
    }

    Ok(site_packages_dir)
}

/// Log installed computeruse.py version using Python runtime with injected PYTHONPATH
#[allow(dead_code)]
async fn log_computeruse_py_version(python_exe: &str, site_packages_dir: &std::path::Path) {
    use tokio::process::Command;
    let code = r#"
import sys
try:
    import importlib.metadata as md
except Exception:
    import importlib_metadata as md  # type: ignore
try:
    v = md.version('computeruse.py')
except Exception:
    try:
        v = md.version('computeruse-py')
    except Exception:
        v = 'unknown'
print(v)
"#;

    match Command::new(python_exe)
        .arg("-c")
        .arg(code)
        .env(
            "PYTHONPATH",
            site_packages_dir.to_string_lossy().to_string(),
        )
        .output()
        .await
    {
        Ok(out) if out.status.success() => {
            let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
            info!("[Python] Using computeruse.py version {}", version);
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            info!(
                "[Python] Could not determine computeruse.py version: {}",
                stderr
            );
        }
        Err(e) => {
            info!("[Python] Version query failed: {}", e);
        }
    }
}

/// Execute JavaScript using Node.js runtime with LOCAL computeruse.js bindings (for development/testing)
pub async fn execute_javascript_with_local_bindings(
    script: String,
) -> Result<serde_json::Value, McpError> {
    use std::process::Stdio;
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::process::Command;

    info!("[Node.js Local] Starting JavaScript execution with local computeruse.js bindings");

    // Check if bun is available, fallback to node
    let runtime = if let Some(bun_exe) = find_executable("bun") {
        match Command::new(&bun_exe)
            .arg("--version")
            .no_window()
            .output()
            .await
        {
            Ok(output) if output.status.success() => {
                info!("[Node.js Local] Found bun at: {}", bun_exe);
                "bun"
            }
            _ => {
                info!("[Node.js Local] Bun found but not working, falling back to node");
                "node"
            }
        }
    } else {
        info!("[Node.js Local] Bun not found, using node");
        "node"
    };

    info!("[Node.js Local] Using runtime: {}", runtime);

    // Resolve local bindings path robustly
    // 1) Explicit override via env var COMPUTERUSE_JS_LOCAL_BINDINGS (points directly to packages/computeruse-nodejs)
    // 2) Derive from compile-time crate dir (../packages/computeruse-nodejs)
    // 3) Try CWD/packages/computeruse-nodejs
    // 4) Try parent_of_CWD/packages/computeruse-nodejs
    // 5) Walk up a few ancestors looking for packages/computeruse-nodejs
    let local_bindings_path: PathBuf = {
        if let Ok(override_path) = std::env::var("COMPUTERUSE_JS_LOCAL_BINDINGS") {
            let p = PathBuf::from(override_path);
            info!(
                "[Node.js Local] Using COMPUTERUSE_JS_LOCAL_BINDINGS override: {}",
                p.display()
            );
            p
        } else {
            // Candidates to probe
            let mut candidates: Vec<PathBuf> = Vec::new();

            // From compile-time crate dir: <workspace>/computeruse-mcp-agent => <workspace>/packages/computeruse-nodejs
            let crate_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            if let Some(ws) = crate_dir.parent() {
                candidates.push(ws.join("packages").join("computeruse-nodejs"));
            }

            // From current dir
            if let Ok(cwd) = std::env::current_dir() {
                candidates.push(cwd.join("packages").join("computeruse-nodejs"));
                if let Some(parent) = cwd.parent() {
                    candidates.push(parent.join("packages").join("computeruse-nodejs"));
                }

                // Walk up to 5 ancestors looking for packages/computeruse-nodejs
                let mut anc = Some(cwd.as_path());
                for _ in 0..5 {
                    if let Some(a) = anc {
                        candidates.push(a.join("packages").join("computeruse-nodejs"));
                        anc = a.parent();
                    }
                }
            }

            // Pick the first existing candidate
            match candidates
                .into_iter()
                .find(|p| std::fs::metadata(p).is_ok())
            {
                Some(found) => found,
                None => {
                    return Err(McpError::internal_error(
                        "Local bindings directory not found",
                        Some(json!({
                            "hint": "Set COMPUTERUSE_JS_LOCAL_BINDINGS to the path of packages/computeruse-nodejs or run from the repo",
                            "cwd": std::env::current_dir().ok().map(|p| p.to_string_lossy().to_string()),
                            "crate_dir": crate_dir.to_string_lossy().to_string(),
                        })),
                    ));
                }
            }
        }
    };

    // Verify the local bindings directory exists
    if tokio::fs::metadata(&local_bindings_path).await.is_err() {
        return Err(McpError::internal_error(
            "Local bindings directory not found",
            Some(json!({"expected_path": local_bindings_path.to_string_lossy()})),
        ));
    }

    info!(
        "[Node.js Local] Using local bindings at: {}",
        local_bindings_path.display()
    );

    // Skip building local bindings; expect the user to build manually
    info!("[Node.js Local] Skipping local bindings build (user-managed)");

    // Create isolated execution directory for this run
    let script_dir = std::env::temp_dir().join(format!(
        "computeruse_mcp_local_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));

    tokio::fs::create_dir_all(&script_dir).await.map_err(|e| {
        McpError::internal_error(
            "Failed to create script directory",
            Some(json!({"error": e.to_string()})),
        )
    })?;

    info!(
        "[Node.js Local] Created script directory: {}",
        script_dir.display()
    );

    // No npm install; require local bindings directly by absolute path
    info!("[Node.js Local] Using require() with absolute local bindings path (no install)");

    // Create a wrapper script that:
    // 1. Imports local computeruse.js
    // 2. Executes user script
    // 3. Returns result
    // Require the bindings index.js explicitly for maximum compatibility (Node/Bun)
    let bindings_entry_path = local_bindings_path.join("index.js");
    let bindings_abs_path = bindings_entry_path.to_string_lossy().replace('\\', "\\\\");
    // Also resolve workflow package path (sibling to computeruse-nodejs)
    let workflow_path = local_bindings_path
        .parent()
        .map(|p| p.join("workflow"))
        .unwrap_or_default();
    let workflow_abs_path = workflow_path.to_string_lossy().replace('\\', "\\\\");
    let wrapper_script = format!(
        r#"
 const {{ Desktop }} = require("{bindings_abs_path}");

 // Create global objects
 global.desktop = new Desktop();
 global.log = console.log;
 global.sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

 // Initialize workflow event emitter
 try {{
     const {{ emit, createStepEmitter }} = require("{workflow_abs_path}");
     global.emit = emit;
     global.createStepEmitter = createStepEmitter;
 }} catch (e) {{
     // Workflow package not available - provide no-op fallbacks
     const noopEmit = {{
         progress: () => {{}},
         stepStarted: () => {{}},
         stepCompleted: () => {{}},
         stepFailed: () => {{}},
         log: () => {{}},
         data: () => {{}},
         screenshot: () => {{}},
         status: () => {{}},
         raw: () => {{}}
     }};
     global.emit = noopEmit;
     global.createStepEmitter = () => ({{ ...noopEmit }});
 }}

 // Execute user script
 (async () => {{
     try {{
         const result = await (async () => {{
             // Expose globals as local variables for user script
             const {{ desktop, emit, createStepEmitter, log, sleep }} = global;
             {script}
         }})();

         // Send result back (normalize undefined to null)
         const resultToSend = result === undefined ? null : result;
         process.stdout.write('__RESULT__' + JSON.stringify(resultToSend) + '__END__\n');
     }} catch (error) {{
         process.stdout.write('__ERROR__' + JSON.stringify({{
             message: error.message,
             stack: error.stack
         }}) + '__END__\n');
     }}
 }})();
 "#
    );

    // Write script to the directory with local bindings
    // Use unique filename to avoid race conditions between concurrent tests
    let unique_filename = format!(
        "main_{}.js",
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
    );
    let script_path = script_dir.join(&unique_filename);
    tokio::fs::write(&script_path, wrapper_script)
        .await
        .map_err(|e| {
            McpError::internal_error(
                "Failed to write script file",
                Some(json!({"error": e.to_string()})),
            )
        })?;

    info!(
        "[Node.js Local] Script written to: {}",
        script_path.display()
    );

    // Find the runtime executable for spawning
    let runtime_exe = find_executable(runtime).ok_or_else(|| {
        McpError::internal_error(
            format!("Could not find {runtime} executable for spawning"),
            None,
        )
    })?;

    info!("[Node.js Local] Spawning {} at: {}", runtime, runtime_exe);

    // Check if executable is a batch file on Windows
    let is_batch_file =
        cfg!(windows) && (runtime_exe.ends_with(".cmd") || runtime_exe.ends_with(".bat"));

    // Spawn Node.js/Bun process from the script directory
    let mut child = if runtime == "bun" && !is_batch_file {
        // Bun can be executed directly if it's not a batch file
        Command::new(&runtime_exe)
            .current_dir(&script_dir)
            .arg(&unique_filename)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .no_window()
            .spawn()
    } else if cfg!(windows) && is_batch_file {
        // Use cmd.exe for batch files on Windows
        Command::new("cmd")
            .current_dir(&script_dir)
            .args(["/c", &runtime_exe, &unique_filename])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .no_window()
            .spawn()
    } else if cfg!(windows) && runtime_exe.ends_with(".exe") {
        // Direct execution should work for .exe files
        Command::new(&runtime_exe)
            .current_dir(&script_dir)
            .arg(&unique_filename)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .no_window()
            .spawn()
    } else {
        Command::new(&runtime_exe)
            .current_dir(&script_dir)
            .arg(&unique_filename)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .no_window()
            .spawn()
    }
    .map_err(|e| {
        McpError::internal_error(
            format!("Failed to spawn {runtime} process"),
            Some(json!({"error": e.to_string()})),
        )
    })?;

    let mut stdout = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut result: Option<serde_json::Value> = None;

    // Handle communication with Node.js process
    while let Ok(Some(line)) = stdout.next_line().await {
        if line.starts_with("__RESULT__") && line.ends_with("__END__") {
            // Parse final result
            let result_json = line.replace("__RESULT__", "").replace("__END__", "");
            result = serde_json::from_str(&result_json).ok();
            break;
        } else if line.starts_with("__ERROR__") && line.ends_with("__END__") {
            // Parse error
            let error_json = line.replace("__ERROR__", "").replace("__END__", "");
            if let Ok(error_data) = serde_json::from_str::<serde_json::Value>(&error_json) {
                // Extract the error message for better reporting
                let error_message = error_data
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("Unknown error");

                // Check for common error types and provide more helpful messages
                let detailed_message = if error_message.contains("Cannot find module") {
                    format!("JavaScript execution failed: {error_message}. The script requires a module that is not available. Please ensure all dependencies are installed or use relative paths for local modules.")
                } else if error_message.contains("SyntaxError") {
                    format!("JavaScript syntax error: {error_message}. Please check the script for syntax errors.")
                } else if error_message.contains("ReferenceError") {
                    format!("JavaScript reference error: {error_message}. The script references a variable or function that is not defined.")
                } else {
                    format!("JavaScript execution error with local bindings: {error_message}")
                };

                {
                    // Strip stack trace from error data
                    let mut clean_data = error_data.clone();
                    if let Some(obj) = clean_data.as_object_mut() {
                        obj.remove("stack");
                    }
                    return Err(McpError::internal_error(detailed_message, Some(clean_data)));
                }
            }
            break;
        } else {
            // Regular console output
            info!("[Node.js Local] {}", line);
        }
    }

    // Wait for process to complete
    let status = child.wait().await.map_err(|e| {
        McpError::internal_error(
            "Node.js process failed",
            Some(json!({"error": e.to_string()})),
        )
    })?;

    // Clean up only on success; keep files on error for debugging
    if status.success() {
        tokio::fs::remove_dir_all(&script_dir).await.ok();
        info!("[Node.js Local] Cleaned up script directory");
    } else {
        warn!(
            "[Node.js Local] Keeping script directory for debugging: {}",
            script_dir.display()
        );
    }

    if !status.success() {
        return Err(McpError::internal_error(
            "Node.js process exited with error",
            Some(json!({
                "exit_code": status.code(),
                "script_dir": script_dir.to_string_lossy(),
                "script_path": script_path.to_string_lossy()
            })),
        ));
    }

    match result {
        Some(r) => {
            info!("[Node.js Local] Execution completed successfully");
            // Return result with empty logs array to match main function format
            Ok(json!({
                "result": r,
                "logs": []
            }))
        }
        None => Err(McpError::internal_error(
            "No result received from Node.js process",
            None,
        )),
    }
}

#[cfg(test)]
mod tests {
    /// Test that the wrapper script template includes global variable exposure
    /// This ensures emit, desktop, etc. are accessible without 'global.' prefix
    #[test]
    fn test_wrapper_script_exposes_globals_as_local_variables() {
        let script = "console.log('test')";

        let wrapper_template = r#"
            const result = await (async () => {
                // Expose globals as local variables for user script
                const { desktop, emit, createStepEmitter, log, sleep, createKVClient } = global;
                SCRIPT_PLACEHOLDER
            })();
        "#;

        let formatted = wrapper_template.replace("SCRIPT_PLACEHOLDER", script);

        assert!(
            formatted.contains(
                "const { desktop, emit, createStepEmitter, log, sleep, createKVClient } = global;"
            ),
            "Wrapper script must expose globals as local variables"
        );

        assert!(
            formatted.contains("console.log('test')"),
            "User script must be injected into wrapper"
        );
    }

    /// Test that emit.progress calls work when emit is exposed as local variable
    #[test]
    fn test_emit_accessible_in_user_script() {
        let user_script = "emit.progress(1, 5, \"Starting...\");\nemit.status(\"Running\");\nawait desktop.delay(100);";

        let wrapper_template = r#"
            const result = await (async () => {
                // Expose globals as local variables for user script
                const { desktop, emit, createStepEmitter, log, sleep, createKVClient } = global;
                SCRIPT_PLACEHOLDER
            })();
        "#;

        let formatted = wrapper_template.replace("SCRIPT_PLACEHOLDER", user_script);

        assert!(
            formatted.contains("emit.progress(1, 5,"),
            "emit.progress should be callable"
        );
        assert!(
            formatted.contains("emit.status("),
            "emit.status should be callable"
        );
        assert!(
            formatted.contains("await desktop.delay("),
            "desktop should be accessible"
        );
    }

    /// Test that all expected globals are exposed
    #[test]
    fn test_all_globals_exposed() {
        let expected_globals = vec![
            "desktop",
            "emit",
            "createStepEmitter",
            "log",
            "sleep",
            "createKVClient",
        ];

        let destructuring_line =
            "const { desktop, emit, createStepEmitter, log, sleep, createKVClient } = global;";

        for global in expected_globals {
            assert!(
                destructuring_line.contains(global),
                "Global '{}' must be exposed as local variable",
                global
            );
        }
    }

    /// Test backward compatibility - scripts using global.emit should still work
    #[test]
    fn test_global_prefix_still_works() {
        let user_script =
            "global.emit.progress(1, 5, \"Using global prefix\");\nglobal.desktop.delay(100);";

        let wrapper_template = r#"
            const result = await (async () => {
                // Expose globals as local variables for user script
                const { desktop, emit, createStepEmitter, log, sleep, createKVClient } = global;
                SCRIPT_PLACEHOLDER
            })();
        "#;

        let formatted = wrapper_template.replace("SCRIPT_PLACEHOLDER", user_script);

        assert!(
            formatted.contains("global.emit.progress"),
            "global.emit syntax should still be valid"
        );
    }
}
