use crate::cancellation::RequestManager;
use crate::mcp_types::{FontStyle, TextPosition, TreeOutputFormat};
use crate::tool_logging::{LogCapture, LogCaptureLayer};
use anyhow::Result;
use rmcp::service::{Peer, RoleServer};
use rmcp::{schemars, schemars::JsonSchema};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use computeruse::WindowManager;
use computeruse::{AutomationError, Desktop, UIElement};
use tokio::sync::Mutex as TokioMutex;
use tracing::{warn, Instrument, Level};
use tracing_subscriber::{util::SubscriberInitExt, EnvFilter, Layer};

/// Per-client mode state for ask/act mode enforcement
/// Only applies to "claude-code" client; "mediar-app" (UI) is never blocked
#[derive(Debug, Clone, Default)]
pub struct ClientModeState {
    /// Current mode: "ask" (read-only) or "act" (full access)
    pub mode: String,
    /// Tools blocked in this mode
    pub blocked_tools: std::collections::HashSet<String>,
}

/// Custom schema generator for serde_json::Value fields.
/// Generates a proper `{"type": "object"}` schema instead of the permissive "any" schema.
fn json_object_schema(_gen: &mut schemars::generate::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({
        "type": "object",
        "additionalProperties": true
    })
}

// ===== Composition Base Types for Reducing Duplication =====

/// Common fields for operations that include monitor screenshots
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, Default)]
pub struct MonitorScreenshotOptions {
    #[schemars(
        description = "Whether to include screenshots of all monitors in the response. Defaults to false."
    )]
    pub include_monitor_screenshots: Option<bool>,
}

/// Common fields for operations that include window screenshots
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, Default)]
pub struct WindowScreenshotOptions {
    #[schemars(
        description = "Whether to include a screenshot of the target window in the response. For action tools, captured after the action completes. Defaults to true. Set to false to disable."
    )]
    pub include_window_screenshot: Option<bool>,
}

/// Common fields for window management control
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, Default)]
pub struct WindowManagementOptions {
    #[schemars(
        description = "Whether to enable window management (minimize always-on-top windows, optionally maximize target, and restore). Defaults to true."
    )]
    pub enable_window_management: Option<bool>,

    #[schemars(
        description = "Whether to maximize the target window. Only used if enable_window_management is true. Defaults to false."
    )]
    pub maximize_target: Option<bool>,

    #[schemars(
        description = "Whether to minimize always-on-top windows that may cover the target. Only used if enable_window_management is true. Defaults to true."
    )]
    pub minimize_always_on_top: Option<bool>,

    #[schemars(
        description = "Whether to bring the target window to front (BringWindowToTop + SetForegroundWindow). Only used if enable_window_management is true. Defaults to true."
    )]
    pub bring_to_front: Option<bool>,

    #[schemars(
        description = "Whether to restore keyboard focus and caret position after tool execution. When true, saves the currently focused element and caret position before window management, then restores them after the tool completes. Defaults to true."
    )]
    pub restore_focus: Option<bool>,
}

/// Tree options for action tools that modify UI - captures diff before/after
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, Default)]
pub struct DiffTreeOptions {
    #[schemars(
        description = "REQUIRED: Capture UI tree before and after action execution, then compute and return the diff. Returns ui_diff and has_ui_changes fields."
    )]
    pub ui_diff_before_after: bool,

    #[schemars(description = "Maximum depth to traverse when building tree")]
    pub tree_max_depth: Option<usize>,

    #[schemars(description = "Selector to start tree from instead of window root")]
    pub tree_from_selector: Option<String>,

    #[schemars(
        description = "Whether to include detailed element attributes (enabled, focused, selected, etc.). Defaults to true for comprehensive LLM context."
    )]
    pub include_detailed_attributes: Option<bool>,

    #[schemars(
        description = "Output format for UI tree. Options: 'verbose_json' (full JSON with all fields), 'compact_yaml' (minimal YAML: [ROLE] name #id). Defaults to 'compact_yaml'."
    )]
    pub tree_output_format: Option<TreeOutputFormat>,
}

/// Tree options for navigation/read-only tools - captures tree after action
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, Default)]
pub struct SimpleTreeOptions {
    #[schemars(
        description = "REQUIRED: Whether to include the UI tree in the response (captured after action execution)."
    )]
    pub include_tree_after_action: bool,

    #[schemars(
        description = "Maximum depth to traverse when building tree (only used if include_tree_after_action is true)"
    )]
    pub tree_max_depth: Option<usize>,

    #[schemars(
        description = "Selector to start tree from instead of window root (only used if include_tree_after_action is true)"
    )]
    pub tree_from_selector: Option<String>,

    #[schemars(
        description = "Whether to include detailed element attributes (enabled, focused, selected, etc.) when include_tree_after_action is true. Defaults to true for comprehensive LLM context."
    )]
    pub include_detailed_attributes: Option<bool>,

    #[schemars(
        description = "Output format for UI tree. Options: 'verbose_json' (full JSON with all fields), 'compact_yaml' (minimal YAML: [ROLE] name #id). Defaults to 'compact_yaml'."
    )]
    pub tree_output_format: Option<TreeOutputFormat>,
}

/// Common fields for element selection with alternatives and fallbacks
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, Default)]
pub struct SelectorOptions {
    #[schemars(
        description = "Process name to scope the search (e.g., 'chrome', 'notepad', 'explorer'). Use 'explorer' for desktop icons/taskbar. Required to prevent slow desktop-wide searches."
    )]
    pub process: String,

    #[schemars(
        description = "Optional window selector for additional filtering within the process (e.g., 'role:Window|name:Untitled'). When specified, searches only within matching windows of the process."
    )]
    pub window_selector: Option<String>,

    #[schemars(
        description = "A string selector to locate the element within the scoped process/window. Can be chained with ` >> `. If omitted, targets the window root element."
    )]
    #[serde(default)]
    pub selector: String,

    #[schemars(
        description = "Optional alternative selectors to try in parallel. The first selector that finds an element will be used."
    )]
    pub alternative_selectors: Option<String>,

    #[schemars(
        description = "Optional fallback selectors to try sequentially if the primary selector fails. These selectors are **only** attempted after the primary selector (and any parallel alternatives) time out. List can be comma-separated."
    )]
    pub fallback_selectors: Option<String>,
}

impl SelectorOptions {
    /// Build the full selector by combining process (and optionally window_selector) with the main selector
    pub fn build_full_selector(&self) -> String {
        if self.selector.is_empty() {
            // No selector = target window root
            if let Some(window_sel) = &self.window_selector {
                format!("process:{} >> {}", self.process, window_sel)
            } else {
                format!("process:{}", self.process)
            }
        } else if let Some(window_sel) = &self.window_selector {
            // Chain: process -> window -> element
            format!(
                "process:{} >> {} >> {}",
                self.process, window_sel, self.selector
            )
        } else {
            // Chain: process -> element
            format!("process:{} >> {}", self.process, self.selector)
        }
    }

    /// Build alternative selectors with scoping applied
    pub fn build_alternative_selectors(&self) -> Option<String> {
        self.alternative_selectors.as_ref().map(|alt| {
            if let Some(window_sel) = &self.window_selector {
                format!("process:{} >> {} >> {}", self.process, window_sel, alt)
            } else {
                format!("process:{} >> {}", self.process, alt)
            }
        })
    }

    /// Build fallback selectors with scoping applied
    pub fn build_fallback_selectors(&self) -> Option<String> {
        self.fallback_selectors.as_ref().map(|fb| {
            if let Some(window_sel) = &self.window_selector {
                format!("process:{} >> {} >> {}", self.process, window_sel, fb)
            } else {
                format!("process:{} >> {}", self.process, fb)
            }
        })
    }
}

/// Common fields for action timing and retries
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ActionOptions {
    #[schemars(description = "Optional timeout in milliseconds for the action")]
    pub timeout_ms: Option<u64>,

    #[schemars(description = "Number of times to retry this step on failure.")]
    pub retries: Option<u32>,

    #[schemars(
        description = "Selector that should exist after action. EXACT match from UI tree only - never guess. Use \"\" to skip."
    )]
    pub verify_element_exists: String,

    #[schemars(
        description = "Selector that should NOT exist after action. EXACT match from UI tree only - never guess. Use \"\" to skip."
    )]
    pub verify_element_not_exists: String,

    #[schemars(
        description = "Timeout in milliseconds for post-action verification. The system will poll until verification passes or timeout is reached. Defaults to 2000ms if not specified."
    )]
    pub verify_timeout_ms: Option<u64>,
}

/// Common fields for visual highlighting before actions
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct HighlightOptions {
    #[schemars(
        description = "REQUIRED: Whether to highlight the element before action. When true, shows a green border with element role as text."
    )]
    pub highlight_before_action: bool,
}

// Validation helpers for better type safety
#[derive(Serialize, Deserialize, JsonSchema)]
pub struct EmptyArgs {}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct StopHighlightingArgs {
    #[schemars(
        description = "Optional specific highlight ID to stop. If omitted, stops all active highlights."
    )]
    pub highlight_id: Option<String>,

    #[serde(flatten)]
    pub monitor: MonitorScreenshotOptions,

    #[serde(flatten)]
    pub window_mgmt: WindowManagementOptions,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct DelayArgs {
    #[schemars(description = "Number of milliseconds to delay")]
    pub delay_ms: u64,

    #[serde(flatten)]
    pub monitor: MonitorScreenshotOptions,

    #[serde(flatten)]
    pub window_mgmt: WindowManagementOptions,
}

// Tool execution context for window management and execution logging
#[derive(Clone, Debug)]
pub struct ToolExecutionContext {
    pub in_sequence: bool,
    pub sequence_id: Option<String>,
    pub total_steps: usize,
    pub current_step: usize,
    pub is_last_step: bool,
    pub previous_process: Option<String>, // Track previous process for detecting switches
    pub workflow_id: Option<String>,      // For execution logging
    pub step_id: Option<String>,          // For execution logging
}

impl ToolExecutionContext {
    pub fn single_tool() -> Self {
        Self {
            in_sequence: false,
            sequence_id: None,
            total_steps: 1,
            current_step: 1,
            is_last_step: true,
            previous_process: None,
            workflow_id: None,
            step_id: None,
        }
    }

    pub fn sequence_step(
        id: String,
        current: usize,
        total: usize,
        previous_process: Option<String>,
    ) -> Self {
        Self {
            in_sequence: true,
            sequence_id: Some(id),
            total_steps: total,
            current_step: current,
            is_last_step: current == total,
            previous_process,
            workflow_id: None,
            step_id: None,
        }
    }

    /// Set workflow context for execution logging
    pub fn with_workflow_context(
        mut self,
        workflow_id: Option<String>,
        step_id: Option<String>,
    ) -> Self {
        self.workflow_id = workflow_id;
        self.step_id = step_id;
        self
    }
}

fn default_desktop() -> Arc<Desktop> {
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    let desktop = Desktop::new(false, false).expect("Failed to create default desktop");
    #[cfg(target_os = "macos")]
    let desktop = Desktop::new(true, true).expect("Failed to create default desktop");
    Arc::new(desktop)
}

fn default_scroll_amount() -> f64 {
    3.0
}

fn default_true() -> bool {
    true
}

// Removed IncludeTreeOption and TreeOptions - now using separate fields

