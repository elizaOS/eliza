//! Action overlay for Windows
//! Shows a click-through full-screen overlay with status messages during
//! action execution (click, type, press_key, etc.). Features:
//! - Full-screen click-through overlay (30% opaque)
//! - Static status messages showing action name and element info
//! - Auto-hides when action completes
//! - Can be globally enabled/disabled

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::{Duration, Instant};

use tracing::{debug, error, info};

use windows::core::PCWSTR;
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::*;

const OVERLAY_CLASS_NAME: PCWSTR = windows::core::w!("ComputerUseActionOverlay");

// Minimum time between overlay state changes (prevent flashing)
const OVERLAY_CHANGE_COOLDOWN_MS: u64 = 100;

// Minimum time overlay must be visible (prevents instant show/hide)
const MINIMUM_DISPLAY_MS: u64 = 300;

// Time to wait after spawning thread to ensure window is visible
const WINDOW_CREATION_DELAY_MS: u64 = 50;

// Global enable/disable flag (default: enabled, can be disabled via COMPUTERUSE_ACTION_OVERLAY=0)
static ACTION_OVERLAY_ENABLED: AtomicBool = AtomicBool::new(true);

// Check env var on first access
static OVERLAY_ENV_CHECKED: once_cell::sync::Lazy<()> = once_cell::sync::Lazy::new(|| {
    if let Ok(val) = std::env::var("COMPUTERUSE_ACTION_OVERLAY") {
        if val == "0" || val.eq_ignore_ascii_case("false") || val.eq_ignore_ascii_case("off") {
            ACTION_OVERLAY_ENABLED.store(false, Ordering::SeqCst);
            tracing::info!("Action overlay disabled via COMPUTERUSE_ACTION_OVERLAY env var");
        }
    }
});

// Track when overlay was shown for minimum display time enforcement
static OVERLAY_SHOWN_AT: once_cell::sync::Lazy<Mutex<Option<Instant>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));

// Global overlay state using std::sync (not tokio) for use in Win32 callbacks
static OVERLAY_STATE: once_cell::sync::Lazy<RwLock<OverlayState>> =
    once_cell::sync::Lazy::new(|| RwLock::new(OverlayState::default()));

// Anti-spam protection
static LAST_OVERLAY_CHANGE: once_cell::sync::Lazy<Mutex<Option<Instant>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));

// Global should_close flag for signaling overlay thread to exit
static SHOULD_CLOSE: once_cell::sync::Lazy<Mutex<Option<Arc<AtomicBool>>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));

#[derive(Default, Clone)]
struct OverlayState {
    is_visible: bool,
    message: String,
    sub_message: Option<String>,
    window_handle: Option<isize>,
}

/// Enable or disable action overlay globally.
/// When disabled, show_action_overlay() becomes a no-op.
pub fn set_action_overlay_enabled(enabled: bool) {
    let was_enabled = ACTION_OVERLAY_ENABLED.swap(enabled, Ordering::SeqCst);
    if was_enabled != enabled {
        info!(
            "Action overlay {} (was {})",
            if enabled { "enabled" } else { "disabled" },
            if was_enabled { "enabled" } else { "disabled" }
        );
        // If disabling, hide any active overlay
        if !enabled {
            hide_action_overlay();
        }
    }
}

/// Check if action overlay is currently enabled
pub fn is_action_overlay_enabled() -> bool {
    ACTION_OVERLAY_ENABLED.load(Ordering::SeqCst)
}

