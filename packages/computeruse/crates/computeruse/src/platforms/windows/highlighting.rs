//! Element highlighting functionality for Windows

use super::types::{FontStyle, HighlightHandle, TextPosition};
use crate::platforms::windows::utils::convert_uiautomation_element_to_computeruse;
use crate::AutomationError;
use crate::UIElement as ComputerUseElement;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tracing::{debug, error};

use uiautomation::UIElement;
// Windows GDI imports
use windows::Win32::Foundation::{COLORREF, RECT};
use windows::Win32::Graphics::Gdi::{
    CreateFontW, CreatePen, CreateSolidBrush, DeleteObject, DrawTextW, FillRect, GetDC, Rectangle,
    ReleaseDC, SelectObject, SetBkMode, SetTextColor, DT_SINGLELINE, HBRUSH, HGDIOBJ, PS_SOLID,
    TRANSPARENT,
};
// Additional imports for overlay window approach
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, GetClientRect, LoadCursorW, RegisterClassExW,
    SetLayeredWindowAttributes, ShowWindow, HICON, IDC_ARROW, LWA_COLORKEY, SW_SHOWNOACTIVATE,
    WM_DESTROY, WM_PAINT, WNDCLASSEXW, WS_EX_LAYERED, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
    WS_EX_TRANSPARENT, WS_POPUP,
};

const OVERLAY_CLASS_NAME: PCWSTR = w!("ComputerUseHighlightOverlay");

// Global atomic storage for recording mode flag
// When enabled, highlights will not trigger scroll_into_view (for passive recording)
/// Global recording mode flag using AtomicBool to work across threads.
/// This is critical because Tokio can switch threads between await points,
/// and thread_local! storage doesn't survive those switches.
static RECORDING_MODE: AtomicBool = AtomicBool::new(false);

/// Enable or disable recording mode for highlights globally.
/// When recording mode is enabled, highlights will NOT scroll elements into view.
/// This is useful for workflow recording where highlighting should be passive (no UI changes).
///
/// # Arguments
/// * `enabled` - true to enable recording mode (disable scroll), false to use normal mode (enable scroll)
///
/// # Example
/// ```
/// use computeruse::platforms::windows::set_recording_mode;
///
/// // Enable recording mode (no scrolling during highlights)
/// set_recording_mode(true);
///
/// // ... perform highlighting during recording ...
///
/// // Restore normal mode (scrolling enabled)
/// set_recording_mode(false);
/// ```
pub fn set_recording_mode(enabled: bool) {
    RECORDING_MODE.store(enabled, Ordering::Relaxed);
}