#[allow(clippy::type_complexity)]
#[derive(Clone, Serialize, Deserialize)]
pub struct DesktopWrapper {
    #[serde(skip, default = "default_desktop")]
    pub desktop: Arc<Desktop>,
    #[serde(skip)]
    pub tool_router: rmcp::handler::server::tool::ToolRouter<Self>,
    #[serde(skip)]
    pub request_manager: RequestManager,
    #[serde(skip)]
    pub active_highlights: Arc<TokioMutex<Vec<computeruse::HighlightHandle>>>,
    #[serde(skip)]
    pub log_capture: Option<LogCapture>,
    #[serde(skip)]
    pub captured_stderr_logs: Arc<Mutex<Vec<crate::execution_logger::CapturedLogEntry>>>,
    #[serde(skip)]
    pub current_workflow_dir: Arc<TokioMutex<Option<std::path::PathBuf>>>,
    #[serde(skip)]
    pub current_scripts_base_path: Arc<TokioMutex<Option<String>>>,
    #[serde(skip)]
    pub window_manager: Arc<WindowManager>,
    /// Tracks whether we're currently executing a workflow sequence
    /// Used to determine if individual tools should handle window management
    #[serde(skip)]
    pub in_sequence: Arc<Mutex<bool>>,
    /// Stores OCR index-to-bounds mapping from the last get_window_tree with include_ocr
    /// Key is 1-based index, value is (text, (x, y, width, height))
    #[serde(skip)]
    pub ocr_bounds: Arc<Mutex<std::collections::HashMap<u32, (String, (f64, f64, f64, f64))>>>,
    /// Stores Omniparser items from the last get_window_tree with include_omniparser
    /// Key is 1-based index, value is item details
    #[serde(skip)]
    pub omniparser_items:
        Arc<Mutex<std::collections::HashMap<u32, crate::omniparser::OmniparserItem>>>,
    /// Stores Vision items from the last get_window_tree with include_gemini_vision
    /// Key is 1-based index, value is item details
    #[serde(skip)]
    pub vision_items: Arc<Mutex<std::collections::HashMap<u32, crate::vision::VisionElement>>>,
    /// Stores UIA tree index-to-bounds mapping from the last get_window_tree
    /// Key is 1-based index, value is (role, name, bounds, selector)
    #[serde(skip)]
    pub uia_bounds: Arc<
        Mutex<
            std::collections::HashMap<u32, (String, String, (f64, f64, f64, f64), Option<String>)>,
        >,
    >,
    /// Stores browser DOM index-to-bounds mapping from the last get_window_tree
    /// Key is 1-based index, value is (tag, identifier, (x, y, width, height)) in screen coordinates
    #[serde(skip)]
    pub dom_bounds:
        Arc<Mutex<std::collections::HashMap<u32, (String, String, (f64, f64, f64, f64))>>>,
    /// Stores clustered index-to-bounds mapping from the last get_window_tree with clustered_yaml format
    /// Key is prefixed index (e.g., "u1", "d2", "o3", "p4", "g5"), value is (source, original_index, bounds)
    #[serde(skip)]
    pub clustered_bounds: Arc<
        Mutex<
            std::collections::HashMap<
                String,
                (
                    crate::tree_formatter::ElementSource,
                    u32,
                    (f64, f64, f64, f64),
                ),
            >,
        >,
    >,
    /// Stores the active inspect overlay handle for cleanup
    #[cfg(target_os = "windows")]
    #[serde(skip)]
    pub inspect_overlay_handle: Arc<Mutex<Option<computeruse::InspectOverlayHandle>>>,
    /// Per-client mode states: HashMap<client_name, ClientModeState>
    /// Only "claude-code" client has mode enforced; "mediar-app" (UI) is never blocked
    #[serde(skip)]
    pub client_modes: Arc<TokioMutex<HashMap<String, ClientModeState>>>,
    /// Stores a peer that supports elicitation capability
    /// This is captured when a client with elicitation capability connects
    /// Used to show UI prompts to the user even when tool calls come from a different peer
    #[serde(skip)]
    pub elicitation_peer: Arc<TokioMutex<Option<Peer<RoleServer>>>>,
    /// All connected peers for broadcasting progress notifications
    /// When emit.progress() is called, notifications are sent to ALL connected clients
    #[serde(skip)]
    pub broadcast_peers: Arc<TokioMutex<Vec<Peer<RoleServer>>>>,
}

impl Default for DesktopWrapper {
    fn default() -> Self {
        // Can't use Default::default() because we need the tool_router from the macro
        // So we'll construct it properly in server.rs
        panic!("DesktopWrapper::default() should not be used directly. Use DesktopWrapper::new() instead.");
    }
}

// Test helper methods for DesktopWrapper
#[cfg(test)]
impl DesktopWrapper {
    /// Test helper method that wraps execute_sequence without requiring Peer and RequestContext
    /// This is a simplified version for testing that doesn't support progress notifications
    pub async fn execute_sequence_for_test(
        &self,
        _args: ExecuteSequenceArgs,
    ) -> Result<rmcp::model::CallToolResult, rmcp::ErrorData> {
        // Since we can't easily create Peer and RequestContext for testing,
        // we'll need to use a different approach. The tests should be updated
        // to test the logic directly without going through the MCP protocol layer.

        // For now, return an error indicating this method needs implementation
        Err(rmcp::ErrorData::internal_error(
            "execute_sequence_for_test is not implemented. Tests need to be refactored.",
            None,
        ))
    }
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct GetWindowTreeArgs {
    #[schemars(
        description = "Process name of the target application (e.g., 'chrome', 'msedge', 'notepad'). Returns tree for the first matching process found."
    )]
    pub process: String,
    #[schemars(description = "Optional window title filter")]
    pub title: Option<String>,
    #[serde(flatten)]
    pub tree: SimpleTreeOptions,
    #[serde(flatten)]
    pub monitor: MonitorScreenshotOptions,
    #[serde(flatten)]
    pub window_screenshot: WindowScreenshotOptions,

    #[serde(flatten)]
    pub window_mgmt: WindowManagementOptions,

    #[schemars(
        description = "Whether to perform OCR on the window and include recognized text with bounding boxes. OCR results are returned as a separate 'ocr_tree' field with word-level positioning for click targeting. Defaults to false."
    )]
    #[serde(default)]
    pub include_ocr: bool,

    #[schemars(
        description = "Whether to use Omniparser V2 to detect icons and fields. Returns an 'omniparser_tree' field with indexed items for click targeting. Defaults to false."
    )]
    #[serde(default)]
    pub include_omniparser: bool,

    #[schemars(
        description = "Use Gemini vision model for UI element detection. Returns a 'vision_tree' field with indexed elements. More accurate than omniparser for modern UIs."
    )]
    #[serde(default)]
    pub include_gemini_vision: bool,

    #[schemars(
        description = "Whether to capture browser DOM elements. Returns a 'browser_dom' field with indexed DOM elements for click targeting. Defaults to false."
    )]
    #[serde(default)]
    pub include_browser_dom: bool,

    #[schemars(
        description = "Maximum number of browser DOM elements to capture. Only applies to browser windows. Defaults to 200."
    )]
    pub browser_dom_max_elements: Option<u32>,

    #[schemars(
        description = "Show visual overlay with indexed elements. Valid values: 'ui_tree', 'dom', 'ocr', 'omniparser', 'vision'. Shows element bounds with [index:role] labels. Only one type can be shown at a time."
    )]
    pub show_overlay: Option<String>,

    #[schemars(
        description = "Display mode for overlay labels when show_overlay is set. Valid values: 'rectangles' (no labels), 'index', 'role', 'index_role', 'name', 'index_name', 'full' (index:role:name). Defaults to 'index'."
    )]
    pub overlay_display_mode: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct GetApplicationsArgs {
    // No parameters needed - this tool simply lists windows/applications
    // Use get_window_tree if you need UI tree details
    // Use capture_screen if you need screenshots
}

/// Args for read-only locator tools (is_toggled, is_selected, get_range_value, list_options)
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct LocatorArgs {
    #[serde(flatten)]
    pub selector: SelectorOptions,

    #[serde(flatten)]
    pub action: ActionOptions,

    #[serde(flatten)]
    pub tree: SimpleTreeOptions,

    #[serde(flatten)]
    pub monitor: MonitorScreenshotOptions,
    #[serde(flatten)]
    pub window_screenshot: WindowScreenshotOptions,

    #[serde(flatten)]
    pub window_mgmt: WindowManagementOptions,
}

/// Args for invoke_element action tool (modifies UI, needs diff)
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct InvokeElementArgs {
    #[serde(flatten)]
    pub selector: SelectorOptions,

    #[serde(flatten)]
    pub action: ActionOptions,

    #[serde(flatten)]
    pub highlight: HighlightOptions,

    #[serde(flatten)]
    pub tree: DiffTreeOptions,

    #[serde(flatten)]
    pub monitor: MonitorScreenshotOptions,
    #[serde(flatten)]
    pub window_screenshot: WindowScreenshotOptions,

    #[serde(flatten)]
    pub window_mgmt: WindowManagementOptions,
}

#[derive(Debug, Serialize, JsonSchema, Clone)]
pub struct ClickPosition {
    #[schemars(description = "X position as percentage (0-100) within the element")]
    pub x_percentage: u32,
    #[schemars(description = "Y position as percentage (0-100) within the element")]
    pub y_percentage: u32,
}

// Custom deserializer that handles both direct objects and stringified JSON
impl<'de> Deserialize<'de> for ClickPosition {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        use serde::de::{self, Visitor};
        use std::fmt;

        struct ClickPositionVisitor;

        impl<'de> Visitor<'de> for ClickPositionVisitor {
            type Value = ClickPosition;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a ClickPosition object or a JSON string representing one")
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                // Handle stringified JSON
                serde_json::from_str(value).map_err(de::Error::custom)
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: de::MapAccess<'de>,
            {
                let mut x_percentage = None;
                let mut y_percentage = None;

                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "x_percentage" => {
                            x_percentage = Some(map.next_value()?);
                        }
                        "y_percentage" => {
                            y_percentage = Some(map.next_value()?);
                        }
                        _ => {
                            let _: serde_json::Value = map.next_value()?;
                        }
                    }
                }

                Ok(ClickPosition {
                    x_percentage: x_percentage
                        .ok_or_else(|| de::Error::missing_field("x_percentage"))?,
                    y_percentage: y_percentage
                        .ok_or_else(|| de::Error::missing_field("y_percentage"))?,
                })
            }
        }

        deserializer.deserialize_any(ClickPositionVisitor)
    }
}