/// Show action overlay with the given message.
/// Returns immediately - overlay is shown asynchronously.
/// If overlay is disabled or cooldown is active, this is a no-op.
pub fn show_action_overlay(message: impl Into<String>, sub_message: Option<String>) {
    // Trigger env var check on first call
    #[allow(clippy::let_unit_value)]
    let _check = &*OVERLAY_ENV_CHECKED;

    if !ACTION_OVERLAY_ENABLED.load(Ordering::SeqCst) {
        debug!("Action overlay disabled, skipping show");
        return;
    }

    let message = message.into();
    info!("action_overlay show: {}", message);

    // Check anti-spam cooldown
    {
        if let Ok(last_change) = LAST_OVERLAY_CHANGE.lock() {
            if let Some(last) = *last_change {
                if last.elapsed() < Duration::from_millis(OVERLAY_CHANGE_COOLDOWN_MS) {
                    debug!(
                        "Skipping overlay change - cooldown active ({:.1}ms remaining)",
                        (Duration::from_millis(OVERLAY_CHANGE_COOLDOWN_MS) - last.elapsed())
                            .as_millis()
                    );
                    return;
                }
            }
        }
    }

    // Update last change time
    if let Ok(mut last_change) = LAST_OVERLAY_CHANGE.lock() {
        *last_change = Some(Instant::now());
    }

    // Record when overlay was shown for minimum display time
    if let Ok(mut shown_at) = OVERLAY_SHOWN_AT.lock() {
        *shown_at = Some(Instant::now());
    }

    // Update state
    if let Ok(mut state) = OVERLAY_STATE.write() {
        state.message = message.clone();
        state.sub_message = sub_message.clone();
        state.is_visible = true;
    }

    // Spawn the overlay window in a separate thread
    thread::spawn(move || {
        if let Err(e) = create_overlay_window() {
            error!("Failed to create action overlay: {}", e);
        }
    });

    // Wait a bit to ensure window is created and visible before returning
    thread::sleep(Duration::from_millis(WINDOW_CREATION_DELAY_MS));
    debug!(
        "action_overlay show complete (waited {}ms for window)",
        WINDOW_CREATION_DELAY_MS
    );
}

/// Hide the action overlay
pub fn hide_action_overlay() {
    // Enforce minimum display time
    if let Ok(mut shown_at) = OVERLAY_SHOWN_AT.lock() {
        if let Some(shown) = shown_at.take() {
            let elapsed = shown.elapsed();
            let min_display = Duration::from_millis(MINIMUM_DISPLAY_MS);
            if elapsed < min_display {
                let wait_time = min_display - elapsed;
                debug!(
                    "action_overlay waiting {}ms to meet minimum display time",
                    wait_time.as_millis()
                );
                thread::sleep(wait_time);
            }
        }
    }

    info!("action_overlay hide");

    // Get handle and update state atomically
    let handle = {
        if let Ok(mut state) = OVERLAY_STATE.write() {
            let was_visible = state.is_visible;
            state.is_visible = false;
            let h = state.window_handle.take();
            debug!(
                "hide(): was_visible={}, took_handle={}",
                was_visible,
                h.is_some()
            );
            h
        } else {
            None
        }
    };

    // Signal overlay thread to close via global flag
    if let Ok(mut global_close) = SHOULD_CLOSE.lock() {
        if let Some(should_close) = global_close.take() {
            should_close.store(true, Ordering::SeqCst);
            debug!("Signaled overlay thread to close");
        }
    }

    // Also try to destroy window directly if handle exists
    if let Some(h) = handle {
        destroy_overlay_window(h);
    }
}

/// Update the message on an existing overlay (or show if not visible)
pub fn update_action_overlay_message(message: impl Into<String>, sub_message: Option<String>) {
    let message = message.into();

    let is_visible = OVERLAY_STATE.read().map(|s| s.is_visible).unwrap_or(false);

    if !is_visible {
        // If not visible, show it with the new message
        show_action_overlay(message, sub_message);
        return;
    }

    // Update the message
    let hwnd = if let Ok(mut state) = OVERLAY_STATE.write() {
        state.message = message.clone();
        state.sub_message = sub_message.clone();
        state.window_handle
    } else {
        None
    };

    info!("Updated overlay message: {}", message);

    // Trigger window redraw
    if let Some(h) = hwnd {
        unsafe {
            let hwnd = HWND(h as *mut _);
            if IsWindow(Some(hwnd)).as_bool() {
                let _ = InvalidateRect(Some(hwnd), None, true);
            }
        }
    }
}

/// RAII guard that shows overlay on creation and hides on drop
pub struct ActionOverlayGuard {
    _private: (),
}

impl ActionOverlayGuard {
    /// Create a new overlay guard that shows the overlay
    pub fn new(action: &str, element_info: Option<&str>) -> Self {
        let sub_message = element_info.map(|s| s.to_string());
        show_action_overlay(action, sub_message);
        Self { _private: () }
    }
}

