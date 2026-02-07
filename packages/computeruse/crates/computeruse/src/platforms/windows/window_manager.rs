//! Window management utilities for Windows platform
//!
//! This module provides window management functionality including:
//! - Window enumeration with Z-order tracking
//! - Bringing windows to top of Z-order (without stealing focus)
//! - Minimizing/maximizing windows
//! - State capture and restoration for workflows
//! - Always-on-top window detection and management
//! - UWP/Modern app detection

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::Mutex;
use tracing::{debug, info, warn};
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetTopWindow, GetWindow, GetWindowLongPtrW, GetWindowPlacement, GetWindowThreadProcessId,
    IsIconic, IsWindowVisible, IsZoomed, SendMessageTimeoutW, SetWindowPlacement, ShowWindow,
    GWL_EXSTYLE, GW_HWNDNEXT, SMTO_ABORTIFHUNG, SMTO_BLOCK, SW_MAXIMIZE, SW_MINIMIZE, SW_RESTORE,
    WINDOWPLACEMENT, WM_GETTEXT, WS_EX_TOPMOST,
};

/// Information about a window
#[derive(Clone, Debug)]
pub struct WindowInfo {
    /// Window handle
    pub hwnd: isize,
    /// Process name (e.g., "notepad.exe")
    pub process_name: String,
    /// Process ID
    pub process_id: u32,
    /// Z-order position (0 = topmost)
    pub z_order: u32,
    /// Whether the window is minimized
    pub is_minimized: bool,
    /// Whether the window is maximized
    pub is_maximized: bool,
    /// Whether the window has WS_EX_TOPMOST style
    pub is_always_on_top: bool,
    /// Window placement for restoration
    pub placement: WindowPlacement,
    /// Window title
    pub title: String,
}

/// Window placement information for state restoration
#[derive(Clone, Debug)]
pub struct WindowPlacement {
    pub flags: u32,
    pub show_cmd: u32,
    pub min_x: i32,
    pub min_y: i32,
    pub max_x: i32,
    pub max_y: i32,
    pub normal_left: i32,
    pub normal_top: i32,
    pub normal_right: i32,
    pub normal_bottom: i32,
}

impl From<WINDOWPLACEMENT> for WindowPlacement {
    fn from(wp: WINDOWPLACEMENT) -> Self {
        Self {
            flags: wp.flags.0,
            show_cmd: wp.showCmd,
            min_x: wp.ptMinPosition.x,
            min_y: wp.ptMinPosition.y,
            max_x: wp.ptMaxPosition.x,
            max_y: wp.ptMaxPosition.y,
            normal_left: wp.rcNormalPosition.left,
            normal_top: wp.rcNormalPosition.top,
            normal_right: wp.rcNormalPosition.right,
            normal_bottom: wp.rcNormalPosition.bottom,
        }
    }
}

impl From<WindowPlacement> for WINDOWPLACEMENT {
    fn from(val: WindowPlacement) -> Self {
        WINDOWPLACEMENT {
            length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
            flags: windows::Win32::UI::WindowsAndMessaging::WINDOWPLACEMENT_FLAGS(val.flags),
            showCmd: val.show_cmd,
            ptMinPosition: windows::Win32::Foundation::POINT {
                x: val.min_x,
                y: val.min_y,
            },
            ptMaxPosition: windows::Win32::Foundation::POINT {
                x: val.max_x,
                y: val.max_y,
            },
            rcNormalPosition: windows::Win32::Foundation::RECT {
                left: val.normal_left,
                top: val.normal_top,
                right: val.normal_right,
                bottom: val.normal_bottom,
            },
        }
    }
}

/// Cache for window information
pub struct WindowCache {
    /// Map: process_name -> windows sorted by Z-order (first = topmost)
    pub process_windows: HashMap<String, Vec<WindowInfo>>,
    /// All visible (non-minimized) windows
    pub visible_windows: Vec<WindowInfo>,
    /// Original state for restoration
    pub original_states: Vec<WindowInfo>,
    /// Windows that were actually minimized (only always-on-top ones)
    pub minimized_windows: Vec<isize>,
    /// Target window that was maximized (needs restoration too)
    pub target_window: Option<isize>,
    /// Timestamp of last cache update
    pub last_updated: Instant,
}

