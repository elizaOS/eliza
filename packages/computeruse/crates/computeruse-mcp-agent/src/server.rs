use crate::elicitation::try_elicit_raw;
use crate::event_pipe::{create_event_channel, WorkflowEvent};
use crate::execution_logger;
use crate::helpers::*;
use crate::scripting_engine;
use crate::telemetry::StepSpan;
use crate::utils::find_and_execute_with_retry_with_fallback;
pub use crate::utils::DesktopWrapper;
use crate::utils::{
    get_timeout, ActivateElementArgs, AskUserArgs, CaptureScreenshotArgs, ClickElementArgs,
    CopyContentArgs, DelayArgs, EditFileArgs, ExecuteBrowserScriptArgs, ExecuteSequenceArgs,
    GeminiComputerUseArgs, GetApplicationsArgs, GetWindowTreeArgs, GlobFilesArgs, GlobalKeyArgs,
    GrepFilesArgs, HighlightElementArgs, InvokeElementArgs, MouseDragArgs, NavigateBrowserArgs,
    OpenApplicationArgs, PressKeyArgs, ReadFileArgs, RunCommandArgs, ScrollElementArgs,
    SelectOptionArgs, SetSelectedArgs, SetValueArgs, StopHighlightingArgs, TypeIntoElementArgs,
    ValidateElementArgs, WaitForElementArgs, WriteFileArgs,
};
use image::imageops::FilterType;
use image::{ExtendedColorType, ImageBuffer, ImageEncoder, Rgba};
use regex::Regex;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{
    CallToolResult, Content, ElicitationSchema, EnumSchema, Implementation, LoggingLevel,
    LoggingMessageNotificationParam, NumberOrString, PrimitiveSchema, ProgressNotificationParam,
    ProgressToken, ProtocolVersion, ServerCapabilities, ServerInfo, StringSchema,
};
use rmcp::tool_router;
use rmcp::{tool, ErrorData as McpError, ServerHandler};
use serde_json::json;
use std::collections::HashMap;
use std::io::Cursor;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use sysinfo::{ProcessesToUpdate, System};
use computeruse::element::UIElementImpl;
use computeruse::{AutomationError, Browser, Desktop, Selector, UIElement};
use tokio::sync::Mutex;
use tracing::{info, warn, Instrument};

// New imports for image encoding
use base64::{engine::general_purpose, Engine as _};
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;

use rmcp::service::{NotificationContext, Peer, RequestContext, RoleServer};

/// Extracts JSON data from Content objects without double serialization
pub fn extract_content_json(content: &Content) -> Result<serde_json::Value, serde_json::Error> {
    // Handle the new rmcp 0.4.0 Content structure with Annotated<RawContent>
    match &content.raw {
        rmcp::model::RawContent::Text(text_content) => {
            // Try to parse the text as JSON first
            if let Ok(parsed_json) = serde_json::from_str::<serde_json::Value>(&text_content.text) {
                Ok(parsed_json)
            } else {
                // If it's not JSON, return as a text object
                Ok(json!({"type": "text", "text": text_content.text}))
            }
        }
        rmcp::model::RawContent::Image(image_content) => Ok(
            json!({"type": "image", "data": image_content.data, "mime_type": image_content.mime_type}),
        ),
        rmcp::model::RawContent::Resource(resource_content) => {
            Ok(json!({"type": "resource", "resource": resource_content}))
        }
        rmcp::model::RawContent::Audio(audio_content) => Ok(
            json!({"type": "audio", "data": audio_content.data, "mime_type": audio_content.mime_type}),
        ),
        rmcp::model::RawContent::ResourceLink(resource_link) => {
            Ok(json!({"type": "resource_link", "resource": resource_link}))
        }
    }
}

/// Extract raw text from Content (for log extraction from run_command results)
pub fn extract_content_text(content: &Content) -> Option<String> {
    match &content.raw {
        rmcp::model::RawContent::Text(text_content) => Some(text_content.text.clone()),
        _ => None,
    }
}

/// Capture screenshots of all monitors, save to disk, and return paths
async fn capture_monitor_screenshots(desktop: &Desktop) -> Vec<String> {
    let mut paths = Vec::new();

    // Initialize screenshot logger
    computeruse::screenshot_logger::init();
    let prefix = computeruse::screenshot_logger::generate_prefix(Some("mcp"), "monitors");

    match desktop.capture_all_monitors().await {
        Ok(screenshots) => {
            let saved = computeruse::screenshot_logger::save_monitor_screenshots(
                &screenshots,
                &prefix,
                None,
            );
            for s in saved {
                info!("Saved monitor screenshot: {}", s.path.display());
                paths.push(s.path.to_string_lossy().to_string());
            }
        }
        Err(e) => {
            warn!("Failed to capture monitor screenshots: {}", e);
        }
    }

    paths
}

/// Helper to conditionally append monitor screenshots to existing content
/// Disabled by default (defaults to false)
async fn append_monitor_screenshots_if_enabled(
    desktop: &Desktop,
    mut contents: Vec<Content>,
    include: Option<bool>,
) -> Vec<Content> {
    // Disabled by default (defaults to false)
    if include.unwrap_or(false) {
        let paths = capture_monitor_screenshots(desktop).await;
        if !paths.is_empty() {
            contents.push(Content::text(format!(
                "Monitor screenshots saved: {:?}",
                paths
            )));
        }
    }
    contents
}

/// Capture a screenshot of the target window by process name, save to disk, return path
async fn capture_window_screenshot(desktop: &Desktop, process: &str) -> Option<String> {
    // Initialize screenshot logger
    computeruse::screenshot_logger::init();
    let prefix = computeruse::screenshot_logger::generate_prefix(Some("mcp"), process);

    // Use core's capture_window_by_process which handles finding the window
    let screenshot = match desktop.capture_window_by_process(process) {
        Ok(s) => s,
        Err(e) => {
            warn!("[window_screenshot] Failed to capture '{}': {}", process, e);
            return None;
        }
    };

    // Save to disk using screenshot_logger
    match computeruse::screenshot_logger::save_window_screenshot(&screenshot, &prefix, None) {
        Some(saved) => {
            info!(
                "[window_screenshot] Saved '{}' window: {}",
                process,
                saved.path.display()
            );
            Some(saved.path.to_string_lossy().to_string())
        }
        None => {
            warn!(
                "[window_screenshot] Failed to save screenshot for '{}'",
                process
            );
            None
        }
    }
}

/// Helper to conditionally append window screenshot path to JSON result
/// Captures screenshot by default (defaults to true)
/// Adds "window_screenshot_path" field to the JSON if screenshot captured
async fn append_window_screenshot_to_json(
    desktop: &Desktop,
    process: &str,
    result_json: &mut serde_json::Value,
    include: Option<bool>,
) {
    // Capture by default (defaults to true)
    if include.unwrap_or(true) {
        if let Some(path) = capture_window_screenshot(desktop, process).await {
            result_json["window_screenshot_path"] = json!(path);
        }
    }
}

#[tool_router]
impl DesktopWrapper {
    /// Check if a string is a valid JavaScript identifier and not a reserved word
    fn is_valid_js_identifier(name: &str) -> bool {
        // Reserved words and globals we don't want to override
        const RESERVED: &[&str] = &[
            "env",
            "variables",
            "desktop",
            "console",
            "log",
            "sleep",
            "require",
            "process",
            "global",
            "window",
            "document",
            "alert",
            "prompt",
            "undefined",
            "null",
            "true",
            "false",
            "NaN",
            "Infinity",
            "var",
            "let",
            "const",
            "function",
            "return",
            "if",
            "else",
            "for",
            "while",
            "do",
            "switch",
            "case",
            "break",
            "continue",
            "throw",
            "try",
            "catch",
            "finally",
            "new",
            "delete",
            "typeof",
            "instanceof",
            "in",
            "of",
            "this",
            "super",
            "class",
            "extends",
            "static",
            "async",
            "await",
            "yield",
            "import",
            "export",
        ];

        if RESERVED.contains(&name) {
            return false;
        }

        // Check if it's a valid identifier: starts with letter/underscore/$,
        // continues with letters/digits/underscore/$
        if name.is_empty() {
            return false;
        }

        let mut chars = name.chars();
        let first = chars.next().unwrap();
        if !first.is_alphabetic() && first != '_' && first != '$' {
            return false;
        }

        chars.all(|c| c.is_alphanumeric() || c == '_' || c == '$')
    }

    /// Prepare window management before tool execution
    /// Handles window cache update, state capture, minimize all, and maximize target
    async fn prepare_window_management(
        &self,
        process: &str,
        execution_context: Option<&crate::utils::ToolExecutionContext>,
        process_id: Option<u32>,
        ui_element: Option<&computeruse::platforms::windows::WindowsUIElement>,
        window_mgmt_opts: &crate::utils::WindowManagementOptions,
    ) -> Result<(), String> {
        let start = std::time::Instant::now();

        // Check if window management is enabled (defaults to true for backward compatibility)
        let enabled = window_mgmt_opts.enable_window_management.unwrap_or(true);
        if !enabled {
            tracing::debug!("Window management disabled by user, skipping");
            return Ok(());
        }

        // Update window cache on-demand before managing windows
        // Initial state is captured once before sequence starts (in server_sequence.rs)
        if let Err(e) = self.window_manager.update_window_cache().await {
            tracing::warn!("Failed to update window cache: {}", e);
        }

        // Handle execution context-aware window management
        if let Some(ctx) = execution_context {
            // Detect process switch
            let process_switched = if let Some(ref prev_process) = ctx.previous_process {
                prev_process != process
            } else {
                false
            };

            if process_switched {
                tracing::info!(
                    "Process switched from '{}' to '{}' at step {}",
                    ctx.previous_process.as_ref().unwrap(),
                    process,
                    ctx.current_step
                );

                // Minimize the previous process window
                if let Some(prev_window) = self
                    .window_manager
                    .get_topmost_window_for_process(ctx.previous_process.as_ref().unwrap())
                    .await
                {
                    match self
                        .window_manager
                        .minimize_if_needed(prev_window.hwnd)
                        .await
                    {
                        Ok(true) => {
                            tracing::info!("Minimized previous process window");
                        }
                        Ok(false) => {
                            tracing::debug!("Previous process window already minimized");
                        }
                        Err(e) => {
                            tracing::warn!("Failed to minimize previous process window: {}", e);
                        }
                    }
                }
            }

            // Initial state is now captured before sequence starts (in server_sequence.rs)
            // No need to capture here anymore

            // Get topmost window for the target process
            if let Some(window) = self
                .window_manager
                .get_topmost_window_for_process(process)
                .await
            {
                tracing::info!(
                    "Managing windows for process '{}' (hwnd: {}, step {}/{})",
                    process,
                    window.hwnd,
                    ctx.current_step,
                    ctx.total_steps
                );

                // Only minimize always-on-top windows (only on first UI step or non-sequence)
                // Maximizing brings the target to front naturally, so we only need to handle
                // always-on-top windows that would otherwise cover it
                // First UI tool in sequence has no previous_process
                let should_minimize_always_on_top =
                    window_mgmt_opts.minimize_always_on_top.unwrap_or(false);
                if should_minimize_always_on_top
                    && (ctx.previous_process.is_none() || !ctx.in_sequence)
                {
                    let always_on_top_windows =
                        self.window_manager.get_always_on_top_windows().await;
                    if !always_on_top_windows.is_empty() {
                        tracing::info!(
                            "Found {} always-on-top windows that may cover target",
                            always_on_top_windows.len()
                        );
                        match self
                            .window_manager
                            .minimize_always_on_top_windows(window.hwnd)
                            .await
                        {
                            Ok(count) => {
                                tracing::info!("Minimized {} always-on-top windows", count);
                            }
                            Err(e) => {
                                tracing::warn!("Failed to minimize always-on-top windows: {}", e);
                            }
                        }
                    } else {
                        tracing::debug!("No always-on-top windows found, skipping minimization (maximize will bring target to front)");
                    }
                }

                // Maximize target if not already maximized
                let should_maximize_target = window_mgmt_opts.maximize_target.unwrap_or(false);
                let should_bring_to_front = window_mgmt_opts.bring_to_front.unwrap_or(true);

                if should_maximize_target {
                    match self.window_manager.maximize_if_needed(window.hwnd).await {
                        Ok(true) => {
                            tracing::info!("Maximized target window");
                        }
                        Ok(false) => {
                            tracing::debug!("Target window already maximized");
                        }
                        Err(e) => {
                            tracing::warn!("Failed to maximize window: {}", e);
                        }
                    }
                }

                // Bring window to front (independent of maximize)
                if should_bring_to_front {
                    match self.window_manager.bring_window_to_front(window.hwnd).await {
                        Ok(true) => {
                            tracing::info!("Brought target window to front");
                        }
                        Ok(false) => {
                            tracing::debug!(
                                "Failed to bring window to front (Windows restrictions)"
                            );
                        }
                        Err(e) => {
                            tracing::warn!("Failed to bring window to front: {}", e);
                        }
                    }
                }
            } else {
                tracing::warn!(
                    "Could not find window for process '{}' for window management",
                    process
                );
            }
        } else {
            // Simple mode: no execution context (direct MCP tool calls)
            // Always capture initial state, minimize all, maximize target

            if let Err(e) = self.window_manager.capture_initial_state().await {
                tracing::warn!("Failed to capture initial window state: {}", e);
            }

            // Check if this is a UWP app (requires process_id)
            let is_uwp = if let Some(pid) = process_id {
                self.window_manager.is_uwp_app(pid).await
            } else {
                false
            };

            if is_uwp {
                tracing::info!("[prepare_window_management] Detected UWP app - using keyboard (Win+Up) for window management");

                // Get UWP window's HWND for tracking and restoration
                // For UWP apps, we need the ApplicationFrameHost parent HWND, not the content window HWND
                let uwp_hwnd = if let Some(element) = ui_element {
                    match element.get_native_window_handle() {
                        Ok(content_hwnd) => {
                            tracing::info!(
                                "[prepare_window_management] Got UWP content window HWND: {}",
                                content_hwnd
                            );

                            // Get the parent ApplicationFrameHost window
                            #[cfg(windows)]
                            {
                                use windows::Win32::Foundation::HWND;
                                use windows::Win32::UI::WindowsAndMessaging::GetAncestor;
                                use windows::Win32::UI::WindowsAndMessaging::GA_ROOT;

                                unsafe {
                                    let hwnd = HWND(content_hwnd as *mut _);
                                    let root_hwnd = GetAncestor(hwnd, GA_ROOT);
                                    if !root_hwnd.0.is_null() {
                                        let root_hwnd_val = root_hwnd.0 as isize;
                                        tracing::info!(
                                            "[prepare_window_management] Got UWP root window HWND: {}",
                                            root_hwnd_val
                                        );
                                        Some(root_hwnd_val)
                                    } else {
                                        tracing::warn!("[prepare_window_management] Failed to get root window for UWP content");
                                        Some(content_hwnd)
                                    }
                                }
                            }

                            #[cfg(not(windows))]
                            {
                                Some(content_hwnd)
                            }
                        }
                        Err(e) => {
                            tracing::warn!(
                                "[prepare_window_management] Failed to get UWP HWND: {}",
                                e
                            );
                            None
                        }
                    }
                } else {
                    tracing::warn!(
                        "[prepare_window_management] No ui_element provided for UWP app"
                    );
                    None
                };

                // 1. Track UWP window as target for restoration
                if let Some(hwnd) = uwp_hwnd {
                    self.window_manager.set_target_window(hwnd).await;
                } else {
                    tracing::warn!("[prepare_window_management] Cannot track UWP window for restoration (no HWND)");
                }

                // 2. Maximize UWP target window using keyboard (ShowWindow doesn't work for UWP)
                let should_maximize_target = window_mgmt_opts.maximize_target.unwrap_or(false);
                if should_maximize_target {
                    if let Some(element) = ui_element {
                        if let Err(e) = element.maximize_window_keyboard() {
                            tracing::warn!(
                                "Failed to maximize UWP window via keyboard for {}: {}",
                                process,
                                e
                            );
                        } else {
                            tracing::info!(
                                "Maximized UWP window for {} via keyboard (Win+Up)",
                                process
                            );
                        }
                    } else {
                        tracing::warn!("Cannot maximize UWP window - no ui_element provided");
                    }
                }

                // 3. Minimize Win32 always-on-top windows (if any)
                // Note: UWP always-on-top windows are not visible via Win32 enumeration
                let should_minimize_always_on_top =
                    window_mgmt_opts.minimize_always_on_top.unwrap_or(false);
                if should_minimize_always_on_top {
                    let always_on_top_windows =
                        self.window_manager.get_always_on_top_windows().await;
                    if !always_on_top_windows.is_empty() {
                        tracing::info!(
                            "Found {} always-on-top Win32 windows to minimize",
                            always_on_top_windows.len()
                        );

                        if let Some(hwnd) = uwp_hwnd {
                            match self
                                .window_manager
                                .minimize_always_on_top_windows(hwnd)
                                .await
                            {
                                Ok(count) => {
                                    tracing::info!(
                                        "Minimized {} Win32 always-on-top windows (UWP target app)",
                                        count
                                    );
                                }
                                Err(e) => {
                                    tracing::warn!(
                                        "Failed to minimize always-on-top windows for UWP app: {}",
                                        e
                                    );
                                }
                            }
                        } else {
                            tracing::warn!(
                                "Could not get HWND from UWP element to minimize always-on-top windows"
                            );
                        }
                    }
                }
            } else {
                // Win32 app: use traditional window management
                // Try PID-based lookup first if available, fallback to process name
                let window = if let Some(pid) = process_id {
                    self.window_manager.get_topmost_window_for_pid(pid).await
                } else {
                    self.window_manager
                        .get_topmost_window_for_process(process)
                        .await
                };

                if let Some(window) = window {
                    // Minimize always-on-top Win32 windows
                    let should_minimize_always_on_top =
                        window_mgmt_opts.minimize_always_on_top.unwrap_or(false);
                    if should_minimize_always_on_top {
                        let always_on_top_windows =
                            self.window_manager.get_always_on_top_windows().await;
                        if !always_on_top_windows.is_empty() {
                            tracing::debug!(
                                "Found {} always-on-top Win32 windows",
                                always_on_top_windows.len()
                            );
                            match self
                                .window_manager
                                .minimize_always_on_top_windows(window.hwnd)
                                .await
                            {
                                Ok(count) => {
                                    tracing::info!(
                                        "Minimized {} always-on-top Win32 windows for {}",
                                        count,
                                        process
                                    );
                                }
                                Err(e) => {
                                    tracing::warn!(
                                        "Failed to minimize always-on-top windows: {}",
                                        e
                                    );
                                }
                            }
                        }
                    }

                    // Maximize target Win32 window
                    let should_maximize_target = window_mgmt_opts.maximize_target.unwrap_or(false);
                    let should_bring_to_front = window_mgmt_opts.bring_to_front.unwrap_or(true);

                    if should_maximize_target {
                        match self.window_manager.maximize_if_needed(window.hwnd).await {
                            Ok(true) => {
                                tracing::info!("Maximized Win32 window for {}", process);
                            }
                            Ok(false) => {
                                tracing::debug!("Win32 window already maximized");
                            }
                            Err(e) => {
                                tracing::warn!("Failed to maximize Win32 window: {}", e);
                            }
                        }
                    }

                    // Bring window to front (independent of maximize)
                    if should_bring_to_front {
                        match self.window_manager.bring_window_to_front(window.hwnd).await {
                            Ok(true) => {
                                tracing::info!("Brought Win32 window to front for {}", process);
                            }
                            Ok(false) => {
                                tracing::debug!(
                                    "Failed to bring Win32 window to front (Windows restrictions)"
                                );
                            }
                            Err(e) => {
                                tracing::warn!("Failed to bring Win32 window to front: {}", e);
                            }
                        }
                    }
                } else {
                    tracing::warn!(
                        "Could not find Win32 window for '{}' for window management",
                        process
                    );
                }
            }
        }

        let elapsed = start.elapsed();
        tracing::info!("[TIMING] prepare_window_management took {:?}", elapsed);
        Ok(())
    }

    /// Restore windows after tool execution
    /// Only restores for non-sequence calls or when explicitly needed
    async fn restore_window_management(&self, should_restore: bool) {
        if should_restore {
            if let Err(e) = self.window_manager.restore_all_windows().await {
                tracing::warn!("Failed to restore windows: {}", e);
            } else {
                tracing::info!("Restored all windows to original state");
            }
            self.window_manager.clear_captured_state().await;
        }
    }

    // Minimal, conservative parser to extract `{ set_env: {...} }` from simple scripts
    // like `return { set_env: { a: 1, b: 'x' } };`. This is only used as a fallback
    // when Node/Bun execution is unavailable, to support env propagation tests.
    #[allow(dead_code)]
    fn parse_set_env_from_script(script: &str) -> Option<serde_json::Value> {
        // Quick check for the pattern "return {" and "set_env" to avoid heavy parsing
        let lower = script.to_ascii_lowercase();
        if !lower.contains("return") || !lower.contains("set_env") {
            return None;
        }

        // Heuristic extraction: find the first '{' after 'return' and the matching '}'
        let return_pos = lower.find("return")?;
        let brace_start = script[return_pos..].find('{')? + return_pos;

        // Naive brace matching to capture the returned object
        let mut depth = 0i32;
        let mut end_idx = None;
        for (i, ch) in script[brace_start..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        end_idx = Some(brace_start + i + 1);
                        break;
                    }
                }
                _ => {}
            }
        }
        let end = end_idx?;
        let object_src = &script[brace_start..end];

        // Convert a very small subset of JS object syntax to JSON:
        // - wrap unquoted keys
        // - convert single quotes to double quotes
        // - allow trailing semicolon outside
        let mut jsonish = object_src.to_string();
        // Replace single quotes with double quotes
        jsonish = jsonish.replace('\'', "\"");
        // Quote bare keys using a conservative regex-like pass
        // This is not a full parser; it aims to handle simple literals used in tests
        let mut out = String::with_capacity(jsonish.len() + 16);
        let mut chars = jsonish.chars().peekable();
        let mut in_string = false;
        while let Some(c) = chars.next() {
            if c == '"' {
                in_string = !in_string;
                out.push(c);
                continue;
            }
            if !in_string && c.is_alphabetic() {
                // start of a possibly bare key
                let mut key = String::new();
                key.push(c);
                while let Some(&nc) = chars.peek() {
                    if nc.is_alphanumeric() || nc == '_' {
                        key.push(nc);
                        chars.next();
                    } else {
                        break;
                    }
                }
                // If the next non-space char is ':' then this was a key
                let mut look = chars.clone();
                let mut ws = String::new();
                while let Some(&nc) = look.peek() {
                    if nc.is_whitespace() {
                        ws.push(nc);
                        look.next();
                    } else {
                        break;
                    }
                }
                if let Some(':') = look.peek().copied() {
                    out.push('"');
                    out.push_str(&key);
                    out.push('"');
                    out.push_str(&ws);
                    out.push(':');
                    // Advance original iterator to after ws and ':'
                    for _ in 0..ws.len() {
                        chars.next();
                    }
                    chars.next();
                } else {
                    out.push_str(&key);
                }
                continue;
            }
            out.push(c);
        }

        // Try to parse as JSON
        if let Ok(mut val) = serde_json::from_str::<serde_json::Value>(&out) {
            // Only accept objects containing set_env as an object
            if let Some(obj) = val.as_object_mut() {
                if let Some(set_env_val) = obj.get("set_env").cloned() {
                    if set_env_val.is_object() {
                        return Some(val);
                    }
                }
            }
        }
        None
    }
    pub fn new() -> Result<Self, McpError> {
        Self::new_with_log_capture(None)
    }

    pub fn new_with_log_capture(
        log_capture: Option<crate::tool_logging::LogCapture>,
    ) -> Result<Self, McpError> {
        #[cfg(any(target_os = "windows", target_os = "linux"))]
        let desktop = match Desktop::new(false, false) {
            Ok(d) => d,
            Err(e) => {
                return Err(McpError::internal_error(
                    "Failed to initialize computeruse desktop",
                    serde_json::to_value(e.to_string()).ok(),
                ))
            }
        };

        #[cfg(target_os = "macos")]
        let desktop = match Desktop::new(true, true) {
            Ok(d) => d,
            Err(e) => {
                return Err(McpError::internal_error(
                    "Failed to initialize computeruse desktop",
                    serde_json::to_value(e.to_string()).ok(),
                ))
            }
        };

        Ok(Self {
            desktop: Arc::new(desktop),
            tool_router: Self::tool_router(),
            request_manager: crate::cancellation::RequestManager::new(),
            active_highlights: Arc::new(Mutex::new(Vec::new())),
            log_capture,
            captured_stderr_logs: Arc::new(std::sync::Mutex::new(Vec::new())),
            current_workflow_dir: Arc::new(Mutex::new(None)),
            current_scripts_base_path: Arc::new(Mutex::new(None)),
            window_manager: Arc::new(computeruse::WindowManager::new()),
            in_sequence: Arc::new(std::sync::Mutex::new(false)),
            ocr_bounds: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            omniparser_items: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            vision_items: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            uia_bounds: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            dom_bounds: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            clustered_bounds: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            #[cfg(target_os = "windows")]
            inspect_overlay_handle: Arc::new(std::sync::Mutex::new(None)),
            client_modes: Arc::new(Mutex::new(std::collections::HashMap::new())),
            elicitation_peer: Arc::new(Mutex::new(None)),
            broadcast_peers: Arc::new(Mutex::new(Vec::new())),
        })
    }

    /// Detect if a PID belongs to a browser process
    /// Delegates to computeruse::is_browser_process for consistent browser detection
    fn detect_browser_by_pid(pid: u32) -> bool {
        #[cfg(target_os = "windows")]
        {
            computeruse::is_browser_process(pid)
        }

        #[cfg(not(target_os = "windows"))]
        {
            let _ = pid; // Suppress unused warning
            false
        }
    }

    /// Capture all visible DOM elements from the current browser tab
    /// Returns (elements, viewport_offset_x, viewport_offset_y) for screen coordinate conversion
    /// The viewport offset is derived from the UIA Document element's screen bounds
    async fn capture_browser_dom_elements(
        &self,
        max_elements: u32,
    ) -> Result<(Vec<serde_json::Value>, f64, f64), String> {
        // First, find the Document element to get viewport screen position
        // This is more reliable than JavaScript window properties (which break with DPI scaling)
        let viewport_offset = match self
            .desktop
            .locator("role:Document")
            .first(Some(Duration::from_millis(2000)))
            .await
        {
            Ok(doc_element) => {
                match doc_element.bounds() {
                    Ok((x, y, _w, _h)) => (x, y),
                    Err(_) => (0.0, 0.0), // Fallback
                }
            }
            Err(_) => (0.0, 0.0), // Fallback
        };
        // Script to extract ALL visible elements using TreeWalker
        let script = format!(
            r#"
(function() {{
    const elements = [];
    const maxElements = {max_elements}; // Configurable limit"#
        ) + r#"

    // Use TreeWalker to traverse ALL elements in the DOM
    const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_ELEMENT,
        {
            acceptNode: function(node) {
                // Check if element is visible
                const style = window.getComputedStyle(node);
                const rect = node.getBoundingClientRect();

                if (style.display === 'none' ||
                    style.visibility === 'hidden' ||
                    style.opacity === '0' ||
                    rect.width === 0 ||
                    rect.height === 0) {
                    return NodeFilter.FILTER_SKIP;
                }

                return NodeFilter.FILTER_ACCEPT;
            }
        }
    );

    let node;
    while (node = walker.nextNode()) {
        if (elements.length >= maxElements) {
            break;
        }

        const rect = node.getBoundingClientRect();
        const text = node.innerText ? node.innerText.substring(0, 100).trim() : null;

        elements.push({
            tag: node.tagName.toLowerCase(),
            id: node.id || null,
            classes: Array.from(node.classList),
            text: text,
            href: node.href || null,
            type: node.type || null,
            name: node.name || null,
            value: node.value || null,
            placeholder: node.placeholder || null,
            aria_label: node.getAttribute('aria-label'),
            role: node.getAttribute('role'),
            // Scale by devicePixelRatio to convert CSS pixels to physical pixels
            x: Math.round(rect.x * window.devicePixelRatio),
            y: Math.round(rect.y * window.devicePixelRatio),
            width: Math.round(rect.width * window.devicePixelRatio),
            height: Math.round(rect.height * window.devicePixelRatio)
        });
    }

    return JSON.stringify({
        elements: elements,
        total_found: elements.length,
        page_url: window.location.href,
        page_title: document.title,
        devicePixelRatio: window.devicePixelRatio
    });
})()
"#;

        let script_result = self.desktop.execute_browser_script(&script).await;
        info!(
            "[capture_browser_dom] execute_browser_script returned, is_ok={}",
            script_result.is_ok()
        );
        match script_result {
            Ok(result_str) => {
                info!(
                    "[capture_browser_dom] Got result_str, len={}",
                    result_str.len()
                );
                match serde_json::from_str::<serde_json::Value>(&result_str) {
                    Ok(result) => {
                        info!("[capture_browser_dom] JSON parsed successfully");
                        let elements = result
                            .get("elements")
                            .and_then(|v| v.as_array())
                            .cloned()
                            .unwrap_or_default();
                        info!(
                            "[capture_browser_dom] Returning {} elements",
                            elements.len()
                        );
                        // Use UIA-based viewport offset (more reliable than JS due to DPI scaling)
                        Ok((elements, viewport_offset.0, viewport_offset.1))
                    }
                    Err(e) => {
                        warn!("[capture_browser_dom] JSON parse failed: {e}");
                        Err(format!("Failed to parse DOM elements: {e}"))
                    }
                }
            }
            Err(e) => {
                let err_msg = e.to_string();
                // Check if we're on a chrome:// page (new tab, settings, extensions, etc.)
                if err_msg.contains("chrome://") || err_msg.contains("Cannot access a chrome") {
                    warn!("[capture_browser_dom] Detected chrome:// page, navigating to google.com and retrying");

                    // Navigate to google.com
                    if let Err(nav_err) = self.desktop.open_url(
                        "https://www.google.com",
                        Some(Browser::Custom("chrome".to_string())),
                    ) {
                        warn!("[capture_browser_dom] Navigation to google.com failed: {nav_err}");
                        return Err(format!(
                            "Cannot capture DOM on chrome:// page, navigation failed: {nav_err}"
                        ));
                    }

                    // Wait for page to load
                    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

                    // Retry the script
                    match self.desktop.execute_browser_script(&script).await {
                        Ok(result_str) => {
                            info!(
                                "[capture_browser_dom] Retry succeeded after navigation, len={}",
                                result_str.len()
                            );
                            match serde_json::from_str::<serde_json::Value>(&result_str) {
                                Ok(result) => {
                                    let elements = result
                                        .get("elements")
                                        .and_then(|v| v.as_array())
                                        .cloned()
                                        .unwrap_or_default();
                                    info!(
                                        "[capture_browser_dom] Returning {} elements after retry",
                                        elements.len()
                                    );
                                    Ok((elements, viewport_offset.0, viewport_offset.1))
                                }
                                Err(parse_err) => {
                                    warn!("[capture_browser_dom] JSON parse failed after retry: {parse_err}");
                                    Err(format!(
                                        "Failed to parse DOM elements after retry: {parse_err}"
                                    ))
                                }
                            }
                        }
                        Err(retry_err) => {
                            warn!(
                                "[capture_browser_dom] Retry failed after navigation: {retry_err}"
                            );
                            Err(format!("DOM capture failed after navigating away from chrome:// page: {retry_err}"))
                        }
                    }
                } else {
                    warn!("[capture_browser_dom] execute_browser_script failed: {e}");
                    Err(format!("Failed to execute browser script: {e}"))
                }
            }
        }
    }

    /// Perform Omniparser V2 detection on a window by its process ID
    async fn perform_omniparser_for_process(
        &self,
        pid: u32,
    ) -> Result<Vec<crate::omniparser::OmniparserItem>, String> {
        // Find the window element for this process
        let apps = self
            .desktop
            .applications()
            .map_err(|e| format!("Failed to get applications: {e}"))?;

        let window_element = apps
            .into_iter()
            .find(|app| app.process_id().unwrap_or(0) == pid)
            .ok_or_else(|| format!("No window found for PID {pid}"))?;

        // Get window bounds (absolute screen coordinates)
        let bounds = window_element
            .bounds()
            .map_err(|e| format!("Failed to get window bounds: {e}"))?;
        let (window_x, window_y, win_w, win_h) = bounds;

        // Capture screenshot of the window
        let screenshot = window_element
            .capture()
            .map_err(|e| format!("Failed to capture window screenshot: {e}"))?;

        // Get original screenshot dimensions
        let original_width = screenshot.width;
        let original_height = screenshot.height;

        // DPI DEBUG: Compare logical window bounds vs physical screenshot size
        let dpi_scale_w = original_width as f64 / win_w;
        let dpi_scale_h = original_height as f64 / win_h;
        info!(
            "OMNIPARSER DPI DEBUG: window_bounds(logical)=({:.0},{:.0},{:.0},{:.0}), screenshot(physical)={}x{}, dpi_scale=({:.3},{:.3})",
            window_x, window_y, win_w, win_h, original_width, original_height, dpi_scale_w, dpi_scale_h
        );

        // Convert BGRA to RGBA (xcap returns BGRA format)
        let rgba_data: Vec<u8> = screenshot
            .image_data
            .chunks_exact(4)
            .flat_map(|bgra| [bgra[2], bgra[1], bgra[0], bgra[3]]) // B,G,R,A -> R,G,B,A
            .collect();

        // Apply resize if needed (max 1920px to match Replicate's imgsz limit)
        const MAX_DIM: u32 = 1920;
        let (final_width, final_height, final_rgba_data, scale_factor) = if original_width > MAX_DIM
            || original_height > MAX_DIM
        {
            // Calculate new dimensions maintaining aspect ratio
            let scale = (MAX_DIM as f32 / original_width.max(original_height) as f32).min(1.0);
            let new_width = (original_width as f32 * scale).round() as u32;
            let new_height = (original_height as f32 * scale).round() as u32;

            // Create ImageBuffer from RGBA data and resize
            let img =
                ImageBuffer::<Rgba<u8>, _>::from_raw(original_width, original_height, rgba_data)
                    .ok_or_else(|| {
                        "Failed to create image buffer from screenshot data".to_string()
                    })?;

            let resized =
                image::imageops::resize(&img, new_width, new_height, FilterType::Lanczos3);

            info!(
                "OmniParser: Resized screenshot from {}x{} to {}x{} (scale: {:.2})",
                original_width, original_height, new_width, new_height, scale
            );

            (new_width, new_height, resized.into_raw(), scale as f64)
        } else {
            (original_width, original_height, rgba_data, 1.0)
        };

        // Encode to PNG
        let mut png_data = Vec::new();
        let encoder = PngEncoder::new(Cursor::new(&mut png_data));
        encoder
            .write_image(
                &final_rgba_data,
                final_width,
                final_height,
                ExtendedColorType::Rgba8,
            )
            .map_err(|e| format!("Failed to encode screenshot to PNG: {e}"))?;

        let base64_image = general_purpose::STANDARD.encode(&png_data);

        info!(
            "OmniParser: Sending {}x{} image ({} KB)",
            final_width,
            final_height,
            png_data.len() / 1024
        );

        // Call OmniParser backend with imgsz=1920 for best detection
        let (items, _raw_json) = crate::omniparser::parse_image_with_backend(
            &base64_image,
            final_width,
            final_height,
            Some(MAX_DIM), // Use max imgsz for best detection quality
        )
        .await
        .map_err(|e| format!("Omniparser failed: {e}"))?;

        // Convert coordinates to absolute screen coordinates
        // If image was resized, scale coordinates back to original size first
        // Then apply DPI scaling to convert from physical to logical coordinates
        let mut absolute_items = Vec::new();
        for item in items {
            let mut new_item = item.clone();
            if let Some(box_2d) = new_item.box_2d {
                // box_2d is [x_min, y_min, x_max, y_max] relative to the (possibly resized) screenshot
                // 1. Scale back to original screenshot size if image was resized (inv_scale)
                // 2. Convert from physical to logical coords (divide by dpi_scale)
                // 3. Add logical window offset
                let inv_scale = 1.0 / scale_factor;
                new_item.box_2d = Some([
                    window_x + (box_2d[0] * inv_scale / dpi_scale_w),
                    window_y + (box_2d[1] * inv_scale / dpi_scale_h),
                    window_x + (box_2d[2] * inv_scale / dpi_scale_w),
                    window_y + (box_2d[3] * inv_scale / dpi_scale_h),
                ]);
            }
            absolute_items.push(new_item);
        }

        Ok(absolute_items)
    }

    /// Perform Gemini Vision detection on a window by its process ID
    async fn perform_gemini_vision_for_process(
        &self,
        pid: u32,
    ) -> Result<Vec<crate::vision::VisionElement>, String> {
        // Find the window element for this process
        let apps = self
            .desktop
            .applications()
            .map_err(|e| format!("Failed to get applications: {e}"))?;

        let window_element = apps
            .into_iter()
            .find(|app| app.process_id().unwrap_or(0) == pid)
            .ok_or_else(|| format!("No window found for PID {pid}"))?;

        // Get window bounds (absolute screen coordinates)
        let bounds = window_element
            .bounds()
            .map_err(|e| format!("Failed to get window bounds: {e}"))?;
        let (window_x, window_y, win_w, win_h) = bounds;

        // Capture screenshot of the window
        let screenshot = window_element
            .capture()
            .map_err(|e| format!("Failed to capture window screenshot: {e}"))?;

        // Get original screenshot dimensions
        let original_width = screenshot.width;
        let original_height = screenshot.height;

        // DPI DEBUG: Compare logical window bounds vs physical screenshot size
        let dpi_scale_w = original_width as f64 / win_w;
        let dpi_scale_h = original_height as f64 / win_h;
        info!(
            "GEMINI VISION DPI DEBUG: window_bounds(logical)=({:.0},{:.0},{:.0},{:.0}), screenshot(physical)={}x{}, dpi_scale=({:.3},{:.3})",
            window_x, window_y, win_w, win_h, original_width, original_height, dpi_scale_w, dpi_scale_h
        );

        // Convert BGRA to RGBA (xcap returns BGRA format)
        let rgba_data: Vec<u8> = screenshot
            .image_data
            .chunks_exact(4)
            .flat_map(|bgra| [bgra[2], bgra[1], bgra[0], bgra[3]]) // B,G,R,A -> R,G,B,A
            .collect();

        // Apply resize if needed (max 1920px for reasonable upload size)
        const MAX_DIM: u32 = 1920;
        let (final_width, final_height, final_rgba_data, scale_factor) = if original_width > MAX_DIM
            || original_height > MAX_DIM
        {
            // Calculate new dimensions maintaining aspect ratio
            let scale = (MAX_DIM as f32 / original_width.max(original_height) as f32).min(1.0);
            let new_width = (original_width as f32 * scale).round() as u32;
            let new_height = (original_height as f32 * scale).round() as u32;

            // Create ImageBuffer from RGBA data and resize
            let img =
                ImageBuffer::<Rgba<u8>, _>::from_raw(original_width, original_height, rgba_data)
                    .ok_or_else(|| {
                        "Failed to create image buffer from screenshot data".to_string()
                    })?;

            let resized =
                image::imageops::resize(&img, new_width, new_height, FilterType::Lanczos3);

            info!(
                "Gemini Vision: Resized screenshot from {}x{} to {}x{} (scale: {:.2})",
                original_width, original_height, new_width, new_height, scale
            );

            (new_width, new_height, resized.into_raw(), scale as f64)
        } else {
            (original_width, original_height, rgba_data, 1.0)
        };

        // Encode to PNG
        let mut png_data = Vec::new();
        let encoder = PngEncoder::new(Cursor::new(&mut png_data));
        encoder
            .write_image(
                &final_rgba_data,
                final_width,
                final_height,
                ExtendedColorType::Rgba8,
            )
            .map_err(|e| format!("Failed to encode screenshot to PNG: {e}"))?;

        let base64_image = general_purpose::STANDARD.encode(&png_data);

        info!(
            "Gemini Vision: Sending {}x{} image ({} KB)",
            final_width,
            final_height,
            png_data.len() / 1024
        );

        // Call Gemini Vision backend
        let (items, _raw_json) =
            crate::vision::parse_image_with_gemini(&base64_image, final_width, final_height)
                .await
                .map_err(|e| format!("Gemini Vision failed: {e}"))?;

        // Convert coordinates to absolute screen coordinates
        // If image was resized, scale coordinates back to original size first
        // Then apply DPI scaling to convert from physical to logical coordinates
        let mut absolute_items = Vec::new();
        for item in items {
            let mut new_item = item.clone();
            if let Some(box_2d) = new_item.box_2d {
                // box_2d is [x_min, y_min, x_max, y_max] relative to the (possibly resized) screenshot
                // 1. Scale back to original screenshot size if image was resized (inv_scale)
                // 2. Convert from physical to logical coords (divide by dpi_scale)
                // 3. Add logical window offset
                let inv_scale = 1.0 / scale_factor;
                new_item.box_2d = Some([
                    window_x + (box_2d[0] * inv_scale / dpi_scale_w),
                    window_y + (box_2d[1] * inv_scale / dpi_scale_h),
                    window_x + (box_2d[2] * inv_scale / dpi_scale_w),
                    window_y + (box_2d[3] * inv_scale / dpi_scale_h),
                ]);
            }
            absolute_items.push(new_item);
        }

        Ok(absolute_items)
    }

    /// Perform OCR on a window by its process ID and return structured results with bounding boxes
    #[cfg(target_os = "windows")]
    async fn perform_ocr_for_process(&self, pid: u32) -> Result<computeruse::OcrElement, String> {
        // Find the window element for this process
        let apps = self
            .desktop
            .applications()
            .map_err(|e| format!("Failed to get applications: {e}"))?;

        let window_element = apps
            .into_iter()
            .find(|app| app.process_id().unwrap_or(0) == pid)
            .ok_or_else(|| format!("No window found for PID {pid}"))?;

        // Get window bounds (absolute screen coordinates)
        let bounds = window_element
            .bounds()
            .map_err(|e| format!("Failed to get window bounds: {e}"))?;

        let (window_x, window_y, win_w, win_h) = bounds;

        // Capture screenshot of the window
        let screenshot = window_element
            .capture()
            .map_err(|e| format!("Failed to capture window screenshot: {e}"))?;

        // Calculate DPI scale factors (physical screenshot pixels / logical window size)
        let dpi_scale_w = screenshot.width as f64 / win_w;
        let dpi_scale_h = screenshot.height as f64 / win_h;
        info!(
            "OCR DPI: window_bounds(logical)=({:.0},{:.0},{:.0},{:.0}), screenshot(physical)={}x{}, dpi_scale=({:.3},{:.3})",
            window_x, window_y, win_w, win_h, screenshot.width, screenshot.height, dpi_scale_w, dpi_scale_h
        );

        // Perform OCR with bounding boxes using Desktop's method
        // Pass DPI scale factors to convert physical OCR coords to logical screen coords
        self.desktop
            .ocr_screenshot_with_bounds(&screenshot, window_x, window_y, dpi_scale_w, dpi_scale_h)
            .map_err(|e| format!("OCR failed: {e}"))
    }

    #[cfg(not(target_os = "windows"))]
    async fn perform_ocr_for_process(&self, _pid: u32) -> Result<computeruse::OcrElement, String> {
        Err("OCR with bounding boxes is currently only supported on Windows".to_string())
    }

    #[tool(
        description = "Get UI tree for a process. Use ONLY at task start or for special modes (OCR, DOM, Omniparser, Gemini vision). Do NOT call after action tools - use their ui_diff_before_after/include_tree_after_action params instead. Options: include_browser_dom for DOM, include_ocr for text, include_omniparser for icons, include_gemini_vision for AI detection. tree_max_depth limits depth, tree_from_selector focuses on subtree. Read-only."
    )]
    pub async fn get_window_tree(
        &self,
        Parameters(args): Parameters<GetWindowTreeArgs>,
    ) -> Result<CallToolResult, McpError> {
        // Start telemetry span
        let mut span = StepSpan::new("get_window_tree", None);
        span.set_attribute("process", args.process.clone());
        if let Some(title) = &args.title {
            span.set_attribute("window_title", title.clone());
        }
        span.set_attribute(
            "include_detailed_attributes",
            args.tree
                .include_detailed_attributes
                .unwrap_or(true)
                .to_string(),
        );

        // Check if we need to perform window management (only for direct MCP calls, not sequences)
        let should_restore = {
            let in_sequence = self.in_sequence.lock().unwrap_or_else(|e| e.into_inner());
            !*in_sequence
        };

        if should_restore {
            tracing::info!(
                "[get_window_tree] Direct MCP call detected - performing window management"
            );
            let _ = self
                .prepare_window_management(&args.process, None, None, None, &args.window_mgmt)
                .await;
        } else {
            tracing::debug!("[get_window_tree] In sequence - skipping window management (dispatch_tool handles it)");
        }

        // Find PID for the process name using shared function
        let pid = computeruse::find_pid_for_process(&self.desktop, &args.process).map_err(|e| {
            McpError::resource_not_found(
                format!(
                    "Process '{}' not found. Use open_application to start it first.",
                    args.process
                ),
                Some(json!({"process": args.process, "error": e.to_string()})),
            )
        })?;

        span.set_attribute("pid", pid.to_string());

        // Detect if this is a browser window
        let is_browser = Self::detect_browser_by_pid(pid);

        // Build the base result JSON first
        let mut result_json = json!({
            "action": "get_window_tree",
            "status": "executed_without_error",
            "process": args.process,
            "pid": pid,
            "title": args.title,
            "detailed_attributes": args.tree.include_detailed_attributes.unwrap_or(true),
            "timestamp": chrono::Utc::now().to_rfc3339(),
        });

        // Add browser detection metadata
        if is_browser {
            result_json["is_browser"] = json!(true);
            info!("Browser window detected for PID {}", pid);

            // Try to capture DOM elements from browser (if enabled)
            // Use timeout to prevent indefinite hangs (default 15 seconds)
            if args.include_browser_dom {
                let max_dom_elements = args.browser_dom_max_elements.unwrap_or(200);
                let dom_timeout = std::time::Duration::from_secs(15);
                let dom_result = tokio::time::timeout(
                    dom_timeout,
                    self.capture_browser_dom_elements(max_dom_elements),
                )
                .await;

                match dom_result {
                    Err(_timeout) => {
                        warn!(
                            "[get_window_tree] DOM capture timed out after {}s",
                            dom_timeout.as_secs()
                        );
                        result_json["browser_dom_error"] = json!(format!(
                            "DOM capture timed out after {}s",
                            dom_timeout.as_secs()
                        ));
                    }
                    Ok(Err(e)) => {
                        warn!("Failed to capture browser DOM: {}", e);
                        result_json["browser_dom_error"] = json!(e.to_string());
                    }
                    Ok(Ok((dom_elements, viewport_offset_x, viewport_offset_y))) => {
                        if dom_elements.is_empty() {
                            info!("Browser detected but no DOM elements captured (extension may not be available)");
                            result_json["browser_dom_error"] = json!(
                                "No DOM elements captured - Chrome extension may not be installed or active"
                            );
                        } else {
                            // Format based on tree_output_format
                            let format = args
                                .tree
                                .tree_output_format
                                .unwrap_or(crate::mcp_types::TreeOutputFormat::CompactYaml);

                            match format {
                                crate::mcp_types::TreeOutputFormat::CompactYaml
                                | crate::mcp_types::TreeOutputFormat::ClusteredYaml => {
                                    let dom_result =
                                        crate::tree_formatter::format_browser_dom_as_compact_yaml(
                                            &dom_elements,
                                        );
                                    result_json["browser_dom"] = json!(dom_result.formatted);

                                    // Store DOM bounds with screen coordinates applied
                                    if let Ok(mut cache) = self.dom_bounds.lock() {
                                        cache.clear();
                                        let mut first_logged = false;
                                        for (index, (tag, identifier, (x, y, w, h))) in
                                            dom_result.index_to_bounds
                                        {
                                            // Convert viewport-relative to screen coordinates
                                            let screen_x = x + viewport_offset_x;
                                            let screen_y = y + viewport_offset_y;
                                            // DPI DEBUG: Log first element conversion
                                            if !first_logged {
                                                info!(
                                                    "DOM DPI DEBUG: viewport_offset=({:.0},{:.0}), first_elem viewport_rel=({:.0},{:.0}), screen=({:.0},{:.0})",
                                                    viewport_offset_x, viewport_offset_y, x, y, screen_x, screen_y
                                                );
                                                first_logged = true;
                                            }
                                            cache.insert(
                                                index,
                                                (tag, identifier, (screen_x, screen_y, w, h)),
                                            );
                                        }
                                        info!(
                                            "Stored {} DOM element bounds for click_index",
                                            cache.len()
                                        );
                                    }
                                }
                                crate::mcp_types::TreeOutputFormat::VerboseJson => {
                                    result_json["browser_dom"] = json!(dom_elements);
                                }
                            }
                            result_json["browser_dom_count"] = json!(dom_elements.len());
                            info!("Captured {} DOM elements from browser", dom_elements.len());
                        }
                    }
                }
            }
        }

        // Use maybe_attach_tree to handle tree extraction with from_selector support
        // Store the returned bounds cache for click_index tool
        // Enable include_all_bounds when showing ui_tree overlay (need bounds for all elements)
        let include_all_bounds = args
            .show_overlay
            .as_ref()
            .map(|s| s == "ui_tree")
            .unwrap_or(false);
        if let Some(bounds_cache) = crate::helpers::maybe_attach_tree(
            &self.desktop,
            args.tree.include_tree_after_action,
            args.tree.tree_max_depth,
            args.tree.tree_from_selector.as_deref(),
            args.tree.include_detailed_attributes,
            args.tree.tree_output_format,
            Some(pid),
            &mut result_json,
            None, // No found element for window tree
            include_all_bounds,
        )
        .await
        {
            if let Ok(mut cache) = self.uia_bounds.lock() {
                *cache = bounds_cache;
            }
        }

        // Perform OCR if requested
        if args.include_ocr {
            match self.perform_ocr_for_process(pid).await {
                Ok(ocr_result) => {
                    // Format OCR tree based on tree_output_format (same as UI tree)
                    let format = args
                        .tree
                        .tree_output_format
                        .unwrap_or(crate::mcp_types::TreeOutputFormat::CompactYaml);

                    match format {
                        crate::mcp_types::TreeOutputFormat::CompactYaml
                        | crate::mcp_types::TreeOutputFormat::ClusteredYaml => {
                            let ocr_formatting_result =
                                crate::tree_formatter::format_ocr_tree_as_compact_yaml(
                                    &ocr_result,
                                    0,
                                );
                            // Store the index-to-bounds mapping for click_ocr_index
                            if let Ok(mut bounds) = self.ocr_bounds.lock() {
                                *bounds = ocr_formatting_result.index_to_bounds;
                            }
                            result_json["ocr_tree"] = json!(ocr_formatting_result.formatted);
                        }
                        crate::mcp_types::TreeOutputFormat::VerboseJson => {
                            result_json["ocr_tree"] =
                                serde_json::to_value(&ocr_result).unwrap_or_default();
                        }
                    }
                    info!("OCR completed for PID {}", pid);
                }
                Err(e) => {
                    warn!("OCR failed for PID {}: {}", pid, e);
                    result_json["ocr_error"] = json!(e.to_string());
                }
            }
        }

        // Perform Omniparser if requested
        if args.include_omniparser {
            match self.perform_omniparser_for_process(pid).await {
                Ok(items) => {
                    // Format Omniparser tree based on tree_output_format (same as UI tree)
                    let format = args
                        .tree
                        .tree_output_format
                        .unwrap_or(crate::mcp_types::TreeOutputFormat::CompactYaml);

                    match format {
                        crate::mcp_types::TreeOutputFormat::CompactYaml
                        | crate::mcp_types::TreeOutputFormat::ClusteredYaml => {
                            let (formatted, cache) =
                                crate::tree_formatter::format_omniparser_tree_as_compact_yaml(
                                    &items,
                                );
                            if let Ok(mut locked_cache) = self.omniparser_items.lock() {
                                *locked_cache = cache;
                            }
                            result_json["omniparser_tree"] = json!(formatted);
                        }
                        crate::mcp_types::TreeOutputFormat::VerboseJson => {
                            let mut omniparser_tree = Vec::new();
                            let mut cache = HashMap::new();

                            for (i, item) in items.iter().enumerate() {
                                let index = (i + 1) as u32;
                                cache.insert(index, item.clone());

                                omniparser_tree.push(json!({
                                    "index": index,
                                    "label": item.label,
                                    "content": item.content,
                                    "bounds": item.box_2d,
                                }));
                            }

                            if let Ok(mut locked_cache) = self.omniparser_items.lock() {
                                *locked_cache = cache;
                            }

                            result_json["omniparser_tree"] = json!(omniparser_tree);
                        }
                    }
                    info!("Omniparser completed for PID {}", pid);
                }
                Err(e) => {
                    warn!("Omniparser failed for PID {}: {}", pid, e);
                    result_json["omniparser_error"] = json!(e.to_string());
                }
            }
        }

        // Perform Gemini Vision if requested
        if args.include_gemini_vision {
            match self.perform_gemini_vision_for_process(pid).await {
                Ok(items) => {
                    // Format Vision tree based on tree_output_format (same as UI tree)
                    let format = args
                        .tree
                        .tree_output_format
                        .unwrap_or(crate::mcp_types::TreeOutputFormat::CompactYaml);

                    match format {
                        crate::mcp_types::TreeOutputFormat::CompactYaml
                        | crate::mcp_types::TreeOutputFormat::ClusteredYaml => {
                            let (formatted, cache) =
                                crate::tree_formatter::format_vision_tree_as_compact_yaml(&items);
                            if let Ok(mut locked_cache) = self.vision_items.lock() {
                                *locked_cache = cache;
                            }
                            result_json["vision_tree"] = json!(formatted);
                        }
                        crate::mcp_types::TreeOutputFormat::VerboseJson => {
                            let mut vision_tree = Vec::new();
                            let mut cache = HashMap::new();

                            for (i, item) in items.iter().enumerate() {
                                let index = (i + 1) as u32;
                                cache.insert(index, item.clone());

                                vision_tree.push(json!({
                                    "index": index,
                                    "type": item.element_type,
                                    "content": item.content,
                                    "description": item.description,
                                    "interactivity": item.interactivity,
                                    "bounds": item.box_2d,
                                }));
                            }

                            if let Ok(mut locked_cache) = self.vision_items.lock() {
                                *locked_cache = cache;
                            }

                            result_json["vision_tree"] = json!(vision_tree);
                        }
                    }
                    result_json["include_gemini_vision"] = json!(true);
                    info!("Gemini Vision completed for PID {}", pid);
                }
                Err(e) => {
                    warn!("Gemini Vision failed for PID {}: {}", pid, e);
                    result_json["vision_error"] = json!(e.to_string());
                }
            }
        }

        // Generate clustered output if requested
        if args
            .tree
            .tree_output_format
            .map(|f| matches!(f, crate::mcp_types::TreeOutputFormat::ClusteredYaml))
            .unwrap_or(false)
        {
            // Gather cached bounds from each source
            let uia_bounds_snapshot = self
                .uia_bounds
                .lock()
                .map(|g| g.clone())
                .unwrap_or_default();
            let dom_bounds_snapshot = self
                .dom_bounds
                .lock()
                .map(|g| g.clone())
                .unwrap_or_default();
            let ocr_bounds_snapshot = self
                .ocr_bounds
                .lock()
                .map(|g| g.clone())
                .unwrap_or_default();
            let omniparser_snapshot = self
                .omniparser_items
                .lock()
                .map(|g| g.clone())
                .unwrap_or_default();
            let vision_snapshot = self
                .vision_items
                .lock()
                .map(|g| g.clone())
                .unwrap_or_default();

            // Cluster and format all elements from all sources
            let clustered_result = crate::tree_formatter::format_clustered_tree_from_caches(
                &uia_bounds_snapshot,
                &dom_bounds_snapshot,
                &ocr_bounds_snapshot,
                &omniparser_snapshot,
                &vision_snapshot,
            );

            result_json["clustered_tree"] = json!(clustered_result.formatted);

            // Store the clustered bounds cache
            let element_count = clustered_result.index_to_source_and_bounds.len();
            if let Ok(mut cache) = self.clustered_bounds.lock() {
                *cache = clustered_result.index_to_source_and_bounds;
            }

            info!("Clustered tree generated with {} elements", element_count);
        }

        // Handle show_overlay request
        #[cfg(target_os = "windows")]
        if let Some(ref overlay_type) = args.show_overlay {
            // Parse display mode from args
            let display_mode = match args.overlay_display_mode.as_deref() {
                Some("rectangles") => computeruse::OverlayDisplayMode::Rectangles,
                Some("index") | None => computeruse::OverlayDisplayMode::Index,
                Some("role") => computeruse::OverlayDisplayMode::Role,
                Some("index_role") => computeruse::OverlayDisplayMode::IndexRole,
                Some("name") => computeruse::OverlayDisplayMode::Name,
                Some("index_name") => computeruse::OverlayDisplayMode::IndexName,
                Some("full") => computeruse::OverlayDisplayMode::Full,
                Some(other) => {
                    result_json["overlay_error"] = json!(format!("Unknown overlay_display_mode: '{}'. Valid options: rectangles, index, role, index_role, name, index_name, full", other));
                    computeruse::OverlayDisplayMode::Index // fallback to default
                }
            };

            match overlay_type.as_str() {
                "ui_tree" => {
                    // Use UIA bounds from uia_bounds cache (like OCR/DOM do)
                    if let Ok(uia_bounds) = self.uia_bounds.lock() {
                        let elements: Vec<computeruse::InspectElement> = uia_bounds
                            .iter()
                            .map(|(idx, (role, name, bounds, _selector))| {
                                computeruse::InspectElement {
                                    index: *idx,
                                    role: role.clone(),
                                    name: if name.is_empty() {
                                        None
                                    } else {
                                        Some(name.clone())
                                    },
                                    bounds: *bounds,
                                }
                            })
                            .collect();

                        if !elements.is_empty() {
                            if let Ok(apps) = self.desktop.applications() {
                                if let Some(app) =
                                    apps.iter().find(|a| a.process_id().ok() == Some(pid))
                                {
                                    if let Ok((x, y, w, h)) = app.bounds() {
                                        if let Ok(mut handle) = self.inspect_overlay_handle.lock() {
                                            *handle = None;
                                        }
                                        computeruse::hide_inspect_overlay();

                                        match computeruse::show_inspect_overlay(
                                            elements,
                                            (x as i32, y as i32, w as i32, h as i32),
                                            display_mode,
                                        ) {
                                            Ok(new_handle) => {
                                                if let Ok(mut handle) =
                                                    self.inspect_overlay_handle.lock()
                                                {
                                                    *handle = Some(new_handle);
                                                }
                                                result_json["overlay_shown"] = json!("ui_tree");
                                                info!("Inspect overlay shown for ui_tree");
                                            }
                                            Err(e) => {
                                                warn!("Failed to show inspect overlay: {}", e);
                                                result_json["overlay_error"] = json!(e.to_string());
                                            }
                                        }
                                    }
                                }
                            }
                        } else {
                            result_json["overlay_error"] = json!("No UI elements with bounds in cache - ensure include_tree_after_action is true");
                        }
                    }
                }
                "ocr" => {
                    // Use OCR bounds from ocr_bounds cache
                    if let Ok(ocr_bounds) = self.ocr_bounds.lock() {
                        let elements: Vec<computeruse::InspectElement> = ocr_bounds
                            .iter()
                            .map(|(idx, (text, bounds))| computeruse::InspectElement {
                                index: *idx,
                                role: "OCR".to_string(),
                                name: Some(text.clone()),
                                bounds: *bounds,
                            })
                            .collect();

                        if !elements.is_empty() {
                            // DPI DEBUG: Log sample element bounds for OCR
                            if let Some(first) = elements.first() {
                                info!(
                                    "OCR OVERLAY DEBUG: first_element bounds=({:.0},{:.0},{:.0},{:.0})",
                                    first.bounds.0, first.bounds.1, first.bounds.2, first.bounds.3
                                );
                            }
                            if let Ok(apps) = self.desktop.applications() {
                                if let Some(app) =
                                    apps.iter().find(|a| a.process_id().ok() == Some(pid))
                                {
                                    if let Ok((x, y, w, h)) = app.bounds() {
                                        info!(
                                            "OCR OVERLAY DEBUG: window_bounds for overlay=({:.0},{:.0},{:.0},{:.0})",
                                            x, y, w, h
                                        );
                                        if let Ok(mut handle) = self.inspect_overlay_handle.lock() {
                                            *handle = None;
                                        }
                                        computeruse::hide_inspect_overlay();

                                        match computeruse::show_inspect_overlay(
                                            elements,
                                            (x as i32, y as i32, w as i32, h as i32),
                                            display_mode,
                                        ) {
                                            Ok(new_handle) => {
                                                if let Ok(mut handle) =
                                                    self.inspect_overlay_handle.lock()
                                                {
                                                    *handle = Some(new_handle);
                                                }
                                                result_json["overlay_shown"] = json!("ocr");
                                            }
                                            Err(e) => {
                                                result_json["overlay_error"] = json!(e.to_string());
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                "omniparser" => {
                    // Use omniparser items from cache
                    if let Ok(omni_items) = self.omniparser_items.lock() {
                        let elements: Vec<computeruse::InspectElement> = omni_items
                            .iter()
                            .filter_map(|(idx, item)| {
                                // Convert box_2d [x_min, y_min, x_max, y_max] to (x, y, width, height)
                                item.box_2d.map(|b| computeruse::InspectElement {
                                    index: *idx,
                                    role: item.label.clone(),
                                    name: item.content.clone(),
                                    bounds: (b[0], b[1], b[2] - b[0], b[3] - b[1]),
                                })
                            })
                            .collect();

                        if !elements.is_empty() {
                            // DPI DEBUG: Log sample element bounds for omniparser
                            if let Some(first) = elements.first() {
                                info!(
                                    "OMNIPARSER OVERLAY DEBUG: first_element bounds=({:.0},{:.0},{:.0},{:.0})",
                                    first.bounds.0, first.bounds.1, first.bounds.2, first.bounds.3
                                );
                            }
                            if let Ok(apps) = self.desktop.applications() {
                                if let Some(app) =
                                    apps.iter().find(|a| a.process_id().ok() == Some(pid))
                                {
                                    if let Ok((x, y, w, h)) = app.bounds() {
                                        info!(
                                            "OMNIPARSER OVERLAY DEBUG: window_bounds for overlay=({:.0},{:.0},{:.0},{:.0})",
                                            x, y, w, h
                                        );
                                        if let Ok(mut handle) = self.inspect_overlay_handle.lock() {
                                            *handle = None;
                                        }
                                        computeruse::hide_inspect_overlay();

                                        match computeruse::show_inspect_overlay(
                                            elements,
                                            (x as i32, y as i32, w as i32, h as i32),
                                            display_mode,
                                        ) {
                                            Ok(new_handle) => {
                                                if let Ok(mut handle) =
                                                    self.inspect_overlay_handle.lock()
                                                {
                                                    *handle = Some(new_handle);
                                                }
                                                result_json["overlay_shown"] = json!("omniparser");
                                            }
                                            Err(e) => {
                                                result_json["overlay_error"] = json!(e.to_string());
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                "dom" => {
                    // Use DOM bounds from dom_bounds cache (populated by include_browser_dom)
                    if let Ok(dom_bounds) = self.dom_bounds.lock() {
                        let elements: Vec<computeruse::InspectElement> = dom_bounds
                            .iter()
                            .map(
                                |(idx, (tag, identifier, bounds))| computeruse::InspectElement {
                                    index: *idx,
                                    role: tag.clone(),
                                    name: if identifier.is_empty() {
                                        None
                                    } else {
                                        Some(identifier.clone())
                                    },
                                    bounds: *bounds,
                                },
                            )
                            .collect();

                        if !elements.is_empty() {
                            // DPI DEBUG: Log sample element bounds for DOM
                            if let Some(first) = elements.first() {
                                info!(
                                    "DOM OVERLAY DEBUG: first_element bounds=({:.0},{:.0},{:.0},{:.0})",
                                    first.bounds.0, first.bounds.1, first.bounds.2, first.bounds.3
                                );
                            }
                            if let Ok(apps) = self.desktop.applications() {
                                if let Some(app) =
                                    apps.iter().find(|a| a.process_id().ok() == Some(pid))
                                {
                                    if let Ok((x, y, w, h)) = app.bounds() {
                                        info!(
                                            "DOM OVERLAY DEBUG: window_bounds for overlay=({:.0},{:.0},{:.0},{:.0})",
                                            x, y, w, h
                                        );
                                        if let Ok(mut handle) = self.inspect_overlay_handle.lock() {
                                            *handle = None;
                                        }
                                        computeruse::hide_inspect_overlay();

                                        match computeruse::show_inspect_overlay(
                                            elements,
                                            (x as i32, y as i32, w as i32, h as i32),
                                            display_mode,
                                        ) {
                                            Ok(new_handle) => {
                                                if let Ok(mut handle) =
                                                    self.inspect_overlay_handle.lock()
                                                {
                                                    *handle = Some(new_handle);
                                                }
                                                result_json["overlay_shown"] = json!("dom");
                                                info!("Inspect overlay shown for DOM elements");
                                            }
                                            Err(e) => {
                                                result_json["overlay_error"] = json!(e.to_string());
                                            }
                                        }
                                    }
                                }
                            }
                        } else {
                            result_json["overlay_error"] = json!("No DOM elements in cache - ensure include_browser_dom is true and browser extension is active");
                        }
                    }
                }
                "gemini" => {
                    // Use Gemini vision items from cache
                    if let Ok(vision_items) = self.vision_items.lock() {
                        let elements: Vec<computeruse::InspectElement> = vision_items
                            .iter()
                            .filter_map(|(idx, item)| {
                                // Convert box_2d [x_min, y_min, x_max, y_max] to (x, y, width, height)
                                item.box_2d.map(|b| computeruse::InspectElement {
                                    index: *idx,
                                    role: item.element_type.clone(),
                                    name: item.content.clone(),
                                    bounds: (b[0], b[1], b[2] - b[0], b[3] - b[1]),
                                })
                            })
                            .collect();

                        if !elements.is_empty() {
                            // DPI DEBUG: Log sample element bounds for vision
                            if let Some(first) = elements.first() {
                                info!(
                                    "VISION OVERLAY DEBUG: first_element bounds=({:.0},{:.0},{:.0},{:.0})",
                                    first.bounds.0, first.bounds.1, first.bounds.2, first.bounds.3
                                );
                            }
                            if let Ok(apps) = self.desktop.applications() {
                                if let Some(app) =
                                    apps.iter().find(|a| a.process_id().ok() == Some(pid))
                                {
                                    if let Ok((x, y, w, h)) = app.bounds() {
                                        info!(
                                            "VISION OVERLAY DEBUG: window_bounds for overlay=({:.0},{:.0},{:.0},{:.0})",
                                            x, y, w, h
                                        );
                                        if let Ok(mut handle) = self.inspect_overlay_handle.lock() {
                                            *handle = None;
                                        }
                                        computeruse::hide_inspect_overlay();

                                        match computeruse::show_inspect_overlay(
                                            elements,
                                            (x as i32, y as i32, w as i32, h as i32),
                                            display_mode,
                                        ) {
                                            Ok(new_handle) => {
                                                if let Ok(mut handle) =
                                                    self.inspect_overlay_handle.lock()
                                                {
                                                    *handle = Some(new_handle);
                                                }
                                                result_json["overlay_shown"] = json!("gemini");
                                            }
                                            Err(e) => {
                                                result_json["overlay_error"] = json!(e.to_string());
                                            }
                                        }
                                    }
                                }
                            }
                        } else {
                            result_json["overlay_error"] = json!("No Gemini elements in cache - use include_gemini_vision=true first");
                        }
                    }
                }
                _ => {
                    result_json["overlay_error"] =
                        json!(format!("Unknown overlay type: {}", overlay_type));
                }
            }
        }

        span.set_status(true, None);
        span.end();

        append_window_screenshot_to_json(
            &self.desktop,
            &args.process,
            &mut result_json,
            args.window_screenshot.include_window_screenshot,
        )
        .await;
        let contents = vec![Content::json(result_json)?];
        let contents = append_monitor_screenshots_if_enabled(
            &self.desktop,
            contents,
            args.monitor.include_monitor_screenshots,
        )
        .await;

        self.restore_window_management(should_restore).await;

        Ok(CallToolResult::success(contents))
    }

    #[tool(
        description = "Get all applications and windows currently running with their process names. Returns a list with name, process_name, id, pid, and is_focused status for each application/window. Use this to check which applications are running and which window has focus before performing actions. This is a read-only operation that returns a simple list without UI trees."
    )]
    pub async fn get_applications_and_windows_list(
        &self,
        Parameters(_args): Parameters<GetApplicationsArgs>,
    ) -> Result<CallToolResult, McpError> {
        // Start telemetry span
        let mut span = StepSpan::new("get_applications_and_windows_list", None);

        let apps = self.desktop.applications().map_err(|e| {
            McpError::resource_not_found(
                "Failed to get applications",
                Some(json!({"reason": e.to_string()})),
            )
        })?;

        // Create System for process name lookup
        let mut system = System::new();
        system.refresh_processes(ProcessesToUpdate::All, true);

        // Build PID -> process_name map
        let process_names: HashMap<u32, String> = apps
            .iter()
            .filter_map(|app| {
                let pid = app.process_id().unwrap_or(0);
                if pid > 0 {
                    system
                        .process(sysinfo::Pid::from_u32(pid))
                        .map(|p| (pid, p.name().to_string_lossy().to_string()))
                } else {
                    None
                }
            })
            .collect();

        // Simple iteration - no async spawning needed (no tree fetching)
        let applications: Vec<_> = apps
            .iter()
            .map(|app| {
                let app_name = app.name().unwrap_or_default();
                let app_id = app.id().unwrap_or_default();
                let app_role = app.role();
                let app_pid = app.process_id().unwrap_or(0);
                let is_focused = app.is_focused().unwrap_or(false);
                let process_name = process_names.get(&app_pid).cloned();

                let suggested_selector = if !app_name.is_empty() {
                    format!("{}|{}", &app_role, &app_name)
                } else {
                    format!("#{app_id}")
                };

                json!({
                    "name": app_name,
                    "process_name": process_name,
                    "id": app_id,
                    "role": app_role,
                    "pid": app_pid,
                    "is_focused": is_focused,
                    "suggested_selector": suggested_selector
                })
            })
            .collect();

        let result_json = json!({
            "action": "get_applications_and_windows_list",
            "status": "executed_without_error",
            "applications": applications,
            "timestamp": chrono::Utc::now().to_rfc3339()
        });

        span.set_status(true, None);
        span.end();

        Ok(CallToolResult::success(vec![Content::json(result_json)?]))
    }

    // NOTE: ensure_element_in_view logic moved to computeruse backend UIElement::ensure_in_view()

    #[tool(
        description = "Types text into a UI element with smart clipboard optimization and verification. Much faster than press key. REQUIRED: clear_before_typing parameter - set to true to clear existing text, false to append. Use ui_diff_before_after:true to see changes (no need to call get_window_tree after). Trailing special keys like {Enter}, {Tab}, {Escape} are auto-detected and pressed after typing (e.g., 'search query{Enter}' types the query then presses Enter)."
    )]
    async fn type_into_element(
        &self,
        Parameters(args): Parameters<TypeIntoElementArgs>,
    ) -> Result<CallToolResult, McpError> {
        let _operation_start = std::time::Instant::now();
        let mut span = StepSpan::new("type_into_element", None);

        // Add comprehensive telemetry attributes
        span.set_attribute("selector", args.selector.selector.clone());
        span.set_attribute("text.length", args.text_to_type.len().to_string());
        span.set_attribute("clear_before_typing", args.clear_before_typing.to_string());
        // Auto-verification is now built into the core library
        span.set_attribute("verification.auto", "true".to_string());
        if let Some(timeout) = args.timeout_ms {
            span.set_attribute("timeout_ms", timeout.to_string());
        }
        if let Some(retries) = args.retries {
            span.set_attribute("retry.max_attempts", retries.to_string());
        }

        tracing::info!(
            "[type_into_element] Called with selector: '{}', process: {:?}, window_selector: {:?}",
            args.selector.selector,
            args.selector.process,
            args.selector.window_selector
        );

        // Check if we need to perform window management (only for direct MCP calls, not sequences)
        let should_restore = {
            let in_sequence = self.in_sequence.lock().unwrap_or_else(|e| e.into_inner());
            let flag_value = *in_sequence;
            let should_restore_value = !flag_value;
            tracing::info!(
                "[type_into_element] Flag check: in_sequence={}, should_restore={}",
                flag_value,
                should_restore_value
            );
            should_restore_value
        };

        // Extract trailing special keys (e.g., {Enter}) from text
        // AI models often pass "text{Enter}" expecting Enter to be pressed after typing
        let (actual_text, trailing_keys) =
            crate::helpers::extract_trailing_keys(&args.text_to_type);
        let has_trailing_keys = !trailing_keys.is_empty();

        // Add telemetry for trailing keys extraction
        if has_trailing_keys {
            span.set_attribute("trailing_keys.count", trailing_keys.len().to_string());
            span.set_attribute("trailing_keys.keys", trailing_keys.join(","));
            span.set_attribute("text.actual_length", actual_text.len().to_string());
        }

        let text_to_type = actual_text.clone();
        let trailing_keys_for_closure = trailing_keys.clone();
        let should_clear = args.clear_before_typing;
        let try_focus_before = args.try_focus_before;
        let try_click_before = args.try_click_before;
        let restore_focus = args.restore_focus;
        let highlight_before = args.highlight.highlight_before_action;

        // CRITICAL: Save focus state HERE at MCP level BEFORE any window activation
        // Both prepare_window_management() and activate_window() steal focus,
        // so we must save BEFORE either of them runs
        //
        // FocusState is Send + Sync (COM objects in MTA mode support cross-thread access)
        use computeruse::platforms::windows::{restore_focus_state, save_focus_state};
        let saved_focus_state = if restore_focus {
            tracing::info!(
                "[type_into_element] Saving focus state BEFORE window management (MCP level)"
            );
            save_focus_state()
        } else {
            None
        };

        if should_restore {
            tracing::info!(
                "[type_into_element] Direct MCP call detected - performing window management"
            );
            let _ = self
                .prepare_window_management(
                    &args.selector.process,
                    None,
                    None,
                    None,
                    &args.window_mgmt,
                )
                .await;
        } else {
            tracing::debug!("[type_into_element] In sequence - skipping window management (dispatch_tool handles it)");
        }

        let action = {
            move |element: UIElement| {
                let text_to_type = text_to_type.clone();
                let trailing_keys = trailing_keys_for_closure.clone();
                async move {
                    // Activate window to ensure it has keyboard focus before typing
                    if let Err(e) = element.activate_window() {
                        tracing::warn!("Failed to activate window before typing: {}", e);
                    }

                    // Apply highlighting before action if enabled
                    if highlight_before {
                        let _ = element.highlight_before_action("type");
                    }

                    // Execute the typing action with state tracking
                    // NOTE: restore_focus=false - MCP handles restoration after find_and_execute
                    // NOTE: Overlay is handled by element.type_text_with_state_and_focus_restore
                    if should_clear {
                        if let Err(clear_error) = element.set_value("") {
                            warn!(
                                "Warning: Failed to clear element before typing: {}",
                                clear_error
                            );
                        }
                    }

                    // Type the text (without trailing keys)
                    let type_result = element.type_text_with_state_and_focus_restore(
                        &text_to_type,
                        true,
                        try_focus_before,
                        try_click_before,
                        false, // Don't restore at core level - MCP handles it
                    );

                    // Press any trailing keys after typing (e.g., {Enter})
                    if type_result.is_ok() && !trailing_keys.is_empty() {
                        for key in &trailing_keys {
                            tracing::info!("[type_into_element] Pressing trailing key: {}", key);
                            // Small delay before pressing key to let UI settle
                            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                            if let Err(e) = element.press_key(key) {
                                tracing::warn!(
                                    "[type_into_element] Failed to press trailing key {}: {}",
                                    key,
                                    e
                                );
                            }
                        }
                    }

                    type_result
                }
            }
        };

        let operation_start = std::time::Instant::now();

        // Store tree config to avoid move issues
        let tree_output_format = args
            .tree
            .tree_output_format
            .unwrap_or(crate::mcp_types::TreeOutputFormat::CompactYaml);

        // Build scoped selectors
        let full_selector = args.selector.build_full_selector();
        let alternative_selectors = args.selector.build_alternative_selectors();
        let fallback_selectors = args.selector.build_fallback_selectors();

        let ((result, element), successful_selector, ui_diff) =
            match crate::helpers::find_and_execute_with_ui_diff(
                &self.desktop,
                &full_selector,
                alternative_selectors.as_deref(),
                fallback_selectors.as_deref(),
                args.timeout_ms,
                args.retries,
                action,
                args.tree.ui_diff_before_after,
                args.tree.tree_max_depth,
                args.tree.include_detailed_attributes,
                tree_output_format,
            )
            .await
            {
                Ok(((result, element), selector, diff)) => {
                    let operation_time_ms = operation_start.elapsed().as_millis() as i64;
                    span.set_attribute("operation.duration_ms", operation_time_ms.to_string());
                    span.set_attribute("element.found", "true".to_string());
                    span.set_attribute("selector.successful", selector.clone());
                    if diff.is_some() {
                        span.set_attribute("ui_diff.captured", "true".to_string());
                    }

                    // Add element metadata
                    if let Some(name) = element.name() {
                        span.set_attribute("element.name", name);
                    }
                    if let Ok(focused) = element.is_focused() {
                        span.set_attribute("element.is_focused", focused.to_string());
                    }

                    Ok(((result, element), selector, diff))
                }
                Err(e) => {
                    // Note: Cannot use span here as it would be moved if we call span.end()
                    Err(build_element_not_found_error(
                        &args.selector.build_full_selector(),
                        args.selector.build_alternative_selectors().as_deref(),
                        args.selector.build_fallback_selectors().as_deref(),
                        e,
                    ))
                }
            }?;

        // CRITICAL: Restore focus state AFTER typing is complete
        // This must happen after find_and_execute but before returning results
        if let Some(state) = saved_focus_state {
            tracing::info!("[type_into_element] Restoring focus state (MCP level)");
            restore_focus_state(state);
        }

        let mut result_json = json!({
            "action": "type_into_element",
            "status": "executed_without_error",
            "text_typed": actual_text,
            "trailing_keys_pressed": trailing_keys,
            "original_input": args.text_to_type,
            "cleared_before_typing": args.clear_before_typing,
            "action_result": {
                "action": result.action,
                "details": result.details,
                "data": result.data,
            },
            "element": build_element_info(&element),
            "selector_used": successful_selector,
            "selectors_tried": get_selectors_tried_all(&args.selector.build_full_selector(), args.selector.build_alternative_selectors().as_deref(), args.selector.build_fallback_selectors().as_deref()),
            "timestamp": chrono::Utc::now().to_rfc3339(),
        });

        // AUTO-VERIFICATION: Core library handles verification via result.verification
        // The type_text_with_state function now auto-verifies by reading element value
        if let Some(ref verification) = result.verification {
            span.set_attribute("verification.method", "direct_value_read".to_string());
            span.set_attribute("verification.passed", verification.passed.to_string());

            if !verification.passed {
                tracing::error!(
                    "[type_into_element] Auto-verification failed: expected '{}', got '{:?}'",
                    verification.expected,
                    verification.actual
                );
                span.set_status(false, Some("Value verification failed"));
                span.end();
                return Err(McpError::internal_error(
                    format!(
                        "Value verification failed: expected value to contain '{}', got '{}'",
                        verification.expected,
                        verification.actual.as_deref().unwrap_or("<none>")
                    ),
                    Some(json!({
                        "expected_text": verification.expected,
                        "actual_value": verification.actual,
                        "selector_used": successful_selector,
                    })),
                ));
            }

            tracing::info!(
                "[type_into_element] Auto-verification passed: value contains '{}'",
                verification.expected
            );

            if let Some(obj) = result_json.as_object_mut() {
                obj.insert(
                    "verification".to_string(),
                    json!({
                        "passed": verification.passed,
                        "method": "direct_value_read",
                        "expected_text": verification.expected,
                        "actual_value": verification.actual,
                    }),
                );
            }
        }

        // Attach UI diff if captured (action tools only support diff, not standalone tree)
        if let Some(diff_result) = ui_diff {
            tracing::debug!(
                "[type_into_element] Attaching UI diff to result (has_changes: {})",
                diff_result.has_changes
            );
            span.set_attribute("ui_diff.has_changes", diff_result.has_changes.to_string());

            result_json["ui_diff"] = json!(diff_result.diff);
            result_json["has_ui_changes"] = json!(diff_result.has_changes);
        }

        // Restore windows after typing into element
        self.restore_window_management(should_restore).await;

        tracing::info!(
            "[PERF] type_into_element total: {}ms",
            operation_start.elapsed().as_millis()
        );
        span.set_status(true, None);
        span.end();
        append_window_screenshot_to_json(
            &self.desktop,
            &args.selector.process,
            &mut result_json,
            args.window_screenshot.include_window_screenshot,
        )
        .await;
        let contents = vec![Content::json(result_json)?];
        let contents = append_monitor_screenshots_if_enabled(
            &self.desktop,
            contents,
            args.monitor.include_monitor_screenshots,
        )
        .await;
        Ok(CallToolResult::success(contents))
    }

    #[tool(
        description = "Unified click tool with three modes. IMPORTANT: Use exactly ONE mode - do not mix parameters from different modes.

**Mode 1 - Selector** (process + selector): Find element by selector and click.
  Example: {\"process\": \"notepad\", \"selector\": \"role:Button|name:Save\", \"click_type\": \"left\"}

**Mode 2 - Index** (index + vision_type): Click indexed item from previous tool response (any action with include_tree_after_action:true, or initial get_window_tree).
  Example: {\"index\": 5, \"vision_type\": \"ui_tree\", \"click_type\": \"double\"}

**Mode 3 - Coordinates** (x + y): Click at absolute screen coordinates.
  Example: {\"x\": 500, \"y\": 300, \"click_type\": \"right\"}

Click types: 'left' (default), 'double', 'right'. Use ui_diff_before_after:true to get UI changes in response (no need to call get_window_tree after)."
    )]
    pub async fn click_element(
        &self,
        Parameters(args): Parameters<ClickElementArgs>,
    ) -> Result<CallToolResult, McpError> {
        use crate::utils::ClickMode;

        let mut span = StepSpan::new("click_element", None);

        let mode = match args.determine_mode() {
            Ok(m) => m,
            Err(e) => {
                span.set_status(false, Some(&e));
                span.end();
                return Err(McpError::invalid_params(e, None));
            }
        };

        span.set_attribute("mode", format!("{:?}", mode));
        span.set_attribute("click_type", format!("{:?}", args.click_type));
        tracing::info!(
            "[click_element] Mode: {:?}, click_type: {:?}",
            mode,
            args.click_type
        );

        let computeruse_click_type = match args.click_type {
            crate::utils::ClickType::Left => computeruse::ClickType::Left,
            crate::utils::ClickType::Double => computeruse::ClickType::Double,
            crate::utils::ClickType::Right => computeruse::ClickType::Right,
        };

        match mode {
            ClickMode::Coordinates => {
                let x = args.x.unwrap();
                let y = args.y.unwrap();
                span.set_attribute("click_x", x.to_string());
                span.set_attribute("click_y", y.to_string());
                tracing::info!("[click_element] Coordinate mode: ({}, {})", x, y);

                // Highlight before click if enabled (coordinate mode - small box around click point)
                if args.highlight.highlight_before_action {
                    const HIGHLIGHT_SIZE: i32 = 24;
                    let highlight_x = (x as i32) - HIGHLIGHT_SIZE / 2;
                    let highlight_y = (y as i32) - HIGHLIGHT_SIZE / 2;
                    tracing::info!(
                        "HIGHLIGHT_BEFORE_CLICK (coordinate mode) point=({}, {})",
                        x,
                        y
                    );
                    let _ = computeruse::highlight_bounds(
                        highlight_x,
                        highlight_y,
                        HIGHLIGHT_SIZE,
                        HIGHLIGHT_SIZE,
                        Some(0x00FF00), // Green
                        Some(std::time::Duration::from_millis(500)),
                        Some(&format!("({}, {})", x as i32, y as i32)),
                        Some(computeruse::TextPosition::Top),
                        Some(computeruse::FontStyle {
                            size: 12,
                            bold: true,
                            color: 0xFFFFFF,
                        }),
                    );
                }

                match self.desktop.click_at_coordinates_with_type(
                    x,
                    y,
                    computeruse_click_type,
                    args.restore_cursor,
                ) {
                    Ok(()) => {
                        let ct_str = match args.click_type {
                            crate::utils::ClickType::Left => "left",
                            crate::utils::ClickType::Double => "double",
                            crate::utils::ClickType::Right => "right",
                        };
                        let mut result_json = json!({
                            "action": "click", "mode": "coordinates", "status": "executed_without_error",
                            "click_type": ct_str,
                            "clicked_at": { "x": x, "y": y },
                            "timestamp": chrono::Utc::now().to_rfc3339()
                        });
                        span.set_status(true, None);
                        span.end();
                        append_window_screenshot_to_json(
                            &self.desktop,
                            args.process.as_deref().unwrap_or(""),
                            &mut result_json,
                            args.window_screenshot.include_window_screenshot,
                        )
                        .await;
                        let contents = vec![Content::json(result_json)?];
                        let contents = append_monitor_screenshots_if_enabled(
                            &self.desktop,
                            contents,
                            args.monitor.include_monitor_screenshots,
                        )
                        .await;
                        return Ok(CallToolResult::success(contents));
                    }
                    Err(e) => {
                        span.set_status(false, Some(&e.to_string()));
                        span.end();
                        return Err(McpError::internal_error(
                            format!("Failed to click at ({}, {}): {}", x, y, e),
                            Some(json!({ "x": x, "y": y })),
                        ));
                    }
                }
            }

            ClickMode::Index => {
                let index = args.index.unwrap();
                let vision_type = args.get_vision_type();
                span.set_attribute("index", index.to_string());
                span.set_attribute("vision_type", format!("{:?}", vision_type));
                tracing::info!("[click_element] Index mode: {}, {:?}", index, vision_type);

                // Track selector for UI tree clicks (populated in match arm)
                let mut uia_selector: Option<String> = None;

                let (item_label, bounds) = match vision_type {
                    crate::utils::VisionType::UiTree => {
                        let r = self
                            .uia_bounds
                            .lock()
                            .map_err(|e| {
                                McpError::internal_error(format!("Lock error: {e}"), None)
                            })?
                            .get(&index)
                            .cloned();
                        let Some((role, name, b, selector)) = r else {
                            span.set_status(false, Some("UIA index not found"));
                            span.end();
                            return Err(McpError::internal_error(
                                format!(
                                    "UI tree index {} not found. Call get_window_tree first.",
                                    index
                                ),
                                Some(json!({ "index": index })),
                            ));
                        };
                        // Store selector for later use in response
                        uia_selector = selector;
                        (
                            if name.is_empty() {
                                role
                            } else {
                                format!("{role}: {name}")
                            },
                            b,
                        )
                    }
                    crate::utils::VisionType::Ocr => {
                        let r = self
                            .ocr_bounds
                            .lock()
                            .map_err(|e| {
                                McpError::internal_error(format!("Lock error: {e}"), None)
                            })?
                            .get(&index)
                            .cloned();
                        let Some((text, b)) = r else {
                            span.set_status(false, Some("OCR index not found"));
                            span.end();
                            return Err(McpError::internal_error(
                                format!("OCR index {} not found.", index),
                                Some(json!({ "index": index })),
                            ));
                        };
                        (text, b)
                    }
                    crate::utils::VisionType::Omniparser => {
                        let r = self
                            .omniparser_items
                            .lock()
                            .map_err(|e| {
                                McpError::internal_error(format!("Lock error: {e}"), None)
                            })?
                            .get(&index)
                            .cloned();
                        let Some(item) = r else {
                            span.set_status(false, Some("Omniparser index not found"));
                            span.end();
                            return Err(McpError::internal_error(
                                format!("Omniparser index {} not found.", index),
                                Some(json!({ "index": index })),
                            ));
                        };
                        let b = item
                            .box_2d
                            .ok_or_else(|| McpError::internal_error("No bounds", None))?;
                        (item.label, (b[0], b[1], b[2] - b[0], b[3] - b[1]))
                    }
                    crate::utils::VisionType::Gemini => {
                        let r = self
                            .vision_items
                            .lock()
                            .map_err(|e| {
                                McpError::internal_error(format!("Lock error: {e}"), None)
                            })?
                            .get(&index)
                            .cloned();
                        let Some(item) = r else {
                            span.set_status(false, Some("Gemini index not found"));
                            span.end();
                            return Err(McpError::internal_error(
                                format!("Gemini index {} not found.", index),
                                Some(json!({ "index": index })),
                            ));
                        };
                        let b = item
                            .box_2d
                            .ok_or_else(|| McpError::internal_error("No bounds", None))?;
                        (item.element_type, (b[0], b[1], b[2] - b[0], b[3] - b[1]))
                    }
                    crate::utils::VisionType::Dom => {
                        let r = self
                            .dom_bounds
                            .lock()
                            .map_err(|e| {
                                McpError::internal_error(format!("Lock error: {e}"), None)
                            })?
                            .get(&index)
                            .cloned();
                        let Some((tag, id, b)) = r else {
                            span.set_status(false, Some("DOM index not found"));
                            span.end();
                            return Err(McpError::internal_error(
                                format!("DOM index {} not found.", index),
                                Some(json!({ "index": index })),
                            ));
                        };
                        (
                            if id.is_empty() {
                                tag
                            } else {
                                format!("{tag}: {id}")
                            },
                            b,
                        )
                    }
                };

                let click_x = bounds.0 + bounds.2 / 2.0;
                let click_y = bounds.1 + bounds.3 / 2.0;
                span.set_attribute("label", item_label.clone());

                // Highlight before click if enabled (index mode)
                if args.highlight.highlight_before_action {
                    tracing::info!(
                        "HIGHLIGHT_BEFORE_CLICK (index mode) bounds=({}, {}, {}, {}) label={}",
                        bounds.0,
                        bounds.1,
                        bounds.2,
                        bounds.3,
                        item_label
                    );
                    let _ = computeruse::highlight_bounds(
                        bounds.0 as i32,
                        bounds.1 as i32,
                        bounds.2 as i32,
                        bounds.3 as i32,
                        Some(0x00FF00), // Green
                        Some(std::time::Duration::from_millis(500)),
                        Some(&item_label),
                        Some(computeruse::TextPosition::Top),
                        Some(computeruse::FontStyle {
                            size: 12,
                            bold: true,
                            color: 0xFFFFFF,
                        }),
                    );
                }

                match self.desktop.click_at_coordinates_with_type(
                    click_x,
                    click_y,
                    computeruse_click_type,
                    args.restore_cursor,
                ) {
                    Ok(()) => {
                        let vt_str = format!("{:?}", vision_type).to_lowercase();
                        let ct_str = match args.click_type {
                            crate::utils::ClickType::Left => "left",
                            crate::utils::ClickType::Double => "double",
                            crate::utils::ClickType::Right => "right",
                        };
                        let mut result_json = json!({
                            "action": "click", "mode": "index", "status": "executed_without_error",
                            "index": index, "vision_type": vt_str, "click_type": ct_str, "label": item_label,
                            "clicked_at": { "x": click_x, "y": click_y },
                            "bounds": { "x": bounds.0, "y": bounds.1, "width": bounds.2, "height": bounds.3 },
                            "timestamp": chrono::Utc::now().to_rfc3339()
                        });
                        // Add selector if available (UI tree clicks only)
                        if let Some(ref sel) = uia_selector {
                            result_json["selector"] = json!(sel);
                        }
                        span.set_status(true, None);
                        span.end();
                        append_window_screenshot_to_json(
                            &self.desktop,
                            args.process.as_deref().unwrap_or(""),
                            &mut result_json,
                            args.window_screenshot.include_window_screenshot,
                        )
                        .await;
                        let contents = vec![Content::json(result_json)?];
                        let contents = append_monitor_screenshots_if_enabled(
                            &self.desktop,
                            contents,
                            args.monitor.include_monitor_screenshots,
                        )
                        .await;
                        return Ok(CallToolResult::success(contents));
                    }
                    Err(e) => {
                        span.set_status(false, Some(&e.to_string()));
                        span.end();
                        return Err(McpError::internal_error(
                            format!("Failed to click index {}: {e}", index),
                            Some(json!({ "index": index, "label": item_label })),
                        ));
                    }
                }
            }

            ClickMode::Selector => {
                let full_selector = args.build_full_selector();
                let click_position = args.get_click_position();
                span.set_attribute("selector", full_selector.clone());
                span.set_attribute("click.position_x", click_position.x_percentage.to_string());
                span.set_attribute("click.position_y", click_position.y_percentage.to_string());
                tracing::info!(
                    "[click_element] Selector mode: '{}', position: {}%, {}%",
                    full_selector,
                    click_position.x_percentage,
                    click_position.y_percentage
                );

                if let Some(retries) = args.action.retries {
                    span.set_attribute("retry.max_attempts", retries.to_string());
                }

                let should_restore = {
                    let in_sequence = self.in_sequence.lock().unwrap_or_else(|e| e.into_inner());
                    !*in_sequence
                };

                if should_restore {
                    if let Some(ref process) = args.process {
                        let _ = self
                            .prepare_window_management(process, None, None, None, &args.window_mgmt)
                            .await;
                    }
                }

                let highlight_before = args.highlight.highlight_before_action;
                let click_type = args.click_type;
                let restore_cursor = args.restore_cursor;
                let action = {
                    let click_position = click_position.clone();
                    move |element: UIElement| {
                        let click_position = click_position.clone();
                        async move {
                            if highlight_before {
                                let _ = element.highlight_before_action("click");
                            }
                            // Show action overlay
                            let element_desc = element.name().unwrap_or_default();
                            let element_role = element.role();
                            let overlay_info = if element_desc.is_empty() {
                                element_role.clone()
                            } else if element_desc.len() > 50 {
                                format!("'{}...' {}", &element_desc[..47], element_role)
                            } else {
                                format!("'{}' {}", element_desc, element_role)
                            };
                            computeruse::show_action_overlay("Clicking", Some(overlay_info));

                            let result = match element.bounds() {
                                Ok(bounds) => {
                                    let x = bounds.0
                                        + (bounds.2 * click_position.x_percentage as f64 / 100.0);
                                    let y = bounds.1
                                        + (bounds.3 * click_position.y_percentage as f64 / 100.0);
                                    tracing::debug!(
                                        "[click_element] Clicking at ({}, {}), restore_cursor={}",
                                        x,
                                        y,
                                        restore_cursor
                                    );

                                    // Use shared click function with restore_cursor support
                                    let computeruse_click_type = match click_type {
                                        crate::utils::ClickType::Left => {
                                            computeruse::ClickType::Left
                                        }
                                        crate::utils::ClickType::Double => {
                                            computeruse::ClickType::Double
                                        }
                                        crate::utils::ClickType::Right => {
                                            computeruse::ClickType::Right
                                        }
                                    };
                                    computeruse::platforms::windows::send_mouse_click(
                                        x,
                                        y,
                                        computeruse_click_type,
                                        restore_cursor,
                                    )?;

                                    use computeruse::ClickResult;
                                    Ok(ClickResult {
                                        coordinates: Some((x, y)),
                                        method: "Position Click".to_string(),
                                        details: format!(
                                            "Clicked at {}%, {}%",
                                            click_position.x_percentage,
                                            click_position.y_percentage
                                        ),
                                    })
                                }
                                Err(e) => {
                                    tracing::warn!(
                                        "[click_element] Failed to get bounds: {}. Falling back.",
                                        e
                                    );
                                    element.click()
                                }
                            };
                            computeruse::hide_action_overlay();
                            result
                        }
                    }
                };

                let operation_start = std::time::Instant::now();
                let tree_output_format = args
                    .tree
                    .tree_output_format
                    .unwrap_or(crate::mcp_types::TreeOutputFormat::CompactYaml);

                let result = crate::helpers::find_and_execute_with_ui_diff(
                    &self.desktop,
                    &full_selector,
                    args.build_alternative_selectors().as_deref(),
                    args.build_fallback_selectors().as_deref(),
                    args.action.timeout_ms,
                    args.action.retries,
                    action,
                    args.tree.ui_diff_before_after,
                    args.tree.tree_max_depth,
                    args.tree.include_detailed_attributes,
                    tree_output_format,
                )
                .await;

                let operation_time_ms = operation_start.elapsed().as_millis() as i64;
                span.set_attribute("operation.duration_ms", operation_time_ms.to_string());
                tracing::info!("[PERF] click_element total: {}ms", operation_time_ms);

                let ((click_result, element), successful_selector, ui_diff) = match result {
                    Ok(((result, element), selector, diff)) => {
                        span.set_attribute("selector.used", selector.clone());
                        span.set_attribute("element.found", "true".to_string());
                        if diff.is_some() {
                            span.set_attribute("ui_diff.captured", "true".to_string());
                        }
                        ((result, element), selector, diff)
                    }
                    Err(e) => {
                        span.set_attribute("element.found", "false".to_string());
                        span.set_status(false, Some(&e.to_string()));
                        span.end();
                        return Err(build_element_not_found_error(
                            &full_selector,
                            args.build_alternative_selectors().as_deref(),
                            args.build_fallback_selectors().as_deref(),
                            e,
                        ));
                    }
                };

                span.set_attribute("element.role", element.role());
                if let Some(name) = element.name() {
                    span.set_attribute("element.name", name);
                }

                let element_info = build_element_info(&element);
                let ct_str = match args.click_type {
                    crate::utils::ClickType::Left => "left",
                    crate::utils::ClickType::Double => "double",
                    crate::utils::ClickType::Right => "right",
                };

                let mut result_json = json!({
                    "action": "click", "mode": "selector", "status": "executed_without_error",
                    "selector_used": successful_selector,
                    "click_type": ct_str,
                    "click_result": { "method": click_result.method, "coordinates": click_result.coordinates, "details": click_result.details },
                    "element": element_info,
                    "timestamp": chrono::Utc::now().to_rfc3339()
                });

                if !args.action.verify_element_exists.is_empty()
                    || !args.action.verify_element_not_exists.is_empty()
                {
                    let verify_timeout_ms = args.action.verify_timeout_ms.unwrap_or(2000);
                    let verify_exists_opt = if args.action.verify_element_exists.is_empty() {
                        None
                    } else {
                        Some(args.action.verify_element_exists.as_str())
                    };
                    let verify_not_exists_opt = if args.action.verify_element_not_exists.is_empty()
                    {
                        None
                    } else {
                        Some(args.action.verify_element_not_exists.as_str())
                    };

                    match crate::helpers::verify_post_action(
                        &self.desktop,
                        &element,
                        verify_exists_opt,
                        verify_not_exists_opt,
                        verify_timeout_ms,
                        &successful_selector,
                    )
                    .await
                    {
                        Ok(verification_result) => {
                            span.set_attribute("verification.passed", "true".to_string());
                            let verification_json = json!({ "passed": verification_result.passed, "method": verification_result.method, "details": verification_result.details, "elapsed_ms": verification_result.elapsed_ms });
                            if let Some(obj) = result_json.as_object_mut() {
                                obj.insert("verification".to_string(), verification_json);
                            }
                        }
                        Err(e) => {
                            span.set_status(false, Some("Verification failed"));
                            span.end();
                            return Err(McpError::internal_error(
                                format!("Post-action verification failed: {e}"),
                                Some(json!({ "selector_used": successful_selector })),
                            ));
                        }
                    }
                }

                if let Some(diff_result) = ui_diff {
                    span.set_attribute("ui_diff.has_changes", diff_result.has_changes.to_string());
                    result_json["ui_diff"] = json!(diff_result.diff);
                    result_json["has_ui_changes"] = json!(diff_result.has_changes);
                }

                self.restore_window_management(should_restore).await;
                span.set_status(true, None);
                span.end();

                append_window_screenshot_to_json(
                    &self.desktop,
                    args.process.as_deref().unwrap_or(""),
                    &mut result_json,
                    args.window_screenshot.include_window_screenshot,
                )
                .await;
                let contents = vec![Content::json(result_json)?];
                let contents = append_monitor_screenshots_if_enabled(
                    &self.desktop,
                    contents,
                    args.monitor.include_monitor_screenshots,
                )
                .await;
                Ok(CallToolResult::success(contents))
            }
        }
    }
    #[tool(
        description = "Sends a key press to a UI element. Keys are auto-normalized to curly brace format (e.g., 'Enter' becomes '{Enter}'). Examples: 'Enter', 'Tab', 'Ctrl+A', '{Ctrl}c', '{Alt}{F4}'. Use ui_diff_before_after:true to see changes (no need to call get_window_tree after)."
    )]
    async fn press_key(
        &self,
        Parameters(args): Parameters<PressKeyArgs>,
    ) -> Result<CallToolResult, McpError> {
        let mut span = StepSpan::new("press_key", None);

        // Add comprehensive telemetry attributes
        span.set_attribute("selector", args.selector.selector.clone());
        span.set_attribute("key", args.key.clone());
        if let Some(timeout) = args.action.timeout_ms {
            span.set_attribute("timeout_ms", timeout.to_string());
        }
        if let Some(retries) = args.action.retries {
            span.set_attribute("retry.max_attempts", retries.to_string());
        }

        tracing::info!(
            "[press_key] Called with selector: '{}', key: '{}'",
            args.selector.selector,
            args.key
        );

        // Check if we need to perform window management (only for direct MCP calls, not sequences)
        let should_restore = {
            let in_sequence = self.in_sequence.lock().unwrap_or_else(|e| e.into_inner());
            let flag_value = *in_sequence;
            let should_restore_value = !flag_value;
            tracing::info!(
                "[press_key] Flag check: in_sequence={}, should_restore={}",
                flag_value,
                should_restore_value
            );
            should_restore_value
        };

        if should_restore {
            tracing::info!("[press_key] Direct MCP call detected - performing window management");
            let _ = self
                .prepare_window_management(
                    &args.selector.process,
                    None,
                    None,
                    None,
                    &args.window_mgmt,
                )
                .await;
        } else {
            tracing::debug!(
                "[press_key] In sequence - skipping window management (dispatch_tool handles it)"
            );
        }

        // Normalize key to ensure curly brace format (e.g., "Enter" -> "{Enter}")
        let key_to_press = normalize_key(&args.key);
        tracing::debug!(
            "[press_key] normalized key: {} -> {}",
            args.key,
            key_to_press
        );
        let try_focus_before = args.try_focus_before;
        let try_click_before = args.try_click_before;
        let highlight_before = args.highlight.highlight_before_action;
        let action = {
            move |element: UIElement| {
                let key_to_press = key_to_press.clone();
                async move {
                    // Activate window to ensure it has keyboard focus before pressing key
                    if let Err(e) = element.activate_window() {
                        tracing::warn!("Failed to activate window before pressing key: {}", e);
                    }

                    // Ensure element is visible and apply highlighting if enabled
                    if highlight_before {
                        let _ = element.highlight_before_action("key");
                    }

                    // Execute the key press action with state tracking
                    element.press_key_with_state_and_focus(
                        &key_to_press,
                        try_focus_before,
                        try_click_before,
                    )
                }
            }
        };

        let operation_start = std::time::Instant::now();

        // Store tree config to avoid move issues
        let tree_output_format = args
            .tree
            .tree_output_format
            .unwrap_or(crate::mcp_types::TreeOutputFormat::CompactYaml);

        let ((result, element), successful_selector, ui_diff) =
            match crate::helpers::find_and_execute_with_ui_diff(
                &self.desktop,
                &args.selector.build_full_selector(),
                None, // PressKey doesn't have alternative selectors yet
                args.selector.build_fallback_selectors().as_deref(),
                args.action.timeout_ms,
                args.action.retries,
                action,
                args.tree.ui_diff_before_after,
                args.tree.tree_max_depth,
                args.tree.include_detailed_attributes,
                tree_output_format,
            )
            .await
            {
                Ok(((result, element), selector, diff)) => {
                    let operation_time_ms = operation_start.elapsed().as_millis() as i64;
                    span.set_attribute("operation.duration_ms", operation_time_ms.to_string());
                    span.set_attribute("element.found", "true".to_string());
                    span.set_attribute("selector.successful", selector.clone());
                    if diff.is_some() {
                        span.set_attribute("ui_diff.captured", "true".to_string());
                    }

                    // Add element metadata
                    if let Some(name) = element.name() {
                        span.set_attribute("element.name", name);
                    }

                    Ok(((result, element), selector, diff))
                }
                Err(e) => {
                    // Note: Cannot use span here as it would be moved if we call span.end()
                    Err(build_element_not_found_error(
                        &args.selector.build_full_selector(),
                        None,
                        args.selector.build_fallback_selectors().as_deref(),
                        e,
                    ))
                }
            }?;

        let element_info = build_element_info(&element);

        let mut result_json = json!({
            "action": "press_key",
            "status": "executed_without_error",
            "key_pressed": args.key,
            "action_result": {
                "action": result.action,
                "details": result.details,
                "data": result.data,
            },
            "element": element_info,
            "selector_used": successful_selector,
            "selectors_tried": get_selectors_tried_all(&args.selector.build_full_selector(), None, args.selector.build_fallback_selectors().as_deref()),
            "timestamp": chrono::Utc::now().to_rfc3339()
        });

        // POST-ACTION VERIFICATION
        if !args.action.verify_element_exists.is_empty()
            || !args.action.verify_element_not_exists.is_empty()
        {
            let verify_timeout_ms = args.action.verify_timeout_ms.unwrap_or(2000);

            let verify_exists_opt = if args.action.verify_element_exists.is_empty() {
                None
            } else {
                Some(args.action.verify_element_exists.as_str())
            };
            let verify_not_exists_opt = if args.action.verify_element_not_exists.is_empty() {
                None
            } else {
                Some(args.action.verify_element_not_exists.as_str())
            };

            match crate::helpers::verify_post_action(
                &self.desktop,
                &element,
                verify_exists_opt,
                verify_not_exists_opt,
                verify_timeout_ms,
                &successful_selector,
            )
            .await
            {
                Ok(verification_result) => {
                    tracing::info!(
                        "[press_key] Verification passed: method={}, details={}",
                        verification_result.method,
                        verification_result.details
                    );
                    span.set_attribute("verification.passed", "true".to_string());
                    span.set_attribute("verification.method", verification_result.method.clone());
                    span.set_attribute(
                        "verification.elapsed_ms",
                        verification_result.elapsed_ms.to_string(),
                    );

                    let verification_json = json!({
                        "passed": verification_result.passed,
                        "method": verification_result.method,
                        "details": verification_result.details,
                        "elapsed_ms": verification_result.elapsed_ms,
                        "timestamp": chrono::Utc::now().to_rfc3339(),
                    });

                    if let Some(obj) = result_json.as_object_mut() {
                        obj.insert("verification".to_string(), verification_json);
                    }
                }
                Err(e) => {
                    tracing::error!("[press_key] Verification failed: {}", e);
                    span.set_attribute("verification.passed", "false".to_string());
                    span.set_status(false, Some("Verification failed"));
                    span.end();
                    return Err(McpError::internal_error(
                        format!("Post-action verification failed: {e}"),
                        Some(json!({
                            "selector_used": successful_selector,
                            "verify_exists": args.action.verify_element_exists,
                            "verify_not_exists": args.action.verify_element_not_exists,
                            "timeout_ms": verify_timeout_ms,
                        })),
                    ));
                }
            }
        }

        // Attach UI diff if captured (action tools only support diff, not standalone tree)
        if let Some(diff_result) = ui_diff {
            tracing::debug!(
                "[press_key] Attaching UI diff to result (has_changes: {})",
                diff_result.has_changes
            );
            span.set_attribute("ui_diff.has_changes", diff_result.has_changes.to_string());

            result_json["ui_diff"] = json!(diff_result.diff);
            result_json["has_ui_changes"] = json!(diff_result.has_changes);
        }

        // Restore windows after pressing key
        self.restore_window_management(should_restore).await;

        span.set_status(true, None);
        span.end();
        append_window_screenshot_to_json(
            &self.desktop,
            &args.selector.process,
            &mut result_json,
            args.window_screenshot.include_window_screenshot,
        )
        .await;
        let contents = vec![Content::json(result_json)?];
        let contents = append_monitor_screenshots_if_enabled(
            &self.desktop,
            contents,
            args.monitor.include_monitor_screenshots,
        )
        .await;
        Ok(CallToolResult::success(contents))
    }

    #[tool(
        description = "Activates the window for the specified process and sends a key press to the focused element. Keys are auto-normalized to curly brace format (e.g., 'Enter' becomes '{Enter}'). Examples: 'Enter', 'Tab', 'Ctrl+A', '{Ctrl}c', '{Alt}{F4}'. Use ui_diff_before_after:true to see changes (no need to call get_window_tree after)."
    )]
    async fn press_key_global(
        &self,
        Parameters(args): Parameters<GlobalKeyArgs>,
    ) -> Result<CallToolResult, McpError> {
        let mut span = StepSpan::new("press_key_global", None);

        // Add telemetry attributes
        span.set_attribute("process", args.process.clone());
        span.set_attribute("key", args.key.clone());

        // Build selector to find the root window for the process
        // Using just process: prefix gets the main/root window directly
        let window_selector = format!("process:{}", args.process);
        span.set_attribute("window_selector", window_selector.clone());

        // Find the window element
        let operation_start = std::time::Instant::now();
        let window = self
            .desktop
            .locator(Selector::from(window_selector.as_str()))
            .first(None)
            .await
            .map_err(|e| {
                McpError::resource_not_found(
                    "Failed to find window for process",
                    Some(json!({
                        "reason": e.to_string(),
                        "process": args.process,
                        "selector": window_selector
                    })),
                )
            })?;

        let find_time_ms = operation_start.elapsed().as_millis() as i64;
        span.set_attribute("window.find_duration_ms", find_time_ms.to_string());

        // Activate the window to bring it to foreground
        window.activate_window().map_err(|e| {
            McpError::internal_error(
                "Failed to activate window",
                Some(json!({
                    "reason": e.to_string(),
                    "process": args.process
                })),
            )
        })?;
        span.set_attribute("window.activated", "true".to_string());

        // Get the focused element after activation
        let element = self.desktop.focused_element().map_err(|e| {
            McpError::internal_error(
                "Failed to get focused element after window activation",
                Some(json!({"reason": e.to_string()})),
            )
        })?;

        let operation_time_ms = operation_start.elapsed().as_millis() as i64;
        span.set_attribute("operation.duration_ms", operation_time_ms.to_string());
        span.set_attribute("focused_element.found", "true".to_string());

        // Add element metadata
        if let Some(name) = element.name() {
            span.set_attribute("element.name", name);
        }

        // Gather metadata for debugging / result payload
        let element_info = build_element_info(&element);
        let window_info = build_element_info(&window);

        // Normalize key to ensure curly brace format (e.g., "Enter" -> "{Enter}")
        let normalized_key = normalize_key(&args.key);
        tracing::debug!(
            "[press_key_global] normalized key: {} -> {}",
            args.key,
            normalized_key
        );

        // Perform the key press on the focused element
        element.press_key(&normalized_key).map_err(|e| {
            McpError::resource_not_found(
                "Failed to press key on focused element",
                Some(json!({
                    "reason": e.to_string(),
                    "key_pressed": normalized_key,
                    "element_info": element_info
                })),
            )
        })?;

        let mut result_json = json!({
            "action": "press_key_global",
            "status": "executed_without_error",
            "process": args.process,
            "key_pressed": normalized_key,
            "window": window_info,
            "focused_element": element_info,
            "timestamp": chrono::Utc::now().to_rfc3339()
        });

        // POST-ACTION VERIFICATION
        let verify_exists = args.verify_element_exists.clone();
        let verify_not_exists = args.verify_element_not_exists.clone();
        let verify_timeout_ms = args.verify_timeout_ms.unwrap_or(2000);

        let skip_verification = verify_exists.is_empty() && verify_not_exists.is_empty();

        if !skip_verification {
            span.add_event("verification_started", vec![]);

            let verify_exists_opt = if verify_exists.is_empty() {
                None
            } else {
                Some(verify_exists.as_str())
            };
            let verify_not_exists_opt = if verify_not_exists.is_empty() {
                None
            } else {
                Some(verify_not_exists.as_str())
            };

            match crate::helpers::verify_post_action(
                &self.desktop,
                &element,
                verify_exists_opt,
                verify_not_exists_opt,
                verify_timeout_ms,
                &window_selector,
            )
            .await
            {
                Ok(verification_result) => {
                    tracing::info!(
                        "[press_key_global] Verification passed: method={}, details={}",
                        verification_result.method,
                        verification_result.details
                    );
                    span.set_attribute("verification.passed", "true".to_string());
                    span.set_attribute("verification.method", verification_result.method.clone());
                    span.set_attribute(
                        "verification.elapsed_ms",
                        verification_result.elapsed_ms.to_string(),
                    );

                    let verification_json = json!({
                        "passed": verification_result.passed,
                        "method": verification_result.method,
                        "details": verification_result.details,
                        "elapsed_ms": verification_result.elapsed_ms,
                        "timestamp": chrono::Utc::now().to_rfc3339(),
                    });
                    result_json["verification"] = verification_json;
                }
                Err(e) => {
                    tracing::error!("[press_key_global] Verification failed: {}", e);
                    span.set_attribute("verification.passed", "false".to_string());
                    span.set_attribute("verification.error", e.to_string());
                    let error_msg = format!("Verification failed: {e}");
                    span.set_status(false, Some(error_msg.as_str()));
                    span.end();

                    return Err(McpError::internal_error(
                        "Post-action verification failed",
                        Some(json!({
                            "error": e.to_string(),
                            "verify_element_exists": verify_exists,
                            "verify_element_not_exists": verify_not_exists,
                            "verify_timeout_ms": verify_timeout_ms,
                        })),
                    ));
                }
            }
        }

        // Action tools only support UI diff, not standalone tree attachment
        // (use ui_diff_before_after: true to capture before/after tree)

        span.set_status(true, None);
        span.end();
        append_window_screenshot_to_json(
            &self.desktop,
            &args.process,
            &mut result_json,
            args.window_screenshot.include_window_screenshot,
        )
        .await;
        let contents = vec![Content::json(result_json)?];
        let contents = append_monitor_screenshots_if_enabled(
            &self.desktop,
            contents,
            args.monitor.include_monitor_screenshots,
        )
        .await;
        Ok(CallToolResult::success(contents))
    }

    #[tool(
        description = "IMPORTANT: Always use grep_files/read_file with working_directory set to computeruse-source to search SDK docs and examples before writing code. Verify API syntax from source.

Docs: docs/COMPUTERUSE_JS_API.md | Selectors: docs/SELECTORS_CHEATSHEET.md | Examples: examples/*.yml | KV: packages/kv/README.md

Executes shell commands OR inline JS/TS via engine. Use 'run' for shell, or 'engine': 'typescript' (preferred) / 'javascript' for computeruse.js code.

INJECTED GLOBALS (engine mode):
desktop, log, sleep(ms), setEnv({k:v}), kv (auto-initialized when ORG_TOKEN set), variables

AVAILABLE APIs (search computeruse-source for full signatures):
- Desktop: locator(), openUrl(url, browser?), navigateBrowser(url, browser?), openApplication(), pressKey(), delay(ms), executeBrowserScript(), getWindowTree(), captureScreenshot()
- Locator: .first(timeoutMs), .all(timeoutMs), .validate(timeoutMs), .waitFor(condition, timeoutMs), .within(element)
- Element: .click(), .doubleClick(), .hover(), .typeText(text, {clearBeforeTyping}), .pressKey(), .invoke(), .text(), .getValue(), .isSelected(), .setSelected(), .scrollIntoView(), .bounds(), .capture(), .locator()
- WindowManager: bringWindowToFront(), minimizeIfNeeded(), captureInitialState()

CRITICAL RULES:
- .first()/.all() REQUIRE timeout in ms: .first(0) immediate, .first(5000) retry 5s
- Selectors MUST include process: desktop.locator('process:chrome >> role:Button')

KV STORAGE (persistent state between workflow runs):
- Basic: kv.get(key), kv.set(key, value), kv.del(key)
- Options: { ex: 60 } expires in 60s, { nx: true } only if not exists (locks), { xx: true } only if exists
- Lists: kv.lpush/rpush/lpop/rpop for queues
- Hashes: kv.hset/hget/hgetall for objects
- Counter: kv.incr(key)
Use cases: duplicate tracking, distributed locks, progress checkpoints, cross-VM state

DATA PASSING:
- Access: variables.my_var, env.step_id_result
- Return: { field: value } auto-merges to env for next steps
- Logs: Set include_logs: true to capture stdout/stderr
"
    )]
    async fn run_command(
        &self,
        peer: Peer<RoleServer>,
        Parameters(args): Parameters<RunCommandArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.run_command_impl(args, None, Some(peer)).await
    }

    async fn run_command_impl(
        &self,
        args: RunCommandArgs,
        cancellation_token: Option<tokio_util::sync::CancellationToken>,
        peer: Option<Peer<RoleServer>>,
    ) -> Result<CallToolResult, McpError> {
        // Start telemetry span
        let mut span = StepSpan::new("run_command_impl", None);

        // Engine-based execution path (provides SDK bindings)
        if let Some(engine_value) = args.engine.as_ref() {
            let engine = engine_value.to_ascii_lowercase();

            // Default timeout: 2 minutes (120000ms), 0 means no timeout
            let timeout_ms = args.timeout_ms.unwrap_or(120_000);
            let timeout_duration = std::time::Duration::from_millis(timeout_ms);

            // Track resolved script path for working directory determination
            let mut resolved_script_path: Option<PathBuf> = None;

            // Resolve script content from file or inline
            let script_content = if let Some(script_file) = &args.script_file {
                // Check that both run and script_file aren't provided
                if args.run.is_some() {
                    return Err(McpError::invalid_params(
                        "Cannot specify both 'run' and 'script_file'. Use one or the other.",
                        None,
                    ));
                }

                // Resolve script file with priority order:
                // 1. Try scripts_base_path if provided (from workflow root level)
                // 2. Fallback to workflow directory if available
                // 3. Use path as-is
                let resolved_path = {
                    let script_path = std::path::Path::new(script_file);
                    let mut resolved_path = None;
                    let mut resolution_attempts = Vec::new();

                    // Only resolve if path is relative
                    if script_path.is_relative() {
                        tracing::info!(
                            "[SCRIPTS_BASE_PATH] Resolving relative script file: '{}'",
                            script_file
                        );

                        // Priority 1: Try scripts_base_path if provided
                        let scripts_base_guard = self.current_scripts_base_path.lock().await;
                        if let Some(ref base_path) = *scripts_base_guard {
                            tracing::info!(
                                "[SCRIPTS_BASE_PATH] Checking scripts_base_path: {}",
                                base_path
                            );
                            let base = std::path::Path::new(base_path);
                            if base.exists() && base.is_dir() {
                                let candidate = base.join(script_file);
                                resolution_attempts
                                    .push(format!("scripts_base_path: {}", candidate.display()));
                                tracing::info!(
                                    "[SCRIPTS_BASE_PATH] Looking for file at: {}",
                                    candidate.display()
                                );
                                if candidate.exists() {
                                    tracing::info!(
                                        "[SCRIPTS_BASE_PATH] ✓ Found in scripts_base_path: {} -> {}",
                                        script_file,
                                        candidate.display()
                                    );
                                    resolved_path = Some(candidate);
                                } else {
                                    tracing::info!(
                                        "[SCRIPTS_BASE_PATH] ✗ Not found in scripts_base_path: {}",
                                        candidate.display()
                                    );
                                }
                            } else {
                                tracing::warn!(
                                    "[SCRIPTS_BASE_PATH] Base path does not exist or is not a directory: {}",
                                    base_path
                                );
                            }
                        } else {
                            tracing::debug!(
                                "[SCRIPTS_BASE_PATH] No scripts_base_path configured for this workflow"
                            );
                        }
                        drop(scripts_base_guard);

                        // Priority 2: Try workflow directory if not found yet
                        if resolved_path.is_none() {
                            let workflow_dir_guard = self.current_workflow_dir.lock().await;
                            if let Some(ref workflow_dir) = *workflow_dir_guard {
                                tracing::info!(
                                    "[SCRIPTS_BASE_PATH] Checking workflow directory: {}",
                                    workflow_dir.display()
                                );
                                let candidate = workflow_dir.join(script_file);
                                resolution_attempts
                                    .push(format!("workflow_dir: {}", candidate.display()));
                                tracing::info!(
                                    "[SCRIPTS_BASE_PATH] Looking for file at: {}",
                                    candidate.display()
                                );
                                if candidate.exists() {
                                    tracing::info!(
                                        "[SCRIPTS_BASE_PATH] ✓ Found in workflow directory: {} -> {}",
                                        script_file,
                                        candidate.display()
                                    );
                                    resolved_path = Some(candidate);
                                } else {
                                    tracing::info!(
                                        "[SCRIPTS_BASE_PATH] ✗ Not found in workflow directory: {}",
                                        candidate.display()
                                    );
                                }
                            } else {
                                tracing::debug!(
                                    "[SCRIPTS_BASE_PATH] No workflow directory available"
                                );
                            }
                        }

                        // Priority 3: Check current directory or use as-is
                        if resolved_path.is_none() {
                            let candidate = script_path.to_path_buf();
                            resolution_attempts.push(format!("as-is: {}", candidate.display()));

                            // Check if file exists before using it
                            if candidate.exists() {
                                tracing::info!(
                                    "[SCRIPTS_BASE_PATH] Found script file at: {}",
                                    candidate.display()
                                );
                                resolved_path = Some(candidate);
                            } else {
                                tracing::warn!(
                                    "[SCRIPTS_BASE_PATH] Script file not found: {} (tried: {:?})",
                                    script_file,
                                    resolution_attempts
                                );
                                // Return error immediately for missing file
                                return Err(McpError::invalid_params(
                                    format!("Script file '{script_file}' not found"),
                                    Some(json!({
                                        "file": script_file,
                                        "resolution_attempts": resolution_attempts,
                                        "error": "File does not exist"
                                    })),
                                ));
                            }
                        }
                    } else {
                        // Absolute path - check if exists
                        let candidate = script_path.to_path_buf();
                        if candidate.exists() {
                            tracing::info!("[run_command] Using absolute path: {}", script_file);
                            resolved_path = Some(candidate);
                        } else {
                            tracing::warn!(
                                "[run_command] Absolute script file not found: {}",
                                script_file
                            );
                            return Err(McpError::invalid_params(
                                format!("Script file '{script_file}' not found"),
                                Some(json!({
                                    "file": script_file,
                                    "error": "File does not exist at absolute path"
                                })),
                            ));
                        }
                    }

                    resolved_path.unwrap()
                };

                // Store the resolved path for later use
                resolved_script_path = Some(resolved_path.clone());

                // Read script from resolved file path
                tokio::fs::read_to_string(&resolved_path)
                    .await
                    .map_err(|e| {
                        McpError::invalid_params(
                            "Failed to read script file",
                            Some(json!({
                                "file": script_file,
                                "resolved_path": resolved_path.to_string_lossy(),
                                "error": e.to_string()
                            })),
                        )
                    })?
            } else if let Some(run) = &args.run {
                run.clone()
            } else {
                return Err(McpError::invalid_params(
                    "Either 'run' or 'script_file' must be provided when using 'engine'",
                    None,
                ));
            };

            // Build final script with env injection if provided
            let mut final_script = String::new();

            // Extract workflow variables and accumulated env from special env keys
            let mut variables_json = "{}".to_string();
            let mut accumulated_env_json = "{}".to_string();
            let mut env_data = args.env.clone();

            if let Some(env) = &env_data {
                if let Some(env_obj) = env.as_object() {
                    // Extract workflow variables
                    if let Some(vars) = env_obj.get("_workflow_variables") {
                        variables_json =
                            serde_json::to_string(vars).unwrap_or_else(|_| "{}".to_string());
                    }
                    // Extract accumulated env
                    if let Some(acc_env) = env_obj.get("_accumulated_env") {
                        accumulated_env_json =
                            serde_json::to_string(acc_env).unwrap_or_else(|_| "{}".to_string());
                    }
                }
            }

            // Remove special keys from env before normal processing
            if let Some(env) = &mut env_data {
                if let Some(env_obj) = env.as_object_mut() {
                    env_obj.remove("_workflow_variables");
                    env_obj.remove("_accumulated_env");
                }
            }

            // Prepare explicit env if provided
            let explicit_env_json = if let Some(env) = &env_data {
                if env.as_object().is_some_and(|o| !o.is_empty()) {
                    serde_json::to_string(&env).map_err(|e| {
                        McpError::internal_error(
                            "Failed to serialize env data",
                            Some(json!({"error": e.to_string()})),
                        )
                    })?
                } else {
                    "{}".to_string()
                }
            } else {
                "{}".to_string()
            };

            // Inject based on engine type
            if matches!(
                engine.as_str(),
                "node" | "bun" | "javascript" | "js" | "typescript" | "ts"
            ) {
                // First inject accumulated env
                final_script.push_str(&format!("var env = {accumulated_env_json};\n"));

                // Merge explicit env if provided
                if explicit_env_json != "{}" {
                    final_script
                        .push_str(&format!("env = Object.assign(env, {explicit_env_json});\n"));
                }

                // Inject individual variables from env
                let merged_env = if explicit_env_json != "{}" {
                    // Merge accumulated and explicit env for individual vars
                    format!("Object.assign({{}}, {accumulated_env_json}, {explicit_env_json})")
                } else {
                    accumulated_env_json.clone()
                };

                if let Ok(env_obj) =
                    serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&merged_env)
                {
                    for (key, value) in env_obj {
                        if Self::is_valid_js_identifier(&key) {
                            // Smart handling of potentially double-stringified JSON (same as browser scripts)
                            let injectable_value = if let Some(str_val) = value.as_str() {
                                let trimmed = str_val.trim();
                                // Check if it looks like JSON (object or array)
                                if (trimmed.starts_with('{') && trimmed.ends_with('}'))
                                    || (trimmed.starts_with('[') && trimmed.ends_with(']'))
                                {
                                    // Try to parse as JSON to avoid double stringification
                                    match serde_json::from_str::<serde_json::Value>(str_val) {
                                        Ok(parsed) => {
                                            tracing::debug!(
                                                "[run_command] Detected JSON string for env.{}, parsing to avoid double stringification",
                                                key
                                            );
                                            parsed
                                        }
                                        Err(_) => value.clone(),
                                    }
                                } else {
                                    value.clone()
                                }
                            } else {
                                value.clone()
                            };

                            // Now stringify for injection (single level of stringification)
                            if let Ok(value_json) = serde_json::to_string(&injectable_value) {
                                final_script.push_str(&format!("var {key} = {value_json};\n"));
                                tracing::debug!(
                                    "[run_command] Injected env.{} as individual variable",
                                    key
                                );
                            }
                        }
                    }
                }

                // Inject variables
                final_script.push_str(&format!("var variables = {variables_json};\n"));

                // Auto-initialize kv if ORG_TOKEN was injected
                if accumulated_env_json.contains("\"ORG_TOKEN\"")
                    || explicit_env_json.contains("\"ORG_TOKEN\"")
                {
                    final_script.push_str("var kv = createKVClient(ORG_TOKEN);\n");
                    tracing::debug!("[run_command] Auto-initialized kv with ORG_TOKEN");
                }

                tracing::debug!("[run_command] Injected accumulated env, explicit env, individual vars, and workflow variables for JavaScript");
            } else if matches!(engine.as_str(), "python" | "py") {
                // For Python, inject as dictionaries
                final_script.push_str(&format!("env = {accumulated_env_json}\n"));

                // Merge explicit env if provided
                if explicit_env_json != "{}" {
                    final_script.push_str(&format!("env.update({explicit_env_json})\n"));
                }

                // Inject individual variables from env
                let merged_env = if explicit_env_json != "{}" {
                    // For Python, we need to merge differently
                    let mut base: serde_json::Map<String, serde_json::Value> =
                        serde_json::from_str(&accumulated_env_json).unwrap_or_default();
                    if let Ok(explicit) = serde_json::from_str::<
                        serde_json::Map<String, serde_json::Value>,
                    >(&explicit_env_json)
                    {
                        base.extend(explicit);
                    }
                    serde_json::to_string(&base).unwrap_or_else(|_| "{}".to_string())
                } else {
                    accumulated_env_json.clone()
                };

                if let Ok(env_obj) =
                    serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&merged_env)
                {
                    for (key, value) in env_obj {
                        if Self::is_valid_js_identifier(&key) {
                            // Smart handling of potentially double-stringified JSON (same as browser/JS scripts)
                            let injectable_value = if let Some(str_val) = value.as_str() {
                                let trimmed = str_val.trim();
                                // Check if it looks like JSON (object or array)
                                if (trimmed.starts_with('{') && trimmed.ends_with('}'))
                                    || (trimmed.starts_with('[') && trimmed.ends_with(']'))
                                {
                                    // Try to parse as JSON to avoid double stringification
                                    match serde_json::from_str::<serde_json::Value>(str_val) {
                                        Ok(parsed) => {
                                            tracing::debug!(
                                                "[run_command] Detected JSON string for env.{}, parsing to avoid double stringification",
                                                key
                                            );
                                            parsed
                                        }
                                        Err(_) => value.clone(),
                                    }
                                } else {
                                    value.clone()
                                }
                            } else {
                                value.clone()
                            };

                            // Now stringify for injection (single level of stringification)
                            if let Ok(value_json) = serde_json::to_string(&injectable_value) {
                                final_script.push_str(&format!("{key} = {value_json}\n"));
                                tracing::debug!(
                                    "[run_command] Injected env.{} as individual variable",
                                    key
                                );
                            }
                        }
                    }
                }

                final_script.push_str(&format!("variables = {variables_json}\n"));
                tracing::debug!("[run_command] Injected accumulated env, explicit env, individual vars, and workflow variables for Python");
            }

            // Append the actual script
            final_script.push_str(&script_content);

            // Map engine to executor
            let is_js = matches!(engine.as_str(), "node" | "bun" | "javascript" | "js");
            let is_ts = matches!(engine.as_str(), "typescript" | "ts");
            let is_py = matches!(engine.as_str(), "python" | "py");

            if is_js {
                // Determine the working directory for script execution
                let script_working_dir = if let Some(ref script_path) = resolved_script_path {
                    // When using script_file with scripts_base_path, change working dir to script's directory
                    let scripts_base_guard = self.current_scripts_base_path.lock().await;
                    if scripts_base_guard.is_some() {
                        // Use the resolved script path's parent directory
                        script_path.parent().map(|p| p.to_path_buf())
                    } else {
                        None
                    }
                } else {
                    None
                };

                // Create shared log buffer for real-time log capture (useful for timeout scenarios)
                let include_logs = args.include_logs.unwrap_or(true);
                let log_buffer = if include_logs {
                    Some(scripting_engine::ScriptLogBuffer::new())
                } else {
                    None
                };

                // Create event channel to collect workflow events (including screenshots)
                let (event_tx, mut event_rx) = create_event_channel();
                // Store screenshots with metadata: (index, timestamp, annotation, element, base64)
                #[allow(clippy::type_complexity)]
                let collected_screenshots: Arc<
                    std::sync::Mutex<Vec<(usize, String, Option<String>, Option<String>, String)>>,
                > = Arc::new(std::sync::Mutex::new(Vec::new()));
                let screenshots_clone = collected_screenshots.clone();

                // Create progress token for MCP notifications
                let progress_token = ProgressToken(NumberOrString::String(
                    format!("run-command-{}", std::process::id()).into(),
                ));

                // Clone peer for the event handler task
                let peer_clone = peer.clone();
                let broadcast_peers_clone = self.broadcast_peers.clone();
                let progress_token_clone = progress_token.clone();

                // Spawn task to collect screenshot events AND forward progress notifications
                let screenshot_collector = tokio::spawn(async move {
                    let mut index = 0usize;
                    while let Some(event) = event_rx.recv().await {
                        match event {
                            WorkflowEvent::Screenshot {
                                base64: Some(b64),
                                timestamp,
                                annotation,
                                element,
                                ..
                            } => {
                                if let Ok(mut screenshots) = screenshots_clone.lock() {
                                    screenshots.push((index, timestamp, annotation, element, b64));
                                    index += 1;
                                }
                            }
                            WorkflowEvent::Progress {
                                current,
                                total,
                                message,
                                ..
                            } => {
                                // Broadcast progress events to ALL connected MCP clients (fire-and-forget)
                                // Non-blocking to avoid holding request slot during slow peer notifications
                                let peers_for_progress = broadcast_peers_clone.clone();
                                let progress_token_for_spawn = progress_token_clone.clone();
                                tokio::spawn(async move {
                                    let mut peers = peers_for_progress.lock().await;
                                    let mut dead_indices = Vec::new();
                                    for (i, p) in peers.iter().enumerate() {
                                        if p.notify_progress(ProgressNotificationParam {
                                            progress_token: progress_token_for_spawn.clone(),
                                            progress: current,
                                            total,
                                            message: message.clone(),
                                        })
                                        .await
                                        .is_err()
                                        {
                                            dead_indices.push(i);
                                        }
                                    }
                                    // Remove dead peers (reverse order to preserve indices)
                                    for i in dead_indices.into_iter().rev() {
                                        peers.remove(i);
                                        tracing::debug!("[broadcast] Removed dead peer at index {}", i);
                                    }
                                });
                            }
                            WorkflowEvent::Status { text, .. } => {
                                // Forward status events as logging messages (fire-and-forget)
                                if let Some(p) = peer_clone.clone() {
                                    tokio::spawn(async move {
                                        let _ = p
                                            .notify_logging_message(LoggingMessageNotificationParam {
                                                level: LoggingLevel::Info,
                                                logger: Some("run_command".to_string()),
                                                data: json!({
                                                    "type": "status",
                                                    "message": text
                                                }),
                                            })
                                            .await;
                                    });
                                }
                            }
                            WorkflowEvent::Log {
                                level,
                                message,
                                data,
                                ..
                            } => {
                                // Forward log events (fire-and-forget)
                                if let Some(p) = peer_clone.clone() {
                                    let log_level = match level.as_str() {
                                        "error" => LoggingLevel::Error,
                                        "warn" | "warning" => LoggingLevel::Warning,
                                        "debug" => LoggingLevel::Debug,
                                        _ => LoggingLevel::Info,
                                    };
                                    tokio::spawn(async move {
                                        let _ = p
                                            .notify_logging_message(LoggingMessageNotificationParam {
                                                level: log_level,
                                                logger: Some("run_command".to_string()),
                                                data: json!({
                                                    "message": message,
                                                    "data": data
                                                }),
                                            })
                                            .await;
                                    });
                                }
                            }
                            _ => {} // Ignore other events
                        }
                    }
                });

                let execution_id = format!("run-js-{}", std::process::id());
                let execution_future = scripting_engine::execute_javascript_with_nodejs(
                    final_script,
                    cancellation_token,
                    script_working_dir,
                    log_buffer.clone(),
                    Some(event_tx),
                    Some(&execution_id),
                );

                let execution_result = if timeout_ms == 0 {
                    execution_future.await?
                } else {
                    match tokio::time::timeout(timeout_duration, execution_future).await {
                        Ok(result) => result?,
                        Err(_) => {
                            // On timeout, include any logs captured before the timeout if include_logs is true
                            let mut error_data = json!({
                                "reason": format!("Execution exceeded timeout of {}ms", timeout_ms),
                                "engine": "javascript",
                                "timeout_ms": timeout_ms
                            });
                            if let Some(ref buf) = log_buffer {
                                let partial_logs = buf.get_logs();
                                let partial_stderr = buf.get_stderr();
                                if !partial_logs.is_empty() {
                                    error_data["logs"] = json!(partial_logs);
                                }
                                if !partial_stderr.is_empty() {
                                    error_data["stderr"] = json!(partial_stderr);
                                }
                            }
                            return Err(McpError::internal_error(
                                "JavaScript execution timed out",
                                Some(error_data),
                            ));
                        }
                    }
                };

                // Wait for screenshot collector to finish
                let _ = screenshot_collector.await;

                // Extract logs, stderr, and actual result
                let logs = execution_result.get("logs").cloned();
                let stderr = execution_result.get("stderr").cloned();
                let actual_result = execution_result
                    .get("result")
                    .cloned()
                    .unwrap_or(execution_result.clone());

                // Debug log extraction
                if let Some(ref log_array) = logs {
                    if let Some(arr) = log_array.as_array() {
                        info!(
                            "[run_command] Extracted {} log lines from JavaScript execution",
                            arr.len()
                        );
                    }
                }

                // Check if the JavaScript result indicates a failure
                // This makes run_command consistent with execute_browser_script behavior
                if let Some(obj) = actual_result.as_object() {
                    if let Some(status) = obj.get("status") {
                        if let Some(status_str) = status.as_str() {
                            if status_str == "failed" || status_str == "error" {
                                // Extract error message if provided
                                let message = obj
                                    .get("message")
                                    .and_then(|m| m.as_str())
                                    .unwrap_or("Script returned failure status");

                                info!(
                                    "[run_command] Script returned status: '{}', treating as error",
                                    status_str
                                );

                                // Return an error to trigger fallback_id in workflows
                                return Err(McpError::internal_error(
                                    format!("JavaScript execution failed: {message}"),
                                    Some(actual_result),
                                ));
                            }
                        }
                    }
                }

                // Build response
                let include_logs = args.include_logs.unwrap_or(true);
                let mut response = json!({
                    "action": "run_command",
                    "mode": "engine",
                    "engine": engine,
                    "status": "executed_without_error",
                    "result": actual_result
                });

                // Conditionally include logs and stderr based on include_logs parameter
                if include_logs {
                    if let Some(logs) = logs {
                        response["logs"] = logs;
                    }
                    if let Some(stderr) = stderr {
                        response["stderr"] = stderr;
                    }
                }

                span.set_status(true, None);
                span.end();

                // Build content with JSON response and any collected screenshots
                // Add screenshot metadata to response for ordering context
                if let Ok(screenshots) = collected_screenshots.lock() {
                    if !screenshots.is_empty() {
                        let screenshot_metadata: Vec<serde_json::Value> = screenshots
                            .iter()
                            .map(|(idx, ts, annotation, element, _)| {
                                json!({
                                    "index": idx,
                                    "timestamp": ts,
                                    "annotation": annotation,
                                    "element": element
                                })
                            })
                            .collect();
                        response["screenshots"] = json!(screenshot_metadata);
                    }
                }

                let mut contents = vec![Content::json(response)?];

                // Append collected screenshots as image content (in order)
                if let Ok(screenshots) = collected_screenshots.lock() {
                    for (_, _, _, _, base64_image) in screenshots.iter() {
                        contents.push(Content::image(
                            base64_image.clone(),
                            "image/png".to_string(),
                        ));
                    }
                    if !screenshots.is_empty() {
                        info!(
                            "[run_command] Appended {} screenshots to response",
                            screenshots.len()
                        );
                    }
                }

                return Ok(CallToolResult::success(
                    append_monitor_screenshots_if_enabled(&self.desktop, contents, None).await,
                ));
            } else if is_ts {
                // Determine the working directory for script execution
                let script_working_dir = if let Some(ref script_path) = resolved_script_path {
                    // When using script_file with scripts_base_path, change working dir to script's directory
                    let scripts_base_guard = self.current_scripts_base_path.lock().await;
                    if scripts_base_guard.is_some() {
                        // Use the resolved script path's parent directory
                        script_path.parent().map(|p| p.to_path_buf())
                    } else {
                        None
                    }
                } else {
                    None
                };

                // Create shared log buffer for real-time log capture (useful for timeout scenarios)
                let include_logs = args.include_logs.unwrap_or(true);
                let log_buffer = if include_logs {
                    Some(scripting_engine::ScriptLogBuffer::new())
                } else {
                    None
                };

                // Create event channel to collect workflow events (including screenshots)
                let (event_tx, mut event_rx) = create_event_channel();
                // Store screenshots with metadata: (index, timestamp, annotation, element, base64)
                #[allow(clippy::type_complexity)]
                let collected_screenshots: Arc<
                    std::sync::Mutex<Vec<(usize, String, Option<String>, Option<String>, String)>>,
                > = Arc::new(std::sync::Mutex::new(Vec::new()));
                let screenshots_clone = collected_screenshots.clone();

                // Create progress token for MCP notifications
                let progress_token = ProgressToken(NumberOrString::String(
                    format!("run-command-{}", std::process::id()).into(),
                ));

                // Clone peer for the event handler task
                let peer_clone = peer.clone();
                let broadcast_peers_clone2 = self.broadcast_peers.clone();
                let progress_token_clone = progress_token.clone();

                // Spawn task to collect screenshot events AND forward progress notifications
                let screenshot_collector = tokio::spawn(async move {
                    let mut index = 0usize;
                    while let Some(event) = event_rx.recv().await {
                        match event {
                            WorkflowEvent::Screenshot {
                                base64: Some(b64),
                                timestamp,
                                annotation,
                                element,
                                ..
                            } => {
                                if let Ok(mut screenshots) = screenshots_clone.lock() {
                                    screenshots.push((index, timestamp, annotation, element, b64));
                                    index += 1;
                                }
                            }
                            WorkflowEvent::Progress {
                                current,
                                total,
                                message,
                                ..
                            } => {
                                // Broadcast progress events to ALL connected MCP clients (fire-and-forget)
                                // Non-blocking to avoid holding request slot during slow peer notifications
                                let peers_for_progress = broadcast_peers_clone2.clone();
                                let progress_token_for_spawn = progress_token_clone.clone();
                                tokio::spawn(async move {
                                    let mut peers = peers_for_progress.lock().await;
                                    let mut dead_indices = Vec::new();
                                    for (i, p) in peers.iter().enumerate() {
                                        if p.notify_progress(ProgressNotificationParam {
                                            progress_token: progress_token_for_spawn.clone(),
                                            progress: current,
                                            total,
                                            message: message.clone(),
                                        })
                                        .await
                                        .is_err()
                                        {
                                            dead_indices.push(i);
                                        }
                                    }
                                    // Remove dead peers (reverse order to preserve indices)
                                    for i in dead_indices.into_iter().rev() {
                                        peers.remove(i);
                                        tracing::debug!("[broadcast] Removed dead peer at index {}", i);
                                    }
                                });
                            }
                            WorkflowEvent::Status { text, .. } => {
                                // Forward status events as logging messages (fire-and-forget)
                                if let Some(p) = peer_clone.clone() {
                                    tokio::spawn(async move {
                                        let _ = p
                                            .notify_logging_message(LoggingMessageNotificationParam {
                                                level: LoggingLevel::Info,
                                                logger: Some("run_command".to_string()),
                                                data: json!({
                                                    "type": "status",
                                                    "message": text
                                                }),
                                            })
                                            .await;
                                    });
                                }
                            }
                            WorkflowEvent::Log {
                                level,
                                message,
                                data,
                                ..
                            } => {
                                // Forward log events (fire-and-forget)
                                if let Some(p) = peer_clone.clone() {
                                    let log_level = match level.as_str() {
                                        "error" => LoggingLevel::Error,
                                        "warn" | "warning" => LoggingLevel::Warning,
                                        "debug" => LoggingLevel::Debug,
                                        _ => LoggingLevel::Info,
                                    };
                                    tokio::spawn(async move {
                                        let _ = p
                                            .notify_logging_message(LoggingMessageNotificationParam {
                                                level: log_level,
                                                logger: Some("run_command".to_string()),
                                                data: json!({
                                                    "message": message,
                                                    "data": data
                                                }),
                                            })
                                            .await;
                                    });
                                }
                            }
                            _ => {} // Ignore other events
                        }
                    }
                });

                let execution_id = format!("run-ts-{}", std::process::id());
                let execution_future = scripting_engine::execute_typescript_with_nodejs(
                    final_script,
                    cancellation_token,
                    script_working_dir,
                    log_buffer.clone(),
                    Some(event_tx),
                    Some(&execution_id),
                );

                let execution_result = if timeout_ms == 0 {
                    execution_future.await?
                } else {
                    match tokio::time::timeout(timeout_duration, execution_future).await {
                        Ok(result) => result?,
                        Err(_) => {
                            // On timeout, include any logs captured before the timeout if include_logs is true
                            let mut error_data = json!({
                                "reason": format!("Execution exceeded timeout of {}ms", timeout_ms),
                                "engine": "typescript",
                                "timeout_ms": timeout_ms
                            });
                            if let Some(ref buf) = log_buffer {
                                let partial_logs = buf.get_logs();
                                let partial_stderr = buf.get_stderr();
                                if !partial_logs.is_empty() {
                                    error_data["logs"] = json!(partial_logs);
                                }
                                if !partial_stderr.is_empty() {
                                    error_data["stderr"] = json!(partial_stderr);
                                }
                            }
                            return Err(McpError::internal_error(
                                "TypeScript execution timed out",
                                Some(error_data),
                            ));
                        }
                    }
                };

                // Wait for screenshot collector to finish
                let _ = screenshot_collector.await;

                // Extract logs, stderr, and actual result (same as JS)
                let logs = execution_result.get("logs").cloned();
                let stderr = execution_result.get("stderr").cloned();
                let actual_result = execution_result
                    .get("result")
                    .cloned()
                    .unwrap_or(execution_result.clone());

                // Check if the TypeScript result indicates a failure
                if let Some(obj) = actual_result.as_object() {
                    if let Some(status) = obj.get("status") {
                        if let Some(status_str) = status.as_str() {
                            if status_str == "failed" || status_str == "error" {
                                // Extract error message if provided
                                let message = obj
                                    .get("message")
                                    .and_then(|m| m.as_str())
                                    .unwrap_or("Script returned failure status");

                                info!(
                                    "[run_command] TypeScript script returned status: '{}', treating as error",
                                    status_str
                                );

                                // Return an error to trigger fallback_id in workflows
                                return Err(McpError::internal_error(
                                    format!("TypeScript execution failed: {message}"),
                                    Some(actual_result),
                                ));
                            }
                        }
                    }
                }

                // Build response
                let include_logs = args.include_logs.unwrap_or(true);
                let mut response = json!({
                    "action": "run_command",
                    "mode": "engine",
                    "engine": engine,
                    "status": "executed_without_error",
                    "result": actual_result
                });

                // Conditionally include logs and stderr based on include_logs parameter
                if include_logs {
                    if let Some(logs) = logs {
                        response["logs"] = logs;
                    }
                    if let Some(stderr) = stderr {
                        response["stderr"] = stderr;
                    }
                }

                span.set_status(true, None);
                span.end();

                // Build content with JSON response and any collected screenshots
                // Add screenshot metadata to response for ordering context
                if let Ok(screenshots) = collected_screenshots.lock() {
                    if !screenshots.is_empty() {
                        let screenshot_metadata: Vec<serde_json::Value> = screenshots
                            .iter()
                            .map(|(idx, ts, annotation, element, _)| {
                                json!({
                                    "index": idx,
                                    "timestamp": ts,
                                    "annotation": annotation,
                                    "element": element
                                })
                            })
                            .collect();
                        response["screenshots"] = json!(screenshot_metadata);
                    }
                }

                let mut contents = vec![Content::json(response)?];

                // Append collected screenshots as image content (in order)
                if let Ok(screenshots) = collected_screenshots.lock() {
                    for (_, _, _, _, base64_image) in screenshots.iter() {
                        contents.push(Content::image(
                            base64_image.clone(),
                            "image/png".to_string(),
                        ));
                    }
                    if !screenshots.is_empty() {
                        info!(
                            "[run_command] Appended {} screenshots to response",
                            screenshots.len()
                        );
                    }
                }

                return Ok(CallToolResult::success(
                    append_monitor_screenshots_if_enabled(&self.desktop, contents, None).await,
                ));
            } else if is_py {
                // Determine the working directory for script execution
                let script_working_dir = if let Some(ref script_path) = resolved_script_path {
                    // When using script_file with scripts_base_path, change working dir to script's directory
                    let scripts_base_guard = self.current_scripts_base_path.lock().await;
                    if scripts_base_guard.is_some() {
                        // Use the resolved script path's parent directory
                        script_path.parent().map(|p| p.to_path_buf())
                    } else {
                        None
                    }
                } else {
                    None
                };

                let execution_future = scripting_engine::execute_python_with_bindings(
                    final_script,
                    script_working_dir,
                );

                let execution_result = if timeout_ms == 0 {
                    execution_future.await?
                } else {
                    match tokio::time::timeout(timeout_duration, execution_future).await {
                        Ok(result) => result?,
                        Err(_) => {
                            return Err(McpError::internal_error(
                                "Python execution timed out",
                                Some(json!({
                                    "reason": format!("Execution exceeded timeout of {}ms", timeout_ms),
                                    "engine": "python",
                                    "timeout_ms": timeout_ms
                                })),
                            ));
                        }
                    }
                };

                // Extract logs, stderr, and actual result (same structure as JS/TS now)
                let logs = execution_result.get("logs").cloned();
                let stderr = execution_result.get("stderr").cloned();
                let actual_result = execution_result
                    .get("result")
                    .cloned()
                    .unwrap_or(execution_result.clone());

                // Check if the Python result indicates a failure (same as JavaScript)
                if let Some(obj) = actual_result.as_object() {
                    if let Some(status) = obj.get("status") {
                        if let Some(status_str) = status.as_str() {
                            if status_str == "failed" || status_str == "error" {
                                // Extract error message if provided
                                let message = obj
                                    .get("message")
                                    .and_then(|m| m.as_str())
                                    .unwrap_or("Script returned failure status");

                                info!("[run_command] Python script returned status: '{}', treating as error", status_str);

                                // Return an error to trigger fallback_id in workflows
                                return Err(McpError::internal_error(
                                    format!("Python execution failed: {message}"),
                                    Some(actual_result),
                                ));
                            }
                        }
                    }
                }

                // Build response
                let include_logs = args.include_logs.unwrap_or(true);
                let mut response = json!({
                    "action": "run_command",
                    "mode": "engine",
                    "engine": engine,
                    "status": "executed_without_error",
                    "result": actual_result
                });

                // Conditionally include logs and stderr based on include_logs parameter
                if include_logs {
                    if let Some(logs) = logs {
                        response["logs"] = logs;
                    }
                    if let Some(stderr) = stderr {
                        response["stderr"] = stderr;
                    }
                }

                span.set_status(true, None);
                span.end();

                return Ok(CallToolResult::success(
                    append_monitor_screenshots_if_enabled(
                        &self.desktop,
                        vec![Content::json(response)?],
                        None,
                    )
                    .await,
                ));
            } else {
                return Err(McpError::invalid_params(
                    "Unsupported engine. Use 'node'/'bun'/'javascript'/'typescript'/'ts' or 'python'",
                    Some(json!({"engine": engine_value})),
                ));
            }
        }

        // Shell-based execution path
        // For shell mode, we also support script_file but env is ignored
        let run_str = if let Some(script_file) = &args.script_file {
            // Check that both run and script_file aren't provided
            if args.run.is_some() {
                return Err(McpError::invalid_params(
                    "Cannot specify both 'run' and 'script_file'. Use one or the other.",
                    None,
                ));
            }

            // Read script from file
            // Resolve script file with priority order (same logic as engine mode)
            let resolved_path = {
                let script_path = std::path::Path::new(script_file);
                let mut resolved_path = None;
                let mut resolution_attempts = Vec::new();

                // Only resolve if path is relative
                if script_path.is_relative() {
                    tracing::info!(
                        "[SCRIPTS_BASE_PATH] Resolving relative shell script: '{}'",
                        script_file
                    );

                    // Priority 1: Try scripts_base_path if provided
                    let scripts_base_guard = self.current_scripts_base_path.lock().await;
                    if let Some(ref base_path) = *scripts_base_guard {
                        tracing::info!(
                            "[SCRIPTS_BASE_PATH] Checking scripts_base_path for shell script: {}",
                            base_path
                        );
                        let base = std::path::Path::new(base_path);
                        if base.exists() && base.is_dir() {
                            let candidate = base.join(script_file);
                            resolution_attempts
                                .push(format!("scripts_base_path: {}", candidate.display()));
                            tracing::info!(
                                "[SCRIPTS_BASE_PATH] Looking for shell script at: {}",
                                candidate.display()
                            );
                            if candidate.exists() {
                                tracing::info!(
                                    "[SCRIPTS_BASE_PATH] ✓ Found shell script in scripts_base_path: {} -> {}",
                                    script_file,
                                    candidate.display()
                                );
                                resolved_path = Some(candidate);
                            } else {
                                tracing::info!(
                                    "[SCRIPTS_BASE_PATH] ✗ Shell script not found in scripts_base_path: {}",
                                    candidate.display()
                                );
                            }
                        } else {
                            tracing::warn!(
                                "[SCRIPTS_BASE_PATH] Base path does not exist or is not a directory: {}",
                                base_path
                            );
                        }
                    } else {
                        tracing::debug!(
                            "[SCRIPTS_BASE_PATH] No scripts_base_path configured for shell script"
                        );
                    }
                    drop(scripts_base_guard);

                    // Priority 2: Try workflow directory if not found yet
                    if resolved_path.is_none() {
                        let workflow_dir_guard = self.current_workflow_dir.lock().await;
                        if let Some(ref workflow_dir) = *workflow_dir_guard {
                            let candidate = workflow_dir.join(script_file);
                            resolution_attempts
                                .push(format!("workflow_dir: {}", candidate.display()));
                            if candidate.exists() {
                                tracing::info!(
                                    "[run_command shell] Resolved via workflow directory: {} -> {}",
                                    script_file,
                                    candidate.display()
                                );
                                resolved_path = Some(candidate);
                            }
                        }
                    }

                    // Priority 3: Check current directory or use as-is
                    if resolved_path.is_none() {
                        let candidate = script_path.to_path_buf();
                        resolution_attempts.push(format!("as-is: {}", candidate.display()));

                        // Check if file exists before using it
                        if candidate.exists() {
                            tracing::info!(
                                "[run_command shell] Found script file at: {}",
                                candidate.display()
                            );
                            resolved_path = Some(candidate);
                        } else {
                            tracing::warn!(
                                "[run_command shell] Script file not found: {} (tried: {:?})",
                                script_file,
                                resolution_attempts
                            );
                            // Return error immediately for missing file
                            return Err(McpError::invalid_params(
                                format!("Script file '{script_file}' not found"),
                                Some(json!({
                                    "file": script_file,
                                    "resolution_attempts": resolution_attempts,
                                    "error": "File does not exist"
                                })),
                            ));
                        }
                    }
                } else {
                    // Absolute path - check if exists
                    let candidate = script_path.to_path_buf();
                    if candidate.exists() {
                        tracing::info!("[run_command shell] Using absolute path: {}", script_file);
                        resolved_path = Some(candidate);
                    } else {
                        tracing::warn!(
                            "[run_command shell] Absolute script file not found: {}",
                            script_file
                        );
                        return Err(McpError::invalid_params(
                            format!("Script file '{script_file}' not found"),
                            Some(json!({
                                "file": script_file,
                                "error": "File does not exist at absolute path"
                            })),
                        ));
                    }
                }

                resolved_path.unwrap()
            };

            // Read script from resolved file path
            tokio::fs::read_to_string(&resolved_path)
                .await
                .map_err(|e| {
                    McpError::invalid_params(
                        "Failed to read script file",
                        Some(json!({
                            "file": script_file,
                            "resolved_path": resolved_path.to_string_lossy(),
                            "error": e.to_string()
                        })),
                    )
                })?
        } else if let Some(run) = &args.run {
            run.clone()
        } else {
            return Err(McpError::invalid_params(
                "Either 'run' or 'script_file' must be provided",
                None,
            ));
        };

        // Determine which shell to use based on platform and user preference
        let (windows_cmd, unix_cmd) = if cfg!(target_os = "windows") {
            // On Windows, prepare the command for execution
            let shell = args.shell.as_deref().unwrap_or("powershell");
            let command_with_cd = if let Some(ref cwd) = args.working_directory {
                match shell {
                    "cmd" => format!("cd /d \"{cwd}\" && {run_str}"),
                    "powershell" | "pwsh" => format!("cd '{cwd}'; {run_str}"),
                    _ => run_str.clone(), // For other shells, handle cwd differently
                }
            } else {
                run_str.clone()
            };

            let windows_cmd = match shell {
                "bash" => {
                    // Use Git Bash or WSL bash if available
                    format!("bash -c \"{}\"", command_with_cd.replace('\"', "\\\""))
                }
                "sh" => {
                    // Use sh (might be Git Bash)
                    format!("sh -c \"{}\"", command_with_cd.replace('\"', "\\\""))
                }
                "cmd" => {
                    // Use cmd.exe
                    format!("cmd /c \"{command_with_cd}\"")
                }
                "powershell" | "pwsh" => {
                    // Default to PowerShell on Windows
                    command_with_cd
                }
                _ => {
                    // For any other shell
                    command_with_cd
                }
            };
            (Some(windows_cmd), None)
        } else {
            // On Unix-like systems (Linux, macOS)
            let shell = args.shell.as_deref().unwrap_or("bash");
            let command_with_cd = if let Some(ref cwd) = args.working_directory {
                format!("cd '{cwd}' && {run_str}")
            } else {
                run_str.clone()
            };

            let unix_cmd = match shell {
                "python" => format!("python -c \"{}\"", command_with_cd.replace('\"', "\\\"")),
                "node" => format!("node -e \"{}\"", command_with_cd.replace('\"', "\\\"")),
                _ => command_with_cd, // For bash, sh, zsh, etc.
            };
            (None, Some(unix_cmd))
        };

        // Default timeout: 2 minutes (120000ms), 0 means no timeout
        let timeout_ms = args.timeout_ms.unwrap_or(120_000);
        let command_future = self
            .desktop
            .run_command(windows_cmd.as_deref(), unix_cmd.as_deref());

        let output = if timeout_ms == 0 {
            // No timeout
            command_future.await
        } else {
            // Apply timeout
            match tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), command_future)
                .await
            {
                Ok(result) => result,
                Err(_) => {
                    return Err(McpError::internal_error(
                        "Shell command timed out",
                        Some(json!({
                            "reason": format!("Command exceeded timeout of {}ms", timeout_ms),
                            "command": run_str,
                            "shell": args.shell,
                            "working_directory": args.working_directory,
                            "timeout_ms": timeout_ms
                        })),
                    ));
                }
            }
        }
        .map_err(|e| {
            McpError::internal_error(
                "Failed to run command",
                Some(json!({
                    "reason": e.to_string(),
                    "command": run_str,
                    "shell": args.shell,
                    "working_directory": args.working_directory
                })),
            )
        })?;

        span.set_status(true, None);
        span.end();

        Ok(CallToolResult::success(
            append_monitor_screenshots_if_enabled(
                &self.desktop,
                vec![Content::json(json!({
                    "exit_status": output.exit_status,
                    "stdout": output.stdout,
                    "stderr": output.stderr,
                    "command": run_str,
                    "shell": args.shell.unwrap_or_else(|| {
                        if cfg!(target_os = "windows") { "powershell" } else { "bash" }.to_string()
                    }),
                    "working_directory": args.working_directory
                }))?],
                None,
            )
            .await,
        ))
    }

    #[tool(
        description = "Activates the window containing the specified element, bringing it to the foreground."
    )]
    pub async fn activate_element(
        &self,
        Parameters(args): Parameters<ActivateElementArgs>,
    ) -> Result<CallToolResult, McpError> {
        // Start telemetry span
        let mut span = StepSpan::new("activate_element", None);

        // Add comprehensive telemetry attributes
        span.set_attribute("selector", args.selector.selector.clone());
        if let Some(retries) = args.action.retries {
            span.set_attribute("retry.max_attempts", retries.to_string());
        }

        // Check if we need to perform window management (only for direct MCP calls, not sequences)
        let should_restore = {
            let in_sequence = self.in_sequence.lock().unwrap_or_else(|e| e.into_inner());
            let flag_value = *in_sequence;
            let should_restore_value = !flag_value;
            tracing::info!(
                "[activate_element] Flag check: in_sequence={}, should_restore={}",
                flag_value,
                should_restore_value
            );
            should_restore_value
        };

        if should_restore {
            tracing::info!(
                "[activate_element] Direct MCP call detected - performing window management"
            );
            let _ = self
                .prepare_window_management(
                    &args.selector.process,
                    None,
                    None,
                    None,
                    &args.window_mgmt,
                )
                .await;
        } else {
            tracing::debug!("[activate_element] In sequence - skipping window management (dispatch_tool handles it)");
        }

        let ((_result, element), successful_selector) =
            match find_and_execute_with_retry_with_fallback(
                &self.desktop,
                &args.selector.build_full_selector(),
                None, // ActivateElement doesn't have alternative selectors
                args.selector.build_fallback_selectors().as_deref(),
                args.action.timeout_ms,
                args.action.retries,
                |element| async move { element.activate_window() },
            )
            .await
            {
                Ok(((result, element), selector)) => Ok(((result, element), selector)),
                Err(e) => {
                    // Restore windows before returning error
                    self.restore_window_management(should_restore).await;
                    Err(build_element_not_found_error(
                        &args.selector.build_full_selector(),
                        None,
                        args.selector.build_fallback_selectors().as_deref(),
                        e,
                    ))
                }
            }?;

        let element_info = build_element_info(&element);
        let target_pid = element.process_id().unwrap_or(0);

        // Add verification to check if activation actually worked
        tokio::time::sleep(std::time::Duration::from_millis(500)).await; // Give window system time to respond

        let mut verification;

        // Method 1: Check if target application is now the focused app (most reliable)
        if let Ok(focused_element) = self.desktop.focused_element() {
            if let Ok(focused_pid) = focused_element.process_id() {
                let pid_match = focused_pid == target_pid;
                verification = json!({
                    "activation_verified": pid_match,
                    "verification_method": "process_id_comparison",
                    "target_pid": target_pid,
                    "focused_pid": focused_pid,
                    "pid_match": pid_match
                });

                // Method 2: Also check if the specific element is focused (additional confirmation)
                if pid_match {
                    let element_focused = element.is_focused().unwrap_or(false);
                    if let Some(obj) = verification.as_object_mut() {
                        obj.insert("target_element_focused".to_string(), json!(element_focused));
                    }
                }
            } else {
                verification = json!({
                    "activation_verified": false,
                    "verification_method": "process_id_comparison",
                    "target_pid": target_pid,
                    "error": "Could not get focused element PID"
                });
            }
        } else {
            verification = json!({
                "activation_verified": false,
                "verification_method": "process_id_comparison",
                "target_pid": target_pid,
                "error": "Could not get focused element"
            });
        }

        // Determine final status based on verification
        let verified_success = verification
            .get("activation_verified")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let final_status = if verified_success {
            "executed_without_error"
        } else {
            "executed_without_error_unverified"
        };

        let mut result_json = json!({
            "action": "activate_element",
            "status": final_status,
            "element": element_info,
            "selector_used": successful_selector,
            "selectors_tried": get_selectors_tried_all(&args.selector.build_full_selector(), None, args.selector.build_fallback_selectors().as_deref()),
            "timestamp": chrono::Utc::now().to_rfc3339(),
            "verification": verification
        });

        // Always attach UI tree for activated elements to help with next actions
        maybe_attach_tree(
            &self.desktop,
            args.tree.include_tree_after_action,
            args.tree.tree_max_depth,
            args.tree.tree_from_selector.as_deref(),
            args.tree.include_detailed_attributes,
            None,
            Some(element.process_id().unwrap_or(0)),
            &mut result_json,
            Some(&element),
            false,
        )
        .await;

        // Restore windows after activation
        self.restore_window_management(should_restore).await;

        span.set_status(true, None);
        span.end();

        append_window_screenshot_to_json(
            &self.desktop,
            &args.selector.process,
            &mut result_json,
            args.window_screenshot.include_window_screenshot,
        )
        .await;
        let contents = vec![Content::json(result_json)?];
        let contents = append_monitor_screenshots_if_enabled(
            &self.desktop,
            contents,
            args.monitor.include_monitor_screenshots,
        )
        .await;
        Ok(CallToolResult::success(contents))
    }

    #[tool(
        description = "Delays execution for a specified number of milliseconds. Useful for waiting between actions to ensure UI stability."
    )]
    async fn delay(
        &self,
        Parameters(args): Parameters<DelayArgs>,
    ) -> Result<CallToolResult, McpError> {
        // Start telemetry span
        let mut span = StepSpan::new("delay", None);

        // Add comprehensive telemetry attributes
        span.set_attribute("delay_ms", args.delay_ms.to_string());
        let start_time = chrono::Utc::now();

        // Use tokio's sleep for async delay
        tokio::time::sleep(std::time::Duration::from_millis(args.delay_ms)).await;

        let end_time = chrono::Utc::now();
        let actual_delay_ms = (end_time - start_time).num_milliseconds();

        span.set_status(true, None);
        span.end();

        Ok(CallToolResult::success(
            append_monitor_screenshots_if_enabled(
                &self.desktop,
                vec![Content::json(json!({
                    "action": "delay",
                    "status": "executed_without_error",
                    "requested_delay_ms": args.delay_ms,
                    "actual_delay_ms": actual_delay_ms,
                    "timestamp": end_time.to_rfc3339()
                }))?],
                None,
            )
            .await,
        ))
    }

    #[tool(
        description = "Ask the user a clarifying question when you need more information to proceed. Use this when uncertain about business logic, which element to interact with, or any decision that requires human judgment. The user will see a prompt with your question and can provide an answer. When choices are provided, clickable buttons are shown."
    )]
    async fn ask_user(
        &self,
        peer: Peer<RoleServer>,
        Parameters(args): Parameters<AskUserArgs>,
    ) -> Result<CallToolResult, McpError> {
        use std::collections::BTreeMap;

        // Build the message to show the user
        let mut message = args.question.clone();

        // Add context if provided
        if let Some(ctx) = &args.context {
            message = format!("{}\n\nContext: {}", message, ctx);
        }

        tracing::info!("[ask_user] Requesting user input: {}", args.question);

        // Build schema dynamically based on whether choices are provided
        let schema = if let Some(choices) = &args.choices {
            // Enum schema for clickable choices
            tracing::info!(
                "[ask_user] Building enum schema with {} choices",
                choices.len()
            );
            let mut properties = BTreeMap::new();
            properties.insert(
                "answer".to_string(),
                PrimitiveSchema::Enum(EnumSchema::new(choices.clone())),
            );
            ElicitationSchema::new(properties)
        } else {
            // String schema for free-form input
            tracing::info!("[ask_user] Building string schema for free-form input");
            let mut properties = BTreeMap::new();
            properties.insert(
                "answer".to_string(),
                PrimitiveSchema::String(
                    StringSchema::new().description("Your answer to the question"),
                ),
            );
            ElicitationSchema::new(properties)
        };

        // Use raw elicitation with custom schema
        match try_elicit_raw(&self.elicitation_peer, &peer, &message, schema).await {
            Some(response) => {
                // Extract answer from response JSON
                let answer = response
                    .get("answer")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                tracing::info!("[ask_user] User responded: {}", answer);

                // SIDE EFFECT: Check if user confirmed mode switch to Act mode
                // This follows MCP elicitation pattern where server-side actions happen
                // DURING tool execution, BEFORE returning result
                let answer_lower = answer.to_lowercase();
                if answer_lower.contains("switch to act")
                    || answer_lower.contains("yes, switch")
                    || (answer_lower.contains("yes") && answer_lower.contains("act"))
                {
                    tracing::info!("[ask_user] Detected mode switch request, switching all clients to Act mode");
                    let mut modes_guard = self.client_modes.lock().await;
                    // Switch all clients to act mode with no blocked tools
                    for (client_name, client_state) in modes_guard.iter_mut() {
                        tracing::info!(
                            "[ask_user] Switching client '{}' from '{}' to 'act' mode",
                            client_name,
                            client_state.mode
                        );
                        client_state.mode = "act".to_string();
                        client_state.blocked_tools.clear();
                    }
                }

                Ok(CallToolResult::success(vec![Content::json(json!({
                    "action": "ask_user",
                    "status": "answered",
                    "question": args.question,
                    "answer": answer
                }))?]))
            }
            None => {
                tracing::info!("[ask_user] User declined or elicitation not supported");
                Ok(CallToolResult::success(vec![Content::json(json!({
                    "action": "ask_user",
                    "status": "declined",
                    "question": args.question,
                    "message": "User declined to answer or elicitation is not supported by the client"
                }))?]))
            }
        }
    }

    #[tool(
        description = "Performs a mouse drag operation from start to end coordinates. Use ui_diff_before_after:true to see changes (no need to call get_window_tree after)."
    )]
    async fn mouse_drag(
        &self,
        Parameters(args): Parameters<MouseDragArgs>,
    ) -> Result<CallToolResult, McpError> {
        // Start telemetry span
        let mut span = StepSpan::new("mouse_drag", None);

        // Add comprehensive telemetry attributes
        span.set_attribute("selector", args.selector.selector.clone());
        // Mouse drag uses x,y coordinates, not selectors
        if let Some(retries) = args.action.retries {
            span.set_attribute("retry.max_attempts", retries.to_string());
        }

        // Check if we need to perform window management (only for direct MCP calls, not sequences)
        let should_restore = {
            let in_sequence = self.in_sequence.lock().unwrap_or_else(|e| e.into_inner());
            !*in_sequence
        };

        if should_restore {
            let _ = self
                .prepare_window_management(
                    &args.selector.process,
                    None,
                    None,
                    None,
                    &args.window_mgmt,
                )
                .await;
        }

        let start_x = args.start_x;
        let start_y = args.start_y;
        let end_x = args.end_x;
        let end_y = args.end_y;
        let highlight_before = args.highlight.highlight_before_action;
        let action = move |element: UIElement| async move {
            // Apply highlighting before action if enabled
            if highlight_before {
                let _ = element.highlight_before_action("mouse_drag");
            }
            element.mouse_drag(start_x, start_y, end_x, end_y)
        };

        let ((_result, element), successful_selector) =
            match find_and_execute_with_retry_with_fallback(
                &self.desktop,
                &args.selector.build_full_selector(),
                args.selector.build_alternative_selectors().as_deref(),
                args.selector.build_fallback_selectors().as_deref(),
                args.action.timeout_ms,
                args.action.retries,
                action,
            )
            .await
            {
                Ok(((result, element), selector)) => Ok(((result, element), selector)),
                Err(e) => Err(build_element_not_found_error(
                    &args.selector.build_full_selector(),
                    args.selector.build_alternative_selectors().as_deref(),
                    args.selector.build_fallback_selectors().as_deref(),
                    e,
                )),
            }?;

        let element_info = build_element_info(&element);

        let mut result_json = json!({
            "action": "mouse_drag",
            "status": "executed_without_error",
            "element": element_info,
            "selector_used": successful_selector,
            "selectors_tried": get_selectors_tried_all(&args.selector.build_full_selector(), args.selector.build_alternative_selectors().as_deref(), args.selector.build_fallback_selectors().as_deref()),
            "start": (args.start_x, args.start_y),
            "end": (args.end_x, args.end_y),
            "timestamp": chrono::Utc::now().to_rfc3339()
        });

        // POST-ACTION VERIFICATION
        if !args.action.verify_element_exists.is_empty()
            || !args.action.verify_element_not_exists.is_empty()
        {
            let verify_timeout_ms = args.action.verify_timeout_ms.unwrap_or(2000);

            let verify_exists_opt = if args.action.verify_element_exists.is_empty() {
                None
            } else {
                Some(args.action.verify_element_exists.as_str())
            };
            let verify_not_exists_opt = if args.action.verify_element_not_exists.is_empty() {
                None
            } else {
                Some(args.action.verify_element_not_exists.as_str())
            };

            match crate::helpers::verify_post_action(
                &self.desktop,
                &element,
                verify_exists_opt,
                verify_not_exists_opt,
                verify_timeout_ms,
                &successful_selector,
            )
            .await
            {
                Ok(verification_result) => {
                    tracing::info!(
                        "[mouse_drag] Verification passed: method={}, details={}",
                        verification_result.method,
                        verification_result.details
                    );
                    span.set_attribute("verification.passed", "true".to_string());
                    span.set_attribute("verification.method", verification_result.method.clone());
                    span.set_attribute(
                        "verification.elapsed_ms",
                        verification_result.elapsed_ms.to_string(),
                    );

                    let verification_json = json!({
                        "passed": verification_result.passed,
                        "method": verification_result.method,
                        "details": verification_result.details,
                        "elapsed_ms": verification_result.elapsed_ms,
                        "timestamp": chrono::Utc::now().to_rfc3339(),
                    });

                    if let Some(obj) = result_json.as_object_mut() {
                        obj.insert("verification".to_string(), verification_json);
                    }
                }
                Err(e) => {
                    tracing::error!("[mouse_drag] Verification failed: {}", e);
                    span.set_attribute("verification.passed", "false".to_string());
                    span.set_status(false, Some("Verification failed"));
                    span.end();
                    return Err(McpError::internal_error(
                        format!("Post-action verification failed: {e}"),
                        Some(json!({
                            "selector_used": successful_selector,
                            "verify_exists": args.action.verify_element_exists,
                            "verify_not_exists": args.action.verify_element_not_exists,
                            "timeout_ms": verify_timeout_ms,
                        })),
                    ));
                }
            }
        }

        // Action tools only support UI diff, not standalone tree attachment

        self.restore_window_management(should_restore).await;

        span.set_status(true, None);
        span.end();

        append_window_screenshot_to_json(
            &self.desktop,
            &args.selector.process,
            &mut result_json,
            args.window_screenshot.include_window_screenshot,
        )
        .await;
        let contents = vec![Content::json(result_json)?];
        let contents = append_monitor_screenshots_if_enabled(
            &self.desktop,
            contents,
            args.monitor.include_monitor_screenshots,
        )
        .await;
        Ok(CallToolResult::success(contents))
    }

    #[tool(
        description = "Validates that an element exists and provides detailed information about it. This is a read-only operation that NEVER throws errors. Returns status='success' with exists=true when found, or status='failed' with exists=false when not found. Use {step_id}_status or {step_id}_result.exists for conditional logic. This is the preferred tool for checking optional/conditional UI elements."
    )]
    pub async fn validate_element(
        &self,
        Parameters(args): Parameters<ValidateElementArgs>,
    ) -> Result<CallToolResult, McpError> {
        // Start telemetry span
        let mut span = StepSpan::new("validate_element", None);

        // Add comprehensive telemetry attributes
        span.set_attribute("selector", args.selector.selector.clone());
        if let Some(timeout) = args.action.timeout_ms {
            span.set_attribute("timeout_ms", timeout.to_string());
        }
        if let Some(retries) = args.action.retries {
            span.set_attribute("retry.max_attempts", retries.to_string());
        }

        // Check if we need to perform window management (only for direct MCP calls, not sequences)
        let should_restore = {
            let in_sequence = self.in_sequence.lock().unwrap_or_else(|e| e.into_inner());
            !*in_sequence
        };

        if should_restore {
            tracing::info!(
                "[validate_element] Direct MCP call detected - performing window management"
            );
            let _ = self
                .prepare_window_management(
                    &args.selector.process,
                    None,
                    None,
                    None,
                    &args.window_mgmt,
                )
                .await;
        } else {
            tracing::debug!("[validate_element] In sequence - skipping window management (dispatch_tool handles it)");
        }

        // For validation, the "action" is just succeeding.
        let action = |element: UIElement| async move { Ok(element) };

        let operation_start = std::time::Instant::now();
        match find_and_execute_with_retry_with_fallback(
            &self.desktop,
            &args.selector.build_full_selector(),
            args.selector.build_alternative_selectors().as_deref(),
            args.selector.build_fallback_selectors().as_deref(),
            args.action.timeout_ms,
            args.action.retries,
            action,
        )
        .await
        {
            Ok(((element, _), successful_selector)) => {
                let operation_time_ms = operation_start.elapsed().as_millis() as i64;
                span.set_attribute("operation.duration_ms", operation_time_ms.to_string());
                span.set_attribute("element.found", "true".to_string());
                span.set_attribute("selector.successful", successful_selector.clone());

                // Add element metadata
                if let Some(name) = element.name() {
                    span.set_attribute("element.name", name);
                }
                let mut element_info = build_element_info(&element);
                if let Some(obj) = element_info.as_object_mut() {
                    obj.insert("exists".to_string(), json!(true));
                }

                let mut result_json = json!({
                    "action": "validate_element",
                    "status": "executed_without_error",
                    "element": element_info,
                    "selector_used": successful_selector,
                    "selectors_tried": get_selectors_tried_all(&args.selector.build_full_selector(), args.selector.build_alternative_selectors().as_deref(), args.selector.build_fallback_selectors().as_deref()),
                    "timestamp": chrono::Utc::now().to_rfc3339()
                });
                maybe_attach_tree(
                    &self.desktop,
                    args.tree.include_tree_after_action,
                    args.tree.tree_max_depth,
                    args.tree.tree_from_selector.as_deref(),
                    args.tree.include_detailed_attributes,
                    None,
                    element.process_id().ok(),
                    &mut result_json,
                    Some(&element),
                    false,
                )
                .await;

                self.restore_window_management(should_restore).await;

                span.set_status(true, None);
                span.end();

                append_window_screenshot_to_json(
                    &self.desktop,
                    &args.selector.process,
                    &mut result_json,
                    args.window_screenshot.include_window_screenshot,
                )
                .await;
                let contents = vec![Content::json(result_json)?];
                let contents = append_monitor_screenshots_if_enabled(
                    &self.desktop,
                    contents,
                    args.monitor.include_monitor_screenshots,
                )
                .await;
                Ok(CallToolResult::success(contents))
            }
            Err(e) => {
                let selectors_tried = get_selectors_tried_all(
                    &args.selector.build_full_selector(),
                    args.selector.build_alternative_selectors().as_deref(),
                    args.selector.build_fallback_selectors().as_deref(),
                );
                let reason_payload = json!({
                    "error_type": "ElementNotFound",
                    "message": format!("The specified element could not be found after trying all selectors. Original error: {}", e),
                    "selectors_tried": selectors_tried,
                    "suggestions": [
                        "This is normal if the element is optional/conditional. Use the 'exists: false' result in conditional logic (if expressions, jumps, or run_command scripts).",
                        "Call `get_window_tree` again to get a fresh view of the UI; it might have changed.",
                        "Verify the element's 'name' and 'role' in the new UI tree. The 'name' attribute might be empty or different from the visible text.",
                        "If the element has no 'name', use its numeric ID selector (e.g., '#12345').",
                        "Consider using alternative_selectors or fallback_selectors for elements with multiple possible states."
                    ]
                });

                // This is not a tool error, but a validation failure, so we return success with the failure info.

                self.restore_window_management(should_restore).await;

                span.set_attribute("element.found", "false".to_string());
                span.set_status(true, None);
                span.end();

                let mut result_json = json!({
                    "action": "validate_element",
                    "status": "execution_error",
                    "exists": false,
                    "reason": reason_payload,
                    "timestamp": chrono::Utc::now().to_rfc3339()
                });
                append_window_screenshot_to_json(
                    &self.desktop,
                    &args.selector.process,
                    &mut result_json,
                    args.window_screenshot.include_window_screenshot,
                )
                .await;
                let contents = vec![Content::json(result_json)?];
                let contents = append_monitor_screenshots_if_enabled(
                    &self.desktop,
                    contents,
                    args.monitor.include_monitor_screenshots,
                )
                .await;
                Ok(CallToolResult::success(contents))
            }
        }
    }

    #[tool(description = "Highlights an element with a colored border for visual confirmation.")]
    async fn highlight_element(
        &self,
        Parameters(args): Parameters<HighlightElementArgs>,
    ) -> Result<CallToolResult, McpError> {
        // Start telemetry span
        let mut span = StepSpan::new("highlight_element", None);

        // Add comprehensive telemetry attributes
        span.set_attribute("selector", args.selector.selector.clone());
        if let Some(ref color) = args.color {
            span.set_attribute("color", format!("#{color:08X}"));
        }
        if let Some(retries) = args.action.retries {
            span.set_attribute("retry.max_attempts", retries.to_string());
        }

        // Check if we need to perform window management (only for direct MCP calls, not sequences)
        let should_restore = {
            let in_sequence = self.in_sequence.lock().unwrap_or_else(|e| e.into_inner());
            !*in_sequence
        };

        if should_restore {
            tracing::info!(
                "[highlight_element] Direct MCP call detected - performing window management"
            );
            let _ = self
                .prepare_window_management(
                    &args.selector.process,
                    None,
                    None,
                    None,
                    &args.window_mgmt,
                )
                .await;
        } else {
            tracing::debug!("[highlight_element] In sequence - skipping window management (dispatch_tool handles it)");
        }

        let duration = args.duration_ms.map(std::time::Duration::from_millis);
        let color = args.color;

        let text = args.text.as_deref();

        #[cfg(target_os = "windows")]
        let text_position = args.text_position.clone().map(|pos| pos.into());
        #[cfg(not(target_os = "windows"))]
        let text_position = None;

        #[cfg(target_os = "windows")]
        let font_style =
            if args.font_size.is_some() || args.font_bold.is_some() || args.font_color.is_some() {
                Some(computeruse::platforms::windows::FontStyle {
                    size: args.font_size.unwrap_or(14),
                    bold: args.font_bold.unwrap_or(false),
                    color: args.font_color.unwrap_or(0),
                })
            } else {
                None
            };
        #[cfg(not(target_os = "windows"))]
        let font_style = None;

        let action = {
            move |element: UIElement| {
                let color = color;
                let local_duration = duration;
                let local_text_position = text_position;
                let local_font_style = font_style.clone();
                async move {
                    let handle = element.highlight(
                        color,
                        local_duration,
                        text,
                        local_text_position,
                        local_font_style,
                    )?;
                    Ok(handle)
                }
            }
        };

        // Use a shorter default timeout for highlight to avoid long waits
        let effective_timeout_ms = args.action.timeout_ms.or(Some(1000));

        let ((handle, element), successful_selector) =
            match find_and_execute_with_retry_with_fallback(
                &self.desktop,
                &args.selector.build_full_selector(),
                args.selector.build_alternative_selectors().as_deref(),
                args.selector.build_fallback_selectors().as_deref(),
                effective_timeout_ms,
                args.action.retries,
                action,
            )
            .await
            {
                Ok(((result, element), selector)) => Ok(((result, element), selector)),
                Err(e) => {
                    // Restore windows before returning error
                    self.restore_window_management(should_restore).await;
                    Err(build_element_not_found_error(
                        &args.selector.build_full_selector(),
                        args.selector.build_alternative_selectors().as_deref(),
                        args.selector.build_fallback_selectors().as_deref(),
                        e,
                    ))
                }
            }?;

        // Register handle and schedule cleanup
        {
            let mut list = self.active_highlights.lock().await;
            list.push(handle);
        }
        let active_highlights_clone = self.active_highlights.clone();
        let expire_after = args.duration_ms.unwrap_or(1000);
        tokio::spawn(
            async move {
                tokio::time::sleep(Duration::from_millis(expire_after)).await;
                let mut list = active_highlights_clone.lock().await;
                let _ = list.pop();
            }
            .in_current_span(),
        );

        // Build minimal response by default; gate heavy element info behind flag
        let mut result_json = json!({
            "action": "highlight_element",
            "status": "executed_without_error",
            "selector_used": successful_selector,
            "selectors_tried": get_selectors_tried_all(&args.selector.build_full_selector(), args.selector.build_alternative_selectors().as_deref(), args.selector.build_fallback_selectors().as_deref()),
            "color": args.color.unwrap_or(0x0000FF),
            "duration_ms": args.duration_ms.unwrap_or(1000),
            "visibility": { "requested_ms": args.duration_ms.unwrap_or(1000) },
            "timestamp": chrono::Utc::now().to_rfc3339()
        });

        if args.include_element_info.unwrap_or(false) {
            let element_info = build_element_info(&element);
            result_json["element"] = element_info;
        }
        // Action tools only support UI diff, not standalone tree attachment

        self.restore_window_management(should_restore).await;

        span.set_status(true, None);
        span.end();

        append_window_screenshot_to_json(
            &self.desktop,
            &args.selector.process,
            &mut result_json,
            args.window_screenshot.include_window_screenshot,
        )
        .await;
        let contents = vec![Content::json(result_json)?];
        let contents = append_monitor_screenshots_if_enabled(
            &self.desktop,
            contents,
            args.monitor.include_monitor_screenshots,
        )
        .await;
        Ok(CallToolResult::success(contents))
    }

    #[tool(
        description = "Hide any active inspect overlay that was shown via get_window_tree with show_overlay parameter."
    )]
    async fn hide_inspect_overlay(&self) -> Result<CallToolResult, McpError> {
        #[cfg(target_os = "windows")]
        {
            computeruse::hide_inspect_overlay();
            info!("Signaled inspect overlay to close");
        }

        Ok(CallToolResult::success(vec![Content::json(json!({
            "action": "hide_inspect_overlay",
            "status": "executed_without_error",
            "message": "Inspect overlay hidden"
        }))?]))
    }

    #[tool(
        description = "Waits for an element to meet a specific condition (visible, enabled, focused, exists)."
    )]
    async fn wait_for_element(
        &self,
        Parameters(args): Parameters<WaitForElementArgs>,
    ) -> Result<CallToolResult, McpError> {
        // Start telemetry span
        let mut span = StepSpan::new("wait_for_element", None);

        // Add comprehensive telemetry attributes
        span.set_attribute("selector", args.selector.selector.clone());
        if let Some(retries) = args.action.retries {
            span.set_attribute("retry.max_attempts", retries.to_string());
        }
        info!(
            "[wait_for_element] Called with selector: '{}', condition: '{}', timeout_ms: {:?}, include_tree: {:?}",
            args.selector.selector, args.condition, args.action.timeout_ms, args.tree.include_tree_after_action
        );

        // Check if we need to perform window management (only for direct MCP calls, not sequences)
        let should_restore = {
            let in_sequence = self.in_sequence.lock().unwrap_or_else(|e| e.into_inner());
            !*in_sequence
        };

        if should_restore {
            tracing::info!(
                "[wait_for_element] Direct MCP call detected - performing window management"
            );
            let _ = self
                .prepare_window_management(
                    &args.selector.process,
                    None,
                    None,
                    None,
                    &args.window_mgmt,
                )
                .await;
        } else {
            tracing::debug!("[wait_for_element] In sequence - skipping window management (dispatch_tool handles it)");
        }

        let locator = self
            .desktop
            .locator(Selector::from(args.selector.selector.as_str()));
        let timeout = get_timeout(args.action.timeout_ms);
        let condition_lower = args.condition.to_lowercase();

        // For the "exists" condition, we can use the standard wait
        if condition_lower == "exists" {
            info!(
                "[wait_for_element] Waiting for element to exist: selector='{}', timeout={:?}",
                args.selector.selector, timeout
            );
            match locator.wait(timeout).await {
                Ok(element) => {
                    info!(
                        "[wait_for_element] Element found for selector='{}' within timeout.",
                        args.selector.selector
                    );
                    let mut result_json = json!({
                        "action": "wait_for_element",
                        "status": "executed_without_error",
                        "condition": args.condition,
                        "condition_met": true,
                        "selector": args.selector.selector,
                        "timeout_ms": timeout.unwrap_or(std::time::Duration::from_millis(5000)).as_millis(),
                        "timestamp": chrono::Utc::now().to_rfc3339()
                    });

                    maybe_attach_tree(
                        &self.desktop,
                        args.tree.include_tree_after_action,
                        args.tree.tree_max_depth,
                        args.tree.tree_from_selector.as_deref(),
                        None, // include_detailed_attributes - use default
                        None, // tree_output_format - use default
                        element.process_id().ok(),
                        &mut result_json,
                        Some(&element),
                        false,
                    )
                    .await;

                    self.restore_window_management(should_restore).await;

                    span.set_status(true, None);
                    span.end();

                    append_window_screenshot_to_json(
                        &self.desktop,
                        &args.selector.process,
                        &mut result_json,
                        args.window_screenshot.include_window_screenshot,
                    )
                    .await;
                    let contents = vec![Content::json(result_json)?];
                    let contents = append_monitor_screenshots_if_enabled(
                        &self.desktop,
                        contents,
                        args.monitor.include_monitor_screenshots,
                    )
                    .await;
                    return Ok(CallToolResult::success(contents));
                }
                Err(e) => {
                    let error_msg = format!("Element not found within timeout: {e}");
                    info!(
                        "[wait_for_element] Element NOT found for selector='{}' within timeout. Error: {}",
                        args.selector.selector, e
                    );

                    self.restore_window_management(should_restore).await;

                    return Err(McpError::internal_error(
                        error_msg,
                        Some(json!({
                            "selector": args.selector.selector,
                            "condition": args.condition,
                            "timeout_ms": timeout.unwrap_or(std::time::Duration::from_millis(5000)).as_millis(),
                            "error": e.to_string()
                        })),
                    ));
                }
            }
        }

        // For other conditions (visible, enabled, focused), we need to poll
        let start_time = std::time::Instant::now();
        let timeout_duration = timeout.unwrap_or(std::time::Duration::from_millis(5000));
        info!(
            "[wait_for_element] Polling for condition '{}' on selector='{}' with timeout {:?}",
            args.condition, args.selector.selector, timeout_duration
        );

        loop {
            // Check if we've exceeded the timeout
            if start_time.elapsed() > timeout_duration {
                let timeout_msg = format!(
                    "Timeout waiting for element to be {} within {}ms",
                    args.condition,
                    timeout_duration.as_millis()
                );
                info!(
                    "[wait_for_element] Timeout exceeded for selector='{}', condition='{}', waited {}ms",
                    args.selector.selector, args.condition, start_time.elapsed().as_millis()
                );

                self.restore_window_management(should_restore).await;

                return Err(McpError::internal_error(
                    timeout_msg,
                    Some(json!({
                        "selector": args.selector.selector,
                        "condition": args.condition,
                        "timeout_ms": timeout_duration.as_millis(),
                        "elapsed_ms": start_time.elapsed().as_millis()
                    })),
                ));
            }

            // Try to find the element with a short timeout
            match locator
                .wait(Some(std::time::Duration::from_millis(100)))
                .await
            {
                Ok(element) => {
                    info!(
                        "[wait_for_element] Element found for selector='{}', checking condition '{}'",
                        args.selector.selector, args.condition
                    );
                    // Element exists, now check the specific condition
                    let condition_met = match condition_lower.as_str() {
                        "visible" => {
                            let v = element.is_visible().unwrap_or(false);
                            info!(
                                "[wait_for_element] is_visible() for selector='{}': {}",
                                args.selector.selector, v
                            );
                            v
                        }
                        "enabled" => {
                            let v = element.is_enabled().unwrap_or(false);
                            info!(
                                "[wait_for_element] is_enabled() for selector='{}': {}",
                                args.selector.selector, v
                            );
                            v
                        }
                        "focused" => {
                            let v = element.is_focused().unwrap_or(false);
                            info!(
                                "[wait_for_element] is_focused() for selector='{}': {}",
                                args.selector.selector, v
                            );
                            v
                        }
                        _ => {
                            info!(
                                "[wait_for_element] Invalid condition provided: '{}'",
                                args.condition
                            );

                            self.restore_window_management(should_restore).await;

                            return Err(McpError::invalid_params(
                                "Invalid condition. Valid: exists, visible, enabled, focused",
                                Some(json!({"provided_condition": args.condition})),
                            ));
                        }
                    };

                    if condition_met {
                        info!(
                            "[wait_for_element] Condition '{}' met for selector='{}' after {}ms",
                            args.condition,
                            args.selector.selector,
                            start_time.elapsed().as_millis()
                        );
                        // Condition is met, return success
                        let mut result_json = json!({
                            "action": "wait_for_element",
                            "status": "executed_without_error",
                            "condition": args.condition,
                            "condition_met": true,
                            "selector": args.selector.selector,
                            "timeout_ms": timeout_duration.as_millis(),
                            "elapsed_ms": start_time.elapsed().as_millis(),
                            "timestamp": chrono::Utc::now().to_rfc3339()
                        });

                        maybe_attach_tree(
                            &self.desktop,
                            args.tree.include_tree_after_action,
                            args.tree.tree_max_depth,
                            args.tree.tree_from_selector.as_deref(),
                            None, // include_detailed_attributes - use default
                            None, // tree_output_format - use default
                            element.process_id().ok(),
                            &mut result_json,
                            Some(&element),
                            false,
                        )
                        .await;

                        self.restore_window_management(should_restore).await;

                        span.set_status(true, None);
                        span.end();

                        append_window_screenshot_to_json(
                            &self.desktop,
                            &args.selector.process,
                            &mut result_json,
                            args.window_screenshot.include_window_screenshot,
                        )
                        .await;
                        let contents = vec![Content::json(result_json)?];
                        let contents = append_monitor_screenshots_if_enabled(
                            &self.desktop,
                            contents,
                            args.monitor.include_monitor_screenshots,
                        )
                        .await;
                        return Ok(CallToolResult::success(contents));
                    } else {
                        info!(
                            "[wait_for_element] Condition '{}' NOT met for selector='{}', continuing to poll...",
                            args.condition, args.selector.selector
                        );
                    }
                    // Condition not met yet, continue polling
                }
                Err(_) => {
                    info!(
                        "[wait_for_element] Element not found for selector='{}', will retry...",
                        args.selector.selector
                    );
                    // Element doesn't exist yet, continue polling
                }
            }

            // Wait a bit before the next poll
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }

    #[tool(
        description = "Opens a URL in the specified browser (uses SDK's built-in browser automation). This is the RECOMMENDED method for browser navigation - more reliable than manually manipulating the address bar with keyboard/mouse actions. Handles page loading, waiting, and error recovery automatically. Requires verify_element_exists and verify_element_not_exists parameters (use empty string \"\" to skip verification). Always use include_tree_after_action: true to get the UI tree of elements after navigation."
    )]
    pub async fn navigate_browser(
        &self,
        Parameters(args): Parameters<NavigateBrowserArgs>,
    ) -> Result<CallToolResult, McpError> {
        let operation_start = std::time::Instant::now();
        // Start telemetry span
        let mut span = StepSpan::new("navigate_browser", None);

        // Add comprehensive telemetry attributes
        span.set_attribute("url", args.url.clone());
        span.set_attribute("process", args.process.clone());

        // Check if we need to perform window management (only for direct MCP calls, not sequences)
        let should_restore = {
            let in_sequence = self.in_sequence.lock().unwrap_or_else(|e| e.into_inner());
            !*in_sequence
        };

        if should_restore {
            tracing::info!(
                "[navigate_browser] Direct MCP call detected - performing window management"
            );
            let _ = self
                .prepare_window_management(&args.process, None, None, None, &args.window_mgmt)
                .await;
        } else {
            tracing::debug!("[navigate_browser] In sequence - skipping window management (dispatch_tool handles it)");
        }

        let browser = Some(Browser::Custom(args.process.clone()));
        let ui_element = self.desktop.open_url(&args.url, browser).map_err(|e| {
            McpError::internal_error(
                "Failed to open URL",
                Some(json!({"reason": e.to_string(), "url": args.url, "process": args.process})),
            )
        })?;

        let element_info = build_element_info(&ui_element);

        let mut result_json = json!({
            "action": "navigate_browser",
            "status": "executed_without_error",
            "url": args.url,
            "process": args.process,
            "element": element_info,
            "timestamp": chrono::Utc::now().to_rfc3339(),
        });

        // POST-ACTION VERIFICATION (must happen BEFORE tree capture so page content is loaded)
        if !args.verify_element_exists.is_empty() || !args.verify_element_not_exists.is_empty() {
            let verify_exists_opt = if args.verify_element_exists.is_empty() {
                None
            } else {
                Some(args.verify_element_exists.as_str())
            };
            let verify_not_exists_opt = if args.verify_element_not_exists.is_empty() {
                None
            } else {
                Some(args.verify_element_not_exists.as_str())
            };

            match crate::helpers::verify_post_action(
                &self.desktop,
                &ui_element,
                verify_exists_opt,
                verify_not_exists_opt,
                args.verify_timeout_ms.unwrap_or(2000),
                &args.url,
            )
            .await
            {
                Ok(verification_result) => {
                    tracing::info!(
                        "[navigate_browser] Verification passed: method={}, details={}",
                        verification_result.method,
                        verification_result.details
                    );
                    span.set_attribute("verification.passed", "true".to_string());
                    span.set_attribute("verification.method", verification_result.method.clone());
                    span.set_attribute(
                        "verification.elapsed_ms",
                        verification_result.elapsed_ms.to_string(),
                    );

                    let verification_json = json!({
                        "passed": verification_result.passed,
                        "method": verification_result.method,
                        "details": verification_result.details,
                        "elapsed_ms": verification_result.elapsed_ms,
                        "timestamp": chrono::Utc::now().to_rfc3339(),
                    });

                    if let Some(obj) = result_json.as_object_mut() {
                        obj.insert("verification".to_string(), verification_json);
                    }
                }
                Err(e) => {
                    tracing::error!("[navigate_browser] Verification failed: {}", e);
                    span.set_attribute("verification.passed", "false".to_string());
                    span.set_status(false, Some("Verification failed"));
                    span.end();
                    return Err(McpError::internal_error(
                        format!("Post-action verification failed: {e}"),
                        None,
                    ));
                }
            }
        }

        // Capture tree AFTER verification passes (page content should be loaded now)
        maybe_attach_tree(
            &self.desktop,
            args.tree.include_tree_after_action,
            args.tree.tree_max_depth,
            args.tree.tree_from_selector.as_deref(),
            args.tree.include_detailed_attributes,
            None,
            ui_element.process_id().ok(),
            &mut result_json,
            Some(&ui_element),
            false,
        )
        .await;

        self.restore_window_management(should_restore).await;

        tracing::info!(
            "[PERF] navigate_browser total: {}ms",
            operation_start.elapsed().as_millis()
        );
        span.set_status(true, None);
        span.end();

        append_window_screenshot_to_json(
            &self.desktop,
            &args.process,
            &mut result_json,
            args.window_screenshot.include_window_screenshot,
        )
        .await;
        let contents = vec![Content::json(result_json)?];
        let contents = append_monitor_screenshots_if_enabled(
            &self.desktop,
            contents,
            args.monitor.include_monitor_screenshots,
        )
        .await;
        Ok(CallToolResult::success(contents))
    }

    #[tool(
        description = "Opens an application by name (uses SDK's built-in app launcher). Requires verify_element_exists and verify_element_not_exists parameters (use empty string \"\" to skip verification)."
    )]
    pub async fn open_application(
        &self,
        Parameters(args): Parameters<OpenApplicationArgs>,
    ) -> Result<CallToolResult, McpError> {
        // Start telemetry span
        let mut span = StepSpan::new("open_application", None);

        // Add comprehensive telemetry attributes
        span.set_attribute("app_name", args.app_name.clone());

        // Open the application
        let ui_element = self.desktop.open_application(&args.app_name).map_err(|e| {
            McpError::internal_error(
                "Failed to open application",
                Some(json!({"reason": e.to_string(), "app_name": args.app_name})),
            )
        })?;

        let process_id = ui_element.process_id().unwrap_or(0);
        let _window_title = ui_element.window_title();

        // Check if we need to perform window management (only for direct MCP calls, not sequences)
        let should_restore = {
            let in_sequence = self.in_sequence.lock().unwrap_or_else(|e| e.into_inner());
            let flag_value = *in_sequence;
            let should_restore_value = !flag_value;
            tracing::info!(
                "[open_application] Flag check: in_sequence={}, should_restore={}",
                flag_value,
                should_restore_value
            );
            should_restore_value
        };

        if should_restore {
            tracing::info!(
                "[open_application] Direct MCP call detected - performing window management"
            );
            // Note: UIElement is a trait object, can't extract platform-specific type, so pass None
            let _ = self
                .prepare_window_management(
                    &args.app_name,
                    None,
                    Some(process_id),
                    None,
                    &args.window_mgmt,
                )
                .await;
        } else {
            tracing::debug!("[open_application] In sequence - skipping window management (dispatch_tool handles it)");
        }

        let element_info = build_element_info(&ui_element);

        let mut result_json = json!({
            "action": "open_application",
            "status": "executed_without_error",
            "app_name": args.app_name,
            "application": element_info,
            "timestamp": chrono::Utc::now().to_rfc3339()
        });

        // Attach UI tree if requested
        maybe_attach_tree(
            &self.desktop,
            args.tree.include_tree_after_action,
            args.tree.tree_max_depth,
            args.tree.tree_from_selector.as_deref(),
            args.tree.include_detailed_attributes,
            args.tree.tree_output_format,
            Some(process_id),
            &mut result_json,
            Some(&ui_element),
            false,
        )
        .await;

        // POST-ACTION VERIFICATION
        if !args.verify_element_exists.is_empty() || !args.verify_element_not_exists.is_empty() {
            let verify_exists_opt = if args.verify_element_exists.is_empty() {
                None
            } else {
                Some(args.verify_element_exists.as_str())
            };
            let verify_not_exists_opt = if args.verify_element_not_exists.is_empty() {
                None
            } else {
                Some(args.verify_element_not_exists.as_str())
            };

            match crate::helpers::verify_post_action(
                &self.desktop,
                &ui_element,
                verify_exists_opt,
                verify_not_exists_opt,
                args.verify_timeout_ms.unwrap_or(2000),
                &args.app_name,
            )
            .await
            {
                Ok(verification_result) => {
                    tracing::info!(
                        "[open_application] Verification passed: method={}, details={}",
                        verification_result.method,
                        verification_result.details
                    );
                    span.set_attribute("verification.passed", "true".to_string());
                    span.set_attribute("verification.method", verification_result.method.clone());
                    span.set_attribute(
                        "verification.elapsed_ms",
                        verification_result.elapsed_ms.to_string(),
                    );

                    let verification_json = json!({
                        "passed": verification_result.passed,
                        "method": verification_result.method,
                        "details": verification_result.details,
                        "elapsed_ms": verification_result.elapsed_ms,
                        "timestamp": chrono::Utc::now().to_rfc3339(),
                    });

                    if let Some(obj) = result_json.as_object_mut() {
                        obj.insert("verification".to_string(), verification_json);
                    }
                }
                Err(e) => {
                    tracing::error!("[open_application] Verification failed: {}", e);
                    span.set_attribute("verification.passed", "false".to_string());
                    span.set_status(false, Some("Verification failed"));
                    span.end();
                    return Err(McpError::internal_error(
                        format!("Post-action verification failed: {e}"),
                        None,
                    ));
                }
            }
        }

        // Restore windows if we did window management
        self.restore_window_management(should_restore).await;

        span.set_status(true, None);
        span.end();

        append_window_screenshot_to_json(
            &self.desktop,
            &args.app_name,
            &mut result_json,
            args.window_screenshot.include_window_screenshot,
        )
        .await;
        let contents = vec![Content::json(result_json)?];
        let contents = append_monitor_screenshots_if_enabled(
            &self.desktop,
            contents,
            args.monitor.include_monitor_screenshots,
        )
        .await;
        Ok(CallToolResult::success(contents))
    }

    #[tool(
        description = "Scrolls a UI element in the specified direction by the given amount. Use ui_diff_before_after:true to see changes (no need to call get_window_tree after)."
    )]
    async fn scroll_element(
        &self,
        Parameters(args): Parameters<ScrollElementArgs>,
    ) -> Result<CallToolResult, McpError> {
        // Start telemetry span
        let mut span = StepSpan::new("scroll_element", None);

        // Add comprehensive telemetry attributes
        span.set_attribute("selector", args.selector.selector.clone());
        span.set_attribute("direction", format!("{:?}", args.direction));
        span.set_attribute("amount", args.amount.to_string());
        if let Some(retries) = args.action.retries {
            span.set_attribute("retry.max_attempts", retries.to_string());
        }
        tracing::info!(
            "[scroll_element] Called with selector: '{}', direction: '{}', amount: {}",
            args.selector.selector,
            args.direction,
            args.amount
        );

        // Check if we need to perform window management (only for direct MCP calls, not sequences)
        let should_restore = {
            let in_sequence = self.in_sequence.lock().unwrap_or_else(|e| e.into_inner());
            !*in_sequence
        };

        if should_restore {
            tracing::info!(
                "[scroll_element] Direct MCP call detected - performing window management"
            );
            let _ = self
                .prepare_window_management(
                    &args.selector.process,
                    None,
                    None,
                    None,
                    &args.window_mgmt,
                )
                .await;
        } else {
            tracing::debug!("[scroll_element] In sequence - skipping window management (dispatch_tool handles it)");
        }

        let direction = args.direction.clone();
        let amount = args.amount;
        let highlight_before = args.highlight.highlight_before_action;
        let action = {
            move |element: UIElement| {
                let direction = direction.clone();
                async move {
                    // Ensure element is visible and apply highlighting if enabled
                    if highlight_before {
                        let _ = element.highlight_before_action("scroll");
                    }

                    // Execute the scroll action with state tracking
                    element.scroll_with_state(&direction, amount)
                }
            }
        };

        // Store tree config to avoid move issues
        let tree_output_format = args
            .tree
            .tree_output_format
            .unwrap_or(crate::mcp_types::TreeOutputFormat::CompactYaml);

        let ((result, element), successful_selector, ui_diff) =
            match crate::helpers::find_and_execute_with_ui_diff(
                &self.desktop,
                &args.selector.build_full_selector(),
                args.selector.build_alternative_selectors().as_deref(),
                args.selector.build_fallback_selectors().as_deref(),
                args.action.timeout_ms,
                args.action.retries,
                action,
                args.tree.ui_diff_before_after,
                args.tree.tree_max_depth,
                args.tree.include_detailed_attributes,
                tree_output_format,
            )
            .await
            {
                Ok(((result, element), selector, diff)) => {
                    if diff.is_some() {
                        span.set_attribute("ui_diff.captured", "true".to_string());
                    }
                    Ok(((result, element), selector, diff))
                }
                Err(e) => {
                    // Restore windows before returning error
                    self.restore_window_management(should_restore).await;
                    Err(build_element_not_found_error(
                        &args.selector.build_full_selector(),
                        args.selector.build_alternative_selectors().as_deref(),
                        args.selector.build_fallback_selectors().as_deref(),
                        e,
                    ))
                }
            }?;

        let element_info = build_element_info(&element);

        let mut result_json = json!({
            "action": "scroll_element",
            "status": "executed_without_error",
            "action_result": {
                "action": result.action,
                "details": result.details,
                "data": result.data,
            },
            "element": element_info,
            "selector_used": successful_selector,
            "selectors_tried": get_selectors_tried_all(&args.selector.build_full_selector(), args.selector.build_alternative_selectors().as_deref(), args.selector.build_fallback_selectors().as_deref()),
            "direction": args.direction,
            "amount": args.amount,
            "timestamp": chrono::Utc::now().to_rfc3339()
        });

        // POST-ACTION VERIFICATION
        if !args.action.verify_element_exists.is_empty()
            || !args.action.verify_element_not_exists.is_empty()
        {
            let verify_timeout_ms = args.action.verify_timeout_ms.unwrap_or(2000);

            let verify_exists_opt = if args.action.verify_element_exists.is_empty() {
                None
            } else {
                Some(args.action.verify_element_exists.as_str())
            };
            let verify_not_exists_opt = if args.action.verify_element_not_exists.is_empty() {
                None
            } else {
                Some(args.action.verify_element_not_exists.as_str())
            };

            match crate::helpers::verify_post_action(
                &self.desktop,
                &element,
                verify_exists_opt,
                verify_not_exists_opt,
                verify_timeout_ms,
                &successful_selector,
            )
            .await
            {
                Ok(verification_result) => {
                    tracing::info!(
                        "[scroll_element] Verification passed: method={}, details={}",
                        verification_result.method,
                        verification_result.details
                    );
                    span.set_attribute("verification.passed", "true".to_string());
                    span.set_attribute("verification.method", verification_result.method.clone());
                    span.set_attribute(
                        "verification.elapsed_ms",
                        verification_result.elapsed_ms.to_string(),
                    );

                    let verification_json = json!({
                        "passed": verification_result.passed,
                        "method": verification_result.method,
                        "details": verification_result.details,
                        "elapsed_ms": verification_result.elapsed_ms,
                        "timestamp": chrono::Utc::now().to_rfc3339(),
                    });

                    if let Some(obj) = result_json.as_object_mut() {
                        obj.insert("verification".to_string(), verification_json);
                    }
                }
                Err(e) => {
                    tracing::error!("[scroll_element] Verification failed: {}", e);
                    span.set_attribute("verification.passed", "false".to_string());
                    span.set_status(false, Some("Verification failed"));
                    span.end();
                    return Err(McpError::internal_error(
                        format!("Post-action verification failed: {e}"),
                        Some(json!({
                            "selector_used": successful_selector,
                            "verify_exists": args.action.verify_element_exists,
                            "verify_not_exists": args.action.verify_element_not_exists,
                            "timeout_ms": verify_timeout_ms,
                        })),
                    ));
                }
            }
        }

        // Attach UI diff if captured
        if let Some(diff_result) = ui_diff {
            tracing::debug!(
                "[scroll_element] Attaching UI diff to result (has_changes: {})",
                diff_result.has_changes
            );
            span.set_attribute("ui_diff.has_changes", diff_result.has_changes.to_string());

            result_json["ui_diff"] = json!(diff_result.diff);
            result_json["has_ui_changes"] = json!(diff_result.has_changes);
        }

        self.restore_window_management(should_restore).await;

        span.set_status(true, None);
        span.end();

        append_window_screenshot_to_json(
            &self.desktop,
            &args.selector.process,
            &mut result_json,
            args.window_screenshot.include_window_screenshot,
        )
        .await;
        let contents = vec![Content::json(result_json)?];
        let contents = append_monitor_screenshots_if_enabled(
            &self.desktop,
            contents,
            args.monitor.include_monitor_screenshots,
        )
        .await;
        Ok(CallToolResult::success(contents))
    }

    #[tool(
        description = "Selects an option in a dropdown or combobox by its visible text. IMPORTANT: The option_name must exactly match the option's accessible name. If unsure of available options, first click the dropdown with ui_diff_before_after:true to see the list of options. Use ui_diff_before_after:true to verify selection (no need to call get_window_tree after)."
    )]
    async fn select_option(
        &self,
        Parameters(args): Parameters<SelectOptionArgs>,
    ) -> Result<CallToolResult, McpError> {
        // Start telemetry span
        let mut span = StepSpan::new("select_option", None);

        // Add comprehensive telemetry attributes
        span.set_attribute("option_name", args.option_name.clone());
        if let Some(retries) = args.action.retries {
            span.set_attribute("retry.max_attempts", retries.to_string());
        }

        // Check if we need to perform window management (only for direct MCP calls, not sequences)
        let should_restore = {
            let in_sequence = self.in_sequence.lock().unwrap_or_else(|e| e.into_inner());
            !*in_sequence
        };

        if should_restore {
            tracing::info!(
                "[select_option] Direct MCP call detected - performing window management"
            );
            let _ = self
                .prepare_window_management(
                    &args.selector.process,
                    None,
                    None,
                    None,
                    &args.window_mgmt,
                )
                .await;
        } else {
            tracing::debug!("[select_option] In sequence - skipping window management (dispatch_tool handles it)");
        }

        let option_name = args.option_name.clone();
        let highlight_before = args.highlight.highlight_before_action;
        let action = move |element: UIElement| {
            let option_name = option_name.clone();
            async move {
                // Apply highlighting before action if enabled
                if highlight_before {
                    let _ = element.highlight_before_action("select_option");
                }
                element.select_option_with_state(&option_name)
            }
        };

        // Store tree config to avoid move issues
        let tree_output_format = args
            .tree
            .tree_output_format
            .unwrap_or(crate::mcp_types::TreeOutputFormat::CompactYaml);

        let ((result, element), successful_selector, ui_diff) =
            match crate::helpers::find_and_execute_with_ui_diff(
                &self.desktop,
                &args.selector.build_full_selector(),
                args.selector.build_alternative_selectors().as_deref(),
                args.selector.build_fallback_selectors().as_deref(),
                args.action.timeout_ms,
                args.action.retries,
                action,
                args.tree.ui_diff_before_after,
                args.tree.tree_max_depth,
                args.tree.include_detailed_attributes,
                tree_output_format,
            )
            .await
            {
                Ok(((result, element), selector, diff)) => {
                    if diff.is_some() {
                        span.set_attribute("ui_diff.captured", "true".to_string());
                    }
                    Ok(((result, element), selector, diff))
                }
                Err(e) => {
                    // Restore windows before returning error
                    self.restore_window_management(should_restore).await;
                    Err(build_element_not_found_error(
                        &args.selector.build_full_selector(),
                        args.selector.build_alternative_selectors().as_deref(),
                        args.selector.build_fallback_selectors().as_deref(),
                        e,
                    ))
                }
            }?;

        let element_info = build_element_info(&element);

        let mut result_json = json!({
            "action": "select_option",
            "status": "executed_without_error",
            "action_result": {
                "action": result.action,
                "details": result.details,
                "data": result.data,
            },
            "element": element_info,
            "selector_used": successful_selector,
            "selectors_tried": get_selectors_tried_all(&args.selector.build_full_selector(), args.selector.build_alternative_selectors().as_deref(), args.selector.build_fallback_selectors().as_deref()),
            "option_selected": args.option_name,
        });

        // Attach UI diff if captured
        if let Some(diff_result) = ui_diff {
            tracing::debug!(
                "[select_option] Attaching UI diff to result (has_changes: {})",
                diff_result.has_changes
            );
            span.set_attribute("ui_diff.has_changes", diff_result.has_changes.to_string());

            result_json["ui_diff"] = json!(diff_result.diff);
            result_json["has_ui_changes"] = json!(diff_result.has_changes);
        }

        self.restore_window_management(should_restore).await;

        span.set_status(true, None);
        span.end();

        append_window_screenshot_to_json(
            &self.desktop,
            &args.selector.process,
            &mut result_json,
            args.window_screenshot.include_window_screenshot,
        )
        .await;
        let contents = vec![Content::json(result_json)?];
        let contents = append_monitor_screenshots_if_enabled(
            &self.desktop,
            contents,
            args.monitor.include_monitor_screenshots,
        )
        .await;
        Ok(CallToolResult::success(contents))
    }

    #[tool(
        description = "Sets the selection state of a selectable item (e.g., in a list or calendar). Use ui_diff_before_after:true to see changes (no need to call get_window_tree after)."
    )]
    async fn set_selected(
        &self,
        Parameters(args): Parameters<SetSelectedArgs>,
    ) -> Result<CallToolResult, McpError> {
        // Start telemetry span
        let mut span = StepSpan::new("set_selected", None);

        // Add comprehensive telemetry attributes
        span.set_attribute("selector", args.selector.selector.clone());
        span.set_attribute("state", args.state.to_string());
        if let Some(retries) = args.action.retries {
            span.set_attribute("retry.max_attempts", retries.to_string());
        }

        // Check if we need to perform window management (only for direct MCP calls, not sequences)
        let should_restore = {
            let in_sequence = self.in_sequence.lock().unwrap_or_else(|e| e.into_inner());
            !*in_sequence
        };

        if should_restore {
            tracing::info!(
                "[set_selected] Direct MCP call detected - performing window management"
            );
            let _ = self
                .prepare_window_management(
                    &args.selector.process,
                    None,
                    None,
                    None,
                    &args.window_mgmt,
                )
                .await;
        } else {
            tracing::debug!("[set_selected] In sequence - skipping window management (dispatch_tool handles it)");
        }

        let state = args.state;
        let highlight_before = args.highlight.highlight_before_action;
        let action = move |element: UIElement| async move {
            // Apply highlighting before action if enabled
            if highlight_before {
                let _ = element.highlight_before_action("set_selected");
            }
            element.set_selected_with_state(state)
        };

        // Store tree config to avoid move issues
        let tree_output_format = args
            .tree
            .tree_output_format
            .unwrap_or(crate::mcp_types::TreeOutputFormat::CompactYaml);

        let ((result, element), successful_selector, ui_diff) =
            match crate::helpers::find_and_execute_with_ui_diff(
                &self.desktop,
                &args.selector.build_full_selector(),
                None, // SetSelected doesn't have alternative selectors
                args.selector.build_fallback_selectors().as_deref(),
                args.action.timeout_ms,
                args.action.retries,
                action,
                args.tree.ui_diff_before_after,
                args.tree.tree_max_depth,
                args.tree.include_detailed_attributes,
                tree_output_format,
            )
            .await
            {
                Ok(((result, element), selector, diff)) => {
                    if diff.is_some() {
                        span.set_attribute("ui_diff.captured", "true".to_string());
                    }
                    Ok(((result, element), selector, diff))
                }
                Err(e) => Err(build_element_not_found_error(
                    &args.selector.build_full_selector(),
                    None,
                    args.selector.build_fallback_selectors().as_deref(),
                    e,
                )),
            }?;

        let element_info = build_element_info(&element);

        let mut result_json = json!({
            "action": "set_selected",
            "status": "executed_without_error",
            "action_result": {
                "action": result.action,
                "details": result.details,
                "data": result.data,
            },
            "element": element_info,
            "selector_used": successful_selector,
            "selectors_tried": get_selectors_tried_all(&args.selector.build_full_selector(), None, args.selector.build_fallback_selectors().as_deref()),
            "state_set_to": args.state,
        });

        // POST-ACTION VERIFICATION: Magic auto-verification or explicit verification
        let should_auto_verify = args.action.verify_element_exists.is_empty()
            && args.action.verify_element_not_exists.is_empty();

        if should_auto_verify {
            // MAGIC AUTO-VERIFICATION: Verify selected state was actually set
            tracing::debug!(
                "[set_selected] Auto-verification: checking is_selected = {}",
                args.state
            );
            span.set_attribute("verification.auto_inferred", "true".to_string());

            let actual_state = element.is_selected().unwrap_or(!args.state);

            if actual_state != args.state {
                tracing::error!(
                    "[set_selected] Auto-verification failed: expected {}, got {}",
                    args.state,
                    actual_state
                );
                span.set_attribute("verification.passed", "false".to_string());
                span.set_status(false, Some("Selected state verification failed"));
                span.end();
                return Err(McpError::internal_error(
                    format!(
                        "Selected state verification failed: expected {}, got {}",
                        args.state, actual_state
                    ),
                    Some(json!({
                        "expected_state": args.state,
                        "actual_state": actual_state,
                        "selector_used": successful_selector,
                    })),
                ));
            }

            tracing::info!(
                "[set_selected] Auto-verification passed: is_selected = {}",
                actual_state
            );
            span.set_attribute("verification.passed", "true".to_string());
            span.set_attribute("verification.method", "direct_property_read".to_string());

            if let Some(obj) = result_json.as_object_mut() {
                obj.insert(
                    "verification".to_string(),
                    json!({
                        "passed": true,
                        "method": "direct_property_read",
                        "expected_state": args.state,
                        "actual_state": actual_state,
                    }),
                );
            }
        } else if !args.action.verify_element_exists.is_empty()
            || !args.action.verify_element_not_exists.is_empty()
        {
            // Explicit verification using selectors
            let verify_timeout_ms = args.action.verify_timeout_ms.unwrap_or(2000);

            let verify_exists_opt = if args.action.verify_element_exists.is_empty() {
                None
            } else {
                Some(args.action.verify_element_exists.as_str())
            };
            let verify_not_exists_opt = if args.action.verify_element_not_exists.is_empty() {
                None
            } else {
                Some(args.action.verify_element_not_exists.as_str())
            };

            match crate::helpers::verify_post_action(
                &self.desktop,
                &element,
                verify_exists_opt,
                verify_not_exists_opt,
                verify_timeout_ms,
                &successful_selector,
            )
            .await
            {
                Ok(verification_result) => {
                    span.set_attribute("verification.passed", "true".to_string());
                    span.set_attribute("verification.method", verification_result.method.clone());

                    if let Some(obj) = result_json.as_object_mut() {
                        obj.insert(
                            "verification".to_string(),
                            json!({
                                "passed": verification_result.passed,
                                "method": verification_result.method,
                                "details": verification_result.details,
                                "elapsed_ms": verification_result.elapsed_ms,
                            }),
                        );
                    }
                }
                Err(e) => {
                    span.set_status(false, Some("Verification failed"));
                    span.end();
                    return Err(McpError::internal_error(
                        format!("Post-action verification failed: {e}"),
                        Some(json!({
                            "selector_used": successful_selector,
                            "timeout_ms": verify_timeout_ms,
                        })),
                    ));
                }
            }
        }

        // Attach UI diff if captured
        if let Some(diff_result) = ui_diff {
            tracing::debug!(
                "[set_selected] Attaching UI diff to result (has_changes: {})",
                diff_result.has_changes
            );
            span.set_attribute("ui_diff.has_changes", diff_result.has_changes.to_string());

            result_json["ui_diff"] = json!(diff_result.diff);
            result_json["has_ui_changes"] = json!(diff_result.has_changes);
        }

        self.restore_window_management(should_restore).await;

        span.set_status(true, None);
        span.end();

        append_window_screenshot_to_json(
            &self.desktop,
            &args.selector.process,
            &mut result_json,
            args.window_screenshot.include_window_screenshot,
        )
        .await;
        let contents = vec![Content::json(result_json)?];
        let contents = append_monitor_screenshots_if_enabled(
            &self.desktop,
            contents,
            args.monitor.include_monitor_screenshots,
        )
        .await;
        Ok(CallToolResult::success(contents))
    }

    #[tool(
        description = "Captures a screenshot. Three modes: (1) Element - provide process + selector to capture specific element, (2) Window - provide process only to capture entire window, (3) Monitor - provide process + entire_monitor=true to capture the monitor where the window is located. Automatically resizes to max 1920px (customizable via max_dimension parameter) while maintaining aspect ratio."
    )]
    async fn capture_screenshot(
        &self,
        Parameters(args): Parameters<CaptureScreenshotArgs>,
    ) -> Result<CallToolResult, McpError> {
        // Start telemetry span
        let mut span = StepSpan::new("capture_screenshot", None);

        // Determine capture mode for telemetry
        let capture_mode = if args.entire_monitor {
            "monitor"
        } else if args.selector.selector.is_empty() {
            "window"
        } else {
            "element"
        };
        span.set_attribute("capture_mode", capture_mode.to_string());
        span.set_attribute("process", args.selector.process.clone());
        if !args.selector.selector.is_empty() {
            span.set_attribute("selector", args.selector.selector.clone());
        }
        if let Some(retries) = args.action.retries {
            span.set_attribute("retry.max_attempts", retries.to_string());
        }

        // Check if we need to perform window management (only for direct MCP calls, not sequences)
        let should_restore = {
            let in_sequence = self.in_sequence.lock().unwrap_or_else(|e| e.into_inner());
            !*in_sequence
        };

        if should_restore {
            tracing::info!(
                "[capture_screenshot] Direct MCP call detected - performing window management"
            );
            let _ = self
                .prepare_window_management(
                    &args.selector.process,
                    None,
                    None,
                    None,
                    &args.window_mgmt,
                )
                .await;
        } else {
            tracing::debug!("[capture_screenshot] In sequence - skipping window management (dispatch_tool handles it)");
        }

        // Capture screenshot based on mode
        let (screenshot_result, element_info, successful_selector) = if args.entire_monitor {
            // Monitor mode: find window, get its monitor, capture the monitor
            let ((element, _), selector) = find_and_execute_with_retry_with_fallback(
                &self.desktop,
                &args.selector.build_full_selector(),
                args.selector.build_alternative_selectors().as_deref(),
                args.selector.build_fallback_selectors().as_deref(),
                args.action.timeout_ms,
                args.action.retries,
                |element| async move { Ok(element) },
            )
            .await
            .map_err(|e| {
                build_element_not_found_error(
                    &args.selector.build_full_selector(),
                    args.selector.build_alternative_selectors().as_deref(),
                    args.selector.build_fallback_selectors().as_deref(),
                    e,
                )
            })?;

            // Get the monitor containing this window
            let monitor = element.monitor().map_err(|e| {
                McpError::internal_error(
                    "Failed to get monitor for window",
                    Some(json!({ "reason": e.to_string() })),
                )
            })?;

            // Capture the monitor
            let screenshot = monitor.capture(&self.desktop).await.map_err(|e| {
                McpError::internal_error(
                    "Failed to capture monitor screenshot",
                    Some(json!({ "reason": e.to_string() })),
                )
            })?;

            let info = json!({
                "type": "monitor",
                "monitor_name": monitor.name,
                "monitor_id": monitor.id,
                "window_process": args.selector.process,
            });
            (screenshot, info, selector)
        } else {
            // Element/Window mode: capture element directly
            let ((result, element), selector) = find_and_execute_with_retry_with_fallback(
                &self.desktop,
                &args.selector.build_full_selector(),
                args.selector.build_alternative_selectors().as_deref(),
                args.selector.build_fallback_selectors().as_deref(),
                args.action.timeout_ms,
                args.action.retries,
                |element| async move { element.capture() },
            )
            .await
            .map_err(|e| {
                build_element_not_found_error(
                    &args.selector.build_full_selector(),
                    args.selector.build_alternative_selectors().as_deref(),
                    args.selector.build_fallback_selectors().as_deref(),
                    e,
                )
            })?;

            let info = build_element_info(&element);
            (result, info, selector)
        };

        // Store original dimensions for metadata
        let original_width = screenshot_result.width;
        let original_height = screenshot_result.height;
        let original_size_bytes = screenshot_result.image_data.len();

        // Convert BGRA to RGBA (xcap returns BGRA format, we need RGBA)
        // Swap red and blue channels: BGRA -> RGBA
        let rgba_data: Vec<u8> = screenshot_result
            .image_data
            .chunks_exact(4)
            .flat_map(|bgra| [bgra[2], bgra[1], bgra[0], bgra[3]]) // B,G,R,A -> R,G,B,A
            .collect();

        // Apply resize if needed (default max dimension is 1920px)
        let max_dim = args.max_dimension.unwrap_or(1920);
        let (final_width, final_height, final_rgba_data, was_resized) = if original_width > max_dim
            || original_height > max_dim
        {
            // Calculate new dimensions maintaining aspect ratio
            let scale = (max_dim as f32 / original_width.max(original_height) as f32).min(1.0);
            let new_width = (original_width as f32 * scale).round() as u32;
            let new_height = (original_height as f32 * scale).round() as u32;

            // Create ImageBuffer from RGBA data
            let img =
                ImageBuffer::<Rgba<u8>, _>::from_raw(original_width, original_height, rgba_data)
                    .ok_or_else(|| {
                        McpError::internal_error(
                            "Failed to create image buffer from screenshot data",
                            None,
                        )
                    })?;

            // Resize using Lanczos3 filter for high quality
            let resized =
                image::imageops::resize(&img, new_width, new_height, FilterType::Lanczos3);

            (new_width, new_height, resized.into_raw(), true)
        } else {
            (original_width, original_height, rgba_data, false)
        };

        // Convert RGBA to RGB for JPEG (JPEG doesn't support alpha channel)
        let rgb_data: Vec<u8> = final_rgba_data
            .chunks_exact(4)
            .flat_map(|rgba| [rgba[0], rgba[1], rgba[2]]) // Drop alpha channel
            .collect();

        // Encode to JPEG with quality 85 (good balance of quality vs size, ~80% smaller than PNG)
        let mut jpeg_data = Vec::new();
        let encoder = JpegEncoder::new_with_quality(Cursor::new(&mut jpeg_data), 85);
        encoder
            .write_image(
                &rgb_data,
                final_width,
                final_height,
                ExtendedColorType::Rgb8,
            )
            .map_err(|e| {
                McpError::internal_error(
                    "Failed to encode screenshot to JPEG",
                    Some(json!({ "reason": e.to_string() })),
                )
            })?;

        let base64_image = general_purpose::STANDARD.encode(&jpeg_data);

        span.set_status(true, None);
        span.end();

        // Build metadata with resize information
        let mut metadata = json!({
            "action": "capture_screenshot",
            "status": "executed_without_error",
            "capture_mode": capture_mode,
            "target": element_info,
            "selector_used": successful_selector,
            "selectors_tried": get_selectors_tried_all(&args.selector.build_full_selector(), args.selector.build_alternative_selectors().as_deref(), args.selector.build_fallback_selectors().as_deref()),
            "image_format": "jpeg",
            "original_size": {
                "width": original_width,
                "height": original_height,
                "bytes": original_size_bytes,
                "mb": (original_size_bytes as f64 / 1024.0 / 1024.0)
            },
            "final_size": {
                "width": final_width,
                "height": final_height,
                "bytes": jpeg_data.len(),
                "mb": (jpeg_data.len() as f64 / 1024.0 / 1024.0)
            },
            "resized": was_resized,
            "max_dimension_applied": max_dim,
        });

        self.restore_window_management(should_restore).await;

        append_window_screenshot_to_json(
            &self.desktop,
            &args.selector.process,
            &mut metadata,
            args.window_screenshot.include_window_screenshot,
        )
        .await;
        let contents = vec![
            Content::json(metadata)?,
            Content::image(base64_image, "image/jpeg".to_string()),
        ];
        let contents = append_monitor_screenshots_if_enabled(
            &self.desktop,
            contents,
            args.monitor.include_monitor_screenshots,
        )
        .await;
        Ok(CallToolResult::success(contents))
    }

    #[tool(
        description = "Invokes a UI element. This is often more reliable than clicking for controls like radio buttons or menu items. Use ui_diff_before_after:true to see changes (no need to call get_window_tree after)."
    )]
    async fn invoke_element(
        &self,
        Parameters(args): Parameters<InvokeElementArgs>,
    ) -> Result<CallToolResult, McpError> {
        // Start telemetry span
        let mut span = StepSpan::new("invoke_element", None);

        // Add comprehensive telemetry attributes
        span.set_attribute("selector", args.selector.selector.clone());
        if let Some(retries) = args.action.retries {
            span.set_attribute("retry.max_attempts", retries.to_string());
        }

        // Check if we need to perform window management (only for direct MCP calls, not sequences)
        let should_restore = {
            let in_sequence = self.in_sequence.lock().unwrap_or_else(|e| e.into_inner());
            let flag_value = *in_sequence;
            let should_restore_value = !flag_value;
            tracing::info!(
                "[invoke_element] Flag check: in_sequence={}, should_restore={}",
                flag_value,
                should_restore_value
            );
            should_restore_value
        };

        if should_restore {
            tracing::info!(
                "[invoke_element] Direct MCP call detected - performing window management"
            );
            let _ = self
                .prepare_window_management(
                    &args.selector.process,
                    None,
                    None,
                    None,
                    &args.window_mgmt,
                )
                .await;
        } else {
            tracing::debug!("[invoke_element] In sequence - skipping window management (dispatch_tool handles it)");
        }

        // Store tree config to avoid move issues
        let tree_output_format = args
            .tree
            .tree_output_format
            .unwrap_or(crate::mcp_types::TreeOutputFormat::CompactYaml);

        let highlight_before = args.highlight.highlight_before_action;
        let ((result, element), successful_selector, ui_diff) =
            match crate::helpers::find_and_execute_with_ui_diff(
                &self.desktop,
                &args.selector.build_full_selector(),
                args.selector.build_alternative_selectors().as_deref(),
                args.selector.build_fallback_selectors().as_deref(),
                args.action.timeout_ms,
                args.action.retries,
                |element| async move {
                    // Apply highlighting before action if enabled
                    if highlight_before {
                        let _ = element.highlight_before_action("invoke");
                    }
                    element.invoke_with_state()
                },
                args.tree.ui_diff_before_after,
                args.tree.tree_max_depth,
                args.tree.include_detailed_attributes,
                tree_output_format,
            )
            .await
            {
                Ok(((result, element), selector, diff)) => {
                    if diff.is_some() {
                        span.set_attribute("ui_diff.captured", "true".to_string());
                    }
                    Ok(((result, element), selector, diff))
                }
                Err(e) => {
                    // Restore windows before returning error
                    self.restore_window_management(should_restore).await;
                    Err(build_element_not_found_error(
                        &args.selector.build_full_selector(),
                        args.selector.build_alternative_selectors().as_deref(),
                        args.selector.build_fallback_selectors().as_deref(),
                        e,
                    ))
                }
            }?;

        let element_info = build_element_info(&element);

        let mut result_json = json!({
            "action": "invoke",
            "status": "executed_without_error",
            "action_result": {
                "action": result.action,
                "details": result.details,
                "data": result.data,
            },
            "element": element_info,
            "selector_used": successful_selector,
            "selectors_tried": get_selectors_tried_all(&args.selector.build_full_selector(), args.selector.build_alternative_selectors().as_deref(), args.selector.build_fallback_selectors().as_deref()),
            "timestamp": chrono::Utc::now().to_rfc3339()
        });

        // POST-ACTION VERIFICATION
        if !args.action.verify_element_exists.is_empty()
            || !args.action.verify_element_not_exists.is_empty()
        {
            let verify_timeout_ms = args.action.verify_timeout_ms.unwrap_or(2000);

            let verify_exists_opt = if args.action.verify_element_exists.is_empty() {
                None
            } else {
                Some(args.action.verify_element_exists.as_str())
            };
            let verify_not_exists_opt = if args.action.verify_element_not_exists.is_empty() {
                None
            } else {
                Some(args.action.verify_element_not_exists.as_str())
            };

            match crate::helpers::verify_post_action(
                &self.desktop,
                &element,
                verify_exists_opt,
                verify_not_exists_opt,
                verify_timeout_ms,
                &successful_selector,
            )
            .await
            {
                Ok(verification_result) => {
                    tracing::info!(
                        "[invoke_element] Verification passed: method={}, details={}",
                        verification_result.method,
                        verification_result.details
                    );
                    span.set_attribute("verification.passed", "true".to_string());
                    span.set_attribute("verification.method", verification_result.method.clone());
                    span.set_attribute(
                        "verification.elapsed_ms",
                        verification_result.elapsed_ms.to_string(),
                    );

                    let verification_json = json!({
                        "passed": verification_result.passed,
                        "method": verification_result.method,
                        "details": verification_result.details,
                        "elapsed_ms": verification_result.elapsed_ms,
                        "timestamp": chrono::Utc::now().to_rfc3339(),
                    });

                    if let Some(obj) = result_json.as_object_mut() {
                        obj.insert("verification".to_string(), verification_json);
                    }
                }
                Err(e) => {
                    tracing::error!("[invoke_element] Verification failed: {}", e);
                    span.set_attribute("verification.passed", "false".to_string());
                    span.set_status(false, Some("Verification failed"));
                    span.end();
                    return Err(McpError::internal_error(
                        format!("Post-action verification failed: {e}"),
                        Some(json!({
                            "selector_used": successful_selector,
                            "verify_exists": args.action.verify_element_exists,
                            "verify_not_exists": args.action.verify_element_not_exists,
                            "timeout_ms": verify_timeout_ms,
                        })),
                    ));
                }
            }
        }

        // Attach UI diff if captured (action tools only support diff, not standalone tree)
        if let Some(diff_result) = ui_diff {
            tracing::debug!(
                "[invoke_element] Attaching UI diff to result (has_changes: {})",
                diff_result.has_changes
            );
            span.set_attribute("ui_diff.has_changes", diff_result.has_changes.to_string());

            result_json["ui_diff"] = json!(diff_result.diff);
            result_json["has_ui_changes"] = json!(diff_result.has_changes);
        }

        // Restore windows after invoking element
        self.restore_window_management(should_restore).await;

        span.set_status(true, None);
        span.end();

        append_window_screenshot_to_json(
            &self.desktop,
            &args.selector.process,
            &mut result_json,
            args.window_screenshot.include_window_screenshot,
        )
        .await;
        let contents = vec![Content::json(result_json)?];
        let contents = append_monitor_screenshots_if_enabled(
            &self.desktop,
            contents,
            args.monitor.include_monitor_screenshots,
        )
        .await;
        Ok(CallToolResult::success(contents))
    }

    #[tool(
        description = "Stops active element highlights immediately. If an ID is provided, stops that specific highlight; otherwise stops all."
    )]
    async fn stop_highlighting(
        &self,
        Parameters(_args): Parameters<crate::utils::StopHighlightingArgs>,
    ) -> Result<CallToolResult, McpError> {
        // Start telemetry span
        let mut span = StepSpan::new("stop_highlighting", None);

        // Check if we need to perform window management (only for direct MCP calls, not sequences)
        let should_restore = {
            let in_sequence = self.in_sequence.lock().unwrap_or_else(|e| e.into_inner());
            !*in_sequence
        };

        // Note: stop_highlighting doesn't interact with specific windows, so no prepare needed

        // Current minimal implementation ignores highlight_id and stops all tracked highlights
        let mut list = self.active_highlights.lock().await;
        let mut stopped = 0usize;
        while let Some(handle) = list.pop() {
            handle.close();
            stopped += 1;
        }
        let response = json!({
            "action": "stop_highlighting",
            "status": "executed_without_error",
            "highlights_stopped": stopped,
            "timestamp": chrono::Utc::now().to_rfc3339(),
        });

        self.restore_window_management(should_restore).await;

        span.set_status(true, None);
        span.end();

        Ok(CallToolResult::success(
            append_monitor_screenshots_if_enabled(
                &self.desktop,
                vec![Content::json(response)?],
                None,
            )
            .await,
        ))
    }
    // Tool functions continue below - part of impl block with #[tool_router]
    #[tool(
        description = "Executes workflow steps. Supports full workflows, step ranges, or single steps.

**EXECUTION MODES:**

1. **Full workflow from file:**
   {\"url\": \"file:///C:/Users/matt/workflows/my-workflow/computeruse.ts\"}

2. **Single step by ID:**
   {\"url\": \"file:///path/to/workflow.ts\", \"start_from_step\": \"login_step\", \"end_at_step\": \"login_step\"}

3. **Step range:**
   {\"url\": \"file:///path/to/workflow.ts\", \"start_from_step\": \"step_1\", \"end_at_step\": \"step_5\"}

4. **Inline steps (no file):**
   {\"steps\": [{\"id\": \"click_btn\", \"tool_name\": \"click_element\", \"arguments\": {...}}]}

**KEY PARAMETERS:**
- `url`: File path to workflow (file:// URL). Preferred over inline steps.
- `start_from_step`: Step ID to start from. Loads saved state from previous runs.
- `end_at_step`: Step ID to stop at (inclusive). Same as start_from_step for single step.
- `inputs`: Variables to pass to workflow (e.g., {\"username\": \"test\"}).
- `workflow_id`: Optional identifier for state persistence when using inline steps.

**ADVANCED OPTIONS:**
- `execute_jumps_at_end`: Allow jump conditions at end_at_step boundary (default: false).
- `follow_fallback`: Follow fallback_id beyond end_at_step on failures (default: false for bounded execution).
- `skip_preflight_check`: Skip browser extension connectivity check.

**DATA PASSING:** Use run_command with engine mode. Return {set_env: {key: value}} to pass data between steps. Access via {{key}} substitution or direct variable names in conditions.

**LOCATOR TIMEOUTS:** .first(0) = immediate, .first(5000) = retry 5s. Default is 0ms (no polling).

**STATE PERSISTENCE:** When using file:// URLs, state is saved to .mediar/workflows/ folder, allowing resume from any step."
    )]
    pub async fn execute_sequence(
        &self,
        peer: Peer<RoleServer>,
        request_context: RequestContext<RoleServer>,
        Parameters(args): Parameters<ExecuteSequenceArgs>,
    ) -> Result<CallToolResult, McpError> {
        let client_progress_token = request_context.meta.get_progress_token();
        return self
            .execute_sequence_impl(peer, request_context, client_progress_token, args)
            .await;
    }

    #[tool(
        description = "Sets the text value of an editable control (e.g., an input field) directly using the underlying accessibility API. This action requires the application to be focused and may change the UI."
    )]
    async fn set_value(
        &self,
        Parameters(args): Parameters<SetValueArgs>,
    ) -> Result<CallToolResult, McpError> {
        // Start telemetry span
        let mut span = StepSpan::new("set_value", None);

        // Add comprehensive telemetry attributes
        span.set_attribute("selector", args.selector.selector.clone());
        span.set_attribute("value", args.value.to_string());
        if let Some(retries) = args.action.retries {
            span.set_attribute("retry.max_attempts", retries.to_string());
        }

        // Check if we need to perform window management (only for direct MCP calls, not sequences)
        let should_restore = {
            let in_sequence = self.in_sequence.lock().unwrap_or_else(|e| e.into_inner());
            !*in_sequence
        };

        if should_restore {
            tracing::info!("[set_value] Direct MCP call detected - performing window management");
            let _ = self
                .prepare_window_management(
                    &args.selector.process,
                    None,
                    None,
                    None,
                    &args.window_mgmt,
                )
                .await;
        } else {
            tracing::debug!(
                "[set_value] In sequence - skipping window management (dispatch_tool handles it)"
            );
        }

        let value_to_set = args.value.clone();
        let highlight_before = args.highlight.highlight_before_action;
        let action = move |element: UIElement| {
            let value_to_set = value_to_set.clone();
            async move {
                // Apply highlighting before action if enabled
                if highlight_before {
                    let _ = element.highlight_before_action("set_value");
                }
                // Activate window to ensure it has keyboard focus before setting value
                if let Err(e) = element.activate_window() {
                    tracing::warn!("Failed to activate window before setting value: {}", e);
                }
                element.set_value(&value_to_set)
            }
        };

        // Store tree config to avoid move issues
        let tree_output_format = args
            .tree
            .tree_output_format
            .unwrap_or(crate::mcp_types::TreeOutputFormat::CompactYaml);

        let ((_result, element), successful_selector, ui_diff) =
            match crate::helpers::find_and_execute_with_ui_diff(
                &self.desktop,
                &args.selector.build_full_selector(),
                args.selector.build_alternative_selectors().as_deref(),
                args.selector.build_fallback_selectors().as_deref(),
                args.action.timeout_ms,
                args.action.retries,
                action,
                args.tree.ui_diff_before_after,
                args.tree.tree_max_depth,
                args.tree.include_detailed_attributes,
                tree_output_format,
            )
            .await
            {
                Ok(((result, element), selector, diff)) => {
                    if diff.is_some() {
                        span.set_attribute("ui_diff.captured", "true".to_string());
                    }
                    Ok(((result, element), selector, diff))
                }
                Err(e) => {
                    // Restore windows before returning error
                    self.restore_window_management(should_restore).await;
                    Err(build_element_not_found_error(
                        &args.selector.build_full_selector(),
                        args.selector.build_alternative_selectors().as_deref(),
                        args.selector.build_fallback_selectors().as_deref(),
                        e,
                    ))
                }
            }?;

        let element_info = build_element_info(&element);

        let mut result_json = json!({
            "action": "set_value",
            "status": "executed_without_error",
            "element": element_info,
            "selector_used": successful_selector,
            "selectors_tried": get_selectors_tried_all(&args.selector.build_full_selector(), args.selector.build_alternative_selectors().as_deref(), args.selector.build_fallback_selectors().as_deref()),
            "value_set_to": args.value,
        });

        // POST-ACTION VERIFICATION: Magic auto-verification or explicit verification
        // 1. If verify_element_exists/not_exists is explicitly set, use selector-based verification
        // 2. Otherwise, auto-verify using element.get_value() to check the value was set
        // 3. Both empty = auto-verification (checks value property directly)

        let should_auto_verify = args.action.verify_element_exists.is_empty()
            && args.action.verify_element_not_exists.is_empty();

        if should_auto_verify {
            // MAGIC AUTO-VERIFICATION: Check element's value property directly
            tracing::debug!(
                "[set_value] Auto-verification: checking get_value() contains '{}'",
                args.value
            );
            span.set_attribute("verification.auto_inferred", "true".to_string());

            let actual_value = element.get_value().unwrap_or(None).unwrap_or_default();

            // Check if the set value is in the element's value
            if !actual_value.contains(&args.value) {
                tracing::error!(
                    "[set_value] Auto-verification failed: expected value to contain '{}', got '{}'",
                    args.value,
                    actual_value
                );
                span.set_attribute("verification.passed", "false".to_string());
                span.set_status(false, Some("Value verification failed"));
                span.end();
                return Err(McpError::internal_error(
                    format!(
                        "Value verification failed: expected value to contain '{}', got '{}'",
                        args.value, actual_value
                    ),
                    Some(json!({
                        "expected_value": args.value,
                        "actual_value": actual_value,
                        "selector_used": successful_selector,
                    })),
                ));
            }

            tracing::info!(
                "[set_value] Auto-verification passed: value contains '{}'",
                args.value
            );
            span.set_attribute("verification.passed", "true".to_string());
            span.set_attribute("verification.method", "direct_value_read".to_string());

            if let Some(obj) = result_json.as_object_mut() {
                obj.insert(
                    "verification".to_string(),
                    json!({
                        "passed": true,
                        "method": "direct_value_read",
                        "expected_value": args.value,
                        "actual_value": actual_value,
                    }),
                );
            }
        } else if !args.action.verify_element_exists.is_empty()
            || !args.action.verify_element_not_exists.is_empty()
        {
            // Explicit verification using selectors
            let verify_timeout_ms = args.action.verify_timeout_ms.unwrap_or(2000);

            let verify_exists_opt = if args.action.verify_element_exists.is_empty() {
                None
            } else {
                Some(args.action.verify_element_exists.as_str())
            };
            let verify_not_exists_opt = if args.action.verify_element_not_exists.is_empty() {
                None
            } else {
                Some(args.action.verify_element_not_exists.as_str())
            };

            match crate::helpers::verify_post_action(
                &self.desktop,
                &element,
                verify_exists_opt,
                verify_not_exists_opt,
                verify_timeout_ms,
                &successful_selector,
            )
            .await
            {
                Ok(verification_result) => {
                    tracing::info!(
                        "[set_value] Verification passed: {}",
                        verification_result.details
                    );
                    span.set_attribute("verification.passed", "true".to_string());
                    span.set_attribute("verification.method", verification_result.method.clone());

                    if let Some(obj) = result_json.as_object_mut() {
                        obj.insert(
                            "verification".to_string(),
                            json!({
                                "passed": verification_result.passed,
                                "method": verification_result.method,
                                "details": verification_result.details,
                                "elapsed_ms": verification_result.elapsed_ms,
                            }),
                        );
                    }
                }
                Err(e) => {
                    tracing::error!("[set_value] Verification failed: {}", e);
                    span.set_status(false, Some("Verification failed"));
                    span.end();
                    return Err(McpError::internal_error(
                        format!("Post-action verification failed: {e}"),
                        Some(json!({
                            "selector_used": successful_selector,
                            "verify_exists": args.action.verify_element_exists,
                            "timeout_ms": verify_timeout_ms,
                        })),
                    ));
                }
            }
        }

        // Attach UI diff if captured
        if let Some(diff_result) = ui_diff {
            tracing::debug!(
                "[set_value] Attaching UI diff to result (has_changes: {})",
                diff_result.has_changes
            );
            span.set_attribute("ui_diff.has_changes", diff_result.has_changes.to_string());

            result_json["ui_diff"] = json!(diff_result.diff);
            result_json["has_ui_changes"] = json!(diff_result.has_changes);
        }

        self.restore_window_management(should_restore).await;

        span.set_status(true, None);
        span.end();

        append_window_screenshot_to_json(
            &self.desktop,
            &args.selector.process,
            &mut result_json,
            args.window_screenshot.include_window_screenshot,
        )
        .await;
        let contents = vec![Content::json(result_json)?];
        let contents = append_monitor_screenshots_if_enabled(
            &self.desktop,
            contents,
            args.monitor.include_monitor_screenshots,
        )
        .await;
        Ok(CallToolResult::success(contents))
    }

    // Removed: run_javascript tool (merged into run_command with engine)

    #[tool(
        description = "IMPORTANT: Always use grep_files/read_file with working_directory set to computeruse-source to search patterns and examples before writing scripts. Verify syntax from source.

Execute JavaScript/TypeScript in browser via Chrome extension. Full DOM access for extraction and manipulation.

TYPESCRIPT (preferred):
- Type annotations auto-detected and transpiled to JS before execution
- Type errors caught BEFORE execution with precise line/column info

SDK: desktop.executeBrowserScript() requires plain JS (no TS transpilation)

CRITICAL RULES:
- Return descriptive data: return { loginRequired: true, formCount: 3 }
- DON'T return null/undefined - causes step failure
- Returning { success: false } intentionally fails the step
- Max 30KB response - truncate large data

NAVIGATION WARNING:
Scripts triggering navigation (click links, form submit) can be killed before return executes.
X button.click(); return {done:true}  // Never executes
OK return {ready_to_navigate:true}     // Let next step navigate

Requires Chrome extension installed."
    )]
    async fn execute_browser_script(
        &self,
        Parameters(args): Parameters<ExecuteBrowserScriptArgs>,
    ) -> Result<CallToolResult, McpError> {
        // Start telemetry span
        let mut span = StepSpan::new("execute_browser_script", None);

        // Add comprehensive telemetry attributes
        if let Some(ref script) = args.script {
            span.set_attribute("script.length", script.len().to_string());
        }
        if let Some(ref script_file) = args.script_file {
            span.set_attribute("script_file", script_file.clone());
        }
        use serde_json::json;
        let start_instant = std::time::Instant::now();

        // Check if we need to perform window management (only for direct MCP calls, not sequences)
        let should_restore = {
            let in_sequence = self.in_sequence.lock().unwrap_or_else(|e| e.into_inner());
            let flag_value = *in_sequence;
            let should_restore_value = !flag_value;
            tracing::info!(
                "[execute_browser_script] Flag check: in_sequence={}, should_restore={}",
                flag_value,
                should_restore_value
            );
            should_restore_value
        };

        if should_restore {
            tracing::info!(
                "[execute_browser_script] Direct MCP call detected - performing window management"
            );
            let _ = self
                .prepare_window_management(
                    &args.selector.process,
                    None,
                    None,
                    None,
                    &args.window_mgmt,
                )
                .await;
        } else {
            tracing::debug!("[execute_browser_script] In sequence - skipping window management (dispatch_tool handles it)");
        }

        // Resolve the script content
        let script_content = if let Some(script_file) = &args.script_file {
            // Resolve script file with priority order (same logic as run_command)
            let resolved_path = {
                let script_path = std::path::Path::new(script_file);
                let mut resolved_path = None;
                let mut resolution_attempts = Vec::new();

                // Only resolve if path is relative
                if script_path.is_relative() {
                    tracing::info!(
                        "[SCRIPTS_BASE_PATH] Resolving relative browser script: '{}'",
                        script_file
                    );

                    // Priority 1: Try scripts_base_path if provided
                    let scripts_base_guard = self.current_scripts_base_path.lock().await;
                    if let Some(ref base_path) = *scripts_base_guard {
                        tracing::info!(
                            "[SCRIPTS_BASE_PATH] Checking scripts_base_path for browser script: {}",
                            base_path
                        );
                        let base = std::path::Path::new(base_path);
                        if base.exists() && base.is_dir() {
                            let candidate = base.join(script_file);
                            resolution_attempts
                                .push(format!("scripts_base_path: {}", candidate.display()));
                            tracing::info!(
                                "[SCRIPTS_BASE_PATH] Looking for browser script at: {}",
                                candidate.display()
                            );
                            if candidate.exists() {
                                tracing::info!(
                                    "[SCRIPTS_BASE_PATH] ✓ Found browser script in scripts_base_path: {} -> {}",
                                    script_file,
                                    candidate.display()
                                );
                                resolved_path = Some(candidate);
                            } else {
                                tracing::info!(
                                    "[SCRIPTS_BASE_PATH] ✗ Browser script not found in scripts_base_path: {}",
                                    candidate.display()
                                );
                            }
                        } else {
                            tracing::warn!(
                                "[SCRIPTS_BASE_PATH] Base path does not exist or is not a directory: {}",
                                base_path
                            );
                        }
                    } else {
                        tracing::debug!(
                            "[SCRIPTS_BASE_PATH] No scripts_base_path configured for browser script"
                        );
                    }
                    drop(scripts_base_guard);

                    // Priority 2: Try workflow directory if not found yet
                    if resolved_path.is_none() {
                        let workflow_dir_guard = self.current_workflow_dir.lock().await;
                        if let Some(ref workflow_dir) = *workflow_dir_guard {
                            let candidate = workflow_dir.join(script_file);
                            resolution_attempts
                                .push(format!("workflow_dir: {}", candidate.display()));
                            if candidate.exists() {
                                tracing::info!(
                                    "[execute_browser_script] Resolved via workflow directory: {} -> {}",
                                    script_file,
                                    candidate.display()
                                );
                                resolved_path = Some(candidate);
                            }
                        }
                    }

                    // Priority 3: Check current directory or use as-is
                    if resolved_path.is_none() {
                        let candidate = script_path.to_path_buf();
                        resolution_attempts.push(format!("as-is: {}", candidate.display()));

                        // Check if file exists before using it
                        if candidate.exists() {
                            tracing::info!(
                                "[execute_browser_script] Found script file at: {}",
                                candidate.display()
                            );
                            resolved_path = Some(candidate);
                        } else {
                            tracing::warn!(
                                "[execute_browser_script] Script file not found: {} (tried: {:?})",
                                script_file,
                                resolution_attempts
                            );
                            // Return error immediately for missing file
                            return Err(McpError::invalid_params(
                                format!("Script file '{script_file}' not found"),
                                Some(json!({
                                    "file": script_file,
                                    "resolution_attempts": resolution_attempts,
                                    "error": "File does not exist"
                                })),
                            ));
                        }
                    }
                } else {
                    // Absolute path - check if exists
                    let candidate = script_path.to_path_buf();
                    if candidate.exists() {
                        tracing::info!(
                            "[execute_browser_script] Using absolute path: {}",
                            script_file
                        );
                        resolved_path = Some(candidate);
                    } else {
                        tracing::warn!(
                            "[execute_browser_script] Absolute script file not found: {}",
                            script_file
                        );
                        return Err(McpError::invalid_params(
                            format!("Script file '{script_file}' not found"),
                            Some(json!({
                                "file": script_file,
                                "error": "File does not exist at absolute path"
                            })),
                        ));
                    }
                }

                resolved_path.unwrap()
            };

            // Read script from resolved file path
            tokio::fs::read_to_string(&resolved_path)
                .await
                .map_err(|e| {
                    McpError::invalid_params(
                        "Failed to read script file",
                        Some(json!({
                            "file": script_file,
                            "resolved_path": resolved_path.to_string_lossy(),
                            "error": e.to_string()
                        })),
                    )
                })?
        } else if let Some(script) = &args.script {
            if script.is_empty() {
                // Restore windows before returning error
                self.restore_window_management(should_restore).await;
                return Err(McpError::invalid_params("Script cannot be empty", None));
            }
            script.clone()
        } else {
            // Restore windows before returning error
            self.restore_window_management(should_restore).await;
            return Err(McpError::invalid_params(
                "Either 'script' or 'script_file' must be provided",
                None,
            ));
        };

        // Transpile TypeScript to JavaScript if needed (before env injection)
        // This provides immediate feedback on type errors before execution
        let script_content = match crate::transpiler::transpile(
            &script_content,
            crate::transpiler::TranspileTarget::Browser,
        )
        .await
        {
            Ok(result) => {
                if result.was_typescript {
                    tracing::info!(
                        "[execute_browser_script] Transpiled TypeScript to JavaScript ({} -> {} bytes)",
                        script_content.len(),
                        result.code.len()
                    );
                }
                result.code
            }
            Err(e) => {
                // Restore windows before returning transpilation error with fallback suggestion
                self.restore_window_management(should_restore).await;
                return Err(e.into_mcp_error());
            }
        };

        // Build the final script with env prepended if provided
        let mut final_script = String::new();

        // Extract workflow variables and accumulated env from special env keys
        let mut variables_json = "{}".to_string();
        let mut accumulated_env_json = "{}".to_string();
        let mut env_data = args.env.clone();

        if let Some(env) = &env_data {
            if let Some(env_obj) = env.as_object() {
                // Extract workflow variables
                if let Some(vars) = env_obj.get("_workflow_variables") {
                    variables_json =
                        serde_json::to_string(vars).unwrap_or_else(|_| "{}".to_string());
                }
                // Extract accumulated env
                if let Some(acc_env) = env_obj.get("_accumulated_env") {
                    accumulated_env_json =
                        serde_json::to_string(acc_env).unwrap_or_else(|_| "{}".to_string());
                }
            }
        }

        // Remove special keys from env before normal processing
        if let Some(env) = &mut env_data {
            if let Some(env_obj) = env.as_object_mut() {
                env_obj.remove("_workflow_variables");
                env_obj.remove("_accumulated_env");
            }
        }

        // Prepare explicit env if provided
        let explicit_env_json = if let Some(env) = &env_data {
            if env.as_object().is_some_and(|o| !o.is_empty()) {
                serde_json::to_string(&env).map_err(|e| {
                    McpError::internal_error(
                        "Failed to serialize env data",
                        Some(json!({"error": e.to_string()})),
                    )
                })?
            } else {
                "{}".to_string()
            }
        } else {
            "{}".to_string()
        };

        // Inject accumulated env first
        final_script.push_str(&format!("var env = {accumulated_env_json};\n"));

        // Merge explicit env if provided
        if explicit_env_json != "{}" {
            final_script.push_str(&format!("env = Object.assign(env, {explicit_env_json});\n"));
        }

        // Inject individual variables from env (browser scripts are always JavaScript)
        let merged_env = if explicit_env_json != "{}" {
            // Merge accumulated and explicit env for individual vars
            let mut base: serde_json::Map<String, serde_json::Value> =
                serde_json::from_str(&accumulated_env_json).unwrap_or_default();
            if let Ok(explicit) = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(
                &explicit_env_json,
            ) {
                base.extend(explicit);
            }
            serde_json::to_string(&base).unwrap_or_else(|_| "{}".to_string())
        } else {
            accumulated_env_json.clone()
        };

        // Track which variables will be injected
        let mut injected_vars = std::collections::HashSet::new();

        if let Ok(env_obj) =
            serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&merged_env)
        {
            for (key, value) in env_obj {
                // Inject all valid JavaScript identifiers from env
                // The IIFE wrapper prevents conflicts with previous script executions
                if Self::is_valid_js_identifier(&key) {
                    // Smart handling of potentially double-stringified JSON
                    let injectable_value = if let Some(str_val) = value.as_str() {
                        let trimmed = str_val.trim();
                        // Check if it looks like JSON (object or array)
                        if (trimmed.starts_with('{') && trimmed.ends_with('}'))
                            || (trimmed.starts_with('[') && trimmed.ends_with(']'))
                        {
                            // Try to parse as JSON to avoid double stringification
                            match serde_json::from_str::<serde_json::Value>(str_val) {
                                Ok(parsed) => {
                                    tracing::debug!(
                                        "[execute_browser_script] Detected JSON string for env.{}, parsing to avoid double stringification",
                                        key
                                    );
                                    parsed
                                }
                                Err(_) => {
                                    // Not valid JSON despite looking like it, keep as string
                                    value.clone()
                                }
                            }
                        } else {
                            // Regular string value, keep as is
                            value.clone()
                        }
                    } else {
                        // Not a string (number, bool, object, etc.), keep as is
                        value.clone()
                    };

                    // Now stringify for injection (single level of stringification)
                    if let Ok(value_json) = serde_json::to_string(&injectable_value) {
                        final_script.push_str(&format!("var {key} = {value_json};\n"));
                        injected_vars.insert(key.clone()); // Track this variable
                    }
                }
            }
        }

        // Inject variables
        final_script.push_str(&format!("var variables = {variables_json};\n"));

        // Parse and inject individual workflow variables
        if let Ok(variables_obj) =
            serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&variables_json)
        {
            for (key, value) in variables_obj {
                // Inject all valid JavaScript identifiers from variables
                if Self::is_valid_js_identifier(&key) {
                    // Smart handling of potentially double-stringified JSON
                    let injectable_value = if let Some(str_val) = value.as_str() {
                        let trimmed = str_val.trim();
                        // Check if it looks like JSON (object or array)
                        if (trimmed.starts_with('{') && trimmed.ends_with('}'))
                            || (trimmed.starts_with('[') && trimmed.ends_with(']'))
                        {
                            // Try to parse as JSON to avoid double stringification
                            match serde_json::from_str::<serde_json::Value>(str_val) {
                                Ok(parsed) => {
                                    tracing::debug!(
                                        "[execute_browser_script] Detected JSON string for variables.{}, parsing to avoid double stringification",
                                        key
                                    );
                                    parsed
                                }
                                Err(_) => {
                                    // Not valid JSON despite looking like it, keep as string
                                    value.clone()
                                }
                            }
                        } else {
                            // Regular string value, keep as is
                            value.clone()
                        }
                    } else {
                        // Not a string (number, bool, object, etc.), keep as is
                        value.clone()
                    };

                    // Now stringify for injection (single level of stringification)
                    if let Ok(value_json) = serde_json::to_string(&injectable_value) {
                        final_script.push_str(&format!("var {key} = {value_json};\n"));
                        injected_vars.insert(key.clone()); // Track this variable for smart replacement
                    }
                }
            }
        }

        tracing::debug!("[execute_browser_script] Injected accumulated env, explicit env, individual vars, and workflow variables");

        // Smart replacement of declarations with assignments for already-injected variables
        let mut modified_script = script_content.clone();
        if !injected_vars.is_empty() {
            tracing::info!(
                "[execute_browser_script] Checking for variable declarations to replace. Injected vars count: {}",
                injected_vars.len()
            );

            for var_name in &injected_vars {
                // Create regex to match declarations of this variable
                // Matches: const varName =, let varName =, var varName =
                // With optional whitespace, handling line start
                let pattern = format!(
                    r"(?m)^(\s*)(const|let|var)\s+{}\s*=",
                    regex::escape(var_name)
                );

                if let Ok(re) = Regex::new(&pattern) {
                    let before = modified_script.clone();
                    modified_script = re
                        .replace_all(&modified_script, format!("${{1}}{var_name} ="))
                        .to_string();

                    if before != modified_script {
                        tracing::info!(
                            "[execute_browser_script] Replaced declaration of '{}' with assignment to avoid redeclaration error",
                            var_name
                        );
                    }
                }
            }

            // Log first 500 chars of modified script for debugging
            let preview: String = modified_script.chars().take(500).collect();
            tracing::debug!(
                "[execute_browser_script] Modified script preview after replacements: {}...",
                preview
            );
        }

        // Validate that browser scripts don't use top-level return statements
        if modified_script.trim_start().starts_with("return ") {
            // Restore windows before returning error
            self.restore_window_management(should_restore).await;
            return Err(McpError::invalid_params(
                "Browser scripts cannot use top-level 'return' statements. \
                 Remove 'return' from the beginning of your script. \
                 Example: Use '(async function() {...})()' instead of 'return (async function() {...})()'",
                None
            ));
        }

        let cleaned_script = modified_script;

        // Check if console log capture is enabled
        let include_logs = args.include_logs.unwrap_or(false);

        if include_logs {
            // Inject console capture wrapper
            final_script.push_str(
                r#"
// Console capture wrapper (auto-injected when include_logs=true)
var __computeruse_logs__ = [];
var __computeruse_console__ = {
  log: console.log,
  warn: console.warn,
  error: console.error,
  info: console.info,
  debug: console.debug
};

console.log = function(...args) {
  __computeruse_logs__.push(['log', ...args.map(a => {
    try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
    catch(e) { return String(a); }
  })]);
  __computeruse_console__.log.apply(console, args);
};
console.error = function(...args) {
  __computeruse_logs__.push(['error', ...args.map(a => {
    try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
    catch(e) { return String(a); }
  })]);
  __computeruse_console__.error.apply(console, args);
};
console.warn = function(...args) {
  __computeruse_logs__.push(['warn', ...args.map(a => {
    try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
    catch(e) { return String(a); }
  })]);
  __computeruse_console__.warn.apply(console, args);
};
console.info = function(...args) {
  __computeruse_logs__.push(['info', ...args.map(a => {
    try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
    catch(e) { return String(a); }
  })]);
  __computeruse_console__.info.apply(console, args);
};

"#,
            );

            // Wrap user script to capture result + logs
            // Use eval() to execute user script - eval returns the last expression's value
            // This handles multi-statement scripts correctly (e.g., "console.log('x'); document.title")
            let escaped_script = cleaned_script
                .replace('\\', "\\\\")
                .replace('`', "\\`")
                .replace("${", "\\${");
            final_script.push_str("(function() {\n");
            final_script.push_str("  var __user_result__ = eval(`");
            final_script.push_str(&escaped_script);
            final_script.push_str("`);\n");
            final_script.push_str("  return JSON.stringify({\n");
            final_script.push_str("    result: __user_result__,\n");
            final_script.push_str("    logs: __computeruse_logs__\n");
            final_script.push_str("  });\n");
            final_script.push_str("})()");
        } else {
            // Append the cleaned script without wrapper
            final_script.push_str(&cleaned_script);
        }
        let script_len = final_script.len();
        let script_preview: String = final_script.chars().take(200).collect();
        tracing::info!(
            "[execute_browser_script] start selector='{}' timeout_ms={:?} retries={:?} script_bytes={}",
            args.selector.selector,
            args.action.timeout_ms,
            args.action.retries,
            script_len
        );
        tracing::debug!(
            "[execute_browser_script] script_preview: {}",
            script_preview
        );

        let script_clone = final_script.clone();
        let ((script_result, element), successful_selector) =
            match crate::utils::find_and_execute_with_retry_with_fallback(
                &self.desktop,
                &args.selector.build_full_selector(),
                args.selector.build_alternative_selectors().as_deref(),
                args.selector.build_fallback_selectors().as_deref(),
                args.action.timeout_ms,
                args.action.retries,
                |el| {
                    let script = script_clone.clone();
                    async move { el.execute_browser_script(&script).await }
                },
            )
            .await
            {
                Ok(((result, element), selector)) => Ok(((result, element), selector)),
                Err(e) => {
                    // Use warn! since browser script failures are often expected (extension not installed, user script errors)
                    tracing::warn!(
                        "[execute_browser_script] failed selector='{}' alt='{:?}' fallback='{:?}' error={}",
                        args.selector.selector,
                        args.selector.alternative_selectors,
                        args.selector.fallback_selectors,
                        e
                    );

                    // Check if this is a JavaScript execution error or extension bridge error
                    if let Some(AutomationError::PlatformError(msg)) =
                        e.downcast_ref::<AutomationError>()
                    {
                        if msg.contains("JavaScript") || msg.contains("script") {
                            // Return JavaScript-specific error, not "Element not found"
                            // Restore windows before returning error
                            self.restore_window_management(should_restore).await;
                            return Err(McpError::invalid_params(
                                "Browser script execution failed",
                                Some(json!({
                                    "error_type": "script_execution_failure",
                                    "message": msg.clone(),
                                    "selector": args.selector.selector,
                                    "selectors_tried": get_selectors_tried_all(
                                        &args.selector.build_full_selector(),
                                        args.selector.build_alternative_selectors().as_deref(),
                                        args.selector.build_fallback_selectors().as_deref(),
                                    ),
                                    "suggestion": "Check the browser console for JavaScript errors. The script may have timed out or encountered an error."
                                })),
                            ));
                        }
                        // Check for extension bridge connection errors
                        if msg.contains("extension")
                            || msg.contains("bridge")
                            || msg.contains("port")
                            || msg.contains("bind")
                            || msg.contains("client")
                        {
                            self.restore_window_management(should_restore).await;
                            return Err(McpError::invalid_params(
                                "Browser extension connection failed",
                                Some(json!({
                                    "error_type": "extension_connection_failure",
                                    "message": msg.clone(),
                                    "selector": args.selector.selector,
                                    "suggestion": "The Chrome extension bridge failed to connect. Try: 1) Kill all computeruse-mcp-agent processes, 2) Refresh the browser tab, 3) Check if ComputerUse Bridge extension is installed and active."
                                })),
                            ));
                        }
                        // Check for chrome:// URL errors (new tab, settings, extensions pages)
                        if msg.contains("chrome://") || msg.contains("Cannot access a chrome") {
                            self.restore_window_management(should_restore).await;
                            return Err(McpError::invalid_params(
                                "Navigate to a regular website first",
                                Some(json!({
                                    "error_type": "chrome_internal_page",
                                    "message": "Cannot execute script on chrome:// page (new tab, settings, extensions). The Chrome DevTools debugger cannot attach to internal browser pages.",
                                    "selector": args.selector.selector,
                                    "suggestion": "Navigate to a regular website (http:// or https://) before executing browser scripts."
                                })),
                            ));
                        }
                    }

                    // For other errors, treat as element not found
                    // Restore windows before returning error
                    self.restore_window_management(should_restore).await;
                    Err(build_element_not_found_error(
                        &args.selector.build_full_selector(),
                        args.selector.build_alternative_selectors().as_deref(),
                        args.selector.build_fallback_selectors().as_deref(),
                        e,
                    ))
                }
            }?;
        let elapsed_ms = start_instant.elapsed().as_millis() as u64;
        tracing::info!(
            "[execute_browser_script] target resolved selector='{}' role='{}' name='{}' pid={} in {}ms",
            successful_selector,
            element.role(),
            element.name().unwrap_or_default(),
            element.process_id().unwrap_or(0),
            elapsed_ms
        );

        let selectors_tried = get_selectors_tried_all(
            &args.selector.build_full_selector(),
            args.selector.build_alternative_selectors().as_deref(),
            args.selector.build_fallback_selectors().as_deref(),
        );

        // Parse script_result to extract result and logs if console capture was enabled
        let (actual_result, captured_logs) = if include_logs {
            // Try to parse the wrapped result
            match serde_json::from_str::<serde_json::Value>(&script_result) {
                Ok(parsed) => {
                    let result = parsed.get("result").cloned().unwrap_or_else(|| {
                        // If no result field, use the whole parsed value
                        parsed.clone()
                    });
                    let logs = parsed.get("logs").cloned();
                    (result, logs)
                }
                Err(e) => {
                    // Failed to parse - script might have returned non-JSON
                    // Fall back to treating the whole result as the actual result
                    tracing::warn!(
                        "[execute_browser_script] Failed to parse wrapped result, falling back to raw result. Error: {}",
                        e
                    );
                    (json!(script_result), None)
                }
            }
        } else {
            // No wrapping, use script_result as-is
            (json!(script_result), None)
        };

        let mut result_json = json!({
            "action": "execute_browser_script",
            "status": "executed_without_error",
            "selector": successful_selector,
            "selector_used": successful_selector,
            "selectors_tried": selectors_tried,
            "element": build_element_info(&element),
            "script": "[script content omitted to reduce verbosity]",
            "script_file": args.script_file,
            "env_provided": args.env.is_some(),
            "result": actual_result,
            "timestamp": chrono::Utc::now().to_rfc3339(),
            "duration_ms": elapsed_ms,
            "script_bytes": script_len,
        });

        // Include logs if they were captured
        if let Some(logs) = captured_logs {
            result_json["logs"] = logs;
        }

        // Note: Tree attachment removed - use ui_diff_before_after for tree context

        // Restore windows after executing browser script
        self.restore_window_management(should_restore).await;

        span.set_status(true, None);
        span.end();

        append_window_screenshot_to_json(
            &self.desktop,
            &args.selector.process,
            &mut result_json,
            args.window_screenshot.include_window_screenshot,
        )
        .await;
        let contents = vec![Content::json(result_json)?];
        let contents = append_monitor_screenshots_if_enabled(
            &self.desktop,
            contents,
            args.monitor.include_monitor_screenshots,
        )
        .await;
        Ok(CallToolResult::success(contents))
    }

    #[tool(
        description = "Stops all currently executing workflows/tools by cancelling active requests. Use this when the user clicks a stop button or wants to abort execution."
    )]
    async fn stop_execution(&self) -> Result<CallToolResult, McpError> {
        let start = std::time::Instant::now();
        info!("[STOP-DEBUG] stop_execution tool called");

        // Get counts before cancellation
        let before_count = self.request_manager.active_count().await;
        info!(
            "[STOP-DEBUG] Active requests BEFORE cancel_all: {}",
            before_count
        );

        // Cancel all active requests using the request manager
        info!("[STOP-DEBUG] Calling request_manager.cancel_all()...");
        self.request_manager.cancel_all().await;
        info!(
            "[STOP-DEBUG] request_manager.cancel_all() completed in {:?}",
            start.elapsed()
        );

        // Also cancel Desktop operations (triggers inner cancellation checks in gemini_computer_use)
        info!("[STOP-DEBUG] Calling desktop.stop_execution()...");
        self.desktop.stop_execution();
        info!("[STOP-DEBUG] desktop.stop_execution() completed");

        let active_count = self.request_manager.active_count().await;
        info!(
            "[STOP-DEBUG] stop_execution completed in {:?}. Active count: {} -> {}",
            start.elapsed(),
            before_count,
            active_count
        );

        let result_json = json!({
            "action": "stop_execution",
            "status": "executed_without_error",
            "message": format!("Cancelled {} active requests", before_count),
            "active_before": before_count,
            "active_after": active_count,
            "elapsed_ms": start.elapsed().as_millis(),
            "timestamp": chrono::Utc::now().to_rfc3339(),
        });

        Ok(CallToolResult::success(vec![Content::json(result_json)?]))
    }

    #[tool(
        description = "Gemini Computer Use agentic loop. Provide a goal and target process, and the tool will autonomously take actions (click, type, scroll, etc.) until the goal is achieved or max_steps is reached. Uses native Gemini 2.5 Computer Use model with function calling. Returns when: task complete (model returns no function call), needs user confirmation, or max_steps exceeded."
    )]
    async fn gemini_computer_use(
        &self,
        Parameters(args): Parameters<GeminiComputerUseArgs>,
    ) -> Result<CallToolResult, McpError> {
        let mut span = StepSpan::new("gemini_computer_use", None);
        span.set_attribute("process", args.process.clone());
        span.set_attribute("goal", args.goal.clone());

        info!(
            "[gemini_computer_use] Starting agentic loop for goal: {} (max_steps: {:?})",
            args.goal, args.max_steps
        );

        // Perform initial window management
        let _ = self
            .prepare_window_management(&args.process, None, None, None, &args.window_mgmt)
            .await;

        // Call Desktop::gemini_computer_use (single source of truth)
        // This respects stop_execution() via cancellation token
        let result = self
            .desktop
            .gemini_computer_use(&args.process, &args.goal, args.max_steps, None)
            .await
            .map_err(|e| McpError::internal_error(e.to_string(), None))?;

        // Restore windows
        let _ = self.window_manager.restore_all_windows().await;
        self.window_manager.clear_captured_state().await;

        span.set_status(result.status == "executed_without_error", None);
        span.end();

        // Build history summary for response (convert steps to simpler format)
        let history_summary: Vec<serde_json::Value> = result
            .steps
            .iter()
            .map(|step| {
                json!({
                    "step": step.step,
                    "action": step.action,
                    "success": step.success,
                    "error": step.error,
                })
            })
            .collect();

        let result_json = json!({
            "status": result.status,
            "goal": result.goal,
            "steps_executed": result.steps_executed,
            "final_action": result.final_action,
            "final_text": result.final_text,
            "history": history_summary,
            "pending_confirmation": result.pending_confirmation,
            "execution_id": result.execution_id,
        });

        info!(
            "[gemini_computer_use] Completed with status: {} ({} steps)",
            result.status, result.steps_executed
        );

        Ok(CallToolResult::success(vec![Content::json(result_json)?]))
    }

    // ===== File Operation Tools =====

    /// Resolve a file path, using working_directory or current_workflow_dir as base for relative paths.
    /// Supports shortcuts for common directories:
    /// - "executions" → %LOCALAPPDATA%/computeruse/executions
    /// - "computeruse-source" → %LOCALAPPDATA%/mediar/computeruse-source
    /// - "logs" → %LOCALAPPDATA%/computeruse/logs
    async fn resolve_file_path(
        &self,
        path: &str,
        working_directory: Option<&str>,
    ) -> Result<PathBuf, String> {
        let path_buf = PathBuf::from(path);

        // If absolute path, use as-is
        if path_buf.is_absolute() {
            return Ok(path_buf);
        }

        // Try working_directory first (injected by mediar-app or specified by AI)
        if let Some(wd) = working_directory {
            let expanded_wd = expand_working_directory_shortcut(wd);
            let resolved = expanded_wd.join(path);
            return Ok(resolved);
        }

        // Fall back to current_workflow_dir (set by execute_sequence)
        let workflow_dir_guard = self.current_workflow_dir.lock().await;
        if let Some(ref workflow_dir) = *workflow_dir_guard {
            return Ok(workflow_dir.join(path));
        }

        Err("No working directory available. Either provide an absolute path or ensure a workflow is focused.".to_string())
    }

    #[tool(
        description = "Read file contents with line numbers. Default 100 lines, max 200. Use grep_files first to find code, then read_file with offset/limit for context."
    )]
    pub async fn read_file(
        &self,
        Parameters(args): Parameters<ReadFileArgs>,
    ) -> Result<CallToolResult, McpError> {
        use std::fs;
        use std::io::{BufRead, BufReader};

        let full_path = match self
            .resolve_file_path(&args.path, args.working_directory.as_deref())
            .await
        {
            Ok(p) => p,
            Err(e) => {
                return Ok(CallToolResult::error(vec![Content::text(format!(
                    "Error: {e}"
                ))]));
            }
        };

        if !full_path.exists() {
            return Ok(CallToolResult::error(vec![Content::text(format!(
                "File not found: {}",
                full_path.display()
            ))]));
        }

        if !full_path.is_file() {
            return Ok(CallToolResult::error(vec![Content::text(format!(
                "Path is not a file: {}",
                full_path.display()
            ))]));
        }

        let file = match fs::File::open(&full_path) {
            Ok(f) => f,
            Err(e) => {
                return Ok(CallToolResult::error(vec![Content::text(format!(
                    "Failed to open file: {e}"
                ))]));
            }
        };

        let reader = BufReader::new(file);
        let offset = args.offset.unwrap_or(1).saturating_sub(1); // Convert to 0-indexed
        let limit = args.limit.unwrap_or(100).min(200); // Default 100, max 200

        let lines: Vec<String> = reader
            .lines()
            .skip(offset)
            .take(limit)
            .enumerate()
            .map(|(i, line)| {
                format!(
                    "{:5}: {}",
                    offset + i + 1,
                    line.unwrap_or_else(|_| "[binary content]".to_string())
                )
            })
            .collect();

        Ok(CallToolResult::success(vec![Content::text(format!(
            "File: {}\nLines {}-{}:\n{}",
            args.path,
            offset + 1,
            offset + lines.len(),
            lines.join("\n")
        ))]))
    }

    #[tool(
        description = "Write content to a file. Creates the file if it doesn't exist, or overwrites if it does. Creates parent directories as needed."
    )]
    pub async fn write_file(
        &self,
        Parameters(args): Parameters<WriteFileArgs>,
    ) -> Result<CallToolResult, McpError> {
        use std::fs;

        let full_path = match self
            .resolve_file_path(&args.path, args.working_directory.as_deref())
            .await
        {
            Ok(p) => p,
            Err(e) => {
                return Ok(CallToolResult::error(vec![Content::text(format!(
                    "Error: {e}"
                ))]));
            }
        };

        // Ensure parent directory exists
        if let Some(parent) = full_path.parent() {
            if !parent.exists() {
                if let Err(e) = fs::create_dir_all(parent) {
                    return Ok(CallToolResult::error(vec![Content::text(format!(
                        "Failed to create directory: {e}"
                    ))]));
                }
            }
        }

        match fs::write(&full_path, &args.content) {
            Ok(_) => Ok(CallToolResult::success(vec![Content::text(format!(
                "Successfully wrote {} bytes to {}",
                args.content.len(),
                args.path
            ))])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(format!(
                "Failed to write file: {e}"
            ))])),
        }
    }

    #[tool(
        description = "Edit a file by replacing a string match. PREFER replacing entire functions, blocks, or logical sections in ONE edit rather than making multiple small surgical edits. Multi-line old_string and new_string are fully supported. The old_string must be unique unless replace_all is true. Line endings are normalized automatically."
    )]
    pub async fn edit_file(
        &self,
        Parameters(args): Parameters<EditFileArgs>,
    ) -> Result<CallToolResult, McpError> {
        use std::fs;

        let full_path = match self
            .resolve_file_path(&args.path, args.working_directory.as_deref())
            .await
        {
            Ok(p) => p,
            Err(e) => {
                return Ok(CallToolResult::error(vec![Content::text(format!(
                    "Error: {e}"
                ))]));
            }
        };

        if !full_path.exists() {
            return Ok(CallToolResult::error(vec![Content::text(format!(
                "File not found: {}",
                full_path.display()
            ))]));
        }

        let content = match fs::read_to_string(&full_path) {
            Ok(c) => c,
            Err(e) => {
                return Ok(CallToolResult::error(vec![Content::text(format!(
                    "Failed to read file: {e}"
                ))]));
            }
        };

        // Normalize line endings for matching (CRLF -> LF)
        let content_normalized = content.replace("\r\n", "\n");
        let old_string_normalized = args.old_string.replace("\r\n", "\n");
        let new_string_normalized = args.new_string.replace("\r\n", "\n");

        // Count occurrences
        let occurrences = content_normalized.matches(&old_string_normalized).count();

        if occurrences == 0 {
            let preview = if args.old_string.len() > 50 {
                format!("{}...", &args.old_string[..50])
            } else {
                args.old_string.clone()
            };
            return Ok(CallToolResult::error(vec![Content::text(format!(
                "String not found in file: \"{}\"",
                preview
            ))]));
        }

        if !args.replace_all.unwrap_or(false) && occurrences > 1 {
            return Ok(CallToolResult::error(vec![Content::text(format!(
                "String found {} times. Use replace_all: true or provide more context to make it unique.",
                occurrences
            ))]));
        }

        // Perform replacement on normalized content
        let new_content = if args.replace_all.unwrap_or(false) {
            content_normalized.replace(&old_string_normalized, &new_string_normalized)
        } else {
            content_normalized.replacen(&old_string_normalized, &new_string_normalized, 1)
        };

        let replacements = if args.replace_all.unwrap_or(false) {
            occurrences
        } else {
            1
        };

        match fs::write(&full_path, new_content) {
            Ok(_) => Ok(CallToolResult::success(vec![Content::text(format!(
                "Successfully made {} replacement(s) in {}",
                replacements, args.path
            ))])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(format!(
                "Failed to write file: {e}"
            ))])),
        }
    }

    #[tool(
        description = "Copy content from a source file and insert/replace it in a target file. Supports extracting by line numbers, patterns, or entire file. Target insertion supports replace, before/after pattern, at line number, append, or prepend. Never use with same source and target path (corrupts file)"
    )]
    pub async fn copy_content(
        &self,
        Parameters(args): Parameters<CopyContentArgs>,
    ) -> Result<CallToolResult, McpError> {
        use std::fs;

        // Resolve source path
        let source_path = match self
            .resolve_file_path(&args.source_path, args.working_directory.as_deref())
            .await
        {
            Ok(p) => p,
            Err(e) => {
                return Ok(CallToolResult::error(vec![Content::text(format!(
                    "Error resolving source path: {e}"
                ))]));
            }
        };

        // Resolve target path
        let target_path = match self
            .resolve_file_path(&args.target_path, args.working_directory.as_deref())
            .await
        {
            Ok(p) => p,
            Err(e) => {
                return Ok(CallToolResult::error(vec![Content::text(format!(
                    "Error resolving target path: {e}"
                ))]));
            }
        };

        // Read source file
        if !source_path.exists() {
            return Ok(CallToolResult::error(vec![Content::text(format!(
                "Source file not found: {}",
                source_path.display()
            ))]));
        }

        let source_content = match fs::read_to_string(&source_path) {
            Ok(c) => c,
            Err(e) => {
                return Ok(CallToolResult::error(vec![Content::text(format!(
                    "Failed to read source file: {e}"
                ))]));
            }
        };

        let source_lines: Vec<&str> = source_content.lines().collect();

        // Extract content from source based on source_mode
        let extracted_content: String = match args.source_mode.as_str() {
            "all" => source_content.clone(),
            "lines" => {
                let start = match args.source_start_line {
                    Some(l) if l >= 1 => l - 1, // Convert to 0-indexed
                    Some(_) => {
                        return Ok(CallToolResult::error(vec![Content::text(
                            "source_start_line must be >= 1".to_string(),
                        )]));
                    }
                    None => {
                        return Ok(CallToolResult::error(vec![Content::text(
                            "source_start_line is required when source_mode is 'lines'".to_string(),
                        )]));
                    }
                };
                let end = match args.source_end_line {
                    Some(l) if l >= 1 => l, // Keep 1-indexed for inclusive end
                    Some(_) => {
                        return Ok(CallToolResult::error(vec![Content::text(
                            "source_end_line must be >= 1".to_string(),
                        )]));
                    }
                    None => {
                        return Ok(CallToolResult::error(vec![Content::text(
                            "source_end_line is required when source_mode is 'lines'".to_string(),
                        )]));
                    }
                };

                if start >= source_lines.len() {
                    return Ok(CallToolResult::error(vec![Content::text(format!(
                        "source_start_line {} exceeds file length {}",
                        start + 1,
                        source_lines.len()
                    ))]));
                }

                let end_clamped = end.min(source_lines.len());
                source_lines[start..end_clamped].join("\n")
            }
            "pattern" => {
                let start_pattern = match &args.source_start_pattern {
                    Some(p) => p,
                    None => {
                        return Ok(CallToolResult::error(vec![Content::text(
                            "source_start_pattern is required when source_mode is 'pattern'"
                                .to_string(),
                        )]));
                    }
                };
                let end_pattern = match &args.source_end_pattern {
                    Some(p) => p,
                    None => {
                        return Ok(CallToolResult::error(vec![Content::text(
                            "source_end_pattern is required when source_mode is 'pattern'"
                                .to_string(),
                        )]));
                    }
                };

                // Find start line
                let start_idx = source_lines
                    .iter()
                    .position(|line| line.contains(start_pattern));
                let start_idx = match start_idx {
                    Some(i) => i,
                    None => {
                        return Ok(CallToolResult::error(vec![Content::text(format!(
                            "source_start_pattern '{}' not found in source file",
                            start_pattern
                        ))]));
                    }
                };

                // Find end line (searching after start)
                let end_idx = source_lines[start_idx..]
                    .iter()
                    .position(|line| line.contains(end_pattern))
                    .map(|i| i + start_idx);
                let end_idx = match end_idx {
                    Some(i) => i + 1, // Include the end line
                    None => {
                        return Ok(CallToolResult::error(vec![Content::text(format!(
                            "source_end_pattern '{}' not found after start pattern in source file",
                            end_pattern
                        ))]));
                    }
                };

                source_lines[start_idx..end_idx].join("\n")
            }
            _ => {
                return Ok(CallToolResult::error(vec![Content::text(format!(
                    "Invalid source_mode '{}'. Must be 'all', 'lines', or 'pattern'",
                    args.source_mode
                ))]));
            }
        };

        // Read target file
        if !target_path.exists() {
            return Ok(CallToolResult::error(vec![Content::text(format!(
                "Target file not found: {}. Use write_file to create new files.",
                target_path.display()
            ))]));
        }

        let target_content = match fs::read_to_string(&target_path) {
            Ok(c) => c,
            Err(e) => {
                return Ok(CallToolResult::error(vec![Content::text(format!(
                    "Failed to read target file: {e}"
                ))]));
            }
        };

        // Apply to target based on target_mode
        let new_target_content: String = match args.target_mode.as_str() {
            "append" => {
                if target_content.ends_with('\n') {
                    format!("{}{}", target_content, extracted_content)
                } else {
                    format!("{}\n{}", target_content, extracted_content)
                }
            }
            "prepend" => {
                format!("{}\n{}", extracted_content, target_content)
            }
            "at_line" => {
                let line_num = match args.target_line {
                    Some(l) if l >= 1 => l,
                    Some(_) => {
                        return Ok(CallToolResult::error(vec![Content::text(
                            "target_line must be >= 1".to_string(),
                        )]));
                    }
                    None => {
                        return Ok(CallToolResult::error(vec![Content::text(
                            "target_line is required when target_mode is 'at_line'".to_string(),
                        )]));
                    }
                };

                let target_lines: Vec<&str> = target_content.lines().collect();
                let insert_idx = (line_num - 1).min(target_lines.len());

                let mut result_lines: Vec<&str> = Vec::new();
                result_lines.extend_from_slice(&target_lines[..insert_idx]);

                // Add extracted content lines
                for line in extracted_content.lines() {
                    result_lines.push(line);
                }

                result_lines.extend_from_slice(&target_lines[insert_idx..]);
                result_lines.join("\n")
            }
            "replace" | "after" | "before" => {
                let pattern = match &args.target_pattern {
                    Some(p) => p,
                    None => {
                        return Ok(CallToolResult::error(vec![Content::text(format!(
                            "target_pattern is required when target_mode is '{}'",
                            args.target_mode
                        ))]));
                    }
                };

                let occurrences = target_content.matches(pattern).count();

                if occurrences == 0 {
                    return Ok(CallToolResult::error(vec![Content::text(format!(
                        "target_pattern '{}' not found in target file",
                        pattern
                    ))]));
                }

                if !args.replace_all.unwrap_or(false) && occurrences > 1 {
                    return Ok(CallToolResult::error(vec![Content::text(format!(
                        "target_pattern found {} times. Use replace_all: true or provide more context to make it unique.",
                        occurrences
                    ))]));
                }

                match args.target_mode.as_str() {
                    "replace" => {
                        if args.replace_all.unwrap_or(false) {
                            target_content.replace(pattern, &extracted_content)
                        } else {
                            target_content.replacen(pattern, &extracted_content, 1)
                        }
                    }
                    "after" => {
                        let replacement = format!("{}\n{}", pattern, extracted_content);
                        if args.replace_all.unwrap_or(false) {
                            target_content.replace(pattern, &replacement)
                        } else {
                            target_content.replacen(pattern, &replacement, 1)
                        }
                    }
                    "before" => {
                        let replacement = format!("{}\n{}", extracted_content, pattern);
                        if args.replace_all.unwrap_or(false) {
                            target_content.replace(pattern, &replacement)
                        } else {
                            target_content.replacen(pattern, &replacement, 1)
                        }
                    }
                    _ => unreachable!(),
                }
            }
            _ => {
                return Ok(CallToolResult::error(vec![Content::text(format!(
                    "Invalid target_mode '{}'. Must be 'replace', 'after', 'before', 'at_line', 'append', or 'prepend'",
                    args.target_mode
                ))]));
            }
        };

        // Write the result
        match fs::write(&target_path, &new_target_content) {
            Ok(_) => {
                let lines_copied = extracted_content.lines().count();
                Ok(CallToolResult::success(vec![Content::text(format!(
                    "Successfully copied {} lines from {} to {} (mode: {} -> {})",
                    lines_copied,
                    args.source_path,
                    args.target_path,
                    args.source_mode,
                    args.target_mode
                ))]))
            }
            Err(e) => Ok(CallToolResult::error(vec![Content::text(format!(
                "Failed to write target file: {e}"
            ))])),
        }
    }

    #[tool(
        description = "Find files matching a glob pattern in the working directory. Returns a list of matching file paths. Automatically respects .gitignore and skips node_modules, .git, dist, etc."
    )]
    pub async fn glob_files(
        &self,
        Parameters(args): Parameters<GlobFilesArgs>,
    ) -> Result<CallToolResult, McpError> {
        use ignore::WalkBuilder;

        let base_dir = match args.working_directory.as_deref() {
            Some(wd) => expand_working_directory_shortcut(wd),
            None => {
                let workflow_dir_guard = self.current_workflow_dir.lock().await;
                match &*workflow_dir_guard {
                    Some(dir) => dir.clone(),
                    None => {
                        return Ok(CallToolResult::error(vec![Content::text(
                            "Error: No working directory available. Either provide working_directory or ensure a workflow is focused.".to_string()
                        )]));
                    }
                }
            }
        };

        // Build glob matcher for the pattern
        let glob_matcher = match glob::Pattern::new(&args.pattern) {
            Ok(p) => p,
            Err(e) => {
                return Ok(CallToolResult::error(vec![Content::text(format!(
                    "Invalid glob pattern: {e}"
                ))]));
            }
        };

        // Use ignore::WalkBuilder which respects .gitignore and has smart defaults
        // - Skips hidden files/dirs (.git, etc.)
        // - Respects .gitignore files
        // - Has built-in ignores for common dirs like node_modules
        let walker = WalkBuilder::new(&base_dir)
            .hidden(true) // Skip hidden files/dirs
            .git_ignore(true) // Respect .gitignore
            .git_global(true) // Respect global gitignore
            .git_exclude(true) // Respect .git/info/exclude
            .require_git(false) // Don't require being in a git repo
            .build();

        let mut paths: Vec<PathBuf> = Vec::new();
        for entry in walker.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            // Get relative path for matching
            let relative = path.strip_prefix(&base_dir).unwrap_or(path);
            let relative_str = relative.to_string_lossy();
            // Match against the glob pattern
            if glob_matcher.matches(&relative_str) || glob_matcher.matches_path(relative) {
                paths.push(path.to_path_buf());
            }
        }

        if paths.is_empty() {
            return Ok(CallToolResult::success(vec![Content::text(
                "No files found matching pattern".to_string(),
            )]));
        }

        let relative_paths: Vec<String> = paths
            .iter()
            .take(100)
            .map(|p| p.strip_prefix(&base_dir).unwrap_or(p).display().to_string())
            .collect();

        let truncated = if paths.len() > 100 {
            format!("\n... and {} more files", paths.len() - 100)
        } else {
            String::new()
        };

        Ok(CallToolResult::success(vec![Content::text(format!(
            "Found {} files:\n{}{}",
            paths.len(),
            relative_paths.join("\n"),
            truncated
        ))]))
    }

    #[tool(
        description = "Search for a regex pattern in files within the working directory. Returns matching lines with context. Automatically respects .gitignore and skips node_modules, .git, dist, etc."
    )]
    pub async fn grep_files(
        &self,
        Parameters(args): Parameters<GrepFilesArgs>,
    ) -> Result<CallToolResult, McpError> {
        use ignore::WalkBuilder;
        use std::fs;
        use std::io::{BufRead, BufReader};

        let base_dir = match args.working_directory.as_deref() {
            Some(wd) => expand_working_directory_shortcut(wd),
            None => {
                let workflow_dir_guard = self.current_workflow_dir.lock().await;
                match &*workflow_dir_guard {
                    Some(dir) => dir.clone(),
                    None => {
                        return Ok(CallToolResult::error(vec![Content::text(
                            "Error: No working directory available. Either provide working_directory or ensure a workflow is focused.".to_string()
                        )]));
                    }
                }
            }
        };

        let pattern = match args.ignore_case.unwrap_or(false) {
            true => Regex::new(&format!("(?i){}", &args.pattern)),
            false => Regex::new(&args.pattern),
        };

        let pattern = match pattern {
            Ok(p) => p,
            Err(e) => {
                return Ok(CallToolResult::error(vec![Content::text(format!(
                    "Invalid regex pattern: {e}"
                ))]));
            }
        };

        let context_lines = args.context_lines.unwrap_or(2);
        let max_results = args.max_results.unwrap_or(50);

        // Build glob pattern for file filtering
        let file_pattern = args.glob.as_deref().unwrap_or("**/*");
        let glob_matcher = match glob::Pattern::new(file_pattern) {
            Ok(p) => p,
            Err(e) => {
                return Ok(CallToolResult::error(vec![Content::text(format!(
                    "Invalid glob pattern: {e}"
                ))]));
            }
        };

        let mut results: Vec<String> = Vec::new();
        let mut match_count = 0;

        // Use ignore::WalkBuilder which respects .gitignore and has smart defaults
        let walker = WalkBuilder::new(&base_dir)
            .hidden(true) // Skip hidden files/dirs
            .git_ignore(true) // Respect .gitignore
            .git_global(true) // Respect global gitignore
            .git_exclude(true) // Respect .git/info/exclude
            .require_git(false) // Don't require being in a git repo
            .build();

        'file_loop: for entry in walker.flatten() {
            let entry_path = entry.path();
            if !entry_path.is_file() {
                continue;
            }

            // Match against glob pattern
            let relative = entry_path.strip_prefix(&base_dir).unwrap_or(entry_path);
            let relative_str = relative.to_string_lossy();
            if !glob_matcher.matches(&relative_str) && !glob_matcher.matches_path(relative) {
                continue;
            }

            // Skip binary files
            if let Some(ext) = entry_path.extension() {
                let ext = ext.to_string_lossy().to_lowercase();
                if matches!(
                    ext.as_str(),
                    "exe"
                        | "dll"
                        | "so"
                        | "dylib"
                        | "png"
                        | "jpg"
                        | "jpeg"
                        | "gif"
                        | "ico"
                        | "woff"
                        | "woff2"
                        | "ttf"
                        | "eot"
                        | "pdf"
                        | "zip"
                        | "tar"
                        | "gz"
                ) {
                    continue;
                }
            }

            let file = match fs::File::open(entry_path) {
                Ok(f) => f,
                Err(_) => continue,
            };

            let reader = BufReader::new(file);
            let lines: Vec<String> = reader.lines().map_while(Result::ok).collect();

            for (line_num, line) in lines.iter().enumerate() {
                if pattern.is_match(line) {
                    match_count += 1;
                    if match_count > max_results {
                        results.push(format!(
                            "\n... (truncated, {} more matches)",
                            match_count - max_results
                        ));
                        break 'file_loop;
                    }

                    let rel_path = entry_path
                        .strip_prefix(&base_dir)
                        .unwrap_or(entry_path)
                        .display();

                    // Add context
                    let start = line_num.saturating_sub(context_lines);
                    let end = (line_num + context_lines + 1).min(lines.len());

                    results.push(format!("\n--- {}:{} ---", rel_path, line_num + 1));
                    for (i, line) in lines.iter().enumerate().skip(start).take(end - start) {
                        let marker = if i == line_num { ">" } else { " " };
                        results.push(format!("{}{:4}: {}", marker, i + 1, line));
                    }
                }
            }
        }

        if results.is_empty() {
            Ok(CallToolResult::success(vec![Content::text(format!(
                "No matches found for pattern '{}' in {}",
                args.pattern, file_pattern
            ))]))
        } else {
            Ok(CallToolResult::success(vec![Content::text(format!(
                "Found {} matches:\n{}",
                match_count.min(max_results),
                results.join("\n")
            ))]))
        }
    }

    #[tool(
        description = "Type-check a TypeScript workflow using tsc --noEmit. Returns structured error information including file, line, column, error code, and message for each type error found."
    )]
    pub async fn typecheck_workflow(
        &self,
        Parameters(args): Parameters<crate::tools::typecheck::TypecheckWorkflowArgs>,
    ) -> Result<CallToolResult, McpError> {
        use crate::tools::typecheck;

        let mut span = StepSpan::new("typecheck_workflow", None);
        span.set_attribute("workflow_path", args.workflow_path.clone());

        match typecheck::typecheck_workflow(&args.workflow_path).await {
            Ok(result) => {
                span.set_status(result.success, None);
                span.end();
                Ok(CallToolResult::success(vec![Content::json(result)?]))
            }
            Err(e) => {
                span.set_status(false, Some(&e));
                span.end();
                Ok(CallToolResult::error(vec![Content::text(e)]))
            }
        }
    }
}

/// Get the path to the computeruse source directory
fn get_computeruse_source_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        std::env::var("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                dirs::home_dir()
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join("AppData")
                    .join("Local")
            })
            .join("mediar")
            .join("computeruse-source")
    }

    #[cfg(target_os = "macos")]
    {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Library")
            .join("Application Support")
            .join("mediar")
            .join("computeruse-source")
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        std::env::var("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                dirs::home_dir()
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join(".local")
                    .join("share")
            })
            .join("mediar")
            .join("computeruse-source")
    }
}

/// Get the path to the workflows directory
fn get_workflows_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        std::env::var("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                dirs::home_dir()
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join("AppData")
                    .join("Local")
            })
            .join("mediar")
            .join("workflows")
    }

    #[cfg(target_os = "macos")]
    {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Library")
            .join("Application Support")
            .join("mediar")
            .join("workflows")
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        std::env::var("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                dirs::home_dir()
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join(".local")
                    .join("share")
            })
            .join("mediar")
            .join("workflows")
    }
}

/// Expand working_directory shortcuts to full paths
/// Supports: "executions", "logs", "workflows", "computeruse-source"
fn expand_working_directory_shortcut(wd: &str) -> PathBuf {
    match wd {
        "executions" => execution_logger::get_executions_dir(),
        "logs" => execution_logger::get_logs_dir(),
        "workflows" => get_workflows_dir(),
        "computeruse-source" => get_computeruse_source_dir(),
        _ => PathBuf::from(wd),
    }
}

/// Check if computeruse source needs to be downloaded/updated
pub fn check_computeruse_source() {
    let source_dir = get_computeruse_source_dir();
    let marker_file = source_dir.join(".computeruse-source-meta.json");

    let needs_update = if !source_dir.exists() || !marker_file.exists() {
        true
    } else {
        // Check if older than 24 hours
        match std::fs::read_to_string(&marker_file) {
            Ok(content) => {
                if let Ok(meta) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(updated) = meta.get("updated").and_then(|v| v.as_str()) {
                        if let Ok(updated_time) = chrono::DateTime::parse_from_rfc3339(updated) {
                            let hours_since = (chrono::Utc::now()
                                - updated_time.with_timezone(&chrono::Utc))
                            .num_hours();
                            hours_since > 24
                        } else {
                            true
                        }
                    } else {
                        true
                    }
                } else {
                    true
                }
            }
            Err(_) => true,
        }
    };

    if needs_update {
        info!("[computeruse-source] Source needs update, triggering download...");
        // Run the download script asynchronously in background
        std::thread::spawn(|| {
            download_computeruse_source();
        });
    } else {
        info!("[computeruse-source] Source is up to date");
    }
}

/// Download computeruse source from GitHub releases
fn download_computeruse_source() {
    use std::process::Command;

    // Try to find the download script
    // First check if we're in a development environment
    let script_paths = [
        // npm package location
        std::env::current_exe().ok().and_then(|p| {
            p.parent()
                .map(|p| p.join("scripts").join("download-source.js"))
        }),
        // Development location
        Some(PathBuf::from("scripts/download-source.js")),
    ];

    for path_opt in script_paths.iter().flatten() {
        if path_opt.exists() {
            info!(
                "[computeruse-source] Running download script: {}",
                path_opt.display()
            );
            match Command::new("node").arg(path_opt).output() {
                Ok(output) => {
                    if !output.status.success() {
                        warn!(
                            "[computeruse-source] Download script failed: {}",
                            String::from_utf8_lossy(&output.stderr)
                        );
                    } else {
                        info!(
                            "[computeruse-source] Download completed: {}",
                            String::from_utf8_lossy(&output.stderr)
                        );
                    }
                }
                Err(e) => {
                    warn!("[computeruse-source] Failed to run download script: {}", e);
                }
            }
            return;
        }
    }

    // Fallback: download directly using reqwest (blocking)
    info!("[computeruse-source] Download script not found, using direct download...");
    if let Err(e) = download_computeruse_source_direct() {
        warn!("[computeruse-source] Direct download failed: {}", e);
    }
}

/// Direct download without Node.js dependency
fn download_computeruse_source_direct() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use std::fs;
    use std::io::Write;

    let source_dir = get_computeruse_source_dir();
    let mediar_dir = source_dir.parent().unwrap();

    // Create mediar directory if needed
    fs::create_dir_all(mediar_dir)?;

    // Get latest release info
    let client = reqwest::blocking::Client::builder()
        .user_agent("computeruse-mcp-agent")
        .build()?;

    let release: serde_json::Value = client
        .get("https://api.github.com/repos/mediar-ai/computeruse/releases/latest")
        .send()?
        .json()?;

    let tag = release["tag_name"]
        .as_str()
        .ok_or("No tag_name in release")?;
    let zip_url = release["zipball_url"]
        .as_str()
        .ok_or("No zipball_url in release")?;

    info!("[computeruse-source] Downloading {} from {}", tag, zip_url);

    // Download zip
    let zip_path = mediar_dir.join("computeruse-source.zip");
    let response = client.get(zip_url).send()?;
    let bytes = response.bytes()?;
    fs::write(&zip_path, &bytes)?;

    // Extract zip
    let temp_dir = mediar_dir.join("computeruse-source-temp");
    if temp_dir.exists() {
        fs::remove_dir_all(&temp_dir)?;
    }
    fs::create_dir_all(&temp_dir)?;

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("powershell")
            .args([
                "-Command",
                &format!(
                    "Expand-Archive -Path '{}' -DestinationPath '{}' -Force",
                    zip_path.display(),
                    temp_dir.display()
                ),
            ])
            .output()?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("unzip")
            .args([
                "-q",
                &zip_path.to_string_lossy(),
                "-d",
                &temp_dir.to_string_lossy(),
            ])
            .output()?;
    }

    // Find extracted folder
    let extracted = fs::read_dir(&temp_dir)?
        .filter_map(|e| e.ok())
        .find(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("mediar-ai-computeruse-")
        })
        .ok_or("Could not find extracted folder")?;

    // Move to final location
    if source_dir.exists() {
        fs::remove_dir_all(&source_dir)?;
    }
    fs::rename(extracted.path(), &source_dir)?;

    // Cleanup
    fs::remove_dir_all(&temp_dir)?;
    fs::remove_file(&zip_path)?;

    // Write metadata
    let marker_file = source_dir.join(".computeruse-source-meta.json");
    let meta = serde_json::json!({
        "tag": tag,
        "updated": chrono::Utc::now().to_rfc3339(),
        "source": "github-release"
    });
    let mut file = fs::File::create(&marker_file)?;
    file.write_all(serde_json::to_string_pretty(&meta)?.as_bytes())?;

    info!(
        "[computeruse-source] Installed {} to {}",
        tag,
        source_dir.display()
    );
    Ok(())
}

impl DesktopWrapper {
    pub(crate) async fn dispatch_tool(
        &self,
        peer: Peer<RoleServer>,
        request_context: RequestContext<RoleServer>,
        tool_name: &str,
        arguments: &serde_json::Value,
        execution_context: Option<crate::utils::ToolExecutionContext>,
    ) -> Result<CallToolResult, McpError> {
        use rmcp::handler::server::wrapper::Parameters;

        // Check if request is already cancelled before dispatching
        if request_context.ct.is_cancelled() {
            return Err(McpError::internal_error(
                format!("Tool {tool_name} cancelled before execution"),
                Some(json!({"code": -32001, "tool": tool_name})),
            ));
        }

        // Window management for UI interaction tools
        // Check if tool has a 'process' argument - if so, it needs window management
        // No whitelist - any tool with a process argument gets window management
        let process_name = arguments
            .get("process")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        // Extract window management options from arguments (defaults to enabled)
        let window_mgmt_opts: crate::utils::WindowManagementOptions =
            serde_json::from_value(arguments.clone()).unwrap_or_default();

        // FOCUS RESTORATION: Save focus state BEFORE any window operations if restore_focus is requested
        // Window management (bring_to_front, SetForegroundWindow) steals focus, so we must save first
        // Default: false only for click-like tools (user wants focus on clicked element), true for everything else
        #[cfg(target_os = "windows")]
        let restore_focus_default = !matches!(
            tool_name,
            "click_element" | "invoke_element" | "hover_element"
        );
        #[cfg(target_os = "windows")]
        let saved_focus = if window_mgmt_opts
            .restore_focus
            .unwrap_or(restore_focus_default)
        {
            tracing::debug!(
                "[FOCUS_RESTORE] dispatch_tool: saving focus state BEFORE window management (tool={}, default={})",
                tool_name,
                restore_focus_default
            );
            computeruse::platforms::windows::save_focus_state()
        } else {
            tracing::debug!(
                "[FOCUS_RESTORE] dispatch_tool: skipping focus save (tool={}, default={})",
                tool_name,
                restore_focus_default
            );
            None
        };
        #[cfg(not(target_os = "windows"))]
        let saved_focus: Option<()> = None;

        // Perform window management if needed
        if let Some(ref process) = process_name {
            let _ = self
                .prepare_window_management(
                    process,
                    execution_context.as_ref(),
                    None,
                    None,
                    &window_mgmt_opts,
                )
                .await;

            // Small delay to let window operations settle
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }

        // Set in_sequence flag to prevent individual tools from doing their own window management
        // dispatch_tool handles window management centrally
        {
            let mut in_seq = self.in_sequence.lock().unwrap_or_else(|e| e.into_inner());
            *in_seq = true;
        }

        // Start execution logging - capture request before tool dispatch
        let start_time = std::time::Instant::now();
        let (workflow_id, step_id, step_index) = execution_context
            .as_ref()
            .map(|ctx| {
                (
                    ctx.workflow_id.clone(),
                    ctx.step_id.clone(),
                    Some(ctx.current_step),
                )
            })
            .unwrap_or((None, None, None));
        let log_ctx = execution_logger::log_request(
            tool_name,
            arguments,
            workflow_id.as_deref(),
            step_id.as_deref(),
            step_index,
        );

        // Start capturing tracing logs for this tool execution
        if let Some(ref log_capture) = self.log_capture {
            log_capture.start_capture();
        }

        // Wrap each tool call with cancellation support
        let result = match tool_name {
            "get_window_tree" => {
                match serde_json::from_value::<GetWindowTreeArgs>(arguments.clone()) {
                    Ok(args) => {
                        // Use tokio::select with the cancellation token from request_context
                        tokio::select! {
                            result = self.get_window_tree(Parameters(args)) => result,
                            _ = request_context.ct.cancelled() => {
                                Err(McpError::internal_error(
                                    format!("{tool_name} cancelled"),
                                    Some(json!({"code": -32001, "tool": tool_name}))
                                ))
                            }
                        }
                    }
                    Err(e) => Err(McpError::invalid_params(
                        "Invalid arguments for get_window_tree",
                        Some(json!({"error": e.to_string()})),
                    )),
                }
            }
            "get_applications_and_windows_list" => {
                match serde_json::from_value::<GetApplicationsArgs>(arguments.clone()) {
                    Ok(args) => {
                        tokio::select! {
                            result = self.get_applications_and_windows_list(Parameters(args)) => result,
                            _ = request_context.ct.cancelled() => {
                                Err(McpError::internal_error(
                                    format!("{tool_name} cancelled"),
                                    Some(json!({"code": -32001, "tool": tool_name}))
                                ))
                            }
                        }
                    }
                    Err(e) => Err(McpError::invalid_params(
                        "Invalid arguments for get_applications_and_windows_list",
                        Some(json!({"error": e.to_string()})),
                    )),
                }
            }
            "click_element" => {
                match serde_json::from_value::<ClickElementArgs>(arguments.clone()) {
                    Ok(args) => {
                        tokio::select! {
                            result = self.click_element(Parameters(args)) => result,
                            _ = request_context.ct.cancelled() => {
                                Err(McpError::internal_error(
                                    format!("{tool_name} cancelled"),
                                    Some(json!({"code": -32001, "tool": tool_name}))
                                ))
                            }
                        }
                    }
                    Err(e) => Err(McpError::invalid_params(
                        "Invalid arguments for click_element",
                        Some(json!({"error": e.to_string()})),
                    )),
                }
            }
            "type_into_element" => {
                match serde_json::from_value::<TypeIntoElementArgs>(arguments.clone()) {
                    Ok(args) => {
                        tokio::select! {
                            result = self.type_into_element(Parameters(args)) => result,
                            _ = request_context.ct.cancelled() => {
                                Err(McpError::internal_error(
                                    format!("{tool_name} cancelled"),
                                    Some(json!({"code": -32001, "tool": tool_name}))
                                ))
                            }
                        }
                    }
                    Err(e) => Err(McpError::invalid_params(
                        "Invalid arguments for type_into_element",
                        Some(json!({"error": e.to_string()})),
                    )),
                }
            }
            "press_key" => match serde_json::from_value::<PressKeyArgs>(arguments.clone()) {
                Ok(args) => {
                    tokio::select! {
                        result = self.press_key(Parameters(args)) => result,
                        _ = request_context.ct.cancelled() => {
                            Err(McpError::internal_error(
                                format!("{tool_name} cancelled"),
                                Some(json!({"code": -32001, "tool": tool_name}))
                            ))
                        }
                    }
                }
                Err(e) => Err(McpError::invalid_params(
                    "Invalid arguments for press_key",
                    Some(json!({"error": e.to_string()})),
                )),
            },
            "press_key_global" => {
                match serde_json::from_value::<GlobalKeyArgs>(arguments.clone()) {
                    Ok(args) => self.press_key_global(Parameters(args)).await,
                    Err(e) => Err(McpError::invalid_params(
                        "Invalid arguments for press_key_global",
                        Some(json!({"error": e.to_string()})),
                    )),
                }
            }
            "validate_element" => {
                match serde_json::from_value::<ValidateElementArgs>(arguments.clone()) {
                    Ok(args) => self.validate_element(Parameters(args)).await,
                    Err(e) => Err(McpError::invalid_params(
                        "Invalid arguments for validate_element",
                        Some(json!({"error": e.to_string()})),
                    )),
                }
            }
            "wait_for_element" => {
                match serde_json::from_value::<WaitForElementArgs>(arguments.clone()) {
                    Ok(args) => {
                        tokio::select! {
                            result = self.wait_for_element(Parameters(args)) => result,
                            _ = request_context.ct.cancelled() => {
                                Err(McpError::internal_error(
                                    format!("{tool_name} cancelled"),
                                    Some(json!({"code": -32001, "tool": tool_name}))
                                ))
                            }
                        }
                    }
                    Err(e) => Err(McpError::invalid_params(
                        "Invalid arguments for wait_for_element",
                        Some(json!({"error": e.to_string()})),
                    )),
                }
            }

            "activate_element" => {
                match serde_json::from_value::<ActivateElementArgs>(arguments.clone()) {
                    Ok(args) => self.activate_element(Parameters(args)).await,
                    Err(e) => Err(McpError::invalid_params(
                        "Invalid arguments for activate_element",
                        Some(json!({"error": e.to_string()})),
                    )),
                }
            }
            "navigate_browser" => {
                match serde_json::from_value::<NavigateBrowserArgs>(arguments.clone()) {
                    Ok(args) => {
                        tokio::select! {
                            result = self.navigate_browser(Parameters(args)) => result,
                            _ = request_context.ct.cancelled() => {
                                Err(McpError::internal_error(
                                    format!("{tool_name} cancelled"),
                                    Some(json!({"code": -32001, "tool": tool_name}))
                                ))
                            }
                        }
                    }
                    Err(e) => Err(McpError::invalid_params(
                        "Invalid arguments for navigate_browser",
                        Some(json!({"error": e.to_string()})),
                    )),
                }
            }
            "execute_browser_script" => {
                match serde_json::from_value::<ExecuteBrowserScriptArgs>(arguments.clone()) {
                    Ok(args) => self.execute_browser_script(Parameters(args)).await,
                    Err(e) => Err(McpError::invalid_params(
                        "Invalid arguments for execute_browser_script",
                        Some(json!({"error": e.to_string()})),
                    )),
                }
            }
            "open_application" => {
                match serde_json::from_value::<OpenApplicationArgs>(arguments.clone()) {
                    Ok(args) => self.open_application(Parameters(args)).await,
                    Err(e) => Err(McpError::invalid_params(
                        "Invalid arguments for open_application",
                        Some(json!({"error": e.to_string()})),
                    )),
                }
            }
            "scroll_element" => {
                match serde_json::from_value::<ScrollElementArgs>(arguments.clone()) {
                    Ok(args) => self.scroll_element(Parameters(args)).await,
                    Err(e) => Err(McpError::invalid_params(
                        "Invalid arguments for scroll_element",
                        Some(json!({"error": e.to_string()})),
                    )),
                }
            }
            "delay" => match serde_json::from_value::<DelayArgs>(arguments.clone()) {
                Ok(args) => self.delay(Parameters(args)).await,
                Err(e) => Err(McpError::invalid_params(
                    "Invalid arguments for delay",
                    Some(json!({"error": e.to_string()})),
                )),
            },
            "run_command" => match serde_json::from_value::<RunCommandArgs>(arguments.clone()) {
                Ok(args) => {
                    // Create a child cancellation token from the request context
                    let cancellation_token = tokio_util::sync::CancellationToken::new();
                    let child_token = cancellation_token.child_token();

                    // Link it to the request context cancellation
                    let ct_for_task = request_context.ct.clone();
                    tokio::spawn(
                        async move {
                            ct_for_task.cancelled().await;
                            cancellation_token.cancel();
                        }
                        .in_current_span(),
                    );

                    self.run_command_impl(
                        args,
                        Some(child_token),
                        Some(request_context.peer.clone()),
                    )
                    .await
                }
                Err(e) => Err(McpError::invalid_params(
                    "Invalid arguments for run_command",
                    Some(json!({"error": e.to_string()})),
                )),
            },
            "mouse_drag" => match serde_json::from_value::<MouseDragArgs>(arguments.clone()) {
                Ok(args) => self.mouse_drag(Parameters(args)).await,
                Err(e) => Err(McpError::invalid_params(
                    "Invalid arguments for mouse_drag",
                    Some(json!({"error": e.to_string()})),
                )),
            },
            "highlight_element" => {
                match serde_json::from_value::<HighlightElementArgs>(arguments.clone()) {
                    Ok(args) => self.highlight_element(Parameters(args)).await,
                    Err(e) => Err(McpError::invalid_params(
                        "Invalid arguments for highlight_element",
                        Some(json!({"error": e.to_string()})),
                    )),
                }
            }
            "select_option" => {
                match serde_json::from_value::<SelectOptionArgs>(arguments.clone()) {
                    Ok(args) => self.select_option(Parameters(args)).await,
                    Err(e) => Err(McpError::invalid_params(
                        "Invalid arguments for select_option",
                        Some(json!({"error": e.to_string()})),
                    )),
                }
            }
            "set_selected" => match serde_json::from_value::<SetSelectedArgs>(arguments.clone()) {
                Ok(args) => self.set_selected(Parameters(args)).await,
                Err(e) => Err(McpError::invalid_params(
                    "Invalid arguments for set_selected",
                    Some(json!({"error": e.to_string()})),
                )),
            },
            "capture_screenshot" | "capture_element_screenshot" => {
                match serde_json::from_value::<CaptureScreenshotArgs>(arguments.clone()) {
                    Ok(args) => self.capture_screenshot(Parameters(args)).await,
                    Err(e) => Err(McpError::invalid_params(
                        "Invalid arguments for capture_screenshot",
                        Some(json!({"error": e.to_string()})),
                    )),
                }
            }
            "invoke_element" => {
                match serde_json::from_value::<InvokeElementArgs>(arguments.clone()) {
                    Ok(args) => self.invoke_element(Parameters(args)).await,
                    Err(e) => Err(McpError::invalid_params(
                        "Invalid arguments for invoke_element",
                        Some(json!({"error": e.to_string()})),
                    )),
                }
            }
            "set_value" => match serde_json::from_value::<SetValueArgs>(arguments.clone()) {
                Ok(args) => self.set_value(Parameters(args)).await,
                Err(e) => Err(McpError::invalid_params(
                    "Invalid arguments for set_value",
                    Some(json!({ "error": e.to_string() })),
                )),
            },
            // run_javascript is deprecated and merged into run_command with engine
            "execute_sequence" => {
                // Handle nested execute_sequence calls by delegating to execute_sequence_impl
                // Use Box::pin to handle async recursion (dispatch_tool -> execute_sequence_impl -> ... -> dispatch_tool)
                match serde_json::from_value::<ExecuteSequenceArgs>(arguments.clone()) {
                    Ok(args) => {
                        let client_progress_token = request_context.meta.get_progress_token();
                        Box::pin(self.execute_sequence_impl(
                            peer,
                            request_context,
                            client_progress_token,
                            args,
                        ))
                        .await
                    }
                    Err(e) => Err(McpError::invalid_params(
                        "Invalid arguments for execute_sequence",
                        Some(json!({ "error": e.to_string() })),
                    )),
                }
            }
            "stop_highlighting" => {
                match serde_json::from_value::<StopHighlightingArgs>(arguments.clone()) {
                    Ok(args) => self.stop_highlighting(Parameters(args)).await,
                    Err(e) => Err(McpError::invalid_params(
                        "Invalid arguments for stop_highlighting",
                        Some(json!({"error": e.to_string()})),
                    )),
                }
            }
            "stop_execution" => {
                // No arguments needed for stop_execution
                self.stop_execution().await
            }
            "gemini_computer_use" => {
                match serde_json::from_value::<GeminiComputerUseArgs>(arguments.clone()) {
                    Ok(args) => {
                        tokio::select! {
                            result = self.gemini_computer_use(Parameters(args)) => result,
                            _ = request_context.ct.cancelled() => {
                                Err(McpError::internal_error(
                                    format!("{tool_name} cancelled"),
                                    Some(json!({"code": -32001, "tool": tool_name}))
                                ))
                            }
                        }
                    }
                    Err(e) => Err(McpError::invalid_params(
                        "Invalid arguments for gemini_computer_use",
                        Some(json!({"error": e.to_string()})),
                    )),
                }
            }
            "read_file" => match serde_json::from_value::<ReadFileArgs>(arguments.clone()) {
                Ok(args) => self.read_file(Parameters(args)).await,
                Err(e) => Err(McpError::invalid_params(
                    "Invalid arguments for read_file",
                    Some(json!({"error": e.to_string()})),
                )),
            },
            "write_file" => match serde_json::from_value::<WriteFileArgs>(arguments.clone()) {
                Ok(args) => self.write_file(Parameters(args)).await,
                Err(e) => Err(McpError::invalid_params(
                    "Invalid arguments for write_file",
                    Some(json!({"error": e.to_string()})),
                )),
            },
            "edit_file" => match serde_json::from_value::<EditFileArgs>(arguments.clone()) {
                Ok(args) => self.edit_file(Parameters(args)).await,
                Err(e) => Err(McpError::invalid_params(
                    "Invalid arguments for edit_file",
                    Some(json!({"error": e.to_string()})),
                )),
            },
            "copy_content" => match serde_json::from_value::<CopyContentArgs>(arguments.clone()) {
                Ok(args) => self.copy_content(Parameters(args)).await,
                Err(e) => Err(McpError::invalid_params(
                    "Invalid arguments for copy_content",
                    Some(json!({"error": e.to_string()})),
                )),
            },
            "glob_files" => match serde_json::from_value::<GlobFilesArgs>(arguments.clone()) {
                Ok(args) => self.glob_files(Parameters(args)).await,
                Err(e) => Err(McpError::invalid_params(
                    "Invalid arguments for glob_files",
                    Some(json!({"error": e.to_string()})),
                )),
            },
            "grep_files" => match serde_json::from_value::<GrepFilesArgs>(arguments.clone()) {
                Ok(args) => self.grep_files(Parameters(args)).await,
                Err(e) => Err(McpError::invalid_params(
                    "Invalid arguments for grep_files",
                    Some(json!({"error": e.to_string()})),
                )),
            },
            _ => Err(McpError::internal_error(
                "Unknown tool called",
                Some(json!({"tool_name": tool_name})),
            )),
        };

        // Stop log capture and collect all logs (tracing + stderr)
        let mut all_logs: Vec<execution_logger::CapturedLogEntry> = Vec::new();

        // Get tracing logs
        if let Some(ref log_capture) = self.log_capture {
            let tracing_logs = log_capture.stop_capture();
            for log in tracing_logs {
                all_logs.push(execution_logger::CapturedLogEntry {
                    timestamp: log.timestamp,
                    level: log.level,
                    message: log.message,
                });
            }
        }

        // Get stderr logs from TypeScript workflow execution
        if let Ok(mut stderr_logs) = self.captured_stderr_logs.lock() {
            all_logs.extend(stderr_logs.drain(..));
        }

        // Extract logs from run_command/execute_sequence result (logs are embedded in the JSON result)
        if tool_name == "run_command" || tool_name == "execute_sequence" {
            if let Ok(ref call_result) = result {
                for content in &call_result.content {
                    if let Some(text) = crate::server::extract_content_text(content) {
                        if let Ok(json_val) = serde_json::from_str::<serde_json::Value>(&text) {
                            let now = chrono::Utc::now();
                            // Extract "logs" array (stdout logs)
                            if let Some(logs_array) =
                                json_val.get("logs").and_then(|v| v.as_array())
                            {
                                for (i, log) in logs_array.iter().enumerate() {
                                    if let Some(msg) = log.as_str() {
                                        all_logs.push(execution_logger::CapturedLogEntry {
                                            timestamp: now
                                                + chrono::Duration::microseconds(i as i64),
                                            level: "INFO".to_string(),
                                            message: msg.to_string(),
                                        });
                                    }
                                }
                            }
                            // Extract "stderr" array (error/warn logs)
                            if let Some(stderr_array) =
                                json_val.get("stderr").and_then(|v| v.as_array())
                            {
                                for (i, log) in stderr_array.iter().enumerate() {
                                    if let Some(msg) = log.as_str() {
                                        // Determine log level based on content
                                        let level = if msg.to_lowercase().contains("error") {
                                            "ERROR"
                                        } else if msg.to_lowercase().contains("warn") {
                                            "WARN"
                                        } else {
                                            "ERROR" // stderr defaults to ERROR
                                        };
                                        all_logs.push(execution_logger::CapturedLogEntry {
                                            timestamp: now
                                                + chrono::Duration::microseconds((1000 + i) as i64),
                                            level: level.to_string(),
                                            message: msg.to_string(),
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // Sort logs by timestamp
        all_logs.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));

        // Extract logs from error data (for TypeScript workflow errors)
        // The logs are embedded in error_data["logs"] when workflow fails
        if let Err(ref e) = result {
            if let Some(ref data) = e.data {
                let now = chrono::Utc::now();
                if let Some(logs_array) = data.get("logs").and_then(|v| v.as_array()) {
                    tracing::debug!(
                        "[call_tool] Extracting {} logs from error data for tool: {}",
                        logs_array.len(),
                        tool_name
                    );
                    for (i, log) in logs_array.iter().enumerate() {
                        // Logs are structured as {timestamp, level, message}
                        let level = log
                            .get("level")
                            .and_then(|v| v.as_str())
                            .unwrap_or("INFO")
                            .to_string();
                        let message = log
                            .get("message")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        if !message.is_empty() {
                            all_logs.push(execution_logger::CapturedLogEntry {
                                timestamp: now + chrono::Duration::microseconds(i as i64),
                                level,
                                message,
                            });
                        }
                    }
                }
            }
        }

        // Log execution response with duration, result, and captured logs
        if let Some(ctx) = log_ctx {
            let duration_ms = start_time.elapsed().as_millis() as u64;
            let logs_option = if all_logs.is_empty() {
                None
            } else {
                Some(all_logs)
            };
            match &result {
                Ok(call_result) => {
                    // Extract JSON from ALL CallToolResult content items (to capture screenshots)
                    let result_json = if !call_result.content.is_empty() {
                        let content_array: Vec<serde_json::Value> = call_result
                            .content
                            .iter()
                            .filter_map(|c| crate::server::extract_content_json(c).ok())
                            .collect();
                        Some(json!({ "content": content_array }))
                    } else {
                        None
                    };
                    if let Some(json_value) = result_json {
                        execution_logger::log_response_with_logs(
                            ctx,
                            Ok(&json_value),
                            duration_ms,
                            logs_option,
                        );
                    }
                }
                Err(e) => {
                    let error_msg = serde_json::to_string(&e).unwrap_or_else(|_| e.to_string());
                    execution_logger::log_response_with_logs(
                        ctx,
                        Err(&error_msg),
                        duration_ms,
                        logs_option,
                    );
                }
            }
        }

        // Reset in_sequence flag after tool execution
        {
            let mut in_seq = self.in_sequence.lock().unwrap_or_else(|e| e.into_inner());
            *in_seq = false;
        }

        // Restore windows appropriately based on execution context
        match execution_context {
            None => {
                // Single tool execution: always restore if window management was performed
                if process_name.is_some() {
                    if let Err(e) = self.window_manager.restore_all_windows().await {
                        tracing::warn!("Failed to restore windows: {}", e);
                    }
                    // Clear captured state after restoration
                    self.window_manager.clear_captured_state().await;
                    tracing::info!("Restored all windows to original state (single tool)");
                }
            }
            Some(ref ctx) => {
                // Sequence execution: only restore on last step
                if ctx.is_last_step && process_name.is_some() {
                    if let Err(e) = self.window_manager.restore_all_windows().await {
                        tracing::warn!("Failed to restore windows: {}", e);
                    }
                    // Clear captured state after restoration
                    self.window_manager.clear_captured_state().await;
                    tracing::info!("Restored all windows to original state (sequence last step)");
                }
            }
        }

        // FOCUS RESTORATION: Restore focus state after tool execution if we saved it
        #[cfg(target_os = "windows")]
        if let Some(state) = saved_focus {
            tracing::debug!(
                "[FOCUS_RESTORE] dispatch_tool: restoring focus state after tool execution"
            );
            computeruse::platforms::windows::restore_focus_state(state);
        }

        result
    }
}

// Manual implementation instead of #[tool_handler] to add execution logging
impl ServerHandler for DesktopWrapper {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            protocol_version: ProtocolVersion::LATEST,
            capabilities: ServerCapabilities::builder().enable_tools().build(),
            server_info: Implementation::from_build_env(),
            instructions: Some(crate::prompt::get_server_instructions().to_string()),
        }
    }

    async fn call_tool(
        &self,
        request: rmcp::model::CallToolRequestParam,
        context: rmcp::service::RequestContext<rmcp::RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        use rmcp::handler::server::tool::ToolCallContext;

        // Extract tool name and arguments for logging
        let tool_name = request.name.to_string();
        let arguments = request
            .arguments
            .as_ref()
            .map(|a| serde_json::Value::Object(a.clone()))
            .unwrap_or(serde_json::Value::Null);

        // Check if tool is blocked for this specific client (per-client mode)
        // Only "claude-code" clients have mode enforced; "mediar-app" (UI) is never blocked
        {
            // Get client name from peer info
            let client_name = context
                .peer
                .peer_info()
                .map(|info| info.client_info.name.to_string())
                .unwrap_or_default();

            let modes_guard = self.client_modes.lock().await;
            if let Some(client_state) = modes_guard.get(&client_name) {
                if client_state.mode == "ask" && client_state.blocked_tools.contains(&tool_name) {
                    tracing::info!(
                        "[call_tool] Blocked tool '{}' for client '{}' in Ask mode",
                        tool_name,
                        client_name
                    );
                    return Err(McpError::invalid_request(
                        format!(
                            "Tool '{}' is blocked in Ask mode. Ask user to switch to Act mode to execute this action.",
                            tool_name
                        ),
                        Some(serde_json::json!({
                            "code": -32002,
                            "tool": tool_name,
                            "mode": "ask",
                            "client": client_name,
                            "action": "switch_to_act_mode"
                        })),
                    ));
                }
            }
            // If no mode is set for this client (e.g., "mediar-app"), allow all tools
        }

        // Reset cancellation state before starting a new tool call (except for stop_execution itself)
        // This clears any previous stop_execution() so new operations can run
        if tool_name != "stop_execution" {
            self.desktop.reset_cancellation();
        }

        // Log request before execution - extract workflow context from execute_sequence args
        let (wf_id, step_id) = if tool_name == "execute_sequence" {
            (
                arguments.get("workflow_id").and_then(|v| v.as_str()),
                arguments.get("start_from_step").and_then(|v| v.as_str()),
            )
        } else {
            (None, None)
        };
        tracing::debug!(
            "[call_tool] Logging with workflow_id={:?}, step_id={:?}",
            wf_id,
            step_id
        );
        let log_ctx = execution_logger::log_request(&tool_name, &arguments, wf_id, step_id, None);
        let start_time = std::time::Instant::now();

        // FOCUS RESTORATION: Extract restore_focus from arguments and save focus state BEFORE tool execution
        // Each tool's window management (bring_to_front, activate_window) steals focus
        // Default: false only for click-like tools (user wants focus on clicked element), true for everything else
        let window_mgmt_opts: crate::utils::WindowManagementOptions =
            serde_json::from_value(arguments.clone()).unwrap_or_default();

        #[cfg(target_os = "windows")]
        let restore_focus_default = !matches!(
            tool_name.as_str(),
            "click_element" | "invoke_element" | "hover_element"
        );
        #[cfg(target_os = "windows")]
        let saved_focus = if window_mgmt_opts
            .restore_focus
            .unwrap_or(restore_focus_default)
        {
            tracing::debug!(
                "[FOCUS_RESTORE] call_tool: saving focus state BEFORE tool execution (tool={}, default={})",
                tool_name,
                restore_focus_default
            );
            computeruse::platforms::windows::save_focus_state()
        } else {
            tracing::debug!(
                "[FOCUS_RESTORE] call_tool: skipping focus save (tool={}, default={})",
                tool_name,
                restore_focus_default
            );
            None
        };
        #[cfg(not(target_os = "windows"))]
        let saved_focus: Option<()> = None;

        // Execute the tool via router
        let tcc = ToolCallContext::new(self, request, context);
        let result = self.tool_router.call(tcc).await;

        // FOCUS RESTORATION: Restore focus state after tool execution if we saved it
        #[cfg(target_os = "windows")]
        if let Some(state) = saved_focus {
            tracing::debug!(
                "[FOCUS_RESTORE] call_tool: restoring focus state after tool execution"
            );
            computeruse::platforms::windows::restore_focus_state(state);
        }

        // Get stderr logs from TypeScript workflow execution (if any)
        let stderr_logs: Vec<execution_logger::CapturedLogEntry> =
            if let Ok(mut logs) = self.captured_stderr_logs.lock() {
                logs.drain(..).collect()
            } else {
                Vec::new()
            };
        let logs_option = if stderr_logs.is_empty() {
            None
        } else {
            Some(stderr_logs)
        };

        // Log response after execution
        if let Some(ctx) = log_ctx {
            let duration_ms = start_time.elapsed().as_millis() as u64;
            match &result {
                Ok(call_result) => {
                    // Convert content to JSON Value for logging
                    // The execution_logger::extract_and_save_screenshots expects an array of content items
                    let content_value = serde_json::to_value(&call_result.content)
                        .unwrap_or(serde_json::Value::Null);
                    execution_logger::log_response_with_logs(
                        ctx,
                        Ok(&content_value),
                        duration_ms,
                        logs_option,
                    );
                }
                Err(e) => {
                    // Serialize error as JSON instead of Debug format
                    let error_msg =
                        serde_json::to_string(&e).unwrap_or_else(|_| format!("{:?}", e));
                    execution_logger::log_response_with_logs(
                        ctx,
                        Err(&error_msg),
                        duration_ms,
                        logs_option,
                    );
                }
            }
        }

        result
    }

    async fn list_tools(
        &self,
        _request: Option<rmcp::model::PaginatedRequestParam>,
        context: rmcp::service::RequestContext<rmcp::RoleServer>,
    ) -> Result<rmcp::model::ListToolsResult, McpError> {
        let all_tools = self.tool_router.list_all();

        // Get client name to check if tools should be filtered
        let client_name = context
            .peer
            .peer_info()
            .map(|info| info.client_info.name.to_string())
            .unwrap_or_default();

        // Check if this client has blocked tools (mode filtering)
        let modes_guard = self.client_modes.lock().await;
        if let Some(client_state) = modes_guard.get(&client_name) {
            if !client_state.blocked_tools.is_empty() {
                // Filter out blocked tools from the list
                let filtered_tools: Vec<_> = all_tools
                    .into_iter()
                    .filter(|tool| !client_state.blocked_tools.contains(&tool.name.to_string()))
                    .collect();
                tracing::debug!(
                    "[list_tools] Filtered {} tools for client '{}' in {} mode (blocked: {})",
                    filtered_tools.len(),
                    client_name,
                    client_state.mode,
                    client_state.blocked_tools.len()
                );
                return Ok(rmcp::model::ListToolsResult::with_all_items(filtered_tools));
            }
        }
        drop(modes_guard);

        Ok(rmcp::model::ListToolsResult::with_all_items(all_tools))
    }

    /// Called after a client completes initialization
    /// We check if this client supports elicitation and store the peer if so
    async fn on_initialized(&self, context: NotificationContext<RoleServer>) {
        let peer = context.peer;
        let supports = peer.supports_elicitation();

        // Log client info to identify different clients (claude-code vs mediar-app)
        if let Some(info) = peer.peer_info() {
            tracing::info!(
                "[on_initialized] Client: name='{}', version='{}', supports_elicitation={}",
                info.client_info.name,
                info.client_info.version,
                supports
            );
        } else {
            tracing::info!(
                "[on_initialized] Client initialized (no peer_info). supports_elicitation: {}",
                supports
            );
        }

        // Add peer to broadcast list for progress notifications
        // All connected clients will receive emit.progress() updates
        {
            let mut broadcast_guard = self.broadcast_peers.lock().await;
            broadcast_guard.push(peer.clone());
            tracing::info!(
                "[on_initialized] Added peer to broadcast list. Total peers: {}",
                broadcast_guard.len()
            );
        }

        if supports {
            tracing::info!("[on_initialized] Storing elicitation-capable peer");
            let mut guard = self.elicitation_peer.lock().await;
            *guard = Some(peer);
        }
    }
}
