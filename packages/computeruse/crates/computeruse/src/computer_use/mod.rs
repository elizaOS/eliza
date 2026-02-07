//! Desktop-dependent Computer Use functionality
//!
//! This module contains the Desktop-dependent parts of Computer Use:
//! - Window capture for screenshots
//! - Action execution that requires Desktop APIs
//! - The main `gemini_computer_use` method on Desktop
//!
//! Types and backend API are in the `computeruse-computer-use` crate.

use crate::Desktop;
use anyhow::Result;
use base64::{engine::general_purpose, Engine as _};
use chrono::Local;
use image::codecs::png::PngEncoder;
use image::imageops::FilterType;
use image::{ExtendedColorType, ImageBuffer, ImageEncoder, Rgba};
use std::fs;
use std::io::Cursor;
use std::path::PathBuf;
use std::time::Duration;
use sysinfo::{ProcessesToUpdate, System};
use computeruse_computer_use::{
    call_computer_use_backend, convert_normalized_to_screen, translate_gemini_keys,
    ComputerUseActionResponse, ComputerUsePreviousAction, ComputerUseResult, ComputerUseStep,
    ProgressCallback,
};
use tracing::{info, warn};

// ===== Internal Types =====

/// Window capture data for computer use
struct WindowCaptureData {
    /// Base64 encoded PNG screenshot
    base64_image: String,
    /// Window bounds (x, y, width, height)
    window_bounds: (f64, f64, f64, f64),
    /// DPI scale factor
    dpi_scale: f64,
    /// Resize scale factor (if image was resized)
    resize_scale: f64,
    /// Browser URL if available
    browser_url: Option<String>,
}

// ===== Screenshot Storage =====

/// Get the executions directory and ensure it exists.
/// Returns the path to %LOCALAPPDATA%/computeruse/executions/
fn get_executions_dir() -> Result<PathBuf, String> {
    let dir = dirs::data_local_dir()
        .ok_or_else(|| "Failed to get LOCALAPPDATA directory".to_string())?
        .join("computeruse")
        .join("executions");

    fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create executions directory: {}", e))?;

    Ok(dir)
}

/// Generate execution ID from timestamp and process name.
fn generate_execution_id(process: &str) -> String {
    let timestamp = Local::now().format("%Y%m%d_%H%M%S").to_string();
    let safe_process = process
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>();
    format!("{}_geminiComputerUse_{}", timestamp, safe_process)
}

/// Save a base64-encoded PNG screenshot to disk (async, non-blocking).
/// Spawns a background task so it doesn't slow down the computer use loop.
fn save_screenshot_async(base64_image: String, path: PathBuf) {
    tokio::spawn(async move {
        let result = tokio::task::spawn_blocking(move || {
            let png_data = general_purpose::STANDARD
                .decode(&base64_image)
                .map_err(|e| format!("Failed to decode base64 screenshot: {}", e))?;

            fs::write(&path, png_data)
                .map_err(|e| format!("Failed to write screenshot to {}: {}", path.display(), e))?;

            Ok::<(), String>(())
        })
        .await;

        if let Err(e) = result {
            warn!("[computer_use] Screenshot save task failed: {:?}", e);
        } else if let Ok(Err(e)) = result {
            warn!("[computer_use] Failed to save screenshot: {}", e);
        }
    });
}

/// Save the execution result as JSON (flat structure).
fn save_execution_result(
    result: &ComputerUseResult,
    executions_dir: &std::path::Path,
    execution_id: &str,
) -> Result<(), String> {
    let json = serde_json::to_string_pretty(result)
        .map_err(|e| format!("Failed to serialize execution result: {}", e))?;

    let path = executions_dir.join(format!("{}.json", execution_id));
    fs::write(&path, json).map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;

    info!(
        "[computer_use] Saved execution result to {}",
        path.display()
    );

    Ok(())
}

// ===== Window Capture =====