/// Unified click tool supporting three modes:
/// 1. Selector mode: provide `process` + `selector` to find and click an element
/// 2. Index mode: provide `index` (+ optional `vision_type`) to click an indexed item from get_window_tree
/// 3. Coordinate mode: provide `x` + `y` to click at absolute screen coordinates
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct ClickElementArgs {
    // === MODE 1: Selector-based clicking ===
    #[schemars(
        description = "Process name to scope the search (e.g., 'chrome', 'notepad'). Required for selector mode."
    )]
    pub process: Option<String>,

    #[schemars(
        description = "A string selector to locate the element (e.g., 'role:Button|name:Submit'). Used with process for selector mode."
    )]
    pub selector: Option<String>,

    #[schemars(
        description = "Optional window selector for additional filtering within the process."
    )]
    pub window_selector: Option<String>,

    #[schemars(description = "Optional alternative selectors to try in parallel.")]
    pub alternative_selectors: Option<String>,

    #[schemars(description = "Optional fallback selectors to try sequentially if primary fails.")]
    pub fallback_selectors: Option<String>,

    #[schemars(
        description = "Click position as percentage within element bounds (selector mode only). Defaults to center (50, 50)."
    )]
    pub click_position: Option<ClickPosition>,

    // === MODE 2: Index-based clicking ===
    #[schemars(
        description = "The 1-based index of the item to click (from get_window_tree output, e.g., #1, #2). Used for index mode."
    )]
    pub index: Option<u32>,

    #[schemars(
        description = "Source of the indexed item: 'ui_tree' (default), 'ocr', 'omniparser', 'gemini', or 'dom'. Used with index."
    )]
    pub vision_type: Option<VisionType>,

    // === MODE 3: Coordinate-based clicking ===
    #[schemars(description = "Absolute screen X coordinate. Used with y for coordinate mode.")]
    pub x: Option<f64>,

    #[schemars(description = "Absolute screen Y coordinate. Used with x for coordinate mode.")]
    pub y: Option<f64>,

    // === Common options ===
    #[schemars(description = "Type of click: 'left' (default), 'double', or 'right'.")]
    #[serde(default)]
    pub click_type: ClickType,

    #[schemars(
        description = "If true, restore cursor to its original position after clicking. Defaults to true."
    )]
    #[serde(default = "default_true")]
    pub restore_cursor: bool,

    #[serde(flatten)]
    pub action: ActionOptions,

    #[serde(flatten)]
    pub highlight: HighlightOptions,

    #[serde(flatten)]
    pub tree: DiffTreeOptions,

    #[serde(flatten)]
    pub monitor: MonitorScreenshotOptions,
    #[serde(flatten)]
    pub window_screenshot: WindowScreenshotOptions,

    #[serde(flatten)]
    pub window_mgmt: WindowManagementOptions,
}

/// Click mode determined from provided arguments
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ClickMode {
    /// Click element by selector (process + selector)
    Selector,
    /// Click by index from get_window_tree
    Index,
    /// Click at absolute screen coordinates
    Coordinates,
}

impl ClickElementArgs {
    /// Determine which click mode based on provided arguments
    pub fn determine_mode(&self) -> Result<ClickMode, String> {
        // Selector mode requires an actual selector, not just process
        // (process is just a scoping filter that can be used with any mode)
        let has_selector = self.selector.is_some();
        let has_index = self.index.is_some();
        let has_coords = self.x.is_some() && self.y.is_some();
        let has_partial_coords = self.x.is_some() || self.y.is_some();

        // Validate: exactly one mode must be specified
        let mode_count = [has_selector, has_index, has_coords]
            .iter()
            .filter(|&&x| x)
            .count();

        if mode_count == 0 {
            // Check for partial coordinates
            if has_partial_coords {
                return Err("Coordinate mode requires both 'x' and 'y' parameters".to_string());
            }
            return Err(
                "Must specify one of: (selector), (index), or (x + y coordinates)".to_string(),
            );
        }

        if mode_count > 1 {
            return Err(
                "Cannot mix modes: specify only one of (selector), (index), or (x + y)".to_string(),
            );
        }

        if has_selector {
            Ok(ClickMode::Selector)
        } else if has_index {
            Ok(ClickMode::Index)
        } else {
            Ok(ClickMode::Coordinates)
        }
    }

    /// Build the full selector string (for selector mode)
    pub fn build_full_selector(&self) -> String {
        let process = self.process.as_deref().unwrap_or("");
        let selector = self.selector.as_deref().unwrap_or("");

        if selector.is_empty() {
            if let Some(window_sel) = &self.window_selector {
                format!("process:{} >> {}", process, window_sel)
            } else {
                format!("process:{}", process)
            }
        } else if let Some(window_sel) = &self.window_selector {
            format!("process:{} >> {} >> {}", process, window_sel, selector)
        } else {
            format!("process:{} >> {}", process, selector)
        }
    }

    /// Build alternative selectors string (for selector mode)
    pub fn build_alternative_selectors(&self) -> Option<String> {
        let process = self.process.as_deref()?;
        let alternatives = self.alternative_selectors.as_ref()?;

        Some(
            alternatives
                .split(',')
                .map(|s| format!("process:{} >> {}", process, s.trim()))
                .collect::<Vec<_>>()
                .join(","),
        )
    }

    /// Build fallback selectors string (for selector mode)
    pub fn build_fallback_selectors(&self) -> Option<String> {
        let process = self.process.as_deref()?;
        let fallbacks = self.fallback_selectors.as_ref()?;

        Some(
            fallbacks
                .split(',')
                .map(|s| format!("process:{} >> {}", process, s.trim()))
                .collect::<Vec<_>>()
                .join(","),
        )
    }

    /// Get click position, defaulting to center (50, 50)
    pub fn get_click_position(&self) -> ClickPosition {
        self.click_position.clone().unwrap_or(ClickPosition {
            x_percentage: 50,
            y_percentage: 50,
        })
    }

    /// Get vision type, defaulting to UiTree
    pub fn get_vision_type(&self) -> VisionType {
        self.vision_type.unwrap_or(VisionType::UiTree)
    }
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct TypeIntoElementArgs {
    #[schemars(description = "The text to type into the element")]
    pub text_to_type: String,
    #[schemars(
        description = "REQUIRED: Whether to clear the element before typing. Set to true to clear existing text, false to append."
    )]
    pub clear_before_typing: bool,
    #[schemars(
        description = "Whether to try focusing the element before typing (default: true). Set to false to skip focus attempt."
    )]
    #[serde(default = "default_true")]
    pub try_focus_before: bool,
    #[schemars(
        description = "Whether to try clicking the element if focus fails (default: true). Set to false to disable click fallback. Useful to avoid unwanted clicks on checkboxes or buttons."
    )]
    #[serde(default = "default_true")]
    pub try_click_before: bool,
    #[schemars(
        description = "Whether to restore the original focus and caret position after typing (default: false). When true, saves the currently focused element and caret position before typing, then restores them after. Useful when automation should not disrupt user's current work."
    )]
    #[serde(default)]
    pub restore_focus: bool,
    #[serde(flatten)]
    pub selector: SelectorOptions,

    // Note: No ActionOptions here - typing uses auto-verification from core library
    #[schemars(description = "Optional timeout in milliseconds for the action")]
    pub timeout_ms: Option<u64>,

    #[schemars(description = "Number of times to retry this step on failure.")]
    pub retries: Option<u32>,

    #[serde(flatten)]
    pub highlight: HighlightOptions,

    #[serde(flatten)]
    pub tree: DiffTreeOptions,

    #[serde(flatten)]
    pub monitor: MonitorScreenshotOptions,
    #[serde(flatten)]
    pub window_screenshot: WindowScreenshotOptions,

    #[serde(flatten)]
    pub window_mgmt: WindowManagementOptions,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct PressKeyArgs {
    #[schemars(
        description = "The key or key combination to press. Auto-normalized to curly brace format (e.g., 'Enter' -> '{Enter}'). Examples: 'Enter', 'Tab', 'Escape', 'Ctrl+A', '{Ctrl}c', '{Alt}{F4}'"
    )]
    pub key: String,
    #[schemars(
        description = "Whether to try focusing the element before pressing the key (default: true). Set to false to skip focus attempt."
    )]
    #[serde(default = "default_true")]
    pub try_focus_before: bool,
    #[schemars(
        description = "Whether to try clicking the element if focus fails (default: true). Set to false to disable click fallback. Useful to avoid unwanted clicks on checkboxes or buttons."
    )]
    #[serde(default = "default_true")]
    pub try_click_before: bool,
    #[serde(flatten)]
    pub selector: SelectorOptions,

    #[serde(flatten)]
    pub action: ActionOptions,

    #[serde(flatten)]
    pub highlight: HighlightOptions,

    #[serde(flatten)]
    pub tree: DiffTreeOptions,

    #[serde(flatten)]
    pub monitor: MonitorScreenshotOptions,
    #[serde(flatten)]
    pub window_screenshot: WindowScreenshotOptions,

    #[serde(flatten)]
    pub window_mgmt: WindowManagementOptions,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct GlobalKeyArgs {
    #[schemars(
        description = "Process name to scope the search (e.g., 'chrome', 'notepad', 'explorer'). Required to activate the correct window before pressing the key."
    )]
    pub process: String,

    #[schemars(
        description = "The key or key combination to press. Auto-normalized to curly brace format (e.g., 'Enter' -> '{Enter}'). Examples: 'Enter', 'PageDown', 'Ctrl+V', '{Ctrl}{V}'"
    )]
    pub key: String,

    #[schemars(
        description = "Selector that should exist after action. EXACT match from UI tree only - never guess. Use \"\" to skip."
    )]
    pub verify_element_exists: String,

    #[schemars(
        description = "Selector that should NOT exist after action. EXACT match from UI tree only - never guess. Use \"\" to skip."
    )]
    pub verify_element_not_exists: String,

    #[schemars(
        description = "Timeout in milliseconds for post-action verification. The system will poll until verification passes or timeout is reached. Defaults to 2000ms if not specified."
    )]
    pub verify_timeout_ms: Option<u64>,

    #[serde(flatten)]
    pub tree: DiffTreeOptions,
    #[serde(flatten)]
    pub monitor: MonitorScreenshotOptions,
    #[serde(flatten)]
    pub window_screenshot: WindowScreenshotOptions,

    #[serde(flatten)]
    pub window_mgmt: WindowManagementOptions,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct RunCommandArgs {
    #[schemars(
        description = "The shell command to run (GitHub Actions-style). When using 'engine', this field contains the inline code to execute. Either this or script_file must be provided."
    )]
    pub run: Option<String>,
    #[schemars(
        description = "Optional path to script file to load and execute. Either this or 'run' must be provided. When using 'engine', the file should contain JavaScript or Python code."
    )]
    pub script_file: Option<String>,
    #[schemars(
        description = "Optional environment variables to inject into the script (only works with 'engine' mode). Variables are automatically available as proper JavaScript/Python types - JSON strings are parsed into objects/arrays. Variables can be accessed directly without 'env.' prefix.",
        schema_with = "json_object_schema"
    )]
    pub env: Option<serde_json::Value>,
    #[schemars(
        description = "Optional high-level engine to execute inline code with SDK bindings. One of: 'node', 'bun', 'javascript', 'js', 'typescript', 'ts', 'python'. When set, 'run' or 'script_file' must contain the code to execute."
    )]
    pub engine: Option<String>,
    #[schemars(
        description = "The shell to use for 'run' (ignored when 'engine' is used). If not specified, defaults to PowerShell on Windows, bash on Unix. Common values: 'bash', 'sh', 'cmd', 'powershell', 'pwsh'"
    )]
    pub shell: Option<String>,
    #[schemars(
        description = "Working directory where the command should be executed. Defaults to current directory."
    )]
    pub working_directory: Option<String>,
    #[schemars(
        description = "Whether to include screenshots of all monitors in the response. Defaults to false."
    )]
    pub include_monitor_screenshots: Option<bool>,
    #[schemars(
        description = "Include execution logs (stdout/stderr) in response. Defaults to true. On errors, logs are always included regardless of this setting."
    )]
    pub include_logs: Option<bool>,
    #[schemars(
        description = "Timeout in milliseconds for shell command execution (ignored when 'engine' is used). Defaults to 120000 (2 minutes). Set to 0 for no timeout."
    )]
    pub timeout_ms: Option<u64>,
}

