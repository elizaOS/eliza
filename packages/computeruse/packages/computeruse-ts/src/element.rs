use napi::bindgen_prelude::FromNapiValue;
use napi::{self};
use napi_derive::napi;
use computeruse::{
    UIElement as ComputerUseUIElement, UIElementAttributes as ComputerUseUIElementAttributes,
};

use crate::{
    map_error, ActionResult, Bounds, ClickResult, ClickType, FontStyle, HighlightHandle, Locator,
    ScreenshotResult, TextPosition, UIElementAttributes,
};

use crate::Selector;
use napi::bindgen_prelude::Either;

/// Normalize key format to ensure curly brace syntax for special keys.
/// If key already contains `{`, assume it's correctly formatted.
/// Otherwise, wrap the entire key in `{}` to ensure it's treated as a special key press.
fn normalize_key(key: &str) -> String {
    if key.contains('{') {
        key.to_string()
    } else {
        format!("{{{}}}", key)
    }
}

/// Click position within element bounds as percentages (0-100)
#[napi(object)]
#[derive(Default, Clone)]
pub struct ClickPosition {
    /// X position as percentage from left edge (0-100). 50 = center.
    pub x_percentage: u8,
    /// Y position as percentage from top edge (0-100). 50 = center.
    pub y_percentage: u8,
}

/// Options for action methods (click, pressKey, scroll, etc.)
#[napi(object)]
#[derive(Default)]
pub struct ActionOptions {
    /// Whether to highlight the element before performing the action. Defaults to false.
    pub highlight_before_action: Option<bool>,
    /// Whether to capture window screenshot after action. Defaults to true.
    pub include_window_screenshot: Option<bool>,
    /// Whether to capture monitor screenshots after action. Defaults to false.
    pub include_monitor_screenshots: Option<bool>,
    /// Whether to try focusing the element before the action. Defaults to true.
    pub try_focus_before: Option<bool>,
    /// Whether to try clicking the element if focus fails. Defaults to true.
    pub try_click_before: Option<bool>,
    /// Whether to capture UI tree before/after action and compute diff. Defaults to false.
    pub ui_diff_before_after: Option<bool>,
    /// Max depth for tree capture when doing UI diff.
    pub ui_diff_max_depth: Option<u32>,
    /// Click position within element bounds. If not specified, clicks at center.
    pub click_position: Option<ClickPosition>,
    /// Type of click: 'Left', 'Double', or 'Right'. Defaults to 'Left'.
    pub click_type: Option<ClickType>,
    /// Whether to restore cursor to original position after click. Defaults to false.
    pub restore_cursor: Option<bool>,
    /// Whether to restore the original focus and caret position after the action. Defaults to false.
    /// When true, saves the currently focused element and caret position before the action, then restores them after.
    pub restore_focus: Option<bool>,
}

/// Options for typeText method
#[napi(object)]
#[derive(Default)]
pub struct TypeTextOptions {
    /// REQUIRED: Whether to clear existing text before typing.
    /// Set to true to clear the field first, false to append.
    pub clear_before_typing: bool,
    /// Whether to use clipboard for pasting. Defaults to false.
    pub use_clipboard: Option<bool>,
    /// Whether to highlight the element before typing. Defaults to false.
    pub highlight_before_action: Option<bool>,
    /// Whether to capture window screenshot after action. Defaults to true.
    pub include_window_screenshot: Option<bool>,
    /// Whether to capture monitor screenshots after action. Defaults to false.
    pub include_monitor_screenshots: Option<bool>,
    /// Whether to try focusing the element before typing. Defaults to true.
    pub try_focus_before: Option<bool>,
    /// Whether to try clicking the element if focus fails. Defaults to true.
    pub try_click_before: Option<bool>,
    /// Whether to restore the original focus and caret position after typing. Defaults to false.
    /// When true, saves the currently focused element and caret position before typing, then restores them after.
    pub restore_focus: Option<bool>,
    /// Whether to capture UI tree before/after action and compute diff. Defaults to false.
    pub ui_diff_before_after: Option<bool>,
    /// Max depth for tree capture when doing UI diff.
    pub ui_diff_max_depth: Option<u32>,
}

/// Result of screenshot capture for Element methods
#[derive(Default)]
struct ElementScreenshotPaths {
    window_path: Option<String>,
    monitor_paths: Option<Vec<String>>,
}

/// Helper to capture and save screenshots for Element methods
fn capture_element_screenshots(
    element: &ComputerUseUIElement,
    include_window: bool,
    include_monitors: bool,
    operation: &str,
) -> ElementScreenshotPaths {
    let mut result = ElementScreenshotPaths::default();

    if !include_window && !include_monitors {
        return result;
    }

    computeruse::screenshot_logger::init();
    let prefix = computeruse::screenshot_logger::generate_prefix(None, operation);

    if include_window {
        // Capture via element's application
        if let Ok(Some(app)) = element.application() {
            if let Ok(screenshot) = app.capture() {
                if let Some(saved) = computeruse::screenshot_logger::save_window_screenshot(
                    &screenshot,
                    &prefix,
                    None,
                ) {
                    result.window_path = Some(saved.path.to_string_lossy().to_string());
                }
            }
        }
    }

    if include_monitors {
        // Create temporary desktop for monitor capture
        if let Ok(temp_desktop) = computeruse::Desktop::new(false, false) {
            if let Ok(monitors) = futures::executor::block_on(temp_desktop.capture_all_monitors()) {
                let saved = computeruse::screenshot_logger::save_monitor_screenshots(
                    &monitors, &prefix, None,
                );
                if !saved.is_empty() {
                    result.monitor_paths = Some(
                        saved
                            .into_iter()
                            .map(|s| s.path.to_string_lossy().to_string())
                            .collect(),
                    );
                }
            }
        }
    }

    result
}

