use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashSet;
use std::sync::LazyLock;
use std::time::SystemTime;
use computeruse::UIElement;

// Precomputed set of null-like values for efficient O(1) lookups
static NULL_LIKE_VALUES: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    [
        // Standard null representations
        "null",
        "nil",
        "undefined",
        "(null)",
        "<null>",
        "n/a",
        "na",
        "",
        // Windows-specific null patterns
        "unknown",
        "<unknown>",
        "(unknown)",
        "none",
        "<none>",
        "(none)",
        "empty",
        "<empty>",
        "(empty)",
        // COM/Windows API specific
        "bstr()",
        "variant()",
        "variant(empty)",
    ]
    .into_iter()
    .collect()
});

// Helper function to filter empty strings and null-like values for serde skip_serializing_if
fn is_empty_string(s: &Option<String>) -> bool {
    match s {
        Some(s) => {
            // Fast path for completely empty strings
            if s.is_empty() {
                return true;
            }

            // Fast path for whitespace-only strings
            let trimmed = s.trim();
            if trimmed.is_empty() {
                return true;
            }

            // Check against precomputed set (case-insensitive)
            // Only allocate lowercase string if we have a reasonable candidate
            if trimmed.len() <= 20 {
                // Reasonable max length for null-like values
                let lower = trimmed.to_lowercase();
                NULL_LIKE_VALUES.contains(lower.as_str())
            } else {
                false // Long strings are unlikely to be null-like values
            }
        }
        None => true,
    }
}

/// Check if text contains relative time patterns that would make selectors unstable
/// Examples: "3 hours ago", "5 minutes ago", "yesterday", "just now"
fn contains_relative_time(text: &str) -> bool {
    // Common relative time patterns (text is already lowercase)
    text.contains(" ago")
        || text.contains("just now")
        || text.contains("yesterday")
        || text.contains("today")
        || text.contains("last week")
        || text.contains("last month")
        || text.ends_with(" min")
        || text.ends_with(" mins")
        || text.ends_with(" hr")
        || text.ends_with(" hrs")
}

/// Represents a position on the screen
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Position {
    pub x: i32,
    pub y: i32,
}

/// Represents a rectangle
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// Represents the type of mouse button
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}

/// Represents the type of mouse event
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum MouseEventType {
    Click,
    DoubleClick,
    RightClick,
    Down,
    Up,
    Move,
    Wheel,
    DragStart,
    DragEnd,
    Drop,
}

/// Represents a keyboard event
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyboardEvent {
    /// The key code
    pub key_code: u32,

    /// Whether the key was pressed or released
    pub is_key_down: bool,

    /// Whether the Ctrl key was pressed
    pub ctrl_pressed: bool,

    /// Whether the Alt key was pressed
    pub alt_pressed: bool,

    /// Whether the Shift key was pressed
    pub shift_pressed: bool,

    /// Whether the Win key was pressed
    pub win_pressed: bool,

    /// Character representation of the key (if printable)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub character: Option<char>,

    /// Raw scan code
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scan_code: Option<u32>,

    /// Event metadata (UI element, application, etc.)
    pub metadata: EventMetadata,
}

/// Represents a mouse event
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MouseEvent {
    /// The type of mouse event
    pub event_type: MouseEventType,

    /// The mouse button
    pub button: MouseButton,

    /// The position of the mouse
    pub position: Position,

    /// Scroll delta for wheel events
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scroll_delta: Option<(i32, i32)>,

    /// Drag start position (for drag events)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drag_start: Option<Position>,

    /// Event metadata (UI element, application, etc.)
    pub metadata: EventMetadata,
}

/// Represents clipboard actions
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ClipboardAction {
    Copy,
    Cut,
    Paste,
    Clear,
}

/// Represents a clipboard event
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipboardEvent {
    /// The clipboard action
    pub action: ClipboardAction,

    /// The content that was copied/cut/pasted (truncated if too long)
    #[serde(skip_serializing_if = "is_empty_string")]
    pub content: Option<String>,

    /// The size of the content in bytes
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_size: Option<usize>,

    /// The format of the clipboard data
    #[serde(skip_serializing_if = "is_empty_string")]
    pub format: Option<String>,

    /// Whether the content was truncated due to size
    pub truncated: bool,

    /// Event metadata (UI element, application, etc.)
    pub metadata: EventMetadata,
}

/// Represents text selection events
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextSelectionEvent {
    /// The selected text content
    pub selected_text: String,

    /// The start position of the selection (screen coordinates)
    pub start_position: Position,

    /// The end position of the selection (screen coordinates)
    pub end_position: Position,

    /// The selection method (mouse drag, keyboard shortcuts, etc.)
    pub selection_method: SelectionMethod,

    /// The length of the selection in characters
    pub selection_length: usize,

    /// Event metadata (UI element, application, etc.)
    pub metadata: EventMetadata,
}

/// Represents how text was selected
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SelectionMethod {
    MouseDrag,
    DoubleClick,      // Word selection
    TripleClick,      // Line/paragraph selection
    KeyboardShortcut, // Ctrl+A, Shift+arrows, etc.
    ContextMenu,
}

/// Represents drag and drop operations
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DragDropEvent {
    /// The start position of the drag
    pub start_position: Position,

    /// The end position of the drop
    pub end_position: Position,

    /// The UI element being dragged (source)
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_optional_ui_element"
    )]
    pub source_element: Option<UIElement>,

    /// The type of data being dragged
    #[serde(skip_serializing_if = "is_empty_string")]
    pub data_type: Option<String>,

    /// The dragged content (if text)
    #[serde(skip_serializing_if = "is_empty_string")]
    pub content: Option<String>,

    /// Whether the drag was successful
    pub success: bool,

    /// Event metadata (target UI element, application, etc.)
    pub metadata: EventMetadata,
}

/// Represents hotkey/shortcut events
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HotkeyEvent {
    /// The key combination (e.g., "Ctrl+C", "Alt+Tab")
    pub combination: String,

    /// The action performed by the hotkey
    #[serde(skip_serializing_if = "is_empty_string")]
    pub action: Option<String>,

    /// Whether this was a global or application-specific hotkey
    pub is_global: bool,

    /// Process executable name (e.g., "chrome.exe", "Notepad.exe")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_name: Option<String>,

    /// Event metadata (UI element, application, etc.)
    pub metadata: EventMetadata,
}

/// Represents the type of button interaction
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ButtonInteractionType {
    /// Simple button click
    Click,
    /// Toggle button (on/off)
    Toggle,
    /// Dropdown button expand/collapse
    DropdownToggle,
    /// Submit button
    Submit,
    /// Cancel/close button
    Cancel,
}