/// Arguments for the ask_user tool - allows AI to request clarification from the user
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct AskUserArgs {
    #[schemars(
        description = "The question or message to show the user. Be specific about what you need clarification on."
    )]
    pub question: String,
    #[schemars(
        description = "Optional list of choices for the user to select from. Use this for simple single-choice questions like 'Which button should I click?' with options ['The blue Submit button', 'The gray Cancel button']."
    )]
    pub choices: Option<Vec<String>>,
    #[schemars(
        description = "Optional context about why you're asking this question. Helps the user understand what information you need."
    )]
    pub context: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct MouseDragArgs {
    #[schemars(description = "Start X coordinate")]
    pub start_x: f64,
    #[schemars(description = "Start Y coordinate")]
    pub start_y: f64,
    #[schemars(description = "End X coordinate")]
    pub end_x: f64,
    #[schemars(description = "End Y coordinate")]
    pub end_y: f64,
    #[serde(flatten)]
    pub selector: SelectorOptions,

    #[serde(flatten)]
    pub action: ActionOptions,

    #[serde(flatten)]
    pub highlight: HighlightOptions,

    #[serde(flatten)]
    pub tree: DiffTreeOptions,

    #[serde(flatten)]
    pub monitor: MonitorScreenshotOptions,
    #[serde(flatten)]
    pub window_screenshot: WindowScreenshotOptions,

    #[serde(flatten)]
    pub window_mgmt: WindowManagementOptions,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, Default)]
#[serde(rename_all = "lowercase")]
pub enum ClickType {
    #[default]
    Left,
    Double,
    Right,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum VisionType {
    Ocr,
    Omniparser,
    #[serde(alias = "ui_tree")]
    #[serde(alias = "uitree")]
    UiTree,
    #[serde(alias = "dom")]
    Dom,
    /// Gemini vision model elements
    #[serde(alias = "vision")]
    Gemini,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct ValidateElementArgs {
    #[serde(flatten)]
    pub selector: SelectorOptions,

    #[serde(flatten)]
    pub action: ActionOptions,

    #[serde(flatten)]
    pub tree: SimpleTreeOptions,

    #[serde(flatten)]
    pub monitor: MonitorScreenshotOptions,
    #[serde(flatten)]
    pub window_screenshot: WindowScreenshotOptions,

    /// Maximum dimension (width or height) for the screenshot. Default: 1920px
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schemars(
        description = "Maximum dimension (width or height) for the screenshot. Screenshots larger than this will be resized while maintaining aspect ratio. Default: 1920px"
    )]
    pub max_dimension: Option<u32>,

    #[serde(flatten)]
    pub window_mgmt: WindowManagementOptions,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct CaptureScreenshotArgs {
    #[serde(flatten)]
    pub selector: SelectorOptions,

    #[serde(flatten)]
    pub action: ActionOptions,

    #[serde(flatten)]
    pub tree: SimpleTreeOptions,

    #[serde(flatten)]
    pub monitor: MonitorScreenshotOptions,
    #[serde(flatten)]
    pub window_screenshot: WindowScreenshotOptions,

    /// Maximum dimension (width or height) for the screenshot. Default: 1920px
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schemars(
        description = "Maximum dimension (width or height) for the screenshot. Screenshots larger than this will be resized while maintaining aspect ratio. Default: 1920px"
    )]
    pub max_dimension: Option<u32>,

    #[schemars(
        description = "If true, captures the entire monitor where the target window is located instead of the window/element. Defaults to false."
    )]
    #[serde(default)]
    pub entire_monitor: bool,

    #[serde(flatten)]
    pub window_mgmt: WindowManagementOptions,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct HighlightElementArgs {
    #[schemars(description = "BGR color code (optional, default red)")]
    pub color: Option<u32>,
    #[schemars(description = "Duration in milliseconds (optional, default 1000ms)")]
    pub duration_ms: Option<u64>,
    pub text: Option<String>,
    #[schemars(description = "Position of text overlay relative to the highlighted element")]
    pub text_position: Option<TextPosition>,
    #[schemars(description = "Font size in pixels (default: 14)")]
    pub font_size: Option<u32>,
    #[schemars(description = "Whether the font should be bold (default: false)")]
    pub font_bold: Option<bool>,
    #[schemars(description = "Text color in BGR format (default: 0 = black)")]
    pub font_color: Option<u32>,
    pub include_element_info: Option<bool>,
    #[serde(flatten)]
    pub selector: SelectorOptions,

    #[serde(flatten)]
    pub action: ActionOptions,

    #[serde(flatten)]
    pub tree: SimpleTreeOptions,

    #[serde(flatten)]
    pub monitor: MonitorScreenshotOptions,
    #[serde(flatten)]
    pub window_screenshot: WindowScreenshotOptions,

    #[serde(flatten)]
    pub window_mgmt: WindowManagementOptions,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct WaitForElementArgs {
    #[schemars(description = "Condition to wait for: 'visible', 'enabled', 'focused', 'exists'")]
    pub condition: String,
    #[serde(flatten)]
    pub selector: SelectorOptions,

    #[serde(flatten)]
    pub action: ActionOptions,

    #[serde(flatten)]
    pub tree: SimpleTreeOptions,

    #[serde(flatten)]
    pub monitor: MonitorScreenshotOptions,
    #[serde(flatten)]
    pub window_screenshot: WindowScreenshotOptions,

    #[serde(flatten)]
    pub window_mgmt: WindowManagementOptions,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct NavigateBrowserArgs {
    #[schemars(description = "URL to navigate to")]
    pub url: String,
    #[schemars(
        description = "Browser process name (e.g., 'chrome', 'msedge', 'firefox'). Will start the browser if not running."
    )]
    pub process: String,

    #[schemars(
        description = "Selector that should exist after navigation. EXACT match from UI tree only - never guess. Use \"\" to skip."
    )]
    pub verify_element_exists: String,

    #[schemars(
        description = "Selector that should NOT exist after navigation. EXACT match from UI tree only - never guess. Use \"\" to skip."
    )]
    pub verify_element_not_exists: String,

    #[schemars(
        description = "Timeout in milliseconds for post-action verification. The system will poll until verification passes or timeout is reached. Defaults to 2000ms if not specified."
    )]
    pub verify_timeout_ms: Option<u64>,

    #[serde(flatten)]
    pub tree: SimpleTreeOptions,
    #[serde(flatten)]
    pub monitor: MonitorScreenshotOptions,
    #[serde(flatten)]
    pub window_screenshot: WindowScreenshotOptions,

    #[serde(flatten)]
    pub window_mgmt: WindowManagementOptions,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct ExecuteBrowserScriptArgs {
    pub script: Option<String>,
    pub script_file: Option<String>,
    #[schemars(schema_with = "json_object_schema")]
    pub env: Option<serde_json::Value>,
    #[schemars(
        description = "Include browser console output (console.log, console.error, console.warn, console.info) in response. Defaults to false. When enabled, automatically intercepts console methods and returns captured logs alongside the script result. Original console methods still output to DevTools."
    )]
    pub include_logs: Option<bool>,
    #[serde(flatten)]
    pub selector: SelectorOptions,

    #[serde(flatten)]
    pub action: ActionOptions,

    #[serde(flatten)]
    pub tree: DiffTreeOptions,

    #[serde(flatten)]
    pub monitor: MonitorScreenshotOptions,
    #[serde(flatten)]
    pub window_screenshot: WindowScreenshotOptions,

    #[serde(flatten)]
    pub window_mgmt: WindowManagementOptions,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct OpenApplicationArgs {
    #[schemars(description = "Name of the application to open")]
    pub app_name: String,

    #[schemars(
        description = "Selector that should exist after app opens. EXACT match from UI tree only - never guess. Use \"\" to skip."
    )]
    pub verify_element_exists: String,

    #[schemars(
        description = "Selector that should NOT exist after app opens. EXACT match from UI tree only - never guess. Use \"\" to skip."
    )]
    pub verify_element_not_exists: String,

    #[schemars(
        description = "Timeout in milliseconds for post-action verification. The system will poll until verification passes or timeout is reached. Defaults to 2000ms if not specified."
    )]
    pub verify_timeout_ms: Option<u64>,

    #[serde(flatten)]
    pub tree: SimpleTreeOptions,

    #[serde(flatten)]
    pub monitor: MonitorScreenshotOptions,
    #[serde(flatten)]
    pub window_screenshot: WindowScreenshotOptions,

    #[serde(flatten)]
    pub window_mgmt: WindowManagementOptions,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct SelectOptionArgs {
    #[schemars(description = "The visible text of the option to select.")]
    pub option_name: String,
    #[serde(flatten)]
    pub selector: SelectorOptions,

    #[serde(flatten)]
    pub action: ActionOptions,

    #[serde(flatten)]
    pub highlight: HighlightOptions,

    #[serde(flatten)]
    pub tree: DiffTreeOptions,

    #[serde(flatten)]
    pub monitor: MonitorScreenshotOptions,
    #[serde(flatten)]
    pub window_screenshot: WindowScreenshotOptions,

    #[serde(flatten)]
    pub window_mgmt: WindowManagementOptions,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct SetValueArgs {
    #[schemars(description = "The text value to set.")]
    pub value: String,
    #[serde(flatten)]
    pub selector: SelectorOptions,

    #[serde(flatten)]
    pub action: ActionOptions,

    #[serde(flatten)]
    pub highlight: HighlightOptions,

    #[serde(flatten)]
    pub tree: DiffTreeOptions,

    #[serde(flatten)]
    pub monitor: MonitorScreenshotOptions,
    #[serde(flatten)]
    pub window_screenshot: WindowScreenshotOptions,

    #[serde(flatten)]
    pub window_mgmt: WindowManagementOptions,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct SetSelectedArgs {
    #[schemars(description = "The desired state: true for selected, false for deselected.")]
    pub state: bool,
    #[serde(flatten)]
    pub selector: SelectorOptions,

    #[serde(flatten)]
    pub action: ActionOptions,

    #[serde(flatten)]
    pub highlight: HighlightOptions,

    #[serde(flatten)]
    pub tree: DiffTreeOptions,

    #[serde(flatten)]
    pub monitor: MonitorScreenshotOptions,
    #[serde(flatten)]
    pub window_screenshot: WindowScreenshotOptions,

    #[serde(flatten)]
    pub window_mgmt: WindowManagementOptions,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[schemars(description = "Arguments for scrolling an element")]
pub struct ScrollElementArgs {
    #[serde(default)]
    #[schemars(description = "Direction to scroll: 'up', 'down', 'left', 'right'")]
    pub direction: String,
    #[serde(default = "default_scroll_amount")]
    #[schemars(description = "Amount to scroll (number of lines or pages, default: 3)")]
    pub amount: f64,
    #[serde(flatten)]
    pub selector: SelectorOptions,

    #[serde(flatten)]
    pub action: ActionOptions,

    #[serde(flatten)]
    pub highlight: HighlightOptions,

    #[serde(flatten)]
    pub tree: DiffTreeOptions,

    #[serde(flatten)]
    pub monitor: MonitorScreenshotOptions,
    #[serde(flatten)]
    pub window_screenshot: WindowScreenshotOptions,

    #[serde(flatten)]
    pub window_mgmt: WindowManagementOptions,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct ActivateElementArgs {
    #[serde(flatten)]
    pub selector: SelectorOptions,

    #[serde(flatten)]
    pub action: ActionOptions,

    #[serde(flatten)]
    pub tree: SimpleTreeOptions,

    #[serde(flatten)]
    pub monitor: MonitorScreenshotOptions,
    #[serde(flatten)]
    pub window_screenshot: WindowScreenshotOptions,

    #[serde(flatten)]
    pub window_mgmt: WindowManagementOptions,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, Clone)]
pub struct ToolCall {
    #[schemars(description = "The name of the tool to be executed.")]
    pub tool_name: String,
    #[schemars(
        description = "The arguments for the tool, as a JSON object.",
        schema_with = "json_object_schema"
    )]
    pub arguments: serde_json::Value,
    #[schemars(
        description = "If true, the sequence will continue even if this tool call fails. Defaults to false."
    )]
    pub continue_on_error: Option<bool>,
    #[schemars(
        description = "An optional delay in milliseconds to wait after this tool call completes."
    )]
    pub delay_ms: Option<u64>,
    #[schemars(
        description = "Optional unique identifier for this step. If provided, the tool's result will be stored as {step_id}_result and its status as {step_id}_status in the environment for use in subsequent steps."
    )]
    pub id: Option<String>,
}

