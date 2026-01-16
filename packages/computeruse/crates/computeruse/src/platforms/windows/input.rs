//! Input operations (mouse, keyboard, scroll) for Windows
//!
//! This module provides low-level input functions that are shared across
//! engine.rs and element.rs to avoid code duplication.

use crate::{AutomationError, ClickType};
use std::thread;
use std::time::Duration;
use tracing::info;
use windows::core::BOOL;
use windows::Win32::Foundation::POINT;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationTextPattern2,
    IUIAutomationTextRange, UIA_TextPattern2Id,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_LEFTDOWN,
    MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEINPUT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetSystemMetrics, SetCursorPos, SM_CXSCREEN, SM_CYSCREEN,
};

/// Send a mouse click at absolute screen coordinates.
///
/// This is the single source of truth for all mouse click operations.
/// Both engine.rs (Desktop.click_at_coordinates) and element.rs (UIElement.click)
/// should use this function.
///
/// # Arguments
/// * `x` - Absolute screen X coordinate
/// * `y` - Absolute screen Y coordinate
/// * `click_type` - Type of click: Left, Double, or Right
/// * `restore_cursor` - If true, cursor returns to original position after click
pub fn send_mouse_click(
    x: f64,
    y: f64,
    click_type: ClickType,
    restore_cursor: bool,
) -> Result<(), AutomationError> {
    // Save original cursor position if restore is requested
    let original_pos = if restore_cursor {
        let mut pos = POINT { x: 0, y: 0 };
        unsafe {
            let _ = GetCursorPos(&mut pos);
        }
        Some(pos)
    } else {
        None
    };

    unsafe {
        let screen_width = GetSystemMetrics(SM_CXSCREEN) as f64;
        let screen_height = GetSystemMetrics(SM_CYSCREEN) as f64;

        // Convert to normalized coordinates (0-65535 range)
        let abs_x = ((x * 65535.0) / screen_width) as i32;
        let abs_y = ((y * 65535.0) / screen_height) as i32;

        // Determine button flags based on click type
        let (down_flag, up_flag) = match click_type {
            ClickType::Left | ClickType::Double => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
            ClickType::Right => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        };

        // Move to position first
        let move_input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: abs_x,
                    dy: abs_y,
                    mouseData: 0,
                    dwFlags: MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_MOVE,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };

        // Mouse down
        let down_input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: abs_x,
                    dy: abs_y,
                    mouseData: 0,
                    dwFlags: MOUSEEVENTF_ABSOLUTE | down_flag,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };

        // Mouse up
        let up_input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: abs_x,
                    dy: abs_y,
                    mouseData: 0,
                    dwFlags: MOUSEEVENTF_ABSOLUTE | up_flag,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };

        // Send inputs
        SendInput(&[move_input], std::mem::size_of::<INPUT>() as i32);
        SendInput(&[down_input], std::mem::size_of::<INPUT>() as i32);
        SendInput(&[up_input], std::mem::size_of::<INPUT>() as i32);

        // For double-click, send another click sequence
        if click_type == ClickType::Double {
            std::thread::sleep(std::time::Duration::from_millis(50));
            SendInput(&[down_input], std::mem::size_of::<INPUT>() as i32);
            SendInput(&[up_input], std::mem::size_of::<INPUT>() as i32);
        }
    }

    // Restore cursor position if requested
    if let Some(pos) = original_pos {
        unsafe {
            let _ = SetCursorPos(pos.x, pos.y);
        }
    }

    Ok(())
}

/// Send a simple left click at absolute screen coordinates.
/// Convenience wrapper for send_mouse_click with Left click type.
#[inline]
pub fn send_left_click(x: f64, y: f64, restore_cursor: bool) -> Result<(), AutomationError> {
    send_mouse_click(x, y, ClickType::Left, restore_cursor)
}

/// Saved focus state for restoration after automation operations.
///
/// Contains the previously focused element, optional caret position (for text fields),
/// and mouse cursor position. Used to restore user's context after typing/pressing keys.
///
/// # Safety
/// This struct is marked as Send + Sync because:
/// 1. We use COINIT_MULTITHREADED (MTA) for COM initialization
/// 2. UI Automation COM objects support cross-thread access in MTA mode
/// 3. The FocusState is saved on one thread and restored on the same/different thread
///    within the same MTA apartment, which is valid COM usage
pub struct FocusState {
    #[allow(dead_code)]
    automation: IUIAutomation,
    focused_element: IUIAutomationElement,
    caret_range: Option<IUIAutomationTextRange>,
}

