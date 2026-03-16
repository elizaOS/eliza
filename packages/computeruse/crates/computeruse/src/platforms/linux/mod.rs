use crate::element::{UIElementAttributes, UIElementImpl};
use crate::platforms::{AccessibilityEngine, TreeBuildConfig};
use crate::{AutomationError, Browser, CommandOutput, Selector, UIElement, UINode};
use std::collections::HashSet;
use std::fmt;
use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

#[cfg(not(target_os = "windows"))]
use enigo::{Button, Direction, Enigo, Key, Keyboard, Mouse, Settings};
#[cfg(not(target_os = "windows"))]
use enigo::Axis;

// AT-SPI2 support via D-Bus
use atspi::proxy::accessible::AccessibleProxy;
use atspi::AccessibilityConnection;
use zbus::Connection as ZbusConnection;

#[derive(Debug, Clone)]
struct LinuxWindowInfo {
    window_id: String, // hex or decimal string (best-effort)
    pid: u32,
    title: String,
    bounds: (f64, f64, f64, f64),
    process_name: Option<String>,
}

static NEXT_OBJECT_ID: AtomicUsize = AtomicUsize::new(1);

#[derive(Clone)]
struct StubElement {
    object_id: usize,
    id: Option<String>,
    role: String,
    attrs: UIElementAttributes,
    pid: u32,
    url: Option<String>,
}

impl StubElement {
    fn new(role: &str, name: Option<String>) -> Self {
        let object_id = NEXT_OBJECT_ID.fetch_add(1, Ordering::Relaxed);
        let mut attrs = UIElementAttributes::default();
        attrs.role = role.to_string();
        attrs.name = name.clone();

        Self {
            object_id,
            id: Some(format!("stub:{object_id}")),
            role: role.to_string(),
            attrs,
            pid: 0,
            url: None,
        }
    }
}

impl fmt::Debug for StubElement {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StubElement")
            .field("id", &self.id)
            .field("role", &self.role)
            .field("name", &self.attrs.name)
            .finish()
    }
}

#[derive(Clone)]
struct LinuxUIElement {
    object_id: usize,
    id: Option<String>,
    attrs: UIElementAttributes,
    pid: u32,
    bounds: Option<(f64, f64, f64, f64)>,
    window_id: Option<String>,
    process_name: Option<String>,
}

impl fmt::Debug for LinuxUIElement {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LinuxUIElement")
            .field("id", &self.id)
            .field("role", &self.attrs.role)
            .field("name", &self.attrs.name)
            .field("pid", &self.pid)
            .field("bounds", &self.bounds)
            .field("window_id", &self.window_id)
            .finish()
    }
}

impl LinuxUIElement {
    fn new_window(info: LinuxWindowInfo) -> Self {
        let object_id = NEXT_OBJECT_ID.fetch_add(1, Ordering::Relaxed);
        let mut attrs = UIElementAttributes::default();
        attrs.role = "Window".to_string();
        attrs.name = Some(info.title);
        Self {
            object_id,
            id: Some(format!("linux:{object_id}")),
            attrs,
            pid: info.pid,
            bounds: Some(info.bounds),
            window_id: Some(info.window_id),
            process_name: info.process_name,
        }
    }
}

impl UIElementImpl for LinuxUIElement {
    fn object_id(&self) -> usize {
        self.object_id
    }
    fn id(&self) -> Option<String> {
        self.id.clone()
    }
    fn role(&self) -> String {
        self.attrs.role.clone()
    }
    fn attributes(&self) -> UIElementAttributes {
        self.attrs.clone()
    }
    fn children(&self) -> Result<Vec<UIElement>, AutomationError> {
        Ok(Vec::new())
    }
    fn parent(&self) -> Result<Option<UIElement>, AutomationError> {
        Ok(None)
    }
    fn bounds(&self) -> Result<(f64, f64, f64, f64), AutomationError> {
        self.bounds.ok_or_else(|| {
            AutomationError::UnsupportedOperation("bounds unavailable for this element".to_string())
        })
    }
    fn click(&self) -> Result<crate::ClickResult, AutomationError> {
        let (x, y, w, h) = self.bounds()?;
        let cx = x + w / 2.0;
        let cy = y + h / 2.0;
        let mut enigo = LinuxEngine::enigo()?;
        enigo
            .move_mouse(cx.round() as i32, cy.round() as i32, enigo::Coordinate::Abs)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to move mouse: {e}")))?;
        enigo
            .button(Button::Left, Direction::Click)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to click: {e}")))?;
        Ok(crate::ClickResult {
            method: "linux:enigo".to_string(),
            coordinates: Some((cx, cy)),
            details: "Clicked center of bounds".to_string(),
        })
    }
    fn double_click(&self) -> Result<crate::ClickResult, AutomationError> {
        let r = self.click()?;
        let mut enigo = LinuxEngine::enigo()?;
        enigo
            .button(Button::Left, Direction::Click)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to double click: {e}")))?;
        Ok(crate::ClickResult { details: "Double clicked center of bounds".to_string(), ..r })
    }
    fn right_click(&self) -> Result<(), AutomationError> {
        let (x, y, w, h) = self.bounds()?;
        let cx = x + w / 2.0;
        let cy = y + h / 2.0;
        let mut enigo = LinuxEngine::enigo()?;
        enigo
            .move_mouse(cx.round() as i32, cy.round() as i32, enigo::Coordinate::Abs)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to move mouse: {e}")))?;
        enigo
            .button(Button::Right, Direction::Click)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to right click: {e}")))?;
        Ok(())
    }
    fn hover(&self) -> Result<(), AutomationError> {
        let (x, y, w, h) = self.bounds()?;
        let cx = x + w / 2.0;
        let cy = y + h / 2.0;
        let mut enigo = LinuxEngine::enigo()?;
        enigo
            .move_mouse(cx.round() as i32, cy.round() as i32, enigo::Coordinate::Abs)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to move mouse: {e}")))?;
        Ok(())
    }
    fn focus(&self) -> Result<(), AutomationError> {
        Ok(())
    }
    fn invoke(&self) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "invoke not implemented on Linux yet".to_string(),
        ))
    }
    fn type_text(
        &self,
        text: &str,
        _use_clipboard: bool,
        _try_focus_before: bool,
        _try_click_before: bool,
        _restore_focus: bool,
    ) -> Result<(), AutomationError> {
        let mut enigo = LinuxEngine::enigo()?;
        enigo
            .text(text)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to type text: {e}")))?;
        Ok(())
    }
    fn press_key(
        &self,
        key: &str,
        _try_focus_before: bool,
        _try_click_before: bool,
        _restore_focus: bool,
    ) -> Result<(), AutomationError> {
        LinuxEngine::send_key_sequence(key)
    }
    fn get_text(&self, _max_depth: usize) -> Result<String, AutomationError> {
        Ok(String::new())
    }
    fn set_value(&self, _value: &str) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "set_value not implemented on Linux yet".to_string(),
        ))
    }
    fn get_value(&self) -> Result<Option<String>, AutomationError> {
        Ok(None)
    }
    fn is_enabled(&self) -> Result<bool, AutomationError> {
        Ok(true)
    }
    fn is_visible(&self) -> Result<bool, AutomationError> {
        Ok(true)
    }
    fn is_focused(&self) -> Result<bool, AutomationError> {
        Ok(false)
    }
    fn perform_action(&self, _action: &str) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "perform_action not implemented on Linux yet".to_string(),
        ))
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
    fn create_locator(&self, _selector: Selector) -> Result<crate::Locator, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "element.locator not implemented on Linux yet".to_string(),
        ))
    }
    fn scroll(&self, direction: &str, amount: f64) -> Result<(), AutomationError> {
        let mut enigo = LinuxEngine::enigo()?;
        let (len, axis) = match direction.to_lowercase().as_str() {
            "up" => (-(amount.round() as i32), Axis::Vertical),
            "down" => (amount.round() as i32, Axis::Vertical),
            "left" => (-(amount.round() as i32), Axis::Horizontal),
            "right" => (amount.round() as i32, Axis::Horizontal),
            _ => {
                return Err(AutomationError::InvalidArgument(format!(
                    "Unknown scroll direction: {direction}"
                )))
            }
        };
        enigo
            .scroll(len, axis)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to scroll: {e}")))?;
        Ok(())
    }
    fn activate_window(&self) -> Result<(), AutomationError> {
        Ok(())
    }
    fn minimize_window(&self) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "minimize_window not implemented on Linux yet".to_string(),
        ))
    }
    fn maximize_window(&self) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "maximize_window not implemented on Linux yet".to_string(),
        ))
    }
    fn maximize_window_keyboard(&self) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "maximize_window_keyboard not implemented on Linux yet".to_string(),
        ))
    }
    fn minimize_window_keyboard(&self) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "minimize_window_keyboard not implemented on Linux yet".to_string(),
        ))
    }
    fn get_native_window_handle(&self) -> Result<isize, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "native window handle not implemented on Linux yet".to_string(),
        ))
    }
    fn clone_box(&self) -> Box<dyn UIElementImpl> {
        Box::new(self.clone())
    }
    fn is_keyboard_focusable(&self) -> Result<bool, AutomationError> {
        Ok(true)
    }
    fn mouse_drag(
        &self,
        start_x: f64,
        start_y: f64,
        end_x: f64,
        end_y: f64,
    ) -> Result<(), AutomationError> {
        let mut enigo = LinuxEngine::enigo()?;
        enigo
            .move_mouse(start_x.round() as i32, start_y.round() as i32, enigo::Coordinate::Abs)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to move mouse: {e}")))?;
        enigo
            .button(Button::Left, Direction::Press)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to press: {e}")))?;
        enigo
            .move_mouse(end_x.round() as i32, end_y.round() as i32, enigo::Coordinate::Abs)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to move mouse: {e}")))?;
        enigo
            .button(Button::Left, Direction::Release)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to release: {e}")))?;
        Ok(())
    }
    fn mouse_click_and_hold(&self, x: f64, y: f64) -> Result<(), AutomationError> {
        let mut enigo = LinuxEngine::enigo()?;
        enigo
            .move_mouse(x.round() as i32, y.round() as i32, enigo::Coordinate::Abs)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to move mouse: {e}")))?;
        enigo
            .button(Button::Left, Direction::Press)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to click and hold: {e}")))?;
        Ok(())
    }
    fn mouse_move(&self, x: f64, y: f64) -> Result<(), AutomationError> {
        let mut enigo = LinuxEngine::enigo()?;
        enigo
            .move_mouse(x.round() as i32, y.round() as i32, enigo::Coordinate::Abs)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to move mouse: {e}")))?;
        Ok(())
    }
    fn mouse_release(&self) -> Result<(), AutomationError> {
        let mut enigo = LinuxEngine::enigo()?;
        enigo
            .button(Button::Left, Direction::Release)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to release: {e}")))?;
        Ok(())
    }
    fn application(&self) -> Result<Option<UIElement>, AutomationError> {
        Ok(None)
    }
    fn window(&self) -> Result<Option<UIElement>, AutomationError> {
        Ok(None)
    }
    fn highlight(
        &self,
        _color: Option<u32>,
        _duration: Option<std::time::Duration>,
        _text: Option<&str>,
        _text_position: Option<crate::TextPosition>,
        _font_style: Option<crate::FontStyle>,
    ) -> Result<crate::HighlightHandle, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "highlight not implemented on Linux yet".to_string(),
        ))
    }
    fn set_transparency(&self, _percentage: u8) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "set_transparency not implemented on Linux yet".to_string(),
        ))
    }
    fn process_id(&self) -> Result<u32, AutomationError> {
        Ok(self.pid)
    }
    fn url(&self) -> Option<String> {
        None
    }
    fn capture(&self) -> Result<crate::ScreenshotResult, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "element.capture not implemented on Linux yet".to_string(),
        ))
    }
    fn close(&self) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "close not implemented on Linux yet".to_string(),
        ))
    }
    fn select_option(&self, _option_name: &str) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "select_option not implemented on Linux yet".to_string(),
        ))
    }
    fn list_options(&self) -> Result<Vec<String>, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "list_options not implemented on Linux yet".to_string(),
        ))
    }
    fn is_toggled(&self) -> Result<bool, AutomationError> {
        Ok(false)
    }
    fn set_toggled(&self, _state: bool) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "set_toggled not implemented on Linux yet".to_string(),
        ))
    }
    fn get_range_value(&self) -> Result<f64, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "get_range_value not implemented on Linux yet".to_string(),
        ))
    }
    fn set_range_value(&self, _value: f64) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "set_range_value not implemented on Linux yet".to_string(),
        ))
    }
    fn is_selected(&self) -> Result<bool, AutomationError> {
        Ok(false)
    }
}