/// Type of pending action being processed
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum PendingActionType {
    /// A click action is being processed
    Click,
    /// A keyboard action is being processed
    Keyboard,
    /// A hotkey action is being processed
    Hotkey,
}

/// Represents a pending action that is being processed
/// Emitted immediately when an action is detected, before UI element capture completes
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingActionEvent {
    /// The type of action being processed
    pub action_type: PendingActionType,

    /// The position where the action occurred (for clicks)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<Position>,

    /// Which mouse button was used (for clicks)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub button: Option<MouseButton>,

    /// Event metadata
    pub metadata: EventMetadata,
}

/// Represents a high-level button click event
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClickEvent {
    /// The text/label of the clicked element
    pub element_text: String,

    /// The type of click interaction
    pub interaction_type: ButtonInteractionType,

    /// The role/type of the clicked element
    pub element_role: String,

    /// Whether the element was enabled when clicked
    pub was_enabled: bool,

    /// The position where the element was clicked
    #[serde(skip_serializing_if = "Option::is_none")]
    pub click_position: Option<Position>,

    /// Additional context about the element's function
    #[serde(skip_serializing_if = "is_empty_string")]
    pub element_description: Option<String>,

    /// Text content from all child elements (unlimited depth traversal)
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub child_text_content: Vec<String>,

    /// Relative position within the element (0.0-1.0 for x and y)
    /// Useful for clicking within large elements like table rows
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relative_position: Option<(f32, f32)>,

    /// Process executable name (e.g., "chrome.exe", "Notepad.exe")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_name: Option<String>,

    /// Page URL if click occurred in a browser window
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_url: Option<String>,

    /// Event metadata with UI element context
    pub metadata: EventMetadata,
}

/// Browser-specific click event with DOM information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserClickEvent {
    /// UI automation element info (Windows UI tree)
    #[serde(default, deserialize_with = "deserialize_optional_ui_element")]
    pub ui_element: Option<UIElement>,

    /// DOM element information from browser
    pub dom_element: Option<DomElementInfo>,

    /// Click position in screen coordinates
    pub position: Position,

    /// Best selector candidates for this element
    pub selectors: Vec<SelectorCandidate>,

    /// Page URL at time of click
    pub page_url: String,

    /// Page title at time of click
    pub page_title: String,

    /// Timestamp of the event
    pub timestamp: u64,

    /// Mouse button used
    pub button: MouseButton,

    /// Whether this was a double-click
    pub is_double_click: bool,

    /// Event metadata
    pub metadata: EventMetadata,
}

/// DOM element information captured from browser
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomElementInfo {
    pub tag_name: String,
    pub id: Option<String>,
    pub class_names: Vec<String>,
    pub css_selector: String,
    pub xpath: String,
    pub inner_text: Option<String>,
    pub input_value: Option<String>,
    pub is_visible: bool,
    pub is_interactive: bool,
    pub aria_label: Option<String>,
    pub selector_candidates: Vec<SelectorCandidate>,
}

/// Selector candidate for DOM element
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SelectorCandidate {
    pub selector: String,
    pub selector_type: String,
    pub specificity: u32,
    pub requires_jquery: bool,
}

/// Browser text input event with DOM context
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserTextInputEvent {
    /// DOM element being typed into
    pub dom_element: Option<DomElementInfo>,

    /// Text that was typed
    pub text: String,

    /// Selector used to identify element
    pub selector: String,

    /// Whether text was pasted vs typed
    pub was_pasted: bool,

    /// Page context
    pub page_url: String,
    pub page_title: String,

    /// Timestamp
    pub timestamp: u64,

    /// Event metadata
    pub metadata: EventMetadata,
}

/// Represents a workflow event
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum WorkflowEvent {
    /// A mouse event
    Mouse(MouseEvent),

    /// A keyboard event
    Keyboard(KeyboardEvent),

    /// A clipboard event
    Clipboard(ClipboardEvent),

    /// A text selection event
    TextSelection(TextSelectionEvent),

    /// A drag and drop event
    DragDrop(DragDropEvent),

    /// A hotkey event
    Hotkey(HotkeyEvent),

    /// High-level text input completion event
    TextInputCompleted(TextInputCompletedEvent),

    /// High-level application switch event
    ApplicationSwitch(ApplicationSwitchEvent),

    /// High-level browser tab navigation event
    BrowserTabNavigation(BrowserTabNavigationEvent),

    /// High-level click event
    Click(ClickEvent),

    /// Browser-specific click event with DOM information
    BrowserClick(BrowserClickEvent),

    /// Browser text input event
    BrowserTextInput(BrowserTextInputEvent),

    /// File opened event (detected via window title and file system search)
    FileOpened(FileOpenedEvent),

    /// Pending action event - emitted immediately before UI capture completes
    PendingAction(PendingActionEvent),
}

impl WorkflowEvent {
    /// Returns a reference to the metadata of the event.
    pub fn metadata(&self) -> &EventMetadata {
        match self {
            WorkflowEvent::Mouse(e) => &e.metadata,
            WorkflowEvent::Keyboard(e) => &e.metadata,
            WorkflowEvent::Clipboard(e) => &e.metadata,
            WorkflowEvent::TextSelection(e) => &e.metadata,
            WorkflowEvent::DragDrop(e) => &e.metadata,
            WorkflowEvent::Hotkey(e) => &e.metadata,
            WorkflowEvent::TextInputCompleted(e) => &e.metadata,
            WorkflowEvent::ApplicationSwitch(e) => &e.metadata,
            WorkflowEvent::BrowserTabNavigation(e) => &e.metadata,
            WorkflowEvent::Click(e) => &e.metadata,
            WorkflowEvent::BrowserClick(e) => &e.metadata,
            WorkflowEvent::BrowserTextInput(e) => &e.metadata,
            WorkflowEvent::FileOpened(e) => &e.metadata,
            WorkflowEvent::PendingAction(e) => &e.metadata,
        }
    }

