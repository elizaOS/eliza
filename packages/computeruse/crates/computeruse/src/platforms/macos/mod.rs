use crate::element::{UIElementAttributes, UIElementImpl};
use crate::platforms::{AccessibilityEngine, TreeBuildConfig};
use crate::{AutomationError, Browser, CommandOutput, Selector, UIElement, UINode};
use crate::platforms::tree_search::{ElementFinderWithWindows, ElementsCollectorWithWindows};
use accessibility::{AXAttribute, AXUIElement, AXUIElementAttributes, Error as AxError};
use accessibility_sys::{
    kAXPositionAttribute, kAXSizeAttribute, AXUIElementCopyAttributeValue, AXValueGetType,
    AXValueGetValue, AXValueRef, kAXValueTypeCGPoint, kAXValueTypeCGSize,
};
use core_foundation::array::CFArray;
use core_foundation::base::{CFType, TCFType};
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use core_graphics::display::CGWindowListCopyWindowInfo;
use core_graphics::window::{
    kCGNullWindowID, kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly,
};
use std::fmt;
use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

#[cfg(not(target_os = "windows"))]
use enigo::{Button, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use enigo::Axis;

static NEXT_OBJECT_ID: AtomicUsize = AtomicUsize::new(1);

#[repr(C)]
#[derive(Debug, Copy, Clone, Default)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[repr(C)]
#[derive(Debug, Copy, Clone, Default)]
struct CGSize {
    width: f64,
    height: f64,
}

#[derive(Debug, Clone)]
struct MacOSWindowInfo {
    window_id: u32,
    pid: i32,
    owner_name: String,
    title: Option<String>,
    bounds: (f64, f64, f64, f64),
}

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
struct MacOSUIElement {
    object_id: usize,
    id: Option<String>,
    attrs: UIElementAttributes,
    pid: u32,
    bounds: Option<(f64, f64, f64, f64)>,
    window_id: Option<u32>,
}

impl fmt::Debug for MacOSUIElement {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MacOSUIElement")
            .field("id", &self.id)
            .field("role", &self.attrs.role)
            .field("name", &self.attrs.name)
            .field("pid", &self.pid)
            .field("bounds", &self.bounds)
            .finish()
    }
}

impl MacOSUIElement {
    fn new(role: &str, name: Option<String>, pid: u32, bounds: Option<(f64, f64, f64, f64)>, window_id: Option<u32>) -> Self {
        let object_id = NEXT_OBJECT_ID.fetch_add(1, Ordering::Relaxed);
        let mut attrs = UIElementAttributes::default();
        attrs.role = role.to_string();
        attrs.name = name;
        Self {
            object_id,
            id: Some(format!("macos:{object_id}")),
            attrs,
            pid,
            bounds,
            window_id,
        }
    }
}

#[derive(Clone)]
struct MacOSAXElement {
    object_id: usize,
    id: Option<String>,
    ax: AXUIElement,
}

impl fmt::Debug for MacOSAXElement {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MacOSAXElement")
            .field("id", &self.id)
            .finish()
    }
}

// SAFETY: The accessibility AXUIElement is a CoreFoundation wrapper around an AXUIElementRef.
// In practice, ComputerUse passes UIElements across threads (tokio spawn_blocking, caches, etc).
// We assume Apple's AX API tolerates cross-thread use for read-only queries and that our usage
// remains short-lived. If this assumption is violated on some systems, we should redesign to
// confine AX queries to a dedicated thread and proxy requests.
unsafe impl Send for MacOSAXElement {}
unsafe impl Sync for MacOSAXElement {}

impl MacOSAXElement {
    fn new(ax: AXUIElement) -> Self {
        let object_id = NEXT_OBJECT_ID.fetch_add(1, Ordering::Relaxed);
        Self {
            object_id,
            id: Some(format!("ax:{object_id}")),
            ax,
        }
    }

    #[allow(dead_code)]
    fn ax_string(res: Result<CFString, AxError>) -> Option<String> {
        res.ok().map(|s| s.to_string())
    }

    #[allow(dead_code)]
    fn role_str(&self) -> Option<String> {
        Self::ax_string(self.ax.role())
    }

    #[allow(dead_code)]
    fn title_str(&self) -> Option<String> {
        Self::ax_string(self.ax.title())
    }

    #[allow(dead_code)]
    fn identifier_str(&self) -> Option<String> {
        Self::ax_string(self.ax.identifier())
    }

    fn value_str(&self) -> Option<String> {
        // Value is CFType in the accessibility crate; we can fall back to empty for now.
        self.ax
            .value()
            .ok()
            .and_then(|v| {
                // Try CFString downcast via CFType.
                v.downcast::<CFString>().map(|s| s.to_string())
            })
    }