impl UIElementImpl for StubElement {
    fn object_id(&self) -> usize {
        self.object_id
    }
    fn id(&self) -> Option<String> {
        self.id.clone()
    }
    fn role(&self) -> String {
        self.role.clone()
    }
    fn attributes(&self) -> UIElementAttributes {
        self.attrs.clone()
    }
    fn children(&self) -> Result<Vec<UIElement>, AutomationError> {
        Ok(Vec::new())
    }
    fn parent(&self) -> Result<Option<UIElement>, AutomationError> {
        Ok(None)
    }
    fn bounds(&self) -> Result<(f64, f64, f64, f64), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "bounds not supported on Linux stub engine".to_string(),
        ))
    }
    fn click(&self) -> Result<crate::ClickResult, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "click not supported on Linux stub engine".to_string(),
        ))
    }
    fn double_click(&self) -> Result<crate::ClickResult, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "double_click not supported on Linux stub engine".to_string(),
        ))
    }
    fn right_click(&self) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "right_click not supported on Linux stub engine".to_string(),
        ))
    }
    fn hover(&self) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "hover not supported on Linux stub engine".to_string(),
        ))
    }
    fn focus(&self) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "focus not supported on Linux stub engine".to_string(),
        ))
    }
    fn invoke(&self) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "invoke not supported on Linux stub engine".to_string(),
        ))
    }
    fn type_text(
        &self,
        _text: &str,
        _use_clipboard: bool,
        _try_focus_before: bool,
        _try_click_before: bool,
        _restore_focus: bool,
    ) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "type_text not supported on Linux stub engine".to_string(),
        ))
    }
    fn press_key(
        &self,
        _key: &str,
        _try_focus_before: bool,
        _try_click_before: bool,
        _restore_focus: bool,
    ) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "press_key not supported on Linux stub engine".to_string(),
        ))
    }
    fn get_text(&self, _max_depth: usize) -> Result<String, AutomationError> {
        Ok(String::new())
    }
    fn set_value(&self, _value: &str) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "set_value not supported on Linux stub engine".to_string(),
        ))
    }
    fn get_value(&self) -> Result<Option<String>, AutomationError> {
        Ok(None)
    }
    fn is_enabled(&self) -> Result<bool, AutomationError> {
        Ok(true)
    }
    fn is_visible(&self) -> Result<bool, AutomationError> {
        Ok(true)
    }
    fn is_focused(&self) -> Result<bool, AutomationError> {
        Ok(false)
    }
    fn perform_action(&self, _action: &str) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "perform_action not supported on Linux stub engine".to_string(),
        ))
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
    fn create_locator(&self, _selector: Selector) -> Result<crate::Locator, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "element.locator not supported on Linux stub engine".to_string(),
        ))
    }
    fn scroll(&self, _direction: &str, _amount: f64) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "scroll not supported on Linux stub engine".to_string(),
        ))
    }
    fn activate_window(&self) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "activate_window not supported on Linux stub engine".to_string(),
        ))
    }
    fn minimize_window(&self) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "minimize_window not supported on Linux stub engine".to_string(),
        ))
    }
    fn maximize_window(&self) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "maximize_window not supported on Linux stub engine".to_string(),
        ))
    }
    fn maximize_window_keyboard(&self) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "maximize_window_keyboard not supported on Linux stub engine".to_string(),
        ))
    }
    fn minimize_window_keyboard(&self) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "minimize_window_keyboard not supported on Linux stub engine".to_string(),
        ))
    }
    fn get_native_window_handle(&self) -> Result<isize, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "native window handle not supported on Linux stub engine".to_string(),
        ))
    }
    fn clone_box(&self) -> Box<dyn UIElementImpl> {
        Box::new(self.clone())
    }
    fn is_keyboard_focusable(&self) -> Result<bool, AutomationError> {
        Ok(false)
    }
    fn mouse_drag(
        &self,
        _start_x: f64,
        _start_y: f64,
        _end_x: f64,
        _end_y: f64,
    ) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "mouse_drag not supported on Linux stub engine".to_string(),
        ))
    }
    fn mouse_click_and_hold(&self, _x: f64, _y: f64) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "mouse_click_and_hold not supported on Linux stub engine".to_string(),
        ))
    }
    fn mouse_move(&self, _x: f64, _y: f64) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "mouse_move not supported on Linux stub engine".to_string(),
        ))
    }
    fn mouse_release(&self) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "mouse_release not supported on Linux stub engine".to_string(),
        ))
    }
    fn application(&self) -> Result<Option<UIElement>, AutomationError> {
        Ok(None)
    }
    fn window(&self) -> Result<Option<UIElement>, AutomationError> {
        Ok(None)
    }
    fn highlight(
        &self,
        _color: Option<u32>,
        _duration: Option<std::time::Duration>,
        _text: Option<&str>,
        _text_position: Option<crate::TextPosition>,
        _font_style: Option<crate::FontStyle>,
    ) -> Result<crate::HighlightHandle, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "highlight not supported on Linux stub engine".to_string(),
        ))
    }
    fn set_transparency(&self, _percentage: u8) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "set_transparency not supported on Linux stub engine".to_string(),
        ))
    }
    fn process_id(&self) -> Result<u32, AutomationError> {
        Ok(self.pid)
    }
    fn capture(&self) -> Result<crate::ScreenshotResult, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "element.capture not supported on Linux stub engine".to_string(),
        ))
    }
    fn close(&self) -> Result<(), AutomationError> {
        Ok(())
    }
    fn url(&self) -> Option<String> {
        self.url.clone()
    }
    fn select_option(&self, _option_name: &str) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "select_option not supported on Linux stub engine".to_string(),
        ))
    }
    fn list_options(&self) -> Result<Vec<String>, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "list_options not supported on Linux stub engine".to_string(),
        ))
    }
    fn is_toggled(&self) -> Result<bool, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "is_toggled not supported on Linux stub engine".to_string(),
        ))
    }
    fn set_toggled(&self, _state: bool) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "set_toggled not supported on Linux stub engine".to_string(),
        ))
    }
    fn get_range_value(&self) -> Result<f64, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "get_range_value not supported on Linux stub engine".to_string(),
        ))
    }
    fn set_range_value(&self, _value: f64) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "set_range_value not supported on Linux stub engine".to_string(),
        ))
    }
    fn is_selected(&self) -> Result<bool, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "is_selected not supported on Linux stub engine".to_string(),
        ))
    }
    fn set_selected(&self, _state: bool) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "set_selected not supported on Linux stub engine".to_string(),
        ))
    }
}