impl Drop for ActionOverlayGuard {
    fn drop(&mut self) {
        hide_action_overlay();
    }
}

// Helper function to create wide string
fn to_wide_string(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn create_overlay_window() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    unsafe {
        let h_instance = GetModuleHandleW(None)?;

        // Register window class (may already be registered)
        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(overlay_window_proc),
            hInstance: HINSTANCE(h_instance.0),
            hCursor: LoadCursorW(None, IDC_ARROW)?,
            hbrBackground: HBRUSH(std::ptr::null_mut()),
            lpszClassName: OVERLAY_CLASS_NAME,
            ..Default::default()
        };

        let atom = RegisterClassExW(&wc);
        if atom == 0 {
            debug!("Window class already registered or registration failed");
        }

        // Get virtual screen dimensions (all monitors)
        let screen_x = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let screen_y = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let screen_width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let screen_height = GetSystemMetrics(SM_CYVIRTUALSCREEN);

        let window_name = to_wide_string("ComputerUse Action Status");

        // Create full-screen click-through overlay window
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE(
                WS_EX_TOPMOST.0
                    | WS_EX_LAYERED.0
                    | WS_EX_TRANSPARENT.0
                    | WS_EX_TOOLWINDOW.0
                    | WS_EX_NOACTIVATE.0,
            ),
            OVERLAY_CLASS_NAME,
            PCWSTR::from_raw(window_name.as_ptr()),
            WINDOW_STYLE(WS_POPUP.0),
            screen_x,
            screen_y,
            screen_width,
            screen_height,
            None,
            None,
            Some(HINSTANCE(h_instance.0)),
            None,
        )?;

        // Store window handle and check if we should destroy immediately
        let new_handle = hwnd.0 as isize;
        let should_destroy = {
            if let Ok(mut state) = OVERLAY_STATE.write() {
                if !state.is_visible {
                    // hide() was called before window was created
                    info!(
                        "Window created but is_visible=false - destroying immediately (handle={})",
                        new_handle
                    );
                    true
                } else {
                    // Destroy any existing window before storing new handle
                    if let Some(old) = state.window_handle.take() {
                        destroy_overlay_window(old);
                    }
                    state.window_handle = Some(new_handle);
                    false
                }
            } else {
                true
            }
        };

        if should_destroy {
            let _ = DestroyWindow(hwnd);
            return Ok(());
        }

        // Set transparency (30% opaque = 77/255, very transparent)
        SetLayeredWindowAttributes(hwnd, COLORREF(0), 77, LWA_ALPHA)?;

        // Show the window
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);

        info!("Action overlay window created successfully");

        // Set up should_close flag for this overlay
        let should_close = Arc::new(AtomicBool::new(false));
        if let Ok(mut global_close) = SHOULD_CLOSE.lock() {
            *global_close = Some(should_close.clone());
        }

        // Message loop with periodic close check
        let mut msg = MSG::default();
        loop {
            // Check if we should close
            if should_close.load(Ordering::SeqCst) {
                debug!("Overlay thread received close signal");
                let _ = DestroyWindow(hwnd);
                break;
            }

            // Non-blocking message peek
            if PeekMessageW(&mut msg, Some(hwnd), 0, 0, PM_REMOVE).as_bool() {
                if msg.message == WM_QUIT {
                    break;
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            } else {
                // Sleep briefly to avoid busy-waiting
                thread::sleep(Duration::from_millis(10));
            }
        }

        Ok(())
    }
}

fn destroy_overlay_window(handle: isize) {
    unsafe {
        let hwnd = HWND(handle as *mut _);
        // Validate handle before posting - prevents crash on RDP sessions
        if IsWindow(Some(hwnd)).as_bool() {
            let _ = PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
            debug!("Posted WM_CLOSE to action overlay window");
        } else {
            debug!(
                "Window handle {} is no longer valid, skipping WM_CLOSE",
                handle
            );
        }
    }
}

