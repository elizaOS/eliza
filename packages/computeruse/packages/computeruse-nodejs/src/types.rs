use napi_derive::napi;
use serde::Serialize;
use std::collections::HashMap;

#[derive(Serialize, Clone)]
#[napi(object, js_name = "Bounds")]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[napi(object, js_name = "Coordinates")]
pub struct Coordinates {
    pub x: f64,
    pub y: f64,
}

/// Result of UI diff capture
#[napi(object, js_name = "UiDiffResult")]
pub struct UiDiffResult {
    /// The computed diff showing changes (lines starting with + or -)
    pub diff: String,
    /// Whether any UI changes were detected
    pub has_changes: bool,
}

#[napi(object, js_name = "ClickResult")]
pub struct ClickResult {
    pub method: String,
    pub coordinates: Option<Coordinates>,
    pub details: String,
    /// Path to window screenshot if captured
    pub window_screenshot_path: Option<String>,
    /// Paths to monitor screenshots if captured
    pub monitor_screenshot_paths: Option<Vec<String>>,
    /// UI diff result if ui_diff_before_after was enabled
    pub ui_diff: Option<UiDiffResult>,
}

/// Result of an action operation (type_text, press_key, scroll, etc.)
#[napi(object, js_name = "ActionResult")]
pub struct ActionResult {
    /// Whether the action succeeded
    pub success: bool,
    /// Path to window screenshot if captured
    pub window_screenshot_path: Option<String>,
    /// Paths to monitor screenshots if captured
    pub monitor_screenshot_paths: Option<Vec<String>>,
    /// UI diff result if ui_diff_before_after was enabled
    pub ui_diff: Option<UiDiffResult>,
}

/// Type of mouse click to perform
#[napi(string_enum, js_name = "ClickType")]
pub enum ClickType {
    /// Single left click (default)
    Left,
    /// Double left click
    Double,
    /// Single right click
    Right,
}

impl From<ClickType> for computeruse::ClickType {
    fn from(ct: ClickType) -> Self {
        match ct {
            ClickType::Left => computeruse::ClickType::Left,
            ClickType::Double => computeruse::ClickType::Double,
            ClickType::Right => computeruse::ClickType::Right,
        }
    }
}

/// Source of indexed elements for click targeting
#[napi(string_enum, js_name = "VisionType")]
pub enum VisionType {
    /// UI Automation tree elements (default)
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

impl From<VisionType> for computeruse::VisionType {
    fn from(vt: VisionType) -> Self {
        match vt {
            VisionType::UiTree => computeruse::VisionType::UiTree,
            VisionType::Ocr => computeruse::VisionType::Ocr,
            VisionType::Omniparser => computeruse::VisionType::Omniparser,
            VisionType::Gemini => computeruse::VisionType::Gemini,
            VisionType::Dom => computeruse::VisionType::Dom,
        }
    }
}

#[napi(object, js_name = "CommandOutput")]
pub struct CommandOutput {
    pub exit_status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Clone)]
#[napi(object)]
pub struct Monitor {
    pub id: String,
    pub name: String,
    pub is_primary: bool,
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub scale_factor: f64,
}

/// A screenshot result containing image data and dimensions.
#[napi(object)]
pub struct ScreenshotResult {
    pub width: u32,
    pub height: u32,
    pub image_data: Vec<u8>,
    pub monitor: Option<Monitor>,
}

impl ScreenshotResult {
    /// Convert to the internal computeruse::ScreenshotResult
    pub fn to_inner(&self) -> computeruse::ScreenshotResult {
        computeruse::ScreenshotResult {
            image_data: self.image_data.clone(),
            width: self.width,
            height: self.height,
            monitor: self.monitor.as_ref().map(|m| computeruse::Monitor {
                id: m.id.clone(),
                name: m.name.clone(),
                is_primary: m.is_primary,
                width: m.width,
                height: m.height,
                x: m.x,
                y: m.y,
                scale_factor: m.scale_factor,
                work_area: None,
            }),
        }
    }
}

#[napi(object)]
pub struct ResizedDimensions {
    pub width: u32,
    pub height: u32,
}

#[napi(object)]
pub struct MonitorScreenshotPair {
    pub monitor: Monitor,
    pub screenshot: ScreenshotResult,
}