    /// Returns a mutable reference to the metadata of the event.
    pub fn metadata_mut(&mut self) -> &mut EventMetadata {
        match self {
            WorkflowEvent::Mouse(e) => &mut e.metadata,
            WorkflowEvent::Keyboard(e) => &mut e.metadata,
            WorkflowEvent::Clipboard(e) => &mut e.metadata,
            WorkflowEvent::TextSelection(e) => &mut e.metadata,
            WorkflowEvent::DragDrop(e) => &mut e.metadata,
            WorkflowEvent::Hotkey(e) => &mut e.metadata,
            WorkflowEvent::TextInputCompleted(e) => &mut e.metadata,
            WorkflowEvent::ApplicationSwitch(e) => &mut e.metadata,
            WorkflowEvent::BrowserTabNavigation(e) => &mut e.metadata,
            WorkflowEvent::Click(e) => &mut e.metadata,
            WorkflowEvent::BrowserClick(e) => &mut e.metadata,
            WorkflowEvent::BrowserTextInput(e) => &mut e.metadata,
            WorkflowEvent::FileOpened(e) => &mut e.metadata,
            WorkflowEvent::PendingAction(e) => &mut e.metadata,
        }
    }

    /// Returns the timestamp of the event, if available.
    pub fn timestamp(&self) -> Option<u64> {
        self.metadata().timestamp
    }

    /// Returns a reference to the UI element of the event, if available.
    pub fn ui_element(&self) -> Option<&UIElement> {
        self.metadata().ui_element.as_ref()
    }
}

/// Represents an MCP tool step for execution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolStep {
    /// The name of the MCP tool to call
    pub tool_name: String,
    /// Arguments to pass to the tool
    pub arguments: serde_json::Value,
    /// Human-readable description of this step
    pub description: String,
    /// Optional timeout for this step in milliseconds
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    /// Whether to continue execution if this step fails
    #[serde(skip_serializing_if = "Option::is_none")]
    pub continue_on_error: Option<bool>,
    /// Delay after this step in milliseconds
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delay_ms: Option<u64>,
    /// Expected UI changes after this action (diff between before/after UI trees)
    /// Used for validation during workflow playback
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_ui_changes: Option<String>,
    /// Expected DOM changes after this action (diff between before/after HTML DOM)
    /// Only populated for browser events
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_dom_changes: Option<String>,
}

/// Represents the interaction context for UI element analysis
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InteractionContext {
    /// Type of interaction performed (e.g., "simple_click", "dropdown_selection")
    pub interaction_type: String,
    /// UI pattern detected (e.g., "button", "dropdown", "menu", "autocomplete")
    pub ui_pattern: String,
    /// UI state before the interaction
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_before: Option<String>,
    /// UI state after the interaction
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_after: Option<String>,
    /// Related UI elements involved in the interaction
    pub related_elements: Vec<UIElementInfo>,
}

/// Simplified UI element info for interaction context
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UIElementInfo {
    /// Element role
    pub role: String,
    /// Element name/label
    #[serde(skip_serializing_if = "is_empty_string")]
    pub name: Option<String>,
    /// Element bounds [x, y, width, height]
    pub bounds: [f64; 4],
    /// Generated selectors for this element
    pub suggested_selectors: Vec<String>,
}

impl UIElementInfo {
    /// Create UIElementInfo from a UIElement
    pub fn from_element(element: &UIElement) -> Self {
        let role = element.role();
        let name = element.name();
        let bounds = element
            .bounds()
            .map(|(x, y, w, h)| [x, y, w, h])
            .unwrap_or([0.0, 0.0, 0.0, 0.0]);

        // Generate basic selector for this parent element
        let selector = match &name {
            Some(n) if !n.is_empty() => format!("role:{role} && text:{n}"),
            _ => format!("role:{role}"),
        };

        Self {
            role,
            name,
            bounds,
            suggested_selectors: vec![selector],
        }
    }
}

/// Build parent hierarchy for a UI element by walking up the tree
/// Returns a Vec of UIElementInfo from root (window) down to immediate parent (reversed order)
///
/// IMPORTANT: Stops at the application window boundary to ensure selectors stay within
/// the target process scope. This prevents selectors from including elements outside
/// the application (like desktop/taskbar elements).
pub fn build_parent_hierarchy(element: &UIElement) -> Vec<UIElementInfo> {
    let mut hierarchy = Vec::new();
    let mut current = element.parent().ok().flatten();

    // Get the target element's process_id to ensure we stay within the same process
    let target_process_id = element.process_id().ok();

    // Walk up the parent chain, collecting up to 10 NAMED parents to avoid infinite loops
    let max_depth = 10;
    while let Some(parent) = current {
        // Check if we've crossed a process boundary (exited the target app's UI tree)
        if let Some(target_pid) = target_process_id {
            if let Ok(parent_pid) = parent.process_id() {
                if parent_pid != target_pid {
                    // We've exited the target application's UI tree - stop here
                    tracing::debug!(
                        "Stopping parent hierarchy at process boundary: target_pid={}, parent_pid={}",
                        target_pid, parent_pid
                    );
                    break;
                }
            }
        }

        let parent_role = parent.role();
        let parent_info = UIElementInfo::from_element(&parent);

        // Only include parents with meaningful names (skip unnamed elements like generic Panes/Groups)
        let has_name = parent_info
            .name
            .as_ref()
            .map(|n| !n.is_empty())
            .unwrap_or(false);
        let is_window = parent_role == "Window";

        // Skip internal browser/app implementation details that shouldn't be in selectors
        // These are container elements that don't provide semantic value for locating UI elements
        let is_internal_element = parent_info
            .name
            .as_ref()
            .map(|n| {
                let lower = n.to_lowercase();
                // Browser internal elements
                lower.contains("legacy window")
                || lower.contains("chrome_widgetwin")
                || lower.contains("intermediate d3d window")
                // Panes that just mirror the Window title (redundant after process: selector)
                || (parent_role == "Pane" && (
                    lower.ends_with(" - google chrome")
                    || lower.ends_with(" - mozilla firefox")
                    || lower.ends_with(" - microsoft edge")
                ))
                // Skip elements with relative timestamps (dynamic, will break selectors)
                || contains_relative_time(&lower)
            })
            .unwrap_or(false);

        if has_name && !is_internal_element {
            let name_for_log = parent_info.name.clone();
            hierarchy.push(parent_info);

            // If we hit a Window role, this is likely the application's main window
            // Include it but stop going further up (don't include desktop/taskbar)
            if is_window {
                tracing::debug!(
                    "Stopping parent hierarchy at Window role: {:?}",
                    name_for_log
                );
                break;
            }

            if hierarchy.len() >= max_depth {
                break;
            }
        }

        // Move to next parent (continue walking up even if we skipped this one)
        current = parent.parent().ok().flatten();
    }

    // Reverse so root is first, immediate parent is last
    hierarchy.reverse();
    hierarchy
}