    fn bounds_from_axvalue(&self) -> Option<(f64, f64, f64, f64)> {
        unsafe {
            let pos_key = CFString::from_static_string(kAXPositionAttribute);
            let size_key = CFString::from_static_string(kAXSizeAttribute);

            let mut pos_val: core_foundation::base::CFTypeRef = std::ptr::null();
            let mut size_val: core_foundation::base::CFTypeRef = std::ptr::null();

            let err_pos = AXUIElementCopyAttributeValue(
                self.ax.as_concrete_TypeRef(),
                pos_key.as_concrete_TypeRef(),
                &mut pos_val,
            );
            if err_pos != 0 || pos_val.is_null() {
                return None;
            }

            let err_size = AXUIElementCopyAttributeValue(
                self.ax.as_concrete_TypeRef(),
                size_key.as_concrete_TypeRef(),
                &mut size_val,
            );
            if err_size != 0 || size_val.is_null() {
                // We intentionally don't CFRelease(pos_val) here; CoreFoundation retain rules
                // are handled by the OS for these AXValue refs, and we only use them briefly.
                return None;
            }

            let pos_ref = pos_val as AXValueRef;
            let size_ref = size_val as AXValueRef;
            if AXValueGetType(pos_ref) != kAXValueTypeCGPoint || AXValueGetType(size_ref) != kAXValueTypeCGSize {
                return None;
            }

            let mut pos = CGPoint::default();
            let mut size = CGSize::default();
            let ok_pos = AXValueGetValue(pos_ref, kAXValueTypeCGPoint, (&mut pos as *mut CGPoint).cast());
            let ok_size = AXValueGetValue(size_ref, kAXValueTypeCGSize, (&mut size as *mut CGSize).cast());
            if !ok_pos || !ok_size {
                return None;
            }

            Some((pos.x, pos.y, size.width, size.height))
        }
    }

    fn click_center_with_type(&self, click_type: crate::ClickType) -> Result<crate::ClickResult, AutomationError> {
        let (x, y, w, h) = self.bounds().unwrap_or((0.0, 0.0, 0.0, 0.0));
        if w <= 0.0 || h <= 0.0 {
            return Err(AutomationError::UnsupportedOperation(
                "Element has no bounds (check Accessibility permissions)".to_string(),
            ));
        }
        let cx = x + w / 2.0;
        let cy = y + h / 2.0;
        let mut enigo = MacOSEngine::enigo()?;
        enigo
            .move_mouse(cx.round() as i32, cy.round() as i32, enigo::Coordinate::Abs)
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
        Ok(crate::ClickResult {
            method: "macos:ax+enigo".to_string(),
            coordinates: Some((cx, cy)),
            details: "Clicked center of AX bounds".to_string(),
        })
    }
}

fn ax_err_to_automation(e: AxError) -> AutomationError {
    match e {
        AxError::NotFound => AutomationError::ElementNotFound("AX element not found".to_string()),
        other => AutomationError::PlatformError(format!(
            "macOS Accessibility error: {other}. Ensure Accessibility permissions are granted."
        )),
    }
}

fn ax_matches_selector(ax: &AXUIElement, selector: &Selector) -> bool {
    // Best-effort, resilient to missing attributes.
    match selector {
        Selector::Role { role, name } => {
            let ax_role = ax.role().ok().map(|s| s.to_string()).unwrap_or_default();
            let ax_role_norm = ax_role.trim_start_matches("AX").to_lowercase();
            let want_role_norm = role.trim_start_matches("AX").to_lowercase();
            if !ax_role_norm.contains(&want_role_norm) && ax_role_norm != want_role_norm {
                return false;
            }
            if let Some(n) = name {
                let title = ax.title().ok().map(|s| s.to_string()).unwrap_or_default();
                return title.to_lowercase().contains(&n.to_lowercase());
            }
            true
        }
        Selector::Name(expected) => ax
            .title()
            .ok()
            .map(|s| s.to_string().to_lowercase().contains(&expected.to_lowercase()))
            .unwrap_or(false),
        Selector::Text(expected) => ax
            .title()
            .ok()
            .map(|s| s.to_string().contains(expected))
            .unwrap_or(false),
        Selector::Id(expected) | Selector::NativeId(expected) => {
            let target = expected.strip_prefix('#').unwrap_or(expected).to_lowercase();
            ax.identifier()
                .ok()
                .map(|s| s.to_string().to_lowercase() == target)
                .unwrap_or(false)
        }
        Selector::And(selectors) => selectors.iter().all(|s| ax_matches_selector(ax, s)),
        Selector::Or(selectors) => selectors.iter().any(|s| ax_matches_selector(ax, s)),
        Selector::Not(inner) => !ax_matches_selector(ax, inner),
        // Not yet supported as pure element predicates in this first pass.
        Selector::Chain(_)
        | Selector::Has(_)
        | Selector::Parent
        | Selector::RightOf(_)
        | Selector::LeftOf(_)
        | Selector::Above(_)
        | Selector::Below(_)
        | Selector::Near(_)
        | Selector::Path(_)
        | Selector::Attributes(_)
        | Selector::Filter(_)
        | Selector::LocalizedRole(_)
        | Selector::Visible(_)
        | Selector::Process(_)
        | Selector::ClassName(_)
        | Selector::Nth(_)
        | Selector::Invalid(_) => false,
    }
}