#[derive(Serialize)]
#[napi(object, js_name = "UIElementAttributes")]
pub struct UIElementAttributes {
    pub role: String,
    pub name: Option<String>,
    pub label: Option<String>,
    pub value: Option<String>,
    pub description: Option<String>,
    pub properties: HashMap<String, Option<String>>,
    pub is_keyboard_focusable: Option<bool>,
    pub bounds: Option<Bounds>,
}

#[derive(Serialize)]
#[napi(object, js_name = "UINode")]
pub struct UINode {
    pub id: Option<String>,
    pub attributes: UIElementAttributes,
    pub children: Vec<UINode>,
}

/// Entry in index-to-bounds mapping for click targeting
#[napi(object, js_name = "BoundsEntry")]
pub struct BoundsEntry {
    pub role: String,
    pub name: String,
    pub bounds: Bounds,
    pub selector: Option<String>,
}

/// Result of get_window_tree_result operation with all computed data
#[napi(object, js_name = "WindowTreeResult")]
pub struct WindowTreeResult {
    /// The raw UI tree structure
    pub tree: UINode,
    /// Process ID of the window
    pub pid: u32,
    /// Whether this is a browser window
    pub is_browser: bool,
    /// Formatted compact YAML output (if format_output was true)
    pub formatted: Option<String>,
    /// Mapping of index to bounds for click targeting (keys are 1-based indices as strings)
    pub index_to_bounds: HashMap<String, BoundsEntry>,
    /// Total count of indexed elements (elements with bounds)
    pub element_count: u32,
    /// Path to saved window screenshot (if include_window_screenshot was true)
    pub window_screenshot_path: Option<String>,
    /// Paths to saved monitor screenshots (if include_monitor_screenshots was true)
    pub monitor_screenshot_paths: Option<Vec<String>>,
}

#[napi(string_enum)]
pub enum PropertyLoadingMode {
    /// Only load essential properties (role + name) - fastest
    Fast,
    /// Load all properties for complete element data - slower but comprehensive
    Complete,
    /// Load specific properties based on element type - balanced approach
    Smart,
}

/// Output format for UI tree
#[napi(string_enum)]
pub enum TreeOutputFormat {
    /// Compact YAML format with indexed elements: #1 [ROLE] name
    CompactYaml,
    /// Full JSON format with all fields and properties
    VerboseJson,
    /// Clustered YAML format: groups elements from all sources (UIA, DOM, OCR, Omniparser, Gemini)
    /// by spatial proximity with prefixed indices (#u1, #d2, #o3, #p4, #g5)
    ClusteredYaml,
}

/// Source of an element for clustered output
#[napi(string_enum)]
pub enum ElementSource {
    /// #u - Accessibility tree (UIA)
    Uia,
    /// #d - Browser DOM
    Dom,
    /// #o - OCR text
    Ocr,
    /// #p - Omniparser vision
    Omniparser,
    /// #g - Gemini vision
    Gemini,
}