// =============================================================================
// AT-SPI2 Element Implementation
// =============================================================================

/// Information cached from an AT-SPI2 accessible object
#[derive(Clone)]
struct ATSPIElementInfo {
    object_id: usize,
    bus_name: String,
    path: String,
    name: String,
    role: String,
    pid: u32,
    bounds: Option<(f64, f64, f64, f64)>,
    states: HashSet<String>,
}

/// Wrapper around an AT-SPI2 accessible object reference
#[derive(Clone)]
pub struct LinuxATSPIElement {
    info: ATSPIElementInfo,
    connection: Arc<ZbusConnection>,
}

impl fmt::Debug for LinuxATSPIElement {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LinuxATSPIElement")
            .field("name", &self.info.name)
            .field("role", &self.info.role)
            .field("pid", &self.info.pid)
            .field("path", &self.info.path)
            .finish()
    }
}

// SAFETY: AT-SPI2 D-Bus connections are thread-safe via zbus's async runtime
unsafe impl Send for LinuxATSPIElement {}
unsafe impl Sync for LinuxATSPIElement {}

impl LinuxATSPIElement {
    /// Create an element from AT-SPI2 proxy info
    async fn from_proxy(
        proxy: &AccessibleProxy<'_>,
        connection: Arc<ZbusConnection>,
    ) -> Result<Self, AutomationError> {
        let object_id = NEXT_OBJECT_ID.fetch_add(1, Ordering::Relaxed);
        
        let name = proxy.name().await.unwrap_or_default();
        let role = proxy.get_role().await
            .map(|r| format!("{:?}", r))
            .unwrap_or_else(|_| "Unknown".to_string());
        
        // Get PID from application
        let pid = proxy.get_application().await
            .ok()
            .and_then(|app_ref| {
                // Try to get PID from the application accessible
                // This is a best-effort approach
                0u32.into()
            })
            .unwrap_or(0);
        
        // Get bounds via Component interface
        let bounds = Self::get_bounds_from_proxy(proxy).await;
        
        // Get states
        let states = proxy.get_state().await
            .map(|state_set| {
                // Convert state set to HashSet of state names
                let mut states = HashSet::new();
                // AT-SPI2 states are bit flags, convert to readable names
                states
            })
            .unwrap_or_default();
        
        let bus_name = proxy.inner().destination().to_string();
        let path = proxy.inner().path().to_string();
        
        Ok(Self {
            info: ATSPIElementInfo {
                object_id,
                bus_name,
                path,
                name,
                role,
                pid,
                bounds,
                states,
            },
            connection,
        })
    }
    
    async fn get_bounds_from_proxy(proxy: &AccessibleProxy<'_>) -> Option<(f64, f64, f64, f64)> {
        // AT-SPI2 uses the Component interface for geometry
        // We need to query the component interface for extents
        use atspi::proxy::component::ComponentProxy;
        
        let conn = proxy.inner().connection();
        let dest = proxy.inner().destination().to_string();
        let path = proxy.inner().path().to_string();
        
        let component = ComponentProxy::builder(conn)
            .destination(dest.as_str())
            .ok()?
            .path(path.as_str())
            .ok()?
            .build()
            .await
            .ok()?;
        
        // Get extents in screen coordinates
        let extents = component.get_extents(atspi::CoordType::Screen).await.ok()?;
        
        Some((
            extents.x as f64,
            extents.y as f64,
            extents.width as f64,
            extents.height as f64,
        ))
    }
    
    fn click_center_with_enigo(&self) -> Result<crate::ClickResult, AutomationError> {
        let (x, y, w, h) = self.info.bounds.ok_or_else(|| {
            AutomationError::UnsupportedOperation("bounds unavailable for element".to_string())
        })?;
        let cx = x + w / 2.0;
        let cy = y + h / 2.0;
        
        let mut enigo = LinuxEngine::enigo()?;
        enigo
            .move_mouse(cx.round() as i32, cy.round() as i32, enigo::Coordinate::Abs)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to move mouse: {e}")))?;
        enigo
            .button(Button::Left, Direction::Click)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to click: {e}")))?;
        
        Ok(crate::ClickResult {
            method: "linux:atspi:enigo".to_string(),
            coordinates: Some((cx, cy)),
            details: "Clicked center of AT-SPI2 element bounds".to_string(),
        })
    }
}

impl UIElementImpl for LinuxATSPIElement {
    fn object_id(&self) -> usize {
        self.info.object_id
    }
    
    fn id(&self) -> Option<String> {
        Some(format!("atspi:{}:{}", self.info.bus_name, self.info.path))
    }
    
    fn role(&self) -> String {
        self.info.role.clone()
    }
    
    fn attributes(&self) -> UIElementAttributes {
        let mut attrs = UIElementAttributes::default();
        attrs.role = self.info.role.clone();
        attrs.name = Some(self.info.name.clone());
        attrs
    }
    
    fn children(&self) -> Result<Vec<UIElement>, AutomationError> {
        // Children require async - return empty for now, use tree building instead
        Ok(Vec::new())
    }
    
    fn parent(&self) -> Result<Option<UIElement>, AutomationError> {
        Ok(None)
    }
    
    fn bounds(&self) -> Result<(f64, f64, f64, f64), AutomationError> {
        self.info.bounds.ok_or_else(|| {
            AutomationError::UnsupportedOperation("bounds unavailable for element".to_string())
        })
    }
    
    fn click(&self) -> Result<crate::ClickResult, AutomationError> {
        self.click_center_with_enigo()
    }
    
    fn double_click(&self) -> Result<crate::ClickResult, AutomationError> {
        let r = self.click()?;
        let mut enigo = LinuxEngine::enigo()?;
        enigo
            .button(Button::Left, Direction::Click)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to double click: {e}")))?;
        Ok(crate::ClickResult { details: "Double clicked AT-SPI2 element".to_string(), ..r })
    }
    
    fn right_click(&self) -> Result<(), AutomationError> {
        let (x, y, w, h) = self.bounds()?;
        let cx = x + w / 2.0;
        let cy = y + h / 2.0;
        let mut enigo = LinuxEngine::enigo()?;
        enigo
            .move_mouse(cx.round() as i32, cy.round() as i32, enigo::Coordinate::Abs)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to move mouse: {e}")))?;
        enigo
            .button(Button::Right, Direction::Click)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to right click: {e}")))?;
        Ok(())
    }
    
    fn hover(&self) -> Result<(), AutomationError> {
        let (x, y, w, h) = self.bounds()?;
        let cx = x + w / 2.0;
        let cy = y + h / 2.0;
        let mut enigo = LinuxEngine::enigo()?;
        enigo
            .move_mouse(cx.round() as i32, cy.round() as i32, enigo::Coordinate::Abs)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to move mouse: {e}")))?;
        Ok(())
    }
    
    fn focus(&self) -> Result<(), AutomationError> {
        // AT-SPI2 has a FocusGrab action on some elements
        Ok(())
    }
    
    fn invoke(&self) -> Result<(), AutomationError> {
        // AT-SPI2 Action interface - would need async
        Err(AutomationError::UnsupportedOperation(
            "invoke via AT-SPI2 Action not implemented yet".to_string(),
        ))
    }
    
    fn type_text(
        &self,
        text: &str,
        _use_clipboard: bool,
        _try_focus_before: bool,
        _try_click_before: bool,
        _restore_focus: bool,
    ) -> Result<(), AutomationError> {
        let mut enigo = LinuxEngine::enigo()?;
        enigo.text(text).map_err(|e| {
            AutomationError::PlatformError(format!("Failed to type text: {e}"))
        })?;
        Ok(())
    }
    
    fn press_key(
        &self,
        key: &str,
        _try_focus_before: bool,
        _try_click_before: bool,
        _restore_focus: bool,
    ) -> Result<(), AutomationError> {
        LinuxEngine::send_key_sequence(key)
    }
    
