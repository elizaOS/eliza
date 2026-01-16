#![allow(clippy::arc_with_non_send_sync)]

use crate::element::UIElementImpl;
use crate::platforms::windows::tree_builder::{
    build_ui_node_tree_configurable, TreeBuildingConfig, TreeBuildingContext,
};
use crate::platforms::windows::types::ThreadSafeWinUIElement;
use crate::platforms::windows::utils::{
    create_ui_automation_with_com_init, map_generic_role_to_win_roles, string_to_ui_property,
};
use crate::platforms::windows::virtual_display::{
    is_headless_environment, HeadlessConfig, VirtualDisplayConfig, VirtualDisplayManager,
};
use crate::platforms::windows::{applications, generate_element_id, WindowsUIElement};
use crate::platforms::AccessibilityEngine;
use crate::ScreenshotResult;
use crate::{AutomationError, Selector, UIElement};
use image::DynamicImage;
use image::{ImageBuffer, Rgba};
use std::panic;
use std::sync::Arc;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

/// Windows constant to prevent console window creation during process spawn
const CREATE_NO_WINDOW: u32 = 0x08000000;
use tokio::runtime::Runtime;
use tracing::{debug, error, info, warn};
use uiautomation::controls::ControlType;
use uiautomation::filters::{ClassNameFilter, ControlTypeFilter, NameFilter, OrFilter};
use uiautomation::types::{TreeScope, UIProperty};
use uiautomation::variants::Variant;
use uiautomation::UIAutomation;
use uni_ocr::{OcrEngine, OcrProvider};

// windows imports
use windows::core::{HRESULT, HSTRING, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

// Windows Media OCR imports
use windows::Media::Ocr::OcrEngine as WinOcrEngine;

// Import OcrElement for bounding box OCR results
use crate::element::OcrElement;

// Define a default timeout duration
// Set to 0 for one-time search (no polling) - add explicit timeout where waiting is needed
const DEFAULT_FIND_TIMEOUT: Duration = Duration::from_millis(0);

// List of common browser process names (without .exe)
const KNOWN_BROWSER_PROCESS_NAMES: &[&str] = &[
    "chrome", "firefox", "msedge", "edge", "iexplore", "opera", "brave", "vivaldi", "browser",
    "arc", "explorer",
];

/// Determines if we should use shallow search for application-level containers
/// Returns true when searching for named Panes/Windows from desktop root
fn should_use_shallow_search(role: &str, name: &Option<String>, root: Option<&UIElement>) -> bool {
    // Only optimize when searching from desktop (no root specified)
    if root.is_some() {
        return false;
    }

    // Check if we're searching for a container type (Pane/Window/Application)
    let is_container = matches!(
        role.to_lowercase().as_str(),
        "pane" | "window" | "application"
    );

    // Must have a name filter - unnamed containers search would return too many results
    let has_name = name.is_some();

    // Use shallow search for named containers at desktop level
    // These are typically application windows or browser tabs that are near the root
    is_container && has_name
}

/// Calculate appropriate search depth based on selector type and context
fn calculate_search_depth(
    role: &str,
    name: &Option<String>,
    root: Option<&UIElement>,
    default_depth: Option<usize>,
) -> u32 {
    let should_optimize = should_use_shallow_search(role, name, root);
    let final_depth = if should_optimize {
        info!(
            "🚀 OPTIMIZED: Using shallow search (depth=5) for container: role={}, name={:?}, root_provided={}", 
            role, name, root.is_some()
        );
        5 // Most application containers are within 5 levels of desktop
    } else {
        let depth = default_depth.unwrap_or(50) as u32;
        debug!(
            "Standard search (depth={}) for: role={}, name={:?}, root_provided={}",
            depth,
            role,
            name,
            root.is_some()
        );
        depth
    };
    final_depth
}

// Helper function to get process name by PID using native Windows API
pub fn get_process_name_by_pid(pid: i32) -> Result<String, AutomationError> {
    unsafe {
        // Create a snapshot of all processes
        let snapshot = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            Ok(h) => h,
            Err(e) => {
                warn!(
                    "[CRASH_DEBUG] CreateToolhelp32Snapshot failed for PID {}: {:?}",
                    pid, e
                );
                return Err(AutomationError::PlatformError(format!(
                    "Failed to create process snapshot: {e}"
                )));
            }
        };

        if snapshot.is_invalid() {
            return Err(AutomationError::PlatformError(
                "Invalid snapshot handle".to_string(),
            ));
        }

        // Ensure we close the handle when done
        let _guard = HandleGuard(snapshot);

        let mut process_entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };

        // Get the first process
        if Process32FirstW(snapshot, &mut process_entry).is_err() {
            return Err(AutomationError::PlatformError(
                "Failed to get first process".to_string(),
            ));
        }

        // Iterate through processes to find the one with matching PID
        loop {
            if process_entry.th32ProcessID == pid as u32 {
                // Convert the process name from wide string to String
                let name_slice = &process_entry.szExeFile;
                let name_len = name_slice
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(name_slice.len());
                let process_name = String::from_utf16_lossy(&name_slice[..name_len]);

                // Remove .exe extension if present
                let clean_name = process_name
                    .strip_suffix(".exe")
                    .or_else(|| process_name.strip_suffix(".EXE"))
                    .unwrap_or(&process_name);

                return Ok(clean_name.to_string());
            }

            // Get the next process
            if Process32NextW(snapshot, &mut process_entry).is_err() {
                break;
            }
        }

        Err(AutomationError::PlatformError(format!(
            "Process with PID {pid} not found"
        )))
    }
}

// Helper function to check if a selector has process scoping
fn selector_has_process_scope(selector: &Selector) -> bool {
    match selector {
        Selector::Process(_) => true,
        Selector::Chain(selectors) => selectors.iter().any(selector_has_process_scope),
        Selector::And(selectors) => selectors.iter().any(selector_has_process_scope),
        Selector::Or(selectors) => selectors.iter().any(selector_has_process_scope),
        Selector::Not(inner) => selector_has_process_scope(inner),
        Selector::Has(inner) => selector_has_process_scope(inner),
        Selector::RightOf(inner)
        | Selector::LeftOf(inner)
        | Selector::Above(inner)
        | Selector::Below(inner)
        | Selector::Near(inner) => selector_has_process_scope(inner),
        _ => false,
    }
}

// RAII guard to ensure handle is closed
struct HandleGuard(HANDLE);

impl Drop for HandleGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

// thread-safety
#[derive(Clone)]
pub struct ThreadSafeWinUIAutomation(pub Arc<UIAutomation>);

// send and sync for wrapper
unsafe impl Send for ThreadSafeWinUIAutomation {}
unsafe impl Sync for ThreadSafeWinUIAutomation {}

#[allow(unused)]
// there is no need of `use_background_apps` or `activate_app`
// windows IUIAutomation will get current running app &
// background running app spontaneously, keeping it anyway!!
pub struct WindowsEngine {
    pub automation: ThreadSafeWinUIAutomation,
    use_background_apps: bool,
    activate_app: bool,
    virtual_display: Option<Arc<Mutex<VirtualDisplayManager>>>,
}

/// Helper function to extract COM error codes from Windows errors
fn extract_com_error_code(error_str: &str) -> Option<i32> {
    // Look for hex patterns like "0x80004005" or "0x80070005"
    if let Some(hex_start) = error_str.find("0x") {
        let hex_str = &error_str[hex_start + 2..];
        let hex_end = hex_str
            .find(|c: char| !c.is_ascii_hexdigit())
            .unwrap_or(hex_str.len());
        if hex_end > 0 {
            if let Ok(val) = i32::from_str_radix(&hex_str[..hex_end], 16) {
                return Some(val);
            }
        }
    }

    // Look for decimal error codes like "-2147467259"
    // Common COM errors are typically large negative numbers
    for word in error_str.split_whitespace() {
        if word.starts_with('-') && word.len() > 5 {
            if let Ok(val) = word.parse::<i32>() {
                // Check if it looks like a COM error (typically large negative numbers)
                if val < -1000000 {
                    return Some(val);
                }
            }
        }
    }

    None
}

impl WindowsEngine {
    pub fn new(use_background_apps: bool, activate_app: bool) -> Result<Self, AutomationError> {
        // Initialize COM in multithreaded mode for thread safety
        unsafe {
            let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
            if hr.is_err() && hr != HRESULT(0x80010106u32 as i32) {
                // Only return error if it's not the "already initialized" case
                return Err(AutomationError::PlatformError(format!(
                    "Failed to initialize COM in multithreaded mode: {hr}"
                )));
            }
            // If we get here, either initialization succeeded or it was already initialized
            if hr == HRESULT(0x80010106u32 as i32) {
                debug!("COM already initialized in this thread");
            }
        }

        // Check if we need to initialize virtual display for headless operation
        let mut virtual_display = None;
        if is_headless_environment() {
            info!("Headless environment detected, initializing virtual display");
            let mut display_manager = VirtualDisplayManager::new(VirtualDisplayConfig::default());
            if let Err(e) = display_manager.initialize() {
                warn!("Failed to initialize virtual display: {}", e);
                // Continue without virtual display - may work with existing session
            } else {
                info!("Virtual display initialized successfully");
                virtual_display = Some(Arc::new(Mutex::new(display_manager)));
            }
        }

        let automation = UIAutomation::new_direct()
            .map_err(|e| AutomationError::PlatformError(e.to_string()))?;
        let arc_automation = ThreadSafeWinUIAutomation(Arc::new(automation));
        Ok(Self {
            automation: arc_automation,
            use_background_apps,
            activate_app,
            virtual_display,
        })
    }

    /// Create a new WindowsEngine with custom headless configuration
    pub fn new_with_headless(
        use_background_apps: bool,
        activate_app: bool,
        headless_config: HeadlessConfig,
    ) -> Result<Self, AutomationError> {
        // Initialize COM
        unsafe {
            let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
            if hr.is_err() && hr != HRESULT(0x80010106u32 as i32) {
                return Err(AutomationError::PlatformError(format!(
                    "Failed to initialize COM in multithreaded mode: {hr}"
                )));
            }
            if hr == HRESULT(0x80010106u32 as i32) {
                debug!("COM already initialized in this thread");
            }
        }

        // Initialize virtual display if configured
        let mut virtual_display = None;
        if headless_config.use_virtual_display {
            info!("Initializing virtual display with custom config");
            let mut display_manager =
                VirtualDisplayManager::new(headless_config.virtual_display_config);

            // Try to install driver if path is provided
            if display_manager.config.driver_path.is_some() {
                if let Err(e) = display_manager.install_driver() {
                    warn!("Failed to install virtual display driver: {}", e);
                }
            }

            if let Err(e) = display_manager.initialize() {
                if headless_config.fallback_to_memory {
                    warn!("Virtual display init failed, using memory fallback: {}", e);
                } else {
                    return Err(AutomationError::PlatformError(format!(
                        "Virtual display initialization failed: {e}"
                    )));
                }
            } else {
                info!("Virtual display initialized successfully");
                virtual_display = Some(Arc::new(Mutex::new(display_manager)));
            }
        }

        let automation = UIAutomation::new_direct()
            .map_err(|e| AutomationError::PlatformError(e.to_string()))?;
        let arc_automation = ThreadSafeWinUIAutomation(Arc::new(automation));

        Ok(Self {
            automation: arc_automation,
            use_background_apps,
            activate_app,
            virtual_display,
        })
    }

    /// Check if virtual display is active
    pub fn is_virtual_display_active(&self) -> bool {
        self.virtual_display
            .as_ref()
            .is_some_and(|vd| vd.lock().unwrap().is_available())
    }

    /// Get virtual display session ID if available
    pub fn get_virtual_session_id(&self) -> Option<u32> {
        self.virtual_display
            .as_ref()
            .and_then(|vd| vd.lock().unwrap().get_session_id())
    }

    /// Extract browser-specific information from window titles
    pub fn extract_browser_info(title: &str) -> (bool, Vec<String>) {
        let title_lower = title.to_lowercase();
        let is_browser = KNOWN_BROWSER_PROCESS_NAMES
            .iter()
            .any(|&browser| title_lower.contains(browser));

        if is_browser {
            let mut parts = Vec::new();

            // Split by common browser title separators
            for separator in &[" - ", " — ", " | ", " • "] {
                if title.contains(separator) {
                    parts.extend(title.split(separator).map(|s| s.trim().to_string()));
                    break;
                }
            }

            // If no separators found, use the whole title
            if parts.is_empty() {
                parts.push(title.trim().to_string());
            }

            (true, parts)
        } else {
            (false, vec![title.to_string()])
        }
    }

    /// Calculate similarity score between two strings with various matching strategies
    pub fn calculate_similarity(text1: &str, text2: &str) -> f64 {
        let text1_lower = text1.to_lowercase();
        let text2_lower = text2.to_lowercase();

        // Exact match
        if text1_lower == text2_lower {
            return 1.0;
        }

        // Contains match - favor longer matches
        if text1_lower.contains(&text2_lower) || text2_lower.contains(&text1_lower) {
            let shorter = text1_lower.len().min(text2_lower.len());
            let longer = text1_lower.len().max(text2_lower.len());
            return shorter as f64 / longer as f64 * 0.9; // Slight penalty for partial match
        }

        // Word-based similarity for longer texts
        let words1: Vec<&str> = text1_lower.split_whitespace().collect();
        let words2: Vec<&str> = text2_lower.split_whitespace().collect();

        if words1.is_empty() || words2.is_empty() {
            return 0.0;
        }

        let mut common_words = 0;
        for word1 in &words1 {
            for word2 in &words2 {
                if word1 == word2 || word1.contains(word2) || word2.contains(word1) {
                    common_words += 1;
                    break;
                }
            }
        }

        // Calculate Jaccard similarity with word overlap
        let total_unique_words = words1.len() + words2.len() - common_words;
        if total_unique_words > 0 {
            common_words as f64 / total_unique_words as f64
        } else {
            0.0
        }
    }

    /// Helper method to get root element with automatic retries for transient Windows UI Automation failures
    fn get_root_element_with_retry(&self) -> Result<Arc<uiautomation::UIElement>, AutomationError> {
        let mut last_error = None;
        const MAX_ATTEMPTS: u32 = 3;

        for attempt in 0..MAX_ATTEMPTS {
            match self.automation.0.get_root_element() {
                Ok(root) => {
                    if attempt > 0 {
                        debug!(
                            "Successfully got root element after {} attempts",
                            attempt + 1
                        );
                    }
                    return Ok(Arc::new(root));
                }
                Err(e) => {
                    last_error = Some(e);
                    if attempt < MAX_ATTEMPTS - 1 {
                        // Windows UI Automation can transiently fail, especially under load
                        // This is normal behavior - wait briefly and retry
                        let wait_ms = 100 * (attempt + 1); // Progressive backoff: 100ms, 200ms
                        debug!(
                            "get_root_element attempt {}/{} failed (this is normal): {:?}. Waiting {}ms before retry...",
                            attempt + 1, MAX_ATTEMPTS, last_error, wait_ms
                        );
                        std::thread::sleep(Duration::from_millis(wait_ms as u64));
                    }
                }
            }
        }

        // All attempts failed - return a proper retryable error
        let error_str = format!("{:?}", last_error.as_ref().unwrap());
        let com_error_code = extract_com_error_code(&error_str);

        if let Some(hresult) = com_error_code {
            Err(AutomationError::UIAutomationAPIError {
                message: format!(
                    "Windows UI Automation service temporarily unavailable after {MAX_ATTEMPTS} attempts. This is a transient Windows issue."
                ),
                com_error: Some(hresult),
                operation: "get_root_element".to_string(),
                is_retryable: true, // Always retryable - this is a transient Windows issue
            })
        } else {
            Err(AutomationError::PlatformError(format!(
                "Failed to get root element after {MAX_ATTEMPTS} attempts: {:?}",
                last_error.as_ref().unwrap()
            )))
        }
    }

