use ::computeruse_core::{
    ClickResult as CoreClickResult, CommandOutput as CoreCommandOutput,
    ScreenshotResult as CoreScreenshotResult,
};
use pyo3::prelude::*;
use pyo3_stub_gen::derive::*;
use serde::Serialize;
use std::collections::HashMap;

/// Monitor/display information.
#[gen_stub_pyclass]
#[pyclass(name = "Monitor")]
#[derive(Serialize, Clone)]
pub struct Monitor {
    #[pyo3(get)]
    pub id: String,
    #[pyo3(get)]
    pub name: String,
    #[pyo3(get)]
    pub is_primary: bool,
    #[pyo3(get)]
    pub width: u32,
    #[pyo3(get)]
    pub height: u32,
    #[pyo3(get)]
    pub x: i32,
    #[pyo3(get)]
    pub y: i32,
    #[pyo3(get)]
    pub scale_factor: f64,
}

/// Result of a screenshot operation.
#[gen_stub_pyclass]
#[pyclass(name = "ScreenshotResult")]
#[derive(Clone, Serialize)]
pub struct ScreenshotResult {
    #[pyo3(get)]
    pub width: u32,
    #[pyo3(get)]
    pub height: u32,
    #[pyo3(get)]
    pub image_data: Vec<u8>,
    #[pyo3(get)]
    pub monitor: Option<Monitor>,
}

/// Result of a click operation.
#[gen_stub_pyclass]
#[pyclass(name = "ClickResult")]
#[derive(Serialize)]
pub struct ClickResult {
    #[pyo3(get)]
    pub method: String,
    #[pyo3(get)]
    pub coordinates: Option<Coordinates>,
    #[pyo3(get)]
    pub details: String,
}

/// Result of a command execution.
#[gen_stub_pyclass]
#[pyclass(name = "CommandOutput")]
#[derive(Serialize)]
pub struct CommandOutput {
    #[pyo3(get)]
    pub exit_status: Option<i32>,
    #[pyo3(get)]
    pub stdout: String,
    #[pyo3(get)]
    pub stderr: String,
}

/// UI Element attributes
#[gen_stub_pyclass]
#[pyclass(name = "UIElementAttributes")]
#[derive(Clone, Serialize)]
pub struct UIElementAttributes {
    #[pyo3(get)]
    pub role: String,
    #[pyo3(get)]
    pub name: Option<String>,
    #[pyo3(get)]
    pub label: Option<String>,
    #[pyo3(get)]
    pub value: Option<String>,
    #[pyo3(get)]
    pub description: Option<String>,
    #[pyo3(get)]
    pub properties: HashMap<String, Option<String>>,
    #[pyo3(get)]
    pub is_keyboard_focusable: Option<bool>,
    #[pyo3(get)]
    pub bounds: Option<Bounds>,
}

/// Coordinates for mouse operations
#[gen_stub_pyclass]
#[pyclass(name = "Coordinates")]
#[derive(Clone, Serialize)]
pub struct Coordinates {
    #[pyo3(get)]
    pub x: f64,
    #[pyo3(get)]
    pub y: f64,
}

/// Bounds for element coordinates
#[gen_stub_pyclass]
#[pyclass(name = "Bounds")]
#[derive(Clone, Serialize)]
pub struct Bounds {
    #[pyo3(get)]
    pub x: f64,
    #[pyo3(get)]
    pub y: f64,
    #[pyo3(get)]
    pub width: f64,
    #[pyo3(get)]
    pub height: f64,
}

/// Details about an explored element
#[gen_stub_pyclass]
#[pyclass(name = "ExploredElementDetail")]
#[derive(Clone, Serialize)]
pub struct ExploredElementDetail {
    #[pyo3(get)]
    pub role: String,
    #[pyo3(get)]
    pub name: Option<String>,
    #[pyo3(get)]
    pub id: Option<String>,
    #[pyo3(get)]
    pub bounds: Option<Bounds>,
    #[pyo3(get)]
    pub value: Option<String>,
    #[pyo3(get)]
    pub description: Option<String>,
    #[pyo3(get)]
    pub text: Option<String>,
    #[pyo3(get)]
    pub parent_id: Option<String>,
    #[pyo3(get)]
    pub children_ids: Vec<String>,
    #[pyo3(get)]
    pub suggested_selector: String,
}