// Simplified structure for Gemini compatibility
#[derive(Debug, Serialize, Deserialize, JsonSchema, Clone)]
pub struct JumpCondition {
    #[serde(rename = "if")]
    #[schemars(description = "Expression to evaluate for this jump condition")]
    pub condition: String,

    #[schemars(description = "Target step ID to jump to when condition is true")]
    pub to_id: String,

    #[schemars(description = "Optional human-readable explanation logged when this jump is taken")]
    pub reason: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, Clone, Default)]
pub struct SequenceStep {
    #[schemars(description = "The name of the tool to execute (for single tool steps)")]
    pub tool_name: Option<String>,
    #[schemars(
        description = "The arguments for the tool (for single tool steps)",
        schema_with = "json_object_schema"
    )]
    pub arguments: Option<serde_json::Value>,
    #[schemars(description = "Continue on error flag (for single tool steps)")]
    pub continue_on_error: Option<bool>,
    #[schemars(description = "Delay after execution (for single tool steps)")]
    pub delay_ms: Option<u64>,
    #[schemars(description = "Group name (for grouped steps)")]
    pub group_name: Option<String>,
    #[schemars(description = "Steps in the group (for grouped steps)")]
    pub steps: Option<Vec<ToolCall>>,
    #[schemars(description = "Whether the group is skippable on error (for grouped steps)")]
    pub skippable: Option<bool>,
    #[serde(rename = "if", skip_serializing_if = "Option::is_none")]
    #[schemars(
        description = "An optional expression to determine if this step should run. e.g., \"policy.use_max_budget == true\" or \"contains(policy.product_types, 'FEX')\""
    )]
    pub r#if: Option<String>,
    #[schemars(description = "Number of times to retry this step or group on failure.")]
    pub retries: Option<u32>,
    #[schemars(
        description = "Optional unique identifier for this step (string). If provided, it can be a target for other steps' fallback_id. Additionally, the tool's result will be stored as {step_id}_result and its status as {step_id}_status in the environment, making it accessible to subsequent steps."
    )]
    pub id: Option<String>,
    #[schemars(
        description = "Optional id of the step to jump to if this step ultimately fails after all retries. This enables robust fallback flows without relying on numeric indices."
    )]
    pub fallback_id: Option<String>,

    #[schemars(
        description = "Conditional jumps evaluated in order after successful step execution. First matching condition triggers jump to target step."
    )]
    pub jumps: Option<Vec<JumpCondition>>,

    // Simplified aliases (keeping originals for backward compatibility)
    #[schemars(
        description = "Simplified alias for 'delay_ms'. Supports human-readable durations like '1s', '500ms', '2m'. Defaults to milliseconds if no unit specified."
    )]
    pub delay: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    #[schemars(
        description = "Expected UI changes after this action (diff between before/after UI trees). Used for validation during workflow playback to ensure actions had the expected effect."
    )]
    pub expected_ui_changes: Option<String>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, Clone, Default, JsonSchema)]
pub struct ExecuteSequenceArgs {
    #[schemars(
        description = "Optional URL to fetch workflow definition from (HTTP/HTTPS or file:// supported)."
    )]
    pub url: Option<String>,
    #[schemars(
        description = "The steps of the workflow to execute in order. Optional when url is provided."
    )]
    #[serde(default)]
    pub steps: Option<Vec<SequenceStep>>,
    #[schemars(
        description = "Optional troubleshooting steps that can be jumped to via fallback_id. These steps are not executed in normal flow."
    )]
    #[serde(default)]
    pub troubleshooting: Option<Vec<SequenceStep>>,
    #[schemars(
        description = "A key-value map defining the schema for dynamic variables (e.g., for UI generation)."
    )]
    pub variables: Option<HashMap<String, VariableDefinition>>,
    #[schemars(
        description = "A key-value map of the actual input values for the variables defined in the schema. **Must be an object**, not a string.",
        schema_with = "json_object_schema"
    )]
    pub inputs: Option<serde_json::Value>,
    #[schemars(
        description = "A key-value map of static UI element selectors for the workflow. **Must be an object with string values**, not a string. Example: {\"button\": \"role:Button|name:Submit\", \"field\": \"role:Edit|name:Email\"}",
        schema_with = "json_object_schema"
    )]
    pub selectors: Option<serde_json::Value>,
    #[schemars(description = "Whether to stop the entire sequence on first error (default: true)")]
    pub stop_on_error: Option<bool>,
    #[schemars(
        description = "Whether to include detailed results from each tool execution (default: true)"
    )]
    pub include_detailed_results: Option<bool>,
    #[schemars(
        description = "An optional, structured parser to process the final tool output and extract structured data.",
        schema_with = "json_object_schema"
    )]
    pub output_parser: Option<serde_json::Value>,

    // Simplified aliases for common parameters (keeping originals for backward compatibility)
    #[schemars(
        description = "Simplified alias for 'output_parser'. Processes the final tool output and extracts structured data. Supports JavaScript code or file path.",
        schema_with = "json_object_schema"
    )]
    pub output: Option<serde_json::Value>,

    #[schemars(
        description = "Continue execution on errors. Opposite of stop_on_error. When true, workflow continues even if steps fail (default: false)."
    )]
    pub r#continue: Option<bool>,

    #[schemars(
        description = "Output verbosity level. Options: 'quiet' (minimal), 'normal' (default), 'verbose' (detailed)."
    )]
    pub verbosity: Option<String>,
    #[schemars(description = "Start execution from a specific step ID (will load saved state)")]
    pub start_from_step: Option<String>,
    #[schemars(description = "Stop execution after a specific step ID (inclusive)")]
    pub end_at_step: Option<String>,
    #[schemars(
        description = "Whether to follow fallback_id when end_at_step is specified. When false (default), execution stops at end_at_step regardless of failures. When true, allows following fallback_id even beyond end_at_step boundary."
    )]
    pub follow_fallback: Option<bool>,
    #[schemars(
        description = "Whether to execute jumps when reaching the end_at_step boundary. When false (default), jumps are skipped at the end step. When true, jumps are evaluated and executed even at the boundary."
    )]
    pub execute_jumps_at_end: Option<bool>,
    #[schemars(
        description = "Optional base path for resolving script files. When script_file is used in run_command or execute_browser_script, relative paths will first be searched in this directory, then fallback to workflow directory or current directory."
    )]
    pub scripts_base_path: Option<String>,
    #[schemars(
        description = "Optional workflow identifier for env state persistence. If provided, will be used instead of URL hash for determining state file location. This allows passing workflow definitions inline without needing a file URL."
    )]
    pub workflow_id: Option<String>,

    #[schemars(
        description = "Skip the browser extension pre-flight check. When true, workflows with execute_browser_script steps will not open/close an about:blank tab to verify extension connectivity before execution. Default: false (pre-flight check enabled)."
    )]
    pub skip_preflight_check: Option<bool>,

    #[schemars(
        description = "Optional trace ID for distributed tracing. When provided by the executor, this trace_id will be used in OpenTelemetry spans to correlate executor and agent logs."
    )]
    pub trace_id: Option<String>,

    #[schemars(
        description = "Optional execution ID for distributed tracing. When provided by the executor, this execution_id will be attached to all logs for correlation."
    )]
    pub execution_id: Option<String>,

    #[serde(flatten)]
    pub window_mgmt: WindowManagementOptions,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, Clone)]
#[serde(rename_all = "camelCase")]
pub enum VariableType {
    String,
    Number,
    Boolean,
    Enum,
    Array,
    Object,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, Clone)]
pub struct VariableDefinition {
    #[schemars(description = "The data type of the variable.")]
    pub r#type: VariableType,
    #[schemars(
        description = "A user-friendly label for the variable, for UI generation. Optional for nested schemas (value_schema, properties, item_schema)."
    )]
    #[serde(default)]
    pub label: Option<String>,
    #[schemars(description = "A detailed description of what the variable is for.")]
    pub description: Option<String>,
    #[schemars(
        description = "The default value for the variable if not provided in the inputs.",
        schema_with = "json_object_schema"
    )]
    pub default: Option<serde_json::Value>,
    #[schemars(description = "For string types, a regex pattern for validation.")]
    pub regex: Option<String>,
    #[schemars(description = "For enum types, a list of allowed string values.")]
    pub options: Option<Vec<String>>,
    #[schemars(description = "Whether this variable is required. Defaults to true.")]
    pub required: Option<bool>,
    #[schemars(
        description = "For object types with flat key-value structure, defines the schema for all values (e.g., all values must be enum with specific options)."
    )]
    pub value_schema: Option<Box<VariableDefinition>>,
    #[schemars(
        description = "For object types with known properties, defines the schema for each named property."
    )]
    pub properties: Option<HashMap<String, Box<VariableDefinition>>>,
    #[schemars(description = "For array types, defines the schema for array items.")]
    pub item_schema: Option<Box<VariableDefinition>>,
}

// Keep the old structures for internal use
#[derive(Debug, Serialize, Deserialize)]
pub struct ToolGroup {
    pub group_name: String,
    pub steps: Vec<ToolCall>,
    pub skippable: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
pub enum SequenceItem {
    Tool { tool_call: ToolCall },
    Group { tool_group: ToolGroup },
}

#[derive(Deserialize, JsonSchema, Debug, Clone)]
pub struct ZoomArgs {
    pub level: u32,
    #[schemars(
        description = "Whether to include screenshots of all monitors in the response. Defaults to false."
    )]
    pub include_monitor_screenshots: Option<bool>,
}

/// Arguments for Gemini Computer Use agentic loop tool
#[derive(Deserialize, JsonSchema, Debug, Clone)]
pub struct GeminiComputerUseArgs {
    #[schemars(
        description = "Process name of the target application (e.g., 'chrome', 'notepad', 'explorer')"
    )]
    pub process: String,

    #[schemars(description = "The goal to achieve (e.g., 'Open Notepad and type Hello World')")]
    pub goal: String,

    #[schemars(description = "Maximum number of steps to take before stopping. Defaults to 20.")]
    pub max_steps: Option<u32>,

    #[serde(flatten)]
    pub window_mgmt: WindowManagementOptions,
}