/// Implementation of element highlighting for Windows UI elements
pub fn highlight(
    element: Arc<UIElement>,
    color: Option<u32>,
    duration: Option<Duration>,
    text: Option<&str>,
    text_position: Option<TextPosition>,
    font_style: Option<FontStyle>,
) -> Result<HighlightHandle, AutomationError> {
    // Best-effort: ensure element is in view before computing bounds
    // Wrap UIA element into our cross-platform UIElement and use the helper
    let wrapped: ComputerUseElement =
        convert_uiautomation_element_to_computeruse(element.as_ref().clone());

    // Check if we're in recording mode - if so, skip scroll to avoid spurious events
    let skip_scroll = RECORDING_MODE.load(Ordering::Relaxed);

    if !skip_scroll {
        // Simply use the core library's scroll_into_view method
        // This method already handles viewport detection, focus attempts, and iterative scrolling
        // We don't need all the sophisticated logic here - that's now in the MCP server
        if let Err(e) = wrapped.scroll_into_view() {
            // Log but don't fail - scrolling is best-effort for highlighting
            debug!("highlight: scroll_into_view failed (best-effort): {}", e);
        } else {
            debug!("highlight: scroll_into_view succeeded");
        }

        // Get the (possibly updated) element bounding rectangle
        // First check what the wrapped element thinks its bounds are
        if let Ok((_wx, _wy, _ww, _wh)) = wrapped.bounds() {
            // info!("highlight: wrapped element final bounds: x={wx}, y={wy}, w={ww}, h={wh}");
        }

        // Small delay to let any scrolling animation settle
        std::thread::sleep(Duration::from_millis(100));
    } else {
        debug!("highlight: skipping scroll_into_view (recording mode enabled)");
    }

    let rect = element.get_bounding_rectangle().map_err(|e| {
        AutomationError::PlatformError(format!("Failed to get element bounds: {e}"))
    })?;

    // Log the rectangle bounds - these are what we'll use for the highlight
    // info!(
    //     "highlight: UIAutomation element final bounds for overlay: left={}, top={}, width={}, height={}",
    //     rect.get_left(),
    //     rect.get_top(),
    //     rect.get_width(),
    //     rect.get_height()
    // );

    // UI Automation coordinates are already in physical pixels (DPI-aware)
    // No scaling needed - use coordinates directly
    let x = rect.get_left();
    let y = rect.get_top();
    let width = rect.get_width();
    let height = rect.get_height();

    // Constants for border appearance
    const DEFAULT_RED_COLOR: u32 = 0x0000FF; // Pure red in BGR format

    // Use provided color or default to red
    let highlight_color = color.unwrap_or(DEFAULT_RED_COLOR);

    // Validate coordinates
    if width <= 0 || height <= 0 {
        return Err(AutomationError::PlatformError(format!(
            "Invalid element dimensions: width={width}, height={height}"
        )));
    }

    debug!(
        "Highlight coordinates (physical pixels): x={}, y={}, width={}, height={}",
        x, y, width, height
    );

    // Prepare text overlay data (no truncation for better readability)
    let text_data = text.map(|t| {
        let display_text = if t.len() > 30 {
            format!("{}...", &t[..27]) // Allow longer text (30 chars max)
        } else {
            t.to_string()
        };
        let font_style = font_style.unwrap_or_default();
        let position = text_position.unwrap_or(TextPosition::Top);
        (display_text, font_style, position)
    });

    // Create atomic bool for controlling the highlight thread
    let should_close = Arc::new(AtomicBool::new(false));
    let should_close_clone = should_close.clone();

    // Spawn a thread to handle the highlighting
    let handle = thread::spawn(move || {
        let start_time = Instant::now();
        let duration = duration.unwrap_or(Duration::from_millis(3000)); // Default 3 seconds

        // info!("OVERLAY_THREAD_START duration_ms={}", duration.as_millis());

        // Compute overlay extents and draw overlay window content
        let mut overlay_x = x;
        let mut overlay_y = y;
        let mut overlay_w = width;
        let mut overlay_h = height;
        let mut border_offset_x = 0;
        let mut border_offset_y = 0;
        let mut text_rect: Option<(i32, i32, i32, i32)> = None; // (x, y, w, h) relative to overlay

        if let Some((_, ref fs, pos)) = text_data {
            // Approximate text box size and position
            let (tw, th) = if fs.size > 0 {
                (width.clamp(200, 600), (fs.size as i32 + 22).max(40))
            } else {
                (width.max(200), 50)
            };
            let (tx_abs, ty_abs) = match pos {
                TextPosition::Top => (x, y - th - 10),
                TextPosition::TopRight => (x + width + 15, y - th - 10),
                TextPosition::Right => (x + width + 15, y + height / 2 - th / 2),
                TextPosition::BottomRight => (x + width + 15, y + height + 15),
                TextPosition::Bottom => (x, y + height + 15),
                TextPosition::BottomLeft => (x - tw - 15, y + height + 15),
                TextPosition::Left => (x - tw - 15, y + height / 2 - th / 2),
                TextPosition::TopLeft => (x - tw - 15, y - th - 10),
                TextPosition::Inside => (x + 15, y + 15),
            };
            let right = (x + width).max(tx_abs + tw);
            let bottom = (y + height).max(ty_abs + th);
            overlay_x = overlay_x.min(tx_abs);
            overlay_y = overlay_y.min(ty_abs);
            overlay_w = right - overlay_x;
            overlay_h = bottom - overlay_y;
            border_offset_x = x - overlay_x;
            border_offset_y = y - overlay_y;
            text_rect = Some((tx_abs - overlay_x, ty_abs - overlay_y, tw, th));
            debug!(
                "Overlay with text: overlay_x={}, overlay_y={}, overlay_w={}, overlay_h={}, border_offset=({}, {}), text_rect={:?}",
                overlay_x, overlay_y, overlay_w, overlay_h, border_offset_x, border_offset_y, text_rect
            );
        } else {
            debug!(
                "Overlay without text: overlay_x={}, overlay_y={}, overlay_w={}, overlay_h={}",
                overlay_x, overlay_y, overlay_w, overlay_h
            );
        }

        if let Err(e) = create_and_show_overlay(
            overlay_x,
            overlay_y,
            overlay_w,
            overlay_h,
            border_offset_x,
            border_offset_y,
            width,
            height,
            highlight_color,
            text_data
                .as_ref()
                .map(|(t, fs, _)| (t.as_str(), fs.clone())),
            text_rect,
        ) {
            error!("Failed to create overlay highlight: {}", e);
        }

        debug!("Waiting for highlight duration: {:?}", duration);
        while start_time.elapsed() < duration && !should_close_clone.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(50));
        }

        // Clean up the overlay window when highlight expires or is manually closed
        cleanup_overlay_window();

        // info!(
        //     "OVERLAY_THREAD_DONE elapsed_ms={}",
        //     start_time.elapsed().as_millis()
        // );
    });

    Ok(HighlightHandle {
        should_close,
        handle: Some(handle),
    })
}