impl UIElementImpl for MacOSUIElement {
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
        let mut enigo = MacOSEngine::enigo()?;
        enigo
            .move_mouse(cx.round() as i32, cy.round() as i32, enigo::Coordinate::Abs)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to move mouse: {e}")))?;
        enigo
            .button(Button::Left, Direction::Click)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to click: {e}")))?;
        Ok(crate::ClickResult {
            method: "macos:enigo".to_string(),
            coordinates: Some((cx, cy)),
            details: "Clicked center of bounds".to_string(),
        })
    }
    fn double_click(&self) -> Result<crate::ClickResult, AutomationError> {
        let r = self.click()?;
        let mut enigo = MacOSEngine::enigo()?;
        enigo
            .button(Button::Left, Direction::Click)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to double click: {e}")))?;
        Ok(crate::ClickResult { details: "Double clicked center of bounds".to_string(), ..r })
    }
    fn right_click(&self) -> Result<(), AutomationError> {
        let (x, y, w, h) = self.bounds()?;
        let cx = x + w / 2.0;
        let cy = y + h / 2.0;
        let mut enigo = MacOSEngine::enigo()?;
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
        let mut enigo = MacOSEngine::enigo()?;
        enigo
            .move_mouse(cx.round() as i32, cy.round() as i32, enigo::Coordinate::Abs)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to move mouse: {e}")))?;
        Ok(())
    }
    fn focus(&self) -> Result<(), AutomationError> {
        // Best-effort: activate owning app.
        if self.pid == 0 {
            return Ok(());
        }
        // We don't map pid->bundle id yet; fall back to no-op.
        Ok(())
    }
    fn invoke(&self) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "invoke not implemented on macOS yet".to_string(),
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
        let mut enigo = MacOSEngine::enigo()?;
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
        MacOSEngine::send_key_sequence(key)
    }
    fn get_text(&self, _max_depth: usize) -> Result<String, AutomationError> {
        Ok(String::new())
    }
    fn set_value(&self, _value: &str) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "set_value not implemented on macOS yet".to_string(),
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
            "perform_action not implemented on macOS yet".to_string(),
        ))
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
    fn create_locator(&self, selector: Selector) -> Result<crate::Locator, AutomationError> {
        // Create a new macOS engine to use for the locator
        let engine = std::sync::Arc::new(MacOSEngine::new(false, false)?);
        let locator = crate::Locator::new(engine, selector);
        // Clone self as a UIElement to set as the root
        let self_element = UIElement::new(Box::new(MacOSUIElement {
            object_id: self.object_id,
            id: self.id.clone(),
            attrs: self.attrs.clone(),
            pid: self.pid,
            bounds: self.bounds,
            window_id: self.window_id,
        }));
        Ok(locator.within(self_element))
    }
    fn scroll(&self, direction: &str, amount: f64) -> Result<(), AutomationError> {
        let mut enigo = MacOSEngine::enigo()?;
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
            "minimize_window not implemented on macOS yet".to_string(),
        ))
    }
    fn maximize_window(&self) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "maximize_window not implemented on macOS yet".to_string(),
        ))
    }
    fn maximize_window_keyboard(&self) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "maximize_window_keyboard not implemented on macOS yet".to_string(),
        ))
    }
    fn minimize_window_keyboard(&self) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "minimize_window_keyboard not implemented on macOS yet".to_string(),
        ))
    }
    fn get_native_window_handle(&self) -> Result<isize, AutomationError> {
        // Not a stable concept on macOS; return window_id if we have it.
        self.window_id
            .map(|w| w as isize)
            .ok_or_else(|| AutomationError::UnsupportedOperation("no native handle".to_string()))
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
        let mut enigo = MacOSEngine::enigo()?;
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
        let mut enigo = MacOSEngine::enigo()?;
        enigo
            .move_mouse(x.round() as i32, y.round() as i32, enigo::Coordinate::Abs)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to move mouse: {e}")))?;
        enigo
            .button(Button::Left, Direction::Press)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to click and hold: {e}")))?;
        Ok(())
    }
    fn mouse_move(&self, x: f64, y: f64) -> Result<(), AutomationError> {
        let mut enigo = MacOSEngine::enigo()?;
        enigo
            .move_mouse(x.round() as i32, y.round() as i32, enigo::Coordinate::Abs)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to move mouse: {e}")))?;
        Ok(())
    }
    fn mouse_release(&self) -> Result<(), AutomationError> {
        let mut enigo = MacOSEngine::enigo()?;
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
            "highlight not implemented on macOS yet".to_string(),
        ))
    }
    fn set_transparency(&self, _percentage: u8) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "set_transparency not implemented on macOS yet".to_string(),
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
            "element.capture not implemented on macOS yet".to_string(),
        ))
    }

    fn close(&self) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "close not implemented on macOS yet".to_string(),
        ))
    }

    fn select_option(&self, _option_name: &str) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "select_option not implemented on macOS yet".to_string(),
        ))
    }

    fn list_options(&self) -> Result<Vec<String>, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "list_options not implemented on macOS yet".to_string(),
        ))
    }

    fn is_toggled(&self) -> Result<bool, AutomationError> {
        Ok(false)
    }

    fn set_toggled(&self, _state: bool) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "set_toggled not implemented on macOS yet".to_string(),
        ))
    }

    fn get_range_value(&self) -> Result<f64, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "get_range_value not implemented on macOS yet".to_string(),
        ))
    }

    fn set_range_value(&self, _value: f64) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "set_range_value not implemented on macOS yet".to_string(),
        ))
    }

    fn is_selected(&self) -> Result<bool, AutomationError> {
        Ok(false)
    }
    fn set_selected(&self, _selected: bool) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "set_selected not implemented on macOS yet".to_string(),
        ))
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
            "bounds not supported on macOS stub engine".to_string(),
        ))
    }
    fn click(&self) -> Result<crate::ClickResult, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "click not supported on macOS stub engine".to_string(),
        ))
    }
    fn double_click(&self) -> Result<crate::ClickResult, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "double_click not supported on macOS stub engine".to_string(),
        ))
    }
    fn right_click(&self) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "right_click not supported on macOS stub engine".to_string(),
        ))
    }
    fn hover(&self) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "hover not supported on macOS stub engine".to_string(),
        ))
    }
    fn focus(&self) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "focus not supported on macOS stub engine".to_string(),
        ))
    }
    fn invoke(&self) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "invoke not supported on macOS stub engine".to_string(),
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
            "type_text not supported on macOS stub engine".to_string(),
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
            "press_key not supported on macOS stub engine".to_string(),
        ))
    }
    fn get_text(&self, _max_depth: usize) -> Result<String, AutomationError> {
        Ok(String::new())
    }
    fn set_value(&self, _value: &str) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "set_value not supported on macOS stub engine".to_string(),
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
            "perform_action not supported on macOS stub engine".to_string(),
        ))
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
    fn create_locator(&self, selector: Selector) -> Result<crate::Locator, AutomationError> {
        // Create a new macOS engine to use for the locator
        let engine = std::sync::Arc::new(MacOSEngine::new(false, false)?);
        let locator = crate::Locator::new(engine, selector);
        // Clone self as a UIElement to set as the root
        let self_element = UIElement::new(Box::new(StubElement {
            object_id: self.object_id,
            id: self.id.clone(),
            role: self.role.clone(),
            attrs: self.attrs.clone(),
            pid: self.pid,
            url: self.url.clone(),
        }));
        Ok(locator.within(self_element))
    }
    fn scroll(&self, _direction: &str, _amount: f64) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "scroll not supported on macOS stub engine".to_string(),
        ))
    }
    fn activate_window(&self) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "activate_window not supported on macOS stub engine".to_string(),
        ))
    }
    fn minimize_window(&self) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "minimize_window not supported on macOS stub engine".to_string(),
        ))
    }
    fn maximize_window(&self) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "maximize_window not supported on macOS stub engine".to_string(),
        ))
    }
    fn maximize_window_keyboard(&self) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "maximize_window_keyboard not supported on macOS stub engine".to_string(),
        ))
    }
    fn minimize_window_keyboard(&self) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "minimize_window_keyboard not supported on macOS stub engine".to_string(),
        ))
    }
    fn get_native_window_handle(&self) -> Result<isize, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "native window handle not supported on macOS stub engine".to_string(),
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
            "mouse_drag not supported on macOS stub engine".to_string(),
        ))
    }
    fn mouse_click_and_hold(&self, _x: f64, _y: f64) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "mouse_click_and_hold not supported on macOS stub engine".to_string(),
        ))
    }
    fn mouse_move(&self, _x: f64, _y: f64) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "mouse_move not supported on macOS stub engine".to_string(),
        ))
    }
    fn mouse_release(&self) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "mouse_release not supported on macOS stub engine".to_string(),
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
            "highlight not supported on macOS stub engine".to_string(),
        ))
    }
    fn set_transparency(&self, _percentage: u8) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "set_transparency not supported on macOS stub engine".to_string(),
        ))
    }
    fn process_id(&self) -> Result<u32, AutomationError> {
        Ok(self.pid)
    }
    fn capture(&self) -> Result<crate::ScreenshotResult, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "element.capture not supported on macOS stub engine".to_string(),
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
            "select_option not supported on macOS stub engine".to_string(),
        ))
    }
    fn list_options(&self) -> Result<Vec<String>, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "list_options not supported on macOS stub engine".to_string(),
        ))
    }
    fn is_toggled(&self) -> Result<bool, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "is_toggled not supported on macOS stub engine".to_string(),
        ))
    }
    fn set_toggled(&self, _state: bool) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "set_toggled not supported on macOS stub engine".to_string(),
        ))
    }
    fn get_range_value(&self) -> Result<f64, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "get_range_value not supported on macOS stub engine".to_string(),
        ))
    }
    fn set_range_value(&self, _value: f64) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "set_range_value not supported on macOS stub engine".to_string(),
        ))
    }
    fn is_selected(&self) -> Result<bool, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "is_selected not supported on macOS stub engine".to_string(),
        ))
    }
    fn set_selected(&self, _state: bool) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "set_selected not supported on macOS stub engine".to_string(),
        ))
    }
}