/// Build chained selector from parent hierarchy and target element
/// Returns selector like: role:Pane >> role:Button && text:Submit
/// Uses only named parents (unnamed parents are already filtered by build_parent_hierarchy)
/// Note: Skips the first Window element since process:app.exe already targets that window
pub fn build_chained_selector(
    parent_hierarchy: &[UIElementInfo],
    target_element: &UIElement,
) -> Option<String> {
    if parent_hierarchy.is_empty() {
        return None;
    }

    let mut path_parts = Vec::new();

    // Add each parent in the hierarchy chain
    // Skip the first Window element since process:app.exe already targets that window
    // The >> operator searches within children, so we don't want to search for the Window again
    for (i, parent) in parent_hierarchy.iter().enumerate() {
        // Skip the first element if it's a Window (since process: selector already returns it)
        if i == 0 && parent.role == "Window" {
            tracing::debug!(
                "Skipping first Window element in chain (process: selector already targets it): {:?}",
                parent.name
            );
            continue;
        }

        let selector = if let Some(ref name) = parent.name {
            if !name.is_empty() {
                // text: does case-sensitive substring matching by default
                format!("role:{} && text:{}", parent.role, name)
            } else {
                format!("role:{}", parent.role)
            }
        } else {
            format!("role:{}", parent.role)
        };
        path_parts.push(selector);
    }

    // Add the target element itself
    let target_role = target_element.role();
    let target_name = target_element.name().unwrap_or_default();

    let target_selector = if !target_name.is_empty() {
        format!("role:{target_role} && text:{target_name}")
    } else {
        format!("role:{target_role}")
    };
    path_parts.push(target_selector);

    // Join with >> operator for full path
    Some(path_parts.join(" >> "))
}

/// Enhanced UI element capture with MCP context
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnhancedUIElement {
    /// Original UI element data
    pub ui_element: UIElement,
    /// Generated selector options for MCP tools
    pub suggested_selectors: Vec<String>,
    /// Chained selector from parent hierarchy to target element (e.g., "role:Window && text:Chrome >> role:Pane >> role:Button && text:Submit")
    pub chained_selector: Option<String>,
    /// Interaction context analysis
    pub interaction_context: InteractionContext,
}

/// Represents a recorded event with timestamp and MCP conversion
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordedEvent {
    /// The timestamp of the event (milliseconds since epoch)
    pub timestamp: u64,

    /// The original workflow event
    pub event: WorkflowEvent,

    /// Optional metadata for the event
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<EventMetadata>,
}

/// Represents a recorded workflow
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordedWorkflow {
    /// The name of the workflow
    pub name: String,

    /// The timestamp when the recording started
    pub start_time: u64,

    /// The timestamp when the recording ended
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_time: Option<u64>,

    /// The recorded events
    pub events: Vec<RecordedEvent>,
}

impl RecordedWorkflow {
    /// Create a new recorded workflow
    pub fn new(name: String) -> Self {
        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        Self {
            name,
            start_time: now,
            end_time: None,
            events: Vec::new(),
        }
    }

    /// Add an event to the workflow
    pub fn add_event(&mut self, event: WorkflowEvent) {
        // Use the event's timestamp if available in its metadata, otherwise generate current timestamp
        let timestamp = event.timestamp().unwrap_or_else(|| {
            // Fallback: generate timestamp now if not present in event metadata
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64
        });

        self.events.push(RecordedEvent {
            timestamp,
            event,
            metadata: None,
        });
    }

    /// Add an enhanced event with MCP conversion data to the workflow
    pub fn add_enhanced_event(&mut self, recorded_event: RecordedEvent) {
        self.events.push(recorded_event);
    }

    /// Finish the recording
    pub fn finish(&mut self) {
        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        self.end_time = Some(now);
    }

    /// Serialize the workflow to JSON string
    /// This converts UIElement instances to serializable form
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        let serializable: SerializableRecordedWorkflow = self.into();
        serde_json::to_string_pretty(&serializable)
    }

    /// Serialize the workflow to JSON bytes
    /// This converts UIElement instances to serializable form
    pub fn to_json_bytes(&self) -> Result<Vec<u8>, serde_json::Error> {
        let serializable: SerializableRecordedWorkflow = self.into();
        serde_json::to_vec_pretty(&serializable)
    }

    /// Deserialize a workflow from JSON string
    /// Note: This creates a workflow with serializable UI elements,
    /// not the original UIElement instances
    pub fn from_json(json: &str) -> Result<SerializableRecordedWorkflow, serde_json::Error> {
        serde_json::from_str(json)
    }

    /// Deserialize a workflow from JSON bytes
    /// Note: This creates a workflow with serializable UI elements,
    /// not the original UIElement instances
    pub fn from_json_bytes(
        bytes: &[u8],
    ) -> Result<SerializableRecordedWorkflow, serde_json::Error> {
        serde_json::from_slice(bytes)
    }

    /// Save the workflow to a JSON file
    pub fn save_to_file<P: AsRef<std::path::Path>>(
        &self,
        path: P,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let json = self.to_json()?;
        std::fs::write(path, json)?;
        Ok(())
    }

    /// Load a workflow from a JSON file
    /// Note: This creates a workflow with serializable UI elements,
    /// not the original UIElement instances
    pub fn load_from_file<P: AsRef<std::path::Path>>(
        path: P,
    ) -> Result<SerializableRecordedWorkflow, Box<dyn std::error::Error>> {
        let json = std::fs::read_to_string(path)?;
        let workflow = Self::from_json(&json)?;
        Ok(workflow)
    }
}

/// Method used to input text
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum TextInputMethod {
    /// Text was typed character by character
    Typed,
    /// Text was likely pasted (large amount added quickly)
    Pasted,
    /// Text was likely auto-filled or auto-completed
    AutoFilled,
    /// Text was selected from autocomplete/suggestion dropdown
    Suggestion,
    /// Mixed input methods
    Mixed,
}

/// How a text field received focus before input
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub enum FieldFocusMethod {
    /// User clicked the field with mouse
    MouseClick,
    /// User navigated via keyboard (Tab/Arrow keys)
    KeyboardNav,
    /// Field was focused programmatically (JS/application)
    Programmatic,
    /// Unknown or field was already focused when recording started
    #[default]
    Unknown,
}

/// High-level text input completion event
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextInputCompletedEvent {
    /// The text that was entered in the field
    pub text_value: String,
    /// The name/label of the input field
    #[serde(skip_serializing_if = "is_empty_string")]
    pub field_name: Option<String>,
    /// The type of input field (e.g., "TextBox", "PasswordBox", "SearchBox")
    pub field_type: String,
    /// Whether the text was likely typed vs pasted/auto-filled
    pub input_method: TextInputMethod,
    /// How the field received focus before input
    #[serde(default = "FieldFocusMethod::default")]
    pub focus_method: FieldFocusMethod,
    /// Duration of the typing session in milliseconds
    pub typing_duration_ms: u64,
    /// Number of individual keystroke events that contributed to this input
    pub keystroke_count: u32,
    /// Process executable name (e.g., "chrome.exe", "Notepad.exe")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_name: Option<String>,
    /// Event metadata with UI element context
    pub metadata: EventMetadata,
}