    /// Enhanced title matching that handles browser windows and fuzzy matching
    fn find_best_title_match(
        &self,
        windows: &[(uiautomation::UIElement, String)],
        target_title: &str,
    ) -> Option<(uiautomation::UIElement, f64)> {
        let title_lower = target_title.to_lowercase();
        let mut best_match: Option<uiautomation::UIElement> = None;
        let mut best_score = 0.0f64;

        for (window, window_name) in windows {
            // Strategy 1: Direct contains match (highest priority)
            if window_name.to_lowercase().contains(&title_lower) {
                info!(
                    "Found exact title match: '{}' contains '{}'",
                    window_name, target_title
                );
                return Some((window.clone(), 1.0));
            }

            // Strategy 2: Browser-aware matching
            let (is_browser_window, window_parts) = Self::extract_browser_info(window_name);
            let (is_target_browser, target_parts) = Self::extract_browser_info(target_title);

            if is_browser_window && is_target_browser {
                let mut max_part_similarity = 0.0f64;

                for window_part in &window_parts {
                    for target_part in &target_parts {
                        let similarity = Self::calculate_similarity(window_part, target_part);
                        max_part_similarity = max_part_similarity.max(similarity);

                        debug!(
                            "Comparing '{}' vs '{}' = {:.2}",
                            window_part, target_part, similarity
                        );
                    }
                }

                if max_part_similarity > 0.6 && max_part_similarity > best_score {
                    info!(
                        "Found browser match: '{}' vs '{}' (similarity: {:.2})",
                        window_name, target_title, max_part_similarity
                    );
                    best_score = max_part_similarity;
                    best_match = Some(window.clone());
                }
            }

            // Strategy 3: General fuzzy matching as fallback
            if best_score < 0.6 {
                let similarity = Self::calculate_similarity(window_name, target_title);
                if similarity > 0.5 && similarity > best_score {
                    debug!(
                        "Potential fuzzy match: '{}' vs '{}' (similarity: {:.2})",
                        window_name, target_title, similarity
                    );
                    best_score = similarity;
                    best_match = Some(window.clone());
                }
            }
        }

        best_match.map(|window| (window, best_score))
    }

    /// Helper function to check if an element matches a selector
    /// Used for filtering elements in AND operations
    #[allow(clippy::only_used_in_recursion)]
    fn element_matches_selector(
        &self,
        element: &UIElement,
        selector: &Selector,
    ) -> Result<bool, AutomationError> {
        // Get the underlying Windows element
        let win_element = if let Some(ele) = element.as_any().downcast_ref::<WindowsUIElement>() {
            &ele.element.0
        } else {
            return Ok(false);
        };

        match selector {
            Selector::Role { role, name } => {
                // Check role
                let element_role = win_element.get_control_type().ok();
                let expected_type = map_generic_role_to_win_roles(role);

                let role_matches = if let Some(elem_type) = element_role {
                    elem_type == expected_type
                } else {
                    false
                };

                if !role_matches {
                    return Ok(false);
                }

                // Check name if specified (case-insensitive partial match)
                if let Some(expected_name) = name {
                    let element_name = win_element.get_name().unwrap_or_default();
                    Ok(element_name
                        .to_lowercase()
                        .contains(&expected_name.to_lowercase()))
                } else {
                    Ok(true)
                }
            }
            Selector::Name(expected_name) => {
                // name: is case-insensitive partial match
                let element_name = win_element.get_name().unwrap_or_default();
                Ok(element_name
                    .to_lowercase()
                    .contains(&expected_name.to_lowercase()))
            }
            Selector::Text(expected_text) => {
                // text: is case-sensitive partial match
                let element_name = win_element.get_name().unwrap_or_default();
                Ok(element_name.contains(expected_text))
            }
            Selector::ClassName(expected_class) => {
                let element_class = win_element.get_classname().unwrap_or_default();
                Ok(element_class == *expected_class)
            }
            Selector::Visible(expected_visibility) => {
                let is_visible = !win_element.is_offscreen().unwrap_or(true);
                Ok(is_visible == *expected_visibility)
            }
            Selector::Id(expected_id) => {
                let target_id = expected_id.strip_prefix('#').unwrap_or(expected_id);
                match generate_element_id(win_element)
                    .map(|id| id.to_string().chars().take(6).collect::<String>())
                {
                    Ok(element_id) => Ok(element_id == target_id),
                    Err(_) => Ok(false),
                }
            }
            Selector::Process(expected_process_name) => {
                // Get process ID from element
                match element.process_id() {
                    Ok(pid) => {
                        // Convert PID to process name
                        match get_process_name_by_pid(pid as i32) {
                            Ok(process_name) => {
                                let process_name_lower = process_name.to_lowercase();
                                let expected_lower = expected_process_name.to_lowercase();

                                // Support both "chrome" and "chrome.exe" matching
                                // Also support partial matches (e.g., "chrome" matches "chrome.exe")
                                let matches = process_name_lower == expected_lower
                                    || process_name_lower.starts_with(&expected_lower)
                                    || expected_lower.starts_with(&process_name_lower);

                                Ok(matches)
                            }
                            Err(_) => Ok(false),
                        }
                    }
                    Err(_) => Ok(false),
                }
            }
            Selector::And(selectors) => {
                // Recursively check all AND conditions
                for sel in selectors {
                    if !self.element_matches_selector(element, sel)? {
                        return Ok(false);
                    }
                }
                Ok(true)
            }
            Selector::Or(selectors) => {
                // Check if any OR condition matches
                for sel in selectors {
                    if self.element_matches_selector(element, sel)? {
                        return Ok(true);
                    }
                }
                Ok(false)
            }
            Selector::Not(inner_selector) => {
                // Negate the inner selector
                Ok(!self.element_matches_selector(element, inner_selector)?)
            }
            // Complex selectors that would need more context
            Selector::Chain(_)
            | Selector::Has(_)
            | Selector::Parent
            | Selector::RightOf(_)
            | Selector::LeftOf(_)
            | Selector::Above(_)
            | Selector::Below(_)
            | Selector::Near(_)
            | Selector::Path(_)
            | Selector::NativeId(_)
            | Selector::Attributes(_)
            | Selector::Filter(_)
            | Selector::LocalizedRole(_)
            | Selector::Nth(_)
            | Selector::Invalid(_) => {
                // These selectors require searching relative to other elements or are complex queries
                // For now, we'll return false as they can't be evaluated on a single element
                Ok(false)
            }
        }
    }

    /// Perform OCR on a screenshot and return structured results with bounding boxes.
    /// Uses Windows native OCR (Windows.Media.Ocr) for accurate word-level positioning.
    ///
    /// # Arguments
    /// * `screenshot` - The screenshot to perform OCR on
    /// * `window_x` - X offset of the window on screen in logical coordinates
    /// * `window_y` - Y offset of the window on screen in logical coordinates
    /// * `dpi_scale_x` - DPI scale factor for X (screenshot_width / window_logical_width)
    /// * `dpi_scale_y` - DPI scale factor for Y (screenshot_height / window_logical_height)
    ///
    /// # Returns
    /// An OcrElement tree with bounds in absolute screen coordinates
    pub fn ocr_screenshot_with_bounds(
        &self,
        screenshot: &ScreenshotResult,
        window_x: f64,
        window_y: f64,
        dpi_scale_x: f64,
        dpi_scale_y: f64,
    ) -> Result<OcrElement, AutomationError> {
        use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
        use windows::Storage::Streams::DataWriter;

        // Windows OCR expects BGRA format, but our screenshot is RGBA
        // Convert RGBA to BGRA
        let mut bgra_data = screenshot.image_data.clone();
        for chunk in bgra_data.chunks_exact_mut(4) {
            chunk.swap(0, 2); // Swap R and B
        }

        // Create an IBuffer from the pixel data using DataWriter
        let writer = DataWriter::new().map_err(|e| {
            AutomationError::PlatformError(format!("Failed to create DataWriter: {e}"))
        })?;

        writer
            .WriteBytes(&bgra_data)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to write bytes: {e}")))?;

        let buffer = writer
            .DetachBuffer()
            .map_err(|e| AutomationError::PlatformError(format!("Failed to detach buffer: {e}")))?;

        // Create SoftwareBitmap directly from raw pixel buffer
        let bitmap = SoftwareBitmap::CreateCopyFromBuffer(
            &buffer,
            BitmapPixelFormat::Bgra8,
            screenshot.width as i32,
            screenshot.height as i32,
        )
        .map_err(|e| {
            AutomationError::PlatformError(format!("Failed to create SoftwareBitmap: {e}"))
        })?;

        // Create OCR engine from user profile languages
        let ocr_engine = WinOcrEngine::TryCreateFromUserProfileLanguages().map_err(|e| {
            AutomationError::PlatformError(format!("Failed to create Windows OCR engine: {e}"))
        })?;

        // Perform OCR recognition (blocking)
        let result = ocr_engine
            .RecognizeAsync(&bitmap)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to start OCR: {e}")))?
            .get()
            .map_err(|e| AutomationError::PlatformError(format!("OCR recognition failed: {e}")))?;

        // Get text angle (rotation)
        let text_angle = result.TextAngle().ok().and_then(|opt| opt.Value().ok());

        // Get full text
        let full_text = result.Text().map(|s| s.to_string()).unwrap_or_default();

        // Build OcrElement tree from lines and words
        let lines = result
            .Lines()
            .map_err(|e| AutomationError::PlatformError(format!("Failed to get OCR lines: {e}")))?;

        let mut ocr_lines = Vec::new();
        for line in lines {
            let line_text = line.Text().map(|s| s.to_string()).unwrap_or_default();

            // Get words for this line
            let words = line.Words().map_err(|e| {
                AutomationError::PlatformError(format!("Failed to get OCR words: {e}"))
            })?;

            let mut ocr_words = Vec::new();
            let mut line_bounds: Option<(f64, f64, f64, f64)> = None;

            for word in words {
                let word_text = word.Text().map(|s| s.to_string()).unwrap_or_default();

                // Get bounding rectangle and convert to absolute screen coordinates
                // OCR returns physical pixel coords in screenshot space
                // We need to convert to logical screen coords: physical/dpi_scale + window_logical_offset
                let rect = word.BoundingRect().map_err(|e| {
                    AutomationError::PlatformError(format!("Failed to get word bounds: {e}"))
                })?;

                let word_bounds = (
                    window_x + (rect.X as f64 / dpi_scale_x),
                    window_y + (rect.Y as f64 / dpi_scale_y),
                    rect.Width as f64 / dpi_scale_x,
                    rect.Height as f64 / dpi_scale_y,
                );

                // Update line bounds to encompass all words
                line_bounds = Some(match line_bounds {
                    None => word_bounds,
                    Some((lx, ly, lw, lh)) => {
                        let new_x = lx.min(word_bounds.0);
                        let new_y = ly.min(word_bounds.1);
                        let new_right = (lx + lw).max(word_bounds.0 + word_bounds.2);
                        let new_bottom = (ly + lh).max(word_bounds.1 + word_bounds.3);
                        (new_x, new_y, new_right - new_x, new_bottom - new_y)
                    }
                });

                ocr_words.push(OcrElement::new_word(word_text, word_bounds, None));
            }

            ocr_lines.push(OcrElement::new_line(line_text, line_bounds, ocr_words));
        }

        Ok(OcrElement::new_result(full_text, text_angle, ocr_lines))
    }
}

#[async_trait::async_trait]
impl AccessibilityEngine for WindowsEngine {
    fn get_root_element(&self) -> UIElement {
        let root = self.get_root_element_with_retry()
            .unwrap_or_else(|e| {
                panic!("Failed to get UI root element at {}:{} - Windows UI Automation may be unavailable: {:?}",
                       file!(), line!(), e)
            });
        let arc_root = ThreadSafeWinUIElement(root);
        UIElement::new(Box::new(WindowsUIElement {
            element: arc_root,
            engine: None, // Root element doesn't need engine reference
        }))
    }

    fn get_element_by_id(&self, id: i32) -> Result<UIElement, AutomationError> {
        let root_element = self.get_root_element_with_retry().map_err(|e| {
            AutomationError::PlatformError(format!(
                "Failed to get root element for ID lookup at {}:{}: {:?}",
                file!(),
                line!(),
                e
            ))
        })?;
        let condition = self
            .automation
            .0
            .create_property_condition(UIProperty::ProcessId, Variant::from(id), None)
            .map_err(|e| {
                AutomationError::PlatformError(format!(
                    "Failed to create ProcessId condition for ID {} at {}:{}: {:?}",
                    id,
                    file!(),
                    line!(),
                    e
                ))
            })?;
        let ele = root_element
            .find_first(TreeScope::Subtree, &condition)
            .map_err(|e| AutomationError::ElementNotFound(e.to_string()))?;
        let arc_ele = ThreadSafeWinUIElement(Arc::new(ele));

        Ok(UIElement::new(Box::new(WindowsUIElement {
            element: arc_ele,
            engine: None, // These are lookup operations, don't need engine reference
        })))
    }

    fn get_focused_element(&self) -> Result<UIElement, AutomationError> {
        let element = self
            .automation
            .0
            .get_focused_element()
            .map_err(|e| AutomationError::ElementNotFound(e.to_string()))?;
        let arc_element = ThreadSafeWinUIElement(Arc::new(element));

        Ok(UIElement::new(Box::new(WindowsUIElement {
            element: arc_element,
            engine: None, // Focused element lookup doesn't need engine reference
        })))
    }

    fn get_applications(&self) -> Result<Vec<UIElement>, AutomationError> {
        let root = self.get_root_element_with_retry().map_err(|e| {
            AutomationError::PlatformError(format!(
                "Failed to get root element for applications at {}:{}: {:?}",
                file!(),
                line!(),
                e
            ))
        })?;

        // OPTIMIZATION: Use Children scope instead of Subtree to avoid deep tree traversal
        // Most applications are direct children of the desktop
        let condition_win = self
            .automation
            .0
            .create_property_condition(
                UIProperty::ControlType,
                Variant::from(ControlType::Window as i32),
                None,
            )
            .map_err(|e| {
                AutomationError::PlatformError(format!(
                    "Failed to create Window condition at {}:{}: {:?}",
                    file!(),
                    line!(),
                    e
                ))
            })?;

        let condition_pane = self
            .automation
            .0
            .create_property_condition(
                UIProperty::ControlType,
                Variant::from(ControlType::Pane as i32),
                None,
            )
            .map_err(|e| {
                AutomationError::PlatformError(format!(
                    "Failed to create Pane condition at {}:{}: {:?}",
                    file!(),
                    line!(),
                    e
                ))
            })?;

        let condition = self
            .automation
            .0
            .create_or_condition(condition_win, condition_pane)
            .map_err(|e| {
                AutomationError::PlatformError(format!(
                    "Failed to create OR condition at {}:{}: {:?}",
                    file!(),
                    line!(),
                    e
                ))
            })?;

        let elements = root
            .find_all(TreeScope::Children, &condition)
            .map_err(|e| AutomationError::ElementNotFound(e.to_string()))?;

        // OPTIMIZATION: Filter out windows with same pid to reduce processing
        let mut seen_pids = std::collections::HashSet::new();
        let filtered_elements: Vec<uiautomation::UIElement> = elements
            .into_iter()
            .filter(|ele| {
                // include windows with names, this way we'd all the opened applications
                if let Ok(pid) = ele.get_process_id() {
                    if seen_pids.insert(pid) {
                        // include only elements with unique PIDs
                        if let Ok(name) = ele.get_name() {
                            !name.is_empty()
                        } else {
                            false
                        }
                    } else {
                        false
                    }
                } else {
                    false
                }
            })
            .collect();

        debug!("Found '{}' application windows", filtered_elements.len());

        let arc_elements: Vec<UIElement> = filtered_elements
            .into_iter()
            .map(|ele| {
                let arc_ele = ThreadSafeWinUIElement(Arc::new(ele));
                UIElement::new(Box::new(WindowsUIElement {
                    element: arc_ele,
                    engine: None,
                }))
            })
            .collect();

        Ok(arc_elements)
    }

    fn get_application_by_name(&self, name: &str) -> Result<UIElement, AutomationError> {
        applications::get_application_by_name(self, name)
    }

    fn get_application_by_pid(
        &self,
        pid: i32,
        timeout: Option<Duration>,
    ) -> Result<UIElement, AutomationError> {
        applications::get_application_by_pid(self, pid, timeout)
    }