    fn get_text(&self, _max_depth: usize) -> Result<String, AutomationError> {
        // AT-SPI2 Text interface - would need async
        Ok(self.info.name.clone())
    }
    
    fn set_value(&self, _value: &str) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "set_value via AT-SPI2 not implemented yet".to_string(),
        ))
    }
    
    fn get_value(&self) -> Result<Option<String>, AutomationError> {
        Ok(Some(self.info.name.clone()))
    }
    
    fn is_enabled(&self) -> Result<bool, AutomationError> {
        Ok(!self.info.states.contains("disabled"))
    }
    
    fn is_visible(&self) -> Result<bool, AutomationError> {
        Ok(self.info.states.contains("visible") || self.info.states.contains("showing"))
    }
    
    fn is_focused(&self) -> Result<bool, AutomationError> {
        Ok(self.info.states.contains("focused"))
    }
    
    fn perform_action(&self, _action: &str) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "perform_action via AT-SPI2 not implemented yet".to_string(),
        ))
    }
    
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
    
    fn create_locator(&self, _selector: Selector) -> Result<crate::Locator, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "element.locator not implemented for AT-SPI2 yet".to_string(),
        ))
    }
    
    fn scroll(&self, direction: &str, amount: f64) -> Result<(), AutomationError> {
        let mut enigo = LinuxEngine::enigo()?;
        let (len, axis) = match direction.to_lowercase().as_str() {
            "up" => (-(amount.round() as i32), Axis::Vertical),
            "down" => (amount.round() as i32, Axis::Vertical),
            "left" => (-(amount.round() as i32), Axis::Horizontal),
            "right" => (amount.round() as i32, Axis::Horizontal),
            _ => {
                return Err(AutomationError::InvalidArgument(format!(
                    "Unknown scroll direction: {direction}"
                )))
            }
        };
        enigo.scroll(len, axis).map_err(|e| {
            AutomationError::PlatformError(format!("Failed to scroll: {e}"))
        })?;
        Ok(())
    }
    
    fn activate_window(&self) -> Result<(), AutomationError> {
        Ok(())
    }
    
    fn minimize_window(&self) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "minimize_window not implemented for AT-SPI2 yet".to_string(),
        ))
    }
    
    fn maximize_window(&self) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "maximize_window not implemented for AT-SPI2 yet".to_string(),
        ))
    }
    
    fn maximize_window_keyboard(&self) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "maximize_window_keyboard not implemented for AT-SPI2 yet".to_string(),
        ))
    }
    
    fn minimize_window_keyboard(&self) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "minimize_window_keyboard not implemented for AT-SPI2 yet".to_string(),
        ))
    }
    
    fn get_native_window_handle(&self) -> Result<isize, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "native window handle not available for AT-SPI2".to_string(),
        ))
    }
    
    fn clone_box(&self) -> Box<dyn UIElementImpl> {
        Box::new(self.clone())
    }
    
    fn is_keyboard_focusable(&self) -> Result<bool, AutomationError> {
        Ok(self.info.states.contains("focusable"))
    }
    
    fn mouse_drag(
        &self,
        start_x: f64,
        start_y: f64,
        end_x: f64,
        end_y: f64,
    ) -> Result<(), AutomationError> {
        let mut enigo = LinuxEngine::enigo()?;
        enigo
            .move_mouse(start_x.round() as i32, start_y.round() as i32, enigo::Coordinate::Abs)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to move mouse: {e}")))?;
        enigo
            .button(Button::Left, Direction::Press)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to press: {e}")))?;
        enigo
            .move_mouse(end_x.round() as i32, end_y.round() as i32, enigo::Coordinate::Abs)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to move mouse: {e}")))?;
        enigo
            .button(Button::Left, Direction::Release)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to release: {e}")))?;
        Ok(())
    }
    
    fn mouse_click_and_hold(&self, x: f64, y: f64) -> Result<(), AutomationError> {
        let mut enigo = LinuxEngine::enigo()?;
        enigo
            .move_mouse(x.round() as i32, y.round() as i32, enigo::Coordinate::Abs)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to move mouse: {e}")))?;
        enigo
            .button(Button::Left, Direction::Press)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to click and hold: {e}")))?;
        Ok(())
    }
    
    fn mouse_move(&self, x: f64, y: f64) -> Result<(), AutomationError> {
        let mut enigo = LinuxEngine::enigo()?;
        enigo
            .move_mouse(x.round() as i32, y.round() as i32, enigo::Coordinate::Abs)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to move mouse: {e}")))?;
        Ok(())
    }
    
    fn mouse_release(&self) -> Result<(), AutomationError> {
        let mut enigo = LinuxEngine::enigo()?;
        enigo
            .button(Button::Left, Direction::Release)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to release: {e}")))?;
        Ok(())
    }
    
    fn application(&self) -> Result<Option<UIElement>, AutomationError> {
        Ok(None)
    }
    
    fn window(&self) -> Result<Option<UIElement>, AutomationError> {
        Ok(None)
    }
    
    fn highlight(
        &self,
        _color: Option<u32>,
        _duration: Option<Duration>,
        _text: Option<&str>,
        _text_position: Option<crate::TextPosition>,
        _font_style: Option<crate::FontStyle>,
    ) -> Result<crate::HighlightHandle, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "highlight not implemented for AT-SPI2 yet".to_string(),
        ))
    }
    
    fn set_transparency(&self, _percentage: u8) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "set_transparency not implemented for AT-SPI2 yet".to_string(),
        ))
    }
    
    fn process_id(&self) -> Result<u32, AutomationError> {
        Ok(self.info.pid)
    }
    
    fn url(&self) -> Option<String> {
        None
    }
    
    fn capture(&self) -> Result<crate::ScreenshotResult, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "element.capture not implemented for AT-SPI2 yet".to_string(),
        ))
    }
    
    fn close(&self) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "close not implemented for AT-SPI2 yet".to_string(),
        ))
    }
    
    fn select_option(&self, _option_name: &str) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "select_option not implemented for AT-SPI2 yet".to_string(),
        ))
    }
    
    fn list_options(&self) -> Result<Vec<String>, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "list_options not implemented for AT-SPI2 yet".to_string(),
        ))
    }
    
    fn is_toggled(&self) -> Result<bool, AutomationError> {
        Ok(self.info.states.contains("checked") || self.info.states.contains("pressed"))
    }
    
    fn set_toggled(&self, _state: bool) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "set_toggled not implemented for AT-SPI2 yet".to_string(),
        ))
    }
    
    fn get_range_value(&self) -> Result<f64, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "get_range_value not implemented for AT-SPI2 yet".to_string(),
        ))
    }
    
    fn set_range_value(&self, _value: f64) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "set_range_value not implemented for AT-SPI2 yet".to_string(),
        ))
    }
    
    fn is_selected(&self) -> Result<bool, AutomationError> {
        Ok(self.info.states.contains("selected"))
    }
    
    fn set_selected(&self, _state: bool) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "set_selected not implemented for AT-SPI2 yet".to_string(),
        ))
    }
}

// =============================================================================
// AT-SPI2 Tree Walker and Selector Matching
// =============================================================================

/// Check if an AT-SPI2 element matches a selector
fn atspi_matches_selector(info: &ATSPIElementInfo, selector: &Selector) -> bool {
    match selector {
        Selector::Role { role, name } => {
            let role_match = info.role.eq_ignore_ascii_case(role)
                || info.role.to_lowercase().contains(&role.to_lowercase());
            let name_match = name.as_ref().map_or(true, |n| {
                info.name.eq_ignore_ascii_case(n)
                    || info.name.to_lowercase().contains(&n.to_lowercase())
            });
            role_match && name_match
        }
        Selector::Name(name) => {
            info.name.eq_ignore_ascii_case(name)
                || info.name.to_lowercase().contains(&name.to_lowercase())
        }
        Selector::Id(id) | Selector::NativeId(id) => {
            info.path.contains(id)
        }
        Selector::Text(text) => {
            info.name.to_lowercase().contains(&text.to_lowercase())
        }
        Selector::And(selectors) => {
            selectors.iter().all(|s| atspi_matches_selector(info, s))
        }
        Selector::Or(selectors) => {
            selectors.iter().any(|s| atspi_matches_selector(info, s))
        }
        Selector::Not(inner) => {
            !atspi_matches_selector(info, inner)
        }
        Selector::Chain(parts) => {
            // For chain selectors, we only match the first part at this level
            parts.first().map_or(false, |first| atspi_matches_selector(info, first))
        }
        // Not yet supported for AT-SPI2
        Selector::Path(_)
        | Selector::Attributes(_)
        | Selector::Filter(_)
        | Selector::ClassName(_)
        | Selector::Visible(_)
        | Selector::LocalizedRole(_)
        | Selector::Process(_)
        | Selector::RightOf(_)
        | Selector::LeftOf(_)
        | Selector::Above(_)
        | Selector::Below(_)
        | Selector::Near(_)
        | Selector::Nth(_)
        | Selector::Has(_)
        | Selector::Parent
        | Selector::Invalid(_) => false,
    }
}