/// A UI element in the accessibility tree.
#[napi(js_name = "Element")]
pub struct Element {
    pub(crate) inner: ComputerUseUIElement,
}

impl From<ComputerUseUIElement> for Element {
    fn from(e: ComputerUseUIElement) -> Self {
        Element { inner: e }
    }
}

impl FromNapiValue for Element {
    unsafe fn from_napi_value(
        env: napi::sys::napi_env,
        napi_val: napi::sys::napi_value,
    ) -> napi::Result<Self> {
        let mut result = std::ptr::null_mut();
        let status = napi::sys::napi_get_value_external(env, napi_val, &mut result);
        if status != napi::sys::Status::napi_ok {
            return Err(napi::Error::new(
                napi::Status::InvalidArg,
                "Failed to get external value",
            ));
        }
        Ok(std::ptr::read(result as *const Element))
    }
}

#[napi]
impl Element {
    /// Get the element's ID.
    ///
    /// @returns {string | null} The element's ID, if available.
    #[napi]
    pub fn id(&self) -> Option<String> {
        self.inner.id()
    }

    /// Get the element's role.
    ///
    /// @returns {string} The element's role (e.g., "button", "textfield").
    #[napi]
    pub fn role(&self) -> napi::Result<String> {
        Ok(self.inner.role())
    }

    /// Get all attributes of the element.
    ///
    /// @returns {UIElementAttributes} The element's attributes.
    #[napi]
    pub fn attributes(&self) -> UIElementAttributes {
        let attrs: ComputerUseUIElementAttributes = self.inner.attributes();
        UIElementAttributes {
            role: attrs.role,
            name: attrs.name,
            label: attrs.label,
            value: attrs.value,
            description: attrs.description,
            properties: attrs
                .properties
                .into_iter()
                .map(|(k, v)| (k, v.map(|v| v.to_string())))
                .collect(),
            is_keyboard_focusable: attrs.is_keyboard_focusable,
            bounds: attrs.bounds.map(|(x, y, width, height)| Bounds {
                x,
                y,
                width,
                height,
            }),
        }
    }

    /// Get the element's name.
    ///
    /// @returns {string | null} The element's name, if available.
    #[napi]
    pub fn name(&self) -> napi::Result<Option<String>> {
        Ok(self.inner.name())
    }

    /// Get children of this element.
    ///
    /// @returns {Array<Element>} List of child elements.
    #[napi]
    pub fn children(&self) -> napi::Result<Vec<Element>> {
        self.inner
            .children()
            .map(|kids| kids.into_iter().map(Element::from).collect())
            .map_err(map_error)
    }

    /// Get the parent element.
    ///
    /// @returns {Element | null} The parent element, if available.
    #[napi]
    pub fn parent(&self) -> napi::Result<Option<Element>> {
        self.inner
            .parent()
            .map(|opt| opt.map(Element::from))
            .map_err(map_error)
    }

    /// Get element bounds.
    ///
    /// @returns {Bounds} The element's bounds (x, y, width, height).
    #[napi]
    pub fn bounds(&self) -> napi::Result<Bounds> {
        self.inner.bounds().map(Bounds::from).map_err(map_error)
    }

    /// Click on this element.
    ///
    /// @param {ActionOptions} [options] - Options for the click action.
    /// @returns {Promise<ClickResult>} Result of the click operation.
    #[napi]
    pub async fn click(&self, options: Option<ActionOptions>) -> napi::Result<ClickResult> {
        let opts = options.unwrap_or_default();
        // Default false: clicking means user wants focus on clicked element
        let _restore_focus = opts.restore_focus.unwrap_or(false);

        // FOCUS RESTORATION: Save focus state BEFORE any window operations
        #[cfg(target_os = "windows")]
        let saved_focus = if _restore_focus {
            tracing::debug!("[TS SDK] click: saving focus state BEFORE activate_window");
            computeruse::platforms::windows::save_focus_state()
        } else {
            None
        };

        if opts.highlight_before_action.unwrap_or(false) {
            let _ = self.inner.highlight_before_action("click");
        }
        let _ = self.inner.activate_window();

        // Determine click type
        let click_type: computeruse::ClickType = opts
            .click_type
            .map(|ct| ct.into())
            .unwrap_or(computeruse::ClickType::Left);

        // Check if custom position is specified
        let use_position = opts.click_position.is_some();
        let (x_pct, y_pct) = opts
            .click_position
            .map(|p| (p.x_percentage, p.y_percentage))
            .unwrap_or((50, 50));

        let mut result = if opts.ui_diff_before_after.unwrap_or(false) {
            // Use backend's execute_on_element_with_ui_diff for UI diff capture
            let diff_options = computeruse::UiDiffOptions {
                max_depth: opts.ui_diff_max_depth.map(|d| d as usize),
                settle_delay_ms: Some(1500),
                include_detailed_attributes: Some(true),
            };

            // Get desktop to call execute_on_element_with_ui_diff
            let desktop = computeruse::Desktop::new_default().map_err(map_error)?;
            let element_clone = self.inner.clone();

            let click_result_with_diff = if use_position {
                desktop
                    .execute_on_element_with_ui_diff(
                        element_clone,
                        |el| async move { el.click_at_position(x_pct, y_pct, click_type) },
                        Some(diff_options),
                    )
                    .await
            } else {
                desktop
                    .execute_on_element_with_ui_diff(
                        element_clone,
                        |el| async move { el.click() },
                        Some(diff_options),
                    )
                    .await
            };

            match click_result_with_diff {
                Ok((click_result, _element, ui_diff)) => {
                    let ui_diff_converted = ui_diff.map(|d| crate::types::UiDiffResult {
                        diff: d.diff,
                        has_changes: d.has_changes,
                    });
                    ClickResult {
                        method: click_result.method,
                        coordinates: click_result
                            .coordinates
                            .map(|c| crate::Coordinates { x: c.0, y: c.1 }),
                        details: click_result.details,
                        window_screenshot_path: None,
                        monitor_screenshot_paths: None,
                        ui_diff: ui_diff_converted,
                    }
                }
                Err(e) => {
                    return Err(map_error(e));
                }
            }
        } else {
            // Standard click without UI diff
            let click_res = if use_position {
                self.inner
                    .click_at_position(x_pct, y_pct, click_type)
                    .map_err(map_error)?
            } else {
                self.inner.click().map_err(map_error)?
            };
            ClickResult {
                method: click_res.method,
                coordinates: click_res
                    .coordinates
                    .map(|c| crate::Coordinates { x: c.0, y: c.1 }),
                details: click_res.details,
                window_screenshot_path: None,
                monitor_screenshot_paths: None,
                ui_diff: None,
            }
        };

        // Capture screenshots if requested
        let screenshots = capture_element_screenshots(
            &self.inner,
            opts.include_window_screenshot.unwrap_or(true),
            opts.include_monitor_screenshots.unwrap_or(false),
            "click",
        );
        result.window_screenshot_path = screenshots.window_path;
        result.monitor_screenshot_paths = screenshots.monitor_paths;

        // FOCUS RESTORATION: Restore focus state after action if we saved it
        #[cfg(target_os = "windows")]
        if let Some(state) = saved_focus {
            tracing::debug!("[TS SDK] click: restoring focus state after action");
            computeruse::platforms::windows::restore_focus_state(state);
        }

        Ok(result)
    }