    fn find_elements(
        &self,
        selector: &Selector,
        root: Option<&UIElement>,
        timeout: Option<Duration>,
        depth: Option<usize>,
    ) -> Result<Vec<UIElement>, AutomationError> {
        // Enforce scoping: desktop-wide search requires process selector when root is None
        if root.is_none() && !selector_has_process_scope(selector) {
            return Err(AutomationError::InvalidSelector(format!(
                "Desktop-wide search not allowed. Selector must include 'process:' prefix to scope search to a specific application.\n\
                 Examples:\n\
                 - process:chrome >> role:Button && name:Submit\n\
                 - process:notepad >> role:Document\n\
                 - process:explorer >> role:Icon && name:Recycle Bin (for desktop icons/taskbar)\n\
                 Or use element.locator() to search within a specific element's tree.\n\
                 Current selector: {selector:?}"
            )));
        }

        let root_ele = if let Some(el) = root {
            if let Some(ele) = el.as_any().downcast_ref::<WindowsUIElement>() {
                &ele.element.0
            } else {
                &Arc::new(self.get_root_element_with_retry().map_err(|e| {
                    let error_str = format!("{e:?}");
                    let com_error_code = extract_com_error_code(&error_str);

                    if let Some(hresult) = com_error_code {
                        AutomationError::UIAutomationAPIError {
                            message: format!(
                                "Windows UI Automation API failed to get root element: {e:?}"
                            ),
                            com_error: Some(hresult),
                            operation: "get_root_element".to_string(),
                            is_retryable: matches!(
                                hresult,
                                -2147467259 /* E_FAIL */ | -2147467262 /* E_NOINTERFACE */
                            ),
                        }
                    } else {
                        AutomationError::PlatformError(format!(
                            "Failed to get root element for selector search at {}:{}: {:?}",
                            file!(),
                            line!(),
                            e
                        ))
                    }
                })?)
            }
        } else {
            &Arc::new(self.get_root_element_with_retry().map_err(|e| {
                let error_str = format!("{e:?}");
                let com_error_code = extract_com_error_code(&error_str);

                if let Some(hresult) = com_error_code {
                    AutomationError::UIAutomationAPIError {
                        message: format!(
                            "Windows UI Automation API failed to get root element: {e:?}"
                        ),
                        com_error: Some(hresult),
                        operation: "get_root_element".to_string(),
                        is_retryable: matches!(
                            hresult,
                            -2147467259 /* E_FAIL */ | -2147467262 /* E_NOINTERFACE */
                        ),
                    }
                } else {
                    AutomationError::PlatformError(format!(
                        "Failed to get root element for selector search at {}:{}: {:?}",
                        file!(),
                        line!(),
                        e
                    ))
                }
            })?)
        };

        let timeout_ms = timeout.unwrap_or(DEFAULT_FIND_TIMEOUT).as_millis() as u32;

        // make condition according to selector
        match selector {
            // Boolean operators: And, Or, Not
            Selector::And(selectors) => {
                if selectors.is_empty() {
                    return Ok(Vec::new());
                }

                // For AND, we need to find elements that match ALL conditions
                // We can't just intersect separate sets because that would only work if
                // the elements are found by each selector independently.
                // Instead, we need to check each element against all conditions.

                // First, we need to get all candidate elements. We'll use a broad search
                // and then filter. The challenge is determining what "all elements" means.
                // We'll use the first selector to get candidates, then filter by the rest.

                // Get initial candidates from the first selector
                let candidates = self.find_elements(&selectors[0], root, timeout, depth)?;

                // Filter candidates by checking if they match ALL remaining selectors
                let mut results = Vec::new();
                for candidate in candidates {
                    let mut matches_all = true;

                    // Check if this candidate matches all other selectors
                    for sel in &selectors[1..] {
                        if !self.element_matches_selector(&candidate, sel)? {
                            matches_all = false;
                            break;
                        }
                    }

                    if matches_all {
                        results.push(candidate);
                    }
                }

                Ok(results)
            }
            Selector::Or(selectors) => {
                let mut seen = std::collections::HashSet::new();
                let mut results = Vec::new();

                for sel in selectors {
                    match self.find_elements(sel, root, timeout, depth) {
                        Ok(elements) => {
                            for el in elements {
                                if seen.insert(el.clone()) {
                                    results.push(el);
                                }
                            }
                        }
                        Err(AutomationError::ElementNotFound(_)) => {
                            // Continue trying other selectors
                            continue;
                        }
                        Err(e) => return Err(e),
                    }
                }

                if results.is_empty() {
                    return Err(AutomationError::ElementNotFound(
                        "No element matched any OR condition".to_string(),
                    ));
                }

                Ok(results)
            }
            Selector::Not(inner_selector) => {
                // Get all elements in scope
                let all_elements = self.find_elements(
                    &Selector::Role {
                        role: "*".to_string(),
                        name: None,
                    },
                    root,
                    timeout,
                    depth,
                )?;

                // Get elements matching the NOT condition
                let excluded_set: std::collections::HashSet<UIElement> =
                    match self.find_elements(inner_selector, root, timeout, depth) {
                        Ok(elements) => elements.into_iter().collect(),
                        Err(AutomationError::ElementNotFound(_)) => {
                            // Nothing to exclude - return all elements
                            return Ok(all_elements);
                        }
                        Err(e) => return Err(e),
                    };

                // Filter out excluded elements
                Ok(all_elements
                    .into_iter()
                    .filter(|el| !excluded_set.contains(el))
                    .collect())
            }
            Selector::Role { role, name } => {
                let win_control_type = map_generic_role_to_win_roles(role);
                // Use optimized depth for containers when appropriate
                let actual_depth = calculate_search_depth(role, name, root, depth);

                debug!(
                    "searching elements by role: {:?} (from: {}), name_filter: {:?}, depth: {:?} (actual: {}), timeout: {}ms, within: {:?}",
                    win_control_type,
                    role,
                    name,
                    depth,
                    actual_depth,
                    timeout_ms,
                    root_ele.get_name().unwrap_or_default()
                );

                let mut matcher_builder = self
                    .automation
                    .0
                    .create_matcher()
                    .from_ref(root_ele)
                    .control_type(win_control_type)
                    .depth(actual_depth)
                    .timeout(timeout_ms as u64);

                if let Some(name) = name {
                    // use contains_name, its undetermined right now
                    // wheather we should use `name` or `contains_name`
                    matcher_builder = matcher_builder.contains_name(name);
                }

                let elements = matcher_builder.find_all().map_err(|e| {
                    AutomationError::ElementNotFound(format!(
                        "Role: '{role}' (mapped to {win_control_type:?}), Name: {name:?}, Err: {e}"
                    ))
                })?;

                debug!(
                    "found {} elements with role: {} (mapped to {:?}), name_filter: {:?}",
                    elements.len(),
                    role,
                    win_control_type,
                    name
                );

                Ok(elements
                    .into_iter()
                    .map(|ele| {
                        UIElement::new(Box::new(WindowsUIElement {
                            element: ThreadSafeWinUIElement(Arc::new(ele)),
                            engine: None,
                        }))
                    })
                    .collect())
            }
            Selector::Id(id) => {
                debug!("Searching for element with ID: {}", id);
                // Clone id to move into the closure
                let target_id = id.strip_prefix('#').unwrap_or(id).to_string();
                let matcher = self
                    .automation
                    .0
                    .create_matcher()
                    .from_ref(root_ele)
                    .depth(depth.unwrap_or(50) as u32)
                    .filter_fn(Box::new(move |e: &uiautomation::UIElement| {
                        // Use the common function to generate ID
                        match generate_element_id(e)
                            .map(|id| id.to_string().chars().take(6).collect::<String>())
                        {
                            Ok(calculated_id) => {
                                let matches = calculated_id == target_id;
                                if matches {
                                    debug!("Found matching element with ID: {}", calculated_id);
                                }
                                Ok(matches)
                            }
                            Err(e) => {
                                debug!("Failed to generate ID for element: {}", e);
                                Ok(false)
                            }
                        }
                    }))
                    .timeout(timeout_ms as u64);

                debug!("Starting element search with timeout: {}ms", timeout_ms);
                let elements = matcher.find_all().map_err(|e| {
                    debug!("Element search failed: {}", e);
                    AutomationError::ElementNotFound(format!("ID: '{id}', Err: {e}"))
                })?;

                debug!("Found {} elements matching ID: {}", elements.len(), id);
                let collected_elements: Vec<UIElement> = elements
                    .into_iter()
                    .map(|ele| {
                        UIElement::new(Box::new(WindowsUIElement {
                            element: ThreadSafeWinUIElement(Arc::new(ele)),
                            engine: None,
                        }))
                    })
                    .collect();

                Ok(collected_elements)
            }
            Selector::Name(name) => {
                debug!("searching element by name: {}", name);
                // name: selector is case-insensitive partial match
                let filter = NameFilter {
                    value: String::from(name),
                    casesensitive: false,
                    partial: true,
                };
                let matcher = self
                    .automation
                    .0
                    .create_matcher()
                    .from_ref(root_ele)
                    .filter(Box::new(filter))
                    .depth(depth.unwrap_or(50) as u32)
                    .timeout(timeout_ms as u64);

                let elements = matcher.find_all().map_err(|e| {
                    AutomationError::ElementNotFound(format!("Name: '{name}', Err: {e}"))
                })?;

                Ok(elements
                    .into_iter()
                    .map(|ele| {
                        UIElement::new(Box::new(WindowsUIElement {
                            element: ThreadSafeWinUIElement(Arc::new(ele)),
                            engine: None,
                        }))
                    })
                    .collect())
            }
            Selector::Text(text) => {
                // text: selector is case-sensitive partial match + bypasses boolean parser
                let filter = NameFilter {
                    value: String::from(text),
                    casesensitive: true,
                    partial: true,
                };
                let matcher = self
                    .automation
                    .0
                    .create_matcher()
                    .from_ref(root_ele)
                    .filter(Box::new(filter))
                    .depth(depth.unwrap_or(50) as u32)
                    .timeout(timeout_ms as u64); // Allow enough time for search

                // Get the first matching element
                let elements = matcher.find_all().map_err(|e| {
                    AutomationError::ElementNotFound(format!("Text: '{text}', Err: {e}"))
                })?;

                Ok(elements
                    .into_iter()
                    .map(|ele| {
                        UIElement::new(Box::new(WindowsUIElement {
                            element: ThreadSafeWinUIElement(Arc::new(ele)),
                            engine: None,
                        }))
                    })
                    .collect())
            }
            Selector::Process(process_name) => {
                info!(
                    "[CRASH_DEBUG] Selector::Process started for: {}",
                    process_name
                );

                // Get root element
                let root_ele = self.get_root_element_with_retry().map_err(|e| {
                    warn!("[CRASH_DEBUG] get_root_element_with_retry failed: {:?}", e);
                    AutomationError::PlatformError(format!(
                        "Failed to get root element for process selector: {e:?}"
                    ))
                })?;
                info!("[CRASH_DEBUG] Got root element successfully");

                // Create condition to find Window or Pane elements
                let condition_win = self
                    .automation
                    .0
                    .create_property_condition(
                        UIProperty::ControlType,
                        Variant::from(ControlType::Window as i32),
                        None,
                    )
                    .map_err(|e| {
                        AutomationError::PlatformError(format!(
                            "Failed to create Window condition for process selector: {e:?}"
                        ))
                    })?;

                let condition_pane = self
                    .automation
                    .0
                    .create_property_condition(
                        UIProperty::ControlType,
                        Variant::from(ControlType::Pane as i32),
                        None,
                    )
                    .map_err(|e| {
                        AutomationError::PlatformError(format!(
                            "Failed to create Pane condition for process selector: {e:?}"
                        ))
                    })?;

                let condition = self
                    .automation
                    .0
                    .create_or_condition(condition_win, condition_pane)
                    .map_err(|e| {
                        AutomationError::PlatformError(format!(
                            "Failed to create OR condition for process selector: {e:?}"
                        ))
                    })?;

                // Find all windows/panes
                info!("[CRASH_DEBUG] Calling find_all for windows/panes");
                let elements = root_ele
                    .find_all(TreeScope::Children, &condition)
                    .map_err(|e| {
                        warn!("[CRASH_DEBUG] find_all failed: {}", e);
                        AutomationError::ElementNotFound(format!(
                            "Failed to find windows for process selector: {e}"
                        ))
                    })?;
                info!(
                    "[CRASH_DEBUG] find_all returned {} elements",
                    elements.len()
                );

                // Filter elements by process name
                let expected_lower = process_name.to_lowercase();
                let mut processed_count = 0;
                let filtered_elements: Vec<UIElement> = elements
                    .into_iter()
                    .filter_map(|ele| {
                        processed_count += 1;
                        if let Ok(pid) = ele.get_process_id() {
                            // Log every 10th element to avoid spam
                            if processed_count % 10 == 1 {
                                debug!("[CRASH_DEBUG] Processing element {}, PID {}", processed_count, pid);
                            }
                            // Wrap in catch_unwind to detect panics
                            let process_result = panic::catch_unwind(panic::AssertUnwindSafe(|| {
                                get_process_name_by_pid(pid as i32)
                            }));
                            let elem_process_name = match process_result {
                                Ok(Ok(name)) => name,
                                Ok(Err(_)) => return None, // Normal error, skip this element
                                Err(panic_info) => {
                                    error!("[CRASH_DEBUG] PANIC in get_process_name_by_pid for PID {}: {:?}", pid, panic_info);
                                    return None;
                                }
                            };
                            let elem_process_lower = elem_process_name.to_lowercase();
                            // Support both "chrome" and "chrome.exe" matching
                            // get_process_name_by_pid strips .exe, so "chrome" matches "chrome.exe"
                            if elem_process_lower == expected_lower
                                || elem_process_lower.starts_with(&expected_lower)
                                || expected_lower.starts_with(&elem_process_lower)
                            {
                                let arc_ele = ThreadSafeWinUIElement(Arc::new(ele));
                                return Some(UIElement::new(Box::new(WindowsUIElement {
                                    element: arc_ele,
                                    engine: None,
                                })));
                            }
                        }
                        None
                    })
                    .collect();

                info!(
                    "[CRASH_DEBUG] Filtering complete, processed {} elements, found {} matches",
                    processed_count,
                    filtered_elements.len()
                );

                if filtered_elements.is_empty() {
                    return Err(AutomationError::ElementNotFound(format!(
                        "No elements found for process: '{process_name}'"
                    )));
                }

                info!(
                    "[CRASH_DEBUG] Selector::Process completed: found {} elements for process: {}",
                    filtered_elements.len(),
                    process_name
                );

                Ok(filtered_elements)
            }
            Selector::Path(_) => Err(AutomationError::UnsupportedOperation(
                "`Path` selector not supported".to_string(),
            )),
            Selector::NativeId(automation_id) => {
                // for windows passing `UIProperty::AutomationID` as `NativeId`
                debug!(
                    "searching for elements using AutomationId: {}",
                    automation_id
                );

                let ele_id = automation_id.clone();
                let matcher = self
                    .automation
                    .0
                    .create_matcher()
                    .from_ref(root_ele)
                    .depth(depth.unwrap_or(500) as u32) // Increased default depth for deep web applications in browsers
                    .filter_fn(Box::new(move |e: &uiautomation::UIElement| {
                        match e.get_automation_id() {
                            Ok(id) => {
                                let matches = id == ele_id;
                                if matches {
                                    debug!(
                                        "found matching elements with AutomationID : {}",
                                        ele_id
                                    );
                                }
                                Ok(matches)
                            }
                            Err(err) => {
                                debug!("failed to get AutomationId: {}", err);
                                Ok(false)
                            }
                        }
                    }))
                    .timeout(timeout_ms as u64);

                debug!("searching elements with timeout: {}ms", timeout_ms);
                let elements = matcher.find_all().map_err(|e| {
                    debug!("Elements search failed: {}", e);
                    AutomationError::ElementNotFound(format!(
                        "AutomationId: '{automation_id}', Err: {e}"
                    ))
                })?;

                debug!(
                    "found {} elements matching AutomationID: {}",
                    elements.len(),
                    automation_id
                );
                let collected_elements: Vec<UIElement> = elements
                    .into_iter()
                    .map(|ele| {
                        UIElement::new(Box::new(WindowsUIElement {
                            element: ThreadSafeWinUIElement(Arc::new(ele)),
                            engine: None,
                        }))
                    })
                    .collect();
                Ok(collected_elements)
            }
            Selector::Attributes(attributes) => {
                // Use efficient filtering at UI Automation level
                let matcher = self
                    .automation
                    .0
                    .create_matcher()
                    .from_ref(root_ele)
                    .depth(depth.unwrap_or(50) as u32)
                    .filter_fn({
                        let attributes = attributes.clone();
                        Box::new(move |e: &uiautomation::UIElement| {
                            let mut matches = true;
                            for (key, expected_value) in &attributes {
                                let ui_property = match string_to_ui_property(key) {
                                    Some(prop) => prop,
                                    None => continue, // Skip unknown properties
                                };
                                let property_value = e.get_property_value(ui_property);
                                if let Ok(property_value) = property_value {
                                    let actual_value = property_value.to_string();
                                    if actual_value.to_lowercase() != expected_value.to_lowercase()
                                    {
                                        matches = false;
                                        break;
                                    }
                                } else {
                                    matches = false;
                                }
                            }
                            Ok(matches)
                        })
                    })
                    .timeout(timeout_ms as u64);

                let elements = matcher.find_all().map_err(|e| {
                    AutomationError::ElementNotFound(format!("Attributes search failed: {e}"))
                })?;

                Ok(elements
                    .into_iter()
                    .map(|ele| {
                        let arc_ele = ThreadSafeWinUIElement(Arc::new(ele));
                        UIElement::new(Box::new(WindowsUIElement {
                            element: arc_ele,
                            engine: None,
                        }))
                    })
                    .collect())
            }
            Selector::Filter(_filter) => Err(AutomationError::UnsupportedOperation(
                "`Filter` selector not supported".to_string(),
            )),
            Selector::Chain(selectors) => {
                if selectors.is_empty() {
                    return Err(AutomationError::InvalidArgument(
                        "Selector chain cannot be empty".to_string(),
                    ));
                }

                // Start with all elements matching the first selector in the chain.
                let mut current_results = self.find_elements(&selectors[0], root, timeout, None)?;

                // Sequentially apply the rest of the selectors.
                for (i, selector) in selectors.iter().skip(1).enumerate() {
                    if current_results.is_empty() {
                        // If at any point we have no results, the chain is broken.
                        return Err(AutomationError::ElementNotFound(format!(
                            "Selector chain broke at step {}: '{:?}' found no elements from the previous step's results.",
                            i + 1,
                            selector
                        )));
                    }

                    if let Selector::Nth(index) = selector {
                        let mut i = *index;
                        let len = current_results.len();

                        if i < 0 {
                            // Handle negative index
                            i += len as i32;
                        }

                        if i >= 0 && (i as usize) < len {
                            // Filter down to the single element at the specified index.
                            let selected = current_results.remove(i as usize);
                            current_results = vec![selected];
                        } else {
                            // Index out of bounds, no elements match.
                            current_results.clear();
                        }
                    } else {
                        // For other selectors, find all children that match from the current set of results.
                        let mut next_results = Vec::new();
                        for element_root in &current_results {
                            // Use a shorter timeout for sub-queries to avoid long delays on non-existent elements mid-chain.
                            let sub_timeout = Some(Duration::from_millis(1000));
                            match self.find_elements(
                                selector,
                                Some(element_root),
                                sub_timeout,
                                None, // Default depth for sub-queries
                            ) {
                                Ok(elements) => next_results.extend(elements),
                                Err(AutomationError::ElementNotFound(_)) => {
                                    // It's okay if one branch of the search finds nothing, continue with others.
                                }
                                Err(e) => return Err(e), // Propagate other critical errors.
                            }
                        }
                        current_results = next_results;
                    }
                }

                // After the chain, return all elements found (this is find_elements, not find_element)
                Ok(current_results)
            }
            Selector::ClassName(classname) => {
                debug!("searching elements by class name: {}", classname);
                let matcher = self
                    .automation
                    .0
                    .create_matcher()
                    .from_ref(root_ele)
                    .filter(Box::new(ClassNameFilter {
                        classname: classname.clone(),
                    }))
                    .depth(depth.unwrap_or(50) as u32)
                    .timeout(timeout_ms as u64);
                let elements = matcher.find_all().map_err(|e| {
                    AutomationError::ElementNotFound(format!("ClassName: '{classname}', Err: {e}"))
                })?;
                Ok(elements
                    .into_iter()
                    .map(|ele| {
                        UIElement::new(Box::new(WindowsUIElement {
                            element: ThreadSafeWinUIElement(Arc::new(ele)),
                            engine: None,
                        }))
                    })
                    .collect())
            }
            Selector::Visible(visibility) => {
                let visibility = *visibility;
                let matcher = self
                    .automation
                    .0
                    .create_matcher()
                    .from_ref(root_ele)
                    .depth(depth.unwrap_or(50) as u32)
                    .filter_fn(Box::new(move |e: &uiautomation::UIElement| {
                        match e.is_offscreen() {
                            Ok(is_offscreen) => Ok(is_offscreen != visibility),
                            Err(e) => {
                                debug!("failed to get visibility: {}", e);
                                Ok(false)
                            }
                        }
                    }))
                    .timeout(timeout_ms as u64);
                let elements = matcher.find_all().map_err(|e| {
                    AutomationError::ElementNotFound(format!("Visible: '{visibility}', Err: {e}"))
                })?;
                Ok(elements
                    .into_iter()
                    .map(|ele| {
                        UIElement::new(Box::new(WindowsUIElement {
                            element: ThreadSafeWinUIElement(Arc::new(ele)),
                            engine: None,
                        }))
                    })
                    .collect())
            }
            Selector::LocalizedRole(localized_role) => {
                debug!("searching elements by localized role: {}", localized_role);
                let lr = localized_role.clone();
                let matcher = self
                    .automation
                    .0
                    .create_matcher()
                    .from_ref(root_ele)
                    .depth(depth.unwrap_or(50) as u32)
                    .filter_fn(Box::new(move |e: &uiautomation::UIElement| {
                        match e.get_localized_control_type() {
                            Ok(lct) => Ok(lct == lr),
                            Err(_) => Ok(false),
                        }
                    }))
                    .depth(depth.unwrap_or(50) as u32)
                    .timeout(timeout_ms as u64);

                let elements = matcher.find_all().map_err(|e| {
                    AutomationError::ElementNotFound(format!(
                        "LocalizedRole: '{localized_role}', Err: {e}"
                    ))
                })?;

                Ok(elements
                    .into_iter()
                    .map(|ele| {
                        UIElement::new(Box::new(WindowsUIElement {
                            element: ThreadSafeWinUIElement(Arc::new(ele)),
                            engine: None,
                        }))
                    })
                    .collect())
            }
            Selector::RightOf(inner_selector)
            | Selector::LeftOf(inner_selector)
            | Selector::Above(inner_selector)
            | Selector::Below(inner_selector)
            | Selector::Near(inner_selector) => {
                // 1. Find the anchor element. Must be a single element.
                let anchor_element = self.find_element(inner_selector, root, timeout)?;
                let anchor_bounds = anchor_element.bounds()?; // (x, y, width, height)

                // 2. Get all candidate elements within the same root.
                // We use Visible(true) as a broad selector to find all potentially relevant elements.
                // A large depth is used to ensure we can find elements across the UI tree.
                let all_elements = self.find_elements(
                    &Selector::Visible(true),
                    root,
                    Some(Duration::from_millis(500)), // Use a short timeout for this broad query
                    Some(100),
                )?;

                // 3. Filter candidates based on geometric relationship
                let anchor_id = anchor_element.id();
                let filtered_elements = all_elements
                    .into_iter()
                    .filter(|candidate| {
                        // Don't include the anchor element itself in the results.
                        if candidate.id() == anchor_id {
                            return false;
                        }

                        if let Ok(candidate_bounds) = candidate.bounds() {
                            let anchor_left = anchor_bounds.0;
                            let anchor_top = anchor_bounds.1;
                            let anchor_right = anchor_bounds.0 + anchor_bounds.2;
                            let anchor_bottom = anchor_bounds.1 + anchor_bounds.3;

                            let candidate_left = candidate_bounds.0;
                            let candidate_top = candidate_bounds.1;
                            let candidate_right = candidate_bounds.0 + candidate_bounds.2;
                            let candidate_bottom = candidate_bounds.1 + candidate_bounds.3;

                            // Check for vertical overlap for left/right selectors
                            let vertical_overlap =
                                candidate_top < anchor_bottom && candidate_bottom > anchor_top;
                            // Check for horizontal overlap for above/below selectors
                            let horizontal_overlap =
                                candidate_left < anchor_right && candidate_right > anchor_left;

                            match selector {
                                Selector::RightOf(_) => {
                                    candidate_left >= anchor_right && vertical_overlap
                                }
                                Selector::LeftOf(_) => {
                                    candidate_right <= anchor_left && vertical_overlap
                                }
                                Selector::Above(_) => {
                                    candidate_bottom <= anchor_top && horizontal_overlap
                                }
                                Selector::Below(_) => {
                                    candidate_top >= anchor_bottom && horizontal_overlap
                                }
                                Selector::Near(_) => {
                                    const NEAR_THRESHOLD: f64 = 50.0;
                                    let anchor_center_x = anchor_bounds.0 + anchor_bounds.2 / 2.0;
                                    let anchor_center_y = anchor_bounds.1 + anchor_bounds.3 / 2.0;
                                    let candidate_center_x =
                                        candidate_bounds.0 + candidate_bounds.2 / 2.0;
                                    let candidate_center_y =
                                        candidate_bounds.1 + candidate_bounds.3 / 2.0;

                                    let dx = anchor_center_x - candidate_center_x;
                                    let dy = anchor_center_y - candidate_center_y;
                                    (dx * dx + dy * dy).sqrt() < NEAR_THRESHOLD
                                }
                                _ => false, // Should not happen
                            }
                        } else {
                            false
                        }
                    })
                    .collect();

                Ok(filtered_elements)
            }
            Selector::Has(inner_selector) => {
                // Step 1: collect all candidate elements under the current root (visibility filter for performance)
                let search_depth = depth.unwrap_or(50);

                let all_candidates = self.find_elements(
                    &Selector::Visible(true),
                    root,
                    timeout,
                    Some(search_depth),
                )?;

                let mut results = Vec::new();
                for candidate in all_candidates {
                    // For each candidate, search for at least one matching descendant
                    let descendants = self.find_elements(
                        inner_selector,
                        Some(&candidate),
                        Some(Duration::from_millis(500)),
                        Some(search_depth),
                    )?;

                    if !descendants.is_empty() {
                        results.push(candidate);
                    }
                }

                Ok(results)
            }
            Selector::Invalid(reason) => Err(AutomationError::InvalidSelector(reason.clone())),
            Selector::Nth(_) => Err(AutomationError::InvalidSelector(
                "Nth selector must be used as part of a chain (e.g. 'list >> nth=0')".to_string(),
            )),
            Selector::Parent => {
                // Get parent element using the existing parent() method
                if let Some(root_element) = root {
                    if let Some(windows_element) =
                        root_element.as_any().downcast_ref::<WindowsUIElement>()
                    {
                        match windows_element.parent() {
                            Ok(Some(parent_element)) => Ok(vec![parent_element]),
                            Ok(None) => {
                                debug!("No parent element found");
                                Ok(vec![]) // No parent found
                            }
                            Err(e) => {
                                debug!("Failed to get parent element: {}", e);
                                Ok(vec![]) // Error getting parent
                            }
                        }
                    } else {
                        Err(AutomationError::PlatformError(
                            "Invalid element type for parent navigation".to_string(),
                        ))
                    }
                } else {
                    Err(AutomationError::InvalidSelector(
                        "Parent selector requires a starting element".to_string(),
                    ))
                }
            }
        }
    }