/// Method used to switch applications
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ApplicationSwitchMethod {
    /// Alt+Tab keyboard shortcut
    AltTab,
    /// Clicking on taskbar icon
    TaskbarClick,
    /// Windows key + number shortcut
    WindowsKeyShortcut,
    /// Start menu or app launcher
    StartMenu,
    /// Direct window click
    WindowClick,
    /// Other/unknown method
    Other,
}

/// High-level application switch event
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApplicationSwitchEvent {
    /// Window and application name being switched from (as reported by Windows UI Automation).
    /// Format varies by application: may contain page/document title + app name, or just app name.
    /// Examples: "GitHub - Google Chrome", "Settings", "*hi there - Notepad"
    #[serde(skip_serializing_if = "is_empty_string")]
    pub from_window_and_application_name: Option<String>,
    /// Window and application name being switched to (as reported by Windows UI Automation).
    /// Format varies by application: may contain page/document title + app name, or just app name.
    pub to_window_and_application_name: String,
    /// Process executable name being switched from (e.g., "chrome.exe", "Notepad.exe")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_process_name: Option<String>,
    /// Process executable name being switched to (e.g., "chrome.exe", "Notepad.exe")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_process_name: Option<String>,
    /// Process ID of the source application
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_process_id: Option<u32>,
    /// Process ID of the target application
    pub to_process_id: u32,
    /// Method used to switch applications
    pub switch_method: ApplicationSwitchMethod,
    /// Time spent in the previous application (milliseconds)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dwell_time_ms: Option<u64>,
    /// Number of rapid application switches (Alt+Tab cycling)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub switch_count: Option<u32>,
    /// Event metadata
    pub metadata: EventMetadata,
}

/// Browser tab navigation action type
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum TabAction {
    /// New tab created
    Created,
    /// Switched to existing tab
    Switched,
    /// Tab closed
    Closed,
    /// Tab moved/reordered
    Moved,
    /// Tab duplicated
    Duplicated,
    /// Tab pinned/unpinned
    Pinned,
    /// Tab refreshed/reloaded
    Refreshed,
}

/// Method used for tab navigation
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum TabNavigationMethod {
    /// Keyboard shortcut (Ctrl+T, Ctrl+W, Ctrl+Tab, etc.)
    KeyboardShortcut,
    /// Mouse click on tab
    TabClick,
    /// Mouse click on new tab button
    NewTabButton,
    /// Mouse click on close button
    CloseButton,
    /// Context menu action
    ContextMenu,
    /// Address bar navigation
    AddressBar,
    /// Link click that opens in new tab
    LinkNewTab,
    /// Other/unknown method
    Other,
}

/// High-level browser tab navigation event
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserTabNavigationEvent {
    /// The action performed on the tab
    pub action: TabAction,
    /// Method used for the navigation
    pub method: TabNavigationMethod,
    /// URL being navigated TO (destination URL)
    #[serde(skip_serializing_if = "is_empty_string")]
    pub to_url: Option<String>,
    /// URL being navigated FROM (source URL)
    #[serde(skip_serializing_if = "is_empty_string")]
    pub from_url: Option<String>,
    /// Title of the page being navigated TO (destination title)
    #[serde(skip_serializing_if = "is_empty_string")]
    pub to_title: Option<String>,
    /// Title of the page being navigated FROM (source title)
    #[serde(skip_serializing_if = "is_empty_string")]
    pub from_title: Option<String>,
    /// Browser application (Chrome, Firefox, Edge, etc.)
    pub browser: String,
    /// Current tab index in the window
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_index: Option<u32>,
    /// Total number of tabs in the window
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_tabs: Option<u32>,
    /// Time spent on previous URL (for navigation events)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_dwell_time_ms: Option<u64>,
    /// Whether this was a back/forward navigation
    pub is_back_forward: bool,
    /// Event metadata
    pub metadata: EventMetadata,
}

/// Confidence level for file path resolution
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum FilePathConfidence {
    /// High confidence - only one file found with this name
    High,
    /// Medium confidence - multiple files found, but clear most recent access time
    Medium,
    /// Low confidence - multiple files with ambiguous access times
    Low,
}

/// Represents a candidate file path with its metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileCandidatePath {
    /// Full path to the file
    pub path: String,
    /// When the file was last accessed (ISO 8601 format)
    pub last_accessed: String,
    /// When the file was last modified (ISO 8601 format)
    pub last_modified: String,
    /// File size in bytes
    pub size_bytes: u64,
}

/// File opened event detected via window title parsing and file system search
/// Captures when a file is opened from Explorer or other applications
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileOpenedEvent {
    /// File name extracted from window title (e.g., "todolist-backup.txt")
    pub filename: String,

    /// Most likely file path (highest confidence based on LastAccessTime)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_path: Option<String>,

    /// All candidate file paths found with this filename, sorted by most recently accessed
    pub candidate_paths: Vec<FileCandidatePath>,

    /// Confidence level in the primary_path selection
    pub confidence: FilePathConfidence,

    /// Name of the application that opened the file (e.g., "Notepad")
    pub application_name: String,

    /// Process ID of the application
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_id: Option<u32>,

    /// Process executable name (e.g., "notepad.exe")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_name: Option<String>,

    /// Time taken to search for file paths in milliseconds
    pub search_time_ms: f64,

    /// File extension (e.g., "txt", "xlsx", "pdf")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_extension: Option<String>,

    /// Full window title from which filename was extracted
    pub window_title: String,

    /// Event metadata
    pub metadata: EventMetadata,
}

/// Helper type for deserializing Option<UIElement> with error tolerance
#[derive(Debug, Clone, Default)]
struct OptionalUIElement(Option<UIElement>);

impl<'de> Deserialize<'de> for OptionalUIElement {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        // First try to deserialize as Option<serde_json::Value>
        let value: Option<serde_json::Value> = Option::deserialize(deserializer)?;

        match value {
            None => Ok(OptionalUIElement(None)),
            Some(json_value) => {
                // Try to deserialize the UIElement from the JSON value
                match serde_json::from_value::<UIElement>(json_value.clone()) {
                    Ok(element) => Ok(OptionalUIElement(Some(element))),
                    Err(e) => {
                        // Log the error but return None instead of failing
                        tracing::debug!(
                            "UIElement deserialization failed (likely in async context): {}. \
                            Continuing with None. Raw data: {:?}",
                            e,
                            json_value
                        );
                        Ok(OptionalUIElement(None))
                    }
                }
            }
        }
    }
}