/// Highlight a rectangular area by bounds directly (no element required).
/// Useful for index-based or coordinate-based clicks where we have bounds but no element.
///
/// # Arguments
/// * `x` - Left edge of the highlight area
/// * `y` - Top edge of the highlight area  
/// * `width` - Width of the highlight area
/// * `height` - Height of the highlight area
/// * `color` - Optional BGR color (default: green 0x00FF00)
/// * `duration` - Optional duration (default: 500ms)
/// * `text` - Optional text label to display
/// * `text_position` - Position for text label
/// * `font_style` - Font styling for text
#[allow(clippy::too_many_arguments)]
pub fn highlight_bounds(
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    color: Option<u32>,
    duration: Option<Duration>,
    text: Option<&str>,
    text_position: Option<TextPosition>,
    font_style: Option<FontStyle>,
) -> Result<HighlightHandle, AutomationError> {
    // Validate coordinates
    if width <= 0 || height <= 0 {
        return Err(AutomationError::PlatformError(format!(
            "Invalid dimensions for highlight_bounds: width={width}, height={height}"
        )));
    }

    debug!(
        "highlight_bounds: x={}, y={}, width={}, height={}",
        x, y, width, height
    );

    const DEFAULT_GREEN_COLOR: u32 = 0x00FF00; // Green in BGR format
    let highlight_color = color.unwrap_or(DEFAULT_GREEN_COLOR);

    // Prepare text overlay data
    let text_data = text.map(|t| {
        let display_text = if t.len() > 30 {
            format!("{}...", &t[..27])
        } else {
            t.to_string()
        };
        let fs = font_style.clone().unwrap_or_default();
        let position = text_position.unwrap_or(TextPosition::Top);
        (display_text, fs, position)
    });

    // Create atomic bool for controlling the highlight thread
    let should_close = Arc::new(AtomicBool::new(false));
    let should_close_clone = should_close.clone();

    // Spawn a thread to handle the highlighting
    let handle = thread::spawn(move || {
        let start_time = Instant::now();
        let duration = duration.unwrap_or(Duration::from_millis(500)); // Default 500ms for action highlight

        let mut overlay_x = x;
        let mut overlay_y = y;
        let mut overlay_w = width;
        let mut overlay_h = height;
        let mut border_offset_x = 0;
        let mut border_offset_y = 0;
        let mut text_rect: Option<(i32, i32, i32, i32)> = None;

        if let Some((_, ref fs, pos)) = text_data {
            let (tw, th) = if fs.size > 0 {
                (width.clamp(200, 600), (fs.size as i32 + 22).max(40))
            } else {
                (width.max(200), 50)
            };
            let (tx_abs, ty_abs) = match pos {
                TextPosition::Top => (x, y - th - 10),
                TextPosition::TopRight => (x + width + 15, y - th - 10),
                TextPosition::Right => (x + width + 15, y + height / 2 - th / 2),
                TextPosition::BottomRight => (x + width + 15, y + height + 15),
                TextPosition::Bottom => (x, y + height + 15),
                TextPosition::BottomLeft => (x - tw - 15, y + height + 15),
                TextPosition::Left => (x - tw - 15, y + height / 2 - th / 2),
                TextPosition::TopLeft => (x - tw - 15, y - th - 10),
                TextPosition::Inside => (x + 15, y + 15),
            };
            let right = (x + width).max(tx_abs + tw);
            let bottom = (y + height).max(ty_abs + th);
            overlay_x = overlay_x.min(tx_abs);
            overlay_y = overlay_y.min(ty_abs);
            overlay_w = right - overlay_x;
            overlay_h = bottom - overlay_y;
            border_offset_x = x - overlay_x;
            border_offset_y = y - overlay_y;
            text_rect = Some((tx_abs - overlay_x, ty_abs - overlay_y, tw, th));
        }

        if let Err(e) = create_and_show_overlay(
            overlay_x,
            overlay_y,
            overlay_w,
            overlay_h,
            border_offset_x,
            border_offset_y,
            width,
            height,
            highlight_color,
            text_data
                .as_ref()
                .map(|(t, fs, _)| (t.as_str(), fs.clone())),
            text_rect,
        ) {
            error!("Failed to create overlay highlight for bounds: {}", e);
        }

        while start_time.elapsed() < duration && !should_close_clone.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(50));
        }

        cleanup_overlay_window();
    });

    Ok(HighlightHandle {
        should_close,
        handle: Some(handle),
    })
}