    fn find_element(
        &self,
        selector: &Selector,
        root: Option<&UIElement>,
        timeout: Option<Duration>,
    ) -> Result<UIElement, AutomationError> {
        let root_ele = if let Some(el) = root {
            if let Some(ele) = el.as_any().downcast_ref::<WindowsUIElement>() {
                &ele.element.0
            } else {
                &Arc::new(self.get_root_element_with_retry().map_err(|e| {
                    let error_str = format!("{e:?}");
                    let com_error_code = extract_com_error_code(&error_str);

                    if let Some(hresult) = com_error_code {
                        AutomationError::UIAutomationAPIError {
                            message: format!(
                                "Windows UI Automation API failed to get root element: {e:?}"
                            ),
                            com_error: Some(hresult),
                            operation: "get_root_element".to_string(),
                            is_retryable: matches!(
                                hresult,
                                -2147467259 /* E_FAIL */ | -2147467262 /* E_NOINTERFACE */
                            ),
                        }
                    } else {
                        AutomationError::PlatformError(format!(
                            "Failed to get root element for selector search at {}:{}: {:?}",
                            file!(),
                            line!(),
                            e
                        ))
                    }
                })?)
            }
        } else {
            &Arc::new(self.get_root_element_with_retry().map_err(|e| {
                let error_str = format!("{e:?}");
                let com_error_code = extract_com_error_code(&error_str);

                if let Some(hresult) = com_error_code {
                    AutomationError::UIAutomationAPIError {
                        message: format!(
                            "Windows UI Automation API failed to get root element: {e:?}"
                        ),
                        com_error: Some(hresult),
                        operation: "get_root_element".to_string(),
                        is_retryable: matches!(
                            hresult,
                            -2147467259 /* E_FAIL */ | -2147467262 /* E_NOINTERFACE */
                        ),
                    }
                } else {
                    AutomationError::PlatformError(format!(
                        "Failed to get root element for selector search at {}:{}: {:?}",
                        file!(),
                        line!(),
                        e
                    ))
                }
            })?)
        };

        let timeout_ms = timeout.unwrap_or(DEFAULT_FIND_TIMEOUT).as_millis() as u32;

        match selector {
            // Boolean operators - delegate to find_elements and take first result
            Selector::And(_) | Selector::Or(_) | Selector::Not(_) => {
                let elements = self.find_elements(selector, root, timeout, None)?;
                elements
                    .into_iter()
                    .next()
                    .ok_or_else(|| AutomationError::ElementNotFound("No element found".to_string()))
            }
            // Process selector - delegate to find_elements and take first result
            Selector::Process(_) => {
                let elements = self.find_elements(selector, root, timeout, None)?;
                elements.into_iter().next().ok_or_else(|| {
                    AutomationError::ElementNotFound("No element found for process".to_string())
                })
            }
            Selector::Role { role, name } => {
                let win_control_type = map_generic_role_to_win_roles(role);
                // Use optimized depth for containers when appropriate
                let actual_depth = calculate_search_depth(role, name, root, None);

                debug!(
                    "searching element by role: {:?} (from: {}), name_filter: {:?}, depth: {}, timeout: {}ms, within: {:?}",
                    win_control_type,
                    role,
                    name,
                    actual_depth,
                    timeout_ms,
                    root_ele.get_name().unwrap_or_default()
                );

                let mut matcher_builder = self
                    .automation
                    .0
                    .create_matcher()
                    .from_ref(root_ele)
                    .control_type(win_control_type)
                    .depth(actual_depth)
                    .timeout(timeout_ms as u64);

                if let Some(name) = name {
                    // use contains_name, its undetermined right now
                    // wheather we should use `name` or `contains_name`
                    matcher_builder = matcher_builder.filter(Box::new(NameFilter {
                        value: name.clone(),
                        casesensitive: false,
                        partial: true,
                    }));
                }

                let element = matcher_builder.find_first().map_err(|e| {
                    AutomationError::ElementNotFound(format!(
                        "Role: '{role}' (mapped to {win_control_type:?}), Name: {name:?}, Root: {root:?}, Err: {e}"
                    ))
                })?;

                let arc_ele = ThreadSafeWinUIElement(Arc::new(element));
                Ok(UIElement::new(Box::new(WindowsUIElement {
                    element: arc_ele,
                    engine: None,
                })))
            }
            Selector::Id(id) => {
                debug!("Searching for element with ID: {}", id);
                // Clone id to move into the closure
                let target_id = id.strip_prefix('#').unwrap_or(id).to_string();
                let matcher = self
                    .automation
                    .0
                    .create_matcher()
                    .from_ref(root_ele)
                    .depth(50)
                    .filter_fn(Box::new(move |e: &uiautomation::UIElement| {
                        // Use the common function to generate ID
                        match generate_element_id(e)
                            .map(|id| id.to_string().chars().take(6).collect::<String>())
                        {
                            Ok(calculated_id) => {
                                let matches = calculated_id == target_id;
                                if matches {
                                    debug!("Found matching element with ID: {}", calculated_id);
                                }
                                Ok(matches)
                            }
                            Err(e) => {
                                debug!("Failed to generate ID for element: {}", e);
                                Ok(false)
                            }
                        }
                    }))
                    .timeout(timeout_ms as u64);

                debug!("Starting element search with timeout: {}ms", timeout_ms);
                let element = matcher.find_first().map_err(|e| {
                    debug!("Element search failed: {}", e);
                    AutomationError::ElementNotFound(format!("ID: '{id}', Err: {e}"))
                })?;

                debug!("Found element matching ID: {}", id);
                let arc_ele = ThreadSafeWinUIElement(Arc::new(element));
                Ok(UIElement::new(Box::new(WindowsUIElement {
                    element: arc_ele,
                    engine: None,
                })))
            }
            Selector::Name(name) => {
                debug!("searching element by name: {}", name);
                // name: selector is case-insensitive partial match
                let filter = NameFilter {
                    value: String::from(name),
                    casesensitive: false,
                    partial: true,
                };
                let matcher = self
                    .automation
                    .0
                    .create_matcher()
                    .from_ref(root_ele)
                    .filter(Box::new(filter))
                    .depth(50)
                    .timeout(timeout_ms as u64);

                let element = matcher.find_first().map_err(|e| {
                    AutomationError::ElementNotFound(format!("Name: '{name}', Err: {e}"))
                })?;

                let arc_ele = ThreadSafeWinUIElement(Arc::new(element));
                Ok(UIElement::new(Box::new(WindowsUIElement {
                    element: arc_ele,
                    engine: None,
                })))
            }
            Selector::Text(text) => {
                // text: selector is case-sensitive partial match + bypasses boolean parser
                let filter = NameFilter {
                    value: String::from(text),
                    casesensitive: true,
                    partial: true,
                };
                let matcher = self
                    .automation
                    .0
                    .create_matcher()
                    .from_ref(root_ele)
                    .filter(Box::new(filter))
                    .depth(50)
                    .timeout(timeout_ms as u64);

                let element = matcher.find_first().map_err(|e| {
                    AutomationError::ElementNotFound(format!(
                        "Text: '{text}', Root: {root:?}, Err: {e}"
                    ))
                })?;

                let arc_ele = ThreadSafeWinUIElement(Arc::new(element));
                Ok(UIElement::new(Box::new(WindowsUIElement {
                    element: arc_ele,
                    engine: None,
                })))
            }
            Selector::Path(path) => {
                // so this implementation is something like this, it'll get the first node from the root with
                // the correct index and use that first node as root to get the second node with correct index
                // & it does that so on, the node name is the ControlType of the element with the index of it
                // `Path` can represent only one element at the time so doesn't need to implement in `find_elements`
                // the drawback of `Path` is that it'll change after the ui changes

                if path.is_empty() {
                    return Err(AutomationError::InvalidArgument(
                        "Path cannot be empty".to_string(),
                    ));
                }

                let mut current_element = root_ele.clone();
                let segments = match super::utils::parse_path(path) {
                    Some(s) => s,
                    None => {
                        return Err(AutomationError::PlatformError(format!(
                            "Failed to parse path, make sure its is in correct format & latest updated with ui: '{path}'",
                        )));
                    }
                };

                // traverse each segment
                for segment in segments {
                    let condition = self
                        .automation
                        .0
                        .create_property_condition(
                            UIProperty::ControlType,
                            Variant::from(segment.control_type as i32),
                            None,
                        )
                        .map_err(|e| AutomationError::PlatformError(
                            format!("Failed to create ControlType condition for path segment at {}:{}: {:?}",
                                    file!(), line!(), e)
                        ))?;

                    // avoid using matcher, for no depth limit
                    // & traverse only Children instead of whole Subtree
                    let children = current_element
                        .find_all(TreeScope::Children, &condition)
                        .map_err(|e| {
                            AutomationError::ElementNotFound(format!(
                                "Failed to find elements from given path: '{path}', Err: {e}"
                            ))
                        })?;

                    if children.len() < segment.index {
                        return Err(AutomationError::PlatformError(format!(
                            "Failed to find {:?}[{}], only {} elements matched",
                            segment.control_type,
                            segment.index,
                            children.len()
                        )));
                    }
                    current_element = Arc::new(children[segment.index - 1].clone());
                    // cuz 1-based
                }

                let arc_ele = ThreadSafeWinUIElement(current_element);
                Ok(UIElement::new(Box::new(WindowsUIElement {
                    element: arc_ele,
                    engine: None,
                })))
            }
            Selector::NativeId(automation_id) => {
                // for windows passing `UIProperty::AutomationID` as `NativeId`
                debug!(
                    "searching for element using AutomationId: {}",
                    automation_id
                );

                let ele_id = automation_id.clone();
                let matcher = self
                    .automation
                    .0
                    .create_matcher()
                    .from_ref(root_ele)
                    .depth(500) // Increased depth for deep web applications in browsers
                    .filter_fn(Box::new(move |e: &uiautomation::UIElement| {
                        match e.get_automation_id() {
                            Ok(id) => {
                                let matches = id == ele_id;
                                if matches {
                                    debug!("found matching element with AutomationID : {}", ele_id);
                                }
                                Ok(matches)
                            }
                            Err(err) => {
                                debug!("failed to get AutomationId: {}", err);
                                Ok(false)
                            }
                        }
                    }))
                    .timeout(timeout_ms as u64);

                debug!("searching element with timeout: {}ms", timeout_ms);

                let element = matcher.find_first().map_err(|e| {
                    debug!("Element search failed: {}", e);
                    AutomationError::ElementNotFound(format!(
                        "AutomationId: '{automation_id}', Err: {e}"
                    ))
                })?;

                let arc_ele = ThreadSafeWinUIElement(Arc::new(element));
                Ok(UIElement::new(Box::new(WindowsUIElement {
                    element: arc_ele,
                    engine: None,
                })))
            }
            Selector::Attributes(attributes) => {
                // Get all elements first, then filter by properties
                let matcher = self
                    .automation
                    .0
                    .create_matcher()
                    .from_ref(root_ele)
                    .depth(50)
                    .filter_fn({
                        let attributes = attributes.clone();
                        Box::new(move |e: &uiautomation::UIElement| {
                            let mut matches = true;
                            for (key, expected_value) in &attributes {
                                let ui_property = match string_to_ui_property(key) {
                                    Some(prop) => prop,
                                    None => continue, // Skip unknown properties
                                };
                                let property_value = e.get_property_value(ui_property);
                                if let Ok(property_value) = property_value {
                                    let actual_value = property_value.to_string();
                                    if actual_value.to_lowercase() != expected_value.to_lowercase()
                                    {
                                        matches = false;
                                        break;
                                    }
                                } else {
                                    matches = false;
                                }
                            }
                            Ok(matches)
                        })
                    })
                    .timeout(timeout_ms as u64);

                let element = matcher.find_first().map_err(|e| {
                    AutomationError::ElementNotFound(format!("Failed to get elements: {e}"))
                })?;

                Ok(UIElement::new(Box::new(WindowsUIElement {
                    element: ThreadSafeWinUIElement(Arc::new(element)),
                    engine: None,
                })))
            }
            Selector::Filter(_filter) => Err(AutomationError::UnsupportedOperation(
                "`Filter` selector not supported".to_string(),
            )),
            Selector::Chain(selectors) => {
                if selectors.is_empty() {
                    return Err(AutomationError::InvalidArgument(
                        "Selector chain cannot be empty".to_string(),
                    ));
                }

                debug!(
                    "Processing chain selector with optimized depth-first search: {:?}",
                    selectors
                );

                // Check if the chain ends with Nth selector
                // When a chain ends with Nth, it should select from the collection, not get children
                if let Some(Selector::Nth(index)) = selectors.last() {
                    debug!(
                        "Chain ends with Nth({}), applying to collection from previous selectors",
                        index
                    );

                    // Build a chain without the last Nth selector
                    let collection_selectors = &selectors[..selectors.len() - 1];

                    // Get all elements matching the chain up to (but not including) the Nth
                    let mut elements = if collection_selectors.len() == 1 {
                        // Single selector before Nth
                        self.find_elements(&collection_selectors[0], root, timeout, None)?
                    } else {
                        // Multiple selectors before Nth - need to evaluate the chain
                        // We'll use find_elements on the sub-chain
                        let sub_chain = Selector::Chain(collection_selectors.to_vec());
                        self.find_elements(&sub_chain, root, timeout, None)?
                    };

                    let mut idx = *index;
                    let len = elements.len() as i32;

                    if idx < 0 {
                        idx += len; // Handle negative indexing
                    }

                    if idx >= 0 && idx < len {
                        return Ok(elements.remove(idx as usize));
                    } else {
                        return Err(AutomationError::ElementNotFound(format!(
                            "Nth index {index} out of bounds (found {len} elements)"
                        )));
                    }
                }

                // Get all potential starting points (elements matching first selector)
                let starting_elements = self.find_elements(&selectors[0], root, timeout, None)?;

                if starting_elements.is_empty() {
                    return Err(AutomationError::ElementNotFound(format!(
                        "First selector in chain '{:?}' found no elements",
                        selectors[0]
                    )));
                }

                debug!(
                    "Found {} potential starting elements for chain",
                    starting_elements.len()
                );

                // Try to complete the chain from each starting element (depth-first)
                for (start_idx, start_element) in starting_elements.iter().enumerate() {
                    debug!(
                        "Trying chain from starting element {} of {}",
                        start_idx + 1,
                        starting_elements.len()
                    );

                    // Try to traverse the rest of the chain from this starting point
                    let mut current_element = start_element.clone();
                    let mut chain_valid = true;

                    for (step_idx, selector) in selectors.iter().skip(1).enumerate() {
                        // Use a shorter timeout for sub-queries to fail fast
                        let sub_timeout = Some(Duration::from_millis(1000));

                        match selector {
                            Selector::Nth(index) => {
                                // For Nth selector, we need to get ALL children and pick the Nth
                                debug!(
                                    "Processing Nth({}) selector in chain at step {}",
                                    index,
                                    step_idx + 2
                                );

                                // We need a parent selector to apply Nth to
                                // This is a bit tricky - we need to know what elements to get the Nth of
                                // Usually this follows another selector that defines the collection
                                // For now, we'll treat this as getting all children of any type

                                // Get all direct children (using a generic matcher)
                                let condition = self.automation.0.create_true_condition()
                                    .map_err(|e| AutomationError::PlatformError(
                                        format!("Failed to create true condition for Nth selector at step {} - {}:{}: {:?}",
                                                step_idx + 2, file!(), line!(), e)
                                    ))?;

                                let win_element = current_element
                                    .as_any()
                                    .downcast_ref::<WindowsUIElement>()
                                    .ok_or_else(|| {
                                        AutomationError::PlatformError(
                                            "Invalid element type".to_string(),
                                        )
                                    })?;

                                let children = win_element
                                    .element
                                    .0
                                    .find_all(TreeScope::Children, &condition)
                                    .map_err(|e| {
                                        AutomationError::ElementNotFound(format!(
                                            "Failed to get children for Nth: {e}"
                                        ))
                                    })?;

                                let mut idx = *index;
                                let len = children.len() as i32;

                                if idx < 0 {
                                    idx += len; // Handle negative indexing
                                }

                                if idx >= 0 && idx < len {
                                    let selected = &children[idx as usize];
                                    current_element = UIElement::new(Box::new(WindowsUIElement {
                                        element: ThreadSafeWinUIElement(Arc::new(selected.clone())),
                                        engine: None,
                                    }));
                                } else {
                                    debug!(
                                        "Nth index {} out of bounds (found {} children)",
                                        index, len
                                    );
                                    chain_valid = false;
                                    break;
                                }
                            }
                            _ => {
                                // For other selectors, use find_element to get just the FIRST match
                                debug!(
                                    "Processing {:?} selector in chain at step {}",
                                    selector,
                                    step_idx + 2
                                );

                                match self.find_element(
                                    selector,
                                    Some(&current_element),
                                    sub_timeout,
                                ) {
                                    Ok(element) => {
                                        current_element = element;
                                    }
                                    Err(_) => {
                                        debug!(
                                            "Chain broken at step {} with selector {:?}",
                                            step_idx + 2,
                                            selector
                                        );
                                        chain_valid = false;
                                        break;
                                    }
                                }
                            }
                        }
                    }

                    if chain_valid {
                        debug!(
                            "Successfully completed chain from starting element {}",
                            start_idx + 1
                        );
                        return Ok(current_element);
                    }
                }

                // If we've tried all starting elements and none completed the chain
                Err(AutomationError::ElementNotFound(format!(
                    "Selector chain `{:?}` could not be completed from any of the {} starting elements",
                    selectors,
                    starting_elements.len()
                )))
            }
            Selector::ClassName(classname) => {
                debug!("searching element by class name: {}", classname);
                let matcher = self
                    .automation
                    .0
                    .create_matcher()
                    .from_ref(root_ele)
                    .filter(Box::new(ClassNameFilter {
                        classname: classname.clone(),
                    }))
                    .depth(50)
                    .timeout(timeout_ms as u64);
                let element = matcher.find_first().map_err(|e| {
                    AutomationError::ElementNotFound(format!("ClassName: '{classname}', Err: {e}"))
                })?;
                let arc_ele = ThreadSafeWinUIElement(Arc::new(element));
                Ok(UIElement::new(Box::new(WindowsUIElement {
                    element: arc_ele,
                    engine: None,
                })))
            }
            Selector::Visible(visibility) => {
                let visibility = *visibility;
                let matcher = self
                    .automation
                    .0
                    .create_matcher()
                    .from_ref(root_ele)
                    .depth(50)
                    .filter_fn(Box::new(move |e: &uiautomation::UIElement| {
                        match e.is_offscreen() {
                            Ok(is_offscreen) => Ok(is_offscreen != visibility),
                            Err(e) => {
                                debug!("failed to get visibility: {}", e);
                                Ok(false)
                            }
                        }
                    }))
                    .timeout(timeout_ms as u64);
                let element = matcher.find_first().map_err(|e| {
                    AutomationError::ElementNotFound(format!("Visible: '{visibility}', Err: {e}"))
                })?;
                Ok(UIElement::new(Box::new(WindowsUIElement {
                    element: ThreadSafeWinUIElement(Arc::new(element)),
                    engine: None,
                })))
            }
            Selector::LocalizedRole(localized_role) => {
                debug!("searching element by localized role: {}", localized_role);
                let lr = localized_role.clone();
                let matcher = self
                    .automation
                    .0
                    .create_matcher()
                    .from_ref(root_ele)
                    .filter_fn(Box::new(move |e: &uiautomation::UIElement| {
                        match e.get_localized_control_type() {
                            Ok(lct) => Ok(lct == lr),
                            Err(_) => Ok(false),
                        }
                    }))
                    .depth(50)
                    .timeout(timeout_ms as u64);
                let element = matcher.find_first().map_err(|e| {
                    AutomationError::ElementNotFound(format!(
                        "LocalizedRole: '{localized_role}', Err: {e}"
                    ))
                })?;
                let arc_ele = ThreadSafeWinUIElement(Arc::new(element));
                Ok(UIElement::new(Box::new(WindowsUIElement {
                    element: arc_ele,
                    engine: None,
                })))
            }
            Selector::Nth(_) => Err(AutomationError::InvalidSelector(
                "Nth selector must be used as part of a chain (e.g. 'list >> nth=0')".to_string(),
            )),
            Selector::Has(_) => Err(AutomationError::InvalidSelector(
                "Has selector must be used as part of a chain (e.g. 'list >> has:button')"
                    .to_string(),
            )),
            Selector::RightOf(_)
            | Selector::LeftOf(_)
            | Selector::Above(_)
            | Selector::Below(_)
            | Selector::Near(_) => {
                let mut elements = self.find_elements(selector, root, timeout, Some(50))?;
                if elements.is_empty() {
                    return Err(AutomationError::ElementNotFound(format!(
                        "No element found for layout selector: {selector:?}"
                    )));
                }

                // For layout selectors, it's often useful to get the *closest* one.
                // Let's sort them by distance from the anchor.
                let inner_selector = match selector {
                    Selector::RightOf(s)
                    | Selector::LeftOf(s)
                    | Selector::Above(s)
                    | Selector::Below(s)
                    | Selector::Near(s) => s.as_ref(),
                    _ => unreachable!(),
                };

                let anchor_element = self.find_element(inner_selector, root, timeout)?;
                let anchor_bounds = anchor_element.bounds()?;
                let anchor_center_x = anchor_bounds.0 + anchor_bounds.2 / 2.0;
                let anchor_center_y = anchor_bounds.1 + anchor_bounds.3 / 2.0;

                elements.sort_by(|a, b| {
                    let dist_a = a
                        .bounds()
                        .map(|b_bounds| {
                            let b_center_x = b_bounds.0 + b_bounds.2 / 2.0;
                            let b_center_y = b_bounds.1 + b_bounds.3 / 2.0;
                            ((b_center_x - anchor_center_x).powi(2)
                                + (b_center_y - anchor_center_y).powi(2))
                            .sqrt()
                        })
                        .unwrap_or(f64::MAX);

                    let dist_b = b
                        .bounds()
                        .map(|b_bounds| {
                            let b_center_x = b_bounds.0 + b_bounds.2 / 2.0;
                            let b_center_y = b_bounds.1 + b_bounds.3 / 2.0;
                            ((b_center_x - anchor_center_x).powi(2)
                                + (b_center_y - anchor_center_y).powi(2))
                            .sqrt()
                        })
                        .unwrap_or(f64::MAX);

                    dist_a
                        .partial_cmp(&dist_b)
                        .unwrap_or(std::cmp::Ordering::Equal)
                });

                Ok(elements.remove(0))
            }
            Selector::Parent => {
                // Get parent element using the existing parent() method
                if let Some(root_element) = root {
                    if let Some(windows_element) =
                        root_element.as_any().downcast_ref::<WindowsUIElement>()
                    {
                        match windows_element.parent() {
                            Ok(Some(parent_element)) => Ok(parent_element),
                            Ok(None) => Err(AutomationError::ElementNotFound(
                                "No parent element found".to_string(),
                            )),
                            Err(e) => Err(AutomationError::ElementNotFound(format!(
                                "Failed to get parent element: {e}"
                            ))),
                        }
                    } else {
                        Err(AutomationError::PlatformError(
                            "Invalid element type for parent navigation".to_string(),
                        ))
                    }
                } else {
                    Err(AutomationError::InvalidSelector(
                        "Parent selector requires a starting element".to_string(),
                    ))
                }
            }
            Selector::Invalid(reason) => Err(AutomationError::InvalidSelector(reason.clone())),
        }
    }