// ===== File Operation Tools Args =====

/// Arguments for reading a file
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ReadFileArgs {
    #[schemars(
        description = "Path to the file to read. Can be relative (resolved from working_directory) or absolute."
    )]
    pub path: String,

    #[schemars(
        description = "Working directory for resolving relative paths. Injected automatically by mediar-app based on focused workflow."
    )]
    pub working_directory: Option<String>,

    #[schemars(description = "Line number to start reading from (1-indexed). Defaults to 1.")]
    pub offset: Option<usize>,

    #[schemars(description = "Maximum number of lines to read. Defaults to 100, max 200.")]
    pub limit: Option<usize>,
}

/// Arguments for writing a file
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct WriteFileArgs {
    #[schemars(
        description = "Path to the file to write. Can be relative (resolved from working_directory) or absolute."
    )]
    pub path: String,

    #[schemars(description = "Content to write to the file.")]
    pub content: String,

    #[schemars(
        description = "Working directory for resolving relative paths. Injected automatically by mediar-app based on focused workflow."
    )]
    pub working_directory: Option<String>,
}

/// Arguments for editing a file (string replacement)
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct EditFileArgs {
    #[schemars(
        description = "Path to the file to edit. Can be relative (resolved from working_directory) or absolute."
    )]
    pub path: String,

    #[schemars(
        description = "String to find and replace. Can be multi-line - prefer replacing entire functions or code blocks rather than making many small edits. Line endings are normalized for matching. Must be unique in the file unless replace_all is true."
    )]
    pub old_string: String,

    #[schemars(description = "String to replace with.")]
    pub new_string: String,

    #[schemars(
        description = "Replace all occurrences instead of requiring uniqueness. Defaults to false."
    )]
    pub replace_all: Option<bool>,

    #[schemars(
        description = "Working directory for resolving relative paths. Injected automatically by mediar-app based on focused workflow."
    )]
    pub working_directory: Option<String>,
}

/// Arguments for finding files by glob pattern
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GlobFilesArgs {
    #[schemars(
        description = "Glob pattern to match files. Examples: '**/*.ts', 'src/*.rs', '*.yml'"
    )]
    pub pattern: String,

    #[schemars(
        description = "Working directory for resolving the glob pattern. Injected automatically by mediar-app based on focused workflow."
    )]
    pub working_directory: Option<String>,
}

/// Arguments for searching file contents
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GrepFilesArgs {
    #[schemars(description = "Regex pattern to search for in file contents.")]
    pub pattern: String,

    #[schemars(
        description = "Optional glob pattern to filter which files to search. Examples: '*.ts', '**/*.rs'"
    )]
    pub glob: Option<String>,

    #[schemars(description = "Case insensitive search. Defaults to false.")]
    pub ignore_case: Option<bool>,

    #[schemars(
        description = "Number of context lines before and after each match. Defaults to 2."
    )]
    pub context_lines: Option<usize>,

    #[schemars(description = "Maximum number of results to return. Defaults to 50.")]
    pub max_results: Option<usize>,

    #[schemars(
        description = "Working directory for resolving relative paths. Injected automatically by mediar-app based on focused workflow."
    )]
    pub working_directory: Option<String>,
}

/// Arguments for copying content between files
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CopyContentArgs {
    #[schemars(description = "Path to the source file to copy content from.")]
    pub source_path: String,

    #[schemars(description = "Path to the target file to insert/replace content into.")]
    pub target_path: String,

    #[schemars(
        description = "How to select content from source. Options: 'lines' (use source_start_line/source_end_line), 'pattern' (use source_start_pattern/source_end_pattern), or 'all' (entire file content)."
    )]
    pub source_mode: String,

    #[schemars(
        description = "Start line number (1-indexed, inclusive). Required when source_mode is 'lines'."
    )]
    pub source_start_line: Option<usize>,

    #[schemars(
        description = "End line number (1-indexed, inclusive). Required when source_mode is 'lines'."
    )]
    pub source_end_line: Option<usize>,

    #[schemars(
        description = "Substring to match start of content (line containing this is included). Required when source_mode is 'pattern'."
    )]
    pub source_start_pattern: Option<String>,

    #[schemars(
        description = "Substring to match end of content (first line containing this after start is included). Required when source_mode is 'pattern'."
    )]
    pub source_end_pattern: Option<String>,

    #[schemars(
        description = "Where to insert in target. Options: 'replace' (replace target_pattern match), 'after' (insert after target_pattern), 'before' (insert before target_pattern), 'at_line' (insert before target_line, pushing existing content down), 'append' (end of file), 'prepend' (start of file)."
    )]
    pub target_mode: String,

    #[schemars(
        description = "Substring to find in target file. Must be unique unless replace_all is true. Required for replace/after/before modes."
    )]
    pub target_pattern: Option<String>,

    #[schemars(
        description = "Replace all occurrences of target_pattern. Defaults to false (requires unique match)."
    )]
    pub replace_all: Option<bool>,

    #[schemars(
        description = "Line number to insert at (1-indexed). Content is inserted before this line. Required when target_mode is 'at_line'."
    )]
    pub target_line: Option<usize>,

    #[schemars(
        description = "Working directory for resolving relative paths. Injected automatically by mediar-app based on focused workflow."
    )]
    pub working_directory: Option<String>,
}

#[derive(Debug)]
pub struct ValidationError {
    pub field: String,
    pub expected: String,
    pub actual: String,
}

impl ValidationError {
    pub fn new(field: &str, expected: &str, actual: &str) -> Self {
        Self {
            field: field.to_string(),
            expected: expected.to_string(),
            actual: actual.to_string(),
        }
    }
}

pub fn validate_inputs(inputs: &serde_json::Value) -> Result<(), ValidationError> {
    if !inputs.is_object() {
        return Err(ValidationError::new(
            "inputs",
            "object",
            &format!("{inputs:?}"),
        ));
    }
    Ok(())
}

pub fn validate_selectors(selectors: &serde_json::Value) -> Result<(), ValidationError> {
    match selectors {
        serde_json::Value::Object(obj) => {
            // Check that all values are strings
            for (key, value) in obj {
                if !value.is_string() {
                    return Err(ValidationError::new(
                        &format!("selectors.{key}"),
                        "string",
                        match value {
                            serde_json::Value::Number(_) => "number",
                            serde_json::Value::Bool(_) => "boolean",
                            serde_json::Value::Array(_) => "array",
                            serde_json::Value::Object(_) => "object",
                            serde_json::Value::Null => "null",
                            _ => "unknown",
                        },
                    ));
                }
            }
            Ok(())
        }
        serde_json::Value::String(s) => {
            // Try to parse as JSON object first
            match serde_json::from_str::<serde_json::Value>(s) {
                Ok(parsed) => validate_selectors(&parsed),
                Err(_) => Err(ValidationError::new(
                    "selectors",
                    "object or valid JSON string",
                    "invalid JSON string",
                )),
            }
        }
        _ => Err(ValidationError::new(
            "selectors",
            "object or JSON string",
            &format!("{selectors:?}"),
        )),
    }
}

pub fn validate_output_parser(parser: &serde_json::Value) -> Result<(), ValidationError> {
    let obj = parser
        .as_object()
        .ok_or_else(|| ValidationError::new("output_parser", "object", &format!("{parser:?}")))?;

    // Check required fields
    if !obj.contains_key("uiTreeJsonPath") {
        return Err(ValidationError::new(
            "output_parser.uiTreeJsonPath",
            "string",
            "missing",
        ));
    }

    if !obj.contains_key("itemContainerDefinition") {
        return Err(ValidationError::new(
            "output_parser.itemContainerDefinition",
            "object",
            "missing",
        ));
    }

    if !obj.contains_key("fieldsToExtract") {
        return Err(ValidationError::new(
            "output_parser.fieldsToExtract",
            "object",
            "missing",
        ));
    }

    Ok(())
}

// Removed: RunJavascriptArgs (merged into RunCommandArgs via engine + script)