// Thread-local storage for the last created overlay window to destroy later
thread_local! {
    static LAST_CREATED_OVERLAY: std::cell::RefCell<Option<HWND>> = const { std::cell::RefCell::new(None) };
}

/// Creates and shows a transparent overlay window and draws the highlight and optional text
#[allow(clippy::too_many_arguments)]
fn create_and_show_overlay(
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    border_offset_x: i32,
    border_offset_y: i32,
    element_w: i32,
    element_h: i32,
    border_color_bgr: u32,
    text: Option<(&str, FontStyle)>,
    text_rect: Option<(i32, i32, i32, i32)>,
) -> Result<(), AutomationError> {
    unsafe {
        let instance = GetModuleHandleW(None)
            .map_err(|e| AutomationError::PlatformError(format!("GetModuleHandleW failed: {e}")))?;

        // Clean up any previous overlay window before creating a new one
        cleanup_previous_overlay();

        // Register window class (ignore already registered)
        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: windows::Win32::UI::WindowsAndMessaging::WNDCLASS_STYLES(0),
            lpfnWndProc: Some(overlay_window_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: instance.into(),
            hIcon: HICON::default(),
            hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
            hbrBackground: HBRUSH::default(),
            lpszMenuName: PCWSTR::null(),
            lpszClassName: OVERLAY_CLASS_NAME,
            hIconSm: HICON::default(),
        };
        let atom = RegisterClassExW(&wc);
        if atom == 0 {
            debug!("RegisterClassExW returned 0 (class may already exist)");
        }

        // Create overlay window
        let hwnd = CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
            OVERLAY_CLASS_NAME,
            w!("Highlight Overlay"),
            WS_POPUP,
            x,
            y,
            width,
            height,
            None,
            None,
            Some(instance.into()),
            None,
        )
        .map_err(|e| AutomationError::PlatformError(format!("CreateWindowExW failed: {e}")))?;

        if hwnd.is_invalid() {
            return Err(AutomationError::PlatformError(
                "CreateWindowExW returned invalid HWND".to_string(),
            ));
        }

        // Make black transparent and allow drawing colored border
        SetLayeredWindowAttributes(hwnd, COLORREF(0x000000), 255, LWA_COLORKEY).map_err(|e| {
            AutomationError::PlatformError(format!("SetLayeredWindowAttributes failed: {e}"))
        })?;

        // Show without activating
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);

        // Draw contents once
        draw_highlight_on_window(
            hwnd,
            border_offset_x,
            border_offset_y,
            element_w,
            element_h,
            border_color_bgr,
            text,
            text_rect,
        );

        // Save HWND for later destruction
        LAST_CREATED_OVERLAY.with(|cell| {
            *cell.borrow_mut() = Some(hwnd);
        });
    }
    Ok(())
}

