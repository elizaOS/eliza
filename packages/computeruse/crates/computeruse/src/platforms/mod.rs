use crate::{AutomationError, Browser, OcrElement, Selector, UIElement, UINode};
use std::sync::Arc;
use std::time::Duration;

/// Configuration for tree building performance and completeness
#[derive(Debug, Clone)]
pub struct TreeBuildConfig {
    /// Property loading strategy
    pub property_mode: PropertyLoadingMode,
    /// Optional timeout per operation in milliseconds
    pub timeout_per_operation_ms: Option<u64>,
    /// Optional yield frequency for responsiveness
    pub yield_every_n_elements: Option<usize>,
    /// Optional batch size for processing elements
    pub batch_size: Option<usize>,
    /// Optional maximum depth to traverse (None = unlimited)
    pub max_depth: Option<usize>,
    /// Include bounds for all elements (not just focusable). Used for inspect overlay.
    pub include_all_bounds: bool,
    /// Delay in milliseconds to wait for UI to stabilize before capturing tree.
    /// Useful for letting animations/transitions complete. Default: 0 (no delay)
    pub ui_settle_delay_ms: Option<u64>,
    /// Generate formatted compact YAML output alongside the tree structure
    pub format_output: bool,
    /// Show visual overlay with indexed elements after building tree (Windows only)
    pub show_overlay: bool,
    /// Display mode for overlay labels when show_overlay is true
    pub overlay_display_mode: Option<OverlayDisplayMode>,
    /// Optional selector to start tree from instead of window root.
    /// When specified, the tree will be built from the element matching this selector
    /// rather than the full window. Useful for getting focused subtrees.
    pub from_selector: Option<String>,
}

/// Display mode for inspect overlay labels (cross-platform definition)
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum OverlayDisplayMode {
    /// Just rectangles, no labels
    Rectangles,
    /// [index] only
    #[default]
    Index,
    /// [role] only
    Role,
    /// [index:role]
    IndexRole,
    /// [name] only
    Name,
    /// [index:name]
    IndexName,
    /// [index:role:name]
    Full,
}

/// Defines how much element property data to load
#[derive(Debug, Clone)]
pub enum PropertyLoadingMode {
    /// Only load essential properties (role + name) - fastest
    Fast,
    /// Load all properties for complete element data - slower but comprehensive  
    Complete,
    /// Load specific properties based on element type - balanced approach
    Smart,
}

impl Default for TreeBuildConfig {
    fn default() -> Self {
        Self {
            property_mode: PropertyLoadingMode::Fast,
            timeout_per_operation_ms: Some(50),
            yield_every_n_elements: Some(50),
            batch_size: Some(50),
            max_depth: None, // No limit by default
            include_all_bounds: false,
            ui_settle_delay_ms: None, // No delay by default
            format_output: false,
            show_overlay: false,
            overlay_display_mode: None,
            from_selector: None,
        }
    }
}

/// The common trait that all platform-specific engines must implement
#[async_trait::async_trait]
pub trait AccessibilityEngine: Send + Sync {
    /// Get the root UI element
    fn get_root_element(&self) -> UIElement;

    fn get_element_by_id(&self, id: i32) -> Result<UIElement, AutomationError>;

    /// Get the currently focused element
    fn get_focused_element(&self) -> Result<UIElement, AutomationError>;

    /// Get all running applications
    fn get_applications(&self) -> Result<Vec<UIElement>, AutomationError>;

    /// Get application by name
    fn get_application_by_name(&self, name: &str) -> Result<UIElement, AutomationError>;

    /// Get application by process ID
    fn get_application_by_pid(
        &self,
        pid: i32,
        timeout: Option<Duration>,
    ) -> Result<UIElement, AutomationError>;

    /// Find elements using a selector
    fn find_element(
        &self,
        selector: &Selector,
        root: Option<&UIElement>,
        timeout: Option<Duration>,
    ) -> Result<UIElement, AutomationError>;