// SAFETY: COM objects in MTA mode can be accessed from any thread in the apartment.
// We initialize with COINIT_MULTITHREADED and these interfaces support MTA.
unsafe impl Send for FocusState {}
unsafe impl Sync for FocusState {}

/// Save the current focus state including focused element and caret position.
///
/// Returns None if focus state cannot be saved (e.g., no focused element).
/// Caret position is only saved if the focused element supports TextPattern2.
pub fn save_focus_state() -> Option<FocusState> {
    unsafe {
        info!("[FOCUS_RESTORE] save_focus_state() called");

        // Initialize COM for this thread (required for UIA)
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        if hr.is_err() && hr.0 != 0x80010106u32 as i32 {
            // 0x80010106 = RPC_E_CHANGED_MODE (already initialized) - that's OK
            info!("[FOCUS_RESTORE] COM init failed: {:?}", hr);
            return None;
        }

        // Create UI Automation instance
        let automation: IUIAutomation =
            match CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) {
                Ok(a) => a,
                Err(e) => {
                    info!("[FOCUS_RESTORE] Failed to create UIA: {:?}", e);
                    return None;
                }
            };

        // Get focused element
        let focused_element = match automation.GetFocusedElement() {
            Ok(el) => el,
            Err(e) => {
                info!("[FOCUS_RESTORE] GetFocusedElement failed: {:?}", e);
                return None;
            }
        };

        // Get element name for logging
        let element_name = focused_element
            .CurrentName()
            .ok()
            .map(|s| s.to_string())
            .unwrap_or_else(|| "<no name>".to_string());
        let element_class = focused_element
            .CurrentClassName()
            .ok()
            .map(|s| s.to_string())
            .unwrap_or_else(|| "<no class>".to_string());

        // Try to get caret position if element supports TextPattern2
        let caret_range = if let Ok(pattern) =
            focused_element.GetCurrentPatternAs::<IUIAutomationTextPattern2>(UIA_TextPattern2Id)
        {
            let mut is_active = BOOL::default();
            if let Ok(range) = pattern.GetCaretRange(&mut is_active) {
                info!("[FOCUS_RESTORE] Got caret range, is_active={:?}", is_active);
                range.Clone().ok()
            } else {
                info!("[FOCUS_RESTORE] GetCaretRange failed");
                None
            }
        } else {
            info!("[FOCUS_RESTORE] Element does not support TextPattern2");
            None
        };

        info!(
            "[FOCUS_RESTORE] Saved: element='{}' class='{}' has_caret={}",
            element_name,
            element_class,
            caret_range.is_some()
        );

        Some(FocusState {
            automation,
            focused_element,
            caret_range,
        })
    }
}

/// Restore a previously saved focus state.
///
/// Restores focus to the saved element and caret position (if available).
/// Silently fails if restoration is not possible (element no longer valid, etc.).
pub fn restore_focus_state(state: FocusState) {
    unsafe {
        info!("[FOCUS_RESTORE] restore_focus_state() called");

        // Initialize COM for this thread (required for UIA)
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        if hr.is_err() && hr.0 != 0x80010106u32 as i32 {
            info!("[FOCUS_RESTORE] COM init failed in restore: {:?}", hr);
            return;
        }

        // Get element info for logging
        let element_name = state
            .focused_element
            .CurrentName()
            .ok()
            .map(|s| s.to_string())
            .unwrap_or_else(|| "<no name>".to_string());

        // Restore focus to the element
        match state.focused_element.SetFocus() {
            Ok(_) => info!("[FOCUS_RESTORE] SetFocus succeeded for '{}'", element_name),
            Err(e) => info!(
                "[FOCUS_RESTORE] SetFocus failed for '{}': {:?}",
                element_name, e
            ),
        }

        // Restore caret position if we have it
        if let Some(ref range) = state.caret_range {
            // Small delay to let focus settle before selecting
            thread::sleep(Duration::from_millis(50));
            match range.Select() {
                Ok(_) => info!("[FOCUS_RESTORE] Caret Select() succeeded"),
                Err(e) => info!("[FOCUS_RESTORE] Caret Select() failed: {:?}", e),
            }
        }

        info!(
            "[FOCUS_RESTORE] Restoration complete: element='{}' had_caret={}",
            element_name,
            state.caret_range.is_some()
        );
    }
}