/// Draw the highlight border and optional text on the overlay window
#[allow(clippy::too_many_arguments)]
fn draw_highlight_on_window(
    hwnd: HWND,
    border_offset_x: i32,
    border_offset_y: i32,
    element_w: i32,
    element_h: i32,
    border_color_bgr: u32,
    text: Option<(&str, FontStyle)>,
    text_rect: Option<(i32, i32, i32, i32)>,
) {
    unsafe {
        let hdc = GetDC(Some(hwnd));
        if hdc.is_invalid() {
            return;
        }

        // Fill entire window with transparent color (black)
        let black_brush = CreateSolidBrush(COLORREF(0x000000));
        let mut window_rect = RECT::default();
        let _ = GetClientRect(hwnd, &mut window_rect);
        let _ = FillRect(hdc, &window_rect, black_brush);
        let _ = DeleteObject(black_brush.into());

        // Draw the highlight border inside the overlay
        let hpen = CreatePen(PS_SOLID, 6, COLORREF(border_color_bgr));
        let old_pen = SelectObject(hdc, HGDIOBJ(hpen.0));
        // Use black brush for interior so it remains transparent due to color key
        let black_brush = CreateSolidBrush(COLORREF(0x000000));
        let old_brush = SelectObject(hdc, HGDIOBJ(black_brush.0));

        // Rectangle around the element region inside overlay (2px inset for aesthetics)
        let left = border_offset_x + 2;
        let top = border_offset_y + 2;
        let right = border_offset_x + element_w - 2;
        let bottom = border_offset_y + element_h - 2;
        let _ = Rectangle(hdc, left, top, right, bottom);

        // Optional text inside the overlay
        if let (Some((txt, fs)), Some((tx, ty, tw, th))) = (text, text_rect) {
            let font_size = if fs.size > 0 { fs.size as i32 } else { 18 };
            let font = CreateFontW(
                font_size,
                0,
                0,
                0,
                700,
                0,
                0,
                0,
                windows::Win32::Graphics::Gdi::FONT_CHARSET(1),
                windows::Win32::Graphics::Gdi::FONT_OUTPUT_PRECISION(0),
                windows::Win32::Graphics::Gdi::FONT_CLIP_PRECISION(0),
                windows::Win32::Graphics::Gdi::FONT_QUALITY(0),
                0,
                PCWSTR::null(),
            );
            let old_font = SelectObject(hdc, HGDIOBJ(font.0));

            let text_color = if fs.color == 0 { 0x00FF00 } else { fs.color };
            SetTextColor(hdc, COLORREF(text_color));
            SetBkMode(hdc, TRANSPARENT);

            let mut wide_text: Vec<u16> = txt.encode_utf16().collect();
            wide_text.push(0);

            let mut rect = RECT {
                left: tx + 5,
                top: ty + 5,
                right: tx + tw - 5,
                bottom: ty + th - 5,
            };
            let _ = DrawTextW(hdc, &mut wide_text, &mut rect, DT_SINGLELINE);

            // Restore font
            SelectObject(hdc, old_font);
            let _ = DeleteObject(HGDIOBJ(font.0));
        }

        // Cleanup
        SelectObject(hdc, old_brush);
        SelectObject(hdc, old_pen);
        let _ = DeleteObject(black_brush.into());
        let _ = DeleteObject(hpen.into());
        let _ = ReleaseDC(Some(hwnd), hdc);
    }
}