/// Window manager for controlling window states
///
/// Provides functionality for:
/// - Enumerating windows with Z-order tracking
/// - Bringing windows to front (bypassing Windows focus-stealing prevention)
/// - Minimizing/maximizing windows
/// - Capturing and restoring window states for workflows
pub struct WindowManager {
    window_cache: Arc<Mutex<WindowCache>>,
}

impl Default for WindowManager {
    fn default() -> Self {
        Self::new()
    }
}

impl WindowManager {
    /// Create a new WindowManager instance
    pub fn new() -> Self {
        Self {
            window_cache: Arc::new(Mutex::new(WindowCache {
                process_windows: HashMap::new(),
                visible_windows: Vec::new(),
                original_states: Vec::new(),
                minimized_windows: Vec::new(),
                target_window: None,
                last_updated: Instant::now(),
            })),
        }
    }

    /// Update window cache with current window information
    pub async fn update_window_cache(&self) -> Result<(), String> {
        let windows = Self::enumerate_windows_in_z_order()?;

        // Build process -> windows map (already sorted by Z-order)
        let mut process_windows: HashMap<String, Vec<WindowInfo>> = HashMap::new();
        for window in &windows {
            if !window.process_name.is_empty() {
                process_windows
                    .entry(window.process_name.clone())
                    .or_default()
                    .push(window.clone());
            }
        }

        // Filter visible windows (not minimized)
        let visible_windows: Vec<WindowInfo> = windows
            .iter()
            .filter(|w| !w.is_minimized)
            .cloned()
            .collect();

        let mut cache = self.window_cache.lock().await;
        cache.process_windows = process_windows;
        cache.visible_windows = visible_windows;
        cache.last_updated = Instant::now();

        Ok(())
    }

    /// Get topmost window for process (already sorted by Z-order)
    pub async fn get_topmost_window_for_process(&self, process: &str) -> Option<WindowInfo> {
        let cache = self.window_cache.lock().await;

        // Normalize process name (remove .exe if present)
        let normalized = process.to_lowercase().replace(".exe", "");

        for (proc_name, windows) in &cache.process_windows {
            let proc_normalized = proc_name.to_lowercase().replace(".exe", "");
            if proc_normalized == normalized {
                // First window is topmost (sorted by Z-order)
                return windows.first().cloned();
            }
        }
        None
    }

    /// Get all visible always-on-top windows
    pub async fn get_always_on_top_windows(&self) -> Vec<WindowInfo> {
        let cache = self.window_cache.lock().await;
        cache
            .visible_windows
            .iter()
            .filter(|w| w.is_always_on_top && !w.is_minimized)
            .cloned()
            .collect()
    }

    /// Minimize only always-on-top windows (excluding target and system components like explorer.exe)
    /// Returns the number of windows minimized
    pub async fn minimize_always_on_top_windows(&self, target_hwnd: isize) -> Result<u32, String> {
        let mut cache = self.window_cache.lock().await;
        let mut minimized_count = 0;
        let mut minimized_hwnds = Vec::new();

        for window in &cache.visible_windows {
            // Skip explorer.exe - minimizing taskbar/shell causes focus issues that close browser dropdowns
            if window.process_name.eq_ignore_ascii_case("explorer.exe") {
                continue;
            }
            if window.hwnd != target_hwnd && window.is_always_on_top && !window.is_minimized {
                unsafe {
                    let hwnd = HWND(window.hwnd as *mut _);
                    let _ = ShowWindow(hwnd, SW_MINIMIZE);
                    minimized_count += 1;
                    minimized_hwnds.push(window.hwnd);
                }
            }
        }

        // Track which windows we minimized for restoration
        cache.minimized_windows = minimized_hwnds;

        Ok(minimized_count)
    }

    /// Minimize all visible windows except the target
    pub async fn minimize_all_except(&self, target_hwnd: isize) -> Result<u32, String> {
        let cache = self.window_cache.lock().await;
        let mut minimized_count = 0;

        for window in &cache.visible_windows {
            if window.hwnd != target_hwnd && !window.is_minimized {
                unsafe {
                    let hwnd = HWND(window.hwnd as *mut _);
                    let _ = ShowWindow(hwnd, SW_MINIMIZE);
                    minimized_count += 1;
                }
            }
        }

        Ok(minimized_count)
    }