    /// Find all elements matching a selector
    /// Default implementation returns an UnsupportedOperation error,
    /// allowing platform-specific implementations to override as needed
    fn find_elements(
        &self,
        selector: &Selector,
        root: Option<&UIElement>,
        timeout: Option<Duration>,
        depth: Option<usize>,
    ) -> Result<Vec<UIElement>, AutomationError>;

    /// Open an application by name
    fn open_application(&self, app_name: &str) -> Result<UIElement, AutomationError>;

    /// Activate an application by name
    fn activate_application(&self, app_name: &str) -> Result<(), AutomationError>;

    /// Open a URL in a specified browser (or default if None)
    fn open_url(&self, url: &str, browser: Option<Browser>) -> Result<UIElement, AutomationError>;

    /// Open a file
    fn open_file(&self, file_path: &str) -> Result<(), AutomationError>;

    /// Run a command
    async fn run_command(
        &self,
        windows_command: Option<&str>,
        unix_command: Option<&str>,
    ) -> Result<crate::CommandOutput, AutomationError>;

    // ============== NEW MONITOR ABSTRACTIONS ==============

    /// List all available monitors/displays
    async fn list_monitors(&self) -> Result<Vec<crate::Monitor>, AutomationError>;

    /// Get the primary monitor
    async fn get_primary_monitor(&self) -> Result<crate::Monitor, AutomationError>;

    /// Get the monitor containing the currently focused window
    async fn get_active_monitor(&self) -> Result<crate::Monitor, AutomationError>;

    /// Get a monitor by its ID
    async fn get_monitor_by_id(&self, id: &str) -> Result<crate::Monitor, AutomationError>;

    /// Get a monitor by its name
    async fn get_monitor_by_name(&self, name: &str) -> Result<crate::Monitor, AutomationError>;

    /// Capture a screenshot of a monitor by its ID
    async fn capture_monitor_by_id(
        &self,
        id: &str,
    ) -> Result<crate::ScreenshotResult, AutomationError>;

    // ============== DEPRECATED METHODS ==============