    /// Double click on this element.
    ///
    /// @param {ActionOptions} [options] - Options for the double click action.
    /// @returns {ClickResult} Result of the click operation.
    #[napi]
    pub fn double_click(&self, options: Option<ActionOptions>) -> napi::Result<ClickResult> {
        let opts = options.unwrap_or_default();
        // Default false: clicking means user wants focus on clicked element
        let _restore_focus = opts.restore_focus.unwrap_or(false);

        // FOCUS RESTORATION: Save focus state BEFORE any window operations
        #[cfg(target_os = "windows")]
        let saved_focus = if _restore_focus {
            tracing::debug!("[TS SDK] double_click: saving focus state BEFORE activate_window");
            computeruse::platforms::windows::save_focus_state()
        } else {
            None
        };

        if opts.highlight_before_action.unwrap_or(false) {
            let _ = self.inner.highlight_before_action("double_click");
        }
        let _ = self.inner.activate_window();
        let mut result: ClickResult = self
            .inner
            .double_click()
            .map(ClickResult::from)
            .map_err(map_error)?;

        // Capture screenshots if requested
        let screenshots = capture_element_screenshots(
            &self.inner,
            opts.include_window_screenshot.unwrap_or(true),
            opts.include_monitor_screenshots.unwrap_or(false),
            "doubleClick",
        );
        result.window_screenshot_path = screenshots.window_path;
        result.monitor_screenshot_paths = screenshots.monitor_paths;

        // FOCUS RESTORATION: Restore focus state after action if we saved it
        #[cfg(target_os = "windows")]
        if let Some(state) = saved_focus {
            tracing::debug!("[TS SDK] double_click: restoring focus state after action");
            computeruse::platforms::windows::restore_focus_state(state);
        }

        Ok(result)
    }

    /// Right click on this element.
    ///
    /// @param {ActionOptions} [options] - Options for the right click action.
    #[napi]
    pub fn right_click(&self, options: Option<ActionOptions>) -> napi::Result<()> {
        let opts = options.unwrap_or_default();
        // Default false: clicking means user wants focus on clicked element
        let _restore_focus = opts.restore_focus.unwrap_or(false);

        // FOCUS RESTORATION: Save focus state BEFORE any window operations
        #[cfg(target_os = "windows")]
        let saved_focus = if _restore_focus {
            tracing::debug!("[TS SDK] right_click: saving focus state BEFORE activate_window");
            computeruse::platforms::windows::save_focus_state()
        } else {
            None
        };

        if opts.highlight_before_action.unwrap_or(false) {
            let _ = self.inner.highlight_before_action("right_click");
        }
        let _ = self.inner.activate_window();
        let result = self.inner.right_click().map_err(map_error);

        // Capture screenshots if requested
        let _screenshots = capture_element_screenshots(
            &self.inner,
            opts.include_window_screenshot.unwrap_or(true),
            opts.include_monitor_screenshots.unwrap_or(false),
            "rightClick",
        );

        // FOCUS RESTORATION: Restore focus state after action if we saved it
        #[cfg(target_os = "windows")]
        if let Some(state) = saved_focus {
            tracing::debug!("[TS SDK] right_click: restoring focus state after action");
            computeruse::platforms::windows::restore_focus_state(state);
        }

        result
    }