impl UIElementImpl for MacOSAXElement {
    fn object_id(&self) -> usize {
        self.object_id
    }
    fn id(&self) -> Option<String> {
        self.id.clone()
    }
    fn role(&self) -> String {
        self.ax.role().ok().map(|s| s.to_string()).unwrap_or_default()
    }
    fn attributes(&self) -> UIElementAttributes {
        let mut attrs = UIElementAttributes::default();
        attrs.role = self.role();
        attrs.name = self.ax.title().ok().map(|s| s.to_string());
        attrs.properties.insert(
            "identifier".to_string(),
            self.ax.identifier().ok().map(|s| serde_json::Value::String(s.to_string())),
        );
        attrs.bounds = self.bounds_from_axvalue();
        attrs
    }
    fn children(&self) -> Result<Vec<UIElement>, AutomationError> {
        let attr_children: AXAttribute<CFArray<AXUIElement>> = AXAttribute::children();
        let children = self.ax.attribute(&attr_children).map_err(ax_err_to_automation)?;
        Ok(children
            .iter()
            .map(|c| UIElement::new(Box::new(MacOSAXElement::new((*c).clone()))))
            .collect())
    }
    fn parent(&self) -> Result<Option<UIElement>, AutomationError> {
        let parent = self.ax.parent().map_err(ax_err_to_automation)?;
        Ok(Some(UIElement::new(Box::new(MacOSAXElement::new(parent)))))
    }
    fn bounds(&self) -> Result<(f64, f64, f64, f64), AutomationError> {
        self.bounds_from_axvalue().ok_or_else(|| {
            AutomationError::UnsupportedOperation(
                "bounds unavailable (check Accessibility permissions)".to_string(),
            )
        })
    }
    fn click(&self) -> Result<crate::ClickResult, AutomationError> {
        self.click_center_with_type(crate::ClickType::Left)
    }
    fn double_click(&self) -> Result<crate::ClickResult, AutomationError> {
        self.click_center_with_type(crate::ClickType::Double)
    }
    fn right_click(&self) -> Result<(), AutomationError> {
        let _ = self.click_center_with_type(crate::ClickType::Right)?;
        Ok(())
    }
    fn hover(&self) -> Result<(), AutomationError> {
        let (x, y, w, h) = self.bounds()?;
        let cx = x + w / 2.0;
        let cy = y + h / 2.0;
        let mut enigo = MacOSEngine::enigo()?;
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
            "invoke not implemented on macOS yet".to_string(),
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
        let mut enigo = MacOSEngine::enigo()?;
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
        MacOSEngine::send_key_sequence(key)
    }
    fn get_text(&self, _max_depth: usize) -> Result<String, AutomationError> {
        Ok(String::new())
    }
    fn set_value(&self, _value: &str) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "set_value not implemented on macOS yet".to_string(),
        ))
    }
    fn get_value(&self) -> Result<Option<String>, AutomationError> {
        Ok(self.value_str())
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
            "perform_action not implemented on macOS yet".to_string(),
        ))
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
    fn create_locator(&self, selector: Selector) -> Result<crate::Locator, AutomationError> {
        // Create a new macOS engine to use for the locator
        let engine = std::sync::Arc::new(MacOSEngine::new(false, false)?);
        let locator = crate::Locator::new(engine, selector);
        // Clone self as a UIElement to set as the root
        let self_element = UIElement::new(Box::new(MacOSAXElement {
            object_id: self.object_id,
            id: self.id.clone(),
            ax: self.ax.clone(),
        }));
        Ok(locator.within(self_element))
    }
    fn scroll(&self, direction: &str, amount: f64) -> Result<(), AutomationError> {
        let mut enigo = MacOSEngine::enigo()?;
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
            "minimize_window not implemented on macOS yet".to_string(),
        ))
    }
    fn maximize_window(&self) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "maximize_window not implemented on macOS yet".to_string(),
        ))
    }
    fn maximize_window_keyboard(&self) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "maximize_window_keyboard not implemented on macOS yet".to_string(),
        ))
    }
    fn minimize_window_keyboard(&self) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "minimize_window_keyboard not implemented on macOS yet".to_string(),
        ))
    }
    fn get_native_window_handle(&self) -> Result<isize, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "native window handle not supported for AX elements".to_string(),
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
        let mut enigo = MacOSEngine::enigo()?;
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
        let mut enigo = MacOSEngine::enigo()?;
        enigo
            .move_mouse(x.round() as i32, y.round() as i32, enigo::Coordinate::Abs)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to move mouse: {e}")))?;
        enigo
            .button(Button::Left, Direction::Press)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to click and hold: {e}")))?;
        Ok(())
    }
    fn mouse_move(&self, x: f64, y: f64) -> Result<(), AutomationError> {
        let mut enigo = MacOSEngine::enigo()?;
        enigo
            .move_mouse(x.round() as i32, y.round() as i32, enigo::Coordinate::Abs)
            .map_err(|e| AutomationError::PlatformError(format!("Failed to move mouse: {e}")))?;
        Ok(())
    }
    fn mouse_release(&self) -> Result<(), AutomationError> {
        let mut enigo = MacOSEngine::enigo()?;
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
            "highlight not implemented on macOS yet".to_string(),
        ))
    }
    fn set_transparency(&self, _percentage: u8) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "set_transparency not implemented on macOS yet".to_string(),
        ))
    }
    fn process_id(&self) -> Result<u32, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "process_id not implemented for AX elements yet".to_string(),
        ))
    }
    fn url(&self) -> Option<String> {
        None
    }
    fn capture(&self) -> Result<crate::ScreenshotResult, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "element.capture not implemented on macOS yet".to_string(),
        ))
    }
    fn close(&self) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "close not implemented on macOS yet".to_string(),
        ))
    }
    fn select_option(&self, _option_name: &str) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "select_option not implemented on macOS yet".to_string(),
        ))
    }
    fn list_options(&self) -> Result<Vec<String>, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "list_options not implemented on macOS yet".to_string(),
        ))
    }
    fn is_toggled(&self) -> Result<bool, AutomationError> {
        Ok(false)
    }
    fn set_toggled(&self, _state: bool) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "set_toggled not implemented on macOS yet".to_string(),
        ))
    }
    fn get_range_value(&self) -> Result<f64, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "get_range_value not implemented on macOS yet".to_string(),
        ))
    }
    fn set_range_value(&self, _value: f64) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "set_range_value not implemented on macOS yet".to_string(),
        ))
    }
    fn is_selected(&self) -> Result<bool, AutomationError> {
        Ok(false)
    }

    fn set_selected(&self, _state: bool) -> Result<(), AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "set_selected not implemented on macOS yet".to_string(),
        ))
    }
}