/// Minimal window procedure; repaints draw content again if needed
unsafe extern "system" fn overlay_window_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    use windows::Win32::UI::WindowsAndMessaging::{DestroyWindow, WM_CLOSE};

    match msg {
        WM_CLOSE => {
            // Handle WM_CLOSE by destroying the window
            let _ = DestroyWindow(hwnd);
            LRESULT(0)
        }
        WM_DESTROY => LRESULT(0),
        WM_PAINT => {
            // On paint, redraw a basic border without text as a best-effort fallback
            let mut rect = RECT::default();
            let _ = GetClientRect(hwnd, &mut rect);
            draw_highlight_on_window(hwnd, 0, 0, rect.right, rect.bottom, 0x0000FF, None, None);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

/// Cleans up the previous overlay window stored in thread-local storage
fn cleanup_previous_overlay() {
    LAST_CREATED_OVERLAY.with(|cell| {
        if let Some(hwnd) = cell.borrow_mut().take() {
            unsafe {
                use windows::Win32::UI::WindowsAndMessaging::DestroyWindow;
                let _ = DestroyWindow(hwnd);
                debug!("Destroyed previous overlay window");
            }
        }
    });
}

/// Cleans up the current overlay window and clears thread-local storage
fn cleanup_overlay_window() {
    cleanup_previous_overlay();
}

/// Stops all active highlight overlay windows globally.
/// Uses Windows API to find and close all windows with the ComputerUseHighlightOverlay class.
/// Returns the number of highlights that were stopped.
pub fn stop_all_highlights() -> usize {
    use windows::Win32::UI::WindowsAndMessaging::{FindWindowExW, SendMessageW, WM_CLOSE};

    let mut stopped = 0usize;

    unsafe {
        // First, collect all overlay window handles
        let mut windows_to_close: Vec<HWND> = Vec::new();
        let mut prev_hwnd = HWND::default();

        // Use FindWindowExW to enumerate all windows of this class
        loop {
            let result = FindWindowExW(None, Some(prev_hwnd), OVERLAY_CLASS_NAME, None);
            let hwnd = match result {
                Ok(h) => h,
                Err(e) => {
                    debug!(
                        "FindWindowExW returned error (expected when no more windows): {:?}",
                        e
                    );
                    break;
                }
            };
            if hwnd.is_invalid() || hwnd.0.is_null() {
                debug!("FindWindowExW returned invalid HWND, stopping enumeration");
                break;
            }
            debug!(
                "FindWindowExW found overlay window {:?}, prev was {:?}",
                hwnd.0, prev_hwnd.0
            );
            windows_to_close.push(hwnd);
            prev_hwnd = hwnd;

            // Safety limit
            if windows_to_close.len() > 100 {
                debug!("Hit safety limit of 100 windows");
                break;
            }
        }

        debug!(
            "stop_all_highlights: found {} overlay windows",
            windows_to_close.len()
        );

        // Now close all of them using SendMessageW which invokes window proc directly
        // (PostMessageW won't work because these windows don't have a message loop)
        for hwnd in windows_to_close {
            SendMessageW(hwnd, WM_CLOSE, Some(WPARAM(0)), Some(LPARAM(0)));
            stopped += 1;
            debug!("Sent WM_CLOSE to highlight overlay window {:?}", hwnd.0);
        }
    }

    if stopped > 0 {
        debug!("stop_all_highlights: stopped {} overlay windows", stopped);
    }

    stopped
}