    /// Hover over this element.
    ///
    /// @param {ActionOptions} [options] - Optional action options.
    #[napi]
    pub fn hover(&self, options: Option<ActionOptions>) -> napi::Result<()> {
        let opts = options.unwrap_or_default();
        // Default false: hover shouldn't steal focus
        let _restore_focus = opts.restore_focus.unwrap_or(false);

        // FOCUS RESTORATION: Save focus state BEFORE any window operations
        #[cfg(target_os = "windows")]
        let saved_focus = if _restore_focus {
            tracing::debug!("[TS SDK] hover: saving focus state BEFORE activate_window");
            computeruse::platforms::windows::save_focus_state()
        } else {
            None
        };

        if opts.highlight_before_action.unwrap_or(false) {
            let _ = self.inner.highlight_before_action("hover");
        }
        let _ = self.inner.activate_window();
        let result = self.inner.hover().map_err(map_error);

        // Capture screenshots if requested
        let _screenshots = capture_element_screenshots(
            &self.inner,
            opts.include_window_screenshot.unwrap_or(true),
            opts.include_monitor_screenshots.unwrap_or(false),
            "hover",
        );

        // FOCUS RESTORATION: Restore focus state after action if we saved it
        #[cfg(target_os = "windows")]
        if let Some(state) = saved_focus {
            tracing::debug!("[TS SDK] hover: restoring focus state after action");
            computeruse::platforms::windows::restore_focus_state(state);
        }

        result
    }

    /// Check if element is visible.
    ///
    /// @returns {boolean} True if the element is visible.
    #[napi]
    pub fn is_visible(&self) -> napi::Result<bool> {
        self.inner.is_visible().map_err(map_error)
    }

    /// Check if element is enabled.
    ///
    /// @returns {boolean} True if the element is enabled.
    #[napi]
    pub fn is_enabled(&self) -> napi::Result<bool> {
        self.inner.is_enabled().map_err(map_error)
    }

    /// Focus this element.
    #[napi]
    pub fn focus(&self) -> napi::Result<()> {
        self.inner.focus().map_err(map_error)
    }

    /// Get text content of this element.
    ///
    /// @param {number} [maxDepth] - Maximum depth to search for text.
    /// @returns {string} The element's text content.
    #[napi]
    pub fn text(&self, max_depth: Option<u32>) -> napi::Result<String> {
        self.inner
            .text(max_depth.unwrap_or(1) as usize)
            .map_err(map_error)
    }

    /// Type text into this element.
    ///
    /// @param {string} text - The text to type.
    /// @param {TypeTextOptions} [options] - Options for typing.
    /// @returns {ActionResult} Result of the type operation.
    #[napi]
    pub fn type_text(
        &self,
        text: String,
        options: Option<TypeTextOptions>,
    ) -> napi::Result<ActionResult> {
        let opts = options.unwrap_or_default();
        let _restore_focus = opts.restore_focus.unwrap_or(true);

        // CRITICAL: Save focus state BEFORE activate_window() if restore is requested
        // activate_window() steals focus, so we must save first
        #[cfg(target_os = "windows")]
        let saved_focus = if _restore_focus {
            tracing::debug!("[TS SDK] type_text: saving focus state BEFORE activate_window");
            computeruse::platforms::windows::save_focus_state()
        } else {
            None
        };

        if opts.highlight_before_action.unwrap_or(false) {
            let _ = self.inner.highlight_before_action("type");
        }
        let _ = self.inner.activate_window();

        // Clear existing text if requested (matches MCP's clear_before_typing behavior)
        if opts.clear_before_typing {
            let _ = self.inner.set_value("");
        }

        let try_focus_before = opts.try_focus_before.unwrap_or(true);
        let try_click_before = opts.try_click_before.unwrap_or(true);
        // Pass restore_focus=false to platform layer since we handle it ourselves
        self.inner
            .type_text_with_state_and_focus_restore(
                &text,
                opts.use_clipboard.unwrap_or(false),
                try_focus_before,
                try_click_before,
                false, // We handle focus restore ourselves since we saved BEFORE activate_window
            )
            .map_err(map_error)?;

        // Restore focus state if we saved it
        #[cfg(target_os = "windows")]
        if let Some(state) = saved_focus {
            tracing::debug!("[TS SDK] type_text: restoring focus state after typing");
            computeruse::platforms::windows::restore_focus_state(state);
        }

        // Capture screenshots if requested
        let screenshots = capture_element_screenshots(
            &self.inner,
            opts.include_window_screenshot.unwrap_or(true),
            opts.include_monitor_screenshots.unwrap_or(false),
            "typeText",
        );

        Ok(ActionResult {
            success: true,
            window_screenshot_path: screenshots.window_path,
            monitor_screenshot_paths: screenshots.monitor_paths,
            ui_diff: None,
        })
    }

    /// Press a key while this element is focused.
    ///
    /// @param {string} key - The key to press.
    /// @param {ActionOptions} [options] - Options for the key press action.
    /// @returns {ActionResult} Result of the key press operation.
    #[napi]
    pub fn press_key(
        &self,
        key: String,
        options: Option<ActionOptions>,
    ) -> napi::Result<ActionResult> {
        let opts = options.unwrap_or_default();
        let _restore_focus = opts.restore_focus.unwrap_or(true);

        // FOCUS RESTORATION: Save focus state BEFORE any window operations
        #[cfg(target_os = "windows")]
        let saved_focus = if _restore_focus {
            tracing::debug!("[TS SDK] press_key: saving focus state BEFORE activate_window");
            computeruse::platforms::windows::save_focus_state()
        } else {
            None
        };

        if opts.highlight_before_action.unwrap_or(false) {
            let _ = self.inner.highlight_before_action("key");
        }
        let _ = self.inner.activate_window();
        let try_focus_before = opts.try_focus_before.unwrap_or(true);
        let try_click_before = opts.try_click_before.unwrap_or(true);
        // Normalize key to ensure curly brace format (e.g., "Enter" -> "{Enter}")
        let normalized_key = normalize_key(&key);
        tracing::debug!(
            "[TS SDK] press_key: normalized key: {} -> {}",
            key,
            normalized_key
        );
        self.inner
            .press_key_with_state_and_focus(&normalized_key, try_focus_before, try_click_before)
            .map_err(map_error)?;

        // Capture screenshots if requested
        let screenshots = capture_element_screenshots(
            &self.inner,
            opts.include_window_screenshot.unwrap_or(true),
            opts.include_monitor_screenshots.unwrap_or(false),
            "pressKey",
        );

        // FOCUS RESTORATION: Restore focus state after action if we saved it
        #[cfg(target_os = "windows")]
        if let Some(state) = saved_focus {
            tracing::debug!("[TS SDK] press_key: restoring focus state after action");
            computeruse::platforms::windows::restore_focus_state(state);
        }

        Ok(ActionResult {
            success: true,
            window_screenshot_path: screenshots.window_path,
            monitor_screenshot_paths: screenshots.monitor_paths,
            ui_diff: None,
        })
    }

