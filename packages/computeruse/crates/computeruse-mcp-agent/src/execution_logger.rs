//! MCP Tool Execution Logger
//!
//! Logs all MCP tool requests and responses to flat files in %LOCALAPPDATA%\mediar\executions\
//! with associated before/after screenshots. 7-day retention with automatic cleanup.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chrono::{DateTime, Local, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tracing::{debug, error, info, warn};

/// Whether execution logging is enabled (can be disabled via env var)
static LOGGING_ENABLED: AtomicBool = AtomicBool::new(true);

/// Retention period in days
const RETENTION_DAYS: i64 = 7;
/// A captured log entry from workflow execution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapturedLogEntry {
    pub timestamp: DateTime<Utc>,
    pub level: String,
    pub message: String,
}

/// Execution log entry combining request and response
#[derive(Debug, Serialize, Deserialize)]
pub struct ExecutionLog {
    pub timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workflow_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_index: Option<usize>,
    pub tool_name: String,
    pub request: Value,
    pub response: ExecutionResponse,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screenshots: Option<ScreenshotRefs>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logs: Option<Vec<CapturedLogEntry>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ExecutionResponse {
    pub status: String,
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ScreenshotRefs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub after: Vec<String>,
}

/// Context for logging an execution (passed between request and response logging)
#[derive(Debug, Clone)]
pub struct ExecutionContext {
    pub timestamp: chrono::DateTime<Local>,
    pub workflow_id: Option<String>,
    pub step_id: Option<String>,
    pub step_index: Option<usize>,
    pub tool_name: String,
    pub request: Value,
    pub file_prefix: String,
}

/// Get the executions directory path for standalone tool calls (no workflow context)
/// Path: %LOCALAPPDATA%/mediar/executions/
pub fn get_executions_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("mediar")
        .join("executions")
}

/// Get the executions directory path for a specific workflow
/// Path: %LOCALAPPDATA%/mediar/workflows/{workflow_id}/executions/
pub fn get_workflow_executions_dir(workflow_id: &str) -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("mediar")
        .join("workflows")
        .join(workflow_id)
        .join("executions")
}

/// Get the logs directory path
pub fn get_logs_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("computeruse")
        .join("logs")
}

/// Initialize execution logging (create dir, check env var, run cleanup)
pub fn init() {
    // Check if logging is disabled via env var
    if std::env::var("COMPUTERUSE_DISABLE_EXECUTION_LOGS")
        .map(|v| v == "1" || v.to_lowercase() == "true")
        .unwrap_or(false)
    {
        LOGGING_ENABLED.store(false, Ordering::Relaxed);
        info!(
            "[execution_logger] Execution logging disabled via COMPUTERUSE_DISABLE_EXECUTION_LOGS"
        );
        return;
    }

    let dir = get_executions_dir();
    if let Err(e) = fs::create_dir_all(&dir) {
        error!("[execution_logger] Failed to create executions dir: {}", e);
        LOGGING_ENABLED.store(false, Ordering::Relaxed);
        return;
    }

    info!(
        "[execution_logger] Execution logs will be written to: {}",
        dir.display()
    );

    // Run cleanup in background
    tokio::spawn(async {
        cleanup_old_executions().await;
    });
}

/// Check if logging is enabled
pub fn is_enabled() -> bool {
    LOGGING_ENABLED.load(Ordering::Relaxed)
}

/// Predicted paths for execution log files
#[derive(Debug, Clone)]
pub struct PredictedLogPaths {
    /// Path to the JSON execution log
    pub json_path: String,
    /// Path to the TypeScript snippet file
    pub ts_path: String,
}

/// Get the predicted execution log paths for a tool call
/// This allows tools to include the log paths in their response before logging happens
pub fn get_predicted_log_paths(
    workflow_id: Option<&str>,
    step_id: Option<&str>,
    tool_name: &str,
) -> PredictedLogPaths {
    if !is_enabled() {
        return PredictedLogPaths {
            json_path: String::new(),
            ts_path: String::new(),
        };
    }
    let timestamp = Local::now();
    let file_prefix = generate_file_prefix(&timestamp, workflow_id, step_id, tool_name);
    let dir = match workflow_id {
        Some(wf_id) => get_workflow_executions_dir(wf_id),
        None => get_executions_dir(),
    };
    PredictedLogPaths {
        json_path: dir
            .join(format!("{}.json", file_prefix))
            .to_string_lossy()
            .to_string(),
        ts_path: dir
            .join(format!("{}.ts", file_prefix))
            .to_string_lossy()
            .to_string(),
    }
}

/// Get the predicted execution log path for a tool call (legacy, returns only JSON path)
/// This allows tools to include the log path in their response before logging happens
pub fn get_predicted_log_path(
    workflow_id: Option<&str>,
    step_id: Option<&str>,
    tool_name: &str,
) -> String {
    get_predicted_log_paths(workflow_id, step_id, tool_name).json_path
}

/// Generate file prefix: YYYYMMDD_HHMMSS_workflowId_stepId_toolName
fn generate_file_prefix(
    timestamp: &chrono::DateTime<Local>,
    workflow_id: Option<&str>,
    step_id: Option<&str>,
    tool_name: &str,
) -> String {
    let date_time = timestamp.format("%Y%m%d_%H%M%S").to_string();
    let wf_id = workflow_id.unwrap_or("standalone");
    let step = step_id.unwrap_or("full");
    // Sanitize tool name (remove mcp__ prefix if present)
    let clean_tool = tool_name
        .strip_prefix("mcp__computeruse-mcp-agent__")
        .unwrap_or(tool_name);
    format!("{}_{}_{}_{}", date_time, wf_id, step, clean_tool)
}

/// Start logging an execution (call before tool dispatch)
/// Returns context to pass to log_response
pub fn log_request(
    tool_name: &str,
    arguments: &Value,
    workflow_id: Option<&str>,
    step_id: Option<&str>,
    step_index: Option<usize>,
) -> Option<ExecutionContext> {
    info!(
        "[execution_logger] log_request called for tool: {}, enabled: {}",
        tool_name,
        is_enabled()
    );
    if !is_enabled() {
        return None;
    }

    let timestamp = Local::now();
    let file_prefix = generate_file_prefix(&timestamp, workflow_id, step_id, tool_name);

    Some(ExecutionContext {
        timestamp,
        workflow_id: workflow_id.map(String::from),
        step_id: step_id.map(String::from),
        step_index,
        tool_name: tool_name.to_string(),
        request: arguments.clone(),
        file_prefix,
    })
}

/// Complete logging an execution (call after tool dispatch)
pub fn log_response(ctx: ExecutionContext, result: Result<&Value, &str>, duration_ms: u64) {
    info!(
        "[execution_logger] log_response called for tool: {}, workflow_id: {:?}, enabled: {}",
        ctx.tool_name,
        ctx.workflow_id,
        is_enabled()
    );
    if !is_enabled() {
        return;
    }

    // Use workflow-specific directory if workflow_id is available, otherwise use standalone dir
    let dir = match &ctx.workflow_id {
        Some(wf_id) => get_workflow_executions_dir(wf_id),
        None => get_executions_dir(),
    };

    // Ensure directory exists
    if let Err(e) = fs::create_dir_all(&dir) {
        error!(
            "[execution_logger] Failed to create executions dir {:?}: {}",
            dir, e
        );
        return;
    }

    let json_path = dir.join(format!("{}.json", ctx.file_prefix));

    // Extract screenshots from result and save them
    let screenshots = if let Ok(result_value) = result {
        extract_and_save_screenshots(&dir, &ctx.file_prefix, result_value)
    } else {
        None
    };

    // Build response, stripping screenshot base64 from result
    let clean_result = result.ok().map(strip_screenshot_base64);

    // Generate TypeScript snippet before moving ctx.request
    let ts_snippet = generate_typescript_snippet(&ctx.tool_name, &ctx.request, result);

    let log = ExecutionLog {
        timestamp: ctx.timestamp.to_rfc3339(),
        workflow_id: ctx.workflow_id,
        step_id: ctx.step_id,
        step_index: ctx.step_index,
        tool_name: ctx.tool_name.clone(),
        request: ctx.request,
        response: ExecutionResponse {
            status: if result.is_ok() {
                "executed_without_error"
            } else {
                "executed_with_error"
            }
            .to_string(),
            duration_ms,
            result: clean_result,
            error: result.err().map(String::from),
        },
        screenshots,
        logs: None,
    };

    // Write JSON
    match serde_json::to_string_pretty(&log) {
        Ok(json) => {
            if let Err(e) = fs::write(&json_path, json) {
                warn!(
                    "[execution_logger] Failed to write {}: {}",
                    json_path.display(),
                    e
                );
            } else {
                info!("[execution_logger] Logged: {}", json_path.display());
            }
        }
        Err(e) => {
            warn!("[execution_logger] Failed to serialize log: {}", e);
        }
    }

    // Write TypeScript snippet file
    let ts_path = dir.join(format!("{}.ts", ctx.file_prefix));
    if let Err(e) = fs::write(&ts_path, &ts_snippet) {
        warn!(
            "[execution_logger] Failed to write {}: {}",
            ts_path.display(),
            e
        );
    } else {
        debug!(
            "[execution_logger] TypeScript snippet: {}",
            ts_path.display()
        );
    }
}

/// Complete logging an execution with captured logs (call after tool dispatch)
/// Same as log_response but includes captured console logs
pub fn log_response_with_logs(
    ctx: ExecutionContext,
    result: Result<&Value, &str>,
    duration_ms: u64,
    logs: Option<Vec<CapturedLogEntry>>,
) {
    info!(
        "[execution_logger] log_response_with_logs called for tool: {}, workflow_id: {:?}, enabled: {}, logs: {:?}",
        ctx.tool_name,
        ctx.workflow_id,
        is_enabled(),
        logs.as_ref().map(|l| l.len())
    );
    if !is_enabled() {
        return;
    }

    // Use workflow-specific directory if workflow_id is available, otherwise use standalone dir
    let dir = match &ctx.workflow_id {
        Some(wf_id) => get_workflow_executions_dir(wf_id),
        None => get_executions_dir(),
    };

    // Ensure directory exists
    if let Err(e) = fs::create_dir_all(&dir) {
        error!(
            "[execution_logger] Failed to create executions dir {:?}: {}",
            dir, e
        );
        return;
    }

    let json_path = dir.join(format!("{}.json", ctx.file_prefix));

    // Extract screenshots from result and save them
    let screenshots = if let Ok(result_value) = result {
        extract_and_save_screenshots(&dir, &ctx.file_prefix, result_value)
    } else {
        None
    };

    // Build response, stripping screenshot base64 from result
    let clean_result = result.ok().map(strip_screenshot_base64);

    // Generate TypeScript snippet before moving ctx.request
    let ts_snippet = generate_typescript_snippet(&ctx.tool_name, &ctx.request, result);

    let log = ExecutionLog {
        timestamp: ctx.timestamp.to_rfc3339(),
        workflow_id: ctx.workflow_id,
        step_id: ctx.step_id,
        step_index: ctx.step_index,
        tool_name: ctx.tool_name.clone(),
        request: ctx.request,
        response: ExecutionResponse {
            status: if result.is_ok() {
                "executed_without_error"
            } else {
                "executed_with_error"
            }
            .to_string(),
            duration_ms,
            result: clean_result,
            error: result.err().map(String::from),
        },
        screenshots,
        logs,
    };

    // Write JSON
    match serde_json::to_string_pretty(&log) {
        Ok(json) => {
            if let Err(e) = fs::write(&json_path, json) {
                warn!(
                    "[execution_logger] Failed to write {}: {}",
                    json_path.display(),
                    e
                );
            } else {
                info!(
                    "[execution_logger] Logged with logs: {}",
                    json_path.display()
                );
            }
        }
        Err(e) => {
            warn!("[execution_logger] Failed to serialize log: {}", e);
        }
    }

    // Write TypeScript snippet file
    let ts_path = dir.join(format!("{}.ts", ctx.file_prefix));
    if let Err(e) = fs::write(&ts_path, &ts_snippet) {
        warn!(
            "[execution_logger] Failed to write {}: {}",
            ts_path.display(),
            e
        );
    } else {
        debug!(
            "[execution_logger] TypeScript snippet: {}",
            ts_path.display()
        );
    }
}