    fn open_application(&self, app_name: &str) -> Result<UIElement, AutomationError> {
        applications::open_application(self, app_name)
    }

    fn open_url(
        &self,
        url: &str,
        browser: Option<crate::Browser>,
    ) -> Result<UIElement, AutomationError> {
        info!("Opening URL on Windows: {} (browser: {:?})", url, browser);

        // Only try to pre-fetch title for http(s) URLs. For browser-internal schemes
        // like chrome:// or edge://, skip network fetch entirely.
        let title: String = if url.starts_with("http://") || url.starts_with("https://") {
            let url_clone = url.to_string();
            let handle = thread::spawn(move || -> Result<String, AutomationError> {
                let client = reqwest::blocking::Client::builder()
                    .danger_accept_invalid_certs(true)
                    .build()
                    .map_err(|e| {
                        AutomationError::PlatformError(format!("Failed to build http client: {e}"))
                    })?;

                let html = client
                    .get(&url_clone)
                    .send()
                    .map_err(|e| {
                        AutomationError::PlatformError(format!("Failed to fetch url: {e}"))
                    })?
                    .text()
                    .map_err(|e| {
                        AutomationError::PlatformError(format!(
                            "Fetched url content is not valid: {e}"
                        ))
                    })?;

                let title = regex::Regex::new(r"(?is)<title>(.*?)</title>")
                    .unwrap()
                    .captures(&html)
                    .and_then(|caps| caps.get(1).map(|m| m.as_str().trim().to_string()))
                    .unwrap_or_default();

                Ok(title)
            });

            let title = handle
                .join()
                .map_err(|_| AutomationError::PlatformError("thread panicked :(".to_string()))??;
            debug!("Extracted title from url: '{:?}'", title);
            title
        } else {
            debug!(
                "Skipping network fetch for non-http(s) URL scheme; proceeding to ShellExecuteW"
            );
            String::new()
        };

        // Auto-select a browser for internal schemes if none was specified
        let mut inferred_browser = browser.clone();
        if inferred_browser.is_none() {
            if url.starts_with("chrome://") {
                inferred_browser = Some(crate::Browser::Chrome);
            } else if url.starts_with("edge://") {
                inferred_browser = Some(crate::Browser::Edge);
            }
        }

        let (browser_exe, browser_search_name): (Option<String>, String) = match inferred_browser
            .as_ref()
        {
            Some(crate::Browser::Chrome) => (Some("chrome.exe".to_string()), "chrome".to_string()),
            Some(crate::Browser::Firefox) => {
                (Some("firefox.exe".to_string()), "firefox".to_string())
            }
            Some(crate::Browser::Edge) => (Some("msedge.exe".to_string()), "msedge".to_string()),
            Some(crate::Browser::Brave) => (Some("brave.exe".to_string()), "brave".to_string()),
            Some(crate::Browser::Opera) => (Some("opera.exe".to_string()), "opera".to_string()),
            Some(crate::Browser::Vivaldi) => {
                (Some("vivaldi.exe".to_string()), "vivaldi".to_string())
            }
            Some(crate::Browser::Custom(path)) => {
                let path_str: &str = path;
                (
                    Some(path_str.to_string()),
                    path_str.trim_end_matches(".exe").to_string(),
                )
            }
            Some(crate::Browser::Default) | None => (None, "".to_string()),
        };

        let url_hstring = HSTRING::from(url);
        let verb_hstring = HSTRING::from("open");
        let verb_pcwstr = PCWSTR(verb_hstring.as_ptr());

        let hinstance = if let Some(exe_name) = browser_exe {
            // Open with a specific browser
            let exe_hstring = HSTRING::from(exe_name);
            unsafe {
                ShellExecuteW(
                    None,
                    verb_pcwstr,
                    PCWSTR(exe_hstring.as_ptr()),
                    PCWSTR(url_hstring.as_ptr()),
                    PCWSTR::null(),
                    SW_SHOWNORMAL,
                )
            }
        } else {
            // Open with default browser
            unsafe {
                ShellExecuteW(
                    None,
                    verb_pcwstr,
                    PCWSTR(url_hstring.as_ptr()),
                    PCWSTR::null(),
                    PCWSTR::null(),
                    SW_SHOWNORMAL,
                )
            }
        };

        // HINSTANCE returned by ShellExecuteW is not a real HRESULT, but a value > 32 on success.
        if hinstance.0 as i32 <= 32 {
            return Err(AutomationError::PlatformError(format!(
                "Failed to open URL. ShellExecuteW returned error code: {:?}",
                hinstance.0 as i32
            )));
        }

        // Enhanced polling for browser window with better reliability
        let start_time = std::time::Instant::now();
        let timeout = std::time::Duration::from_millis(2000); // Reduced to 2s due to immediate fallback
        let initial_poll_interval = std::time::Duration::from_millis(200); // Faster initial polling
        let fast_poll_interval = std::time::Duration::from_millis(100); // Faster subsequent polling

        // For default browser, try to find the browser window intelligently
        if browser_search_name.clone().is_empty() {
            info!("No specific browser requested, searching for any browser window with the page title.");

            // Try to find a browser window that contains the page title or looks like a browser
            if !title.is_empty() {
                let automation = match create_ui_automation_with_com_init() {
                    Ok(a) => a,
                    Err(e) => {
                        return Err(AutomationError::ElementNotFound(format!(
                            "Failed to create UIAutomation instance for default browser search: {e}"
                        )));
                    }
                };

                let root = automation
                    .get_root_element()
                    .map_err(|e| {
                        error!("Failed to get root element for browser search: {:?}", e);
                        e
                    })
                    .unwrap_or_else(|_| {
                        panic!(
                            "Failed to get root element for browser window search at {}:{}",
                            file!(),
                            line!()
                        )
                    });
                let search_keywords: String = title
                    .split_whitespace()
                    .take(5)
                    .collect::<Vec<_>>()
                    .join(" ")
                    .to_lowercase();
                debug!(
                    "Searching for browser window with title keywords: {}",
                    search_keywords
                );
                let search_title_norm = crate::utils::normalize(&search_keywords);

                let matcher = automation
                    .create_matcher()
                    .from_ref(&root)
                    .filter(Box::new(OrFilter {
                        left: Box::new(ControlTypeFilter {
                            control_type: ControlType::Window,
                        }),
                        right: Box::new(ControlTypeFilter {
                            control_type: ControlType::Pane,
                        }),
                    }))
                    .filter_fn(Box::new(move |e: &uiautomation::UIElement| {
                        let name = crate::utils::normalize(&e.get_name().unwrap_or_default())
                            .to_lowercase();

                        // Look for windows with the page title or common browser indicators
                        let is_title_match =
                            !search_title_norm.is_empty() && name.contains(&search_title_norm);
                        let is_browser_keyword =
                            ["chrome", "firefox", "edge", "browser", "mozilla", "safari"]
                                .iter()
                                .any(|kw| name.contains(kw));
                        if is_title_match || is_browser_keyword {
                            Ok(true)
                        } else {
                            Ok(false)
                        }
                    }))
                    .depth(5)
                    .timeout(1000);

                match matcher.find_first() {
                    Ok(ele) => {
                        info!(
                            "Found browser window for default browser: '{}'",
                            ele.get_name().unwrap_or_default()
                        );
                        let arc_ele = ThreadSafeWinUIElement(Arc::new(ele));
                        return Ok(UIElement::new(Box::new(WindowsUIElement {
                            element: arc_ele,
                            engine: None,
                        })));
                    }
                    Err(_) => {
                        debug!(
                            "Could not find browser window by title, trying browser name search"
                        );
                    }
                }
            }

            // Fallback: try common browser names with shorter timeout
            let common_browsers = vec!["chrome", "firefox", "msedge", "edge"];
            for browser_name in common_browsers {
                debug!("Quick search for browser: {}", browser_name);
                // Use find_element with shorter timeout to avoid long delays
                let start_search = std::time::Instant::now();
                let automation = match create_ui_automation_with_com_init() {
                    Ok(a) => a,
                    Err(_) => continue,
                };

                let root = automation.get_root_element().ok();
                if let Some(root) = root {
                    let matcher = automation
                        .create_matcher()
                        .from_ref(&root)
                        .filter(Box::new(ControlTypeFilter {
                            control_type: ControlType::Window,
                        }))
                        .filter_fn(Box::new(move |e: &uiautomation::UIElement| {
                            let name = e.get_name().unwrap_or_default().to_lowercase();
                            Ok(name.contains(browser_name))
                        }))
                        .timeout(1000); // 1 second timeout instead of 4 seconds

                    match matcher.find_first() {
                        Ok(element) => {
                            debug!(
                                "Found browser '{}' in {}ms",
                                browser_name,
                                start_search.elapsed().as_millis()
                            );
                            let arc_ele = ThreadSafeWinUIElement(Arc::new(element));
                            let app = UIElement::new(Box::new(WindowsUIElement {
                                element: arc_ele,
                                engine: None,
                            }));
                            info!(
                                "Found default browser '{}': {}",
                                browser_name,
                                app.name().unwrap_or_default()
                            );
                            return Ok(app);
                        }
                        Err(_) => {
                            debug!(
                                "Browser '{}' not found in {}ms, trying next...",
                                browser_name,
                                start_search.elapsed().as_millis()
                            );
                            continue;
                        }
                    }
                }
            }

            // Last resort: get focused application (old behavior)
            info!("Could not find browser window, falling back to focused application.");
            let focused_element_raw = self.automation.0.get_focused_element().map_err(|e| {
                AutomationError::PlatformError(format!("Failed to get focused element: {e}"))
            })?;

            let pid = focused_element_raw.get_process_id().map_err(|e| {
                AutomationError::PlatformError(format!(
                    "Failed to get PID for focused element: {e}"
                ))
            })?;

            self.get_application_by_pid(pid as i32, Some(Duration::from_millis(5000)))
        } else {
            // For specific browser, poll with more patience and better error handling
            info!(
                "Polling for '{}' browser to appear",
                browser_search_name.clone()
            );

            let mut title_search_failed = false;

            loop {
                if start_time.elapsed() > timeout {
                    // try to find the browser window by `get_application_by_name`
                    match self.get_application_by_name(&browser_search_name) {
                        Ok(app) => {
                            info!("Found {} browser window, returning.", browser_search_name);
                            return Ok(app);
                        }
                        Err(e) => {
                            return Err(AutomationError::PlatformError(format!(
                                "Timeout waiting for {} browser to appear after {}ms. Last error: {}",
                                browser_search_name, timeout.as_millis(), e
                            )));
                        }
                    }
                }

                // Try name-based search after 1 second or if title search failed
                if start_time.elapsed() > std::time::Duration::from_millis(1000)
                    || title_search_failed
                {
                    match self.get_application_by_name(&browser_search_name) {
                        Ok(app) => {
                            info!(
                                "Found {} browser window using name search, returning.",
                                browser_search_name
                            );
                            return Ok(app);
                        }
                        Err(_) => {
                            // Continue with title search if name search fails
                        }
                    }
                }

                // Skip title search for Edge (known to be slow) and try name-based search immediately
                if browser_search_name == "msedge" {
                    debug!("Skipping title search for Edge, trying name-based search directly");
                    match self.get_application_by_name(&browser_search_name) {
                        Ok(app) => {
                            info!(
                                "Found {} browser window using direct name search, returning.",
                                browser_search_name
                            );
                            return Ok(app);
                        }
                        Err(name_err) => {
                            debug!("Direct name search failed for Edge: {}", name_err);
                        }
                    }
                }

                // Only try title search once, and only in the first 1.5 seconds
                if !title.is_empty()
                    && !title_search_failed
                    && start_time.elapsed() < std::time::Duration::from_millis(1500)
                {
                    debug!(
                        "Creating UI automation instance at {}ms",
                        start_time.elapsed().as_millis()
                    );
                    let automation_start = std::time::Instant::now();
                    let automation = match create_ui_automation_with_com_init() {
                        Ok(a) => {
                            debug!(
                                "UI automation created in {}ms",
                                automation_start.elapsed().as_millis()
                            );
                            a
                        }
                        Err(e) => {
                            return Err(AutomationError::ElementNotFound(format!(
                                "Failed to create UIAutomation instance for opening_url: {e}"
                            )));
                        }
                    };

                    let root = automation
                        .get_root_element()
                        .map_err(|e| {
                            error!("Failed to get root element for browser search: {:?}", e);
                            e
                        })
                        .unwrap_or_else(|_| {
                            panic!(
                                "Failed to get root element for browser window search at {}:{}",
                                file!(),
                                line!()
                            )
                        });
                    let browser_search_name_cloned = browser_search_name.clone();
                    let search_keywords: String = title
                        .split_whitespace()
                        .take(5)
                        .collect::<Vec<_>>()
                        .join(" ")
                        .to_lowercase();
                    debug!("search keywords: {}", search_keywords);
                    let search_title_norm = crate::utils::normalize(&search_keywords);

                    let matcher = automation
                        .create_matcher()
                        .from_ref(&root)
                        .filter(Box::new(OrFilter {
                            left: Box::new(ControlTypeFilter {
                                control_type: ControlType::Window,
                            }),
                            right: Box::new(ControlTypeFilter {
                                control_type: ControlType::Pane,
                            }),
                        }))
                        .filter_fn(Box::new(move |e: &uiautomation::UIElement| {
                            let name = crate::utils::normalize(&e.get_name().unwrap_or_default());
                            let name_lower = name.to_lowercase();
                            if name_lower.contains(&search_title_norm)
                                || name_lower.contains(&browser_search_name_cloned)
                            {
                                Ok(true)
                            } else {
                                Ok(false)
                            }
                        }))
                        .depth(5)
                        .timeout(500); // Reduced to 500ms since API timeout doesn't work reliably

                    debug!(
                        "Starting title search at {}ms",
                        start_time.elapsed().as_millis()
                    );
                    let search_start = std::time::Instant::now();

                    match matcher.find_first() {
                        Ok(ele) => {
                            debug!(
                                "Title search succeeded in {}ms",
                                search_start.elapsed().as_millis()
                            );
                            info!("Found browser document window with title '{}'", title);
                            let arc_ele = ThreadSafeWinUIElement(Arc::new(ele));
                            return Ok(UIElement::new(Box::new(WindowsUIElement {
                                element: arc_ele,
                                engine: None,
                            })));
                        }
                        Err(e) => {
                            debug!("Title search failed in {}ms: '{}', immediately trying name-based search", search_start.elapsed().as_millis(), e);
                            title_search_failed = true;

                            // Immediately try name-based search when title search fails
                            match self.get_application_by_name(&browser_search_name) {
                                Ok(app) => {
                                    info!("Found {} browser window using name search after title failure, returning.", browser_search_name);
                                    return Ok(app);
                                }
                                Err(name_err) => {
                                    debug!("Name-based search also failed: {}", name_err);
                                }
                            }
                        }
                    }
                }

                // Use adaptive polling
                let poll_interval = if start_time.elapsed() < std::time::Duration::from_millis(1000)
                {
                    initial_poll_interval
                } else {
                    fast_poll_interval
                };

                std::thread::sleep(poll_interval);
            }
        }
    }