    /// Set value of this element.
    ///
    /// @param {string} value - The value to set.
    /// @param {ActionOptions} [options] - Options for the set value action.
    /// @returns {ActionResult} Result of the set value operation.
    #[napi]
    pub fn set_value(
        &self,
        value: String,
        options: Option<ActionOptions>,
    ) -> napi::Result<ActionResult> {
        let opts = options.unwrap_or_default();
        let _restore_focus = opts.restore_focus.unwrap_or(true);

        // FOCUS RESTORATION: Save focus state BEFORE any window operations
        #[cfg(target_os = "windows")]
        let saved_focus = if _restore_focus {
            tracing::debug!("[TS SDK] set_value: saving focus state BEFORE action");
            computeruse::platforms::windows::save_focus_state()
        } else {
            None
        };

        if opts.highlight_before_action.unwrap_or(false) {
            let _ = self.inner.highlight_before_action("set_value");
        }
        self.inner.set_value(&value).map_err(map_error)?;

        // Capture screenshots if requested
        let screenshots = capture_element_screenshots(
            &self.inner,
            opts.include_window_screenshot.unwrap_or(true),
            opts.include_monitor_screenshots.unwrap_or(false),
            "setValue",
        );

        // FOCUS RESTORATION: Restore focus state after action if we saved it
        #[cfg(target_os = "windows")]
        if let Some(state) = saved_focus {
            tracing::debug!("[TS SDK] set_value: restoring focus state after action");
            computeruse::platforms::windows::restore_focus_state(state);
        }

        Ok(ActionResult {
            success: true,
            window_screenshot_path: screenshots.window_path,
            monitor_screenshot_paths: screenshots.monitor_paths,
            ui_diff: None,
        })
    }

    /// Perform a named action on this element.
    ///
    /// @param {string} action - The action to perform.
    #[napi]
    pub fn perform_action(&self, action: String) -> napi::Result<()> {
        self.inner.perform_action(&action).map_err(map_error)
    }

    /// Invoke this element (triggers the default action).
    /// This is often more reliable than clicking for controls like radio buttons or menu items.
    ///
    /// @param {ActionOptions} [options] - Options for the invoke action.
    /// @returns {ActionResult} Result of the invoke operation.
    #[napi]
    pub fn invoke(&self, options: Option<ActionOptions>) -> napi::Result<ActionResult> {
        let opts = options.unwrap_or_default();
        // Default false: invoking is like clicking
        let _restore_focus = opts.restore_focus.unwrap_or(false);

        // FOCUS RESTORATION: Save focus state BEFORE any window operations
        #[cfg(target_os = "windows")]
        let saved_focus = if _restore_focus {
            tracing::debug!("[TS SDK] invoke: saving focus state BEFORE action");
            computeruse::platforms::windows::save_focus_state()
        } else {
            None
        };

        if opts.highlight_before_action.unwrap_or(false) {
            let _ = self.inner.highlight_before_action("invoke");
        }
        self.inner.invoke().map_err(map_error)?;

        // Capture screenshots if requested
        let screenshots = capture_element_screenshots(
            &self.inner,
            opts.include_window_screenshot.unwrap_or(true),
            opts.include_monitor_screenshots.unwrap_or(false),
            "invoke",
        );

        // FOCUS RESTORATION: Restore focus state after action if we saved it
        #[cfg(target_os = "windows")]
        if let Some(state) = saved_focus {
            tracing::debug!("[TS SDK] invoke: restoring focus state after action");
            computeruse::platforms::windows::restore_focus_state(state);
        }

        Ok(ActionResult {
            success: true,
            window_screenshot_path: screenshots.window_path,
            monitor_screenshot_paths: screenshots.monitor_paths,
            ui_diff: None,
        })
    }

    /// Scroll the element in a given direction.
    ///
    /// @param {string} direction - The direction to scroll.
    /// @param {number} amount - The amount to scroll.
    /// @param {ActionOptions} [options] - Options for the scroll action.
    /// @returns {ActionResult} Result of the scroll operation.
    #[napi]
    pub fn scroll(
        &self,
        direction: String,
        amount: f64,
        options: Option<ActionOptions>,
    ) -> napi::Result<ActionResult> {
        let opts = options.unwrap_or_default();
        let _restore_focus = opts.restore_focus.unwrap_or(true);

        // FOCUS RESTORATION: Save focus state BEFORE any window operations
        #[cfg(target_os = "windows")]
        let saved_focus = if _restore_focus {
            tracing::debug!("[TS SDK] scroll: saving focus state BEFORE action");
            computeruse::platforms::windows::save_focus_state()
        } else {
            None
        };

        if opts.highlight_before_action.unwrap_or(false) {
            let _ = self.inner.highlight_before_action("scroll");
        }
        self.inner.scroll(&direction, amount).map_err(map_error)?;

        // Capture screenshots if requested
        let screenshots = capture_element_screenshots(
            &self.inner,
            opts.include_window_screenshot.unwrap_or(true),
            opts.include_monitor_screenshots.unwrap_or(false),
            "scroll",
        );

        // FOCUS RESTORATION: Restore focus state after action if we saved it
        #[cfg(target_os = "windows")]
        if let Some(state) = saved_focus {
            tracing::debug!("[TS SDK] scroll: restoring focus state after action");
            computeruse::platforms::windows::restore_focus_state(state);
        }

        Ok(ActionResult {
            success: true,
            window_screenshot_path: screenshots.window_path,
            monitor_screenshot_paths: screenshots.monitor_paths,
            ui_diff: None,
        })
    }