pub fn init_logging() -> Result<Option<LogCapture>> {
    use tracing_appender::rolling;

    let log_level = env::var("LOG_LEVEL")
        .map(|level| match level.to_lowercase().as_str() {
            "error" => Level::ERROR,
            "warn" => Level::WARN,
            "info" => Level::INFO,
            "debug" => Level::DEBUG,
            _ => Level::INFO,
        })
        .unwrap_or(Level::INFO);

    // Determine log directory - check for override first
    let log_dir = if let Ok(custom_dir) = env::var("COMPUTERUSE_LOG_DIR") {
        // User-specified log directory via environment variable
        std::path::PathBuf::from(custom_dir)
    } else {
        // Use standard directories: data_local_dir on all platforms with temp fallback
        dirs::data_local_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("computeruse")
            .join("logs")
    };

    // Create log directory if it doesn't exist
    if let Err(e) = std::fs::create_dir_all(&log_dir) {
        warn!("Failed to create log directory: {}", e);
    }

    // Create daily rolling file appenders (need separate instances for each layer)
    let file_appender = rolling::daily(&log_dir, "computeruse-mcp-agent.log");
    let file_appender2 = rolling::daily(&log_dir, "computeruse-mcp-agent.log");

    // Create log capture instance (max 1000 entries to prevent unbounded growth)
    let log_capture = LogCapture::new(1000);
    let capture_layer = LogCaptureLayer::new(log_capture.clone());
    let capture_layer2 = LogCaptureLayer::new(log_capture.clone());

    // Build the subscriber with stderr output, file output, log capture, optional OTLP, and optional Sentry
    #[cfg(feature = "telemetry")]
    {
        // Try to create combined OTLP layer (traces + logs)
        // The combined layer includes tracing-opentelemetry (for TraceId propagation) and
        // OpenTelemetryTracingBridge (for sending logs with TraceId)
        match crate::telemetry::create_otel_logs_layer() {
            Some(otel_layer) => {
                use tracing_subscriber::layer::SubscriberExt;

                // Start with Registry - add combined OTEL layer first
                let base_subscriber = tracing_subscriber::registry().with(
                    // Combined OTEL layer with RUST_LOG filtering - CRITICAL to avoid HTTP client noise
                    otel_layer.with_filter(
                        EnvFilter::try_from_default_env()
                            .unwrap_or_else(|_| {
                                EnvFilter::new("info,computeruse=info,computeruse_mcp_agent=info")
                            })
                            .add_directive(log_level.into())
                            // Filter out noisy health check and connection logs - set to ERROR to suppress repetitive warnings
                            .add_directive(
                                "computeruse::platforms::windows::health=error"
                                    .parse()
                                    .unwrap(),
                            )
                            .add_directive("axum::serve=error".parse().unwrap())
                            .add_directive("h2::proto=error".parse().unwrap())
                            .add_directive("h2::codec=error".parse().unwrap())
                            .add_directive("h2::server=error".parse().unwrap())
                            .add_directive("h2::frame=error".parse().unwrap())
                            .add_directive("rmcp::transport=warn".parse().unwrap())
                            .add_directive(
                                "rmcp::transport::streamable_http_server=error"
                                    .parse()
                                    .unwrap(),
                            )
                            .add_directive("rmcp::service=error".parse().unwrap())
                            .add_directive("hyper::client=error".parse().unwrap())
                            .add_directive("hyper::proto=error".parse().unwrap())
                            // Also filter scripting engine DEBUG logs from telemetry
                            .add_directive(
                                "computeruse_mcp_agent::scripting_engine=info"
                                    .parse()
                                    .unwrap(),
                            ),
                    ),
                );

                // Add Sentry layer when feature is enabled
                #[cfg(feature = "sentry")]
                let base_subscriber = {
                    eprintln!(
                        "✓ Sentry tracing integration enabled (configure via SENTRY_DSN env var)"
                    );
                    base_subscriber.with(sentry_tracing::layer())
                };

                let subscriber = base_subscriber
                    .with(
                        // Console/stderr layer
                        tracing_subscriber::fmt::layer()
                            .with_writer(std::io::stderr)
                            .with_ansi(false)
                            .with_filter(
                                EnvFilter::try_from_default_env()
                                    .unwrap_or_else(|_| {
                                        EnvFilter::new(
                                            "info,computeruse=info,computeruse_mcp_agent=info",
                                        )
                                    })
                                    .add_directive(log_level.into())
                                    // Filter out noisy health check and connection logs - set to ERROR to suppress repetitive warnings
                                    .add_directive(
                                        "computeruse::platforms::windows::health=error"
                                            .parse()
                                            .unwrap(),
                                    )
                                    .add_directive("axum::serve=error".parse().unwrap())
                                    .add_directive("h2::proto=error".parse().unwrap())
                                    .add_directive("h2::codec=error".parse().unwrap())
                                    .add_directive("h2::server=error".parse().unwrap())
                                    .add_directive("h2::frame=error".parse().unwrap())
                                    .add_directive("rmcp::transport=warn".parse().unwrap())
                                    .add_directive(
                                        "rmcp::transport::streamable_http_server=error"
                                            .parse()
                                            .unwrap(),
                                    )
                                    .add_directive("rmcp::service=error".parse().unwrap())
                                    .add_directive("hyper::client=error".parse().unwrap())
                                    .add_directive("hyper::proto=error".parse().unwrap()),
                            ),
                    )
                    .with(
                        // File layer with timestamps
                        tracing_subscriber::fmt::layer()
                            .with_writer(file_appender)
                            .with_ansi(false)
                            .with_target(true)
                            .with_thread_ids(true)
                            .with_thread_names(false)
                            .with_file(true)
                            .with_line_number(true)
                            .with_filter(
                                EnvFilter::try_from_default_env()
                                    .unwrap_or_else(|_| {
                                        EnvFilter::new(
                                            "info,computeruse=info,computeruse_mcp_agent=info",
                                        )
                                    })
                                    .add_directive(log_level.into())
                                    // Filter out noisy health check and connection logs - set to ERROR to suppress repetitive warnings
                                    .add_directive(
                                        "computeruse::platforms::windows::health=error"
                                            .parse()
                                            .unwrap(),
                                    )
                                    .add_directive("axum::serve=error".parse().unwrap())
                                    .add_directive("h2::proto=error".parse().unwrap())
                                    .add_directive("h2::codec=error".parse().unwrap())
                                    .add_directive("h2::server=error".parse().unwrap())
                                    .add_directive("h2::frame=error".parse().unwrap())
                                    .add_directive("rmcp::transport=warn".parse().unwrap())
                                    .add_directive(
                                        "rmcp::transport::streamable_http_server=error"
                                            .parse()
                                            .unwrap(),
                                    )
                                    .add_directive("rmcp::service=error".parse().unwrap())
                                    .add_directive("hyper::client=error".parse().unwrap())
                                    .add_directive("hyper::proto=error".parse().unwrap()),
                            ),
                    )
                    .with(capture_layer);

                tracing::subscriber::set_global_default(subscriber)
                    .expect("Failed to set subscriber");
                eprintln!(
                    "✓ OTLP logs exporter enabled - logs will be sent to OpenTelemetry collector"
                );
            }
            None => {
                // No OTLP layer - standard logging only
                use tracing_subscriber::layer::SubscriberExt;

                // Start with Registry and optionally add Sentry layer first (when feature is enabled)
                #[cfg(feature = "sentry")]
                let base_subscriber = {
                    eprintln!(
                        "✓ Sentry tracing integration enabled (configure via SENTRY_DSN env var)"
                    );
                    tracing_subscriber::registry().with(sentry_tracing::layer())
                };

                #[cfg(not(feature = "sentry"))]
                let base_subscriber = tracing_subscriber::registry();

                let subscriber = base_subscriber
                    .with(
                        // Console/stderr layer
                        tracing_subscriber::fmt::layer()
                            .with_writer(std::io::stderr)
                            .with_ansi(false)
                            .with_filter(
                                EnvFilter::try_from_default_env()
                                    .unwrap_or_else(|_| {
                                        EnvFilter::new(
                                            "info,computeruse=info,computeruse_mcp_agent=info",
                                        )
                                    })
                                    .add_directive(log_level.into())
                                    // Filter out noisy health check and connection logs - set to ERROR to suppress repetitive warnings
                                    .add_directive(
                                        "computeruse::platforms::windows::health=error"
                                            .parse()
                                            .unwrap(),
                                    )
                                    .add_directive("axum::serve=error".parse().unwrap())
                                    .add_directive("h2::proto=error".parse().unwrap())
                                    .add_directive("h2::codec=error".parse().unwrap())
                                    .add_directive("h2::server=error".parse().unwrap())
                                    .add_directive("h2::frame=error".parse().unwrap())
                                    .add_directive("rmcp::transport=warn".parse().unwrap())
                                    .add_directive(
                                        "rmcp::transport::streamable_http_server=error"
                                            .parse()
                                            .unwrap(),
                                    )
                                    .add_directive("rmcp::service=error".parse().unwrap())
                                    .add_directive("hyper::client=error".parse().unwrap())
                                    .add_directive("hyper::proto=error".parse().unwrap()),
                            ),
                    )
                    .with(
                        // File layer with timestamps
                        tracing_subscriber::fmt::layer()
                            .with_writer(file_appender2)
                            .with_ansi(false)
                            .with_target(true)
                            .with_thread_ids(true)
                            .with_thread_names(false)
                            .with_file(true)
                            .with_line_number(true)
                            .with_filter(
                                EnvFilter::try_from_default_env()
                                    .unwrap_or_else(|_| {
                                        EnvFilter::new(
                                            "info,computeruse=info,computeruse_mcp_agent=info",
                                        )
                                    })
                                    .add_directive(log_level.into())
                                    // Filter out noisy health check and connection logs - set to ERROR to suppress repetitive warnings
                                    .add_directive(
                                        "computeruse::platforms::windows::health=error"
                                            .parse()
                                            .unwrap(),
                                    )
                                    .add_directive("axum::serve=error".parse().unwrap())
                                    .add_directive("h2::proto=error".parse().unwrap())
                                    .add_directive("h2::codec=error".parse().unwrap())
                                    .add_directive("h2::server=error".parse().unwrap())
                                    .add_directive("h2::frame=error".parse().unwrap())
                                    .add_directive("rmcp::transport=warn".parse().unwrap())
                                    .add_directive(
                                        "rmcp::transport::streamable_http_server=error"
                                            .parse()
                                            .unwrap(),
                                    )
                                    .add_directive("rmcp::service=error".parse().unwrap())
                                    .add_directive("hyper::client=error".parse().unwrap())
                                    .add_directive("hyper::proto=error".parse().unwrap()),
                            ),
                    )
                    .with(capture_layer2);

                subscriber.init();
            }
        }
    }

    #[cfg(not(feature = "telemetry"))]
    {
        // No OTLP layer when telemetry feature is disabled
        use tracing_subscriber::layer::SubscriberExt;

        // Start with Registry and optionally add Sentry layer first (when feature is enabled)
        #[cfg(feature = "sentry")]
        let base_subscriber = {
            eprintln!("✓ Sentry tracing integration enabled (configure via SENTRY_DSN env var)");
            tracing_subscriber::registry().with(sentry_tracing::layer())
        };

        #[cfg(not(feature = "sentry"))]
        let base_subscriber = tracing_subscriber::registry();

        let subscriber = base_subscriber
            .with(
                // Console/stderr layer
                tracing_subscriber::fmt::layer()
                    .with_writer(std::io::stderr)
                    .with_ansi(false)
                    .with_filter(
                        EnvFilter::try_from_default_env()
                            .unwrap_or_else(|_| {
                                EnvFilter::new("info,computeruse=info,computeruse_mcp_agent=info")
                            })
                            .add_directive(log_level.into()),
                    ),
            )
            .with(
                // File layer with timestamps
                tracing_subscriber::fmt::layer()
                    .with_writer(file_appender)
                    .with_ansi(false)
                    .with_target(true)
                    .with_thread_ids(true)
                    .with_thread_names(false)
                    .with_file(true)
                    .with_line_number(true)
                    .with_filter(
                        EnvFilter::try_from_default_env()
                            .unwrap_or_else(|_| {
                                EnvFilter::new("info,computeruse=info,computeruse_mcp_agent=info")
                            })
                            .add_directive(log_level.into()),
                    ),
            )
            .with(capture_layer);

        subscriber.init();
    }

    // Log the log directory location on startup
    tracing::info!("Log files will be written to: {}", log_dir.display());

    Ok(Some(log_capture))
}

pub fn get_timeout(timeout_ms: Option<u64>) -> Option<Duration> {
    // Default to 3 seconds instead of indefinite wait to prevent hanging
    let timeout = timeout_ms.unwrap_or(3000);
    Some(Duration::from_millis(timeout))
}