/// Extract screenshots from result and save as PNG files
/// Returns screenshot references for the JSON
fn extract_and_save_screenshots(
    dir: &std::path::Path,
    file_prefix: &str,
    result: &Value,
) -> Option<ScreenshotRefs> {
    let mut refs = ScreenshotRefs {
        before: None,
        after: Vec::new(),
    };
    let mut screenshot_counter = 0usize;

    // Look for screenshot in various locations in the result
    // Common patterns: result.screenshot, result.screenshot_before, result.screenshot_after
    // Also in content array: content[].screenshot, content[].image

    // Try direct screenshot field (usually "after" or single screenshot)
    if let Some(screenshot) =
        extract_base64_image(result, &["screenshot", "image", "screenshot_base64"])
    {
        let filename = format!("{}_after.png", file_prefix);
        if save_screenshot(dir, &filename, &screenshot) {
            refs.after.push(filename);
            screenshot_counter += 1;
        }
    }

    // Try screenshot_before
    if let Some(screenshot) =
        extract_base64_image(result, &["screenshot_before", "before_screenshot"])
    {
        let filename = format!("{}_before.png", file_prefix);
        if save_screenshot(dir, &filename, &screenshot) {
            refs.before = Some(filename);
        }
    }

    // Try screenshot_after (explicit) - only if no screenshots saved yet
    if refs.after.is_empty() {
        if let Some(screenshot) =
            extract_base64_image(result, &["screenshot_after", "after_screenshot"])
        {
            let filename = format!("{}_after.png", file_prefix);
            if save_screenshot(dir, &filename, &screenshot) {
                refs.after.push(filename);
                screenshot_counter += 1;
            }
        }
    }

    // Check in content array (MCP response format) - save ALL images
    // Handle both: result IS the array (from call_result.content serialization)
    // or result.content is the array (nested format)
    let content_array = result
        .as_array()
        .or_else(|| result.get("content").and_then(|c| c.as_array()));

    if let Some(content) = content_array {
        for item in content {
            // Image content type
            if item.get("type").and_then(|t| t.as_str()) == Some("image") {
                if let Some(data) = item.get("data").and_then(|d| d.as_str()) {
                    // Generate unique filename for each screenshot
                    let filename = if screenshot_counter == 0 {
                        format!("{}_after.png", file_prefix)
                    } else {
                        format!("{}_after_{}.png", file_prefix, screenshot_counter)
                    };
                    if save_screenshot(dir, &filename, data) {
                        refs.after.push(filename);
                        screenshot_counter += 1;
                    }
                }
            }
            // Text content with embedded screenshot
            if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                if let Ok(parsed) = serde_json::from_str::<Value>(text) {
                    if let Some(screenshot) =
                        extract_base64_image(&parsed, &["screenshot", "image"])
                    {
                        let filename = if screenshot_counter == 0 {
                            format!("{}_after.png", file_prefix)
                        } else {
                            format!("{}_after_{}.png", file_prefix, screenshot_counter)
                        };
                        if save_screenshot(dir, &filename, &screenshot) {
                            refs.after.push(filename);
                            screenshot_counter += 1;
                        }
                    }
                }
            }
        }
    }

    if refs.before.is_some() || !refs.after.is_empty() {
        Some(refs)
    } else {
        None
    }
}

/// Extract base64 image from value by trying multiple field names
fn extract_base64_image(value: &Value, field_names: &[&str]) -> Option<String> {
    for name in field_names {
        if let Some(img) = value.get(*name).and_then(|v| v.as_str()) {
            // Check if it looks like base64 image data (minimum ~80 chars for minimal 1x1 PNG)
            if img.len() >= 80
                && (img.starts_with("iVBOR") || img.starts_with("/9j/") || img.contains("base64,"))
            {
                // Strip data URL prefix if present
                let data = if let Some(pos) = img.find("base64,") {
                    &img[pos + 7..]
                } else {
                    img
                };
                return Some(data.to_string());
            }
        }
    }
    None
}

/// Save base64 screenshot as PNG file
fn save_screenshot(dir: &std::path::Path, filename: &str, base64_data: &str) -> bool {
    match BASE64.decode(base64_data.trim()) {
        Ok(bytes) => {
            let path = dir.join(filename);
            match fs::write(&path, bytes) {
                Ok(_) => {
                    info!("[execution_logger] Saved screenshot: {}", filename);
                    true
                }
                Err(e) => {
                    warn!(
                        "[execution_logger] Failed to save screenshot {}: {}",
                        filename, e
                    );
                    false
                }
            }
        }
        Err(e) => {
            warn!(
                "[execution_logger] Failed to decode screenshot base64: {}",
                e
            );
            false
        }
    }
}

/// Strip screenshot base64 data from result to keep JSON small
fn strip_screenshot_base64(value: &Value) -> Value {
    let mut result = value.clone();

    // Fields to strip
    let screenshot_fields = [
        "screenshot",
        "screenshot_base64",
        "screenshot_before",
        "screenshot_after",
        "before_screenshot",
        "after_screenshot",
        "image",
    ];

    if let Some(obj) = result.as_object_mut() {
        for field in &screenshot_fields {
            if obj.contains_key(*field) {
                obj.insert(
                    field.to_string(),
                    Value::String("[extracted to file]".to_string()),
                );
            }
        }
    }

    // Also strip from content array
    if let Some(content) = result.get_mut("content").and_then(|c| c.as_array_mut()) {
        for item in content.iter_mut() {
            if item.get("type").and_then(|t| t.as_str()) == Some("image") {
                if let Some(obj) = item.as_object_mut() {
                    obj.insert(
                        "data".to_string(),
                        Value::String("[extracted to file]".to_string()),
                    );
                }
            }
            // Handle text content with embedded JSON
            if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                if let Ok(mut parsed) = serde_json::from_str::<Value>(text) {
                    let mut modified = false;
                    if let Some(obj) = parsed.as_object_mut() {
                        for field in &screenshot_fields {
                            if obj.contains_key(*field) {
                                obj.insert(
                                    field.to_string(),
                                    Value::String("[extracted to file]".to_string()),
                                );
                                modified = true;
                            }
                        }
                    }
                    if modified {
                        if let Some(obj) = item.as_object_mut() {
                            if let Ok(new_text) = serde_json::to_string(&parsed) {
                                obj.insert("text".to_string(), Value::String(new_text));
                            }
                        }
                    }
                }
            }
        }
    }

    result
}

/// Generate TypeScript SDK snippet from MCP tool call
/// This creates a .ts file alongside the .json execution log
/// Generate TypeScript SDK snippet from MCP tool call.
/// This is the single source of truth for tool -> TypeScript conversion.
pub fn generate_typescript_snippet(
    tool_name: &str,
    args: &Value,
    result: Result<&Value, &str>,
) -> String {
    // Clean tool name (remove mcp__ prefix if present)
    let clean_tool = tool_name
        .strip_prefix("mcp__computeruse-mcp-agent__")
        .unwrap_or(tool_name);

    // Extract delay_ms (step-level metadata, not a tool arg)
    let delay_ms = args.get("delay_ms").and_then(|v| v.as_u64()).unwrap_or(0);

    let mut snippet = match clean_tool {
        "click_element" => generate_click_snippet(args),
        "type_into_element" => generate_type_snippet(args),
        "press_key" => generate_press_key_snippet(args),
        "global_key" | "press_key_global" => generate_global_key_snippet(args),
        "delay" => generate_delay_snippet(args),
        "open_application" => generate_open_application_snippet(args),
        "navigate_browser" => generate_navigate_browser_snippet(args),
        "get_window_tree" => generate_get_window_tree_snippet(args),
        "capture_screenshot" => generate_capture_screenshot_snippet(args),
        "run_command" => generate_run_command_snippet(args),
        "mouse_drag" => generate_mouse_drag_snippet(args),
        "scroll_element" => generate_scroll_snippet(args),
        "wait_for_element" => generate_wait_for_element_snippet(args),
        "select_option" => generate_select_option_snippet(args),
        "set_value" => generate_set_value_snippet(args),
        "highlight_element" => generate_highlight_snippet(args),
        "validate_element" => generate_validate_snippet(args),
        "invoke_element" => generate_invoke_snippet(args),
        "set_selected" => generate_set_selected_snippet(args),
        "activate_element" => generate_activate_snippet(args),
        "close_element" => generate_close_snippet(args),
        "get_applications" | "get_applications_and_windows_list" => {
            "const apps = desktop.getApplications();".to_string()
        }
        "execute_browser_script" => generate_execute_browser_script_snippet(args),
        "stop_highlighting" => generate_stop_highlighting_snippet(args),
        "stop_execution" => "desktop.stopExecution();".to_string(),
        "gemini_computer_use" => generate_gemini_computer_use_snippet(args),
        _ => {
            // Comment out ALL lines of the JSON to avoid syntax errors
            let args_json = serde_json::to_string_pretty(args).unwrap_or_default();
            let commented_args = args_json
                .lines()
                .map(|line| format!("//   {}", line))
                .collect::<Vec<_>>()
                .join("\n");
            format!(
                "// Unsupported tool: {}\n// Args:\n{}",
                clean_tool, commented_args
            )
        }
    };

    // Add verification code for action tools (skip for read-only tools)
    let action_tools = [
        "click_element",
        "type_into_element",
        "press_key",
        "press_key_global",
        "scroll_element",
        "select_option",
        "set_value",
        "set_selected",
        "invoke_element",
        "activate_element",
        "navigate_browser",
        "open_application",
    ];
    if action_tools.contains(&clean_tool) {
        let verification_code = generate_verification_code(args);
        if !verification_code.is_empty() {
            snippet.push_str(&verification_code);
        }
    }

    // Wrap in retry loop if retries is specified
    if let Some(retries) = args.get("retries").and_then(|v| v.as_u64()) {
        if retries > 0 {
            let indented_snippet = snippet
                .lines()
                .map(|line| format!("    {}", line))
                .collect::<Vec<_>>()
                .join("\n");
            snippet = format!(
                r#"// Retry up to {} times on failure
for (let attempt = 0; attempt <= {}; attempt++) {{
  try {{
{}
    break; // Success, exit retry loop
  }} catch (error) {{
    if (attempt === {}) throw error; // Last attempt, rethrow
    console.log(`Attempt ${{attempt + 1}} failed, retrying...`);
    await sleep(500); // Brief delay before retry
  }}
}}"#,
                retries, retries, indented_snippet, retries
            );
        }
    }

    // Add delay if specified - must come BEFORE any "return __stepResult;"
    if delay_ms > 0 {
        let sleep_code = format!("await sleep({});", delay_ms);
        if snippet.trim_end().ends_with("return __stepResult;") {
            // Insert sleep before the return statement
            if let Some(pos) = snippet.rfind("return __stepResult;") {
                snippet.insert_str(pos, &format!("{}\n", sleep_code));
            }
        } else {
            // Append sleep at the end
            snippet.push_str(&format!("\n{}", sleep_code));
        }
    }

    // Output raw snippet only (desktop is pre-injected in engine mode)
    let status_comment = match result {
        Ok(_) => "// Status: SUCCESS",
        Err(e) => return format!("// Status: ERROR - {}\n{}", e, snippet),
    };

    format!("{}\n{}\n", status_comment, snippet)
}