    /// Activate the window containing this element.
    #[napi]
    pub fn activate_window(&self) -> napi::Result<()> {
        self.inner.activate_window().map_err(map_error)
    }

    /// Minimize the window containing this element.
    #[napi]
    pub fn minimize_window(&self) -> napi::Result<()> {
        self.inner.minimize_window().map_err(map_error)
    }

    /// Maximize the window containing this element.
    #[napi]
    pub fn maximize_window(&self) -> napi::Result<()> {
        self.inner.maximize_window().map_err(map_error)
    }

    /// Check if element is focused.
    ///
    /// @returns {boolean} True if the element is focused.
    #[napi]
    pub fn is_focused(&self) -> napi::Result<bool> {
        self.inner.is_focused().map_err(map_error)
    }

    /// Check if element is keyboard focusable.
    ///
    /// @returns {boolean} True if the element can receive keyboard focus.
    #[napi]
    pub fn is_keyboard_focusable(&self) -> napi::Result<bool> {
        self.inner.is_keyboard_focusable().map_err(map_error)
    }

    /// Drag mouse from start to end coordinates.
    ///
    /// @param {number} startX - Starting X coordinate.
    /// @param {number} startY - Starting Y coordinate.
    /// @param {number} endX - Ending X coordinate.
    /// @param {number} endY - Ending Y coordinate.
    /// @param {ActionOptions} [options] - Optional action options.
    #[napi]
    pub fn mouse_drag(
        &self,
        start_x: f64,
        start_y: f64,
        end_x: f64,
        end_y: f64,
        options: Option<ActionOptions>,
    ) -> napi::Result<()> {
        let opts = options.unwrap_or_default();

        if opts.highlight_before_action.unwrap_or(false) {
            let _ = self.inner.highlight_before_action("mouse_drag");
        }

        let result = self
            .inner
            .mouse_drag(start_x, start_y, end_x, end_y)
            .map_err(map_error);

        // Capture screenshots if requested
        let _screenshots = capture_element_screenshots(
            &self.inner,
            opts.include_window_screenshot.unwrap_or(true),
            opts.include_monitor_screenshots.unwrap_or(false),
            "mouseDrag",
        );

        result
    }

    /// Press and hold mouse at coordinates.
    ///
    /// @param {number} x - X coordinate.
    /// @param {number} y - Y coordinate.
    #[napi]
    pub fn mouse_click_and_hold(&self, x: f64, y: f64) -> napi::Result<()> {
        self.inner.mouse_click_and_hold(x, y).map_err(map_error)
    }

    /// Move mouse to coordinates.
    ///
    /// @param {number} x - X coordinate.
    /// @param {number} y - Y coordinate.
    #[napi]
    pub fn mouse_move(&self, x: f64, y: f64) -> napi::Result<()> {
        self.inner.mouse_move(x, y).map_err(map_error)
    }

    /// Release mouse button.
    ///
    /// @param {ActionOptions} [options] - Optional action options.
    #[napi]
    pub fn mouse_release(&self, options: Option<ActionOptions>) -> napi::Result<()> {
        let opts = options.unwrap_or_default();

        if opts.highlight_before_action.unwrap_or(false) {
            let _ = self.inner.highlight_before_action("mouse_release");
        }

        let result = self.inner.mouse_release().map_err(map_error);

        // Capture screenshots if requested
        let _screenshots = capture_element_screenshots(
            &self.inner,
            opts.include_window_screenshot.unwrap_or(true),
            opts.include_monitor_screenshots.unwrap_or(false),
            "mouseRelease",
        );

        result
    }

    /// Create a locator from this element.
    /// Accepts either a selector string or a Selector object.
    ///
    /// @param {string | Selector} selector - The selector.
    /// @returns {Locator} A new locator for finding elements.
    #[napi]
    pub fn locator(
        &self,
        #[napi(ts_arg_type = "string | Selector")] selector: Either<String, &Selector>,
    ) -> napi::Result<Locator> {
        use napi::bindgen_prelude::Either::*;
        let sel_rust: computeruse::selector::Selector = match selector {
            A(sel_str) => sel_str.as_str().into(),
            B(sel_obj) => sel_obj.inner.clone(),
        };
        let loc = self.inner.locator(sel_rust).map_err(map_error)?;
        Ok(Locator::from(loc))
    }

    /// Get the containing application element.
    ///
    /// @returns {Element | null} The containing application element, if available.
    #[napi]
    pub fn application(&self) -> napi::Result<Option<Element>> {
        self.inner
            .application()
            .map(|opt| opt.map(Element::from))
            .map_err(map_error)
    }

    /// Get the containing window element.
    ///
    /// @returns {Element | null} The containing window element, if available.
    #[napi]
    pub fn window(&self) -> napi::Result<Option<Element>> {
        self.inner
            .window()
            .map(|opt| opt.map(Element::from))
            .map_err(map_error)
    }