/// Response from exploring an element
#[gen_stub_pyclass]
#[pyclass(name = "ExploreResponse")]
#[derive(Clone, Serialize)]
pub struct ExploreResponse {
    #[pyo3(get)]
    pub parent: crate::element::UIElement,
    #[pyo3(get)]
    pub children: Vec<ExploredElementDetail>,
}

/// UI Node representing a tree structure of UI elements
#[gen_stub_pyclass]
#[pyclass(name = "UINode")]
#[derive(Clone, Serialize)]
pub struct UINode {
    #[pyo3(get)]
    pub id: Option<String>,
    #[pyo3(get)]
    pub attributes: UIElementAttributes,
    #[pyo3(get)]
    pub children: Vec<UINode>,
}

/// Property loading strategy for tree building
#[gen_stub_pyclass]
#[pyclass(name = "PropertyLoadingMode")]
#[derive(Clone, Serialize)]
pub struct PropertyLoadingMode {
    #[pyo3(get, set)]
    pub mode: String,
}

#[gen_stub_pymethods]
#[pymethods]
impl PropertyLoadingMode {
    #[new]
    #[pyo3(signature = (mode=None))]
    pub fn new(mode: Option<String>) -> Self {
        PropertyLoadingMode {
            mode: mode.unwrap_or_else(|| "Fast".to_string()),
        }
    }

    #[classmethod]
    pub fn fast(_cls: &Bound<'_, pyo3::types::PyType>) -> Self {
        PropertyLoadingMode {
            mode: "Fast".to_string(),
        }
    }

    #[classmethod]
    pub fn complete(_cls: &Bound<'_, pyo3::types::PyType>) -> Self {
        PropertyLoadingMode {
            mode: "Complete".to_string(),
        }
    }

    #[classmethod]
    pub fn smart(_cls: &Bound<'_, pyo3::types::PyType>) -> Self {
        PropertyLoadingMode {
            mode: "Smart".to_string(),
        }
    }

    fn __repr__(&self) -> PyResult<String> {
        serde_json::to_string(self)
            .map_err(|e| pyo3::exceptions::PyException::new_err(e.to_string()))
    }

    fn __str__(&self) -> PyResult<String> {
        serde_json::to_string_pretty(self)
            .map_err(|e| pyo3::exceptions::PyException::new_err(e.to_string()))
    }
}

/// Configuration for tree building performance and completeness
#[gen_stub_pyclass]
#[pyclass(name = "TreeBuildConfig")]
#[derive(Clone, Serialize)]
pub struct TreeBuildConfig {
    #[pyo3(get, set)]
    pub property_mode: PropertyLoadingMode,
    #[pyo3(get, set)]
    pub timeout_per_operation_ms: Option<u64>,
    #[pyo3(get, set)]
    pub yield_every_n_elements: Option<usize>,
    #[pyo3(get, set)]
    pub batch_size: Option<usize>,
}

#[gen_stub_pymethods]
#[pymethods]
impl TreeBuildConfig {
    #[new]
    #[pyo3(signature = (property_mode=None, timeout_per_operation_ms=None, yield_every_n_elements=None, batch_size=None))]
    pub fn new(
        property_mode: Option<PropertyLoadingMode>,
        timeout_per_operation_ms: Option<u64>,
        yield_every_n_elements: Option<usize>,
        batch_size: Option<usize>,
    ) -> Self {
        TreeBuildConfig {
            property_mode: property_mode.unwrap_or_else(|| PropertyLoadingMode { mode: "Fast".to_string() }),
            timeout_per_operation_ms,
            yield_every_n_elements,
            batch_size,
        }
    }

    fn __repr__(&self) -> PyResult<String> {
        serde_json::to_string(self)
            .map_err(|e| pyo3::exceptions::PyException::new_err(e.to_string()))
    }

    fn __str__(&self) -> PyResult<String> {
        serde_json::to_string_pretty(self)
            .map_err(|e| pyo3::exceptions::PyException::new_err(e.to_string()))
    }
}

/// Position options for text overlays in highlighting
#[gen_stub_pyclass]
#[pyclass(name = "TextPosition")]
#[derive(Clone, Serialize)]
pub struct TextPosition {
    #[pyo3(get)]
    pub position: String,
}