/// Build locator string from args
fn build_locator_string(args: &Value) -> String {
    let process = args.get("process").and_then(|v| v.as_str()).unwrap_or("");
    let selector = args.get("selector").and_then(|v| v.as_str()).unwrap_or("");
    let window_selector = args.get("window_selector").and_then(|v| v.as_str());

    if process.is_empty() && selector.is_empty() {
        return "\"\"".to_string();
    }

    let mut locator = format!("process:{}", process);

    if let Some(ws) = window_selector {
        if !ws.is_empty() {
            locator = format!("{} >> {}", locator, ws);
        }
    }

    if !selector.is_empty() {
        locator = format!("{} >> {}", locator, selector);
    }

    format!("\"{}\"", locator)
}

/// Build locator string for fallback selector (uses same process/window_selector but different element selector)
fn build_fallback_locator_string(args: &Value, fallback_selector: &str) -> String {
    let process = args.get("process").and_then(|v| v.as_str()).unwrap_or("");
    let window_selector = args.get("window_selector").and_then(|v| v.as_str());

    if process.is_empty() && fallback_selector.is_empty() {
        return "\"\"".to_string();
    }

    let mut locator = format!("process:{}", process);

    if let Some(ws) = window_selector {
        if !ws.is_empty() {
            locator = format!("{} >> {}", locator, ws);
        }
    }

    if !fallback_selector.is_empty() {
        // Convert MCP fallback selector format (pipe-separated) to SDK format (&&)
        // e.g., "role:Button|name:Log On" -> "role:Button && name:Log On"
        let sdk_selector = fallback_selector.replace('|', " && ");
        locator = format!("{} >> {}", locator, sdk_selector);
    }

    format!("\"{}\"", locator)
}