    /// Maximize window if not already maximized
    pub async fn maximize_if_needed(&self, hwnd: isize) -> Result<bool, String> {
        // Track this window as the target that needs restoration
        let mut cache = self.window_cache.lock().await;
        cache.target_window = Some(hwnd);
        drop(cache);

        unsafe {
            let hwnd_win = HWND(hwnd as *mut _);
            let was_maximized = IsZoomed(hwnd_win).as_bool();

            debug!(
                "maximize_if_needed: hwnd={:?}, was_maximized={}",
                hwnd, was_maximized
            );

            if !was_maximized {
                let _ = ShowWindow(hwnd_win, SW_MAXIMIZE);
                debug!("maximize_if_needed: Called ShowWindow(SW_MAXIMIZE)");
            }

            Ok(!was_maximized)
        }
    }

    /// Brings window to front and activates it using SetForegroundWindow.
    pub async fn bring_window_to_front(&self, hwnd: isize) -> Result<bool, String> {
        use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
        use windows::Win32::UI::WindowsAndMessaging::{BringWindowToTop, SetForegroundWindow};

        // Track this window as the target for restoration
        {
            let mut cache = self.window_cache.lock().await;
            cache.target_window = Some(hwnd);
        }

        unsafe {
            let hwnd_win = HWND(hwnd as *mut _);

            // If window is minimized, restore it first
            if IsIconic(hwnd_win).as_bool() {
                let _ = ShowWindow(hwnd_win, SW_RESTORE);
            }

            // Get thread IDs for focus manipulation
            let foreground_hwnd = windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow();
            let foreground_thread = GetWindowThreadProcessId(foreground_hwnd, None);
            let target_thread = GetWindowThreadProcessId(hwnd_win, None);
            let current_thread = GetCurrentThreadId();

            // Attach threads to allow focus change
            let attached_fg = if foreground_thread != current_thread {
                AttachThreadInput(current_thread, foreground_thread, true).as_bool()
            } else {
                false
            };

            let attached_target =
                if target_thread != current_thread && target_thread != foreground_thread {
                    AttachThreadInput(current_thread, target_thread, true).as_bool()
                } else {
                    false
                };

            // Bring window to top and activate
            let _ = BringWindowToTop(hwnd_win);
            let result = SetForegroundWindow(hwnd_win);

            // Detach threads
            if attached_fg {
                let _ = AttachThreadInput(current_thread, foreground_thread, false);
            }
            if attached_target {
                let _ = AttachThreadInput(current_thread, target_thread, false);
            }

            Ok(result.as_bool())
        }
    }

