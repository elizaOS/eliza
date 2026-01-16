//! Desktop UI automation through accessibility APIs
//!
//! This module provides a cross-platform API for automating desktop applications
//! through accessibility APIs, inspired by Playwright's web automation model.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex, RwLock};
use sysinfo::{ProcessesToUpdate, System};
use tracing::{debug, error, info, instrument};

pub mod browser_script;
pub mod element;
pub mod errors;
pub mod extension_bridge;
pub mod health;
pub mod locator;
pub mod platforms;
pub mod screenshot;
pub mod screenshot_logger;
pub mod selector;
#[cfg(test)]
mod tests;
pub mod tree_formatter;
pub mod types;
pub mod ui_tree_diff;
pub mod utils;

#[cfg(target_os = "windows")]
pub mod computer_use;

pub use element::{OcrElement, SerializableUIElement, UIElement, UIElementAttributes};
pub use errors::AutomationError;
pub use locator::Locator;
pub use screenshot::{
    get_cursor_position, ScreenshotError, ScreenshotResult, DEFAULT_MAX_DIMENSION,
};
pub use selector::Selector;
pub use tokio_util::sync::CancellationToken;
pub use tree_formatter::{
    format_clustered_tree_from_caches, format_ocr_tree_as_compact_yaml,
    format_tree_as_compact_yaml, format_ui_node_as_compact_yaml, serializable_to_ui_node,
    ClusteredFormattingResult, ElementSource, OcrFormattingResult, TreeFormattingResult,
    UnifiedElement,
};
pub use types::{FontStyle, HighlightHandle, OmniparserItem, TextPosition, VisionElement};
pub use utils::find_pid_for_process;

// Re-export types from computeruse-computer-use crate (cross-platform).
//
// Note: execution requires platform-specific Desktop capabilities; on non-Windows
// many actions are currently UnsupportedOperation, but the types remain available.
pub use computeruse_computer_use::{
    call_computer_use_backend, convert_normalized_to_screen, translate_gemini_keys,
    ComputerUseActionResponse, ComputerUseFunctionCall, ComputerUsePreviousAction,
    ComputerUseResponse, ComputerUseResult, ComputerUseStep, ProgressCallback,
};

// Re-export cross-platform types from platforms
pub use platforms::{OverlayDisplayMode, PropertyLoadingMode, TreeBuildConfig};

// Re-export window manager + overlay helpers.
// On non-Windows these are stubs to keep downstream crates compiling.
pub use platforms::windows::window_manager::{WindowCache, WindowInfo, WindowManager, WindowPlacement};
pub use platforms::windows::{
    hide_action_overlay, hide_inspect_overlay, highlight_bounds, is_action_overlay_enabled,
    set_action_overlay_enabled, show_action_overlay, show_inspect_overlay, stop_all_highlights,
    update_action_overlay_message, ActionOverlayGuard, InspectElement, InspectOverlayHandle,
};

// Cross-platform helper (Windows has a richer implementation).
pub use platforms::is_browser_process;

/// Walk up the element tree to find the parent Window or Pane element.
///
/// This is useful when you have a focused element (e.g., a button inside a window)
/// and need to find the containing window to build a UI tree from.
///
/// # Arguments
/// * `element` - The UIElement to start from
///
/// # Returns
/// The parent Window/Pane element, or None if not found
pub fn find_parent_window(element: &UIElement) -> Option<UIElement> {
    let mut current = element.clone();
    let start_role = current.role();
    let start_name = current.name().unwrap_or_default();

    tracing::debug!(
        "find_parent_window: starting from element role='{}' name='{}'",
        start_role,
        start_name
    );

    // Limit iterations to prevent infinite loops in malformed trees
    for depth in 0..100 {
        let role = current.role();
        let name = current.name().unwrap_or_default();

        if role == "Window"
            || role == "Pane"
            // macOS Accessibility roles are typically prefixed with "AX"
            || role == "AXWindow"
            || role == "AXPane"
        {
            tracing::debug!(
                "find_parent_window: found window at depth {} - role='{}' name='{}'",
                depth,
                role,
                name
            );
            return Some(current);
        }

        match current.parent() {
            Ok(Some(parent)) => {
                tracing::trace!(
                    "find_parent_window: depth {} role='{}' -> moving to parent",
                    depth,
                    role
                );
                current = parent;
            }
            Ok(None) => {
                tracing::debug!(
                    "find_parent_window: reached root at depth {} (role='{}' name='{}') without finding window",
                    depth,
                    role,
                    name
                );
                return None;
            }
            Err(e) => {
                tracing::warn!(
                    "find_parent_window: parent() failed at depth {} (role='{}' name='{}'): {}",
                    depth,
                    role,
                    name,
                    e
                );
                return None;
            }
        }
    }
    tracing::warn!(
        "find_parent_window: hit iteration limit without finding window (started from role='{}' name='{}')",
        start_role,
        start_name
    );
    None
}

/// Recommend to use any of these: ["Default", "Chrome", "Firefox", "Edge", "Brave", "Opera", "Vivaldi"]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Browser {
    Default,
    Chrome,
    Firefox,
    Edge,
    Brave,
    Opera,
    Vivaldi,
    Custom(String),
}

/// Type of mouse click to perform
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ClickType {
    /// Single left click (default)
    Left,
    /// Double left click
    Double,
    /// Single right click
    Right,
}

/// Source of indexed elements for click targeting
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum VisionType {
    /// UI Automation tree elements
    #[default]
    UiTree,
    /// OCR-detected text elements
    Ocr,
    /// Omniparser-detected elements
    Omniparser,
    /// Gemini Vision-detected elements
    Gemini,
    /// Browser DOM elements
    Dom,
}

#[cfg(target_os = "windows")]
pub use platforms::windows::{
    convert_uiautomation_element_to_computeruse, get_process_name_by_pid, set_recording_mode,
    KNOWN_BROWSER_PROCESS_NAMES,
};

// Define a new struct to hold click result information - move to module level
pub struct ClickResult {
    pub method: String,
    pub coordinates: Option<(f64, f64)>,
    pub details: String,
}

/// Result of text verification after typing
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TypeVerification {
    /// Whether verification passed
    pub passed: bool,
    /// The expected text that was typed
    pub expected: String,
    /// The actual value read from the element
    pub actual: Option<String>,
    /// Error message if verification failed
    pub error: Option<String>,
}

/// Generic result struct for UI actions with state tracking
pub struct ActionResult {
    pub action: String,
    pub details: String,
    pub data: Option<serde_json::Value>,
    /// Verification result for type operations
    pub verification: Option<TypeVerification>,
}

/// Holds the output of a terminal command execution
pub struct CommandOutput {
    pub exit_status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Result of get_window_tree operation with all computed data
///
/// This struct provides everything needed for UI automation:
/// - Raw UINode tree for programmatic traversal
/// - Formatted output for LLM consumption
/// - Index-to-bounds mapping for click targeting
/// - Metadata about the window/process
#[derive(Debug, Clone)]
#[allow(clippy::type_complexity)]
pub struct WindowTreeResult {
    /// The raw UI tree structure
    pub tree: UINode,
    /// Process ID of the window
    pub pid: u32,
    /// Whether this is a browser window
    pub is_browser: bool,
    /// Formatted compact YAML output (if format_output was true)
    pub formatted: Option<String>,
    /// Mapping of index to (role, name, bounds, selector) for click targeting
    /// Key is 1-based index, value is (role, name, (x, y, width, height), selector)
    pub index_to_bounds:
        std::collections::HashMap<u32, (String, String, (f64, f64, f64, f64), Option<String>)>,
    /// Total count of indexed elements (elements with bounds)
    pub element_count: u32,
}

/// Options for UI diff capture during action execution
#[derive(Debug, Clone, Default)]
pub struct UiDiffOptions {
    /// Maximum depth for tree capture
    pub max_depth: Option<usize>,
    /// Delay in ms after action for UI to settle (default 1500)
    pub settle_delay_ms: Option<u64>,
    /// Include detailed element attributes (enabled, focused, etc.)
    pub include_detailed_attributes: Option<bool>,
}

/// Result of UI diff capture
#[derive(Debug, Clone)]
pub struct UiDiffResult {
    /// The computed diff showing changes (lines starting with + or -)
    pub diff: String,
    /// Whether any UI changes were detected
    pub has_changes: bool,
}

/// Represents a monitor/display device
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Monitor {
    /// Unique identifier for the monitor
    pub id: String,
    /// Human-readable name of the monitor
    pub name: String,
    /// Whether this is the primary monitor
    pub is_primary: bool,
    /// Monitor dimensions
    pub width: u32,
    pub height: u32,
    /// Monitor position (top-left corner)
    pub x: i32,
    pub y: i32,
    /// Scale factor (e.g., 1.0 for 100%, 1.25 for 125%)
    pub scale_factor: f64,
    /// Work area dimensions (screen area excluding taskbar) - Windows only
    /// On other platforms, this will be the same as the full monitor dimensions
    pub work_area: Option<WorkAreaBounds>,
}

/// Represents the work area bounds (excluding taskbar and docked windows)
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct WorkAreaBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Monitor {
    /// Capture a screenshot of this monitor
    #[instrument(skip(self, desktop))]
    pub async fn capture(&self, desktop: &Desktop) -> Result<ScreenshotResult, AutomationError> {
        desktop.engine.capture_monitor_by_id(&self.id).await
    }

    /// Check if this monitor contains the given coordinates
    pub fn contains_point(&self, x: i32, y: i32) -> bool {
        x >= self.x
            && x < self.x + self.width as i32
            && y >= self.y
            && y < self.y + self.height as i32
    }

    /// Get the center point of this monitor
    pub fn center(&self) -> (i32, i32) {
        (
            self.x + self.width as i32 / 2,
            self.y + self.height as i32 / 2,
        )
    }
}

/// Represents a node in the UI tree, containing its attributes and children.
#[derive(Clone, Serialize, Deserialize, Default)]
pub struct UINode {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub attributes: UIElementAttributes,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<UINode>,
    /// Chained selector path from root to this node (e.g., "role:Window && name:App >> role:Button && name:Submit")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
}

impl fmt::Debug for UINode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.debug_with_depth(f, 0, 100)
    }
}