pub struct MacOSEngine {
    _use_background_apps: bool,
    _activate_app: bool,
}

impl MacOSEngine {
    pub fn new(use_background_apps: bool, activate_app: bool) -> Result<Self, AutomationError> {
        Ok(Self {
            _use_background_apps: use_background_apps,
            _activate_app: activate_app,
        })
    }

    fn root_element(&self) -> UIElement {
        UIElement::new(Box::new(StubElement::new("Desktop", Some("macOS".to_string()))))
    }

    fn list_windows(&self) -> Result<Vec<MacOSWindowInfo>, AutomationError> {
        unsafe {
            let options = kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements;
            let arr_ref = CGWindowListCopyWindowInfo(options, kCGNullWindowID);
            if arr_ref.is_null() {
                return Err(AutomationError::PlatformError(
                    "CGWindowListCopyWindowInfo returned null".to_string(),
                ));
            }

            let window_list: CFArray<CFDictionary<CFString, CFType>> =
                CFArray::wrap_under_create_rule(arr_ref);

            let key_owner = CFString::new("kCGWindowOwnerName");
            let key_title = CFString::new("kCGWindowName");
            let key_pid = CFString::new("kCGWindowOwnerPID");
            let key_wid = CFString::new("kCGWindowNumber");
            let key_bounds = CFString::new("kCGWindowBounds");

            let mut out: Vec<MacOSWindowInfo> = Vec::new();
            for dict in window_list.iter() {
                let owner_name = dict
                    .find(&key_owner)
                    .and_then(|v| v.downcast::<CFString>())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| "Unknown".to_string());

                let title = dict
                    .find(&key_title)
                    .and_then(|v| v.downcast::<CFString>())
                    .map(|s| {
                        let t = s.to_string();
                        if t.is_empty() { None } else { Some(t) }
                    })
                    .unwrap_or(None);

                let pid = dict
                    .find(&key_pid)
                    .and_then(|v| v.downcast::<CFNumber>())
                    .and_then(|n| n.to_i32())
                    .unwrap_or(0);

                let window_id = dict
                    .find(&key_wid)
                    .and_then(|v| v.downcast::<CFNumber>())
                    .and_then(|n| n.to_i32())
                    .map(|v| v.max(0) as u32)
                    .unwrap_or(0);

                let bounds = dict
                    .find(&key_bounds)
                    .and_then(|v| v.downcast::<CFDictionary>())
                    .and_then(|bd_untyped| {
                        let bd: CFDictionary<CFString, CFType> =
                            CFDictionary::wrap_under_get_rule(bd_untyped.as_concrete_TypeRef());
                        let kx = CFString::new("X");
                        let ky = CFString::new("Y");
                        let kw = CFString::new("Width");
                        let kh = CFString::new("Height");
                        let x = bd
                            .find(&kx)
                            .and_then(|v| v.downcast::<CFNumber>())
                            .and_then(|n| n.to_f64())?;
                        let y = bd
                            .find(&ky)
                            .and_then(|v| v.downcast::<CFNumber>())
                            .and_then(|n| n.to_f64())?;
                        let w = bd
                            .find(&kw)
                            .and_then(|v| v.downcast::<CFNumber>())
                            .and_then(|n| n.to_f64())?;
                        let h = bd
                            .find(&kh)
                            .and_then(|v| v.downcast::<CFNumber>())
                            .and_then(|n| n.to_f64())?;
                        Some((x, y, w, h))
                    })
                    .unwrap_or((0.0, 0.0, 0.0, 0.0));

                // Filter out zero-sized windows.
                if bounds.2 <= 1.0 || bounds.3 <= 1.0 {
                    continue;
                }

                out.push(MacOSWindowInfo {
                    window_id,
                    pid,
                    owner_name,
                    title,
                    bounds,
                });
            }

            Ok(out)
        }
    }

    fn frontmost_app_name(&self) -> Result<String, AutomationError> {
        let output = std::process::Command::new("osascript")
            .args([
                "-e",
                "tell application \"System Events\" to get name of first application process whose frontmost is true",
            ])
            .output()
            .map_err(|e| AutomationError::PlatformError(format!("Failed to run osascript: {e}")))?;
        if !output.status.success() {
            return Err(AutomationError::PlatformError(
                "osascript returned non-zero exit status".to_string(),
            ));
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
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
        // Very small SendKeys-ish parser:
        // - "{Ctrl}a" holds Ctrl for the next token, then releases.
        // - "{Enter}" presses Enter.
        // - raw characters are typed as text.
        let mut enigo = Self::enigo()?;

        let mut held_mods: Vec<Key> = Vec::new();

        let mut i = 0usize;
        let bytes = key.as_bytes();
        while i < bytes.len() {
            if bytes[i] == b'{' {
                // parse {Token}
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
                    "alt" | "option" => Some(Key::Alt),
                    "shift" => Some(Key::Shift),
                    "cmd" | "command" | "meta" => Some(Key::Meta),
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

                // If it's a modifier, hold it until next non-mod token.
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

            // Plain character: type it.
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

        // Release any remaining modifiers.
        for m in held_mods.drain(..).rev() {
            let _ = enigo.key(m, Direction::Release);
        }

        Ok(())
    }

    fn ax_root_from_uielement(root: Option<&UIElement>) -> AXUIElement {
        if let Some(r) = root {
            if let Some(ax) = r.as_any().downcast_ref::<MacOSAXElement>() {
                return ax.ax.clone();
            }
        }
        AXUIElement::system_wide()
    }

    fn find_ax_element(
        &self,
        selector: &Selector,
        root: Option<&UIElement>,
        timeout: Option<Duration>,
    ) -> Result<AXUIElement, AutomationError> {
        let selector_owned = selector.clone();
        // Chain: find sequentially within found element.
        if let Selector::Chain(parts) = &selector_owned {
            let mut current_root: Option<UIElement> = root.cloned();
            for part in parts {
                let part_owned = part.clone();
                let ax_root = Self::ax_root_from_uielement(current_root.as_ref());
                let finder = ElementFinderWithWindows::new(
                    &ax_root,
                    move |ax| ax_matches_selector(ax, &part_owned),
                    timeout,
                );
                let found = finder.find().map_err(ax_err_to_automation)?;
                current_root = Some(UIElement::new(Box::new(MacOSAXElement::new(found))));
            }
            return current_root
                .and_then(|u| u.as_any().downcast_ref::<MacOSAXElement>().map(|m| m.ax.clone()))
                .ok_or_else(|| AutomationError::ElementNotFound("No element found".to_string()));
        }

        let ax_root = Self::ax_root_from_uielement(root);
        let finder = ElementFinderWithWindows::new(
            &ax_root,
            move |ax| ax_matches_selector(ax, &selector_owned),
            timeout,
        );
        finder.find().map_err(ax_err_to_automation)
    }

    fn build_ui_node_from_ax(
        &self,
        ax: &AXUIElement,
        config: &TreeBuildConfig,
        depth: usize,
    ) -> UINode {
        let mut attrs = UIElementAttributes::default();
        attrs.role = ax.role().ok().map(|s| s.to_string()).unwrap_or_default();
        attrs.name = ax.title().ok().map(|s| s.to_string());

        // Bounds (best-effort)
        let tmp = MacOSAXElement::new(ax.clone());
        attrs.bounds = tmp.bounds_from_axvalue();

        let mut node = UINode {
            id: None,
            attributes: attrs,
            children: Vec::new(),
            selector: None,
        };

        if let Some(max_depth) = config.max_depth {
            if depth >= max_depth {
                return node;
            }
        }

        let attr_children: AXAttribute<CFArray<AXUIElement>> = AXAttribute::children();
        if let Ok(children) = ax.attribute(&attr_children) {
            for child in children.iter() {
                node.children
                    .push(self.build_ui_node_from_ax(&child, config, depth + 1));
            }
        }
        node
    }
}

#[async_trait::async_trait]
impl AccessibilityEngine for MacOSEngine {
    fn get_root_element(&self) -> UIElement {
        self.root_element()
    }

    fn get_element_by_id(&self, _id: i32) -> Result<UIElement, AutomationError> {
        Err(AutomationError::UnsupportedOperation(
            "get_element_by_id not supported on macOS stub engine".to_string(),
        ))
    }

    fn get_focused_element(&self) -> Result<UIElement, AutomationError> {
        // Best-effort: treat the active window as focused.
        let app = self.frontmost_app_name()?;
        let windows = self.list_windows()?;
        for w in windows {
            if w.owner_name == app {
                let name = w.title.or(Some(w.owner_name));
                return Ok(UIElement::new(Box::new(MacOSUIElement::new(
                    "Window",
                    name,
                    w.pid.max(0) as u32,
                    Some(w.bounds),
                    Some(w.window_id),
                ))));
            }
        }
        Err(AutomationError::ElementNotFound(
            "No focused element found".to_string(),
        ))
    }

    fn get_applications(&self) -> Result<Vec<UIElement>, AutomationError> {
        let windows = self.list_windows()?;
        Ok(windows
            .into_iter()
            .map(|w| {
                let name = w.title.or(Some(w.owner_name));
                UIElement::new(Box::new(MacOSUIElement::new(
                    "Window",
                    name,
                    w.pid.max(0) as u32,
                    Some(w.bounds),
                    Some(w.window_id),
                )))
            })
            .collect())
    }

    fn get_application_by_name(&self, _name: &str) -> Result<UIElement, AutomationError> {
        let needle = _name.to_lowercase();
        let windows = self.list_windows()?;
        for w in windows {
            let owner_lc = w.owner_name.to_lowercase();
            let title_lc = w.title.clone().unwrap_or_default().to_lowercase();
            if owner_lc.contains(&needle) || title_lc.contains(&needle) {
                let name = w.title.or(Some(w.owner_name));
                return Ok(UIElement::new(Box::new(MacOSUIElement::new(
                    "Window",
                    name,
                    w.pid.max(0) as u32,
                    Some(w.bounds),
                    Some(w.window_id),
                ))));
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
            "get_application_by_pid not supported on macOS stub engine".to_string(),
        ))
    }

    fn find_element(
        &self,
        selector: &Selector,
        root: Option<&UIElement>,
        timeout: Option<Duration>,
    ) -> Result<UIElement, AutomationError> {
        let ax = self.find_ax_element(selector, root, timeout)?;
        Ok(UIElement::new(Box::new(MacOSAXElement::new(ax))))
    }

    fn find_elements(
        &self,
        selector: &Selector,
        root: Option<&UIElement>,
        _timeout: Option<Duration>,
        _depth: Option<usize>,
    ) -> Result<Vec<UIElement>, AutomationError> {
        // Note: we don't currently poll on timeout for find_elements.
        let ax_root = Self::ax_root_from_uielement(root);
        let selector_owned = selector.clone();
        let collector =
            ElementsCollectorWithWindows::new(&ax_root, move |ax| ax_matches_selector(ax, &selector_owned));
        let els = collector.find_all();
        Ok(els
            .into_iter()
            .map(|ax| UIElement::new(Box::new(MacOSAXElement::new(ax))))
            .collect())
    }

    fn open_application(&self, _app_name: &str) -> Result<UIElement, AutomationError> {
        let status = std::process::Command::new("open")
            .args(["-a", _app_name])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|e| AutomationError::PlatformError(format!("Failed to spawn 'open -a': {e}")))?;

        if !status.success() {
            return Err(AutomationError::PlatformError(
                "'open -a' returned non-zero exit status".to_string(),
            ));
        }

        // Wait briefly for a window to appear.
        let start = std::time::Instant::now();
        while start.elapsed() < Duration::from_secs(5) {
            if let Ok(el) = self.get_application_by_name(_app_name) {
                return Ok(el);
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Err(AutomationError::Timeout(format!(
            "Timed out waiting for '{_app_name}' to appear"
        )))
    }

    fn activate_application(&self, _app_name: &str) -> Result<(), AutomationError> {
        let script = format!("tell application \"{}\" to activate", _app_name.replace('"', "\\\""));
        let status = std::process::Command::new("osascript")
            .args(["-e", &script])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|e| AutomationError::PlatformError(format!("Failed to run osascript: {e}")))?;
        if !status.success() {
            return Err(AutomationError::PlatformError(
                "osascript returned non-zero exit status".to_string(),
            ));
        }
        Ok(())
    }

    fn open_url(&self, url: &str, _browser: Option<Browser>) -> Result<UIElement, AutomationError> {
        // Best-effort. This does not return a "live" UI element yet.
        let status = std::process::Command::new("open")
            .arg(url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|e| AutomationError::PlatformError(format!("Failed to spawn 'open': {e}")))?;

        if !status.success() {
            return Err(AutomationError::PlatformError(
                "'open' returned non-zero exit status".to_string(),
            ));
        }

        let mut el = StubElement::new("Application", Some("Browser".to_string()));
        el.url = Some(url.to_string());
        Ok(UIElement::new(Box::new(el)))
    }

    fn open_file(&self, file_path: &str) -> Result<(), AutomationError> {
        let status = std::process::Command::new("open")
            .arg(file_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|e| AutomationError::PlatformError(format!("Failed to spawn 'open': {e}")))?;

        if !status.success() {
            return Err(AutomationError::PlatformError(
                "'open' returned non-zero exit status".to_string(),
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

        // Click once or twice.
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
            AutomationError::InvalidArgument("unix_command is required on macOS".to_string())
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
                // Work area is Windows-only; on macOS we just treat full bounds as work area.
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
        // Reuse existing OCR provider.
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
        // Best-effort: activate the frontmost browser by title match.
        let needle = _title.to_lowercase();
        let windows = self.list_windows()?;
        for w in windows {
            if w.title
                .clone()
                .unwrap_or_default()
                .to_lowercase()
                .contains(&needle)
            {
                // Activate owning app. Specific window focus is not implemented yet.
                return self.activate_application(&w.owner_name);
            }
        }
        Err(AutomationError::ElementNotFound(format!(
            "No browser window matching title '{_title}'"
        )))
    }

    async fn get_current_browser_window(&self) -> Result<UIElement, AutomationError> {
        self.get_current_window().await
    }

    async fn get_current_window(&self) -> Result<UIElement, AutomationError> {
        let app = self.frontmost_app_name()?;
        let windows = self.list_windows()?;
        for w in windows {
            if w.owner_name == app {
                let name = w.title.or(Some(w.owner_name));
                return Ok(UIElement::new(Box::new(MacOSUIElement::new(
                    "Window",
                    name,
                    w.pid.max(0) as u32,
                    Some(w.bounds),
                    Some(w.window_id),
                ))));
            }
        }
        Err(AutomationError::ElementNotFound(
            "No active window found".to_string(),
        ))
    }

    async fn get_current_application(&self) -> Result<UIElement, AutomationError> {
        let name = self.frontmost_app_name()?;
        self.get_application_by_name(&name)
    }

    fn press_key(&self, _key: &str) -> Result<(), AutomationError> {
        Self::send_key_sequence(_key)
    }

    fn set_zoom(&self, _percentage: u32) -> Result<(), AutomationError> {
        // Best-effort: reset to 100%, then adjust in 10% increments with Cmd +/-.
        let mut enigo = Self::enigo()?;
        // Cmd+0
        enigo.key(Key::Meta, Direction::Press).ok();
        enigo.key(Key::Unicode('0'), Direction::Click).ok();
        enigo.key(Key::Meta, Direction::Release).ok();

        let pct = _percentage.clamp(25, 500);
        let steps: i32 = ((pct as i32 - 100) / 10).clamp(-30, 40);
        if steps == 0 {
            return Ok(());
        }

        enigo.key(Key::Meta, Direction::Press).map_err(|e| {
            AutomationError::PlatformError(format!("Failed to hold Cmd for zoom: {e}"))
        })?;
        let key = if steps > 0 { Key::Unicode('+') } else { Key::Unicode('-') };
        for _ in 0..steps.unsigned_abs() {
            enigo.key(key.clone(), Direction::Click).map_err(|e| {
                AutomationError::PlatformError(format!("Failed to adjust zoom: {e}"))
            })?;
        }
        let _ = enigo.key(Key::Meta, Direction::Release);
        Ok(())
    }

    fn get_window_tree(
        &self,
        pid: u32,
        title: Option<&str>,
        config: TreeBuildConfig,
    ) -> Result<UINode, AutomationError> {
        let app = AXUIElement::application(pid as i32);
        // Pick a window (best-effort).
        let windows = app.windows().map_err(ax_err_to_automation)?;
        let mut chosen: Option<AXUIElement> = None;
        for w in windows.iter() {
            let w_title = w.title().ok().map(|s| s.to_string()).unwrap_or_default();
            if title.is_none() || title.map(|t| w_title.to_lowercase().contains(&t.to_lowercase())).unwrap_or(false) {
                chosen = Some((*w).clone());
                break;
            }
        }
        let root = chosen.unwrap_or(app);
        Ok(self.build_ui_node_from_ax(&root, &config, 0))
    }

    fn get_tree_from_element(
        &self,
        element: &UIElement,
        config: TreeBuildConfig,
    ) -> Result<UINode, AutomationError> {
        if let Some(ax) = element.as_any().downcast_ref::<MacOSAXElement>() {
            return Ok(self.build_ui_node_from_ax(&ax.ax, &config, 0));
        }
        Err(AutomationError::UnsupportedOperation(
            "get_tree_from_element requires an AX-backed element on macOS".to_string(),
        ))
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