/// Custom deserializer for Option<UIElement> that returns None on deserialization errors
fn deserialize_optional_ui_element<'de, D>(deserializer: D) -> Result<Option<UIElement>, D::Error>
where
    D: Deserializer<'de>,
{
    let optional = OptionalUIElement::deserialize(deserializer)?;
    Ok(optional.0)
}

/// Unified metadata for all workflow events
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventMetadata {
    /// The UI element associated with this event (if available)
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        deserialize_with = "deserialize_optional_ui_element"
    )]
    pub ui_element: Option<UIElement>,

    /// The exact timestamp when this event occurred (milliseconds since epoch)
    /// If None, the timestamp will be generated when the event is recorded
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<u64>,
}

// implement empty() constructor
impl EventMetadata {
    pub fn empty() -> Self {
        Self {
            ui_element: None,
            timestamp: None,
        }
    }

    /// Create EventMetadata with current timestamp
    pub fn with_timestamp() -> Self {
        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        Self {
            ui_element: None,
            timestamp: Some(now),
        }
    }

    /// Create EventMetadata with UI element and current timestamp
    pub fn with_ui_element_and_timestamp(ui_element: Option<UIElement>) -> Self {
        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        Self {
            ui_element,
            timestamp: Some(now),
        }
    }
}

/// Serializable version of UIElement for JSON export
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerializableUIElement {
    #[serde(skip_serializing_if = "is_empty_string")]
    pub id: Option<String>,
    pub role: String,
    #[serde(skip_serializing_if = "is_empty_string")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<(f64, f64, f64, f64)>,
    #[serde(skip_serializing_if = "is_empty_string")]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "is_empty_string")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "is_empty_string")]
    pub application: Option<String>,
    #[serde(skip_serializing_if = "is_empty_string")]
    pub window_title: Option<String>,
    #[serde(skip_serializing_if = "is_empty_string")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_id: Option<u32>,
}

impl From<&UIElement> for SerializableUIElement {
    fn from(element: &UIElement) -> Self {
        let attrs = element.attributes();
        let bounds = element.bounds().ok();

        // Helper function to filter empty strings
        fn filter_empty(s: Option<String>) -> Option<String> {
            s.filter(|s| !s.is_empty())
        }

        Self {
            id: filter_empty(element.id()),
            role: element.role(),
            name: filter_empty(attrs.name),
            bounds,
            value: filter_empty(attrs.value),
            description: filter_empty(attrs.description),
            application: filter_empty(Some(element.application_name())),
            window_title: filter_empty(Some(element.window_title())),
            url: element.url(),
            process_id: element.process_id().ok(),
        }
    }
}

/// Serializable version of EventMetadata for JSON export
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerializableEventMetadata {
    /// The UI element associated with this event (if available)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ui_element: Option<SerializableUIElement>,

    /// The exact timestamp when this event occurred (milliseconds since epoch)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<u64>,
}

impl From<&EventMetadata> for SerializableEventMetadata {
    fn from(metadata: &EventMetadata) -> Self {
        Self {
            ui_element: metadata.ui_element.as_ref().map(|elem| elem.into()),
            timestamp: metadata.timestamp,
        }
    }
}

/// Serializable version of KeyboardEvent for JSON export
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerializableKeyboardEvent {
    pub key_code: u32,
    pub is_key_down: bool,
    pub ctrl_pressed: bool,
    pub alt_pressed: bool,
    pub shift_pressed: bool,
    pub win_pressed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub character: Option<char>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scan_code: Option<u32>,
    pub metadata: SerializableEventMetadata,
}

impl From<&KeyboardEvent> for SerializableKeyboardEvent {
    fn from(event: &KeyboardEvent) -> Self {
        Self {
            key_code: event.key_code,
            is_key_down: event.is_key_down,
            ctrl_pressed: event.ctrl_pressed,
            alt_pressed: event.alt_pressed,
            shift_pressed: event.shift_pressed,
            win_pressed: event.win_pressed,
            character: event.character,
            scan_code: event.scan_code,
            metadata: (&event.metadata).into(),
        }
    }
}

/// Serializable version of MouseEvent for JSON export
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerializableMouseEvent {
    pub event_type: MouseEventType,
    pub button: MouseButton,
    pub position: Position,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scroll_delta: Option<(i32, i32)>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drag_start: Option<Position>,
    pub metadata: SerializableEventMetadata,
}

impl From<&MouseEvent> for SerializableMouseEvent {
    fn from(event: &MouseEvent) -> Self {
        Self {
            event_type: event.event_type,
            button: event.button,
            position: event.position,
            scroll_delta: event.scroll_delta,
            drag_start: event.drag_start,
            metadata: (&event.metadata).into(),
        }
    }
}

/// Serializable version of ClipboardEvent for JSON export
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerializableClipboardEvent {
    pub action: ClipboardAction,
    #[serde(skip_serializing_if = "is_empty_string")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_size: Option<usize>,
    #[serde(skip_serializing_if = "is_empty_string")]
    pub format: Option<String>,
    pub truncated: bool,
    pub metadata: SerializableEventMetadata,
}

impl From<&ClipboardEvent> for SerializableClipboardEvent {
    fn from(event: &ClipboardEvent) -> Self {
        Self {
            action: event.action.clone(),
            content: event.content.clone(),
            content_size: event.content_size,
            format: event.format.clone(),
            truncated: event.truncated,
            metadata: (&event.metadata).into(),
        }
    }
}

/// Serializable version of TextSelectionEvent for JSON export
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerializableTextSelectionEvent {
    pub selected_text: String,
    pub start_position: Position,
    pub end_position: Position,
    pub selection_method: SelectionMethod,
    pub selection_length: usize,
    pub metadata: SerializableEventMetadata,
}

impl From<&TextSelectionEvent> for SerializableTextSelectionEvent {
    fn from(event: &TextSelectionEvent) -> Self {
        Self {
            selected_text: event.selected_text.clone(),
            start_position: event.start_position,
            end_position: event.end_position,
            selection_method: event.selection_method.clone(),
            selection_length: event.selection_length,
            metadata: (&event.metadata).into(),
        }
    }
}