/// Display mode for inspect overlay labels
#[napi(string_enum)]
pub enum OverlayDisplayMode {
    /// Just rectangles, no labels
    Rectangles,
    /// [index] only (default)
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

/// Element data for inspect overlay rendering
#[napi(object, js_name = "InspectElement")]
pub struct InspectElement {
    /// 1-based index for click targeting
    pub index: u32,
    /// Element role (e.g., "Button", "Edit")
    pub role: String,
    /// Element name if available
    pub name: Option<String>,
    /// Bounding box (x, y, width, height)
    pub bounds: Bounds,
}

/// OCR element representing text detected via optical character recognition.
/// Hierarchy: OcrResult -> OcrLine -> OcrWord
#[derive(Serialize)]
#[napi(object, js_name = "OcrElement")]
pub struct OcrElement {
    /// Role type: "OcrResult", "OcrLine", or "OcrWord"
    pub role: String,
    /// The recognized text content
    pub text: Option<String>,
    /// Bounding box in absolute screen coordinates
    pub bounds: Option<Bounds>,
    /// Text rotation angle in degrees (only present on OcrResult)
    pub text_angle: Option<f64>,
    /// Confidence score (0.0 to 1.0) if available
    pub confidence: Option<f64>,
    /// Child elements (lines for OcrResult, words for OcrLine)
    pub children: Option<Vec<OcrElement>>,
}

/// Result of OCR operation with tree and index-to-bounds mapping
#[napi(object, js_name = "OcrResult")]
pub struct OcrResult {
    /// The OCR tree structure
    pub tree: OcrElement,
    /// Formatted compact YAML output (if format_output was true)
    pub formatted: Option<String>,
    /// Mapping of index to bounds for click targeting (keys are 1-based indices as strings)
    /// Value contains (text, bounds)
    pub index_to_bounds: HashMap<String, OcrBoundsEntry>,
    /// Total count of indexed elements (words with bounds)
    pub element_count: u32,
}

/// Entry in OCR index-to-bounds mapping for click targeting
#[napi(object, js_name = "OcrBoundsEntry")]
pub struct OcrBoundsEntry {
    pub text: String,
    pub bounds: Bounds,
}

/// Browser DOM element captured from a web page
#[derive(Serialize)]
#[napi(object, js_name = "BrowserDomElement")]
pub struct BrowserDomElement {
    /// HTML tag name (lowercase)
    pub tag: String,
    /// Element id attribute
    pub id: Option<String>,
    /// CSS classes
    pub classes: Vec<String>,
    /// Visible text content (truncated to 100 chars)
    pub text: Option<String>,
    /// href attribute for links
    pub href: Option<String>,
    /// type attribute for inputs
    pub r#type: Option<String>,
    /// name attribute
    pub name: Option<String>,
    /// value attribute for inputs
    pub value: Option<String>,
    /// placeholder attribute
    pub placeholder: Option<String>,
    /// aria-label attribute
    pub aria_label: Option<String>,
    /// role attribute
    pub role: Option<String>,
    /// Bounding box in screen coordinates
    pub bounds: Bounds,
}

/// Entry in DOM index-to-bounds mapping for click targeting
#[napi(object, js_name = "DomBoundsEntry")]
pub struct DomBoundsEntry {
    /// Display name (text or aria-label or tag)
    pub name: String,
    /// HTML tag
    pub tag: String,
    /// Bounding box
    pub bounds: Bounds,
}

/// Result of browser DOM capture operation
#[napi(object, js_name = "BrowserDomResult")]
pub struct BrowserDomResult {
    /// List of captured DOM elements
    pub elements: Vec<BrowserDomElement>,
    /// Formatted compact YAML output (if format_output was true)
    pub formatted: Option<String>,
    /// Mapping of index to bounds for click targeting
    pub index_to_bounds: HashMap<String, DomBoundsEntry>,
    /// Total count of captured elements
    pub element_count: u32,
    /// Page URL
    pub page_url: String,
    /// Page title
    pub page_title: String,
}

/// UI element detected by Gemini vision model
#[derive(Serialize, Clone)]
#[napi(object, js_name = "VisionElement")]
pub struct VisionElement {
    /// Element type: text, icon, button, input, checkbox, dropdown, link, image, unknown
    pub element_type: String,
    /// Visible text or label on the element
    pub content: Option<String>,
    /// AI description of what this element is or does
    pub description: Option<String>,
    /// Bounding box in screen coordinates (x, y, width, height)
    pub bounds: Option<Bounds>,
    /// Whether the element is interactive/clickable
    pub interactivity: Option<bool>,
}

/// Entry in Gemini vision index-to-bounds mapping for click targeting
#[napi(object, js_name = "VisionBoundsEntry")]
pub struct VisionBoundsEntry {
    /// Display name (content or description)
    pub name: String,
    /// Element type
    pub element_type: String,
    /// Bounding box
    pub bounds: Bounds,
}

/// Result of Gemini vision detection operation
#[napi(object, js_name = "GeminiVisionResult")]
pub struct GeminiVisionResult {
    /// List of detected UI elements
    pub elements: Vec<VisionElement>,
    /// Formatted compact YAML output (if format_output was true)
    pub formatted: Option<String>,
    /// Mapping of index to bounds for click targeting
    pub index_to_bounds: HashMap<String, VisionBoundsEntry>,
    /// Total count of detected elements
    pub element_count: u32,
}

/// Item detected by Omniparser V2 (icon/field detection)
#[derive(Serialize, Clone)]
#[napi(object, js_name = "OmniparserItem")]
pub struct OmniparserItem {
    /// Element label: "icon", "text", etc.
    pub label: String,
    /// Content or OCR text
    pub content: Option<String>,
    /// Bounding box in screen coordinates (x, y, width, height)
    pub bounds: Option<Bounds>,
}

/// Entry in Omniparser index-to-bounds mapping for click targeting
#[napi(object, js_name = "OmniparserBoundsEntry")]
pub struct OmniparserBoundsEntry {
    /// Display name (content or label)
    pub name: String,
    /// Element label
    pub label: String,
    /// Bounding box
    pub bounds: Bounds,
}

/// Result of Omniparser detection operation
#[napi(object, js_name = "OmniparserResult")]
pub struct OmniparserResult {
    /// List of detected items
    pub items: Vec<OmniparserItem>,
    /// Formatted compact YAML output (if format_output was true)
    pub formatted: Option<String>,
    /// Mapping of index to bounds for click targeting
    pub index_to_bounds: HashMap<String, OmniparserBoundsEntry>,
    /// Total count of detected items
    pub item_count: u32,
}

/// Entry in clustered index mapping (for click targeting across all sources)
#[napi(object, js_name = "ClusteredBoundsEntry")]
pub struct ClusteredBoundsEntry {
    /// Element source (Uia, Dom, Ocr, Omniparser, Gemini)
    pub source: ElementSource,
    /// Original index within the source
    pub original_index: u32,
    /// Bounding box in screen coordinates
    pub bounds: Bounds,
}

/// Result of clustered tree formatting
#[napi(object, js_name = "ClusteredFormattingResult")]
pub struct ClusteredFormattingResult {
    /// Formatted clustered YAML output
    pub formatted: String,
    /// Mapping from prefixed index (e.g., "u1", "d2") to source and bounds
    pub index_to_source_and_bounds: HashMap<String, ClusteredBoundsEntry>,
}

#[napi(object, js_name = "TreeBuildConfig")]
pub struct TreeBuildConfig {
    /// Property loading strategy
    pub property_mode: PropertyLoadingMode,
    /// Optional timeout per operation in milliseconds
    pub timeout_per_operation_ms: Option<i64>,
    /// Optional yield frequency for responsiveness
    pub yield_every_n_elements: Option<i32>,
    /// Optional batch size for processing elements
    pub batch_size: Option<i32>,
    /// Optional maximum depth to traverse (undefined = unlimited)
    pub max_depth: Option<i32>,
    /// Delay in milliseconds to wait for UI to stabilize before capturing tree
    pub ui_settle_delay_ms: Option<i64>,
    /// Generate formatted output alongside the tree structure (defaults to true if tree_output_format is set)
    pub format_output: Option<bool>,
    /// Output format for tree: 'CompactYaml' (default) or 'VerboseJson'
    pub tree_output_format: Option<TreeOutputFormat>,
    /// Selector to start tree from instead of window root (e.g., "role:Dialog" to focus on a dialog)
    pub tree_from_selector: Option<String>,
    /// Include window screenshot in result (saved to executions dir). Defaults to false.
    pub include_window_screenshot: Option<bool>,
    /// Include all monitor screenshots in result (saved to executions dir). Defaults to false.
    pub include_monitor_screenshots: Option<bool>,
    /// Include Gemini Vision AI detection. Elements prefixed with #g1, #g2, etc.
    pub include_gemini_vision: Option<bool>,
    /// Include Omniparser detection. Elements prefixed with #p1, #p2, etc.
    pub include_omniparser: Option<bool>,
    /// Include OCR text detection. Elements prefixed with #o1, #o2, etc.
    pub include_ocr: Option<bool>,
    /// Include browser DOM elements (requires ComputerUse Bridge extension). Elements prefixed with #d1, #d2, etc.
    pub include_browser_dom: Option<bool>,
}

impl From<(f64, f64, f64, f64)> for Bounds {
    fn from(t: (f64, f64, f64, f64)) -> Self {
        Bounds {
            x: t.0,
            y: t.1,
            width: t.2,
            height: t.3,
        }
    }
}

impl From<(f64, f64)> for Coordinates {
    fn from(t: (f64, f64)) -> Self {
        Coordinates { x: t.0, y: t.1 }
    }
}

impl From<computeruse::ClickResult> for ClickResult {
    fn from(r: computeruse::ClickResult) -> Self {
        ClickResult {
            method: r.method,
            coordinates: r.coordinates.map(Coordinates::from),
            details: r.details,
            window_screenshot_path: None,
            monitor_screenshot_paths: None,
            ui_diff: None,
        }
    }
}

impl From<computeruse::Monitor> for Monitor {
    fn from(m: computeruse::Monitor) -> Self {
        Monitor {
            id: m.id,
            name: m.name,
            is_primary: m.is_primary,
            width: m.width,
            height: m.height,
            x: m.x,
            y: m.y,
            scale_factor: m.scale_factor,
        }
    }
}

impl From<computeruse::OcrElement> for OcrElement {
    fn from(e: computeruse::OcrElement) -> Self {
        OcrElement {
            role: e.role,
            text: e.text,
            bounds: e.bounds.map(|(x, y, w, h)| Bounds {
                x,
                y,
                width: w,
                height: h,
            }),
            text_angle: e.text_angle,
            confidence: e.confidence,
            children: e
                .children
                .map(|children| children.into_iter().map(OcrElement::from).collect()),
        }
    }
}

impl From<computeruse::UINode> for UINode {
    fn from(node: computeruse::UINode) -> Self {
        UINode {
            id: node.id,
            attributes: UIElementAttributes::from(node.attributes),
            children: node.children.into_iter().map(UINode::from).collect(),
        }
    }
}

impl From<computeruse::WindowTreeResult> for WindowTreeResult {
    fn from(result: computeruse::WindowTreeResult) -> Self {
        // Convert HashMap<u32, (String, String, (f64, f64, f64, f64), Option<String>)>
        // to HashMap<String, BoundsEntry>
        let index_to_bounds = result
            .index_to_bounds
            .into_iter()
            .map(|(idx, (role, name, (x, y, w, h), selector))| {
                (
                    idx.to_string(),
                    BoundsEntry {
                        role,
                        name,
                        bounds: Bounds {
                            x,
                            y,
                            width: w,
                            height: h,
                        },
                        selector,
                    },
                )
            })
            .collect();

        WindowTreeResult {
            tree: UINode::from(result.tree),
            pid: result.pid,
            is_browser: result.is_browser,
            formatted: result.formatted,
            index_to_bounds,
            element_count: result.element_count,
            window_screenshot_path: None,
            monitor_screenshot_paths: None,
        }
    }
}

impl From<computeruse::UIElementAttributes> for UIElementAttributes {
    fn from(attrs: computeruse::UIElementAttributes) -> Self {
        // Convert HashMap<String, Option<serde_json::Value>> to HashMap<String, Option<String>>
        let properties = attrs
            .properties
            .into_iter()
            .map(|(k, v)| (k, v.map(|val| val.to_string())))
            .collect();

        UIElementAttributes {
            role: attrs.role,
            name: attrs.name,
            label: attrs.label,
            value: attrs.value,
            description: attrs.description,
            properties,
            is_keyboard_focusable: attrs.is_keyboard_focusable,
            bounds: attrs.bounds.map(|(x, y, width, height)| Bounds {
                x,
                y,
                width,
                height,
            }),
        }
    }
}

#[napi(string_enum)]
pub enum TextPosition {
    Top,
    TopRight,
    Right,
    BottomRight,
    Bottom,
    BottomLeft,
    Left,
    TopLeft,
    Inside,
}

#[napi(object)]
pub struct FontStyle {
    pub size: u32,
    pub bold: bool,
    pub color: u32,
}

#[napi]
pub struct HighlightHandle {
    inner: Option<computeruse::HighlightHandle>,
}

#[napi]
impl HighlightHandle {
    #[napi]
    pub fn close(&mut self) {
        if let Some(handle) = self.inner.take() {
            handle.close();
        }
    }
}

impl HighlightHandle {
    pub fn new(handle: computeruse::HighlightHandle) -> Self {
        Self {
            inner: Some(handle),
        }
    }