/// Generate verification code if verify_element_exists or verify_element_not_exists is specified
fn generate_verification_code(args: &Value) -> String {
    let mut verification_code = String::new();

    let verify_exists = args
        .get("verify_element_exists")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let verify_not_exists = args
        .get("verify_element_not_exists")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let verify_timeout = args
        .get("verify_timeout_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(2000);

    // Get process from various sources (process, browser for navigate_browser, app_name for open_application)
    let process = args
        .get("process")
        .or_else(|| args.get("browser"))
        .or_else(|| args.get("app_name"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    // Build locator - if process is empty, just use the selector directly
    let build_locator = |selector: &str| -> String {
        if process.is_empty() {
            format!("\"{}\"", selector)
        } else {
            format!("\"process:{} >> {}\"", process, selector)
        }
    };

    if !verify_exists.is_empty() {
        verification_code.push_str(&format!(
            "\n// Verify element exists after action\nawait desktop.locator({}).waitFor({{ timeout: {} }});",
            build_locator(verify_exists), verify_timeout
        ));
    }

    if !verify_not_exists.is_empty() {
        verification_code.push_str(&format!(
            "\n// Verify element does NOT exist after action\nawait desktop.locator({}).waitFor({{ state: \"hidden\", timeout: {} }});",
            build_locator(verify_not_exists), verify_timeout
        ));
    }

    verification_code
}

/// Build ActionOptions object from MCP params (maps to SDK camelCase)
fn build_action_options(args: &Value) -> String {
    let mut opts = Vec::new();

    // highlightBeforeAction
    if let Some(true) = args
        .get("highlight_before_action")
        .and_then(|v| v.as_bool())
    {
        opts.push("highlightBeforeAction: true".to_string());
    }

    // clickPosition
    if let Some(pos) = args.get("click_position") {
        let x = pos.get("x_percentage").and_then(|v| v.as_u64());
        let y = pos.get("y_percentage").and_then(|v| v.as_u64());
        if let (Some(x), Some(y)) = (x, y) {
            if x != 50 || y != 50 {
                opts.push(format!(
                    "clickPosition: {{ xPercentage: {}, yPercentage: {} }}",
                    x, y
                ));
            }
        }
    }

    // clickType (only if not default "left")
    if let Some(ct) = args.get("click_type").and_then(|v| v.as_str()) {
        if ct != "left" {
            let sdk_type = match ct {
                "double" => "Double",
                "right" => "Right",
                _ => "Left",
            };
            opts.push(format!("clickType: \"{}\"", sdk_type));
        }
    }

    // uiDiffBeforeAfter
    if let Some(true) = args.get("ui_diff_before_after").and_then(|v| v.as_bool()) {
        opts.push("uiDiffBeforeAfter: true".to_string());
    }

    if opts.is_empty() {
        String::new()
    } else {
        format!("{{ {} }}", opts.join(", "))
    }
}

/// Build ClickOptions object from MCP params (extends ActionOptions with restore_cursor)
fn build_click_options(args: &Value, restore_cursor: bool) -> String {
    let mut opts = Vec::new();

    // highlightBeforeAction
    if let Some(true) = args
        .get("highlight_before_action")
        .and_then(|v| v.as_bool())
    {
        opts.push("highlightBeforeAction: true".to_string());
    }

    // clickPosition
    if let Some(pos) = args.get("click_position") {
        let x = pos.get("x_percentage").and_then(|v| v.as_u64());
        let y = pos.get("y_percentage").and_then(|v| v.as_u64());
        if let (Some(x), Some(y)) = (x, y) {
            if x != 50 || y != 50 {
                opts.push(format!(
                    "clickPosition: {{ xPercentage: {}, yPercentage: {} }}",
                    x, y
                ));
            }
        }
    }

    // clickType (only if not default "left")
    if let Some(ct) = args.get("click_type").and_then(|v| v.as_str()) {
        if ct != "left" {
            let sdk_type = match ct {
                "double" => "Double",
                "right" => "Right",
                _ => "Left",
            };
            opts.push(format!("clickType: \"{}\"", sdk_type));
        }
    }

    // uiDiffBeforeAfter
    if let Some(true) = args.get("ui_diff_before_after").and_then(|v| v.as_bool()) {
        opts.push("uiDiffBeforeAfter: true".to_string());
    }

    // restoreCursor (default true, only include if false)
    if !restore_cursor {
        opts.push("restoreCursor: false".to_string());
    }

    if opts.is_empty() {
        String::new()
    } else {
        format!("{{ {} }}", opts.join(", "))
    }
}

/// Build TypeTextOptions object from MCP params
fn build_type_text_options(args: &Value, clear_before_typing: bool) -> String {
    let mut opts = vec![format!("clearBeforeTyping: {}", clear_before_typing)];

    // highlightBeforeAction
    if let Some(true) = args
        .get("highlight_before_action")
        .and_then(|v| v.as_bool())
    {
        opts.push("highlightBeforeAction: true".to_string());
    }

    // tryFocusBefore (default true, only include if false)
    if let Some(false) = args.get("try_focus_before").and_then(|v| v.as_bool()) {
        opts.push("tryFocusBefore: false".to_string());
    }

    // tryClickBefore (default true, only include if false)
    if let Some(false) = args.get("try_click_before").and_then(|v| v.as_bool()) {
        opts.push("tryClickBefore: false".to_string());
    }

    // restoreFocus (default false, only include if true)
    if let Some(true) = args.get("restore_focus").and_then(|v| v.as_bool()) {
        opts.push("restoreFocus: true".to_string());
    }

    // uiDiffBeforeAfter
    if let Some(true) = args.get("ui_diff_before_after").and_then(|v| v.as_bool()) {
        opts.push("uiDiffBeforeAfter: true".to_string());
    }

    format!("{{ {} }}", opts.join(", "))
}

/// Generate click_element snippet
fn generate_click_snippet(args: &Value) -> String {
    // Check mode: selector, index, or coordinates
    if let (Some(x), Some(y)) = (
        args.get("x").and_then(|v| v.as_f64()),
        args.get("y").and_then(|v| v.as_f64()),
    ) {
        // Coordinate mode
        let click_type = args
            .get("click_type")
            .and_then(|v| v.as_str())
            .unwrap_or("left");
        return match click_type {
            "double" => format!("await desktop.doubleClick({}, {});", x as i32, y as i32),
            "right" => format!("await desktop.rightClick({}, {});", x as i32, y as i32),
            _ => format!("await desktop.click({}, {});", x as i32, y as i32),
        };
    }

    if let Some(index) = args.get("index").and_then(|v| v.as_u64()) {
        // Index mode (from get_window_tree)
        let vision_type = args
            .get("vision_type")
            .and_then(|v| v.as_str())
            .unwrap_or("ui_tree");
        let process = args.get("process").and_then(|v| v.as_str()).unwrap_or("");
        let click_type = args
            .get("click_type")
            .and_then(|v| v.as_str())
            .unwrap_or("left");

        // Map vision_type to SDK method
        let (tree_method, click_method) = match vision_type {
            "ocr" => ("getOcrTree", "clickOcrItem"),
            "omniparser" => ("getOmniparserTree", "clickOmniparserItem"),
            "gemini" | "vision" => ("getVisionTree", "clickVisionItem"),
            "dom" => ("getBrowserDom", "clickDomItem"),
            _ => ("getWindowTree", "clickTreeItem"),
        };

        let click_opts = match click_type {
            "double" => ", { clickType: \"Double\" }",
            "right" => ", { clickType: \"Right\" }",
            _ => "",
        };

        return format!(
            "// Index-based click using {} tree\nconst tree = await desktop.{}(\"{}\");\nawait desktop.{}(tree, {}{}); // item #{}",
            vision_type, tree_method, process, click_method, index, click_opts, index
        );
    }

    // Selector mode
    let locator = build_locator_string(args);
    let timeout = args
        .get("timeout_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(5000);
    let restore_cursor = args
        .get("restore_cursor")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    // Build ActionOptions from MCP params
    let options = build_click_options(args, restore_cursor);

    // Check for alternative_selectors - generate Promise.race if present
    if let Some(alternatives) = args.get("alternative_selectors").and_then(|v| v.as_str()) {
        if !alternatives.is_empty() {
            let process = args.get("process").and_then(|v| v.as_str()).unwrap_or("");
            let alt_selectors: Vec<&str> = alternatives.split(',').map(|s| s.trim()).collect();
            let mut race_parts = vec![format!("desktop.locator({}).first({})", locator, timeout)];
            for alt in alt_selectors {
                if !alt.is_empty() {
                    race_parts.push(format!(
                        "desktop.locator(\"process:{} >> {}\").first({})",
                        process, alt, timeout
                    ));
                }
            }
            return format!(
                "// Racing {} selectors in parallel\nconst element = await Promise.race([\n  {}\n]);\nawait element.click({});",
                race_parts.len(),
                race_parts.join(",\n  "),
                options
            );
        }
    }

    // Check for fallback_selectors - generate try/catch if present
    if let Some(fallback) = args.get("fallback_selectors").and_then(|v| v.as_str()) {
        if !fallback.is_empty() {
            let fallback_locator = build_fallback_locator_string(args, fallback);
            return format!(
                r#"let element;
try {{
  element = await desktop.locator({}).first({});
}} catch (e) {{
  // Primary selector failed, trying fallback: {}
  element = await desktop.locator({}).first({});
}}
await element.click({});"#,
                locator, timeout, fallback, fallback_locator, timeout, options
            );
        }
    }

    format!(
        "const element = await desktop.locator({}).first({});\nawait element.click({});",
        locator, timeout, options
    )
}

/// Format text for TypeScript, handling variable references
/// - Pure variable like `${input.xxx}` -> `input.xxx` (no quotes)
/// - Mixed content like `Hello ${input.name}!` -> `` `Hello ${input.name}!` `` (template literal)
/// - Plain text -> `"plain text"` (double quotes)
fn format_text_for_typescript(text: &str) -> String {
    // Check if it's a pure variable reference like ${input.xxx} or ${context.xxx}
    let pure_var_regex =
        regex::Regex::new(r"^\$\{([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\}$")
            .unwrap();
    if let Some(caps) = pure_var_regex.captures(text) {
        // Pure variable reference - return without quotes
        return caps.get(1).unwrap().as_str().to_string();
    }

    // Check if text contains any variable references
    let has_vars = text.contains("${");

    if has_vars {
        // Mixed content - use template literal (backticks)
        // Escape backticks in the content
        let escaped = text.replace('\\', "\\\\").replace('`', "\\`");
        format!("`{}`", escaped)
    } else {
        // Plain text - use double quotes
        let escaped = text
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n");
        format!("\"{}\"", escaped)
    }
}

/// Generate type_into_element snippet
fn generate_type_snippet(args: &Value) -> String {
    let locator = build_locator_string(args);
    // MCP uses text_to_type, SDK uses text
    let text = args
        .get("text_to_type")
        .or_else(|| args.get("text"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let clear = args
        .get("clear_before_typing")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let timeout = args
        .get("timeout_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(5000);

    // Format text with proper variable handling
    let formatted_text = format_text_for_typescript(text);

    // Build TypeTextOptions
    let options = build_type_text_options(args, clear);

    format!(
        "const element = await desktop.locator({}).first({});\nawait element.typeText({}, {});",
        locator, timeout, formatted_text, options
    )
}

/// Generate press_key snippet
fn generate_press_key_snippet(args: &Value) -> String {
    let locator = build_locator_string(args);
    let key = args.get("key").and_then(|v| v.as_str()).unwrap_or("");
    let timeout = args
        .get("timeout_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(5000);

    // Build options including action options and press_key specific options
    let mut opts = Vec::new();

    // Action options
    if let Some(true) = args
        .get("highlight_before_action")
        .and_then(|v| v.as_bool())
    {
        opts.push("highlightBeforeAction: true".to_string());
    }
    if let Some(true) = args.get("ui_diff_before_after").and_then(|v| v.as_bool()) {
        opts.push("uiDiffBeforeAfter: true".to_string());
    }

    // Press key specific options (default true, only include if false)
    if let Some(false) = args.get("try_focus_before").and_then(|v| v.as_bool()) {
        opts.push("tryFocusBefore: false".to_string());
    }
    if let Some(false) = args.get("try_click_before").and_then(|v| v.as_bool()) {
        opts.push("tryClickBefore: false".to_string());
    }

    let options = if opts.is_empty() {
        String::new()
    } else {
        format!("{{ {} }}", opts.join(", "))
    };

    format!(
        "const element = await desktop.locator({}).first({});\nawait element.pressKey(\"{}\"{});",
        locator,
        timeout,
        key,
        if options.is_empty() {
            String::new()
        } else {
            format!(", {}", options)
        }
    )
}

/// Generate global_key snippet (no element needed)
fn generate_global_key_snippet(args: &Value) -> String {
    let key = args.get("key").and_then(|v| v.as_str()).unwrap_or("");
    format!("await desktop.pressKey(\"{}\");", key)
}

/// Generate delay snippet
fn generate_delay_snippet(args: &Value) -> String {
    // MCP uses delay_ms, fallback to ms for compatibility
    let ms = args
        .get("delay_ms")
        .or_else(|| args.get("ms"))
        .and_then(|v| v.as_u64())
        .unwrap_or(1000);
    format!("await desktop.delay({});", ms)
}

/// Generate open_application snippet
fn generate_open_application_snippet(args: &Value) -> String {
    let name = args.get("app_name").and_then(|v| v.as_str()).unwrap_or("");
    format!("desktop.openApplication(\"{}\");", name)
}

/// Generate navigate_browser snippet
fn generate_navigate_browser_snippet(args: &Value) -> String {
    let url = args.get("url").and_then(|v| v.as_str()).unwrap_or("");
    let browser = args
        .get("browser")
        .or_else(|| args.get("process"))
        .and_then(|v| v.as_str());

    if let Some(b) = browser {
        format!("await desktop.navigateBrowser(\"{}\", \"{}\");", url, b)
    } else {
        format!("await desktop.navigateBrowser(\"{}\");", url)
    }
}

/// Generate get_window_tree snippet
fn generate_get_window_tree_snippet(args: &Value) -> String {
    let process = args.get("process").and_then(|v| v.as_str()).unwrap_or("");
    let title = args.get("title").and_then(|v| v.as_str());
    let include_gemini = args
        .get("include_gemini_vision")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let include_omniparser = args
        .get("include_omniparser")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let include_ocr = args
        .get("include_ocr")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let include_browser_dom = args
        .get("include_browser_dom")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let tree_output_format = args.get("tree_output_format").and_then(|v| v.as_str());
    let tree_max_depth = args.get("tree_max_depth").and_then(|v| v.as_u64());
    let tree_from_selector = args.get("tree_from_selector").and_then(|v| v.as_str());
    let include_detailed_attributes = args
        .get("include_detailed_attributes")
        .and_then(|v| v.as_bool());
    let show_overlay = args.get("show_overlay").and_then(|v| v.as_str());
    let browser_dom_max_elements = args
        .get("browser_dom_max_elements")
        .and_then(|v| v.as_u64());

    // Build config options
    let mut config_parts = vec!["propertyMode: \"Fast\"".to_string()];

    if include_gemini {
        config_parts.push("includeGeminiVision: true".to_string());
    }
    if include_omniparser {
        config_parts.push("includeOmniparser: true".to_string());
    }
    if include_ocr {
        config_parts.push("includeOcr: true".to_string());
    }
    if include_browser_dom {
        config_parts.push("includeBrowserDom: true".to_string());
    }
    if let Some(format) = tree_output_format {
        let format_value = match format {
            "clustered_yaml" => "\"ClusteredYaml\"",
            "verbose_json" => "\"VerboseJson\"",
            _ => "\"CompactYaml\"",
        };
        config_parts.push(format!("treeOutputFormat: {}", format_value));
    }
    if let Some(depth) = tree_max_depth {
        config_parts.push(format!("maxDepth: {}", depth));
    }
    if let Some(selector) = tree_from_selector {
        if !selector.is_empty() {
            config_parts.push(format!("treeFromSelector: \"{}\"", selector));
        }
    }
    if let Some(detailed) = include_detailed_attributes {
        config_parts.push(format!("includeDetailedAttributes: {}", detailed));
    }
    if let Some(overlay) = show_overlay {
        if !overlay.is_empty() {
            config_parts.push(format!("showOverlay: \"{}\"", overlay));
        }
    }
    if let Some(max_elements) = browser_dom_max_elements {
        config_parts.push(format!("browserDomMaxElements: {}", max_elements));
    }

    let config = format!("{{ {} }}", config_parts.join(", "));

    // Build title filter if specified
    let title_arg = title
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{}\"", t))
        .unwrap_or_else(|| "null".to_string());

    // Use async method when vision options are present
    if include_gemini || include_omniparser || include_ocr || include_browser_dom {
        format!(
            "const result = await desktop.getWindowTreeResultAsync(\"{}\", {}, {});\nconsole.log(result.formatted);",
            process, title_arg, config
        )
    } else {
        format!(
            "const result = desktop.getWindowTreeResult(\"{}\", {}, {});\nconsole.log(result.formatted);",
            process, title_arg, config
        )
    }
}

/// Generate capture_screenshot snippet
fn generate_capture_screenshot_snippet(args: &Value) -> String {
    let process = args.get("process").and_then(|v| v.as_str()).unwrap_or("");
    let selector = args.get("selector").and_then(|v| v.as_str());
    let window_selector = args.get("window_selector").and_then(|v| v.as_str());
    let entire_monitor = args
        .get("entire_monitor")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let timeout = args
        .get("timeout_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(5000);

    if let Some(sel) = selector {
        if !sel.is_empty() {
            // Element screenshot via locator
            let locator = build_locator_string(args);
            return format!(
                "const element = await desktop.locator({}).first({});\nconst screenshot = element.capture();",
                locator, timeout
            );
        }
    }

    // Build window selector arg if specified
    let window_arg = window_selector
        .filter(|ws| !ws.is_empty())
        .map(|ws| format!("\"{}\"", ws))
        .unwrap_or_else(|| "null".to_string());

    // Window or monitor screenshot via desktop method
    if entire_monitor {
        format!(
            "const screenshot = await desktop.captureScreenshot(\"{}\", {}, true, {});",
            process, window_arg, timeout
        )
    } else {
        format!(
            "const screenshot = await desktop.captureScreenshot(\"{}\", {}, false, {});",
            process, window_arg, timeout
        )
    }
}

/// Transform YAML engine JavaScript to TypeScript SDK API.
/// The YAML execution engine had different globals/APIs than the TypeScript SDK.
fn transform_yaml_js_to_sdk(code: &str) -> String {
    let mut transformed = code.to_string();

    // 1. log() -> console.log() (YAML engine had global log function)
    // Simple string replacement - replace standalone "log(" but not ".log(" or "console.log("
    // First, temporarily replace known patterns we want to preserve
    transformed = transformed.replace("console.log(", "__CONSOLE_LOG__");
    transformed = transformed.replace(".log(", "__DOT_LOG__");
    // Now replace standalone log(
    transformed = transformed.replace("log(", "console.log(");
    // Restore preserved patterns
    transformed = transformed.replace("__CONSOLE_LOG__", "console.log(");
    transformed = transformed.replace("__DOT_LOG__", ".log(");

    // 2. .value() -> .getValue() (Element API difference)
    transformed = transformed.replace(".value()", ".getValue()");

    // 3. .press_key( -> .pressKey( (snake_case to camelCase)
    transformed = transformed.replace(".press_key(", ".pressKey(");

    // 4. tar -xf -> PowerShell Expand-Archive for Windows compatibility
    // Use regex to handle whitespace variations in the source code
    if transformed.contains("tar -xf") && transformed.contains("execSync") {
        // Match: execSync(`tar -xf "${zipPath}" -C "${destDir}"`, { ... });
        // The pattern handles varying whitespace and optional trailing semicolon
        let tar_pattern = regex::Regex::new(
            r#"execSync\s*\(\s*`tar\s+-xf\s+"?\$\{zipPath\}"?\s+-C\s+"?\$\{destDir\}"?\s*`\s*,\s*\{\s*stdio:\s*['"]inherit['"]\s*,\s*windowsHide:\s*true\s*\}\s*\)"#
        ).unwrap();

        if tar_pattern.is_match(&transformed) {
            // Note: $$ in replacement produces literal $ (escaping for regex)
            transformed = tar_pattern.replace(
                &transformed,
                r#"execSync(`powershell -NoProfile -Command "Expand-Archive -Path '$${zipPath}' -DestinationPath '$${destDir}' -Force"`, { stdio: 'inherit', windowsHide: true })"#
            ).to_string();
        }
    }

    // 5. YAML runtime -> TypeScript SDK variable access transformations
    // YAML runtime injects `env` and stores step results in `outputs.{step_id}_result`
    // TypeScript SDK uses `context.state` for all shared state between steps

    // 5a. typeof env/outputs checks -> true (context always exists in SDK)
    // Must do this BEFORE replacing env/outputs to avoid partial replacements
    // Handle: typeof env !== 'undefined', typeof env != 'undefined'
    if let Ok(typeof_env) = regex::Regex::new(r#"typeof\s+env\s*!==?\s*['"]undefined['"]"#) {
        transformed = typeof_env.replace_all(&transformed, "true").to_string();
    }
    if let Ok(typeof_outputs) = regex::Regex::new(r#"typeof\s+outputs\s*!==?\s*['"]undefined['"]"#)
    {
        transformed = typeof_outputs.replace_all(&transformed, "true").to_string();
    }
    // Handle nested checks: typeof env.xxx !== 'undefined'
    if let Ok(typeof_env_prop) =
        regex::Regex::new(r#"typeof\s+env\.(\w+)\s*!==?\s*['"]undefined['"]"#)
    {
        transformed = typeof_env_prop
            .replace_all(&transformed, "context.state.$1 !== undefined")
            .to_string();
    }
    if let Ok(typeof_outputs_prop) =
        regex::Regex::new(r#"typeof\s+outputs\.(\w+)_result\s*!==?\s*['"]undefined['"]"#)
    {
        transformed = typeof_outputs_prop
            .replace_all(&transformed, "context.state.$1 !== undefined")
            .to_string();
    }
    if let Ok(typeof_outputs_prop2) =
        regex::Regex::new(r#"typeof\s+outputs\.(\w+)\s*!==?\s*['"]undefined['"]"#)
    {
        transformed = typeof_outputs_prop2
            .replace_all(&transformed, "context.state.$1 !== undefined")
            .to_string();
    }

    // 5b. outputs.step_id_result -> context.state.step_id (strip _result suffix)
    // Must do this BEFORE the generic outputs.xxx pattern
    if let Ok(outputs_result) = regex::Regex::new(r"\boutputs\.(\w+)_result\b") {
        transformed = outputs_result
            .replace_all(&transformed, "context.state.$1")
            .to_string();
    }

    // 5c. outputs.step_id -> context.state.step_id (without _result suffix)
    if let Ok(outputs) = regex::Regex::new(r"\boutputs\.(\w+)") {
        transformed = outputs
            .replace_all(&transformed, "context.state.$1")
            .to_string();
    }

    // 5d. env.xxx -> context.state.xxx
    // Handle: env.loop_index, env.current_record, etc.
    if let Ok(env) = regex::Regex::new(r"\benv\.(\w+)") {
        transformed = env
            .replace_all(&transformed, "context.state.$1")
            .to_string();
    }

    // 6. Transform ::set-env patterns to proper state returns
    // YAML runtime used: console.log('::set-env name=X::' + value)
    // SDK needs: return { state: { X: value } }
    transformed = transform_set_env_to_state_return(transformed);

    // Debug log to confirm transformations applied
    if transformed.contains("context.state.") {
        tracing::debug!(
            "[transform_yaml_js_to_sdk] Applied env/outputs -> context.state transformations"
        );
    }

    transformed
}

/// Transform console.log('::set-env name=X::' + value) patterns to state returns
/// Collects all set-env variables and merges them into a single return { state: {...} }
fn transform_set_env_to_state_return(code: String) -> String {
    let mut cleaned = code.clone();
    let mut state_vars: Vec<(String, String)> = Vec::new();

    // Pattern 1: console.log('::set-env name=X::' + VALUE) or with JSON.stringify
    if let Ok(pattern1) = regex::Regex::new(
        r#"console\.log\s*\(\s*['"]::set-env name=(\w+)::['"]\s*\+\s*(?:JSON\.stringify\s*\(\s*)?([^);\n]+?)(?:\s*\))?\s*\)\s*;?"#,
    ) {
        for cap in pattern1.captures_iter(&code) {
            let var_name = cap
                .get(1)
                .map(|m| m.as_str().to_string())
                .unwrap_or_default();
            let var_value = cap
                .get(2)
                .map(|m| m.as_str().trim().to_string())
                .unwrap_or_default();
            if !var_name.is_empty() && !var_value.is_empty() {
                state_vars.push((var_name, var_value));
            }
        }
        cleaned = pattern1.replace_all(&cleaned, "").to_string();
    }

    // Pattern 2: console.log('::set-env name=X::LITERAL') - literal value in same string
    // e.g., console.log('::set-env name=current_record::{}')
    if let Ok(pattern2) =
        regex::Regex::new(r#"console\.log\s*\(\s*['"]::set-env name=(\w+)::([^'"]*)['"]\s*\)\s*;?"#)
    {
        for cap in pattern2.captures_iter(&cleaned) {
            let var_name = cap
                .get(1)
                .map(|m| m.as_str().to_string())
                .unwrap_or_default();
            let var_value = cap
                .get(2)
                .map(|m| m.as_str().trim().to_string())
                .unwrap_or_default();
            if !var_name.is_empty() {
                // Literal values like {} need to be valid JS
                let js_value = if var_value.is_empty() || var_value == "{}" {
                    "{}".to_string()
                } else {
                    format!("\"{}\"", var_value) // wrap as string literal
                };
                // Only add if not already captured by pattern 1
                if !state_vars.iter().any(|(n, _)| n == &var_name) {
                    state_vars.push((var_name, js_value));
                }
            }
        }
        cleaned = pattern2.replace_all(&cleaned, "").to_string();
    }

    if state_vars.is_empty() {
        return code;
    }

    // Clean up empty lines left behind
    let empty_lines = regex::Regex::new(r"\n\s*\n\s*\n").unwrap();
    cleaned = empty_lines.replace_all(&cleaned, "\n\n").to_string();

    // Check if there's already a return { state: ... } statement
    let has_state_return = cleaned.contains("return { state:")
        || cleaned.contains("return {state:")
        || cleaned.contains("return {\n") && cleaned.contains("state:");

    if has_state_return {
        // Merge set-env vars into existing return statement
        // Find: return { state: { ... } } and add our vars
        if let Ok(return_pattern) = regex::Regex::new(r"return\s*\{\s*state:\s*\{([^}]*)\}\s*\}") {
            if let Some(cap) = return_pattern.captures(&cleaned) {
                let existing_state = cap.get(1).map(|m| m.as_str()).unwrap_or("");
                let mut all_vars: Vec<String> = Vec::new();

                // Add set-env vars first
                for (name, value) in &state_vars {
                    all_vars.push(format!("{}: {}", name, value));
                }

                // Add existing vars (if any)
                let existing_trimmed = existing_state.trim();
                if !existing_trimmed.is_empty() {
                    // Check if existing vars conflict with set-env vars
                    let set_env_names: std::collections::HashSet<_> =
                        state_vars.iter().map(|(n, _)| n.as_str()).collect();
                    for part in existing_trimmed.split(',') {
                        let part = part.trim();
                        if part.is_empty() {
                            continue;
                        }
                        // Extract var name (before : or just the name if shorthand)
                        let var_name = part.split(':').next().unwrap_or("").trim();
                        if !set_env_names.contains(var_name) {
                            all_vars.push(part.to_string());
                        }
                    }
                }

                let new_state = all_vars.join(", ");
                let replacement = format!("return {{ state: {{ {} }} }}", new_state);
                cleaned = return_pattern
                    .replace(&cleaned, replacement.as_str())
                    .to_string();
            }
        }
    } else {
        // No existing state return - check if there's any return statement
        let has_return = cleaned.contains("return ");

        if !has_return {
            // Add return statement at end (before closing brace if in try block)
            let state_obj = state_vars
                .iter()
                .map(|(n, v)| format!("{}: {}", n, v))
                .collect::<Vec<_>>()
                .join(", ");

            // Find the right place to insert - before the last } or at the end
            if let Some(last_brace) = cleaned.rfind('}') {
                let before = &cleaned[..last_brace];
                let after = &cleaned[last_brace..];
                cleaned = format!(
                    "{}\n    return {{ state: {{ {} }} }};\n{}",
                    before.trim_end(),
                    state_obj,
                    after
                );
            } else {
                cleaned = format!("{}\nreturn {{ state: {{ {} }} }};", cleaned, state_obj);
            }
        }
    }

    cleaned
}

/// Detect if code looks like shell/PowerShell rather than JavaScript
fn looks_like_shell_code(code: &str) -> bool {
    let trimmed = code.trim();

    // PowerShell patterns
    if trimmed.contains("$env:")
        || trimmed.contains("Get-")
        || trimmed.contains("Set-")
        || trimmed.contains("New-")
        || trimmed.contains("Remove-")
        || trimmed.contains("Write-")
        || trimmed.contains("Invoke-")
        || trimmed.contains("Select-")
        || trimmed.contains("Where-")
        || trimmed.contains("ForEach-")
    {
        return true;
    }

    // PowerShell variable assignment at start of line (not JS destructuring)
    // $var = "value" but not ${ or $(
    for line in trimmed.lines() {
        let line = line.trim();
        if line.starts_with('$')
            && !line.starts_with("${")
            && !line.starts_with("$(")
            && (line.contains(" = ") || line.contains('='))
        {
            return true;
        }
    }

    // Bash/shell patterns
    if trimmed.starts_with("#!/")
        || trimmed.starts_with("export ")
        || trimmed.starts_with("source ")
        || trimmed.contains(" && ")
        || trimmed.contains(" || ")
    {
        return true;
    }

    false
}

/// Detect if code looks like JavaScript/TypeScript (to avoid misclassifying as shell)
fn looks_like_javascript_code(code: &str) -> bool {
    let trimmed = code.trim();

    // Strong JavaScript indicators
    trimmed.contains("const ")
        || trimmed.contains("let ")
        || trimmed.contains("var ")
        || trimmed.contains("function ")
        || trimmed.contains("async ")
        || trimmed.contains("await ")
        || trimmed.contains("require(")
        || trimmed.contains("import ")
        || trimmed.contains("export ")
        || trimmed.contains("=>")
        || trimmed.contains(".forEach")
        || trimmed.contains(".map(")
        || trimmed.contains(".filter(")
        || trimmed.contains(".reduce(")
        || trimmed.contains("try {")
        || trimmed.contains("catch (")
        || trimmed.contains("JSON.")
        || trimmed.contains("console.")
        || trimmed.contains("document.")
        || trimmed.contains("window.")
}

/// Generate run_command snippet
fn generate_run_command_snippet(args: &Value) -> String {
    let run = args.get("run").and_then(|v| v.as_str()).unwrap_or("");
    let engine = args.get("engine").and_then(|v| v.as_str());
    let shell = args.get("shell").and_then(|v| v.as_str());
    let working_directory = args.get("working_directory").and_then(|v| v.as_str());
    let script_file = args.get("script_file").and_then(|v| v.as_str());
    let env = args.get("env");

    // If script_file is provided, generate file-loading code
    if let Some(file) = script_file {
        if !file.is_empty() {
            let escaped_file = file.replace('\\', "\\\\");
            let mut code = format!(
                "const fs = require('fs');\nconst scriptContent = fs.readFileSync(\"{}\", 'utf8');",
                escaped_file
            );
            // Add env variables if provided
            if let Some(env_obj) = env.and_then(|v| v.as_object()) {
                for (key, value) in env_obj {
                    let val_str = match value {
                        serde_json::Value::String(s) => format!("\"{}\"", s.replace('"', "\\\"")),
                        _ => value.to_string(),
                    };
                    code.push_str(&format!("\nconst {} = {};", key, val_str));
                }
            }
            code.push_str("\neval(scriptContent);");
            return code;
        }
    }

    // Determine if this is shell code:
    // 1. Explicit engine set to shell/bash/cmd/powershell
    // 2. Engine not set but code looks like shell/PowerShell (and NOT like JavaScript)
    let is_shell = match engine {
        Some(e) => matches!(e, "shell" | "bash" | "cmd" | "powershell"),
        // Only use heuristics if no explicit engine - and be careful not to
        // misclassify JS code that contains && or || operators
        None => looks_like_shell_code(run) && !looks_like_javascript_code(run),
    };

    // Determine if code needs Node.js runtime (require, fs operations, etc.)
    let needs_node_runtime = run.contains("require(")
        || run.contains("import ")
        || run.contains("fs.readFileSync")
        || run.contains("fs.writeFileSync");

    // Shell command mode - wrap in desktop.run() with shell and working_directory
    if is_shell && !needs_node_runtime {
        let escaped_run = run
            .replace('\\', "\\\\")
            .replace('`', "\\`")
            .replace('$', "\\$");

        // Build desktop.run() call with optional shell and working_directory
        let shell_arg = shell.map(|s| format!(", \"{}\"", s)).unwrap_or_default();
        let wd_arg = if let Some(wd) = working_directory {
            let wd_escaped = wd.replace('\\', "\\\\");
            if shell.is_some() {
                format!(", \"{}\"", wd_escaped)
            } else {
                format!(", null, \"{}\"", wd_escaped)
            }
        } else {
            String::new()
        };

        return format!(
            "const result = await desktop.run(`{}`{}{});\nreturn result;",
            escaped_run, shell_arg, wd_arg
        );
    }

    // JavaScript/TypeScript - apply API transformations
    let transformed = transform_yaml_js_to_sdk(run);

    // Node.js code runs inline - the SDK execute() function already runs in Node.js
    // No need for runCommand() which spawns PowerShell on Windows

    // Inline JavaScript code with transformations applied

    // If the code contains a return statement with state/set_env (for inter-step communication),
    // we need to capture the IIFE result and return it from the step's execute function
    // so the SDK can merge the state properly
    if transformed.contains("return {")
        && (transformed.contains("state:") || transformed.contains("set_env:"))
    {
        // Check if code contains an IIFE pattern: (async () => { ... })() or (() => { ... })()
        // The IIFE may be preceded by require statements or other setup code
        let has_iife = transformed.contains("(async () =>")
            || transformed.contains("(() =>")
            || transformed.contains("(async() =>")
            || transformed.contains("(()=>");

        if has_iife {
            // Find the IIFE and wrap it to capture its return value
            // Replace "await (async () => ..." with "const __stepResult = await (async () => ..."
            // and add "return __stepResult;" at the end
            let mut result = transformed.clone();

            // Handle "await (async () =>" pattern
            if result.contains("await (async () =>") {
                result = result.replacen(
                    "await (async () =>",
                    "const __stepResult = await (async () =>",
                    1,
                );
            } else if result.contains("await (async() =>") {
                result = result.replacen(
                    "await (async() =>",
                    "const __stepResult = await (async() =>",
                    1,
                );
            } else if result.contains("await (() =>") {
                result = result.replacen("await (() =>", "const __stepResult = await (() =>", 1);
            } else if result.contains("await (()=>") {
                result = result.replacen("await (()=>", "const __stepResult = await (()=>", 1);
            }
            // Handle non-awaited IIFE at the end (standalone IIFE)
            else if result.trim_end().ends_with("})()") || result.trim_end().ends_with("})();") {
                result = format!(
                    "const __stepResult = await {};\nreturn __stepResult;",
                    result.trim()
                );
                return result;
            }

            // Add return statement at the end
            result.push_str("\nreturn __stepResult;");
            return result;
        }
    }

    transformed
}

/// Generate mouse_drag snippet
fn generate_mouse_drag_snippet(args: &Value) -> String {
    let locator = build_locator_string(args);
    let start_x = args.get("start_x").and_then(|v| v.as_f64()).unwrap_or(0.0) as i32;
    let start_y = args.get("start_y").and_then(|v| v.as_f64()).unwrap_or(0.0) as i32;
    let end_x = args.get("end_x").and_then(|v| v.as_f64()).unwrap_or(0.0) as i32;
    let end_y = args.get("end_y").and_then(|v| v.as_f64()).unwrap_or(0.0) as i32;
    let timeout = args
        .get("timeout_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(5000);
    let options = build_action_options(args);

    format!(
        "const element = await desktop.locator({}).first({});\nelement.mouseDrag({}, {}, {}, {}{});",
        locator,
        timeout,
        start_x,
        start_y,
        end_x,
        end_y,
        if options.is_empty() {
            String::new()
        } else {
            format!(", {}", options)
        }
    )
}

/// Generate scroll_element snippet
fn generate_scroll_snippet(args: &Value) -> String {
    let locator = build_locator_string(args);
    let direction = args
        .get("direction")
        .and_then(|v| v.as_str())
        .unwrap_or("down");
    let amount = args.get("amount").and_then(|v| v.as_f64()).unwrap_or(3.0) as u64;
    let timeout = args
        .get("timeout_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(5000);
    let options = build_action_options(args);
    format!(
        "const element = await desktop.locator({}).first({});\nelement.scroll(\"{}\", {}{});",
        locator,
        timeout,
        direction,
        amount,
        if options.is_empty() {
            String::new()
        } else {
            format!(", {}", options)
        }
    )
}

/// Generate close_element snippet
fn generate_close_snippet(args: &Value) -> String {
    let locator = build_locator_string(args);
    let timeout = args
        .get("timeout_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(5000);
    format!(
        "const element = await desktop.locator({}).first({});\nawait element.close();",
        locator, timeout
    )
}

/// Generate wait_for_element snippet
fn generate_wait_for_element_snippet(args: &Value) -> String {
    let locator = build_locator_string(args);
    let timeout = args
        .get("timeout_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(30000);
    let condition = args
        .get("condition")
        .and_then(|v| v.as_str())
        .unwrap_or("exists");
    format!(
        "await desktop.locator({}).waitFor(\"{}\", {});",
        locator, condition, timeout
    )
}

/// Generate select_option snippet
fn generate_select_option_snippet(args: &Value) -> String {
    let locator = build_locator_string(args);
    let option = args
        .get("option_name")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let timeout = args
        .get("timeout_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(5000);
    let opts = build_action_options(args);
    if opts.is_empty() {
        format!(
            "const element = await desktop.locator({}).first({});\nawait element.selectOption(\"{}\");",
            locator, timeout, option
        )
    } else {
        format!(
            "const element = await desktop.locator({}).first({});\nawait element.selectOption(\"{}\", {});",
            locator, timeout, option, opts
        )
    }
}

/// Generate set_value snippet
fn generate_set_value_snippet(args: &Value) -> String {
    let locator = build_locator_string(args);
    let value = args.get("value").and_then(|v| v.as_str()).unwrap_or("");
    let escaped_value = value.replace('\\', "\\\\").replace('"', "\\\"");
    let timeout = args
        .get("timeout_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(5000);
    let options = build_action_options(args);
    format!(
        "const element = await desktop.locator({}).first({});\nelement.setValue(\"{}\"{});",
        locator,
        timeout,
        escaped_value,
        if options.is_empty() {
            String::new()
        } else {
            format!(", {}", options)
        }
    )
}

/// Generate highlight_element snippet
fn generate_highlight_snippet(args: &Value) -> String {
    let locator = build_locator_string(args);
    let timeout = args
        .get("timeout_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(5000);
    let color = args.get("color").and_then(|v| v.as_u64());
    let duration = args.get("duration_ms").and_then(|v| v.as_u64());
    let text = args.get("text").and_then(|v| v.as_str());
    let text_position = args.get("text_position").and_then(|v| v.as_str());
    let font_size = args.get("font_size").and_then(|v| v.as_u64());
    let font_bold = args.get("font_bold").and_then(|v| v.as_bool());
    let font_color = args.get("font_color").and_then(|v| v.as_u64());

    // Build options object if any text options are specified
    let mut opts = Vec::new();
    if let Some(t) = text {
        opts.push(format!("text: \"{}\"", t.replace('"', "\\\"")));
    }
    if let Some(pos) = text_position {
        opts.push(format!("textPosition: \"{}\"", pos));
    }
    if let Some(size) = font_size {
        opts.push(format!("fontSize: {}", size));
    }
    if let Some(bold) = font_bold {
        opts.push(format!("fontBold: {}", bold));
    }
    if let Some(fc) = font_color {
        opts.push(format!("fontColor: {}", fc));
    }

    let options_str = if opts.is_empty() {
        String::new()
    } else {
        format!(", {{ {} }}", opts.join(", "))
    };

    if color.is_some() || duration.is_some() || !opts.is_empty() {
        format!(
            "const element = await desktop.locator({}).first({});\nelement.highlight({}, {}{});",
            locator,
            timeout,
            color
                .map(|c| c.to_string())
                .unwrap_or("undefined".to_string()),
            duration
                .map(|d| d.to_string())
                .unwrap_or("undefined".to_string()),
            options_str
        )
    } else {
        format!(
            "const element = await desktop.locator({}).first({});\nelement.highlight();",
            locator, timeout
        )
    }
}

/// Generate validate_element snippet
fn generate_validate_snippet(args: &Value) -> String {
    let locator = build_locator_string(args);
    let timeout = args
        .get("timeout_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(5000);
    format!(
        "const result = await desktop.locator({}).validate({});\nconsole.log(\"exists:\", result.exists);",
        locator, timeout
    )
}

/// Generate invoke_element snippet
fn generate_invoke_snippet(args: &Value) -> String {
    let locator = build_locator_string(args);
    let timeout = args
        .get("timeout_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(5000);
    let options = build_action_options(args);
    format!(
        "const element = await desktop.locator({}).first({});\nelement.invoke({});",
        locator, timeout, options
    )
}

/// Generate set_selected snippet
fn generate_set_selected_snippet(args: &Value) -> String {
    let locator = build_locator_string(args);
    let state = args.get("state").and_then(|v| v.as_bool()).unwrap_or(true);
    let timeout = args
        .get("timeout_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(5000);
    let options = build_action_options(args);
    format!(
        "const element = await desktop.locator({}).first({});\nelement.setSelected({}{});",
        locator,
        timeout,
        state,
        if options.is_empty() {
            String::new()
        } else {
            format!(", {}", options)
        }
    )
}

/// Generate activate_element snippet
fn generate_activate_snippet(args: &Value) -> String {
    let locator = build_locator_string(args);
    let timeout = args
        .get("timeout_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(5000);
    format!(
        "const element = await desktop.locator({}).first({});\nelement.activate();",
        locator, timeout
    )
}

/// Generate execute_browser_script snippet
///
/// Uses Element-based pattern for cleaner, more concise code:
/// - First locate the browser element via process selector
/// - Then call executeBrowserScript on the element
/// - Element.executeBrowserScript(fn, env?) properly passes env to the function
///
/// This is more concise than Desktop.executeBrowserScript which requires
/// hacky string injection for env variables.
fn generate_execute_browser_script_snippet(args: &Value) -> String {
    let script = args.get("script").and_then(|v| v.as_str()).unwrap_or("");
    let script_file = args.get("script_file").and_then(|v| v.as_str());
    let process = args
        .get("process")
        .and_then(|v| v.as_str())
        .unwrap_or("chrome");

    // Check if env is provided and has values
    let env_obj = args.get("env").and_then(|v| v.as_object());
    let has_env = env_obj.is_some_and(|o| !o.is_empty());

    // If script_file provided, use file-based syntax with Element pattern
    if let Some(file) = script_file {
        if has_env {
            let env_entries: Vec<String> = env_obj
                .unwrap()
                .keys()
                .map(|key| format!("{}: context.state.{}", key, key))
                .collect();
            let env_object = env_entries.join(", ");
            return format!(
                r#"const browser = await desktop.locator("process:{}").first(5000);
const result = await browser.executeBrowserScript({{ file: "{}" }}, {{ {} }});"#,
                process,
                file.replace('\\', "\\\\"),
                env_object
            );
        }
        return format!(
            r#"const browser = await desktop.locator("process:{}").first(5000);
const result = await browser.executeBrowserScript({{ file: "{}" }});"#,
            process,
            file.replace('\\', "\\\\")
        );
    }

    // Extract function body from IIFE patterns like:
    // (function() { ... })()
    // (async function() { ... })()
    // (() => { ... })()
    let mut function_body = extract_iife_body(script);

    // Transform JSON.parse(env.xxx) -> env.xxx
    // YAML runtime passed env values as strings, but SDK passes objects directly
    // So JSON.parse() is no longer needed and would fail with "[object Object]" error
    if let Ok(json_parse_env) = regex::Regex::new(r"JSON\.parse\s*\(\s*env\.(\w+)\s*\)") {
        function_body = json_parse_env
            .replace_all(&function_body, "env.$1")
            .to_string();
        tracing::debug!("[browser_script] Transformed JSON.parse(env.xxx) -> env.xxx");
    }

    // Detect if script body references env-related variables
    // These patterns indicate the script expects env to be available
    let needs_env = has_env
        || function_body.contains("env.")
        || function_body.contains("env[")
        || function_body.contains("typeof env")
        || function_body.contains("current_record")
        || function_body.contains("loop_index");

    if needs_env {
        // Build env object entries that reference context.state.X at runtime
        let env_entries: Vec<String> = if let Some(env_obj) = env_obj {
            env_obj
                .keys()
                .map(|key| format!("{}: context.state.{}", key, key))
                .collect()
        } else {
            // No explicit env, but script uses env vars - provide common ones
            vec![
                "current_record: context.state.current_record".to_string(),
                "loop_index: context.state.loop_index".to_string(),
            ]
        };

        let env_object = env_entries.join(", ");

        // Element-based pattern: element.executeBrowserScript(fn, env)
        // The SDK properly passes env to the function parameter
        return format!(
            r#"const browser = await desktop.locator("process:{}").first(5000);
const result = await browser.executeBrowserScript(async function(env) {{
{}
}}, {{ {} }});"#,
            process, function_body, env_object
        );
    }

    // No env needed - simple function without env parameter
    format!(
        r#"const browser = await desktop.locator("process:{}").first(5000);
const result = await browser.executeBrowserScript(async function() {{
{}
}});"#,
        process, function_body
    )
}

/// Extract the body from an IIFE pattern, or return the script as-is if not an IIFE
fn extract_iife_body(script: &str) -> String {
    let trimmed = script.trim();

    // Determine IIFE ending offset: })() is 4 chars, })(); is 5 chars
    let (is_iife_ending, end_offset) = if trimmed.ends_with("})();") {
        (true, 5)
    } else if trimmed.ends_with("})()") {
        (true, 4)
    } else {
        (false, 0)
    };

    // Check for IIFE patterns: (function() { ... })() or (async function() { ... })()
    if (trimmed.starts_with("(function") || trimmed.starts_with("(async function"))
        && is_iife_ending
    {
        if let Some(brace_start) = trimmed.find('{') {
            // Body is between first { and the last } before })() or })();
            let last_brace = trimmed.len() - end_offset;
            let body = &trimmed[brace_start + 1..last_brace];
            return body.trim().to_string();
        }
    }

    // Check for arrow IIFE: (() => { ... })() or (() => { ... })();
    if trimmed.starts_with("(() =>") && is_iife_ending {
        if let Some(brace_start) = trimmed.find('{') {
            let last_brace = trimmed.len() - end_offset;
            let body = &trimmed[brace_start + 1..last_brace];
            return body.trim().to_string();
        }
    }

    // Not an IIFE - return as-is (will be wrapped in async function)
    trimmed.to_string()
}

/// Generate stop_highlighting snippet
fn generate_stop_highlighting_snippet(args: &Value) -> String {
    // Check if a specific highlight_id is provided
    if let Some(id) = args.get("highlight_id").and_then(|v| v.as_str()) {
        if !id.is_empty() {
            return format!(
                "// Stop specific highlight: {}\ndesktop.stopHighlighting();",
                id
            );
        }
    }
    "desktop.stopHighlighting();".to_string()
}

/// Generate gemini_computer_use snippet
fn generate_gemini_computer_use_snippet(args: &Value) -> String {
    let process = args
        .get("process")
        .and_then(|v| v.as_str())
        .unwrap_or("chrome");
    let goal = args.get("goal").and_then(|v| v.as_str()).unwrap_or("");
    let max_steps = args.get("max_steps").and_then(|v| v.as_u64()).unwrap_or(20);

    // Escape goal string for JavaScript
    let escaped_goal = goal
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n");

    format!(
        r#"const result = await desktop.geminiComputerUse("{}", "{}", {});"#,
        process, escaped_goal, max_steps
    )
}

/// Clean up execution logs older than RETENTION_DAYS in a single directory
fn cleanup_directory(dir: &std::path::Path, cutoff_prefix: &str) -> (usize, usize) {
    let mut deleted_count = 0;
    let mut error_count = 0;

    if !dir.exists() {
        return (0, 0);
    }

    match fs::read_dir(dir) {
        Ok(entries) => {
            for entry in entries.flatten() {
                let filename = entry.file_name().to_string_lossy().to_string();

                // Extract date prefix (first 8 chars: YYYYMMDD)
                if filename.len() >= 8 {
                    let file_date_prefix = &filename[..8];

                    // Compare lexicographically (works for YYYYMMDD format)
                    if file_date_prefix < cutoff_prefix {
                        match fs::remove_file(entry.path()) {
                            Ok(_) => {
                                deleted_count += 1;
                                debug!("[execution_logger] Deleted old file: {}", filename);
                            }
                            Err(e) => {
                                error_count += 1;
                                warn!("[execution_logger] Failed to delete {}: {}", filename, e);
                            }
                        }
                    }
                }
            }
        }
        Err(e) => {
            warn!(
                "[execution_logger] Failed to read dir {:?} for cleanup: {}",
                dir, e
            );
        }
    }

    (deleted_count, error_count)
}

/// Clean up execution logs older than RETENTION_DAYS
async fn cleanup_old_executions() {
    let cutoff_date = Local::now().date_naive() - chrono::Duration::days(RETENTION_DAYS);
    let cutoff_prefix = cutoff_date.format("%Y%m%d").to_string();

    debug!(
        "[execution_logger] Cleaning up files older than {} (prefix < {})",
        cutoff_date, cutoff_prefix
    );

    let mut total_deleted = 0;
    let mut total_errors = 0;

    // 1. Clean standalone executions (mediar/executions/)
    let standalone_dir = get_executions_dir();
    let (deleted, errors) = cleanup_directory(&standalone_dir, &cutoff_prefix);
    total_deleted += deleted;
    total_errors += errors;

    // 2. Clean workflow executions (mediar/workflows/*/executions/)
    let workflows_dir = dirs::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("mediar")
        .join("workflows");

    if workflows_dir.exists() {
        if let Ok(entries) = fs::read_dir(&workflows_dir) {
            for entry in entries.flatten() {
                if entry.path().is_dir() {
                    let executions_dir = entry.path().join("executions");
                    let (deleted, errors) = cleanup_directory(&executions_dir, &cutoff_prefix);
                    total_deleted += deleted;
                    total_errors += errors;
                }
            }
        }
    }

    if total_deleted > 0 || total_errors > 0 {
        info!(
            "[execution_logger] Cleanup complete: deleted {} files, {} errors",
            total_deleted, total_errors
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_generate_file_prefix() {
        let ts = Local::now();
        let prefix = generate_file_prefix(&ts, Some("198"), Some("step_xyz"), "click_element");
        assert!(prefix.contains("198"));
        assert!(prefix.contains("step_xyz"));
        assert!(prefix.contains("click_element"));

        let prefix_standalone = generate_file_prefix(&ts, None, None, "get_window_tree");
        assert!(prefix_standalone.contains("standalone"));
        assert!(prefix_standalone.contains("full"));
    }

    #[test]
    fn test_strip_screenshot_base64() {
        let value = json!({
            "status": "executed_without_error",
            "screenshot": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            "other_data": "keep this"
        });

        let stripped = strip_screenshot_base64(&value);
        assert_eq!(stripped["screenshot"], "[extracted to file]");
        assert_eq!(stripped["other_data"], "keep this");
    }

    #[test]
    fn test_extract_base64_image() {
        let value = json!({
            "screenshot": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
        });

        let img = extract_base64_image(&value, &["screenshot"]);
        assert!(img.is_some());
        assert!(img.unwrap().starts_with("iVBOR"));
    }

    #[test]
    fn test_generate_click_snippet_selector_mode() {
        let args = json!({
            "process": "chrome",
            "selector": "role:Button|name:Submit",
            "click_type": "left"
        });
        let snippet = generate_click_snippet(&args);
        assert!(snippet.contains("desktop.locator(\"process:chrome >> role:Button|name:Submit\")"));
        assert!(snippet.contains(".first(5000)"));
        assert!(snippet.contains(".click()"));
    }

    #[test]
    fn test_generate_click_snippet_coordinate_mode() {
        let args = json!({
            "x": 100.0,
            "y": 200.0
        });
        let snippet = generate_click_snippet(&args);
        assert!(snippet.contains("desktop.click(100, 200)"));
    }

    #[test]
    fn test_generate_type_snippet() {
        let args = json!({
            "process": "notepad",
            "selector": "role:Edit",
            "text_to_type": "Hello World",
            "clear_before_typing": true
        });
        let snippet = generate_type_snippet(&args);
        assert!(snippet.contains("desktop.locator(\"process:notepad >> role:Edit\")"));
        assert!(snippet.contains("typeText(\"Hello World\""));
        assert!(snippet.contains("clearBeforeTyping: true"));
    }

    #[test]
    fn test_generate_press_key_snippet() {
        let args = json!({
            "process": "notepad",
            "selector": "role:Document",
            "key": "Ctrl+S"
        });
        let snippet = generate_press_key_snippet(&args);
        assert!(snippet.contains("pressKey(\"Ctrl+S\")"));
    }

    #[test]
    fn test_generate_delay_snippet() {
        let args = json!({
            "ms": 2000
        });
        let snippet = generate_delay_snippet(&args);
        assert_eq!(snippet, "await desktop.delay(2000);");
    }

    #[test]
    fn test_generate_typescript_snippet_raw() {
        let args = json!({
            "process": "chrome",
            "selector": "role:Button|name:OK"
        });
        let result = json!({"status": "executed_without_error"});
        let ts = generate_typescript_snippet("click_element", &args, Ok(&result));

        // Should NOT contain boilerplate (desktop is pre-injected in engine mode)
        assert!(!ts.contains("import { Desktop }"));
        assert!(!ts.contains("new Desktop()"));
        // Should contain raw snippet
        assert!(ts.contains("// Status: SUCCESS"));
        assert!(ts.contains("desktop.locator"));
    }

    #[test]
    fn test_build_locator_string_with_window_selector() {
        let args = json!({
            "process": "chrome",
            "window_selector": "role:Window|name:Google",
            "selector": "role:Button|name:Submit"
        });
        let locator = build_locator_string(&args);
        assert_eq!(
            locator,
            "\"process:chrome >> role:Window|name:Google >> role:Button|name:Submit\""
        );
    }

    #[test]
    fn test_all_snippets_comprehensive() {
        let result = json!({"status": "executed_without_error"});
        let ok_result: Result<&serde_json::Value, &str> = Ok(&result);

        // 1. click_element - selector mode with all params
        let click_selector = json!({
            "process": "chrome",
            "window_selector": "role:Window|name:Google",
            "selector": "role:Button|name:Submit",
            "click_type": "double",
            "timeout": 10000
        });
        println!(
            "\n=== 1. click_element (selector) ===\n{}",
            generate_click_snippet(&click_selector)
        );

        // 2. click_element - coordinate mode
        let click_coord = json!({
            "x": 500.0,
            "y": 300.0,
            "click_type": "right"
        });
        println!(
            "\n=== 2. click_element (coordinates) ===\n{}",
            generate_click_snippet(&click_coord)
        );

        // 3. click_element - index mode
        let click_index = json!({
            "index": 5,
            "vision_type": "ocr"
        });
        println!(
            "\n=== 3. click_element (index) ===\n{}",
            generate_click_snippet(&click_index)
        );

        // 4. type_into_element
        let type_args = json!({
            "process": "notepad",
            "selector": "role:Edit|name:Text Editor",
            "text_to_type": "Hello\\nWorld",
            "clear_before_typing": true,
            "timeout": 8000
        });
        println!(
            "\n=== 4. type_into_element ===\n{}",
            generate_type_snippet(&type_args)
        );

        // 5. press_key
        let press_key = json!({
            "process": "notepad",
            "selector": "role:Document",
            "key": "{Ctrl}s",
            "timeout": 5000
        });
        println!(
            "\n=== 5. press_key ===\n{}",
            generate_press_key_snippet(&press_key)
        );

        // 6. global_key
        let global_key = json!({
            "key": "{Alt}{F4}"
        });
        println!(
            "\n=== 6. global_key ===\n{}",
            generate_global_key_snippet(&global_key)
        );

        // 7. delay
        let delay = json!({
            "ms": 2500
        });
        println!("\n=== 7. delay ===\n{}", generate_delay_snippet(&delay));

        // 8. open_application
        let open_app = json!({
            "path": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
        });
        println!(
            "\n=== 8. open_application ===\n{}",
            generate_open_application_snippet(&open_app)
        );

        // 9. navigate_browser
        let navigate = json!({
            "url": "https://example.com/page?q=test",
            "browser": "firefox"
        });
        println!(
            "\n=== 9. navigate_browser ===\n{}",
            generate_navigate_browser_snippet(&navigate)
        );

        // 10. get_window_tree
        let tree = json!({
            "process": "chrome",
            "window_selector": "role:Window|name:Google",
            "timeout": 15000
        });
        println!(
            "\n=== 10. get_window_tree ===\n{}",
            generate_get_window_tree_snippet(&tree)
        );

        // 11. capture_screenshot (element)
        let screenshot = json!({
            "process": "chrome",
            "selector": "role:Document",
            "timeout": 5000
        });
        println!(
            "\n=== 11. capture_screenshot ===\n{}",
            generate_capture_screenshot_snippet(&screenshot)
        );

        // 12. run_command
        let cmd = json!({
            "command": "echo \"Hello World\" && dir"
        });
        println!(
            "\n=== 12. run_command ===\n{}",
            generate_run_command_snippet(&cmd)
        );

        // 13. mouse_drag
        let drag = json!({
            "start_x": 100.0,
            "start_y": 200.0,
            "end_x": 400.0,
            "end_y": 500.0
        });
        println!(
            "\n=== 13. mouse_drag ===\n{}",
            generate_mouse_drag_snippet(&drag)
        );

        // 14. scroll_element
        let scroll = json!({
            "process": "chrome",
            "selector": "role:Document",
            "direction": "down",
            "amount": 5,
            "timeout": 3000
        });
        println!(
            "\n=== 14. scroll_element ===\n{}",
            generate_scroll_snippet(&scroll)
        );

        // 15. wait_for_element
        let wait = json!({
            "process": "chrome",
            "selector": "role:Button|name:Submit",
            "timeout": 30000
        });
        println!(
            "\n=== 15. wait_for_element ===\n{}",
            generate_wait_for_element_snippet(&wait)
        );

        // 16. select_option
        let select = json!({
            "process": "chrome",
            "selector": "role:ComboBox|name:Country",
            "option": "United States",
            "timeout": 5000
        });
        println!(
            "\n=== 16. select_option ===\n{}",
            generate_select_option_snippet(&select)
        );

        // 17. set_value
        let set_val = json!({
            "process": "notepad",
            "selector": "role:Slider|name:Volume",
            "value": "75",
            "timeout": 3000
        });
        println!(
            "\n=== 17. set_value ===\n{}",
            generate_set_value_snippet(&set_val)
        );

        // 18. highlight_element
        let highlight = json!({
            "process": "chrome",
            "selector": "role:Link|name:Click here",
            "timeout": 5000
        });
        println!(
            "\n=== 18. highlight_element ===\n{}",
            generate_highlight_snippet(&highlight)
        );

        // 19. validate_element
        let validate = json!({
            "process": "chrome",
            "selector": "role:Button|name:Submit",
            "timeout": 10000
        });
        println!(
            "\n=== 19. validate_element ===\n{}",
            generate_validate_snippet(&validate)
        );

        // 20. get_applications
        println!("\n=== 20. get_applications ===\nconst apps = await desktop.getApplications();");

        // 21. Full TypeScript file generation
        let full_args = json!({
            "process": "chrome",
            "selector": "role:Button|name:OK",
            "timeout": 5000
        });
        println!(
            "\n=== 21. FULL FILE (click_element) ===\n{}",
            generate_typescript_snippet("click_element", &full_args, ok_result)
        );

        // 22. Unsupported tool
        let unsupported = json!({"foo": "bar"});
        println!(
            "\n=== 22. unsupported_tool ===\n{}",
            generate_typescript_snippet("some_unknown_tool", &unsupported, ok_result)
        );
    }
}