/// Serializable version of DragDropEvent for JSON export
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerializableDragDropEvent {
    pub start_position: Position,
    pub end_position: Position,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_element: Option<SerializableUIElement>,
    #[serde(skip_serializing_if = "is_empty_string")]
    pub data_type: Option<String>,
    #[serde(skip_serializing_if = "is_empty_string")]
    pub content: Option<String>,
    pub success: bool,
    pub metadata: SerializableEventMetadata,
}

impl From<&DragDropEvent> for SerializableDragDropEvent {
    fn from(event: &DragDropEvent) -> Self {
        Self {
            start_position: event.start_position,
            end_position: event.end_position,
            source_element: event.source_element.as_ref().map(|elem| elem.into()),
            data_type: event.data_type.clone(),
            content: event.content.clone(),
            success: event.success,
            metadata: (&event.metadata).into(),
        }
    }
}

/// Serializable version of HotkeyEvent for JSON export
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerializableHotkeyEvent {
    pub combination: String,
    #[serde(skip_serializing_if = "is_empty_string")]
    pub action: Option<String>,
    pub is_global: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_name: Option<String>,
    pub metadata: SerializableEventMetadata,
}

impl From<&HotkeyEvent> for SerializableHotkeyEvent {
    fn from(event: &HotkeyEvent) -> Self {
        Self {
            combination: event.combination.clone(),
            action: event.action.clone(),
            is_global: event.is_global,
            process_name: event.process_name.clone(),
            metadata: (&event.metadata).into(),
        }
    }
}

/// Serializable version of TextInputCompletedEvent for JSON export
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerializableTextInputCompletedEvent {
    pub text_value: String,
    #[serde(skip_serializing_if = "is_empty_string")]
    pub field_name: Option<String>,
    pub field_type: String,
    pub input_method: TextInputMethod,
    pub focus_method: FieldFocusMethod,
    pub typing_duration_ms: u64,
    pub keystroke_count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_name: Option<String>,
    pub metadata: SerializableEventMetadata,
}

impl From<&TextInputCompletedEvent> for SerializableTextInputCompletedEvent {
    fn from(event: &TextInputCompletedEvent) -> Self {
        Self {
            text_value: event.text_value.clone(),
            field_name: event.field_name.clone(),
            field_type: event.field_type.clone(),
            input_method: event.input_method.clone(),
            focus_method: event.focus_method.clone(),
            typing_duration_ms: event.typing_duration_ms,
            keystroke_count: event.keystroke_count,
            process_name: event.process_name.clone(),
            metadata: (&event.metadata).into(),
        }
    }
}

/// Serializable version of ApplicationSwitchEvent for JSON export
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerializableApplicationSwitchEvent {
    #[serde(skip_serializing_if = "is_empty_string")]
    pub from_window_and_application_name: Option<String>,
    pub to_window_and_application_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_process_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_process_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_process_id: Option<u32>,
    pub to_process_id: u32,
    pub switch_method: ApplicationSwitchMethod,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dwell_time_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub switch_count: Option<u32>,
    pub metadata: SerializableEventMetadata,
}

impl From<&ApplicationSwitchEvent> for SerializableApplicationSwitchEvent {
    fn from(event: &ApplicationSwitchEvent) -> Self {
        Self {
            from_window_and_application_name: event.from_window_and_application_name.clone(),
            to_window_and_application_name: event.to_window_and_application_name.clone(),
            from_process_name: event.from_process_name.clone(),
            to_process_name: event.to_process_name.clone(),
            from_process_id: event.from_process_id,
            to_process_id: event.to_process_id,
            switch_method: event.switch_method.clone(),
            dwell_time_ms: event.dwell_time_ms,
            switch_count: event.switch_count,
            metadata: (&event.metadata).into(),
        }
    }
}

/// Serializable version of BrowserTabNavigationEvent for JSON export
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerializableBrowserTabNavigationEvent {
    pub action: TabAction,
    pub method: TabNavigationMethod,
    #[serde(skip_serializing_if = "is_empty_string")]
    pub to_url: Option<String>,
    #[serde(skip_serializing_if = "is_empty_string")]
    pub from_url: Option<String>,
    #[serde(skip_serializing_if = "is_empty_string")]
    pub to_title: Option<String>,
    #[serde(skip_serializing_if = "is_empty_string")]
    pub from_title: Option<String>,
    pub browser: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_tabs: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_dwell_time_ms: Option<u64>,
    pub is_back_forward: bool,
    pub metadata: SerializableEventMetadata,
}

impl From<&BrowserTabNavigationEvent> for SerializableBrowserTabNavigationEvent {
    fn from(event: &BrowserTabNavigationEvent) -> Self {
        Self {
            action: event.action.clone(),
            method: event.method.clone(),
            to_url: event.to_url.clone(),
            from_url: event.from_url.clone(),
            to_title: event.to_title.clone(),
            from_title: event.from_title.clone(),
            browser: event.browser.clone(),
            tab_index: event.tab_index,
            total_tabs: event.total_tabs,
            page_dwell_time_ms: event.page_dwell_time_ms,
            is_back_forward: event.is_back_forward,
            metadata: (&event.metadata).into(),
        }
    }
}

/// Serializable version of ButtonClickEvent for JSON export
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerializableClickEvent {
    pub element_text: String,
    pub interaction_type: ButtonInteractionType,
    pub element_role: String,
    pub was_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub click_position: Option<Position>,
    #[serde(skip_serializing_if = "is_empty_string")]
    pub element_description: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub child_text_content: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relative_position: Option<(f32, f32)>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_url: Option<String>,
    pub metadata: SerializableEventMetadata,
}

impl From<&ClickEvent> for SerializableClickEvent {
    fn from(event: &ClickEvent) -> Self {
        Self {
            element_text: event.element_text.clone(),
            interaction_type: event.interaction_type.clone(),
            element_role: event.element_role.clone(),
            was_enabled: event.was_enabled,
            click_position: event.click_position,
            element_description: event.element_description.clone(),
            child_text_content: event.child_text_content.clone(),
            relative_position: event.relative_position,
            process_name: event.process_name.clone(),
            page_url: event.page_url.clone(),
            metadata: (&event.metadata).into(),
        }
    }
}

/// Serializable version of WorkflowEvent for JSON export
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SerializableWorkflowEvent {
    Mouse(SerializableMouseEvent),
    Keyboard(SerializableKeyboardEvent),
    Clipboard(SerializableClipboardEvent),
    TextSelection(SerializableTextSelectionEvent),
    DragDrop(SerializableDragDropEvent),
    Hotkey(SerializableHotkeyEvent),
    TextInputCompleted(SerializableTextInputCompletedEvent),
    ApplicationSwitch(SerializableApplicationSwitchEvent),
    BrowserTabNavigation(SerializableBrowserTabNavigationEvent),
    Click(SerializableClickEvent),
    BrowserClick(BrowserClickEvent),
    BrowserTextInput(BrowserTextInputEvent),
    FileOpened(FileOpenedEvent),
    PendingAction(PendingActionEvent),
}