    fn open_file(&self, file_path: &str) -> Result<(), AutomationError> {
        // Use Invoke-Item and explicitly quote the path within the command string.
        // Also use -LiteralPath to prevent PowerShell from interpreting characters in the path.
        // Escape any pre-existing double quotes within the path itself using PowerShell's backtick escape `"
        let command_str = format!(
            "Invoke-Item -LiteralPath \"{}\"",
            file_path.replace('\"', "`\"")
        );
        info!("Running command to open file: {}", command_str);

        let output = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-WindowStyle",
                "hidden",
                "-Command",
                &command_str, // Pass the fully formed command string
            ])
            .output() // Capture output instead of just status
            .map_err(|e| AutomationError::PlatformError(e.to_string()))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            error!(
                "Failed to open file '{}' using Invoke-Item. Stderr: {}",
                file_path, stderr
            );
            return Err(AutomationError::PlatformError(format!(
                "Failed to open file '{file_path}' using Invoke-Item. Error: {stderr}"
            )));
        }
        Ok(())
    }

    async fn run_command(
        &self,
        windows_command: Option<&str>,
        _unix_command: Option<&str>,
    ) -> Result<crate::CommandOutput, AutomationError> {
        let command_str = windows_command.ok_or_else(|| {
            AutomationError::InvalidArgument("Windows command must be provided".to_string())
        })?;

        // Use tokio::process::Command for async execution
        // CREATE_NO_WINDOW prevents console allocation which can steal focus/minimize parent windows
        let output = tokio::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-WindowStyle",
                "hidden",
                "-Command",
                command_str,
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .await // Await the async output
            .map_err(|e| AutomationError::PlatformError(e.to_string()))?;

        Ok(crate::CommandOutput {
            exit_status: output.status.code(),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        })
    }

    async fn capture_screen(&self) -> Result<ScreenshotResult, AutomationError> {
        let monitors = xcap::Monitor::all()
            .map_err(|e| AutomationError::PlatformError(format!("Failed to get monitors: {e}")))?;
        let mut primary_monitor: Option<xcap::Monitor> = None;
        for monitor in monitors {
            match monitor.is_primary() {
                Ok(true) => {
                    primary_monitor = Some(monitor);
                    break;
                }
                Ok(false) => continue,
                Err(e) => {
                    return Err(AutomationError::PlatformError(format!(
                        "Error checking monitor primary status: {e}"
                    )));
                }
            }
        }
        let primary_monitor = primary_monitor.ok_or_else(|| {
            AutomationError::PlatformError("Could not find primary monitor".to_string())
        })?;

        let image = primary_monitor.capture_image().map_err(|e| {
            AutomationError::PlatformError(format!("Failed to capture screen: {e}"))
        })?;

        Ok(ScreenshotResult {
            image_data: image.to_vec(),
            width: image.width(),
            height: image.height(),
            monitor: None,
        })
    }

    async fn get_active_monitor_name(&self) -> Result<String, AutomationError> {
        // Get all windows
        let windows = xcap::Window::all()
            .map_err(|e| AutomationError::PlatformError(format!("Failed to get windows: {e}")))?;

        // Find the focused window
        let focused_window = windows
            .iter()
            .find(|w| w.is_focused().unwrap_or(false))
            .ok_or_else(|| {
                AutomationError::ElementNotFound("No focused window found".to_string())
            })?;

        // Get the monitor name for the focused window
        let monitor = focused_window.current_monitor().map_err(|e| {
            AutomationError::PlatformError(format!("Failed to get current monitor: {e}"))
        })?;

        let monitor_name = monitor.name().map_err(|e| {
            AutomationError::PlatformError(format!("Failed to get monitor name: {e}"))
        })?;

        Ok(monitor_name)
    }

    async fn capture_monitor_by_name(
        &self,
        name: &str,
    ) -> Result<ScreenshotResult, AutomationError> {
        let monitors = xcap::Monitor::all()
            .map_err(|e| AutomationError::PlatformError(format!("Failed to get monitors: {e}")))?;
        let mut target_monitor: Option<xcap::Monitor> = None;
        for monitor in monitors {
            match monitor.name() {
                Ok(monitor_name) if monitor_name == name => {
                    target_monitor = Some(monitor);
                    break;
                }
                Ok(_) => continue,
                Err(e) => {
                    return Err(AutomationError::PlatformError(format!(
                        "Error getting monitor name: {e}"
                    )));
                }
            }
        }
        let target_monitor = target_monitor.ok_or_else(|| {
            AutomationError::ElementNotFound(format!("Monitor '{name}' not found"))
        })?;

        let image = target_monitor.capture_image().map_err(|e| {
            AutomationError::PlatformError(format!("Failed to capture monitor '{name}': {e}"))
        })?;

        Ok(ScreenshotResult {
            image_data: image.to_vec(),
            width: image.width(),
            height: image.height(),
            monitor: None,
        })
    }

    // ============== NEW MONITOR ABSTRACTIONS ==============

    async fn list_monitors(&self) -> Result<Vec<crate::Monitor>, AutomationError> {
        let monitors = xcap::Monitor::all()
            .map_err(|e| AutomationError::PlatformError(format!("Failed to get monitors: {e}")))?;

        let mut result = Vec::new();
        for (index, monitor) in monitors.iter().enumerate() {
            let name = monitor.name().map_err(|e| {
                AutomationError::PlatformError(format!("Failed to get monitor name: {e}"))
            })?;

            let is_primary = monitor.is_primary().map_err(|e| {
                AutomationError::PlatformError(format!("Failed to check primary status: {e}"))
            })?;

            let width = monitor.width().map_err(|e| {
                AutomationError::PlatformError(format!("Failed to get monitor width: {e}"))
            })?;

            let height = monitor.height().map_err(|e| {
                AutomationError::PlatformError(format!("Failed to get monitor height: {e}"))
            })?;

            let x = monitor.x().map_err(|e| {
                AutomationError::PlatformError(format!("Failed to get monitor x position: {e}"))
            })?;

            let y = monitor.y().map_err(|e| {
                AutomationError::PlatformError(format!("Failed to get monitor y position: {e}"))
            })?;

            let scale_factor = monitor.scale_factor().map_err(|e| {
                AutomationError::PlatformError(format!("Failed to get monitor scale factor: {e}"))
            })? as f64;

            // Get work area for this monitor if it's primary (Windows only supports primary monitor work area via SPI_GETWORKAREA)
            let work_area = if is_primary {
                use crate::platforms::windows::element::WorkArea;
                if let Ok(work_area) = WorkArea::get_primary() {
                    Some(crate::WorkAreaBounds {
                        x: work_area.x,
                        y: work_area.y,
                        width: work_area.width as u32,
                        height: work_area.height as u32,
                    })
                } else {
                    None
                }
            } else {
                // For non-primary monitors, work area is same as full monitor
                // (Windows doesn't provide per-monitor work area through simple API)
                Some(crate::WorkAreaBounds {
                    x,
                    y,
                    width,
                    height,
                })
            };

            result.push(crate::Monitor {
                id: format!("monitor_{index}"),
                name,
                is_primary,
                width,
                height,
                x,
                y,
                scale_factor,
                work_area,
            });
        }

        Ok(result)
    }

    async fn get_primary_monitor(&self) -> Result<crate::Monitor, AutomationError> {
        let monitors = self.list_monitors().await?;
        monitors
            .into_iter()
            .find(|m| m.is_primary)
            .ok_or_else(|| AutomationError::PlatformError("No primary monitor found".to_string()))
    }

    async fn get_active_monitor(&self) -> Result<crate::Monitor, AutomationError> {
        // Get all windows
        let windows = xcap::Window::all()
            .map_err(|e| AutomationError::PlatformError(format!("Failed to get windows: {e}")))?;

        // Find the focused window
        let focused_window = windows
            .iter()
            .find(|w| w.is_focused().unwrap_or(false))
            .ok_or_else(|| {
                AutomationError::ElementNotFound("No focused window found".to_string())
            })?;

        // Get the monitor for the focused window
        let xcap_monitor = focused_window.current_monitor().map_err(|e| {
            AutomationError::PlatformError(format!("Failed to get current monitor: {e}"))
        })?;

        // Convert to our Monitor struct
        let name = xcap_monitor.name().map_err(|e| {
            AutomationError::PlatformError(format!("Failed to get monitor name: {e}"))
        })?;

        let is_primary = xcap_monitor.is_primary().map_err(|e| {
            AutomationError::PlatformError(format!("Failed to check primary status: {e}"))
        })?;

        // Find the monitor index for ID generation
        let monitors = xcap::Monitor::all()
            .map_err(|e| AutomationError::PlatformError(format!("Failed to get monitors: {e}")))?;

        let monitor_index = monitors
            .iter()
            .position(|m| m.name().map(|n| n == name).unwrap_or(false))
            .unwrap_or(0);

        let width = xcap_monitor.width().map_err(|e| {
            AutomationError::PlatformError(format!("Failed to get monitor width: {e}"))
        })?;

        let height = xcap_monitor.height().map_err(|e| {
            AutomationError::PlatformError(format!("Failed to get monitor height: {e}"))
        })?;

        let x = xcap_monitor.x().map_err(|e| {
            AutomationError::PlatformError(format!("Failed to get monitor x position: {e}"))
        })?;

        let y = xcap_monitor.y().map_err(|e| {
            AutomationError::PlatformError(format!("Failed to get monitor y position: {e}"))
        })?;

        let scale_factor = xcap_monitor.scale_factor().map_err(|e| {
            AutomationError::PlatformError(format!("Failed to get monitor scale factor: {e}"))
        })? as f64;

        // Get work area for this monitor if it's primary
        let work_area = if is_primary {
            use crate::platforms::windows::element::WorkArea;
            if let Ok(work_area) = WorkArea::get_primary() {
                Some(crate::WorkAreaBounds {
                    x: work_area.x,
                    y: work_area.y,
                    width: work_area.width as u32,
                    height: work_area.height as u32,
                })
            } else {
                None
            }
        } else {
            // For non-primary monitors, work area is same as full monitor
            Some(crate::WorkAreaBounds {
                x,
                y,
                width,
                height,
            })
        };

        Ok(crate::Monitor {
            id: format!("monitor_{monitor_index}"),
            name,
            is_primary,
            width,
            height,
            x,
            y,
            scale_factor,
            work_area,
        })
    }

    async fn get_monitor_by_id(&self, id: &str) -> Result<crate::Monitor, AutomationError> {
        let monitors = self.list_monitors().await?;
        monitors.into_iter().find(|m| m.id == id).ok_or_else(|| {
            AutomationError::ElementNotFound(format!("Monitor with ID '{id}' not found"))
        })
    }

    async fn get_monitor_by_name(&self, name: &str) -> Result<crate::Monitor, AutomationError> {
        let monitors = self.list_monitors().await?;
        monitors
            .into_iter()
            .find(|m| m.name == name)
            .ok_or_else(|| AutomationError::ElementNotFound(format!("Monitor '{name}' not found")))
    }

    async fn capture_monitor_by_id(
        &self,
        id: &str,
    ) -> Result<crate::ScreenshotResult, AutomationError> {
        let monitor = self.get_monitor_by_id(id).await?;

        // Find the xcap monitor by name
        let monitors = xcap::Monitor::all()
            .map_err(|e| AutomationError::PlatformError(format!("Failed to get monitors: {e}")))?;

        let xcap_monitor = monitors
            .into_iter()
            .find(|m| m.name().map(|n| n == monitor.name).unwrap_or(false))
            .ok_or_else(|| {
                AutomationError::ElementNotFound(format!("Monitor '{}' not found", monitor.name))
            })?;

        let image = xcap_monitor.capture_image().map_err(|e| {
            AutomationError::PlatformError(format!(
                "Failed to capture monitor '{}': {}",
                monitor.name, e
            ))
        })?;

        Ok(ScreenshotResult {
            image_data: image.to_vec(),
            width: image.width(),
            height: image.height(),
            monitor: Some(monitor),
        })
    }

    // ============== END NEW MONITOR ABSTRACTIONS ==============

    async fn ocr_image_path(&self, image_path: &str) -> Result<String, AutomationError> {
        // Create a Tokio runtime to run the async OCR operation
        let rt = Runtime::new().map_err(|e| {
            AutomationError::PlatformError(format!("Failed to create Tokio runtime: {e}"))
        })?;

        // Run the async code block on the runtime
        rt.block_on(async {
            let engine = OcrEngine::new(OcrProvider::Auto).map_err(|e| {
                AutomationError::PlatformError(format!("Failed to create OCR engine: {e}"))
            })?;

            let (text, _language, _confidence) = engine // Destructure the tuple
                .recognize_file(image_path)
                .await
                .map_err(|e| {
                    AutomationError::PlatformError(format!("OCR recognition failed: {e}"))
                })?;

            Ok(text) // Return only the text
        })
    }

    async fn ocr_screenshot(
        &self,
        screenshot: &ScreenshotResult,
    ) -> Result<String, AutomationError> {
        // Reconstruct the image buffer from raw data
        let img_buffer: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::from_raw(
            screenshot.width,
            screenshot.height,
            screenshot.image_data.clone(), // Clone data into the buffer
        )
        .ok_or_else(|| {
            AutomationError::InvalidArgument(
                "Invalid screenshot data for buffer creation".to_string(),
            )
        })?;

        // Convert to DynamicImage
        let dynamic_image = DynamicImage::ImageRgba8(img_buffer);

        // Directly await the OCR operation within the existing async context
        let engine = OcrEngine::new(OcrProvider::Auto).map_err(|e| {
            AutomationError::PlatformError(format!("Failed to create OCR engine: {e}"))
        })?;

        let (text, _language, _confidence) = engine
            .recognize_image(&dynamic_image) // Use recognize_image
            .await // << Directly await here
            .map_err(|e| AutomationError::PlatformError(format!("OCR recognition failed: {e}")))?;

        Ok(text)
    }

    fn ocr_screenshot_with_bounds(
        &self,
        screenshot: &ScreenshotResult,
        window_x: f64,
        window_y: f64,
        dpi_scale_x: f64,
        dpi_scale_y: f64,
    ) -> Result<OcrElement, AutomationError> {
        // Delegate to the implementation in impl WindowsEngine
        WindowsEngine::ocr_screenshot_with_bounds(
            self,
            screenshot,
            window_x,
            window_y,
            dpi_scale_x,
            dpi_scale_y,
        )
    }

    fn click_at_coordinates(
        &self,
        x: f64,
        y: f64,
        restore_cursor: bool,
    ) -> Result<(), AutomationError> {
        super::input::send_mouse_click(x, y, crate::ClickType::Left, restore_cursor)
    }

    fn click_at_coordinates_with_type(
        &self,
        x: f64,
        y: f64,
        click_type: crate::ClickType,
        restore_cursor: bool,
    ) -> Result<(), AutomationError> {
        super::input::send_mouse_click(x, y, click_type, restore_cursor)
    }

    fn activate_browser_window_by_title(&self, title: &str) -> Result<(), AutomationError> {
        info!(
            "Attempting to activate browser window containing title: {}",
            title
        );
        let root = self
            .automation
            .0
            .get_root_element() // Cache root element lookup
            .map_err(|e| {
                AutomationError::PlatformError(format!("Failed to get root element: {e}"))
            })?;

        // Find top-level windows
        let window_matcher = self
            .automation
            .0
            .create_matcher()
            .from_ref(&root)
            .filter(Box::new(ControlTypeFilter {
                control_type: ControlType::TabItem,
            }))
            .contains_name(title)
            .depth(50)
            .timeout(5000);

        let window = window_matcher.find_first().map_err(|e| {
            AutomationError::PlatformError(format!("Failed to find top-level windows: {e}"))
        })?;

        // TODO: focus part does not work (at least in browser firefox)
        // If find_first succeeds, 'window' is the UIElement. Now try to focus it.
        window.set_focus().map_err(|e| {
            AutomationError::PlatformError(format!("Failed to set focus on window/tab: {e}"))
        })?; // Map focus error

        Ok(()) // If focus succeeds, return Ok
    }

    async fn get_current_browser_window(&self) -> Result<UIElement, AutomationError> {
        info!("Attempting to get the current focused browser window.");
        let focused_element_raw = self.automation.0.get_focused_element().map_err(|e| {
            AutomationError::PlatformError(format!("Failed to get focused element: {e}"))
        })?;

        let pid = focused_element_raw.get_process_id().map_err(|e| {
            AutomationError::PlatformError(format!(
                "Failed to get process ID for focused element: {e}"
            ))
        })?;

        let process_name_raw = get_process_name_by_pid(pid as i32)?;
        let process_name = process_name_raw.to_lowercase(); // Compare lowercase

        info!(
            "Focused element belongs to process: {} (PID: {})",
            process_name, pid
        );

        if KNOWN_BROWSER_PROCESS_NAMES
            .iter()
            .any(|&browser_name| process_name.contains(browser_name))
        {
            // First try to get the focused element's parent chain to find a tab
            let mut current_element = focused_element_raw.clone();
            let mut found_tab = false;

            // Walk up the parent chain looking for a TabItem
            for _ in 0..10 {
                // Limit depth to prevent infinite loops
                if let Ok(control_type) = current_element.get_control_type() {
                    debug!(
                        "get_current_browser_window, control_type: {:?}",
                        control_type
                    );
                    if control_type == ControlType::Document {
                        info!("Found browser tab in parent chain");
                        found_tab = true;
                        break;
                    }
                }

                match current_element.get_cached_parent() {
                    Ok(parent) => current_element = parent,
                    Err(_) => break,
                }
            }

            if found_tab {
                // If we found a tab, use the focused element
                info!("Using focused element as it's part of a browser tab");
                let arc_focused_element = ThreadSafeWinUIElement(Arc::new(focused_element_raw));
                Ok(UIElement::new(Box::new(WindowsUIElement {
                    element: arc_focused_element,
                    engine: None,
                })))
            } else {
                // If no tab found, fall back to the main window
                info!("No tab found in parent chain, falling back to main window");
                match self.get_application_by_pid(pid as i32, Some(DEFAULT_FIND_TIMEOUT)) {
                    Ok(app_window_element) => {
                        info!("Successfully fetched main application window for browser");
                        Ok(app_window_element)
                    }
                    Err(e) => {
                        error!(
                            "Failed to get application window by PID {} for browser {}: {}. Falling back to focused element.",
                            pid, process_name, e
                        );
                        // Fallback to returning the originally focused element
                        let arc_focused_element =
                            ThreadSafeWinUIElement(Arc::new(focused_element_raw));
                        Ok(UIElement::new(Box::new(WindowsUIElement {
                            element: arc_focused_element,
                            engine: None,
                        })))
                    }
                }
            }
        } else {
            Err(AutomationError::ElementNotFound(
                "Currently focused window is not a recognized browser.".to_string(),
            ))
        }
    }

    fn activate_application(&self, app_name: &str) -> Result<(), AutomationError> {
        info!("Attempting to activate application by name: {}", app_name);
        // Find the application window first
        let app_element = self.get_application_by_name(app_name)?;

        // Attempt to activate/focus the window
        // Downcast to the specific WindowsUIElement to call set_focus or activate_window
        let win_element_impl = app_element
            .as_any()
            .downcast_ref::<WindowsUIElement>()
            .ok_or_else(|| {
                AutomationError::PlatformError(
                    "Failed to get window element implementation for activation".to_string(),
                )
            })?;

        // Use set_focus, which typically brings the window forward on Windows
        win_element_impl.element.0.set_focus().map_err(|e| {
            AutomationError::PlatformError(format!(
                "Failed to set focus on application window '{app_name}': {e}"
            ))
        })
    }

    async fn get_current_window(&self) -> Result<UIElement, AutomationError> {
        info!("Attempting to get the current focused window.");
        let focused_element_raw = self.automation.0.get_focused_element().map_err(|e| {
            AutomationError::PlatformError(format!("Failed to get focused element: {e}"))
        })?;

        let mut current_element_arc = Arc::new(focused_element_raw);

        for _ in 0..20 {
            // Max depth to prevent infinite loops
            match current_element_arc.get_control_type() {
                Ok(control_type) => {
                    if control_type == ControlType::Window || control_type == ControlType::Pane {
                        let window_ui_element = WindowsUIElement {
                            element: ThreadSafeWinUIElement(Arc::clone(&current_element_arc)),
                            engine: None,
                        };
                        return Ok(UIElement::new(Box::new(window_ui_element)));
                    }
                }
                Err(e) => {
                    return Err(AutomationError::PlatformError(format!(
                        "Failed to get control type during window search: {e}"
                    )));
                }
            }

            match current_element_arc.get_cached_parent() {
                Ok(parent_uia_element) => {
                    // Check if parent is same as current (e.g. desktop root's parent is itself)
                    let current_runtime_id = current_element_arc.get_runtime_id().map_err(|e| {
                        AutomationError::PlatformError(format!(
                            "Failed to get runtime_id for current element: {e}"
                        ))
                    })?;
                    let parent_runtime_id = parent_uia_element.get_runtime_id().map_err(|e| {
                        AutomationError::PlatformError(format!(
                            "Failed to get runtime_id for parent element: {e}"
                        ))
                    })?;

                    if parent_runtime_id == current_runtime_id {
                        debug!(
                            "Parent element has same runtime ID as current, stopping window search."
                        );
                        break; // Reached the top or a cycle.
                    }
                    current_element_arc = Arc::new(parent_uia_element); // Move to the parent
                }
                Err(_e) => {
                    // No parent found, or error occurred.
                    // This could mean the focused element itself is the top-level window, or it's detached.
                    // We break here and if the loop didn't find a window, we'll return an error below.
                    break;
                }
            }
        }

        Err(AutomationError::ElementNotFound(
            "Could not find a parent window for the focused element.".to_string(),
        ))
    }

    async fn get_current_application(&self) -> Result<UIElement, AutomationError> {
        info!("Attempting to get the current focused application.");
        let focused_element_raw = self.automation.0.get_focused_element().map_err(|e| {
            AutomationError::PlatformError(format!("Failed to get focused element: {e}"))
        })?;

        let pid = focused_element_raw.get_process_id().map_err(|e| {
            AutomationError::PlatformError(format!("Failed to get PID for focused element: {e}"))
        })?;

        self.get_application_by_pid(pid as i32, Some(DEFAULT_FIND_TIMEOUT))
    }

    fn get_window_tree(
        &self,
        pid: u32,
        title: Option<&str>,
        config: crate::platforms::TreeBuildConfig,
    ) -> Result<crate::UINode, AutomationError> {
        info!(
            "Getting window tree for PID: {} and title: {:?} with config: {:?}",
            pid, title, config
        );
        let root_ele_os = self.get_root_element_with_retry().map_err(|e| {
            error!("Failed to get root element: {}", e);
            AutomationError::PlatformError(format!("Failed to get root element: {e}"))
        })?;

        // Find all windows for the given process ID
        // Search for both Window and Pane control types since some applications use panes as main containers
        let window_matcher = self
            .automation
            .0
            .create_matcher()
            .from_ref(&root_ele_os)
            .filter(Box::new(OrFilter {
                left: Box::new(ControlTypeFilter {
                    control_type: ControlType::Window,
                }),
                right: Box::new(ControlTypeFilter {
                    control_type: ControlType::Pane,
                }),
            }))
            .depth(3)
            .timeout(3000);

        let windows = window_matcher.find_all().map_err(|e| {
            error!("Failed to find windows: {}", e);
            AutomationError::ElementNotFound(format!("Failed to find windows: {e}"))
        })?;

        info!(
            "Found {} total windows, filtering by PID: {}",
            windows.len(),
            pid
        );

        // Filter windows by process ID first
        let mut pid_matching_windows = Vec::new();
        let mut window_debug_info = Vec::new(); // For debugging

        for window in windows {
            match window.get_process_id() {
                Ok(window_pid) => {
                    let window_name = window.get_name().unwrap_or_else(|_| "Unknown".to_string());
                    window_debug_info.push(format!("PID: {window_pid}, Name: {window_name}"));

                    if window_pid == pid {
                        pid_matching_windows.push((window, window_name));
                    }
                }
                Err(e) => {
                    debug!("Failed to get process ID for window: {}", e);
                }
            }
        }

        if pid_matching_windows.is_empty() {
            error!("No windows found for PID: {}", pid);
            debug!("Available windows: {:?}", window_debug_info);
            return Err(AutomationError::ElementNotFound(format!(
                "No windows found for process ID {pid}. Available windows: {window_debug_info:?}"
            )));
        }

        info!(
            "Found {} windows for PID: {}",
            pid_matching_windows.len(),
            pid
        );

        // Enhanced title matching logic for PID-based search
        let selected_window = if let Some(title) = title {
            info!(
                "Filtering {} windows by title: '{}'",
                pid_matching_windows.len(),
                title
            );

            // Use the enhanced title matching helper
            match self.find_best_title_match(&pid_matching_windows, title) {
                Some((window, score)) => {
                    if score < 1.0 {
                        info!(
                            "Using best match with similarity {:.2} for PID {}: '{}'",
                            score,
                            pid,
                            window.get_name().unwrap_or_default()
                        );
                    }
                    window
                }
                None => {
                    let window_names: Vec<&String> =
                        pid_matching_windows.iter().map(|(_, name)| name).collect();
                    warn!(
                        "No good title match found for '{}' in PID {}, falling back to first window. Available: {:?}",
                        title, pid, window_names
                    );
                    pid_matching_windows[0].0.clone()
                }
            }
        } else {
            info!(
                "No title filter provided, using first window with PID {}",
                pid
            );
            pid_matching_windows[0].0.clone()
        };

        let selected_window_name = selected_window
            .get_name()
            .unwrap_or_else(|_| "Unknown".to_string());
        info!(
            "Selected window: '{}' for PID: {} (title filter: {:?})",
            selected_window_name, pid, title
        );

        // Wrap the raw OS element into our UIElement
        let window_element_wrapper = UIElement::new(Box::new(WindowsUIElement {
            element: ThreadSafeWinUIElement(Arc::new(selected_window)),
            engine: None,
        }));

        // Build the UI tree with configurable performance optimizations
        // Get application name from process using sysinfo (efficient single lookup)
        let application_name = {
            use sysinfo::{ProcessesToUpdate, System};
            let mut system = System::new();
            system.refresh_processes(ProcessesToUpdate::All, true);
            system
                .process(sysinfo::Pid::from_u32(pid))
                .map(|p| p.name().to_string_lossy().to_string())
        };

        // Use configured tree building approach
        let mut context = TreeBuildingContext {
            config: TreeBuildingConfig {
                timeout_per_operation_ms: config.timeout_per_operation_ms.unwrap_or(50),
                yield_every_n_elements: config.yield_every_n_elements.unwrap_or(50),
                batch_size: config.batch_size.unwrap_or(50),
                max_depth: config.max_depth.or(Some(500)), // Set reasonable default to prevent stack overflow
            },
            property_mode: config.property_mode.clone(),
            elements_processed: 0,
            max_depth_reached: 0,
            cache_hits: 0,
            fallback_calls: 0,
            errors_encountered: 0,
            application_name, // Cache application name for all nodes in tree
            include_all_bounds: config.include_all_bounds,
        };

        let result =
            build_ui_node_tree_configurable(&window_element_wrapper, 0, &mut context, vec![])?;

        info!(
            "Tree building completed for PID: {}. Stats: elements={}, depth={}, cache_hits={}, fallbacks={}, errors={}",
            pid,
            context.elements_processed,
            context.max_depth_reached,
            context.cache_hits,
            context.fallback_calls,
            context.errors_encountered
        );

        Ok(result)
    }

    fn get_tree_from_element(
        &self,
        element: &UIElement,
        config: crate::platforms::TreeBuildConfig,
    ) -> Result<crate::UINode, AutomationError> {
        info!(
            "Building UI tree directly from element (role: {})",
            element.role()
        );

        // Get PID from element for application name lookup
        let pid = element.process_id().ok();

        // Get application name from process using sysinfo
        let application_name = pid.and_then(|p| {
            use sysinfo::{ProcessesToUpdate, System};
            let mut system = System::new();
            system.refresh_processes(ProcessesToUpdate::All, true);
            system
                .process(sysinfo::Pid::from_u32(p))
                .map(|proc| proc.name().to_string_lossy().to_string())
        });

        // Use configured tree building approach
        let mut context = TreeBuildingContext {
            config: TreeBuildingConfig {
                timeout_per_operation_ms: config.timeout_per_operation_ms.unwrap_or(50),
                yield_every_n_elements: config.yield_every_n_elements.unwrap_or(50),
                batch_size: config.batch_size.unwrap_or(50),
                max_depth: config.max_depth.or(Some(500)),
            },
            property_mode: config.property_mode.clone(),
            elements_processed: 0,
            max_depth_reached: 0,
            cache_hits: 0,
            fallback_calls: 0,
            errors_encountered: 0,
            application_name,
            include_all_bounds: config.include_all_bounds,
        };

        let result = build_ui_node_tree_configurable(element, 0, &mut context, vec![])?;

        info!(
            "Tree building from element completed. Stats: elements={}, depth={}, cache_hits={}, fallbacks={}, errors={}",
            context.elements_processed,
            context.max_depth_reached,
            context.cache_hits,
            context.fallback_calls,
            context.errors_encountered
        );

        Ok(result)
    }

    fn press_key(&self, key: &str) -> Result<(), AutomationError> {
        // Use global keyboard simulation directly (works without focused element)
        use uiautomation::inputs::Keyboard;
        Keyboard::new()
            .interval(10)
            .send_keys(key)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to press key: {e:?}")))
    }

    fn set_zoom(&self, percentage: u32) -> Result<(), AutomationError> {
        // Fallback approach using keyboard shortcuts. This works for most browsers and many applications.
        // NOTE: This method is imprecise because browser zoom levels are not always linear (e.g., 90%, 100%, 110%, 125%).
        // It avoids using Ctrl+0 to reset zoom, as that can trigger unwanted website-specific shortcuts.
        // Instead, it zooms out fully to a known minimum state and then zooms in to the target level.

        const ZOOM_STEP: u32 = 10; // Assumed average step for zoom changes.
        const MIN_ZOOM: u32 = 25; // Assumed minimum zoom level for most browsers.
        const MAX_ZOOM_OUT_STEPS: u32 = 50; // A high number of steps to ensure we reach the minimum zoom.

        // Zoom out completely to reach a known state (minimum zoom).
        // Inlined zoom_out logic
        for _ in 0..MAX_ZOOM_OUT_STEPS {
            self.press_key("{Ctrl}-")?;
        }

        // A small delay to allow the UI to process the zoom changes.
        std::thread::sleep(std::time::Duration::from_millis(100));

        if percentage <= MIN_ZOOM {
            // The target is at or below the assumed minimum, so we're done.
            return Ok(());
        }

        // From the minimum zoom, calculate how many steps to zoom in.
        // We add half of ZOOM_STEP for rounding.
        let steps_to_zoom_in = (percentage.saturating_sub(MIN_ZOOM) + ZOOM_STEP / 2) / ZOOM_STEP;

        // Inlined zoom_in logic
        if steps_to_zoom_in > 0 {
            for _ in 0..steps_to_zoom_in {
                self.press_key("{Ctrl}=")?;
            }
        }

        Ok(())
    }

    /// Enable downcasting to concrete engine types
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}