    /// Minimize window if not already minimized
    pub async fn minimize_if_needed(&self, hwnd: isize) -> Result<bool, String> {
        unsafe {
            let hwnd = HWND(hwnd as *mut _);
            if !IsIconic(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_MINIMIZE);
                Ok(true)
            } else {
                Ok(false)
            }
        }
    }

    /// Restore windows that were minimized (only always-on-top windows) and target window
    pub async fn restore_all_windows(&self) -> Result<u32, String> {
        let cache = self.window_cache.lock().await;
        let mut restored_count = 0;

        info!(
            "restore_all_windows: minimized_windows={}, target_window={:?}, original_states={}",
            cache.minimized_windows.len(),
            cache.target_window,
            cache.original_states.len()
        );

        // Log HWNDs in original_states to debug target window matching
        if let Some(target) = cache.target_window {
            let found = cache.original_states.iter().find(|w| w.hwnd == target);
            if found.is_some() {
                info!("Target window FOUND in original_states (HWND={})", target);
            } else {
                warn!(
                    "Target window NOT FOUND in original_states (HWND={})",
                    target
                );
                warn!(
                    "Original states HWNDs: {:?}",
                    cache
                        .original_states
                        .iter()
                        .take(10)
                        .map(|w| (w.hwnd, w.process_name.clone()))
                        .collect::<Vec<_>>()
                );
            }
        }

        // Determine which windows need restoration
        // Only restore windows we actually modified (minimized or target)
        let windows_to_restore: Vec<&WindowInfo> = cache
            .original_states
            .iter()
            .filter(|w| {
                // Restore if this window was minimized OR if it's the target window
                cache.minimized_windows.contains(&w.hwnd) || (cache.target_window == Some(w.hwnd))
            })
            .collect();

        // Restore in reverse order (bottommost first) to preserve Z-order
        // This ensures topmost windows end up on top after restoration
        info!("Restoring {} windows", windows_to_restore.len());
        for window in windows_to_restore.iter().rev() {
            unsafe {
                let hwnd = HWND(window.hwnd as *mut _);

                // Check if this is a UWP window (SetWindowPlacement doesn't work for UWP)
                let is_uwp = Self::is_uwp_app_internal(window.process_id);
                info!(
                    "Restoring window: PID={}, process={}, is_uwp={}, was_maximized={}",
                    window.process_id, window.process_name, is_uwp, window.is_maximized
                );

                if is_uwp {
                    // For UWP windows, use keyboard shortcuts to restore
                    // Check current state vs desired state
                    let currently_maximized = IsZoomed(hwnd).as_bool();
                    let should_be_maximized = window.is_maximized;

                    if currently_maximized && !should_be_maximized {
                        // Need to restore down from maximized
                        info!(
                            "Restoring UWP window (PID {}) from maximized state using keyboard (Win+Down)",
                            window.process_id
                        );
                        Self::restore_uwp_window_keyboard(hwnd);
                        restored_count += 1;
                    } else if !currently_maximized && should_be_maximized {
                        // Edge case: need to maximize (shouldn't happen in normal flow)
                        debug!(
                            "UWP window (PID {}) already in non-maximized state",
                            window.process_id
                        );
                    } else {
                        // States match, no restoration needed
                        debug!(
                            "UWP window (PID {}) already in correct state",
                            window.process_id
                        );
                    }
                } else {
                    // Win32 window: use SetWindowPlacement (works reliably)
                    let placement: WINDOWPLACEMENT = window.placement.clone().into();
                    if SetWindowPlacement(hwnd, &placement).is_ok() {
                        restored_count += 1;
                    }
                }
            }
        }

        Ok(restored_count)
    }

    /// Restore UWP window from maximized state using keyboard (Win+Down)
    fn restore_uwp_window_keyboard(hwnd: HWND) {
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_DOWN,
            VK_LWIN,
        };
        use windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow;

        unsafe {
            // Activate the window first
            let _ = SetForegroundWindow(hwnd);
            std::thread::sleep(std::time::Duration::from_millis(100));

            // Press Win + Down
            let mut inputs = vec![
                INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: VK_LWIN,
                            ..Default::default()
                        },
                    },
                },
                INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: VK_DOWN,
                            ..Default::default()
                        },
                    },
                },
            ];
            SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);

            std::thread::sleep(std::time::Duration::from_millis(50));

            // Release Down + Win
            inputs.clear();
            inputs.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_DOWN,
                        dwFlags: KEYEVENTF_KEYUP,
                        ..Default::default()
                    },
                },
            });
            inputs.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_LWIN,
                        dwFlags: KEYEVENTF_KEYUP,
                        ..Default::default()
                    },
                },
            });
            SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
        }
    }

    /// Capture current state before workflow
    pub async fn capture_initial_state(&self) -> Result<(), String> {
        let mut cache = self.window_cache.lock().await;
        let windows = Self::enumerate_windows_in_z_order()?;

        // Store all current window states
        cache.original_states = windows
            .iter()
            .filter(|w| !w.is_minimized)
            .cloned()
            .collect();

        // Also populate visible_windows and process_windows for direct MCP calls
        cache.visible_windows = windows
            .iter()
            .filter(|w| !w.is_minimized)
            .cloned()
            .collect();

        // Group windows by process
        cache.process_windows.clear();
        let visible_windows_clone = cache.visible_windows.clone();
        for window in &visible_windows_clone {
            cache
                .process_windows
                .entry(window.process_name.clone())
                .or_insert_with(Vec::new)
                .push(window.clone());
        }

        Ok(())
    }

    /// Clear captured state
    pub async fn clear_captured_state(&self) {
        let mut cache = self.window_cache.lock().await;
        cache.original_states.clear();
        cache.minimized_windows.clear();
        cache.target_window = None;
    }

    /// Enumerate all windows in Z-order (topmost first)
    fn enumerate_windows_in_z_order() -> Result<Vec<WindowInfo>, String> {
        let mut windows = Vec::new();
        let mut z_order = 0u32;

        unsafe {
            let mut hwnd = match GetTopWindow(None) {
                Ok(h) => h,
                Err(_) => return Ok(windows),
            };

            loop {
                if hwnd.0.is_null() {
                    break;
                }

                // Skip invisible windows
                if !IsWindowVisible(hwnd).as_bool() {
                    hwnd = match GetWindow(hwnd, GW_HWNDNEXT) {
                        Ok(h) => h,
                        Err(_) => break,
                    };
                    continue;
                }

                let mut pid = 0u32;
                GetWindowThreadProcessId(hwnd, Some(&mut pid));

                if pid > 0 {
                    let process_name = Self::get_process_name(pid).unwrap_or_default();
                    let title = Self::get_window_title(hwnd);
                    let is_minimized = IsIconic(hwnd).as_bool();
                    let is_maximized = IsZoomed(hwnd).as_bool();

                    // Check if window is always on top
                    let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
                    let is_always_on_top = (ex_style & WS_EX_TOPMOST.0 as isize) != 0;

                    let mut placement = WINDOWPLACEMENT {
                        length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
                        ..Default::default()
                    };
                    let _ = GetWindowPlacement(hwnd, &mut placement);

                    windows.push(WindowInfo {
                        hwnd: hwnd.0 as isize,
                        process_name: process_name.clone(),
                        process_id: pid,
                        z_order,
                        is_minimized,
                        is_maximized,
                        is_always_on_top,
                        placement: placement.into(),
                        title,
                    });
                }

                z_order += 1;
                hwnd = match GetWindow(hwnd, GW_HWNDNEXT) {
                    Ok(h) => h,
                    Err(_) => break,
                };
            }
        }

        Ok(windows)
    }

    /// Get process name from PID
    fn get_process_name(pid: u32) -> Option<String> {
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;

            let mut name = vec![0u16; 512];
            let mut size = name.len() as u32;

            if QueryFullProcessImageNameW(
                process,
                PROCESS_NAME_WIN32,
                windows::core::PWSTR(name.as_mut_ptr()),
                &mut size,
            )
            .is_ok()
            {
                let name_str = String::from_utf16_lossy(&name[..size as usize]);
                // Extract just the executable name from full path
                let exe_name = name_str.split('\\').next_back()?.to_string();
                Some(exe_name)
            } else {
                None
            }
        }
    }

    /// Get window title with timeout to avoid blocking on unresponsive windows
    fn get_window_title(hwnd: HWND) -> String {
        unsafe {
            let mut title = vec![0u16; 512];
            let mut char_count: usize = 0;

            // Use SendMessageTimeoutW with 100ms timeout and SMTO_ABORTIFHUNG flag
            let status = SendMessageTimeoutW(
                hwnd,
                WM_GETTEXT,
                WPARAM(title.len()),
                LPARAM(title.as_mut_ptr() as isize),
                SMTO_ABORTIFHUNG | SMTO_BLOCK,
                100, // 100ms timeout
                Some(&mut char_count),
            );

            // LRESULT.0 == 0 means failure (timeout or error)
            if status.0 == 0 {
                let error = windows::Win32::Foundation::GetLastError();
                if error.0 != 0 {
                    debug!(
                        "[get_window_title] Timeout or hung window detected for hwnd {:?}, error: {:?}",
                        hwnd.0, error
                    );
                }
                return String::new();
            }

            if char_count > 0 {
                String::from_utf16_lossy(&title[..char_count])
            } else {
                String::new()
            }
        }
    }

    // ========== UWP Detection ==========

    /// Check if a process is a UWP/Modern app (internal)
    fn is_uwp_app_internal(pid: u32) -> bool {
        let process_name = Self::get_process_name(pid).unwrap_or_default();
        let lower_name = process_name.to_lowercase();

        // Common UWP/Modern app patterns
        let is_uwp =
            // Core UWP infrastructure
            lower_name.contains("applicationframehost") ||
            lower_name.contains("wwahost") ||
            lower_name.contains("windowsinternal") ||
            lower_name.contains("textinputhost") ||

            // Microsoft Store apps
            lower_name.contains("calculatorapp") ||
            lower_name.contains("systemsettings") ||
            lower_name.contains("microsoft.windows.photos") ||
            lower_name.contains("microsoft.windowsstore") ||
            lower_name.contains("microsoft.windowscommunicationsapps") ||
            lower_name.contains("microsoft.windowscamera") ||
            lower_name.contains("microsoft.windowsmaps") ||
            lower_name.contains("microsoft.windowsalarms") ||
            lower_name.contains("microsoft.windowscalculator") ||
            lower_name.contains("microsoft.windowssoundrecorder") ||
            lower_name.contains("microsoft.microsoftedge") ||
            lower_name.contains("microsoft.office") ||
            lower_name.contains("microsoft.people") ||
            lower_name.contains("microsoft.bingnews") ||
            lower_name.contains("microsoft.bingweather") ||
            lower_name.contains("microsoft.bingsports") ||
            lower_name.contains("microsoft.bingfinance") ||
            lower_name.contains("microsoft.zunemusic") ||
            lower_name.contains("microsoft.zunevideo") ||
            lower_name.contains("microsoft.windowsfeedbackhub") ||
            lower_name.contains("microsoft.gethelp") ||
            lower_name.contains("microsoft.messaging") ||
            lower_name.contains("microsoft.oneconnect") ||
            lower_name.contains("microsoft.skypeapp") ||
            lower_name.contains("microsoft.xboxapp") ||
            lower_name.contains("microsoft.xboxidentityprovider") ||
            lower_name.contains("microsoft.xboxgamecallableui") ||
            lower_name.contains("microsoft.yourphone") ||
            lower_name.contains("microsoft.screensketch") ||
            lower_name.contains("microsoft.mixedreality") ||

            // Generic patterns
            lower_name.starts_with("microsoft.") ||
            lower_name.starts_with("windows.") ||
            lower_name.ends_with(".exe_") ||
            lower_name.contains("immersivecontrol");

        if is_uwp {
            info!("PID {} detected as UWP/Modern app ({})", pid, process_name);
        }

        is_uwp
    }

    /// Public method to check if a process is UWP
    pub async fn is_uwp_app(&self, pid: u32) -> bool {
        Self::is_uwp_app_internal(pid)
    }

    /// Track a window as the target for restoration
    pub async fn set_target_window(&self, hwnd: isize) {
        let mut cache = self.window_cache.lock().await;
        cache.target_window = Some(hwnd);
        info!("Set target window for restoration: hwnd={}", hwnd);
    }

    /// Get topmost window for a specific PID (Win32 only - UWP windows not visible)
    pub async fn get_topmost_window_for_pid(&self, pid: u32) -> Option<WindowInfo> {
        const WIN32_RETRIES: usize = 2;
        const RETRY_DELAY_MS: u64 = 200;

        // Check if this is a UWP app FIRST - they're not visible to Win32 enumeration
        if Self::is_uwp_app_internal(pid) {
            debug!("PID {} is UWP - skipping Win32 window enumeration", pid);
            return None;
        }

        // Retry logic for Win32 apps
        for attempt in 0..WIN32_RETRIES {
            if attempt > 0 {
                tokio::time::sleep(tokio::time::Duration::from_millis(RETRY_DELAY_MS)).await;
            }

            self.update_window_cache().await.ok()?;
            let cache = self.window_cache.lock().await;

            if let Some(window) = cache.visible_windows.iter().find(|w| w.process_id == pid) {
                debug!(
                    "Found Win32 window for PID {} on attempt {}",
                    pid,
                    attempt + 1
                );
                return Some(window.clone());
            }
        }

        warn!(
            "Win32 window for PID {} not found after {} attempts",
            pid, WIN32_RETRIES
        );
        None
    }
}