/// Build a UINode tree from an AT-SPI2 accessible
async fn build_atspi_tree(
    proxy: &AccessibleProxy<'_>,
    connection: Arc<ZbusConnection>,
    config: &TreeBuildConfig,
    depth: usize,
) -> Result<UINode, AutomationError> {
    let element = LinuxATSPIElement::from_proxy(proxy, connection.clone()).await?;
    
    let mut children_nodes = Vec::new();
    
    if depth < config.max_depth.unwrap_or(10) {
        // Get children count
        if let Ok(child_count) = proxy.child_count().await {
            for i in 0..child_count {
                if let Ok(child_ref) = proxy.get_child_at_index(i).await {
                    let child_proxy = AccessibleProxy::builder(&*connection)
                        .destination(child_ref.name.as_str())
                        .ok()
                        .and_then(|b| b.path(child_ref.path.as_str()).ok());
                    
                    if let Some(builder) = child_proxy {
                        if let Ok(child_proxy) = builder.build().await {
                            if let Ok(child_node) = Box::pin(build_atspi_tree(
                                &child_proxy,
                                connection.clone(),
                                config,
                                depth + 1,
                            )).await {
                                children_nodes.push(child_node);
                            }
                        }
                    }
                }
            }
        }
    }
    
    let mut attrs = UIElementAttributes::default();
    attrs.role = element.info.role.clone();
    attrs.name = Some(element.info.name.clone());
    attrs.bounds = element.info.bounds;
    
    Ok(UINode {
        id: element.id(),
        attributes: attrs,
        children: children_nodes,
        selector: None,
    })
}

/// Find elements matching a selector in the AT-SPI2 tree
async fn find_atspi_elements(
    proxy: &AccessibleProxy<'_>,
    connection: Arc<ZbusConnection>,
    selector: &Selector,
    results: &mut Vec<LinuxATSPIElement>,
    max_results: Option<usize>,
    depth: usize,
    max_depth: usize,
) -> Result<(), AutomationError> {
    if max_results.map_or(false, |max| results.len() >= max) {
        return Ok(());
    }
    
    let element = LinuxATSPIElement::from_proxy(proxy, connection.clone()).await?;
    
    if atspi_matches_selector(&element.info, selector) {
        results.push(element);
        if max_results.map_or(false, |max| results.len() >= max) {
            return Ok(());
        }
    }
    
    if depth < max_depth {
        if let Ok(child_count) = proxy.child_count().await {
            for i in 0..child_count {
                if let Ok(child_ref) = proxy.get_child_at_index(i).await {
                    let child_proxy = AccessibleProxy::builder(&*connection)
                        .destination(child_ref.name.as_str())
                        .ok()
                        .and_then(|b| b.path(child_ref.path.as_str()).ok());
                    
                    if let Some(builder) = child_proxy {
                        if let Ok(child_proxy) = builder.build().await {
                            Box::pin(find_atspi_elements(
                                &child_proxy,
                                connection.clone(),
                                selector,
                                results,
                                max_results,
                                depth + 1,
                                max_depth,
                            )).await?;
                        }
                    }
                }
            }
        }
    }
    
    Ok(())
}

pub struct LinuxEngine {
    _use_background_apps: bool,
    _activate_app: bool,
}

impl LinuxEngine {
    pub fn new(use_background_apps: bool, activate_app: bool) -> Result<Self, AutomationError> {
        Ok(Self {
            _use_background_apps: use_background_apps,
            _activate_app: activate_app,
        })
    }

    fn root_element(&self) -> UIElement {
        UIElement::new(Box::new(StubElement::new("Desktop", Some("Linux".to_string()))))
    }

    fn monitor_list(&self) -> Result<Vec<xcap::Monitor>, AutomationError> {
        xcap::Monitor::all()
            .map_err(|e| AutomationError::PlatformError(format!("Failed to enumerate monitors: {e}")))
    }

    fn enigo() -> Result<Enigo, AutomationError> {
        Enigo::new(&Settings::default()).map_err(|e| {
            AutomationError::PlatformError(format!("Failed to initialize input backend: {e}"))
        })
    }

    fn send_key_sequence(key: &str) -> Result<(), AutomationError> {
        // Minimal SendKeys-ish parser; see macOS implementation for semantics.
        let mut enigo = Self::enigo()?;
        let mut held_mods: Vec<Key> = Vec::new();

        let mut i = 0usize;
        let bytes = key.as_bytes();
        while i < bytes.len() {
            if bytes[i] == b'{' {
                let mut end = i + 1;
                while end < bytes.len() && bytes[end] != b'}' {
                    end += 1;
                }
                if end >= bytes.len() {
                    return Err(AutomationError::InvalidArgument(format!(
                        "Invalid key sequence (missing '}}'): {key}"
                    )));
                }
                let token = &key[i + 1..end];
                let token_norm = token.trim().to_lowercase();

                let maybe_key = match token_norm.as_str() {
                    "ctrl" | "control" => Some(Key::Control),
                    "alt" => Some(Key::Alt),
                    "shift" => Some(Key::Shift),
                    "meta" | "super" | "win" => Some(Key::Meta),
                    "enter" | "return" => Some(Key::Return),
                    "tab" => Some(Key::Tab),
                    "esc" | "escape" => Some(Key::Escape),
                    "backspace" => Some(Key::Backspace),
                    "delete" | "del" => Some(Key::Delete),
                    "space" => Some(Key::Space),
                    "up" => Some(Key::UpArrow),
                    "down" => Some(Key::DownArrow),
                    "left" => Some(Key::LeftArrow),
                    "right" => Some(Key::RightArrow),
                    "home" => Some(Key::Home),
                    "end" => Some(Key::End),
                    "pageup" => Some(Key::PageUp),
                    "pagedown" => Some(Key::PageDown),
                    _ => None,
                };

                if let Some(k) = maybe_key {
                    let is_modifier = matches!(k, Key::Control | Key::Alt | Key::Shift | Key::Meta);
                    if is_modifier {
                        enigo.key(k, Direction::Press).map_err(|e| {
                            AutomationError::PlatformError(format!("Failed to press modifier: {e}"))
                        })?;
                        held_mods.push(k);
                    } else {
                        enigo.key(k, Direction::Click).map_err(|e| {
                            AutomationError::PlatformError(format!("Failed to press key: {e}"))
                        })?;
                        for m in held_mods.drain(..).rev() {
                            let _ = enigo.key(m, Direction::Release);
                        }
                    }
                } else {
                    return Err(AutomationError::InvalidArgument(format!(
                        "Unknown key token: {{{token}}}"
                    )));
                }

                i = end + 1;
                continue;
            }

            let ch = key[i..].chars().next().ok_or_else(|| {
                AutomationError::InvalidArgument("Invalid UTF-8 in key sequence".to_string())
            })?;
            let s = ch.to_string();
            enigo.text(&s).map_err(|e| {
                AutomationError::PlatformError(format!("Failed to type text: {e}"))
            })?;

            for m in held_mods.drain(..).rev() {
                let _ = enigo.key(m, Direction::Release);
            }

            i += ch.len_utf8();
        }

        for m in held_mods.drain(..).rev() {
            let _ = enigo.key(m, Direction::Release);
        }
        Ok(())
    }

    fn has_gui_session() -> bool {
        std::env::var("DISPLAY").is_ok() || std::env::var("WAYLAND_DISPLAY").is_ok()
    }

    fn command_exists(cmd: &str) -> bool {
        std::process::Command::new(cmd)
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok()
    }

    fn list_windows_best_effort(&self) -> Result<Vec<LinuxWindowInfo>, AutomationError> {
        if !Self::has_gui_session() {
            return Err(AutomationError::UnsupportedOperation(
                "No GUI session detected (DISPLAY/WAYLAND_DISPLAY not set)".to_string(),
            ));
        }

        // Prefer wmctrl if available (X11).
        if !Self::command_exists("wmctrl") {
            return Err(AutomationError::UnsupportedOperation(
                "wmctrl not available (install wmctrl for window enumeration)".to_string(),
            ));
        }

        let output = std::process::Command::new("wmctrl")
            .args(["-lpG"])
            .stdin(Stdio::null())
            .output()
            .map_err(|e| AutomationError::PlatformError(format!("Failed to run wmctrl: {e}")))?;

        if !output.status.success() {
            return Err(AutomationError::PlatformError(
                "wmctrl returned non-zero exit status".to_string(),
            ));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);

        // Map pid -> process name (best-effort).
        let mut system = sysinfo::System::new();
        system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

        let mut out: Vec<LinuxWindowInfo> = Vec::new();
        for line in stdout.lines() {
            // wmctrl -lpG format:
            // 0x01200007  0  1234  10  20  800  600  host  Window Title
            let mut parts = line.split_whitespace();
            let window_id = match parts.next() {
                Some(v) => v.to_string(),
                None => continue,
            };
            let _desktop = parts.next();
            let pid = match parts.next().and_then(|p| p.parse::<u32>().ok()) {
                Some(p) => p,
                None => continue,
            };
            let x = parts.next().and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
            let y = parts.next().and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
            let w = parts.next().and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
            let h = parts.next().and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
            // host
            let _host = parts.next();
            let title = parts.collect::<Vec<&str>>().join(" ");
            if title.is_empty() || w <= 1.0 || h <= 1.0 {
                continue;
            }

            let process_name = system
                .process(sysinfo::Pid::from_u32(pid))
                .map(|p| p.name().to_string_lossy().to_string());

            out.push(LinuxWindowInfo {
                window_id,
                pid,
                title,
                bounds: (x, y, w, h),
                process_name,
            });
        }

        Ok(out)
    }