impl UINode {
    /// Helper method for debug formatting with depth control
    fn debug_with_depth(
        &self,
        f: &mut fmt::Formatter<'_>,
        current_depth: usize,
        max_depth: usize,
    ) -> fmt::Result {
        let mut debug_struct = f.debug_struct("UINode");
        debug_struct.field("attributes", &self.attributes);

        if !self.children.is_empty() {
            if current_depth < max_depth {
                debug_struct.field(
                    "children",
                    &DebugChildrenWithDepth {
                        children: &self.children,
                        current_depth,
                        max_depth,
                    },
                );
            } else {
                debug_struct.field(
                    "children",
                    &format!("[{} children (depth limit reached)]", self.children.len()),
                );
            }
        }

        debug_struct.finish()
    }
}

/// Helper struct for debug formatting children with depth control
struct DebugChildrenWithDepth<'a> {
    children: &'a Vec<UINode>,
    current_depth: usize,
    max_depth: usize,
}

impl fmt::Debug for DebugChildrenWithDepth<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut list = f.debug_list();

        // Show ALL children, no limit
        for child in self.children.iter() {
            list.entry(&DebugNodeWithDepth {
                node: child,
                current_depth: self.current_depth + 1,
                max_depth: self.max_depth,
            });
        }

        list.finish()
    }
}

/// Helper struct for debug formatting a single node with depth control
struct DebugNodeWithDepth<'a> {
    node: &'a UINode,
    current_depth: usize,
    max_depth: usize,
}

impl fmt::Debug for DebugNodeWithDepth<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.node
            .debug_with_depth(f, self.current_depth, self.max_depth)
    }
}

// Removed struct ScreenshotResult (moved to screenshot.rs)

/// Cached element bounds for index-based click targeting
/// Stored as (role/label, name/text, bounds, optional_selector)
type UiaBoundsCache = HashMap<u32, (String, String, (f64, f64, f64, f64), Option<String>)>;
/// OCR bounds cache: (text, bounds)
type OcrBoundsCache = HashMap<u32, (String, (f64, f64, f64, f64))>;
/// DOM bounds cache: (tag, id, bounds)
type DomBoundsCache = HashMap<u32, (String, String, (f64, f64, f64, f64))>;

/// The main entry point for UI automation
pub struct Desktop {
    engine: Arc<dyn platforms::AccessibilityEngine>,
    /// Cancellation token for stopping execution (wrapped in RwLock to allow reset)
    cancellation_token: Arc<RwLock<CancellationToken>>,
    /// Cache for UI Automation tree element bounds (index → bounds info)
    uia_cache: Arc<Mutex<UiaBoundsCache>>,
    /// Cache for OCR element bounds
    ocr_cache: Arc<Mutex<OcrBoundsCache>>,
    /// Cache for Omniparser element bounds
    omniparser_cache: Arc<Mutex<HashMap<u32, OmniparserItem>>>,
    /// Cache for Gemini Vision element bounds
    vision_cache: Arc<Mutex<HashMap<u32, VisionElement>>>,
    /// Cache for DOM element bounds
    dom_cache: Arc<Mutex<DomBoundsCache>>,
}