    pub fn new_dummy() -> Self {
        Self { inner: None }
    }
}

impl From<TextPosition> for computeruse::TextPosition {
    fn from(pos: TextPosition) -> Self {
        match pos {
            TextPosition::Top => computeruse::TextPosition::Top,
            TextPosition::TopRight => computeruse::TextPosition::TopRight,
            TextPosition::Right => computeruse::TextPosition::Right,
            TextPosition::BottomRight => computeruse::TextPosition::BottomRight,
            TextPosition::Bottom => computeruse::TextPosition::Bottom,
            TextPosition::BottomLeft => computeruse::TextPosition::BottomLeft,
            TextPosition::Left => computeruse::TextPosition::Left,
            TextPosition::TopLeft => computeruse::TextPosition::TopLeft,
            TextPosition::Inside => computeruse::TextPosition::Inside,
        }
    }
}

impl From<FontStyle> for computeruse::FontStyle {
    fn from(style: FontStyle) -> Self {
        computeruse::FontStyle {
            size: style.size,
            bold: style.bold,
            color: style.color,
        }
    }
}

impl Default for FontStyle {
    fn default() -> Self {
        Self {
            size: 12,
            bold: false,
            color: 0x000000,
        }
    }
}

impl From<OverlayDisplayMode> for computeruse::OverlayDisplayMode {
    fn from(mode: OverlayDisplayMode) -> Self {
        match mode {
            OverlayDisplayMode::Rectangles => computeruse::OverlayDisplayMode::Rectangles,
            OverlayDisplayMode::Index => computeruse::OverlayDisplayMode::Index,
            OverlayDisplayMode::Role => computeruse::OverlayDisplayMode::Role,
            OverlayDisplayMode::IndexRole => computeruse::OverlayDisplayMode::IndexRole,
            OverlayDisplayMode::Name => computeruse::OverlayDisplayMode::Name,
            OverlayDisplayMode::IndexName => computeruse::OverlayDisplayMode::IndexName,
            OverlayDisplayMode::Full => computeruse::OverlayDisplayMode::Full,
        }
    }
}

impl From<InspectElement> for computeruse::InspectElement {
    fn from(elem: InspectElement) -> Self {
        computeruse::InspectElement {
            index: elem.index,
            role: elem.role,
            name: elem.name,
            bounds: (
                elem.bounds.x,
                elem.bounds.y,
                elem.bounds.width,
                elem.bounds.height,
            ),
        }
    }
}

impl From<TreeBuildConfig> for computeruse::platforms::TreeBuildConfig {
    fn from(config: TreeBuildConfig) -> Self {
        computeruse::platforms::TreeBuildConfig {
            property_mode: match config.property_mode {
                PropertyLoadingMode::Fast => computeruse::platforms::PropertyLoadingMode::Fast,
                PropertyLoadingMode::Complete => {
                    computeruse::platforms::PropertyLoadingMode::Complete
                }
                PropertyLoadingMode::Smart => computeruse::platforms::PropertyLoadingMode::Smart,
            },
            timeout_per_operation_ms: config.timeout_per_operation_ms.map(|x| x as u64),
            yield_every_n_elements: config.yield_every_n_elements.map(|x| x as usize),
            batch_size: config.batch_size.map(|x| x as usize),
            max_depth: config.max_depth.map(|x| x as usize),
            include_all_bounds: false,
            ui_settle_delay_ms: config.ui_settle_delay_ms.map(|x| x as u64),
            format_output: config.format_output.unwrap_or(false),
            show_overlay: false, // Use Desktop.showInspectOverlay() method instead
            overlay_display_mode: None,
            from_selector: config.tree_from_selector, // Pass through to core SDK
        }
    }
}

/// Convert SerializableUIElement to UINode
pub(crate) fn serializable_to_ui_node(elem: &computeruse::SerializableUIElement) -> UINode {
    let attrs = UIElementAttributes {
        role: elem.role.clone(),
        name: elem.name.clone(),
        label: elem.label.clone(),
        value: elem.value.clone(),
        description: elem.description.clone(),
        properties: HashMap::new(), // SerializableUIElement doesn't have properties field
        is_keyboard_focusable: elem.is_keyboard_focusable,
        bounds: elem.bounds.map(|(x, y, w, h)| Bounds {
            x,
            y,
            width: w,
            height: h,
        }),
    };

    let children = elem
        .children
        .as_ref()
        .map(|children| children.iter().map(serializable_to_ui_node).collect())
        .unwrap_or_default();

    UINode {
        id: elem.id.clone(),
        attributes: attrs,
        children,
    }
}

// ===== Computer Use Types =====

/// A single step in the computer use execution
#[napi(object)]
pub struct ComputerUseStep {
    /// Step number (1-indexed)
    pub step: u32,
    /// Action that was executed
    pub action: String,
    /// Arguments passed to the action (as JSON string)
    pub args: String,
    /// Whether the action succeeded
    pub success: bool,
    /// Error message if action failed
    pub error: Option<String>,
    /// Model's reasoning text for this step
    pub text: Option<String>,
}

/// Pending confirmation info when safety check triggers
#[napi(object)]
pub struct ComputerUsePendingConfirmation {
    /// Action that needs confirmation
    pub action: String,
    /// Arguments for the action (as JSON string)
    pub args: String,
    /// Model's explanation text
    pub text: Option<String>,
}

/// Result of the computer use execution
#[napi(object)]
pub struct ComputerUseResult {
    /// Status: "success", "failed", "needs_confirmation", "max_steps_reached"
    pub status: String,
    /// The goal that was attempted
    pub goal: String,
    /// Number of steps executed
    pub steps_executed: u32,
    /// Last action performed
    pub final_action: String,
    /// Final text response from model
    pub final_text: Option<String>,
    /// History of all steps
    pub steps: Vec<ComputerUseStep>,
    /// Pending confirmation info if status is "needs_confirmation"
    pub pending_confirmation: Option<ComputerUsePendingConfirmation>,
    /// Execution ID for finding screenshots (e.g., "20251205_134500_geminiComputerUse_msedge")
    pub execution_id: Option<String>,
}

impl From<computeruse::ComputerUseStep> for ComputerUseStep {
    fn from(step: computeruse::ComputerUseStep) -> Self {
        ComputerUseStep {
            step: step.step,
            action: step.action,
            args: step.args.to_string(),
            success: step.success,
            error: step.error,
            text: step.text,
        }
    }
}

impl From<computeruse::ComputerUseResult> for ComputerUseResult {
    fn from(result: computeruse::ComputerUseResult) -> Self {
        let pending_confirmation =
            result
                .pending_confirmation
                .map(|pc| ComputerUsePendingConfirmation {
                    action: pc
                        .get("action")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    args: pc.get("args").map(|v| v.to_string()).unwrap_or_default(),
                    text: pc
                        .get("text")
                        .and_then(|v| v.as_str())
                        .map(|s: &str| s.to_string()),
                });

        ComputerUseResult {
            status: result.status,
            goal: result.goal,
            steps_executed: result.steps_executed,
            final_action: result.final_action,
            final_text: result.final_text,
            steps: result
                .steps
                .into_iter()
                .map(ComputerUseStep::from)
                .collect(),
            pending_confirmation,
            execution_id: result.execution_id,
        }
    }
}

/// Result of closing a browser tab
#[napi(object)]
#[derive(Debug, Clone)]
pub struct CloseTabResult {
    pub closed: bool,
    pub tab: ClosedTabInfo,
}

/// Information about a closed tab
#[napi(object)]
#[derive(Debug, Clone)]
pub struct ClosedTabInfo {
    pub id: i32,
    pub url: Option<String>,
    pub title: Option<String>,
    pub window_id: Option<i32>,
}

impl From<computeruse::extension_bridge::CloseTabResult> for CloseTabResult {
    fn from(result: computeruse::extension_bridge::CloseTabResult) -> Self {
        CloseTabResult {
            closed: result.closed,
            tab: ClosedTabInfo {
                id: result.tab.id,
                url: result.tab.url,
                title: result.tab.title,
                window_id: result.tab.window_id,
            },
        }
    }
}

/// Options for closing a browser tab
#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct CloseTabOptions {
    /// Specific Chrome tab ID to close
    pub tab_id: Option<i32>,
    /// URL to match (partial match supported)
    pub url: Option<String>,
    /// Title to match (case-insensitive partial match)
    pub title: Option<String>,
}