/// Capture window screenshot for computer use
fn capture_window_for_computer_use(
    desktop: &Desktop,
    process: &str,
) -> Result<WindowCaptureData, String> {
    // Find the window element for this process using sysinfo to match process names
    let apps = desktop
        .applications()
        .map_err(|e| format!("Failed to get applications: {e}"))?;

    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::All, true);

    let window_element = apps
        .into_iter()
        .find(|app| {
            let app_pid = app.process_id().unwrap_or(0);
            if app_pid > 0 {
                system
                    .process(sysinfo::Pid::from_u32(app_pid))
                    .map(|p| {
                        let process_name = p.name().to_string_lossy().to_string();
                        process_name
                            .to_lowercase()
                            .contains(&process.to_lowercase())
                    })
                    .unwrap_or(false)
            } else {
                false
            }
        })
        .ok_or_else(|| format!("No window found for process '{process}'"))?;

    // Get browser URL if available, or create synthetic URL for desktop apps
    // Gemini Computer Use API requires URL field for multi-step operations
    let browser_url = window_element.url().or_else(|| {
        // For desktop apps, create a synthetic URL: app://{process}/{window_name}
        let window_name = window_element
            .name()
            .unwrap_or_default()
            .replace([' ', '/'], "_");
        Some(format!("app://{}/{}", process, window_name))
    });

    // Get window bounds (absolute screen coordinates)
    let bounds = window_element
        .bounds()
        .map_err(|e| format!("Failed to get window bounds: {e}"))?;
    let (window_x, window_y, win_w, _win_h) = bounds;

    // Capture screenshot
    let screenshot = window_element
        .capture()
        .map_err(|e| format!("Failed to capture screenshot: {e}"))?;

    let original_width = screenshot.width;
    let original_height = screenshot.height;

    // Calculate DPI scale
    let dpi_scale_w = original_width as f64 / win_w;

    // Convert BGRA to RGBA
    let rgba_data: Vec<u8> = screenshot
        .image_data
        .chunks_exact(4)
        .flat_map(|bgra| [bgra[2], bgra[1], bgra[0], bgra[3]])
        .collect();

    // Resize if needed (max 1920px)
    const MAX_DIM: u32 = 1920;
    let (final_width, final_height, final_rgba_data, resize_scale) = if original_width > MAX_DIM
        || original_height > MAX_DIM
    {
        let scale = (MAX_DIM as f32 / original_width.max(original_height) as f32).min(1.0);
        let new_width = (original_width as f32 * scale).round() as u32;
        let new_height = (original_height as f32 * scale).round() as u32;

        let img = ImageBuffer::<Rgba<u8>, _>::from_raw(original_width, original_height, rgba_data)
            .ok_or("Failed to create image buffer")?;
        let resized = image::imageops::resize(&img, new_width, new_height, FilterType::Lanczos3);

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
        .map_err(|e| format!("Failed to encode PNG: {e}"))?;

    // Base64 encode
    let base64_image = general_purpose::STANDARD.encode(&png_data);

    Ok(WindowCaptureData {
        base64_image,
        window_bounds: (window_x, window_y, final_width as f64, final_height as f64),
        dpi_scale: dpi_scale_w,
        resize_scale,
        browser_url,
    })
}

// ===== Action Execution =====