    fn get_active_window_best_effort(&self) -> Result<LinuxWindowInfo, AutomationError> {
        if !Self::has_gui_session() {
            return Err(AutomationError::UnsupportedOperation(
                "No GUI session detected (DISPLAY/WAYLAND_DISPLAY not set)".to_string(),
            ));
        }
        if !Self::command_exists("xdotool") {
            return Err(AutomationError::UnsupportedOperation(
                "xdotool not available (install xdotool for active window detection)".to_string(),
            ));
        }

        // Get active window id
        let wid_out = std::process::Command::new("xdotool")
            .args(["getactivewindow"])
            .stdin(Stdio::null())
            .output()
            .map_err(|e| AutomationError::PlatformError(format!("Failed to run xdotool: {e}")))?;
        if !wid_out.status.success() {
            return Err(AutomationError::PlatformError(
                "xdotool getactivewindow failed".to_string(),
            ));
        }
        let wid = String::from_utf8_lossy(&wid_out.stdout).trim().to_string();

        // Title
        let title_out = std::process::Command::new("xdotool")
            .args(["getwindowname", &wid])
            .stdin(Stdio::null())
            .output()
            .map_err(|e| AutomationError::PlatformError(format!("Failed to run xdotool: {e}")))?;
        let title = String::from_utf8_lossy(&title_out.stdout).trim().to_string();

        // PID
        let pid_out = std::process::Command::new("xdotool")
            .args(["getwindowpid", &wid])
            .stdin(Stdio::null())
            .output()
            .map_err(|e| AutomationError::PlatformError(format!("Failed to run xdotool: {e}")))?;
        let pid = String::from_utf8_lossy(&pid_out.stdout)
            .trim()
            .parse::<u32>()
            .unwrap_or(0);

        // Geometry
        let geom_out = std::process::Command::new("xdotool")
            .args(["getwindowgeometry", "--shell", &wid])
            .stdin(Stdio::null())
            .output()
            .map_err(|e| AutomationError::PlatformError(format!("Failed to run xdotool: {e}")))?;
        let geom = String::from_utf8_lossy(&geom_out.stdout);
        let mut x = 0.0;
        let mut y = 0.0;
        let mut w = 0.0;
        let mut h = 0.0;
        for ln in geom.lines() {
            if let Some(v) = ln.strip_prefix("X=") {
                x = v.parse::<f64>().unwrap_or(0.0);
            } else if let Some(v) = ln.strip_prefix("Y=") {
                y = v.parse::<f64>().unwrap_or(0.0);
            } else if let Some(v) = ln.strip_prefix("WIDTH=") {
                w = v.parse::<f64>().unwrap_or(0.0);
            } else if let Some(v) = ln.strip_prefix("HEIGHT=") {
                h = v.parse::<f64>().unwrap_or(0.0);
            }
        }

        // pid -> process name
        let mut system = sysinfo::System::new();
        system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        let process_name = system
            .process(sysinfo::Pid::from_u32(pid))
            .map(|p| p.name().to_string_lossy().to_string());

        Ok(LinuxWindowInfo {
            window_id: wid,
            pid,
            title,
            bounds: (x, y, w, h),
            process_name,
        })
    }
    
    // =========================================================================
    // AT-SPI2 Async Helpers
    // =========================================================================
    
    /// Connect to the AT-SPI2 accessibility bus
    async fn connect_atspi() -> Result<Arc<ZbusConnection>, AutomationError> {
        let connection = AccessibilityConnection::new()
            .await
            .map_err(|e| AutomationError::PlatformError(format!("Failed to connect to AT-SPI2: {e}")))?;
        
        Ok(Arc::new(connection.into()))
    }
    
    /// Get the desktop root accessible from AT-SPI2 registry
    async fn get_atspi_desktop(connection: &ZbusConnection) -> Result<AccessibleProxy<'_>, AutomationError> {
        // AT-SPI2 registry path
        let proxy = AccessibleProxy::builder(connection)
            .destination("org.a11y.atspi.Registry")
            .map_err(|e| AutomationError::PlatformError(format!("Failed to set destination: {e}")))?
            .path("/org/a11y/atspi/accessible/root")
            .map_err(|e| AutomationError::PlatformError(format!("Failed to set path: {e}")))?
            .build()
            .await
            .map_err(|e| AutomationError::PlatformError(format!("Failed to build registry proxy: {e}")))?;
        
        Ok(proxy)
    }
    
    /// Find a single element via AT-SPI2
    async fn find_element_atspi(selector: &Selector) -> Result<UIElement, AutomationError> {
        let connection = Self::connect_atspi().await?;
        let desktop = Self::get_atspi_desktop(&connection).await?;
        
        let mut results = Vec::new();
        find_atspi_elements(&desktop, connection.clone(), selector, &mut results, Some(1), 0, 15).await?;
        
        results.into_iter().next()
            .map(|el| UIElement::new(Box::new(el)))
            .ok_or_else(|| AutomationError::ElementNotFound(format!("No element found for selector: {:?}", selector)))
    }
    
    /// Find all matching elements via AT-SPI2
    async fn find_elements_atspi(selector: &Selector, max_depth: usize) -> Result<Vec<UIElement>, AutomationError> {
        let connection = Self::connect_atspi().await?;
        let desktop = Self::get_atspi_desktop(&connection).await?;
        
        let mut results = Vec::new();
        find_atspi_elements(&desktop, connection.clone(), selector, &mut results, None, 0, max_depth).await?;
        
        Ok(results.into_iter().map(|el| UIElement::new(Box::new(el))).collect())
    }
    
    /// Build window tree via AT-SPI2
    async fn build_window_tree_atspi(pid: u32, title: Option<&str>, config: &TreeBuildConfig) -> Result<UINode, AutomationError> {
        let connection = Self::connect_atspi().await?;
        let desktop = Self::get_atspi_desktop(&connection).await?;
        
        // Find matching application/window by PID or title
        let child_count = desktop.child_count().await.unwrap_or(0);
        
        for i in 0..child_count {
            if let Ok(child_ref) = desktop.get_child_at_index(i).await {
                let child_proxy = AccessibleProxy::builder(&*connection)
                    .destination(child_ref.name.as_str())
                    .ok()
                    .and_then(|b| b.path(child_ref.path.as_str()).ok());
                
                if let Some(builder) = child_proxy {
                    if let Ok(app_proxy) = builder.build().await {
                        // Check if this app matches our criteria
                        let app_name = app_proxy.name().await.unwrap_or_default();
                        
                        // Check title match
                        let title_matches = title.map_or(true, |t| {
                            app_name.to_lowercase().contains(&t.to_lowercase())
                        });
                        
                        // For PID matching, we'd need to query the application's PID
                        // via the Application interface - this is a simplification
                        let pid_matches = pid == 0 || title_matches;
                        
                        if pid_matches && title_matches {
                            return build_atspi_tree(&app_proxy, connection.clone(), config, 0).await;
                        }
                    }
                }
            }
        }
        
        Err(AutomationError::ElementNotFound(format!(
            "No application found with pid={} title={:?}",
            pid,
            title
        )))
    }
}

#[async_trait::async_trait]
impl AccessibilityEngine for LinuxEngine {
    fn get_root_element(&self) -> UIElement {
        self.root_element()
    }