/// Try multiple selectors with primary selector priority
/// The primary selector is always preferred if it succeeds, even if alternatives also succeed
pub async fn find_element_with_fallbacks(
    desktop: &Desktop,
    primary_selector: &str,
    alternative_selectors: Option<&str>,
    fallback_selectors: Option<&str>,
    timeout_ms: Option<u64>,
) -> Result<(computeruse::UIElement, String), computeruse::AutomationError> {
    use tokio::time::Duration;

    let find_start = std::time::Instant::now();
    let timeout_duration = get_timeout(timeout_ms).unwrap_or(Duration::from_millis(3000));

    // FAST PATH: If no alternatives or fallbacks are provided, just use the primary selector directly.
    if alternative_selectors.is_none() && fallback_selectors.is_none() {
        let locator = desktop.locator(computeruse::Selector::from(primary_selector));
        return match locator.first(Some(timeout_duration)).await {
            Ok(element) => {
                tracing::info!(
                    "[PERF] find_element_with_fallbacks: {}ms (selector: {})",
                    find_start.elapsed().as_millis(),
                    primary_selector
                );
                Ok((element, primary_selector.to_string()))
            }
            Err(e) => {
                tracing::info!(
                    "[PERF] find_element_with_fallbacks: {}ms (FAILED selector: {})",
                    find_start.elapsed().as_millis(),
                    primary_selector
                );
                Err(computeruse::AutomationError::ElementNotFound(format!(
                    "Primary selector '{primary_selector}' failed: {e}"
                )))
            }
        };
    }

    // Parse comma-separated alternative selectors
    let alternative_selectors_vec: Option<Vec<String>> = alternative_selectors.map(|alts| {
        alts.split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    });

    // Parse comma-separated fallback selectors
    let fallback_selectors_vec: Option<Vec<String>> = fallback_selectors.map(|alts| {
        alts.split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    });

    // Create primary task
    let desktop_clone = desktop.clone();
    let primary_clone = primary_selector.to_string();
    let primary_task = tokio::spawn(
        async move {
            let locator = desktop_clone.locator(computeruse::Selector::from(primary_clone.as_str()));
            match locator.first(Some(timeout_duration)).await {
                Ok(element) => Ok((element, primary_clone)),
                Err(e) => Err((primary_clone, e)),
            }
        }
        .in_current_span(),
    );

    // Create alternative tasks
    let mut alternative_tasks = Vec::new();
    if let Some(alternatives) = alternative_selectors_vec.as_ref() {
        for selector_str in alternatives {
            let desktop_clone = desktop.clone();
            let selector_clone = selector_str.clone();
            let task = tokio::spawn(
                async move {
                    let locator =
                        desktop_clone.locator(computeruse::Selector::from(selector_clone.as_str()));
                    match locator.first(Some(timeout_duration)).await {
                        Ok(element) => Ok((element, selector_clone)),
                        Err(e) => Err((selector_clone, e)),
                    }
                }
                .in_current_span(),
            );
            alternative_tasks.push(task);
        }
    }

    // Wait for primary task first, then alternatives
    let mut errors = Vec::new();
    let mut completed_tasks = Vec::new();
    completed_tasks.push(primary_task);
    completed_tasks.extend(alternative_tasks);

    // Use select_all but prioritize primary selector if multiple succeed
    while !completed_tasks.is_empty() {
        let (result, index, remaining_tasks) = futures::future::select_all(completed_tasks).await;

        match result {
            Ok(Ok((element, selector))) => {
                // Cancel remaining tasks
                for task in remaining_tasks {
                    task.abort();
                }

                // Always prefer primary selector (index 0) if it succeeds
                if index == 0 {
                    tracing::info!(
                        "[PERF] find_element_with_fallbacks: {}ms (primary selector: {})",
                        find_start.elapsed().as_millis(),
                        selector
                    );
                    return Ok((element, selector));
                } else {
                    // Alternative succeeded first, but give primary selector a brief grace period
                    // in case it's about to succeed too (within 10ms)
                    let desktop_clone = desktop.clone();
                    let primary_clone = primary_selector.to_string();

                    match tokio::time::timeout(Duration::from_millis(10), async move {
                        let locator = desktop_clone
                            .locator(computeruse::Selector::from(primary_clone.as_str()));
                        locator.first(Some(Duration::from_millis(1))).await
                    })
                    .await
                    {
                        Ok(Ok(primary_element)) => {
                            // Primary also succeeded within grace period - prefer it
                            tracing::info!("[PERF] find_element_with_fallbacks: {}ms (primary after grace: {})", find_start.elapsed().as_millis(), primary_selector);
                            return Ok((primary_element, primary_selector.to_string()));
                        }
                        _ => {
                            // Primary didn't succeed quickly, use the alternative that worked
                            tracing::info!(
                                "[PERF] find_element_with_fallbacks: {}ms (alternative: {})",
                                find_start.elapsed().as_millis(),
                                selector
                            );
                            return Ok((element, selector));
                        }
                    }
                }
            }
            Ok(Err((selector, error))) => {
                // Check if this is a UIAutomationAPIError - if so, return immediately
                if let computeruse::AutomationError::UIAutomationAPIError { .. } = error {
                    // This is a system-level failure that affects all selectors
                    // No point trying alternatives - abort remaining tasks
                    for task in remaining_tasks {
                        task.abort();
                    }
                    // Return the UIAutomationAPIError directly
                    return Err(error);
                }
                // For other errors, continue collecting them as strings
                errors.push(format!("'{selector}': {error}"));
                completed_tasks = remaining_tasks;
            }
            Err(join_error) => {
                errors.push(format!("Task error: {join_error}"));
                completed_tasks = remaining_tasks;
            }
        }
    }

    // If we reach here, primary and alternative selectors failed. Try fallback selectors sequentially.
    if let Some(fallbacks) = fallback_selectors_vec {
        for fb_selector in fallbacks {
            let locator = desktop.locator(computeruse::Selector::from(fb_selector.as_str()));
            match locator.first(Some(timeout_duration)).await {
                Ok(element) => {
                    return Ok((element, fb_selector));
                }
                Err(e) => {
                    errors.push(format!("'{fb_selector}': {e}"));
                }
            }
        }
    }

    // All selectors (primary, alternatives, fallbacks) failed
    let combined_error = if errors.is_empty() {
        "No selectors provided".to_string()
    } else {
        format!(
            "All {} selectors failed: [{}]",
            errors.len(),
            errors.join(", ")
        )
    };

    tracing::info!(
        "[PERF] find_element_with_fallbacks: {}ms (ALL FAILED: {})",
        find_start.elapsed().as_millis(),
        primary_selector
    );
    Err(computeruse::AutomationError::ElementNotFound(combined_error))
}

/// A robust helper that finds a UI element and executes a provided action on it,
/// with built-in retry logic for both finding the element and performing the action.
///
/// This function is the standard way to interact with elements when reliability is key.
///
/// # Arguments
/// * `desktop` - The active `Desktop` instance.
/// * `primary_selector` - The main selector for the target element.
/// * `alternatives` - A comma-separated string of fallback selectors.
/// * `timeout_ms` - The timeout for the initial element search.
/// * `retries` - The number of times to retry the *entire find-and-act sequence*.
/// * `action` - An async closure that takes the found `UIElement` and performs an action,
///
/// # Returns
/// A `Result` containing a tuple of the action's return value `T` and the `UIElement` on
/// which the action was successfully performed.
pub async fn find_and_execute_with_retry<F, Fut, T>(
    desktop: &Desktop,
    primary_selector: &str,
    alternatives: Option<&str>,
    timeout_ms: Option<u64>,
    retries: Option<u32>,
    action: F,
) -> Result<((T, UIElement), String), anyhow::Error>
where
    F: Fn(UIElement) -> Fut,
    Fut: std::future::Future<Output = Result<T, AutomationError>>,
{
    let retry_count = retries.unwrap_or(0);
    let mut last_error: Option<anyhow::Error> = None;

    for attempt in 0..=retry_count {
        match find_element_with_fallbacks(desktop, primary_selector, alternatives, None, timeout_ms)
            .await
        {
            Ok((element, successful_selector)) => match action(element.clone()).await {
                Ok(result) => return Ok(((result, element), successful_selector)),
                Err(e) => {
                    last_error = Some(e.into());
                    if attempt < retry_count {
                        warn!(
                            "Action failed on attempt {}/{}. Retrying... Error: {}",
                            attempt + 1,
                            retry_count + 1,
                            last_error.as_ref().unwrap()
                        );
                        tokio::time::sleep(Duration::from_millis(250)).await; // Wait before next retry
                    }
                }
            },
            Err(e) => {
                last_error = Some(e.into());
                if attempt < retry_count {
                    warn!(
                        "Find element failed on attempt {}/{}. Retrying... Error: {}",
                        attempt + 1,
                        retry_count + 1,
                        last_error.as_ref().unwrap()
                    );
                    // No need to sleep here, as find_element_with_fallbacks already has a timeout.
                }
            }
        }
    }

    Err(last_error.unwrap_or_else(|| {
        anyhow::anyhow!(
            "Action failed after {} retries for selector '{}'",
            retry_count + 1,
            primary_selector
        )
    }))
}

/// New helper that exposes fallback selectors as an argument. Internal implementation is shared.
pub async fn find_and_execute_with_retry_with_fallback<F, Fut, T>(
    desktop: &Desktop,
    primary_selector: &str,
    alternatives: Option<&str>,
    fallback_selectors: Option<&str>,
    timeout_ms: Option<u64>,
    retries: Option<u32>,
    action: F,
) -> Result<((T, UIElement), String), anyhow::Error>
where
    F: Fn(UIElement) -> Fut,
    Fut: std::future::Future<Output = Result<T, AutomationError>>,
{
    let retry_count = retries.unwrap_or(0);
    let mut last_error: Option<anyhow::Error> = None;

    for attempt in 0..=retry_count {
        match find_element_with_fallbacks(
            desktop,
            primary_selector,
            alternatives,
            fallback_selectors,
            timeout_ms,
        )
        .await
        {
            Ok((element, successful_selector)) => match action(element.clone()).await {
                Ok(result) => return Ok(((result, element), successful_selector)),
                Err(e) => {
                    last_error = Some(e.into());
                    if attempt < retry_count {
                        warn!(
                            "Action failed on attempt {}/{}. Retrying... Error: {}",
                            attempt + 1,
                            retry_count + 1,
                            last_error.as_ref().unwrap()
                        );
                        tokio::time::sleep(Duration::from_millis(250)).await; // Wait before next retry
                    }
                }
            },
            Err(e) => {
                last_error = Some(e.into());
                if attempt < retry_count {
                    warn!(
                        "Find element failed on attempt {}/{}. Retrying... Error: {}",
                        attempt + 1,
                        retry_count + 1,
                        last_error.as_ref().unwrap()
                    );
                    // No need to sleep here, as find_element_with_fallbacks already has a timeout.
                }
            }
        }
    }

    Err(last_error.unwrap_or_else(|| {
        anyhow::anyhow!(
            "Action failed after {} retries for selector '{}'",
            retry_count + 1,
            primary_selector
        )
    }))
}

#[derive(Debug, Clone, serde::Deserialize, schemars::JsonSchema)]
pub struct HighlightConfig {
    /// Enable visual highlighting of UI elements during recording
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Duration in milliseconds for each highlight (default: 500ms)
    pub duration_ms: Option<u64>,
    /// Border color in BGR format (default: 0x0000FF - red)
    pub color: Option<u32>,
    /// Show event type labels on highlighted elements
    #[serde(default = "default_true")]
    pub show_labels: bool,
    /// Position of event type labels relative to highlighted element
    pub label_position: Option<TextPosition>,
    /// Font style for event type labels
    pub label_style: Option<FontStyle>,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct ActionHighlightConfig {
    /// Enable visual highlighting before action execution
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Duration in milliseconds for the highlight (default: 500ms)
    pub duration_ms: Option<u64>,
    /// Border color in BGR format (default: 0x00FF00 - green)
    pub color: Option<u32>,
    /// Optional text to display as overlay
    pub text: Option<String>,
    /// Position of text overlay relative to highlighted element
    pub text_position: Option<TextPosition>,
    /// Font style for text overlay
    pub font_style: Option<FontStyle>,
}

impl Default for ActionHighlightConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            duration_ms: Some(500),
            color: Some(0x00FF00), // Green in BGR for actions
            text: None,
            text_position: Some(TextPosition::Top),
            font_style: Some(FontStyle {
                size: 12,
                bold: true,
                color: 0xFFFFFF, // White text
            }),
        }
    }
}

impl Default for HighlightConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            duration_ms: Some(500),
            color: Some(0x0000FF), // Red in BGR
            show_labels: true,
            label_position: Some(TextPosition::Top),
            label_style: Some(FontStyle {
                size: 14,
                bold: true,
                color: 0xFFFFFF, // White text
            }),
        }
    }
}