    /// Capture screenshot (deprecated - use monitor-specific methods)
    #[deprecated(
        since = "0.4.9",
        note = "Use get_primary_monitor() and capture_monitor_by_id() instead"
    )]
    async fn capture_screen(&self) -> Result<crate::ScreenshotResult, AutomationError> {
        let primary = self.get_primary_monitor().await?;
        self.capture_monitor_by_id(&primary.id).await
    }

    /// Capture screenshot by monitor name (deprecated)
    #[deprecated(
        since = "0.4.9",
        note = "Use get_monitor_by_name() and capture_monitor_by_id() instead"
    )]
    async fn capture_monitor_by_name(
        &self,
        name: &str,
    ) -> Result<crate::ScreenshotResult, AutomationError> {
        let monitor = self.get_monitor_by_name(name).await?;
        self.capture_monitor_by_id(&monitor.id).await
    }

    /// Get the name of the currently active monitor (deprecated)
    #[deprecated(since = "0.4.9", note = "Use get_active_monitor() instead")]
    async fn get_active_monitor_name(&self) -> Result<String, AutomationError> {
        let monitor = self.get_active_monitor().await?;
        Ok(monitor.name)
    }

    // ============== END DEPRECATED METHODS ==============

    /// OCR on image path
    async fn ocr_image_path(&self, image_path: &str) -> Result<String, AutomationError>;

    /// OCR on screenshot
    async fn ocr_screenshot(
        &self,
        screenshot: &crate::ScreenshotResult,
    ) -> Result<String, AutomationError>;

    /// OCR on screenshot with bounding boxes - returns structured OCR elements with absolute screen coordinates
    /// Default implementation returns UnsupportedOperation - override in platform-specific engines
    ///
    /// # Arguments
    /// * `screenshot` - The screenshot to perform OCR on
    /// * `window_x` - X offset of the window on screen in logical coordinates
    /// * `window_y` - Y offset of the window on screen in logical coordinates
    /// * `dpi_scale_x` - DPI scale factor for X (screenshot_width / window_logical_width)
    /// * `dpi_scale_y` - DPI scale factor for Y (screenshot_height / window_logical_height)
    fn ocr_screenshot_with_bounds(
        &self,
        _screenshot: &crate::ScreenshotResult,
        _window_x: f64,
        _window_y: f64,
        _dpi_scale_x: f64,
        _dpi_scale_y: f64,
    ) -> Result<OcrElement, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "OCR with bounding boxes not supported on this platform".to_string(),
        ))
    }

    /// Click at absolute screen coordinates
    /// Default implementation returns UnsupportedOperation - override in platform-specific engines
    /// If `restore_cursor` is true, the cursor position will be restored after the click
    fn click_at_coordinates(
        &self,
        _x: f64,
        _y: f64,
        _restore_cursor: bool,
    ) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "Click at coordinates not supported on this platform".to_string(),
        ))
    }

    /// Click at absolute screen coordinates with specified click type (left, double, right)
    /// Default implementation returns UnsupportedOperation - override in platform-specific engines
    /// If `restore_cursor` is true, the cursor position will be restored after the click
    fn click_at_coordinates_with_type(
        &self,
        _x: f64,
        _y: f64,
        _click_type: crate::ClickType,
        _restore_cursor: bool,
    ) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "Click at coordinates with type not supported on this platform".to_string(),
        ))
    }

    /// Activate browser window
    fn activate_browser_window_by_title(&self, title: &str) -> Result<(), AutomationError>;

    /// Get current browser window
    async fn get_current_browser_window(&self) -> Result<UIElement, AutomationError>;

    /// Get current window
    async fn get_current_window(&self) -> Result<UIElement, AutomationError>;

    /// Get current application
    async fn get_current_application(&self) -> Result<UIElement, AutomationError>;

    fn press_key(&self, key: &str) -> Result<(), AutomationError>;
    /// Sets the zoom level to a specific percentage (e.g., 100 for 100%, 150 for 150%)
    fn set_zoom(&self, percentage: u32) -> Result<(), AutomationError>;

    /// Get the complete UI tree for a window identified by process ID and optional title
    /// This is the single tree building function - replaces get_window_tree_by_title and get_window_tree_by_pid_and_title
    ///
    /// # Arguments
    /// * `pid` - Process ID of the target application
    /// * `title` - Optional window title filter (if None, uses any window from the PID)
    /// * `config` - Configuration for tree building performance and completeness
    ///
    /// # Returns
    /// Complete UI tree starting from the identified window
    fn get_window_tree(
        &self,
        pid: u32,
        title: Option<&str>,
        config: TreeBuildConfig,
    ) -> Result<UINode, AutomationError>;

    /// Build UI tree directly from a UIElement (no PID-based window search needed)
    ///
    /// This is more efficient when you already have a reference to the target element,
    /// as it avoids enumerating all desktop windows which can fail during transient
    /// UI Automation states.
    ///
    /// # Arguments
    /// * `element` - The UIElement to build tree from (should be a window/pane element)
    /// * `config` - Configuration for tree building performance and completeness
    ///
    /// # Returns
    /// Complete UI tree starting from the provided element
    fn get_tree_from_element(
        &self,
        element: &UIElement,
        config: TreeBuildConfig,
    ) -> Result<UINode, AutomationError>;

    /// Enable downcasting to concrete engine types
    fn as_any(&self) -> &dyn std::any::Any;
}

#[cfg(target_os = "windows")]
pub mod windows;

// macOS AX tree traversal helpers (used by macos engine).
#[cfg(target_os = "macos")]
pub mod tree_search;

/// Windows-specific API surface stubs for non-Windows builds.
///
/// Several downstream crates (Node/Python bindings, MCP agent) reference
/// `computeruse::platforms::windows::*` symbols for convenience. To keep the
/// workspace compiling on macOS/Linux while those features are still Windows-only,
/// we provide no-op/UnsupportedOperation stubs here.
#[cfg(not(target_os = "windows"))]
pub mod windows {
    use crate::{AutomationError, ClickType, FontStyle, HighlightHandle, TextPosition};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    /// Stub type used by focus restoration helpers.
    #[derive(Debug, Clone)]
    pub struct FocusState;