    fn get_element_by_id(&self, _id: i32) -> Result<UIElement, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "get_element_by_id not supported on Linux stub engine".to_string(),
        ))
    }

    fn get_focused_element(&self) -> Result<UIElement, AutomationError> {
        let info = self.get_active_window_best_effort()?;
        Ok(UIElement::new(Box::new(LinuxUIElement::new_window(info))))
    }

    fn get_applications(&self) -> Result<Vec<UIElement>, AutomationError> {
        let windows = self.list_windows_best_effort()?;
        Ok(windows
            .into_iter()
            .map(|w| UIElement::new(Box::new(LinuxUIElement::new_window(w))))
            .collect())
    }

    fn get_application_by_name(&self, _name: &str) -> Result<UIElement, AutomationError> {
        let needle = _name.to_lowercase();
        let windows = self.list_windows_best_effort()?;
        for w in windows {
            let title_lc = w.title.to_lowercase();
            let proc_lc = w
                .process_name
                .clone()
                .unwrap_or_default()
                .to_lowercase();
            if title_lc.contains(&needle) || proc_lc.contains(&needle) {
                return Ok(UIElement::new(Box::new(LinuxUIElement::new_window(w))));
            }
        }
        Err(AutomationError::ElementNotFound(format!(
            "No matching application/window for '{_name}'"
        )))
    }

    fn get_application_by_pid(
        &self,
        _pid: i32,
        _timeout: Option<Duration>,
    ) -> Result<UIElement, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "get_application_by_pid not supported on Linux stub engine".to_string(),
        ))
    }

    fn find_element(
        &self,
        selector: &Selector,
        _root: Option<&UIElement>,
        timeout: Option<Duration>,
    ) -> Result<UIElement, AutomationError> {
        if !Self::has_gui_session() {
            return Err(AutomationError::UnsupportedOperation(
                "No GUI session detected (AT-SPI2 requires DISPLAY/WAYLAND_DISPLAY)".to_string(),
            ));
        }
        
        let selector = selector.clone();
        let timeout = timeout.unwrap_or(Duration::from_secs(5));
        
        // Use blocking task to run async AT-SPI2 code
        let result = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|e| AutomationError::PlatformError(format!("Failed to create runtime: {e}")))?;
            
            rt.block_on(async move {
                let start = std::time::Instant::now();
                
                while start.elapsed() < timeout {
                    match Self::find_element_atspi(&selector).await {
                        Ok(el) => return Ok(el),
                        Err(AutomationError::ElementNotFound(_)) => {
                            tokio::time::sleep(Duration::from_millis(100)).await;
                        }
                        Err(e) => return Err(e),
                    }
                }
                
                Err(AutomationError::Timeout(format!(
                    "Timed out waiting for element matching selector: {:?}",
                    selector
                )))
            })
        })
        .join()
        .map_err(|_| AutomationError::PlatformError("AT-SPI2 thread panicked".to_string()))??;
        
        Ok(result)
    }

    fn find_elements(
        &self,
        selector: &Selector,
        _root: Option<&UIElement>,
        _timeout: Option<Duration>,
        depth: Option<usize>,
    ) -> Result<Vec<UIElement>, AutomationError> {
        if !Self::has_gui_session() {
            return Err(AutomationError::UnsupportedOperation(
                "No GUI session detected (AT-SPI2 requires DISPLAY/WAYLAND_DISPLAY)".to_string(),
            ));
        }
        
        let selector = selector.clone();
        let max_depth = depth.unwrap_or(10);
        
        let result = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|e| AutomationError::PlatformError(format!("Failed to create runtime: {e}")))?;
            
            rt.block_on(Self::find_elements_atspi(&selector, max_depth))
        })
        .join()
        .map_err(|_| AutomationError::PlatformError("AT-SPI2 thread panicked".to_string()))??;
        
        Ok(result)
    }

    fn open_application(&self, _app_name: &str) -> Result<UIElement, AutomationError> {
        if !Self::has_gui_session() {
            return Err(AutomationError::UnsupportedOperation(
                "No GUI session detected (DISPLAY/WAYLAND_DISPLAY not set)".to_string(),
            ));
        }

        // Best-effort: spawn via shell (user must provide a runnable command).
        let status = std::process::Command::new("bash")
            .arg("-lc")
            .arg(_app_name)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|e| AutomationError::PlatformError(format!("Failed to run '{_app_name}': {e}")))?;

        if !status.success() {
            // Still allow the app to be already running; fall through to lookup.
        }

        let start = std::time::Instant::now();
        while start.elapsed() < Duration::from_secs(5) {
            if let Ok(el) = self.get_application_by_name(_app_name) {
                return Ok(el);
            }
            std::thread::sleep(Duration::from_millis(150));
        }

        Err(AutomationError::Timeout(format!(
            "Timed out waiting for '{_app_name}' to appear"
        )))
    }

    fn activate_application(&self, _app_name: &str) -> Result<(), AutomationError> {
        if !Self::has_gui_session() {
            return Err(AutomationError::UnsupportedOperation(
                "No GUI session detected (DISPLAY/WAYLAND_DISPLAY not set)".to_string(),
            ));
        }

        if Self::command_exists("wmctrl") {
            // -x uses WM_CLASS; best-effort.
            let status = std::process::Command::new("wmctrl")
                .args(["-xa", _app_name])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map_err(|e| AutomationError::PlatformError(format!("Failed to run wmctrl: {e}")))?;
            if status.success() {
                return Ok(());
            }
        }

        Err(AutomationError::UnsupportedOperation(
            "activate_application requires wmctrl (X11)".to_string(),
        ))
    }

    fn open_url(&self, url: &str, _browser: Option<Browser>) -> Result<UIElement, AutomationError> {
        // Best-effort. This does not return a "live" UI element yet.
        let status = std::process::Command::new("xdg-open")
            .arg(url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|e| AutomationError::PlatformError(format!("Failed to spawn 'xdg-open': {e}")))?;

        if !status.success() {
            return Err(AutomationError::PlatformError(
                "'xdg-open' returned non-zero exit status".to_string(),
            ));
        }

        let mut el = StubElement::new("Application", Some("Browser".to_string()));
        el.url = Some(url.to_string());
        Ok(UIElement::new(Box::new(el)))
    }

    fn open_file(&self, file_path: &str) -> Result<(), AutomationError> {
        let status = std::process::Command::new("xdg-open")
            .arg(file_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|e| AutomationError::PlatformError(format!("Failed to spawn 'xdg-open': {e}")))?;

        if !status.success() {
            return Err(AutomationError::PlatformError(
                "'xdg-open' returned non-zero exit status".to_string(),
            ));
        }
        Ok(())
    }

    fn click_at_coordinates(&self, x: f64, y: f64, _restore_cursor: bool) -> Result<(), AutomationError> {
        self.click_at_coordinates_with_type(x, y, crate::ClickType::Left, false)
    }

    fn click_at_coordinates_with_type(
        &self,
        x: f64,
        y: f64,
        click_type: crate::ClickType,
        _restore_cursor: bool,
    ) -> Result<(), AutomationError> {
        let mut enigo = Self::enigo()?;
        enigo
            .move_mouse(x.round() as i32, y.round() as i32, enigo::Coordinate::Abs)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to move mouse: {e}")))?;

        let button = match click_type {
            crate::ClickType::Left | crate::ClickType::Double => Button::Left,
            crate::ClickType::Right => Button::Right,
        };

        enigo
            .button(button, Direction::Click)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to click: {e}")))?;
        if click_type == crate::ClickType::Double {
            enigo
                .button(button, Direction::Click)
                .map_err(|e| AutomationError::PlatformError(format!("Failed to double click: {e}")))?;
        }
        Ok(())
    }

    async fn run_command(
        &self,
        _windows_command: Option<&str>,
        unix_command: Option<&str>,
    ) -> Result<CommandOutput, AutomationError> {
        let cmd = unix_command.ok_or_else(|| {
            AutomationError::InvalidArgument("unix_command is required on Linux".to_string())
        })?;

        let output = tokio::process::Command::new("bash")
            .arg("-lc")
            .arg(cmd)
            .stdin(Stdio::null())
            .output()
            .await
            .map_err(|e| AutomationError::PlatformError(format!("Failed to run command: {e}")))?;

        Ok(CommandOutput {
            exit_status: output.status.code(),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        })
    }

    async fn list_monitors(&self) -> Result<Vec<crate::Monitor>, AutomationError> {
        let monitors = self.monitor_list()?;
        let mut out = Vec::with_capacity(monitors.len());
        for mon in monitors {
            let id = mon.id().map_err(|e| {
                AutomationError::PlatformError(format!("Failed to get monitor id: {e}"))
            })?;
            let name = mon.name().map_err(|e| {
                AutomationError::PlatformError(format!("Failed to get monitor name: {e}"))
            })?;
            let width = mon.width().map_err(|e| {
                AutomationError::PlatformError(format!("Failed to get monitor width: {e}"))
            })?;
            let height = mon.height().map_err(|e| {
                AutomationError::PlatformError(format!("Failed to get monitor height: {e}"))
            })?;
            let x = mon.x().map_err(|e| {
                AutomationError::PlatformError(format!("Failed to get monitor x: {e}"))
            })?;
            let y = mon.y().map_err(|e| {
                AutomationError::PlatformError(format!("Failed to get monitor y: {e}"))
            })?;
            let scale_factor = mon.scale_factor().map_err(|e| {
                AutomationError::PlatformError(format!("Failed to get monitor scale factor: {e}"))
            })? as f64;
            let is_primary = mon.is_primary().map_err(|e| {
                AutomationError::PlatformError(format!("Failed to get monitor primary flag: {e}"))
            })?;
            out.push(crate::Monitor {
                id: id.to_string(),
                name,
                is_primary,
                width,
                height,
                x,
                y,
                scale_factor,
                work_area: Some(crate::WorkAreaBounds {
                    x,
                    y,
                    width,
                    height,
                }),
            });
        }
        Ok(out)
    }

    async fn get_primary_monitor(&self) -> Result<crate::Monitor, AutomationError> {
        let monitors = self.list_monitors().await?;
        monitors
            .into_iter()
            .find(|m| m.is_primary)
            .ok_or_else(|| AutomationError::PlatformError("No primary monitor found".to_string()))
    }

    async fn get_active_monitor(&self) -> Result<crate::Monitor, AutomationError> {
        // TODO: map focused window -> monitor. For now, return primary.
        self.get_primary_monitor().await
    }

    async fn get_monitor_by_id(&self, id: &str) -> Result<crate::Monitor, AutomationError> {
        let monitors = self.list_monitors().await?;
        monitors
            .into_iter()
            .find(|m| m.id == id)
            .ok_or_else(|| AutomationError::ElementNotFound(format!("Monitor id '{id}' not found")))
    }

    async fn get_monitor_by_name(&self, name: &str) -> Result<crate::Monitor, AutomationError> {
        let monitors = self.list_monitors().await?;
        monitors
            .into_iter()
            .find(|m| m.name == name)
            .ok_or_else(|| {
                AutomationError::ElementNotFound(format!("Monitor name '{name}' not found"))
            })
    }

    async fn capture_monitor_by_id(
        &self,
        id: &str,
    ) -> Result<crate::ScreenshotResult, AutomationError> {
        let monitors = self.monitor_list()?;
        for mon in monitors {
            let mon_id = mon.id().map_err(|e| {
                AutomationError::PlatformError(format!("Failed to get monitor id: {e}"))
            })?;
            if mon_id.to_string() == id {
                let image = mon.capture_image().map_err(|e| {
                    AutomationError::PlatformError(format!("Failed to capture monitor: {e}"))
                })?;
                let (w, h) = (image.width(), image.height());
                return Ok(crate::ScreenshotResult {
                    image_data: image.into_raw(),
                    width: w,
                    height: h,
                    monitor: None,
                });
            }
        }
        Err(AutomationError::ElementNotFound(format!(
            "Monitor id '{id}' not found"
        )))
    }

    async fn ocr_image_path(&self, image_path: &str) -> Result<String, AutomationError> {
        let img = image::open(image_path).map_err(|e| {
            AutomationError::PlatformError(format!("Failed to open image for OCR: {e}"))
        })?;
        let engine = uni_ocr::OcrEngine::new(uni_ocr::OcrProvider::Auto).map_err(|e| {
            AutomationError::PlatformError(format!("Failed to create OCR engine: {e}"))
        })?;
        let (text, _language, _confidence) = engine
            .recognize_image(&img)
            .await
            .map_err(|e| AutomationError::PlatformError(format!("OCR recognition failed: {e}")))?;
        Ok(text)
    }

    async fn ocr_screenshot(
        &self,
        screenshot: &crate::ScreenshotResult,
    ) -> Result<String, AutomationError> {
        let img_buffer = image::ImageBuffer::from_raw(
            screenshot.width,
            screenshot.height,
            screenshot.image_data.clone(),
        )
        .ok_or_else(|| {
            AutomationError::PlatformError("Failed to create image buffer from screenshot".into())
        })?;
        let dynamic_image = image::DynamicImage::ImageRgba8(img_buffer);

        let engine = uni_ocr::OcrEngine::new(uni_ocr::OcrProvider::Auto).map_err(|e| {
            AutomationError::PlatformError(format!("Failed to create OCR engine: {e}"))
        })?;

        let (text, _language, _confidence) = engine
            .recognize_image(&dynamic_image)
            .await
            .map_err(|e| AutomationError::PlatformError(format!("OCR recognition failed: {e}")))?;
        Ok(text)
    }

    fn activate_browser_window_by_title(&self, _title: &str) -> Result<(), AutomationError> {
        if !Self::has_gui_session() {
            return Err(AutomationError::UnsupportedOperation(
                "No GUI session detected (DISPLAY/WAYLAND_DISPLAY not set)".to_string(),
            ));
        }

        if Self::command_exists("wmctrl") {
            let status = std::process::Command::new("wmctrl")
                .args(["-a", _title])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map_err(|e| AutomationError::PlatformError(format!("Failed to run wmctrl: {e}")))?;
            if status.success() {
                return Ok(());
            }
        }

        Err(AutomationError::UnsupportedOperation(
            "activate_browser_window_by_title requires wmctrl (X11)".to_string(),
        ))
    }

    async fn get_current_browser_window(&self) -> Result<UIElement, AutomationError> {
        self.get_current_window().await
    }

    async fn get_current_window(&self) -> Result<UIElement, AutomationError> {
        let info = self.get_active_window_best_effort()?;
        Ok(UIElement::new(Box::new(LinuxUIElement::new_window(info))))
    }

    async fn get_current_application(&self) -> Result<UIElement, AutomationError> {
        let info = self.get_active_window_best_effort()?;
        let name = info
            .process_name
            .clone()
            .or_else(|| Some(info.title))
            .unwrap_or_else(|| "Application".to_string());
        let mut el = StubElement::new("Application", Some(name));
        el.pid = info.pid;
        Ok(UIElement::new(Box::new(el)))
    }

    fn press_key(&self, _key: &str) -> Result<(), AutomationError> {
        Self::send_key_sequence(_key)
    }

    fn set_zoom(&self, _percentage: u32) -> Result<(), AutomationError> {
        // Best-effort: reset to 100%, then adjust in 10% increments with Ctrl +/-.
        let mut enigo = Self::enigo()?;
        // Ctrl+0
        enigo.key(Key::Control, Direction::Press).ok();
        enigo.key(Key::Unicode('0'), Direction::Click).ok();
        enigo.key(Key::Control, Direction::Release).ok();

        let pct = _percentage.clamp(25, 500);
        let steps: i32 = ((pct as i32 - 100) / 10).clamp(-30, 40);
        if steps == 0 {
            return Ok(());
        }

        enigo.key(Key::Control, Direction::Press).map_err(|e| {
            AutomationError::PlatformError(format!("Failed to hold Ctrl for zoom: {e}"))
        })?;
        let key = if steps > 0 { Key::Unicode('+') } else { Key::Unicode('-') };
        for _ in 0..steps.unsigned_abs() {
            enigo.key(key.clone(), Direction::Click).map_err(|e| {
                AutomationError::PlatformError(format!("Failed to adjust zoom: {e}"))
            })?;
        }
        let _ = enigo.key(Key::Control, Direction::Release);
        Ok(())
    }

    fn get_window_tree(
        &self,
        pid: u32,
        title: Option<&str>,
        config: TreeBuildConfig,
    ) -> Result<UINode, AutomationError> {
        if !Self::has_gui_session() {
            return Err(AutomationError::UnsupportedOperation(
                "No GUI session detected (AT-SPI2 requires DISPLAY/WAYLAND_DISPLAY)".to_string(),
            ));
        }
        
        let title_owned = title.map(|s| s.to_string());
        
        let result = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|e| AutomationError::PlatformError(format!("Failed to create runtime: {e}")))?;
            
            rt.block_on(Self::build_window_tree_atspi(pid, title_owned.as_deref(), &config))
        })
        .join()
        .map_err(|_| AutomationError::PlatformError("AT-SPI2 thread panicked".to_string()))??;
        
        Ok(result)
    }

    fn get_tree_from_element(
        &self,
        element: &UIElement,
        config: TreeBuildConfig,
    ) -> Result<UINode, AutomationError> {
        if !Self::has_gui_session() {
            return Err(AutomationError::UnsupportedOperation(
                "No GUI session detected (AT-SPI2 requires DISPLAY/WAYLAND_DISPLAY)".to_string(),
            ));
        }
        
        // For AT-SPI2 elements, we can build the tree from that element
        // For other elements (LinuxUIElement), fall back to the window-based approach
        let el_any = element.as_any();
        
        if let Some(atspi_el) = el_any.downcast_ref::<LinuxATSPIElement>() {
            let bus_name = atspi_el.info.bus_name.clone();
            let path = atspi_el.info.path.clone();
            
            let result = std::thread::spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(|e| AutomationError::PlatformError(format!("Failed to create runtime: {e}")))?;
                
                rt.block_on(async {
                    let connection = Self::connect_atspi().await?;
                    
                    let proxy = AccessibleProxy::builder(&*connection)
                        .destination(bus_name.as_str())
                        .map_err(|e| AutomationError::PlatformError(format!("Failed to set destination: {e}")))?
                        .path(path.as_str())
                        .map_err(|e| AutomationError::PlatformError(format!("Failed to set path: {e}")))?
                        .build()
                        .await
                        .map_err(|e| AutomationError::PlatformError(format!("Failed to build proxy: {e}")))?;
                    
                    build_atspi_tree(&proxy, connection.clone(), &config, 0).await
                })
            })
            .join()
            .map_err(|_| AutomationError::PlatformError("AT-SPI2 thread panicked".to_string()))??;
            
            return Ok(result);
        }
        
        // For LinuxUIElement (window-level), use PID-based tree building
        if let Ok(pid) = element.process_id() {
            let name = element.attributes().name.clone();
            return self.get_window_tree(pid, name.as_deref(), config);
        }
        
        Err(AutomationError::UnsupportedOperation(
            "Cannot build tree from this element type".to_string(),
        ))
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