/// Execute a computer use action
async fn execute_action(
    desktop: &Desktop,
    process: &str,
    action: &str,
    args: &serde_json::Value,
    window_bounds: (f64, f64, f64, f64),
    dpi_scale: f64,
    resize_scale: f64,
) -> Result<(), String> {
    let (window_x, window_y, screenshot_w, screenshot_h) = window_bounds;

    // Helper to get values from args
    let get_f64 = |key: &str| -> Option<f64> { args.get(key).and_then(|v| v.as_f64()) };
    let get_str = |key: &str| -> Option<&str> { args.get(key).and_then(|v| v.as_str()) };
    let get_bool = |key: &str| -> Option<bool> { args.get(key).and_then(|v| v.as_bool()) };

    // Helper to convert 0-999 normalized coords to absolute screen coords
    let convert_coord = |norm_x: f64, norm_y: f64| -> (f64, f64) {
        convert_normalized_to_screen(
            norm_x,
            norm_y,
            window_x,
            window_y,
            screenshot_w,
            screenshot_h,
            dpi_scale,
            resize_scale,
        )
    };

    match action {
        "click_at" => {
            let x = get_f64("x").ok_or("click_at requires x coordinate")?;
            let y = get_f64("y").ok_or("click_at requires y coordinate")?;
            let (screen_x, screen_y) = convert_coord(x, y);
            info!(
                "[computer_use] click_at ({}, {}) -> screen ({}, {})",
                x, y, screen_x, screen_y
            );
            desktop
                .click_at_coordinates(screen_x, screen_y, false)
                .map_err(|e| format!("Click failed: {e}"))?;
        }
        "type_text_at" => {
            let x = get_f64("x").ok_or("type_text_at requires x coordinate")?;
            let y = get_f64("y").ok_or("type_text_at requires y coordinate")?;
            let text = get_str("text").ok_or("type_text_at requires text")?;
            let press_enter = get_bool("press_enter").unwrap_or(false);
            let (screen_x, screen_y) = convert_coord(x, y);
            info!(
                "[computer_use] type_text_at ({}, {}) -> screen ({}, {}), text: {}",
                x, y, screen_x, screen_y, text
            );
            // Click first to focus
            desktop
                .click_at_coordinates(screen_x, screen_y, false)
                .map_err(|e| format!("Click before type failed: {e}"))?;
            tokio::time::sleep(Duration::from_millis(100)).await;
            // Select all (Ctrl+A) to clear existing text before typing
            desktop
                .press_key("{Ctrl}a")
                .await
                .map_err(|e| format!("Select all failed: {e}"))?;
            tokio::time::sleep(Duration::from_millis(50)).await;
            // Type text using root element (this will replace selected text)
            let root = desktop.root();
            root.type_text(text, false)
                .map_err(|e| format!("Type text failed: {e}"))?;
            // Press Enter if requested
            if press_enter {
                tokio::time::sleep(Duration::from_millis(50)).await;
                desktop
                    .press_key("{Enter}")
                    .await
                    .map_err(|e| format!("Press Enter failed: {e}"))?;
            }
        }
        "key_combination" => {
            let keys = get_str("keys").ok_or("key_combination requires keys")?;
            let translated = translate_gemini_keys(keys)?;
            info!("[computer_use] key_combination: {} -> {}", keys, translated);
            desktop
                .press_key(&translated)
                .await
                .map_err(|e| format!("Key press failed: {e}"))?;
        }
        "scroll_document" | "scroll_at" => {
            let direction = get_str("direction").ok_or("scroll requires direction")?;
            let magnitude = get_f64("magnitude").unwrap_or(3.0);
            let amount: f64 = match direction {
                "up" => -magnitude,
                "down" => magnitude,
                "left" => -magnitude,
                "right" => magnitude,
                _ => magnitude,
            };
            info!("[computer_use] scroll: {} (amount: {})", direction, amount);
            // If coordinates provided, click there first to focus
            if let (Some(x), Some(y)) = (get_f64("x"), get_f64("y")) {
                let (screen_x, screen_y) = convert_coord(x, y);
                desktop
                    .click_at_coordinates(screen_x, screen_y, false)
                    .map_err(|e| format!("Click before scroll failed: {e}"))?;
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            // Scroll using root element
            let root = desktop.root();
            root.scroll(direction, amount)
                .map_err(|e| format!("Scroll failed: {e}"))?;
        }
        "drag_and_drop" => {
            let start_x = get_f64("x")
                .or(get_f64("start_x"))
                .ok_or("drag_and_drop requires x/start_x")?;
            let start_y = get_f64("y")
                .or(get_f64("start_y"))
                .ok_or("drag_and_drop requires y/start_y")?;
            let end_x = get_f64("destination_x")
                .or(get_f64("end_x"))
                .ok_or("drag_and_drop requires destination_x/end_x")?;
            let end_y = get_f64("destination_y")
                .or(get_f64("end_y"))
                .ok_or("drag_and_drop requires destination_y/end_y")?;
            let (start_screen_x, start_screen_y) = convert_coord(start_x, start_y);
            let (end_screen_x, end_screen_y) = convert_coord(end_x, end_y);
            info!(
                "[computer_use] drag_and_drop from ({}, {}) to ({}, {})",
                start_screen_x, start_screen_y, end_screen_x, end_screen_y
            );
            let root = desktop.root();
            root.mouse_drag(start_screen_x, start_screen_y, end_screen_x, end_screen_y)
                .map_err(|e| format!("Drag failed: {e}"))?;
        }
        "wait_5_seconds" => {
            info!("[computer_use] waiting 5 seconds");
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
        "hover_at" => {
            let x = get_f64("x").ok_or("hover_at requires x coordinate")?;
            let y = get_f64("y").ok_or("hover_at requires y coordinate")?;
            let (screen_x, screen_y) = convert_coord(x, y);
            info!(
                "[computer_use] hover_at ({}, {}) -> screen ({}, {})",
                x, y, screen_x, screen_y
            );
            let root = desktop.root();
            root.mouse_move(screen_x, screen_y)
                .map_err(|e| format!("Mouse move failed: {e}"))?;
        }
        "navigate" => {
            let url = get_str("url").ok_or("navigate requires url")?;
            info!("[computer_use] navigate to: {} (process: {})", url, process);
            // First, activate the browser window to ensure it has focus
            if let Err(e) = desktop.activate_application(process) {
                warn!("[computer_use] Failed to activate {}: {}", process, e);
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
            // Use Ctrl+L to focus address bar, then type URL and press Enter
            // This navigates the current tab instead of opening a new one
            desktop
                .press_key("{Ctrl}l")
                .await
                .map_err(|e| format!("Focus address bar failed: {e}"))?;
            tokio::time::sleep(Duration::from_millis(150)).await;
            // Select all existing text in address bar
            desktop
                .press_key("{Ctrl}a")
                .await
                .map_err(|e| format!("Select all in address bar failed: {e}"))?;
            tokio::time::sleep(Duration::from_millis(50)).await;
            // Type the URL
            let root = desktop.root();
            root.type_text(url, false)
                .map_err(|e| format!("Type URL failed: {e}"))?;
            tokio::time::sleep(Duration::from_millis(100)).await;
            // Press Enter to navigate
            desktop
                .press_key("{Enter}")
                .await
                .map_err(|e| format!("Press Enter to navigate failed: {e}"))?;
            // Wait for navigation to start
            tokio::time::sleep(Duration::from_millis(1000)).await;
        }
        "search" => {
            let query = get_str("query")
                .or_else(|| get_str("text"))
                .or_else(|| get_str("q"))
                .unwrap_or("");
            info!("[computer_use] search: {}", query);
            if query.is_empty() {
                desktop
                    .press_key("{Enter}")
                    .await
                    .map_err(|e| format!("Press Enter for search failed: {e}"))?;
            } else {
                let encoded_query: String = query
                    .chars()
                    .map(|c| match c {
                        ' ' => "+".to_string(),
                        'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
                        _ => format!("%{:02X}", c as u32),
                    })
                    .collect();
                let search_url = format!("https://www.google.com/search?q={}", encoded_query);
                desktop
                    .open_url(&search_url, None)
                    .map_err(|e| format!("Open search URL failed: {e}"))?;
            }
        }
        _ => {
            warn!("[computer_use] Unknown action: {}", action);
            return Err(format!("Unknown action: {action}"));
        }
    }

    Ok(())
}

// ===== Main Implementation =====

impl Desktop {
    /// Run Gemini Computer Use agentic loop.
    ///
    /// Provide a goal and target process, and this will autonomously take actions
    /// (click, type, scroll, etc.) until the goal is achieved or max_steps is reached.
    ///
    /// # Arguments
    /// * `process` - Process name of the target application (e.g., "chrome", "notepad")
    /// * `goal` - What to achieve (e.g., "Open Notepad and type Hello World")
    /// * `max_steps` - Maximum number of steps before stopping (default: 20)
    /// * `on_step` - Optional callback for progress updates
    ///
    /// # Returns
    /// * `Ok(ComputerUseResult)` - Result with status, steps executed, and history
    /// * `Err(e)` - If the operation fails
    ///
    /// # Example
    /// ```ignore
    /// let desktop = Desktop::new(false, true)?;
    /// let result = desktop.gemini_computer_use(
    ///     "notepad",
    ///     "Type 'Hello World' and save the file",
    ///     Some(10),
    ///     Some(Box::new(|step| println!("Step {}: {}", step.step, step.action))),
    /// ).await?;
    /// println!("Status: {}", result.status);
    /// ```
    pub async fn gemini_computer_use(
        &self,
        process: &str,
        goal: &str,
        max_steps: Option<u32>,
        on_step: Option<ProgressCallback>,
    ) -> Result<ComputerUseResult> {
        let max_steps = max_steps.unwrap_or(20);
        let mut previous_actions: Vec<ComputerUsePreviousAction> = Vec::new();
        let mut steps: Vec<ComputerUseStep> = Vec::new();
        let mut final_status = "max_steps_reached";
        let mut final_action = String::new();
        let mut final_text: Option<String> = None;
        let mut pending_confirmation: Option<serde_json::Value> = None;

        // Setup executions directory for screenshots (flat structure)
        let execution_id = generate_execution_id(process);
        let executions_dir = match get_executions_dir() {
            Ok(dir) => Some(dir),
            Err(e) => {
                warn!("[computer_use] Failed to get executions dir: {}", e);
                None
            }
        };

        info!(
            "[computer_use] Starting agentic loop for goal: {} (max_steps: {}, execution_id: {})",
            goal, max_steps, execution_id
        );

        for step_num in 1..=max_steps {
            // Check for cancellation at start of each iteration
            if self.is_cancelled() {
                info!("[computer_use] Cancelled by stop_execution");
                final_status = "cancelled";
                break;
            }

            info!("[computer_use] Step {}/{}", step_num, max_steps);

            // 1. Capture screenshot of target window
            let capture_data = match capture_window_for_computer_use(self, process) {
                Ok(data) => data,
                Err(e) => {
                    warn!("[computer_use] Failed to capture screenshot: {}", e);
                    final_status = "failed";
                    break;
                }
            };

            // 1b. Save initial screenshot only (before any action) - async, non-blocking
            if step_num == 1 {
                if let Some(ref dir) = executions_dir {
                    let screenshot_path = dir.join(format!("{}_000_initial.png", execution_id));
                    save_screenshot_async(capture_data.base64_image.clone(), screenshot_path);
                }
            }

            // 2. Call backend to get next action
            let response = match call_computer_use_backend(
                &capture_data.base64_image,
                goal,
                if previous_actions.is_empty() {
                    None
                } else {
                    Some(&previous_actions)
                },
            )
            .await
            {
                Ok(r) => r,
                Err(e) => {
                    warn!("[computer_use] Backend error: {}", e);
                    final_status = "failed";
                    break;
                }
            };

            // Store text response
            if response.text.is_some() {
                final_text = response.text.clone();
            }

            // 3. Check for task completion
            if response.completed {
                final_status = "success";
                final_action = "completed".to_string();
                info!("[computer_use] Task completed. Text: {:?}", response.text);
                break;
            }

            // 4. Get function call
            let function_call = match response.function_call {
                Some(fc) => fc,
                None => {
                    final_status = "success";
                    final_action = "no_action".to_string();
                    break;
                }
            };

            final_action = function_call.name.clone();
            info!(
                "[computer_use] Action: {} (text: {:?})",
                function_call.name, response.text
            );

            // 5. Check for safety confirmation
            if response.safety_decision.as_deref() == Some("require_confirmation") {
                final_status = "needs_confirmation";
                pending_confirmation = Some(serde_json::json!({
                    "action": function_call.name,
                    "args": function_call.args,
                    "text": response.text,
                }));
                break;
            }

            // 6. Execute action
            let execute_result = execute_action(
                self,
                process,
                &function_call.name,
                &function_call.args,
                capture_data.window_bounds,
                capture_data.dpi_scale,
                capture_data.resize_scale,
            )
            .await;

            // 7. Record action result
            let (success, error_msg) = match &execute_result {
                Ok(_) => (true, None),
                Err(e) => (false, Some(e.to_string())),
            };

            let step = ComputerUseStep {
                step: step_num,
                action: function_call.name.clone(),
                args: function_call.args.clone(),
                success,
                error: error_msg.clone(),
                text: response.text.clone(),
            };

            // Call progress callback if provided
            if let Some(ref callback) = on_step {
                callback(&step);
            }

            steps.push(step);

            // 8. Wait for UI to settle before capturing post-action screenshot
            // This is critical for actions that cause page navigation (e.g., press Enter on search)
            // Use select! to allow cancellation during the wait
            let ct = self.cancellation_token();
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(1000)) => {},
                _ = ct.cancelled() => {
                    info!("[computer_use] Cancelled during wait by stop_execution");
                    final_status = "cancelled";
                    break;
                }
            }

            // 9. Capture new screenshot after action for next iteration
            let (post_action_screenshot, post_action_url) = match capture_window_for_computer_use(
                self, process,
            ) {
                Ok(data) => (data.base64_image, data.browser_url),
                Err(e) => {
                    warn!("[computer_use] Failed to capture post-action screenshot: {}. Skipping previous_actions update.", e);
                    // Don't fallback to pre-action screenshot - that would confuse Gemini
                    // Just continue to next iteration without adding to previous_actions
                    continue;
                }
            };

            // 9b. Save post-action screenshot (result of this step's action) - async, non-blocking
            if let Some(ref dir) = executions_dir {
                let screenshot_path =
                    dir.join(format!("{}_{:03}_after.png", execution_id, step_num));
                save_screenshot_async(post_action_screenshot.clone(), screenshot_path);
            }

            previous_actions.push(ComputerUsePreviousAction {
                name: function_call.name,
                response: ComputerUseActionResponse {
                    success,
                    error: error_msg,
                },
                screenshot: post_action_screenshot,
                url: post_action_url,
            });

            // 10. Limit previous_actions to last 3 to avoid payload too large errors
            if previous_actions.len() > 3 {
                previous_actions.remove(0);
            }
        }

        info!(
            "[computer_use] Completed with status: {} ({} steps)",
            final_status,
            steps.len()
        );

        let result = ComputerUseResult {
            status: final_status.to_string(),
            goal: goal.to_string(),
            steps_executed: steps.len() as u32,
            final_action,
            final_text,
            steps,
            pending_confirmation,
            execution_id: Some(execution_id.clone()),
        };

        // Save execution result as JSON (flat structure)
        if let Some(ref dir) = executions_dir {
            if let Err(e) = save_execution_result(&result, dir, &execution_id) {
                warn!("[computer_use] Failed to save execution result: {}", e);
            }
        }

        Ok(result)
    }
}