    /// Best-effort focus saving is Windows-only today.
    pub fn save_focus_state() -> Option<FocusState> {
        None
    }

    /// Best-effort focus restoration is Windows-only today.
    pub fn restore_focus_state(_state: FocusState) {}

    /// Mouse click injection is Windows-only in the current engine.
    pub fn send_mouse_click(
        _x: f64,
        _y: f64,
        _click_type: ClickType,
        _restore_cursor: bool,
    ) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "send_mouse_click is only supported on Windows".to_string(),
        ))
    }

    /// Stub UI element type used by some Windows-specific MCP utilities.
    #[derive(Debug, Clone)]
    pub struct WindowsUIElement;

    impl WindowsUIElement {
        pub fn get_native_window_handle(&self) -> Result<isize, AutomationError> {
            Err(AutomationError::UnsupportedOperation(
                "get_native_window_handle is only supported on Windows".to_string(),
            ))
        }

        pub fn maximize_window_keyboard(&self) -> Result<(), AutomationError> {
            Err(AutomationError::UnsupportedOperation(
                "maximize_window_keyboard is only supported on Windows".to_string(),
            ))
        }
    }

    // ===== Highlighting stubs =====

    #[allow(clippy::too_many_arguments)]
    pub fn highlight_bounds(
        _x: i32,
        _y: i32,
        _width: i32,
        _height: i32,
        _color: Option<u32>,
        _duration: Option<Duration>,
        _text: Option<&str>,
        _text_position: Option<TextPosition>,
        _font_style: Option<FontStyle>,
    ) -> Result<HighlightHandle, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "highlight_bounds is only supported on Windows".to_string(),
        ))
    }

    pub fn stop_all_highlights() -> usize {
        0
    }

    pub fn set_recording_mode(_enabled: bool) {}

    // ===== Inspect overlay stubs =====

    #[derive(Debug, Clone)]
    pub struct InspectElement {
        pub index: u32,
        pub role: String,
        pub name: Option<String>,
        pub bounds: (f64, f64, f64, f64),
    }

    #[derive(Debug)]
    pub struct InspectOverlayHandle;

    pub fn show_inspect_overlay(
        _elements: Vec<InspectElement>,
        _window_bounds: (i32, i32, i32, i32),
        _display_mode: super::OverlayDisplayMode,
    ) -> Result<InspectOverlayHandle, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "inspect overlay is only supported on Windows".to_string(),
        ))
    }

    pub fn hide_inspect_overlay() {}

    // ===== Action overlay stubs =====

    static ACTION_OVERLAY_ENABLED: AtomicBool = AtomicBool::new(false);

    pub fn set_action_overlay_enabled(enabled: bool) {
        ACTION_OVERLAY_ENABLED.store(enabled, Ordering::SeqCst);
    }

    pub fn is_action_overlay_enabled() -> bool {
        ACTION_OVERLAY_ENABLED.load(Ordering::SeqCst)
    }

    pub fn show_action_overlay(_message: impl Into<String>, _sub_message: Option<String>) {}

    pub fn update_action_overlay_message(_message: impl Into<String>, _sub_message: Option<String>) {}

    pub fn hide_action_overlay() {}

    #[derive(Debug)]
    pub struct ActionOverlayGuard;

    impl Drop for ActionOverlayGuard {
        fn drop(&mut self) {
            // no-op
        }
    }

    /// Window manager stubs (Windows-only feature today).
    pub mod window_manager {
        #[derive(Debug, Clone, Default)]
        pub struct WindowCache;

        #[derive(Debug, Clone)]
        pub struct WindowInfo {
            pub hwnd: isize,
            pub process_name: String,
            pub process_id: u32,
            pub z_order: u32,
            pub is_minimized: bool,
            pub is_maximized: bool,
            pub is_always_on_top: bool,
            pub title: String,
        }

        #[derive(Debug, Clone, Copy)]
        pub struct WindowPlacement;

        #[derive(Debug, Default)]
        pub struct WindowManager;

        impl WindowManager {
            pub fn new() -> Self {
                Self
            }

            pub async fn update_window_cache(&self) -> Result<(), String> {
                Err("WindowManager is only supported on Windows".to_string())
            }

            pub async fn get_always_on_top_windows(&self) -> Vec<WindowInfo> {
                Vec::new()
            }

            pub async fn get_topmost_window_for_process(&self, _process: &str) -> Option<WindowInfo> {
                None
            }

            pub async fn get_topmost_window_for_pid(&self, _pid: u32) -> Option<WindowInfo> {
                None
            }

            pub async fn minimize_always_on_top_windows(&self, _target_hwnd: isize) -> Result<u32, String> {
                Ok(0)
            }

            pub async fn maximize_if_needed(&self, _hwnd: isize) -> Result<bool, String> {
                Ok(false)
            }

            pub async fn bring_window_to_front(&self, _hwnd: isize) -> Result<bool, String> {
                Ok(false)
            }

            pub async fn minimize_if_needed(&self, _hwnd: isize) -> Result<bool, String> {
                Ok(false)
            }

            pub async fn restore_all_windows(&self) -> Result<u32, String> {
                Ok(0)
            }

            pub async fn capture_initial_state(&self) -> Result<(), String> {
                Ok(())
            }

            pub async fn clear_captured_state(&self) {}

            pub async fn is_uwp_app(&self, _pid: u32) -> bool {
                false
            }

            pub async fn set_target_window(&self, _hwnd: isize) {}
        }
    }
}
#[cfg(all(target_os = "windows", test))]
pub mod windows_tests;