#[gen_stub_pymethods]
#[pymethods]
impl TextPosition {
    #[classmethod]
    pub fn top(_cls: &Bound<'_, pyo3::types::PyType>) -> Self {
        TextPosition {
            position: "Top".to_string(),
        }
    }

    #[classmethod]
    pub fn top_right(_cls: &Bound<'_, pyo3::types::PyType>) -> Self {
        TextPosition {
            position: "TopRight".to_string(),
        }
    }

    #[classmethod]
    pub fn right(_cls: &Bound<'_, pyo3::types::PyType>) -> Self {
        TextPosition {
            position: "Right".to_string(),
        }
    }

    #[classmethod]
    pub fn bottom_right(_cls: &Bound<'_, pyo3::types::PyType>) -> Self {
        TextPosition {
            position: "BottomRight".to_string(),
        }
    }

    #[classmethod]
    pub fn bottom(_cls: &Bound<'_, pyo3::types::PyType>) -> Self {
        TextPosition {
            position: "Bottom".to_string(),
        }
    }

    #[classmethod]
    pub fn bottom_left(_cls: &Bound<'_, pyo3::types::PyType>) -> Self {
        TextPosition {
            position: "BottomLeft".to_string(),
        }
    }

    #[classmethod]
    pub fn left(_cls: &Bound<'_, pyo3::types::PyType>) -> Self {
        TextPosition {
            position: "Left".to_string(),
        }
    }

    #[classmethod]
    pub fn top_left(_cls: &Bound<'_, pyo3::types::PyType>) -> Self {
        TextPosition {
            position: "TopLeft".to_string(),
        }
    }

    #[classmethod]
    pub fn inside(_cls: &Bound<'_, pyo3::types::PyType>) -> Self {
        TextPosition {
            position: "Inside".to_string(),
        }
    }

    fn __repr__(&self) -> PyResult<String> {
        serde_json::to_string(self)
            .map_err(|e| pyo3::exceptions::PyException::new_err(e.to_string()))
    }
    fn __str__(&self) -> PyResult<String> {
        serde_json::to_string_pretty(self)
            .map_err(|e| pyo3::exceptions::PyException::new_err(e.to_string()))
    }
}

/// Font styling options for text overlays
#[gen_stub_pyclass]
#[pyclass(name = "FontStyle")]
#[derive(Clone, Serialize)]
pub struct FontStyle {
    #[pyo3(get)]
    pub size: u32,
    #[pyo3(get)]
    pub bold: bool,
    #[pyo3(get)]
    pub color: u32,
}

#[gen_stub_pymethods]
#[pymethods]
impl FontStyle {
    #[new]
    pub fn new(size: Option<u32>, bold: Option<bool>, color: Option<u32>) -> Self {
        FontStyle {
            size: size.unwrap_or(12),
            bold: bold.unwrap_or(false),
            color: color.unwrap_or(0x000000), // Black
        }
    }

    fn __repr__(&self) -> PyResult<String> {
        serde_json::to_string(self)
            .map_err(|e| pyo3::exceptions::PyException::new_err(e.to_string()))
    }
    fn __str__(&self) -> PyResult<String> {
        serde_json::to_string_pretty(self)
            .map_err(|e| pyo3::exceptions::PyException::new_err(e.to_string()))
    }
}

/// Handle for managing active highlights with cleanup
#[gen_stub_pyclass]
#[pyclass(name = "HighlightHandle")]
pub struct HighlightHandle {
    inner: Option<::computeruse_core::HighlightHandle>,
}

#[gen_stub_pymethods]
#[pymethods]
impl HighlightHandle {
    /// Manually close the highlight
    pub fn close(&mut self) {
        if let Some(handle) = self.inner.take() {
            handle.close();
        }
    }

    fn __repr__(&self) -> PyResult<String> {
        Ok("HighlightHandle".to_string())
    }
    fn __str__(&self) -> PyResult<String> {
        Ok("HighlightHandle".to_string())
    }
}

impl HighlightHandle {
    pub fn new(handle: ::computeruse_core::HighlightHandle) -> Self {
        Self {
            inner: Some(handle),
        }
    }

    pub fn new_dummy() -> Self {
        Self { inner: None }
    }
}