impl From<&WorkflowEvent> for SerializableWorkflowEvent {
    fn from(event: &WorkflowEvent) -> Self {
        match event {
            WorkflowEvent::Mouse(e) => SerializableWorkflowEvent::Mouse(e.into()),
            WorkflowEvent::Keyboard(e) => SerializableWorkflowEvent::Keyboard(e.into()),
            WorkflowEvent::Clipboard(e) => SerializableWorkflowEvent::Clipboard(e.into()),
            WorkflowEvent::TextSelection(e) => SerializableWorkflowEvent::TextSelection(e.into()),
            WorkflowEvent::DragDrop(e) => SerializableWorkflowEvent::DragDrop(e.into()),
            WorkflowEvent::Hotkey(e) => SerializableWorkflowEvent::Hotkey(e.into()),
            WorkflowEvent::TextInputCompleted(e) => {
                SerializableWorkflowEvent::TextInputCompleted(e.into())
            }
            WorkflowEvent::ApplicationSwitch(e) => {
                SerializableWorkflowEvent::ApplicationSwitch(e.into())
            }
            WorkflowEvent::BrowserTabNavigation(e) => {
                SerializableWorkflowEvent::BrowserTabNavigation(e.into())
            }
            WorkflowEvent::Click(e) => SerializableWorkflowEvent::Click(e.into()),
            WorkflowEvent::BrowserClick(e) => SerializableWorkflowEvent::BrowserClick(e.clone()),
            WorkflowEvent::BrowserTextInput(e) => {
                SerializableWorkflowEvent::BrowserTextInput(e.clone())
            }
            WorkflowEvent::FileOpened(e) => SerializableWorkflowEvent::FileOpened(e.clone()),
            WorkflowEvent::PendingAction(e) => SerializableWorkflowEvent::PendingAction(e.clone()),
        }
    }
}

/// Serializable version of RecordedEvent for JSON export
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerializableRecordedEvent {
    pub timestamp: u64,
    pub event: SerializableWorkflowEvent,
}

impl From<&RecordedEvent> for SerializableRecordedEvent {
    fn from(event: &RecordedEvent) -> Self {
        Self {
            timestamp: event.timestamp,
            event: (&event.event).into(),
        }
    }
}

/// Serializable version of RecordedWorkflow for JSON export
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerializableRecordedWorkflow {
    pub name: String,
    pub start_time: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_time: Option<u64>,
    pub events: Vec<SerializableRecordedEvent>,
}

impl From<&RecordedWorkflow> for SerializableRecordedWorkflow {
    fn from(workflow: &RecordedWorkflow) -> Self {
        Self {
            name: workflow.name.clone(),
            start_time: workflow.start_time,
            end_time: workflow.end_time,
            events: workflow.events.iter().map(|e| e.into()).collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_empty_string_helper() {
        // Test None values
        assert!(is_empty_string(&None));

        // Test empty strings
        assert!(is_empty_string(&Some("".to_string())));
        assert!(is_empty_string(&Some(" ".to_string())));
        assert!(is_empty_string(&Some("   ".to_string())));
        assert!(is_empty_string(&Some("\t\n".to_string())));

        // Test various null representations that might come from Windows APIs
        assert!(is_empty_string(&Some("null".to_string())));
        assert!(is_empty_string(&Some("NULL".to_string())));
        assert!(is_empty_string(&Some("Null".to_string())));
        assert!(is_empty_string(&Some("nil".to_string())));
        assert!(is_empty_string(&Some("NIL".to_string())));
        assert!(is_empty_string(&Some("undefined".to_string())));
        assert!(is_empty_string(&Some("UNDEFINED".to_string())));
        assert!(is_empty_string(&Some("(null)".to_string())));
        assert!(is_empty_string(&Some("<null>".to_string())));
        assert!(is_empty_string(&Some("n/a".to_string())));
        assert!(is_empty_string(&Some("N/A".to_string())));
        assert!(is_empty_string(&Some("na".to_string())));
        assert!(is_empty_string(&Some("NA".to_string())));

        // Test Windows-specific null patterns
        assert!(is_empty_string(&Some("unknown".to_string())));
        assert!(is_empty_string(&Some("UNKNOWN".to_string())));
        assert!(is_empty_string(&Some("<unknown>".to_string())));
        assert!(is_empty_string(&Some("(unknown)".to_string())));
        assert!(is_empty_string(&Some("none".to_string())));
        assert!(is_empty_string(&Some("NONE".to_string())));
        assert!(is_empty_string(&Some("<none>".to_string())));
        assert!(is_empty_string(&Some("(none)".to_string())));
        assert!(is_empty_string(&Some("empty".to_string())));
        assert!(is_empty_string(&Some("EMPTY".to_string())));
        assert!(is_empty_string(&Some("<empty>".to_string())));
        assert!(is_empty_string(&Some("(empty)".to_string())));

        // Test COM/Windows API specific patterns
        assert!(is_empty_string(&Some("BSTR()".to_string())));
        assert!(is_empty_string(&Some("variant()".to_string())));
        assert!(is_empty_string(&Some("VARIANT(EMPTY)".to_string())));
        assert!(is_empty_string(&Some("Variant(Empty)".to_string())));

        // Test with surrounding whitespace
        assert!(is_empty_string(&Some(" null ".to_string())));
        assert!(is_empty_string(&Some("\t(null)\n".to_string())));
        assert!(is_empty_string(&Some("  UNKNOWN  ".to_string())));

        // Test valid strings that should NOT be filtered
        assert!(!is_empty_string(&Some("test".to_string())));
        assert!(!is_empty_string(&Some("valid content".to_string())));
        assert!(!is_empty_string(&Some("0".to_string())));
        assert!(!is_empty_string(&Some("false".to_string())));
        assert!(!is_empty_string(&Some("Button".to_string())));

        // Test edge cases that might look like null but aren't
        assert!(!is_empty_string(&Some("not null".to_string())));
        assert!(!is_empty_string(&Some("nullify".to_string())));
        assert!(!is_empty_string(&Some("nullable".to_string())));
        assert!(!is_empty_string(&Some("unknown value".to_string())));
        assert!(!is_empty_string(&Some("something empty".to_string())));
        assert!(!is_empty_string(&Some("none selected".to_string())));
    }
}