    /// Highlights the element with a colored border and optional text overlay.
    ///
    /// @param {number} [color] - Optional BGR color code (32-bit integer). Default: 0x0000FF (red)
    /// @param {number} [durationMs] - Optional duration in milliseconds.
    /// @param {string} [text] - Optional text to display. Text will be truncated to 10 characters.
    /// @param {TextPosition} [textPosition] - Optional position for the text overlay (default: Top)
    /// @param {FontStyle} [fontStyle] - Optional font styling for the text
    /// @returns {HighlightHandle} Handle that can be used to close the highlight early
    #[napi]
    pub fn highlight(
        &self,
        color: Option<u32>,
        duration_ms: Option<f64>,
        text: Option<String>,
        text_position: Option<TextPosition>,
        font_style: Option<FontStyle>,
    ) -> napi::Result<HighlightHandle> {
        let duration = duration_ms.map(|ms| std::time::Duration::from_millis(ms as u64));

        #[cfg(target_os = "windows")]
        {
            let rust_text_position = text_position.map(|pos| pos.into());
            let rust_font_style = font_style.map(|style| style.into());

            let handle = self
                .inner
                .highlight(
                    color,
                    duration,
                    text.as_deref(),
                    rust_text_position,
                    rust_font_style,
                )
                .map_err(map_error)?;

            Ok(HighlightHandle::new(handle))
        }

        #[cfg(not(target_os = "windows"))]
        {
            let _ = (color, duration, text, text_position, font_style);
            Ok(HighlightHandle::new_dummy())
        }
    }

    /// Capture a screenshot of this element.
    ///
    /// @returns {ScreenshotResult} The screenshot data containing image data and dimensions.
    #[napi]
    pub fn capture(&self) -> napi::Result<ScreenshotResult> {
        self.inner
            .capture()
            .map(|result| ScreenshotResult {
                image_data: result.image_data,
                width: result.width,
                height: result.height,
                monitor: result.monitor.map(crate::types::Monitor::from),
            })
            .map_err(map_error)
    }

    /// Get the process ID of the application containing this element.
    ///
    /// @returns {number} The process ID.
    #[napi]
    pub fn process_id(&self) -> napi::Result<u32> {
        self.inner.process_id().map_err(map_error)
    }

    /// Get the process name of the application containing this element.
    ///
    /// @returns {string} The process name (e.g., "chrome", "notepad").
    #[napi]
    pub fn process_name(&self) -> napi::Result<String> {
        self.inner.process_name().map_err(map_error)
    }

    #[napi]
    pub fn to_string(&self) -> napi::Result<String> {
        let id_part = self.inner.id().map_or("null".to_string(), |id| id);

        let attrs = self.inner.attributes();
        let json =
            serde_json::to_string(&attrs).map_err(|e| napi::Error::from_reason(e.to_string()))?;

        Ok(format!("Element<{id_part}, {json}>"))
    }

    /// Sets the transparency of the window.
    ///
    /// @param {number} percentage - The transparency percentage from 0 (completely transparent) to 100 (completely opaque).
    /// @returns {void}
    #[napi]
    pub fn set_transparency(&self, percentage: u8) -> napi::Result<()> {
        self.inner.set_transparency(percentage).map_err(map_error)
    }

    /// Close the element if it's closable (like windows, applications).
    /// Does nothing for non-closable elements (like buttons, text, etc.).
    ///
    /// @returns {void}
    #[napi]
    pub fn close(&self) -> napi::Result<()> {
        self.inner.close().map_err(map_error)
    }

    /// Get the monitor containing this element.
    ///
    /// @returns {Monitor} The monitor information for the display containing this element.
    #[napi]
    pub fn monitor(&self) -> napi::Result<crate::types::Monitor> {
        self.inner
            .monitor()
            .map(crate::types::Monitor::from)
            .map_err(map_error)
    }

    /// Scrolls the element into view within its window viewport.
    /// If the element is already visible, returns immediately.
    ///
    /// @returns {void}
    #[napi]
    pub fn scroll_into_view(&self) -> napi::Result<()> {
        self.inner.scroll_into_view().map_err(map_error)
    }

    /// Selects an option in a dropdown or combobox by its visible text.
    ///
    /// @param {string} optionName - The visible text of the option to select.
    /// @param {ActionOptions} [options] - Optional action options.
    /// @returns {void}
    #[napi]
    pub fn select_option(
        &self,
        option_name: String,
        options: Option<ActionOptions>,
    ) -> napi::Result<()> {
        let opts = options.unwrap_or_default();
        let _restore_focus = opts.restore_focus.unwrap_or(true);

        // FOCUS RESTORATION: Save focus state BEFORE any window operations
        #[cfg(target_os = "windows")]
        let saved_focus = if _restore_focus {
            tracing::debug!("[TS SDK] select_option: saving focus state BEFORE action");
            computeruse::platforms::windows::save_focus_state()
        } else {
            None
        };

        if opts.highlight_before_action.unwrap_or(false) {
            let _ = self.inner.highlight_before_action("select_option");
        }
        let result = self.inner.select_option(&option_name).map_err(map_error);

        // Capture screenshots if requested
        let _screenshots = capture_element_screenshots(
            &self.inner,
            opts.include_window_screenshot.unwrap_or(true),
            opts.include_monitor_screenshots.unwrap_or(false),
            "selectOption",
        );

        // FOCUS RESTORATION: Restore focus state after action if we saved it
        #[cfg(target_os = "windows")]
        if let Some(state) = saved_focus {
            tracing::debug!("[TS SDK] select_option: restoring focus state after action");
            computeruse::platforms::windows::restore_focus_state(state);
        }

        result
    }