impl Desktop {
    #[instrument(skip(use_background_apps, activate_app))]
    pub fn new(use_background_apps: bool, activate_app: bool) -> Result<Self, AutomationError> {
        let engine = platforms::create_engine(use_background_apps, activate_app)?;
        Ok(Self {
            engine,
            cancellation_token: Arc::new(RwLock::new(CancellationToken::new())),
            uia_cache: Arc::new(Mutex::new(HashMap::new())),
            ocr_cache: Arc::new(Mutex::new(HashMap::new())),
            omniparser_cache: Arc::new(Mutex::new(HashMap::new())),
            vision_cache: Arc::new(Mutex::new(HashMap::new())),
            dom_cache: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// Initializet the desktop without arguments
    ///
    /// This is a convenience method that calls `new` with default arguments.
    ///
    /// # Examples
    ///
    /// ```
    /// use computeruse::Desktop;
    /// let desktop = Desktop::new_default()?;
    /// # Ok::<(), computeruse::AutomationError>(())
    /// ```
    pub fn new_default() -> Result<Self, AutomationError> {
        Self::new(false, false)
    }

    /// Gets the root element representing the entire desktop.
    ///
    /// This is the top-level element that contains all applications, windows,
    /// and UI elements on the desktop. You can use it as a starting point for
    /// element searches.
    ///
    /// # Examples
    ///
    /// ```
    /// use computeruse::Desktop;
    /// let desktop = Desktop::new(false, false)?;
    /// let root = desktop.root();
    /// println!("Root element ID: {:?}", root.id());
    /// # Ok::<(), computeruse::AutomationError>(())
    /// ```
    pub fn root(&self) -> UIElement {
        self.engine.get_root_element()
    }

    #[instrument(level = "debug", skip(self, selector))]
    pub fn locator(&self, selector: impl Into<Selector>) -> Locator {
        let selector = selector.into();
        Locator::new(self.engine.clone(), selector)
    }

    #[instrument(skip(self))]
    pub fn focused_element(&self) -> Result<UIElement, AutomationError> {
        self.engine.get_focused_element()
    }

    #[instrument(skip(self))]
    pub fn applications(&self) -> Result<Vec<UIElement>, AutomationError> {
        self.engine.get_applications()
    }

    #[instrument(skip(self, name))]
    pub fn application(&self, name: &str) -> Result<UIElement, AutomationError> {
        self.engine.get_application_by_name(name)
    }

    #[instrument(skip(self, app_name))]
    pub fn open_application(&self, app_name: &str) -> Result<UIElement, AutomationError> {
        self.engine.open_application(app_name)
    }

    #[instrument(skip(self, app_name))]
    pub fn activate_application(&self, app_name: &str) -> Result<(), AutomationError> {
        self.engine.activate_application(app_name)
    }

    #[instrument(skip(self, url, browser))]
    pub fn open_url(
        &self,
        url: &str,
        browser: Option<Browser>,
    ) -> Result<UIElement, AutomationError> {
        self.engine.open_url(url, browser)
    }

    #[instrument(skip(self, file_path))]
    pub fn open_file(&self, file_path: &str) -> Result<(), AutomationError> {
        self.engine.open_file(file_path)
    }

    #[instrument(skip(self, windows_command, unix_command))]
    pub async fn run_command(
        &self,
        windows_command: Option<&str>,
        unix_command: Option<&str>,
    ) -> Result<CommandOutput, AutomationError> {
        self.engine.run_command(windows_command, unix_command).await
    }

    /// Execute a shell command using GitHub Actions-style syntax
    ///
    /// # Arguments
    /// * `command` - The command to run (can be single or multi-line)
    /// * `shell` - Optional shell to use (defaults to PowerShell on Windows, bash on Unix)
    /// * `working_directory` - Optional working directory for the command
    ///
    /// # Examples
    /// ```no_run
    /// use computeruse::Desktop;
    /// #[tokio::main]
    /// async fn main() {
    ///     let desktop = Desktop::new_default().unwrap();
    ///     let output = desktop.run(
    ///         "echo 'Hello, World!'",
    ///         None,
    ///         None
    ///     ).await.unwrap();
    ///     println!("Output: {}", output.stdout);
    /// }
    /// ```
    #[instrument(skip(self, command))]
    pub async fn run(
        &self,
        command: &str,
        shell: Option<&str>,
        working_directory: Option<&str>,
    ) -> Result<CommandOutput, AutomationError> {
        // Determine which shell to use based on platform and user preference
        let (windows_cmd, unix_cmd) = if cfg!(target_os = "windows") {
            let shell = shell.unwrap_or("powershell");
            let command_with_cd = if let Some(cwd) = working_directory {
                match shell {
                    "cmd" => format!("cd /d \"{cwd}\" && {command}"),
                    "powershell" | "pwsh" => format!("cd '{cwd}'; {command}"),
                    _ => command.to_string(),
                }
            } else {
                command.to_string()
            };

            let windows_cmd = match shell {
                "bash" => format!("bash -c \"{}\"", command_with_cd.replace('\"', "\\\"")),
                "sh" => format!("sh -c \"{}\"", command_with_cd.replace('\"', "\\\"")),
                "cmd" => format!("cmd /c \"{command_with_cd}\""),
                "powershell" | "pwsh" => command_with_cd,
                _ => command_with_cd,
            };
            (Some(windows_cmd), None)
        } else {
            let shell = shell.unwrap_or("bash");
            let command_with_cd = if let Some(cwd) = working_directory {
                format!("cd '{cwd}' && {command}")
            } else {
                command.to_string()
            };

            let unix_cmd = match shell {
                "python" => format!("python -c \"{}\"", command_with_cd.replace('\"', "\\\"")),
                "node" => format!("node -e \"{}\"", command_with_cd.replace('\"', "\\\"")),
                _ => command_with_cd,
            };
            (None, Some(unix_cmd))
        };

        self.engine
            .run_command(windows_cmd.as_deref(), unix_cmd.as_deref())
            .await
    }

    // ============== NEW MONITOR ABSTRACTIONS ==============

    /// List all available monitors/displays
    ///
    /// Returns a vector of Monitor structs containing information about each display,
    /// including dimensions, position, scale factor, and whether it's the primary monitor.
    ///
    /// # Examples
    ///
    /// ```no_run
    /// use computeruse::Desktop;
    /// #[tokio::main]
    /// async fn main() {
    ///     let desktop = Desktop::new_default().unwrap();
    ///     let monitors = desktop.list_monitors().await.unwrap();
    ///     for monitor in monitors {
    ///         println!("Monitor: {} ({}x{})", monitor.name, monitor.width, monitor.height);
    ///     }
    /// }
    /// ```
    #[instrument(skip(self))]
    pub async fn list_monitors(&self) -> Result<Vec<Monitor>, AutomationError> {
        self.engine.list_monitors().await
    }

    /// Get the primary monitor
    ///
    /// Returns the monitor marked as primary in the system settings.
    ///
    /// # Examples
    ///
    /// ```no_run
    /// use computeruse::Desktop;
    /// #[tokio::main]
    /// async fn main() {
    ///     let desktop = Desktop::new_default().unwrap();
    ///     let primary = desktop.get_primary_monitor().await.unwrap();
    ///     println!("Primary monitor: {}", primary.name);
    /// }
    /// ```
    #[instrument(skip(self))]
    pub async fn get_primary_monitor(&self) -> Result<Monitor, AutomationError> {
        self.engine.get_primary_monitor().await
    }

    /// Get the monitor containing the currently focused window
    ///
    /// Returns the monitor that contains the currently active/focused window.
    ///
    /// # Examples
    ///
    /// ```no_run
    /// use computeruse::Desktop;
    /// #[tokio::main]
    /// async fn main() {
    ///     let desktop = Desktop::new_default().unwrap();
    ///     let active = desktop.get_active_monitor().await.unwrap();
    ///     println!("Active monitor: {}", active.name);
    /// }
    /// ```
    #[instrument(skip(self))]
    pub async fn get_active_monitor(&self) -> Result<Monitor, AutomationError> {
        self.engine.get_active_monitor().await
    }

    /// Get a monitor by its ID
    ///
    /// # Examples
    ///
    /// ```no_run
    /// use computeruse::Desktop;
    /// #[tokio::main]
    /// async fn main() {
    ///     let desktop = Desktop::new_default().unwrap();
    ///     let monitor = desktop.get_monitor_by_id("monitor_id").await.unwrap();
    /// }
    /// ```
    #[instrument(skip(self, id))]
    pub async fn get_monitor_by_id(&self, id: &str) -> Result<Monitor, AutomationError> {
        self.engine.get_monitor_by_id(id).await
    }

    /// Get a monitor by its name
    ///
    /// # Examples
    ///
    /// ```no_run
    /// use computeruse::Desktop;
    /// #[tokio::main]
    /// async fn main() {
    ///     let desktop = Desktop::new_default().unwrap();
    ///     let monitor = desktop.get_monitor_by_name("Dell Monitor").await.unwrap();
    /// }
    /// ```
    #[instrument(skip(self, name))]
    pub async fn get_monitor_by_name(&self, name: &str) -> Result<Monitor, AutomationError> {
        self.engine.get_monitor_by_name(name).await
    }

    /// Capture a screenshot of a specific monitor
    ///
    /// # Examples
    ///
    /// ```no_run
    /// use computeruse::Desktop;
    /// #[tokio::main]
    /// async fn main() {
    ///     let desktop = Desktop::new_default().unwrap();
    ///     let monitor = desktop.get_primary_monitor().await.unwrap();
    ///     let screenshot = desktop.capture_monitor(&monitor).await.unwrap();
    /// }
    /// ```
    #[instrument(skip(self, monitor))]
    pub async fn capture_monitor(
        &self,
        monitor: &Monitor,
    ) -> Result<ScreenshotResult, AutomationError> {
        let mut result = self.engine.capture_monitor_by_id(&monitor.id).await?;
        result.monitor = Some(monitor.clone());
        Ok(result)
    }

    /// Capture screenshots of all monitors
    ///
    /// Returns a vector of (Monitor, ScreenshotResult) pairs for each display.
    ///
    /// # Examples
    ///
    /// ```no_run
    /// use computeruse::Desktop;
    /// #[tokio::main]
    /// async fn main() {
    ///     let desktop = Desktop::new_default().unwrap();
    ///     let screenshots = desktop.capture_all_monitors().await.unwrap();
    ///     for (monitor, screenshot) in screenshots {
    ///         println!("Captured monitor: {} ({}x{})", monitor.name, screenshot.width, screenshot.height);
    ///     }
    /// }
    /// ```
    #[instrument(skip(self))]
    pub async fn capture_all_monitors(
        &self,
    ) -> Result<Vec<(Monitor, ScreenshotResult)>, AutomationError> {
        let monitors = self.list_monitors().await?;
        let mut results = Vec::new();

        for monitor in monitors {
            match self.capture_monitor(&monitor).await {
                Ok(screenshot) => results.push((monitor, screenshot)),
                Err(e) => {
                    error!("Failed to capture monitor {}: {}", monitor.name, e);
                    // Continue with other monitors rather than failing completely
                }
            }
        }

        if results.is_empty() {
            return Err(AutomationError::PlatformError(
                "Failed to capture any monitors".to_string(),
            ));
        }

        Ok(results)
    }

    /// Capture a screenshot of a window by process name
    ///
    /// Finds the first window matching the given process name and captures its screenshot.
    /// Process name matching is case-insensitive and uses substring matching.
    ///
    /// # Arguments
    /// * `process` - Process name to match (e.g., "chrome", "notepad", "code")
    ///
    /// # Examples
    ///
    /// ```no_run
    /// use computeruse::Desktop;
    /// fn main() {
    ///     let desktop = Desktop::new_default().unwrap();
    ///     let screenshot = desktop.capture_window_by_process("notepad").unwrap();
    ///     // Convert to base64 PNG for LLM consumption
    ///     let base64_png = screenshot.to_base64_png_resized(Some(1920)).unwrap();
    /// }
    /// ```
    #[instrument(skip(self))]
    pub fn capture_window_by_process(
        &self,
        process: &str,
    ) -> Result<ScreenshotResult, AutomationError> {
        let apps = self.applications()?;
        let process_lower = process.to_lowercase();

        // Use sysinfo for reliable process name lookup (same as get_applications_and_windows_list)
        let mut system = System::new();
        system.refresh_processes(ProcessesToUpdate::All, true);

        // Find matching window by process name using sysinfo
        let window_element = apps.into_iter().find(|app| {
            let pid = app.process_id().unwrap_or(0);
            if pid > 0 {
                system
                    .process(sysinfo::Pid::from_u32(pid))
                    .map(|p| {
                        p.name()
                            .to_string_lossy()
                            .to_lowercase()
                            .contains(&process_lower)
                    })
                    .unwrap_or(false)
            } else {
                false
            }
        });

        let window_element = window_element.ok_or_else(|| {
            AutomationError::ElementNotFound(format!("No window found for process '{}'", process))
        })?;

        window_element.capture()
    }

    // ============== DEPRECATED METHODS ==============

    // ============== END DEPRECATED METHODS ==============

    #[instrument(skip(self, image_path))]
    pub async fn ocr_image_path(&self, image_path: &str) -> Result<String, AutomationError> {
        self.engine.ocr_image_path(image_path).await
    }

    #[instrument(skip(self, screenshot))]
    pub async fn ocr_screenshot(
        &self,
        screenshot: &ScreenshotResult,
    ) -> Result<String, AutomationError> {
        self.engine.ocr_screenshot(screenshot).await
    }

    /// OCR on screenshot with bounding boxes - returns structured OCR elements with absolute screen coordinates
    /// Window coordinates are used to convert OCR bounding boxes to absolute screen positions
    ///
    /// # Arguments
    /// * `screenshot` - The screenshot to perform OCR on
    /// * `window_x` - X offset of the window on screen in logical coordinates
    /// * `window_y` - Y offset of the window on screen in logical coordinates
    /// * `dpi_scale_x` - DPI scale factor for X (screenshot_width / window_logical_width)
    /// * `dpi_scale_y` - DPI scale factor for Y (screenshot_height / window_logical_height)
    #[instrument(skip(self, screenshot))]
    pub fn ocr_screenshot_with_bounds(
        &self,
        screenshot: &ScreenshotResult,
        window_x: f64,
        window_y: f64,
        dpi_scale_x: f64,
        dpi_scale_y: f64,
    ) -> Result<OcrElement, AutomationError> {
        self.engine.ocr_screenshot_with_bounds(
            screenshot,
            window_x,
            window_y,
            dpi_scale_x,
            dpi_scale_y,
        )
    }

    /// Click at absolute screen coordinates
    /// This is useful for clicking on OCR-detected text elements
    /// If `restore_cursor` is true, the cursor position will be restored after the click
    #[instrument(skip(self))]
    pub fn click_at_coordinates(
        &self,
        x: f64,
        y: f64,
        restore_cursor: bool,
    ) -> Result<(), AutomationError> {
        self.engine.click_at_coordinates(x, y, restore_cursor)
    }

    /// Click at absolute screen coordinates with specified click type (left, double, right)
    /// This is useful for clicking on OCR-detected text elements with different click types
    /// If `restore_cursor` is true, the cursor position will be restored after the click
    #[instrument(skip(self))]
    pub fn click_at_coordinates_with_type(
        &self,
        x: f64,
        y: f64,
        click_type: ClickType,
        restore_cursor: bool,
    ) -> Result<(), AutomationError> {
        self.engine
            .click_at_coordinates_with_type(x, y, click_type, restore_cursor)
    }

    /// Click within element bounds at a specified position (percentage-based).
    ///
    /// This is useful for clicking on elements from UI tree, OCR, omniparser, gemini vision, or DOM
    /// without needing an element reference - just the bounds.
    ///
    /// # Arguments
    /// * `bounds` - Element bounds as (x, y, width, height)
    /// * `click_position` - Optional (x_percentage, y_percentage) within bounds. Defaults to center (50, 50)
    /// * `click_type` - Type of click: Left, Double, or Right
    /// * `restore_cursor` - If true, cursor position will be restored after the click
    ///
    /// # Returns
    /// ClickResult with coordinates and method details
    #[instrument(skip(self))]
    pub fn click_at_bounds(
        &self,
        bounds: (f64, f64, f64, f64),
        click_position: Option<(u8, u8)>,
        click_type: ClickType,
        restore_cursor: bool,
    ) -> Result<ClickResult, AutomationError> {
        let (x_pct, y_pct) = click_position.unwrap_or((50, 50));
        let x = bounds.0 + bounds.2 * x_pct as f64 / 100.0;
        let y = bounds.1 + bounds.3 * y_pct as f64 / 100.0;

        self.engine
            .click_at_coordinates_with_type(x, y, click_type, restore_cursor)?;

        Ok(ClickResult {
            method: "bounds".to_string(),
            coordinates: Some((x, y)),
            details: format!(
                "Clicked at {}%,{}% within bounds ({}, {}, {}, {})",
                x_pct, y_pct, bounds.0, bounds.1, bounds.2, bounds.3
            ),
        })
    }

    /// Click on an element by its index from the last tree/vision query.
    ///
    /// This looks up cached bounds from the appropriate cache based on vision_type,
    /// then clicks at the specified position within those bounds.
    ///
    /// # Arguments
    /// * `index` - 1-based index from the tree/vision output (e.g., #1, #2)
    /// * `vision_type` - Source of the index: UiTree, Ocr, Omniparser, Gemini, or Dom
    /// * `click_position` - Optional (x_percentage, y_percentage) within bounds. Defaults to center (50, 50)
    /// * `click_type` - Type of click: Left, Double, or Right
    /// * `restore_cursor` - If true, cursor position will be restored after the click
    ///
    /// # Returns
    /// ClickResult with coordinates, element info, and method details
    ///
    /// # Errors
    /// Returns error if index not found in cache (call get_window_tree/get_ocr/etc first)
    #[instrument(skip(self))]
    pub fn click_by_index(
        &self,
        index: u32,
        vision_type: VisionType,
        click_position: Option<(u8, u8)>,
        click_type: ClickType,
        restore_cursor: bool,
    ) -> Result<ClickResult, AutomationError> {
        let (label, bounds) = match vision_type {
            VisionType::UiTree => {
                let cache = self.uia_cache.lock().map_err(|e| {
                    AutomationError::Internal(format!("Failed to lock UIA cache: {}", e))
                })?;
                let entry = cache.get(&index).ok_or_else(|| {
                    AutomationError::ElementNotFound(format!(
                        "UI tree index #{} not found. Call get_window_tree first.",
                        index
                    ))
                })?;
                let label = if entry.1.is_empty() {
                    entry.0.clone()
                } else {
                    format!("{}: {}", entry.0, entry.1)
                };
                (label, entry.2)
            }
            VisionType::Ocr => {
                let cache = self.ocr_cache.lock().map_err(|e| {
                    AutomationError::Internal(format!("Failed to lock OCR cache: {}", e))
                })?;
                let entry = cache.get(&index).ok_or_else(|| {
                    AutomationError::ElementNotFound(format!(
                        "OCR index #{} not found. Call ocr methods first.",
                        index
                    ))
                })?;
                (entry.0.clone(), entry.1)
            }
            VisionType::Omniparser => {
                let cache = self.omniparser_cache.lock().map_err(|e| {
                    AutomationError::Internal(format!("Failed to lock Omniparser cache: {}", e))
                })?;
                let item = cache.get(&index).ok_or_else(|| {
                    AutomationError::ElementNotFound(format!(
                        "Omniparser index #{} not found. Call omniparser methods first.",
                        index
                    ))
                })?;
                let box_2d = item.box_2d.ok_or_else(|| {
                    AutomationError::Internal(format!("Omniparser index #{} has no bounds", index))
                })?;
                // Convert [x_min, y_min, x_max, y_max] to (x, y, width, height)
                let bounds = (
                    box_2d[0],
                    box_2d[1],
                    box_2d[2] - box_2d[0],
                    box_2d[3] - box_2d[1],
                );
                (item.label.clone(), bounds)
            }
            VisionType::Gemini => {
                let cache = self.vision_cache.lock().map_err(|e| {
                    AutomationError::Internal(format!("Failed to lock Vision cache: {}", e))
                })?;
                let item = cache.get(&index).ok_or_else(|| {
                    AutomationError::ElementNotFound(format!(
                        "Gemini index #{} not found. Call gemini vision methods first.",
                        index
                    ))
                })?;
                let box_2d = item.box_2d.ok_or_else(|| {
                    AutomationError::Internal(format!("Gemini index #{} has no bounds", index))
                })?;
                // Convert [x_min, y_min, x_max, y_max] to (x, y, width, height)
                let bounds = (
                    box_2d[0],
                    box_2d[1],
                    box_2d[2] - box_2d[0],
                    box_2d[3] - box_2d[1],
                );
                (item.element_type.clone(), bounds)
            }
            VisionType::Dom => {
                let cache = self.dom_cache.lock().map_err(|e| {
                    AutomationError::Internal(format!("Failed to lock DOM cache: {}", e))
                })?;
                let entry = cache.get(&index).ok_or_else(|| {
                    AutomationError::ElementNotFound(format!(
                        "DOM index #{} not found. Call DOM methods first.",
                        index
                    ))
                })?;
                let label = if entry.1.is_empty() {
                    entry.0.clone()
                } else {
                    format!("{}: {}", entry.0, entry.1)
                };
                (label, entry.2)
            }
        };

        let (x_pct, y_pct) = click_position.unwrap_or((50, 50));
        let x = bounds.0 + bounds.2 * x_pct as f64 / 100.0;
        let y = bounds.1 + bounds.3 * y_pct as f64 / 100.0;

        self.engine
            .click_at_coordinates_with_type(x, y, click_type, restore_cursor)?;

        Ok(ClickResult {
            method: "index".to_string(),
            coordinates: Some((x, y)),
            details: format!(
                "Clicked #{} [{}] at {}%,{}% (bounds: {:.0},{:.0},{:.0},{:.0})",
                index, label, x_pct, y_pct, bounds.0, bounds.1, bounds.2, bounds.3
            ),
        })
    }

    /// Populate the OCR cache for index-based clicking.
    /// Call this after performing OCR to enable click_by_index with VisionType::Ocr.
    ///
    /// # Arguments
    /// * `bounds_map` - Map of index to (text, bounds) from OCR formatting result
    #[allow(clippy::type_complexity)]
    pub fn populate_ocr_cache(&self, bounds_map: HashMap<u32, (String, (f64, f64, f64, f64))>) {
        if let Ok(mut cache) = self.ocr_cache.lock() {
            cache.clear();
            cache.extend(bounds_map);
            debug!("Populated OCR cache with {} elements", cache.len());
        }
    }

    /// Populate the Omniparser cache for index-based clicking.
    /// Call this after performing Omniparser to enable click_by_index with VisionType::Omniparser.
    ///
    /// # Arguments
    /// * `items` - Map of index to OmniparserItem from Omniparser result
    pub fn populate_omniparser_cache(&self, items: HashMap<u32, OmniparserItem>) {
        if let Ok(mut cache) = self.omniparser_cache.lock() {
            cache.clear();
            cache.extend(items);
            debug!("Populated Omniparser cache with {} elements", cache.len());
        }
    }

    /// Populate the Gemini vision cache for index-based clicking.
    /// Call this after performing Gemini vision to enable click_by_index with VisionType::Gemini.
    ///
    /// # Arguments
    /// * `items` - Map of index to VisionElement from Gemini result
    pub fn populate_vision_cache(&self, items: HashMap<u32, VisionElement>) {
        if let Ok(mut cache) = self.vision_cache.lock() {
            cache.clear();
            cache.extend(items);
            debug!("Populated Vision cache with {} elements", cache.len());
        }
    }

    /// Populate the DOM cache for index-based clicking.
    /// Call this after capturing browser DOM to enable click_by_index with VisionType::Dom.
    ///
    /// # Arguments
    /// * `bounds_map` - Map of index to (tag, id, bounds) from DOM capture
    #[allow(clippy::type_complexity)]
    pub fn populate_dom_cache(
        &self,
        bounds_map: HashMap<u32, (String, String, (f64, f64, f64, f64))>,
    ) {
        if let Ok(mut cache) = self.dom_cache.lock() {
            cache.clear();
            cache.extend(bounds_map);
            debug!("Populated DOM cache with {} elements", cache.len());
        }
    }

    /// Clear all vision caches.
    /// Call this when starting a new session or switching contexts.
    pub fn clear_vision_caches(&self) {
        if let Ok(mut cache) = self.uia_cache.lock() {
            cache.clear();
        }
        if let Ok(mut cache) = self.ocr_cache.lock() {
            cache.clear();
        }
        if let Ok(mut cache) = self.omniparser_cache.lock() {
            cache.clear();
        }
        if let Ok(mut cache) = self.vision_cache.lock() {
            cache.clear();
        }
        if let Ok(mut cache) = self.dom_cache.lock() {
            cache.clear();
        }
        debug!("Cleared all vision caches");
    }

    #[instrument(skip(self, title))]
    pub fn activate_browser_window_by_title(&self, title: &str) -> Result<(), AutomationError> {
        self.engine.activate_browser_window_by_title(title)
    }

    #[instrument(skip(self))]
    pub async fn get_current_browser_window(&self) -> Result<UIElement, AutomationError> {
        self.engine.get_current_browser_window().await
    }

    /// Execute JavaScript in the currently focused browser tab.
    /// Automatically finds the active browser window and executes the script.
    ///
    /// This method respects cancellation - if `stop_execution()` is called,
    /// the operation will be interrupted and return an error.
    #[instrument(skip(self, script))]
    pub async fn execute_browser_script(&self, script: &str) -> Result<String, AutomationError> {
        let browser_window = self.engine.get_current_browser_window().await?;
        let cancel_token = self.cancellation_token();
        tokio::select! {
            result = browser_window.execute_browser_script(script) => result,
            _ = cancel_token.cancelled() => {
                Err(AutomationError::OperationCancelled("Browser script execution cancelled by stop_execution".into()))
            }
        }
    }
    /// Close a browser tab safely using the browser extension
    ///
    /// This method can identify the tab to close by:
    /// - tab_id: Close a specific tab by its Chrome tab ID
    /// - url: Find and close a tab matching this URL
    /// - title: Find and close a tab matching this title
    /// - If none provided, closes the currently active tab
    ///
    /// Returns information about the closed tab for verification.
    /// Returns None if no extension is connected or tab couldn't be found.
    ///
    /// # Safety
    /// - Will NOT close protected browser pages (chrome://, about:, etc.)
    /// - Returns the closed tab's URL/title so you can verify the right tab was closed
    ///
    /// # Examples
    /// ```no_run
    /// use computeruse::Desktop;
    /// use std::time::Duration;
    ///
    /// async fn example() {
    ///     let desktop = Desktop::new_default().unwrap();
    ///     
    ///     // Close by URL
    ///     let result = desktop.close_tab(None, Some("example.com"), None).await;
    ///     
    ///     // Close by title
    ///     let result = desktop.close_tab(None, None, Some("My Tab")).await;
    ///     
    ///     // Close active tab
    ///     let result = desktop.close_tab(None, None, None).await;
    /// }
    /// ```
    #[instrument(skip(self))]
    pub async fn close_tab(
        &self,
        tab_id: Option<i32>,
        url: Option<&str>,
        title: Option<&str>,
    ) -> Result<Option<extension_bridge::CloseTabResult>, AutomationError> {
        use std::time::Duration;
        extension_bridge::try_close_tab(tab_id, url, title, Duration::from_secs(10)).await
    }
    #[instrument(skip(self))]
    pub async fn get_current_window(&self) -> Result<UIElement, AutomationError> {
        self.engine.get_current_window().await
    }

    #[instrument(skip(self))]
    pub async fn get_current_application(&self) -> Result<UIElement, AutomationError> {
        self.engine.get_current_application().await
    }

    #[instrument(skip(self, pid, title, config))]
    pub fn get_window_tree(
        &self,
        pid: u32,
        title: Option<&str>,
        config: Option<crate::platforms::TreeBuildConfig>,
    ) -> Result<UINode, AutomationError> {
        let tree_config = config.unwrap_or_default();
        self.engine.get_window_tree(pid, title, tree_config)
    }

    /// Build UI tree directly from a UIElement
    ///
    /// This avoids the PID-based window enumeration which can fail during
    /// transient UI Automation states. Use when you already have a UIElement.
    ///
    /// # Arguments
    /// * `element` - The UIElement to build tree from
    /// * `config` - Optional tree building configuration
    ///
    /// # Returns
    /// Complete UI tree starting from the provided element
    #[instrument(skip(self, element, config))]
    pub fn get_tree_from_element(
        &self,
        element: &UIElement,
        config: Option<crate::platforms::TreeBuildConfig>,
    ) -> Result<UINode, AutomationError> {
        let tree_config = config.unwrap_or_default();
        self.engine.get_tree_from_element(element, tree_config)
    }

    /// Find the parent window of an element and build tree from it
    ///
    /// Walks up the element tree to find Window/Pane, then builds the UI tree.
    /// This is the recommended method when you have a focused element from an event,
    /// as it avoids desktop enumeration which can fail during transient states.
    ///
    /// # Arguments
    /// * `element` - The UIElement to start from (e.g., focused element)
    /// * `config` - Optional tree building configuration
    ///
    /// # Returns
    /// Complete UI tree starting from the parent window
    #[instrument(skip(self, element, config))]
    pub fn get_window_tree_from_element(
        &self,
        element: &UIElement,
        config: Option<crate::platforms::TreeBuildConfig>,
    ) -> Result<UINode, AutomationError> {
        let window = find_parent_window(element).ok_or_else(|| {
            AutomationError::ElementNotFound("Could not find parent window for element".to_string())
        })?;

        tracing::info!(
            "Found parent window: '{}' (role: {})",
            window.name().unwrap_or_default(),
            window.role()
        );

        self.get_tree_from_element(&window, config)
    }

    /// Get the UI tree with full result including formatting and bounds mapping
    ///
    /// This is the recommended method for getting window trees when you need:
    /// - Formatted YAML output for LLM consumption
    /// - Index-to-bounds mapping for click targeting
    /// - Browser detection
    ///
    /// # Arguments
    /// * `pid` - Process ID of the target application
    /// * `title` - Optional window title filter
    /// * `config` - Tree building configuration (format_output controls formatted output)
    ///
    /// # Returns
    /// `WindowTreeResult` containing the tree, formatted output, and bounds mapping
    #[instrument(skip(self, pid, title, config))]
    pub fn get_window_tree_result(
        &self,
        pid: u32,
        title: Option<&str>,
        config: Option<crate::platforms::TreeBuildConfig>,
    ) -> Result<WindowTreeResult, AutomationError> {
        let tree_config = config.unwrap_or_default();
        let format_output = tree_config.format_output;

        // Get the raw tree
        let tree = self.engine.get_window_tree(pid, title, tree_config)?;

        // Check if browser process
        let is_browser = crate::platforms::is_browser_process(pid);

        // Format the tree and get bounds mapping if requested
        let (formatted, index_to_bounds, element_count) = if format_output {
            let result = format_ui_node_as_compact_yaml(&tree, 0);
            (
                Some(result.formatted),
                result.index_to_bounds,
                result.element_count,
            )
        } else {
            (None, HashMap::new(), 0)
        };

        // Populate the UIA cache for index-based clicking
        if !index_to_bounds.is_empty() {
            if let Ok(mut cache) = self.uia_cache.lock() {
                cache.clear();
                cache.extend(index_to_bounds.clone());
                debug!("Populated UIA cache with {} elements", cache.len());
            }
        }

        Ok(WindowTreeResult {
            tree,
            pid,
            is_browser,
            formatted,
            index_to_bounds,
            element_count,
        })
    }

    /// Get the UI tree with full result, with async support for from_selector
    ///
    /// This method extends `get_window_tree_result` with support for `from_selector`
    /// in the config, which allows building a subtree starting from a specific element
    /// instead of the full window.
    ///
    /// # Arguments
    /// * `pid` - Process ID of the target application
    /// * `title` - Optional window title filter
    /// * `config` - Tree building configuration. Set `from_selector` to scope the tree.
    ///
    /// # Returns
    /// `WindowTreeResult` containing the tree (or subtree), formatted output, and bounds mapping
    #[instrument(skip(self, pid, title, config))]
    pub async fn get_window_tree_result_async(
        &self,
        pid: u32,
        title: Option<&str>,
        config: Option<crate::platforms::TreeBuildConfig>,
    ) -> Result<WindowTreeResult, AutomationError> {
        let tree_config = config.unwrap_or_default();
        let format_output = tree_config.format_output;
        let from_selector = tree_config.from_selector.clone();
        let max_depth = tree_config.max_depth.unwrap_or(30);

        // If from_selector is specified, find the element and build subtree from it
        if let Some(selector_str) = from_selector {
            // Find app element by PID
            let apps = self.applications()?;
            let app_element = apps
                .into_iter()
                .find(|app| app.process_id().ok() == Some(pid))
                .ok_or_else(|| {
                    AutomationError::ElementNotFound(format!(
                        "No application found with PID {}",
                        pid
                    ))
                })?;

            // Find element by selector within the app
            let selector = Selector::from(selector_str.as_str());
            let locator = app_element.locator(selector)?;
            let element = locator
                .first(Some(std::time::Duration::from_millis(2000)))
                .await?;

            // Build subtree from this element
            let serializable_tree = element.to_serializable_tree(max_depth);
            let tree = serializable_to_ui_node(&serializable_tree);

            // Check if browser process
            let is_browser = crate::platforms::is_browser_process(pid);

            // Format the tree and get bounds mapping if requested
            let (formatted, index_to_bounds, element_count) = if format_output {
                let result = format_tree_as_compact_yaml(&serializable_tree, 0);
                (
                    Some(result.formatted),
                    result.index_to_bounds,
                    result.element_count,
                )
            } else {
                (None, HashMap::new(), 0)
            };

            // Populate the UIA cache for index-based clicking
            if !index_to_bounds.is_empty() {
                if let Ok(mut cache) = self.uia_cache.lock() {
                    cache.clear();
                    cache.extend(index_to_bounds.clone());
                    debug!(
                        "Populated UIA cache with {} elements (from_selector)",
                        cache.len()
                    );
                }
            }

            return Ok(WindowTreeResult {
                tree,
                pid,
                is_browser,
                formatted,
                index_to_bounds,
                element_count,
            });
        }

        // No from_selector - use the sync method
        self.get_window_tree_result(pid, title, Some(tree_config))
    }

    /// Get the UI tree for all open applications in parallel.
    ///
    /// This function retrieves the UI hierarchy for every running application
    /// on the desktop. It processes applications in parallel for better performance.
    ///
    /// # Examples
    ///
    /// ```no_run
    /// use computeruse::Desktop;
    /// #[tokio::main]
    /// async fn main() {
    ///     let desktop = Desktop::new_default().unwrap();
    ///     let app_trees = desktop.get_all_applications_tree().await.unwrap();
    ///     for tree in app_trees {
    ///         println!("Application Tree: {:#?}", tree);
    ///     }
    /// }
    /// ```
    /// This method respects cancellation - if `stop_execution()` is called,
    /// the operation will be interrupted and return an error.
    #[instrument(skip(self))]
    pub async fn get_all_applications_tree(&self) -> Result<Vec<UINode>, AutomationError> {
        let applications = self.applications()?;

        let futures = applications.into_iter().map(|app| {
            let desktop = self.clone();
            tokio::task::spawn_blocking(move || {
                let pid = match app.process_id() {
                    Ok(pid) if pid > 0 => pid,
                    _ => return None, // Skip apps with invalid or zero/negative PIDs
                };

                // TODO: tbh not sure it cannot lead to crash to run this in threads on windows :)
                match desktop.get_window_tree(pid, None, None) {
                    Ok(tree) => {
                        if !tree.children.is_empty() || tree.attributes.name.is_some() {
                            Some(tree)
                        } else {
                            None
                        }
                    }
                    Err(e) => {
                        let app_name = app.name().unwrap_or_else(|| "Unknown".to_string());
                        tracing::warn!(
                            "Could not get window tree for app '{}' (PID: {}): {}",
                            app_name,
                            pid,
                            e
                        );
                        None
                    }
                }
            })
        });

        // Use select to allow cancellation while waiting for all futures
        let cancel_token = self.cancellation_token();
        tokio::select! {
            results = futures::future::join_all(futures) => {
                let trees: Vec<UINode> = results
                    .into_iter()
                    .filter_map(|res| match res {
                        Ok(Some(tree)) => Some(tree),
                        Ok(None) => None,
                        Err(e) => {
                            error!("A task for getting a window tree panicked: {}", e);
                            None
                        }
                    })
                    .collect();

                Ok(trees)
            }
            _ = cancel_token.cancelled() => {
                Err(AutomationError::OperationCancelled("get_all_applications_tree cancelled by stop_execution".into()))
            }
        }
    }

    /// Get all window elements for a given application by name
    #[instrument(skip(self, app_name))]
    pub async fn windows_for_application(
        &self,
        app_name: &str,
    ) -> Result<Vec<UIElement>, AutomationError> {
        // 1. Find the application element
        let app_element = match self.application(app_name) {
            Ok(app) => app,
            Err(e) => {
                error!("Application '{}' not found: {}", app_name, e);
                return Err(e);
            }
        };

        // 2. Get children of the application element
        let children = match app_element.children() {
            Ok(ch) => ch,
            Err(e) => {
                error!(
                    "Failed to get children for application '{}': {}",
                    app_name, e
                );
                return Err(e);
            }
        };

        // 3. Filter children to find windows (cross-platform)
        let windows: Vec<UIElement> = children
            .into_iter()
            .filter(|el| {
                let role = el.role().to_lowercase();
                #[cfg(target_os = "macos")]
                {
                    role == "axwindow" || role == "window"
                }
                #[cfg(target_os = "windows")]
                {
                    role == "window"
                }
                #[cfg(not(any(target_os = "macos", target_os = "windows")))]
                {
                    // Fallback: just look for 'window' role
                    role == "window"
                }
            })
            .collect();

        debug!(
            window_count = windows.len(),
            "Found windows for application '{}'", app_name
        );

        Ok(windows)
    }

    pub async fn press_key(&self, key: &str) -> Result<(), AutomationError> {
        self.engine.press_key(key)
    }

    /// Delay execution for a specified number of milliseconds.
    /// Useful for waiting between actions to ensure UI stability.
    ///
    /// This method respects cancellation - if `stop_execution()` is called,
    /// the delay will be interrupted and return an error.
    pub async fn delay(&self, delay_ms: u64) -> Result<(), AutomationError> {
        let cancel_token = self.cancellation_token();
        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_millis(delay_ms)) => Ok(()),
            _ = cancel_token.cancelled() => {
                Err(AutomationError::OperationCancelled("Delay cancelled by stop_execution".into()))
            }
        }
    }

    /// Sets the zoom level to a specific percentage
    ///
    /// # Arguments
    /// * `percentage` - The zoom percentage (e.g., 100 for 100%, 150 for 150%, 50 for 50%)
    ///
    /// # Examples
    /// ```no_run
    /// use computeruse::Desktop;
    ///
    /// #[tokio::main]
    /// async fn main() {
    ///     let desktop = Desktop::new_default().unwrap();
    ///     // Set zoom to 150%
    ///     desktop.set_zoom(150).await.unwrap();
    ///
    ///     // Reset zoom to 100%
    ///     desktop.set_zoom(100).await.unwrap();
    /// }
    /// ```
    pub async fn set_zoom(&self, percentage: u32) -> Result<(), AutomationError> {
        self.engine.set_zoom(percentage)
    }

    /// Stop all currently executing operations.
    ///
    /// This cancels the internal cancellation token, which will cause any
    /// operations that check `is_cancelled()` to abort. After calling this,
    /// you should create a new Desktop instance to start fresh.
    ///
    /// # Examples
    /// ```no_run
    /// use computeruse::Desktop;
    ///
    /// let desktop = Desktop::new_default().unwrap();
    /// // ... start some operations ...
    /// desktop.stop_execution();
    /// ```
    pub fn stop_execution(&self) {
        info!("[STOP-DEBUG] Desktop::stop_execution called - cancelling all operations");
        if let Ok(token) = self.cancellation_token.read() {
            info!("[STOP-DEBUG] Calling cancellation_token.cancel()");
            token.cancel();
            info!("[STOP-DEBUG] cancellation_token.cancel() completed");
        } else {
            info!("[STOP-DEBUG] WARNING: Could not acquire cancellation_token lock");
        }
    }

    /// Check if execution has been cancelled.
    ///
    /// Returns `true` if `stop_execution()` has been called.
    /// Long-running operations should periodically check this and abort if true.
    ///
    /// # Examples
    /// ```no_run
    /// use computeruse::Desktop;
    ///
    /// let desktop = Desktop::new_default().unwrap();
    /// if desktop.is_cancelled() {
    ///     println!("Execution was cancelled");
    /// }
    /// ```
    pub fn is_cancelled(&self) -> bool {
        self.cancellation_token
            .read()
            .map(|t| t.is_cancelled())
            .unwrap_or(false)
    }

    /// Get a clone of the cancellation token for use in async operations.
    ///
    /// This allows external code to wait on cancellation or create child tokens.
    pub fn cancellation_token(&self) -> CancellationToken {
        self.cancellation_token
            .read()
            .map(|t| t.clone())
            .unwrap_or_else(|_| CancellationToken::new())
    }

    /// Reset the cancellation state, allowing new operations to run.
    ///
    /// This should be called at the start of new operations to clear any
    /// previous cancellation state from `stop_execution()`.
    ///
    /// # Examples
    /// ```no_run
    /// use computeruse::Desktop;
    ///
    /// let desktop = Desktop::new_default().unwrap();
    /// desktop.stop_execution(); // Cancel previous operations
    /// // ... later ...
    /// desktop.reset_cancellation(); // Allow new operations
    /// ```
    pub fn reset_cancellation(&self) {
        if let Ok(mut token) = self.cancellation_token.write() {
            if token.is_cancelled() {
                info!("🔄 Resetting cancellation state for new operations");
                *token = CancellationToken::new();
            }
        }
    }

    /// Execute an action on an element with UI diff capture.
    ///
    /// This method:
    /// 1. Finds the element by selector
    /// 2. Captures the UI tree before the action
    /// 3. Executes the action
    /// 4. Waits for UI to settle (configurable, default 1500ms)
    /// 5. Captures the UI tree after the action
    /// 6. Computes and returns the diff
    ///
    /// # Arguments
    /// * `selector` - Selector string to find the element
    /// * `action` - Closure that takes &UIElement and returns Result<T, AutomationError>
    /// * `options` - Optional UI diff capture options
    ///
    /// # Returns
    /// Tuple of (action_result, element, Option<UiDiffResult>)
    ///
    /// # Examples
    /// ```no_run
    /// use computeruse::{Desktop, UiDiffOptions};
    ///
    /// async fn example() -> Result<(), computeruse::AutomationError> {
    ///     let desktop = Desktop::new_default()?;
    ///     let options = UiDiffOptions {
    ///         settle_delay_ms: Some(1500),
    ///         ..Default::default()
    ///     };
    ///     let (result, element, diff) = desktop.execute_with_ui_diff(
    ///         "role:Button && name:Submit",
    ///         |el| el.click(),
    ///         Some(options),
    ///     ).await?;
    ///     Ok(())
    /// }
    /// ```
    pub async fn execute_with_ui_diff<T, F>(
        &self,
        selector: &str,
        action: F,
        options: Option<UiDiffOptions>,
    ) -> Result<(T, UIElement, Option<UiDiffResult>), AutomationError>
    where
        F: FnOnce(&UIElement) -> Result<T, AutomationError>,
    {
        use std::time::Duration;

        // Find the element (with default 30s timeout)
        let element = self
            .locator(selector)
            .first(Some(Duration::from_secs(30)))
            .await?;

        let opts = options.unwrap_or_default();

        // Get PID for tree capture
        let pid = element.process_id().unwrap_or(0);
        if pid == 0 {
            debug!("[ui_diff] Could not get PID from element, executing without diff capture");
            let result = action(&element)?;
            return Ok((result, element, None));
        }

        // Build tree config
        let detailed = opts.include_detailed_attributes.unwrap_or(true);
        let tree_config = platforms::TreeBuildConfig {
            property_mode: if detailed {
                platforms::PropertyLoadingMode::Complete
            } else {
                platforms::PropertyLoadingMode::Fast
            },
            timeout_per_operation_ms: Some(100),
            yield_every_n_elements: Some(25),
            batch_size: Some(25),
            max_depth: opts.max_depth,
            include_all_bounds: false,
            ui_settle_delay_ms: None,
            format_output: false,
            show_overlay: false,
            overlay_display_mode: None,
            from_selector: None,
        };

        // Capture BEFORE tree
        debug!("[ui_diff] Capturing UI tree before action (PID: {})", pid);
        let tree_before = match self.get_window_tree(pid, None, Some(tree_config.clone())) {
            Ok(tree) => tree,
            Err(e) => {
                debug!(
                    "[ui_diff] Failed to capture tree before action: {}. Executing without diff.",
                    e
                );
                let result = action(&element)?;
                return Ok((result, element, None));
            }
        };
        let before_str = format_ui_node_as_compact_yaml(&tree_before, 0).formatted;

        // Execute action
        let result = action(&element)?;

        // Wait for UI to settle
        let settle_ms = opts.settle_delay_ms.unwrap_or(1500);
        debug!("[ui_diff] Waiting {}ms for UI to settle", settle_ms);
        tokio::time::sleep(Duration::from_millis(settle_ms)).await;

        // Capture AFTER tree
        debug!("[ui_diff] Capturing UI tree after action (PID: {})", pid);
        let tree_after = match self.get_window_tree(pid, None, Some(tree_config)) {
            Ok(tree) => tree,
            Err(e) => {
                debug!(
                    "[ui_diff] Failed to capture tree after action: {}. Returning without diff.",
                    e
                );
                return Ok((result, element, None));
            }
        };
        let after_str = format_ui_node_as_compact_yaml(&tree_after, 0).formatted;

        // Compute diff
        let diff_result = match ui_tree_diff::simple_ui_tree_diff(&before_str, &after_str) {
            Ok(Some(diff)) => {
                info!(
                    "[ui_diff] UI changes detected: {} characters in diff",
                    diff.len()
                );
                UiDiffResult {
                    diff,
                    has_changes: true,
                }
            }
            Ok(None) => {
                debug!("[ui_diff] No UI changes detected");
                UiDiffResult {
                    diff: "No UI changes detected".to_string(),
                    has_changes: false,
                }
            }
            Err(e) => {
                debug!(
                    "[ui_diff] Failed to compute UI diff: {}. Returning without diff.",
                    e
                );
                return Ok((result, element, None));
            }
        };

        Ok((result, element, Some(diff_result)))
    }

    /// Execute an action on an already-found element with UI diff capture (async action variant).
    ///
    /// Use this when you have complex element-finding logic (fallback selectors, retries)
    /// and want to separate element finding from diff capture. This variant accepts async
    /// actions that take ownership of the element.
    ///
    /// # Arguments
    /// * `element` - The element to execute the action on (will be cloned for return)
    /// * `action` - Async closure that takes UIElement and returns Future<Result<T, AutomationError>>
    /// * `options` - Optional UI diff capture options
    ///
    /// # Returns
    /// Tuple of (action_result, element, Option<UiDiffResult>)
    pub async fn execute_on_element_with_ui_diff<T, F, Fut>(
        &self,
        element: UIElement,
        action: F,
        options: Option<UiDiffOptions>,
    ) -> Result<(T, UIElement, Option<UiDiffResult>), AutomationError>
    where
        F: FnOnce(UIElement) -> Fut,
        Fut: std::future::Future<Output = Result<T, AutomationError>>,
    {
        use std::time::Duration;

        let opts = options.unwrap_or_default();

        // Clone element so we can return it after action consumes one copy
        let element_for_return = element.clone();

        // Get PID for tree capture
        let pid = element.process_id().unwrap_or(0);
        if pid == 0 {
            debug!("[ui_diff] Could not get PID from element, executing without diff capture");
            let result = action(element).await?;
            return Ok((result, element_for_return, None));
        }

        // Build tree config
        let detailed = opts.include_detailed_attributes.unwrap_or(true);
        let tree_config = platforms::TreeBuildConfig {
            property_mode: if detailed {
                platforms::PropertyLoadingMode::Complete
            } else {
                platforms::PropertyLoadingMode::Fast
            },
            timeout_per_operation_ms: Some(100),
            yield_every_n_elements: Some(25),
            batch_size: Some(25),
            max_depth: opts.max_depth,
            include_all_bounds: false,
            ui_settle_delay_ms: None,
            format_output: false,
            show_overlay: false,
            overlay_display_mode: None,
            from_selector: None,
        };

        // Capture BEFORE tree
        debug!("[ui_diff] Capturing UI tree before action (PID: {})", pid);
        let tree_before = match self.get_window_tree(pid, None, Some(tree_config.clone())) {
            Ok(tree) => tree,
            Err(e) => {
                debug!(
                    "[ui_diff] Failed to capture tree before action: {}. Executing without diff.",
                    e
                );
                let result = action(element).await?;
                return Ok((result, element_for_return, None));
            }
        };
        let before_str = format_ui_node_as_compact_yaml(&tree_before, 0).formatted;

        // Execute action (async)
        let result = action(element).await?;

        // Wait for UI to settle
        let settle_ms = opts.settle_delay_ms.unwrap_or(1500);
        debug!("[ui_diff] Waiting {}ms for UI to settle", settle_ms);
        tokio::time::sleep(Duration::from_millis(settle_ms)).await;

        // Capture AFTER tree
        debug!("[ui_diff] Capturing UI tree after action (PID: {})", pid);
        let tree_after = match self.get_window_tree(pid, None, Some(tree_config)) {
            Ok(tree) => tree,
            Err(e) => {
                debug!(
                    "[ui_diff] Failed to capture tree after action: {}. Returning without diff.",
                    e
                );
                return Ok((result, element_for_return, None));
            }
        };
        let after_str = format_ui_node_as_compact_yaml(&tree_after, 0).formatted;

        // Compute diff
        let diff_result = match ui_tree_diff::simple_ui_tree_diff(&before_str, &after_str) {
            Ok(Some(diff)) => {
                info!(
                    "[ui_diff] UI changes detected: {} characters in diff",
                    diff.len()
                );
                UiDiffResult {
                    diff,
                    has_changes: true,
                }
            }
            Ok(None) => {
                debug!("[ui_diff] No UI changes detected");
                UiDiffResult {
                    diff: "No UI changes detected".to_string(),
                    has_changes: false,
                }
            }
            Err(e) => {
                debug!(
                    "[ui_diff] Failed to compute UI diff: {}. Returning without diff.",
                    e
                );
                return Ok((result, element_for_return, None));
            }
        };

        Ok((result, element_for_return, Some(diff_result)))
    }

    // ============== ELEMENT VERIFICATION ==============

    /// Verify that an element matching the selector exists within the same application as the scope element.
    ///
    /// This is used for post-action verification - checking that an expected element appeared after
    /// performing an action (e.g., a success dialog after clicking submit).
    ///
    /// # Arguments
    /// * `scope_element` - The element to get the application scope from (typically the element the action was performed on)
    /// * `selector` - The selector string to search for
    /// * `timeout_ms` - How long to wait for the element to appear
    ///
    /// # Returns
    /// The found element if verification passes, or an error if the element is not found within the timeout
    ///
    /// # Errors
    /// * `AutomationError::ElementNotFound` - If the application window cannot be determined from scope_element
    /// * `AutomationError::Timeout` - If the element is not found within the timeout
    #[instrument(skip(self, scope_element, selector))]
    pub async fn verify_element_exists(
        &self,
        scope_element: &UIElement,
        selector: &str,
        timeout_ms: u64,
    ) -> Result<UIElement, AutomationError> {
        use std::time::Duration;

        debug!(
            "Verifying element exists: '{}' within '{}'",
            selector,
            scope_element.name().unwrap_or_default()
        );

        // Create a locator scoped to the provided element (same as element.locator())
        let locator = self
            .locator(Selector::from(selector))
            .within(scope_element.clone());

        // Wait for the element with the specified timeout
        locator
            .wait(Some(Duration::from_millis(timeout_ms)))
            .await
            .map_err(|e| {
                AutomationError::Timeout(format!(
                    "Verification failed: element '{}' not found after {}ms. {}",
                    selector, timeout_ms, e
                ))
            })
    }

    /// Verify that an element matching the selector does NOT exist within the same application as the scope element.
    ///
    /// This is used for post-action verification - checking that an element disappeared after
    /// performing an action (e.g., a modal dialog closed after clicking OK).
    ///
    /// # Arguments
    /// * `scope_element` - The element to get the application scope from (typically the element the action was performed on)
    /// * `selector` - The selector string that should NOT be found
    /// * `timeout_ms` - How long to wait/check that the element doesn't appear
    ///
    /// # Returns
    /// Ok(()) if the element is NOT found (verification passes), or an error if the element IS found
    ///
    /// # Errors
    /// * `AutomationError::ElementNotFound` - If the application window cannot be determined from scope_element
    /// * `AutomationError::VerificationFailed` - If the element IS found (meaning verification failed)
    #[instrument(skip(self, scope_element, selector))]
    pub async fn verify_element_not_exists(
        &self,
        scope_element: &UIElement,
        selector: &str,
        timeout_ms: u64,
    ) -> Result<(), AutomationError> {
        use std::time::Duration;

        debug!(
            "Verifying element does NOT exist: '{}' within '{}'",
            selector,
            scope_element.name().unwrap_or_default()
        );

        // Create a locator scoped to the provided element (same as element.locator())
        let locator = self
            .locator(Selector::from(selector))
            .within(scope_element.clone());

        // Try to find the element - we WANT this to fail (timeout)
        match locator.wait(Some(Duration::from_millis(timeout_ms))).await {
            Ok(_found_element) => {
                // Element was found - this is a verification FAILURE
                Err(AutomationError::VerificationFailed(format!(
                    "Verification failed: element '{}' should not exist but was found",
                    selector
                )))
            }
            Err(_) => {
                // Element not found - this is what we wanted, verification PASSED
                debug!("Verification passed: element '{}' not present", selector);
                Ok(())
            }
        }
    }
}

impl Clone for Desktop {
    fn clone(&self) -> Self {
        Self {
            engine: self.engine.clone(),
            // Clone shares the same cancellation token so stop_execution affects all clones
            cancellation_token: self.cancellation_token.clone(),
            // Clone shares the same caches so index lookups work across clones
            uia_cache: self.uia_cache.clone(),
            ocr_cache: self.ocr_cache.clone(),
            omniparser_cache: self.omniparser_cache.clone(),
            vision_cache: self.vision_cache.clone(),
            dom_cache: self.dom_cache.clone(),
        }
    }
}

/// Stub ComputerUse agent loop on non-Windows.
///
/// The full agentic automation loop relies on Windows-only UI automation capabilities today.
/// We keep the method available so language bindings and downstream crates compile.
#[cfg(not(target_os = "windows"))]
impl Desktop {
    pub async fn gemini_computer_use(
        &self,
        _process: &str,
        _goal: &str,
        _max_steps: Option<u32>,
        _on_step: Option<ProgressCallback>,
    ) -> anyhow::Result<ComputerUseResult> {
        Err(anyhow::anyhow!(
            "gemini_computer_use is currently supported on Windows only"
        ))
    }
}