unsafe extern "system" fn overlay_window_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_CREATE => LRESULT(0),
        WM_PAINT => {
            let mut ps = PAINTSTRUCT::default();
            let hdc = BeginPaint(hwnd, &mut ps);

            // Get window rect
            let mut rect = RECT::default();
            let _ = GetClientRect(hwnd, &mut rect);

            // Fill background with white (will appear grey due to 30% alpha)
            let white_brush = CreateSolidBrush(COLORREF(0xFFFFFF));
            FillRect(hdc, &rect, white_brush);
            let _ = DeleteObject(white_brush.into());

            // Fetch current message from global state (using std::sync, not async)
            let (message, sub_message) = {
                if let Ok(state) = OVERLAY_STATE.read() {
                    (state.message.clone(), state.sub_message.clone())
                } else {
                    ("".to_string(), None)
                }
            };

            // Set up text rendering
            SetBkMode(hdc, TRANSPARENT);
            SetTextColor(hdc, COLORREF(0x000000)); // Black text

            // Create font for main message (bold)
            let font_height = -32; // 32 pixels high
            let font = CreateFontW(
                font_height,
                0,
                0,
                0,
                FW_BLACK.0 as i32,
                0,
                0,
                0,
                DEFAULT_CHARSET,
                OUT_DEFAULT_PRECIS,
                CLIP_DEFAULT_PRECIS,
                CLEARTYPE_QUALITY,
                DEFAULT_PITCH.0 as u32 | FF_DONTCARE.0 as u32,
                windows::core::w!("Segoe UI"),
            );
            let old_font = SelectObject(hdc, HGDIOBJ::from(font));

            // Calculate text area (centered box)
            let box_width = 800;
            let box_height = 400;
            let box_x = (rect.right - rect.left - box_width) / 2;
            let box_y = (rect.bottom - rect.top - box_height) / 2;

            // Draw black border around message box
            let black_pen = CreatePen(PS_SOLID, 2, COLORREF(0x000000));
            let old_pen = SelectObject(hdc, HGDIOBJ::from(black_pen));
            let null_brush = GetStockObject(NULL_BRUSH);
            let old_brush = SelectObject(hdc, null_brush);

            let _ = Rectangle(
                hdc,
                box_x - 10,
                box_y - 10,
                box_x + box_width + 10,
                box_y + box_height + 10,
            );

            SelectObject(hdc, old_pen);
            SelectObject(hdc, old_brush);
            let _ = DeleteObject(black_pen.into());

            // Draw main message
            let mut text_rect = RECT {
                left: box_x,
                top: box_y + 20,
                right: box_x + box_width,
                bottom: box_y + 80,
            };

            let mut message_wide = to_wide_string(&message);
            DrawTextW(
                hdc,
                &mut message_wide,
                &mut text_rect,
                DT_CENTER | DT_SINGLELINE | DT_VCENTER,
            );

            // Draw sub message if present (smaller font)
            if let Some(sub) = sub_message {
                let small_font = CreateFontW(
                    -20, // 20 pixels high
                    0,
                    0,
                    0,
                    FW_NORMAL.0 as i32,
                    0,
                    0,
                    0,
                    DEFAULT_CHARSET,
                    OUT_DEFAULT_PRECIS,
                    CLIP_DEFAULT_PRECIS,
                    CLEARTYPE_QUALITY,
                    DEFAULT_PITCH.0 as u32 | FF_DONTCARE.0 as u32,
                    windows::core::w!("Segoe UI"),
                );
                SelectObject(hdc, HGDIOBJ::from(small_font));

                let mut sub_rect = RECT {
                    left: box_x,
                    top: box_y + 100,
                    right: box_x + box_width,
                    bottom: box_y + box_height - 20,
                };

                let mut sub_wide = to_wide_string(&sub);
                DrawTextW(hdc, &mut sub_wide, &mut sub_rect, DT_CENTER | DT_WORDBREAK);

                let _ = DeleteObject(small_font.into());
            }

            // Cleanup
            SelectObject(hdc, old_font);
            let _ = DeleteObject(font.into());

            let _ = EndPaint(hwnd, &ps);
            LRESULT(0)
        }
        WM_CLOSE => {
            let _ = DestroyWindow(hwnd);
            LRESULT(0)
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_enable_disable() {
        // Should be enabled by default
        assert!(is_action_overlay_enabled());

        set_action_overlay_enabled(false);
        assert!(!is_action_overlay_enabled());

        set_action_overlay_enabled(true);
        assert!(is_action_overlay_enabled());
    }
}