impl From<::computeruse_core::Monitor> for Monitor {
    fn from(m: ::computeruse_core::Monitor) -> Self {
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

impl From<CoreScreenshotResult> for ScreenshotResult {
    fn from(r: CoreScreenshotResult) -> Self {
        ScreenshotResult {
            width: r.width,
            height: r.height,
            image_data: r.image_data,
            monitor: r.monitor.map(Monitor::from),
        }
    }
}

impl From<ScreenshotResult> for CoreScreenshotResult {
    fn from(r: ScreenshotResult) -> Self {
        CoreScreenshotResult {
            width: r.width,
            height: r.height,
            image_data: r.image_data,
            monitor: r.monitor.map(|m| ::computeruse_core::Monitor {
                id: m.id,
                name: m.name,
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

impl From<CoreClickResult> for ClickResult {
    fn from(r: CoreClickResult) -> Self {
        ClickResult {
            method: r.method,
            coordinates: r.coordinates.map(|(x, y)| Coordinates { x, y }),
            details: r.details,
        }
    }
}

impl From<CoreCommandOutput> for CommandOutput {
    fn from(r: CoreCommandOutput) -> Self {
        CommandOutput {
            exit_status: r.exit_status,
            stdout: r.stdout,
            stderr: r.stderr,
        }
    }
}

impl From<::computeruse_core::UINode> for UINode {
    fn from(node: ::computeruse_core::UINode) -> Self {
        UINode {
            id: node.id,
            attributes: UIElementAttributes::from(node.attributes),
            children: node.children.into_iter().map(UINode::from).collect(),
        }
    }
}

impl From<::computeruse_core::UIElementAttributes> for UIElementAttributes {
    fn from(attrs: ::computeruse_core::UIElementAttributes) -> Self {
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

impl From<TreeBuildConfig> for ::computeruse_core::platforms::TreeBuildConfig {
    fn from(config: TreeBuildConfig) -> Self {
        let property_mode = match config.property_mode.mode.as_str() {
            "Fast" => ::computeruse_core::platforms::PropertyLoadingMode::Fast,
            "Complete" => ::computeruse_core::platforms::PropertyLoadingMode::Complete,
            "Smart" => ::computeruse_core::platforms::PropertyLoadingMode::Smart,
            _ => ::computeruse_core::platforms::PropertyLoadingMode::Fast, // default
        };

        ::computeruse_core::platforms::TreeBuildConfig {
            property_mode,
            timeout_per_operation_ms: config.timeout_per_operation_ms,
            yield_every_n_elements: config.yield_every_n_elements,
            batch_size: config.batch_size,
            max_depth: None, // Not exposed in Python bindings yet
            include_all_bounds: false,
            ui_settle_delay_ms: None,
            format_output: false,
            show_overlay: false,
            overlay_display_mode: None,
            from_selector: None,
        }
    }
}

impl From<TextPosition> for ::computeruse_core::TextPosition {
    fn from(pos: TextPosition) -> Self {
        match pos.position.as_str() {
            "Top" => ::computeruse_core::TextPosition::Top,
            "TopRight" => ::computeruse_core::TextPosition::TopRight,
            "Right" => ::computeruse_core::TextPosition::Right,
            "BottomRight" => ::computeruse_core::TextPosition::BottomRight,
            "Bottom" => ::computeruse_core::TextPosition::Bottom,
            "BottomLeft" => ::computeruse_core::TextPosition::BottomLeft,
            "Left" => ::computeruse_core::TextPosition::Left,
            "TopLeft" => ::computeruse_core::TextPosition::TopLeft,
            "Inside" => ::computeruse_core::TextPosition::Inside,
            _ => ::computeruse_core::TextPosition::Top, // default
        }
    }
}

impl From<FontStyle> for ::computeruse_core::FontStyle {
    fn from(style: FontStyle) -> Self {
        ::computeruse_core::FontStyle {
            size: style.size,
            bold: style.bold,
            color: style.color,
        }
    }
}

#[gen_stub_pymethods]
#[pymethods]
impl ExploreResponse {
    fn __repr__(&self) -> PyResult<String> {
        serde_json::to_string(self)
            .map_err(|e| pyo3::exceptions::PyException::new_err(e.to_string()))
    }
    fn __str__(&self) -> PyResult<String> {
        serde_json::to_string_pretty(self)
            .map_err(|e| pyo3::exceptions::PyException::new_err(e.to_string()))
    }
}

#[gen_stub_pymethods]
#[pymethods]
impl ClickResult {
    fn __repr__(&self) -> PyResult<String> {
        serde_json::to_string(self)
            .map_err(|e| pyo3::exceptions::PyException::new_err(e.to_string()))
    }
    fn __str__(&self) -> PyResult<String> {
        serde_json::to_string_pretty(self)
            .map_err(|e| pyo3::exceptions::PyException::new_err(e.to_string()))
    }
}

#[gen_stub_pymethods]
#[pymethods]
impl UIElementAttributes {
    fn __repr__(&self) -> PyResult<String> {
        serde_json::to_string(self)
            .map_err(|e| pyo3::exceptions::PyException::new_err(e.to_string()))
    }
    fn __str__(&self) -> PyResult<String> {
        serde_json::to_string_pretty(self)
            .map_err(|e| pyo3::exceptions::PyException::new_err(e.to_string()))
    }
}

#[gen_stub_pymethods]
#[pymethods]
impl ScreenshotResult {
    fn __repr__(&self) -> PyResult<String> {
        serde_json::to_string(self)
            .map_err(|e| pyo3::exceptions::PyException::new_err(e.to_string()))
    }
    fn __str__(&self) -> PyResult<String> {
        serde_json::to_string_pretty(self)
            .map_err(|e| pyo3::exceptions::PyException::new_err(e.to_string()))
    }
}

#[gen_stub_pymethods]
#[pymethods]
impl CommandOutput {
    fn __repr__(&self) -> PyResult<String> {
        serde_json::to_string(self)
            .map_err(|e| pyo3::exceptions::PyException::new_err(e.to_string()))
    }
    fn __str__(&self) -> PyResult<String> {
        serde_json::to_string_pretty(self)
            .map_err(|e| pyo3::exceptions::PyException::new_err(e.to_string()))
    }
}

#[gen_stub_pymethods]
#[pymethods]
impl Coordinates {
    fn __repr__(&self) -> PyResult<String> {
        serde_json::to_string(self)
            .map_err(|e| pyo3::exceptions::PyException::new_err(e.to_string()))
    }
    fn __str__(&self) -> PyResult<String> {
        serde_json::to_string_pretty(self)
            .map_err(|e| pyo3::exceptions::PyException::new_err(e.to_string()))
    }
}

#[gen_stub_pymethods]
#[pymethods]
impl Bounds {
    fn __repr__(&self) -> PyResult<String> {
        serde_json::to_string(self)
            .map_err(|e| pyo3::exceptions::PyException::new_err(e.to_string()))
    }
    fn __str__(&self) -> PyResult<String> {
        serde_json::to_string_pretty(self)
            .map_err(|e| pyo3::exceptions::PyException::new_err(e.to_string()))
    }
}

#[gen_stub_pymethods]
#[pymethods]
impl ExploredElementDetail {
    fn __repr__(&self) -> PyResult<String> {
        serde_json::to_string(self)
            .map_err(|e| pyo3::exceptions::PyException::new_err(e.to_string()))
    }
    fn __str__(&self) -> PyResult<String> {
        serde_json::to_string_pretty(self)
            .map_err(|e| pyo3::exceptions::PyException::new_err(e.to_string()))
    }
}

#[gen_stub_pymethods]
#[pymethods]
impl UINode {
    fn __repr__(&self) -> PyResult<String> {
        serde_json::to_string(self)
            .map_err(|e| pyo3::exceptions::PyException::new_err(e.to_string()))
    }
    fn __str__(&self) -> PyResult<String> {
        serde_json::to_string_pretty(self)
            .map_err(|e| pyo3::exceptions::PyException::new_err(e.to_string()))
    }
}

#[gen_stub_pymethods]
#[pymethods]
impl Monitor {
    fn __repr__(&self) -> PyResult<String> {
        serde_json::to_string(self)
            .map_err(|e| pyo3::exceptions::PyException::new_err(e.to_string()))
    }
    fn __str__(&self) -> PyResult<String> {
        serde_json::to_string_pretty(self)
            .map_err(|e| pyo3::exceptions::PyException::new_err(e.to_string()))
    }
}