    /// Lists all available option strings from a dropdown or list box.
    ///
    /// @returns {Array<string>} List of available option strings.
    #[napi]
    pub fn list_options(&self) -> napi::Result<Vec<String>> {
        self.inner.list_options().map_err(map_error)
    }

    /// Checks if a control (like a checkbox or toggle switch) is currently toggled on.
    ///
    /// @returns {boolean} True if the control is toggled on.
    #[napi]
    pub fn is_toggled(&self) -> napi::Result<bool> {
        self.inner.is_toggled().map_err(map_error)
    }

    /// Sets the state of a toggleable control.
    /// It only performs an action if the control is not already in the desired state.
    ///
    /// @param {boolean} state - The desired toggle state.
    /// @param {ActionOptions} [options] - Optional action options.
    /// @returns {void}
    #[napi]
    pub fn set_toggled(&self, state: bool, options: Option<ActionOptions>) -> napi::Result<()> {
        let opts = options.unwrap_or_default();

        if opts.highlight_before_action.unwrap_or(false) {
            let _ = self.inner.highlight_before_action("set_toggled");
        }

        let result = self.inner.set_toggled(state).map_err(map_error);

        // Capture screenshots if requested
        let _screenshots = capture_element_screenshots(
            &self.inner,
            opts.include_window_screenshot.unwrap_or(true),
            opts.include_monitor_screenshots.unwrap_or(false),
            "setToggled",
        );

        result
    }

    /// Checks if an element is selected (e.g., list item, tree node, tab).
    ///
    /// @returns {boolean} True if the element is selected, false otherwise.
    #[napi]
    pub fn is_selected(&self) -> napi::Result<bool> {
        self.inner.is_selected().map_err(map_error)
    }

    /// Sets the selection state of a selectable item.
    /// Only performs an action if the element is not already in the desired state.
    ///
    /// @param {boolean} state - The desired selection state.
    /// @param {ActionOptions} [options] - Optional action options.
    /// @returns {void}
    #[napi]
    pub fn set_selected(&self, state: bool, options: Option<ActionOptions>) -> napi::Result<()> {
        let opts = options.unwrap_or_default();
        let _restore_focus = opts.restore_focus.unwrap_or(true);

        // FOCUS RESTORATION: Save focus state BEFORE any window operations
        #[cfg(target_os = "windows")]
        let saved_focus = if _restore_focus {
            tracing::debug!("[TS SDK] set_selected: saving focus state BEFORE action");
            computeruse::platforms::windows::save_focus_state()
        } else {
            None
        };

        if opts.highlight_before_action.unwrap_or(false) {
            let _ = self.inner.highlight_before_action("set_selected");
        }
        let result = self.inner.set_selected(state).map_err(map_error);

        // Capture screenshots if requested
        let _screenshots = capture_element_screenshots(
            &self.inner,
            opts.include_window_screenshot.unwrap_or(true),
            opts.include_monitor_screenshots.unwrap_or(false),
            "setSelected",
        );

        // FOCUS RESTORATION: Restore focus state after action if we saved it
        #[cfg(target_os = "windows")]
        if let Some(state) = saved_focus {
            tracing::debug!("[TS SDK] set_selected: restoring focus state after action");
            computeruse::platforms::windows::restore_focus_state(state);
        }

        result
    }

    /// Gets the current value from a range-based control like a slider or progress bar.
    ///
    /// @returns {number} The current value of the range control.
    #[napi]
    pub fn get_range_value(&self) -> napi::Result<f64> {
        self.inner.get_range_value().map_err(map_error)
    }

    /// Sets the value of a range-based control like a slider.
    ///
    /// @param {number} value - The value to set.
    /// @param {ActionOptions} [options] - Optional action options.
    /// @returns {void}
    #[napi]
    pub fn set_range_value(&self, value: f64, options: Option<ActionOptions>) -> napi::Result<()> {
        let opts = options.unwrap_or_default();

        if opts.highlight_before_action.unwrap_or(false) {
            let _ = self.inner.highlight_before_action("set_range_value");
        }

        let result = self.inner.set_range_value(value).map_err(map_error);

        // Capture screenshots if requested
        let _screenshots = capture_element_screenshots(
            &self.inner,
            opts.include_window_screenshot.unwrap_or(true),
            opts.include_monitor_screenshots.unwrap_or(false),
            "setRangeValue",
        );

        result
    }

    /// Gets the value attribute of an element (text inputs, combo boxes, etc.).
    ///
    /// @returns {string | null} The value attribute, or null if not available.
    #[napi]
    pub fn get_value(&self) -> napi::Result<Option<String>> {
        self.inner.get_value().map_err(map_error)
    }

    /// Execute JavaScript in web browser using dev tools console.
    /// Returns the result of the script execution as a string.
    ///
    /// @param {string} script - The JavaScript code to execute.
    /// @returns {Promise<string>} The result of script execution.
    #[napi]
    pub async fn execute_browser_script(&self, script: String) -> napi::Result<String> {
        self.inner
            .execute_browser_script(&script)
            .await
            .map_err(map_error)
    }

    /// Get the UI tree starting from this element.
    /// Returns a tree structure containing this element and all its descendants.
    ///
    /// @param {number} [maxDepth=100] - Maximum depth to traverse (default: 100).
    /// @returns {UINode} Tree structure with recursive children.
    #[napi]
    pub fn get_tree(&self, max_depth: Option<i32>) -> napi::Result<crate::UINode> {
        let depth = max_depth.unwrap_or(100).max(0) as usize;
        let serializable_tree = self.inner.to_serializable_tree(depth);
        Ok(crate::types::serializable_to_ui_node(&serializable_tree))
    }
}