#[cfg(target_os = "windows")]
#[cfg(test)]
pub mod windows_benchmarks;

#[cfg(target_os = "macos")]
pub mod macos;

#[cfg(target_os = "linux")]
pub mod linux;

/// Returns whether a process ID looks like a supported browser process.
///
/// On Windows we defer to the platform implementation. On other platforms we
/// fall back to a simple `sysinfo` process-name check.
pub fn is_browser_process(pid: u32) -> bool {
    #[cfg(target_os = "windows")]
    {
        return windows::is_browser_process(pid);
    }

    #[cfg(not(target_os = "windows"))]
    {
        use sysinfo::{ProcessesToUpdate, System};
        let mut system = System::new();
        system.refresh_processes(ProcessesToUpdate::All, true);
        let name = system
            .process(sysinfo::Pid::from_u32(pid))
            .map(|p| p.name().to_string_lossy().to_lowercase());

        match name {
            Some(n) => {
                // Keep in sync with Windows known browser list (best-effort).
                matches!(
                    n.as_str(),
                    "chrome.exe"
                        | "chrome"
                        | "msedge.exe"
                        | "msedge"
                        | "firefox.exe"
                        | "firefox"
                        | "brave.exe"
                        | "brave"
                        | "opera.exe"
                        | "opera"
                        | "vivaldi.exe"
                        | "vivaldi"
                )
            }
            None => false,
        }
    }
}

/// Create the appropriate engine for the current platform
pub fn create_engine(
    use_background_apps: bool,
    activate_app: bool,
) -> Result<Arc<dyn AccessibilityEngine>, AutomationError> {
    #[cfg(target_os = "windows")]
    {
        Ok(Arc::new(windows::WindowsEngine::new(
            use_background_apps,
            activate_app,
        )?))
    }
    #[cfg(target_os = "macos")]
    {
        Ok(Arc::new(macos::MacOSEngine::new(
            use_background_apps,
            activate_app,
        )?))
    }
    #[cfg(target_os = "linux")]
    {
        Ok(Arc::new(linux::LinuxEngine::new(
            use_background_apps,
            activate_app,
        )?))
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Err(AutomationError::UnsupportedPlatform(
            "Unsupported OS (only Windows/macOS/Linux are supported)".to_string(),
        ))
    }
}
