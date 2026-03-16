//! Window manager bindings for Node.js

use napi_derive::napi;
#[cfg(target_os = "windows")]
use std::sync::Arc;

#[cfg(target_os = "windows")]
use computeruse::WindowManager as RustWindowManager;

/// Information about a window
#[napi(object)]
pub struct WindowInfo {
    /// Window handle
    pub hwnd: i64,
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
    /// Window title
    pub title: String,
}

#[cfg(target_os = "windows")]
impl From<computeruse::WindowInfo> for WindowInfo {
    fn from(info: computeruse::WindowInfo) -> Self {
        Self {
            hwnd: info.hwnd as i64,
            process_name: info.process_name,
            process_id: info.process_id,
            z_order: info.z_order,
            is_minimized: info.is_minimized,
            is_maximized: info.is_maximized,
            is_always_on_top: info.is_always_on_top,
            title: info.title,
        }
    }
}

/// Window manager for controlling window states
///
/// Provides functionality for:
/// - Enumerating windows with Z-order tracking
/// - Bringing windows to front (bypassing Windows focus-stealing prevention)
/// - Minimizing/maximizing windows
/// - Capturing and restoring window states for workflows
#[napi]
pub struct WindowManager {
    #[cfg(target_os = "windows")]
    inner: Arc<RustWindowManager>,
}

#[napi]
impl Default for WindowManager {
    fn default() -> Self {
        Self::new()
    }
}

#[napi]
impl WindowManager {
    /// Create a new WindowManager instance
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            #[cfg(target_os = "windows")]
            inner: Arc::new(RustWindowManager::new()),
        }
    }

    /// Update window cache with current window information
    #[napi]
    pub async fn update_window_cache(&self) -> napi::Result<()> {
        #[cfg(target_os = "windows")]
        {
            self.inner.update_window_cache().await.map_err(|e| {
                napi::Error::from_reason(format!("Failed to update window cache: {}", e))
            })
        }
        #[cfg(not(target_os = "windows"))]
        {
            Err(napi::Error::from_reason(
                "WindowManager is only supported on Windows",
            ))
        }
    }

    /// Get topmost window for a process by name
    #[napi]
    pub async fn get_topmost_window_for_process(
        &self,
        #[allow(unused_variables)] process: String,
    ) -> napi::Result<Option<WindowInfo>> {
        #[cfg(target_os = "windows")]
        {
            Ok(self
                .inner
                .get_topmost_window_for_process(&process)
                .await
                .map(WindowInfo::from))
        }
        #[cfg(not(target_os = "windows"))]
        {
            Err(napi::Error::from_reason(
                "WindowManager is only supported on Windows",
            ))
        }
    }

    /// Get topmost window for a specific PID
    #[napi]
    pub async fn get_topmost_window_for_pid(&self, #[allow(unused_variables)] pid: u32) -> napi::Result<Option<WindowInfo>> {
        #[cfg(target_os = "windows")]
        {
            Ok(self
                .inner
                .get_topmost_window_for_pid(pid)
                .await
                .map(WindowInfo::from))
        }
        #[cfg(not(target_os = "windows"))]
        {
            Err(napi::Error::from_reason(
                "WindowManager is only supported on Windows",
            ))
        }
    }

    /// Get all visible always-on-top windows
    #[napi]
    pub async fn get_always_on_top_windows(&self) -> napi::Result<Vec<WindowInfo>> {
        #[cfg(target_os = "windows")]
        {
            Ok(self
                .inner
                .get_always_on_top_windows()
                .await
                .into_iter()
                .map(WindowInfo::from)
                .collect())
        }
        #[cfg(not(target_os = "windows"))]
        {
            Err(napi::Error::from_reason(
                "WindowManager is only supported on Windows",
            ))
        }
    }

    /// Minimize only always-on-top windows (excluding target)
    /// Returns the number of windows minimized
    #[napi]
    pub async fn minimize_always_on_top_windows(&self, #[allow(unused_variables)] target_hwnd: i64) -> napi::Result<u32> {
        #[cfg(target_os = "windows")]
        {
            self.inner
                .minimize_always_on_top_windows(target_hwnd as isize)
                .await
                .map_err(|e| {
                    napi::Error::from_reason(format!(
                        "Failed to minimize always-on-top windows: {}",
                        e
                    ))
                })
        }
        #[cfg(not(target_os = "windows"))]
        {
            Err(napi::Error::from_reason(
                "WindowManager is only supported on Windows",
            ))
        }
    }

    /// Minimize all visible windows except the target
    #[napi]
    pub async fn minimize_all_except(&self, #[allow(unused_variables)] target_hwnd: i64) -> napi::Result<u32> {
        #[cfg(target_os = "windows")]
        {
            self.inner
                .minimize_all_except(target_hwnd as isize)
                .await
                .map_err(|e| napi::Error::from_reason(format!("Failed to minimize windows: {}", e)))
        }
        #[cfg(not(target_os = "windows"))]
        {
            Err(napi::Error::from_reason(
                "WindowManager is only supported on Windows",
            ))
        }
    }

    /// Maximize window if not already maximized
    /// Returns true if the window was maximized (wasn't already maximized)
    #[napi]
    pub async fn maximize_if_needed(&self, #[allow(unused_variables)] hwnd: i64) -> napi::Result<bool> {
        #[cfg(target_os = "windows")]
        {
            self.inner
                .maximize_if_needed(hwnd as isize)
                .await
                .map_err(|e| napi::Error::from_reason(format!("Failed to maximize window: {}", e)))
        }
        #[cfg(not(target_os = "windows"))]
        {
            Err(napi::Error::from_reason(
                "WindowManager is only supported on Windows",
            ))
        }
    }

    /// Bring window to front using AttachThreadInput trick
    ///
    /// This uses AttachThreadInput to bypass Windows' focus-stealing prevention.
    /// Returns true if the window is now in the foreground.
    #[napi]
    pub async fn bring_window_to_front(&self, #[allow(unused_variables)] hwnd: i64) -> napi::Result<bool> {
        #[cfg(target_os = "windows")]
        {
            self.inner
                .bring_window_to_front(hwnd as isize)
                .await
                .map_err(|e| {
                    napi::Error::from_reason(format!("Failed to bring window to front: {}", e))
                })
        }
        #[cfg(not(target_os = "windows"))]
        {
            Err(napi::Error::from_reason(
                "WindowManager is only supported on Windows",
            ))
        }
    }

    /// Minimize window if not already minimized
    /// Returns true if the window was minimized (wasn't already minimized)
    #[napi]
    pub async fn minimize_if_needed(&self, #[allow(unused_variables)] hwnd: i64) -> napi::Result<bool> {
        #[cfg(target_os = "windows")]
        {
            self.inner
                .minimize_if_needed(hwnd as isize)
                .await
                .map_err(|e| napi::Error::from_reason(format!("Failed to minimize window: {}", e)))
        }
        #[cfg(not(target_os = "windows"))]
        {
            Err(napi::Error::from_reason(
                "WindowManager is only supported on Windows",
            ))
        }
    }

    /// Capture current state before workflow
    #[napi]
    pub async fn capture_initial_state(&self) -> napi::Result<()> {
        #[cfg(target_os = "windows")]
        {
            self.inner.capture_initial_state().await.map_err(|e| {
                napi::Error::from_reason(format!("Failed to capture initial state: {}", e))
            })
        }
        #[cfg(not(target_os = "windows"))]
        {
            Err(napi::Error::from_reason(
                "WindowManager is only supported on Windows",
            ))
        }
    }

    /// Restore windows that were minimized and target window to their original state
    /// Returns the number of windows restored
    #[napi]
    pub async fn restore_all_windows(&self) -> napi::Result<u32> {
        #[cfg(target_os = "windows")]
        {
            self.inner
                .restore_all_windows()
                .await
                .map_err(|e| napi::Error::from_reason(format!("Failed to restore windows: {}", e)))
        }
        #[cfg(not(target_os = "windows"))]
        {
            Err(napi::Error::from_reason(
                "WindowManager is only supported on Windows",
            ))
        }
    }

    /// Clear captured state
    #[napi]
    pub async fn clear_captured_state(&self) -> napi::Result<()> {
        #[cfg(target_os = "windows")]
        {
            self.inner.clear_captured_state().await;
            Ok(())
        }
        #[cfg(not(target_os = "windows"))]
        {
            Err(napi::Error::from_reason(
                "WindowManager is only supported on Windows",
            ))
        }
    }

    /// Check if a process is a UWP/Modern app
    #[napi]
    pub async fn is_uwp_app(&self, #[allow(unused_variables)] pid: u32) -> napi::Result<bool> {
        #[cfg(target_os = "windows")]
        {
            Ok(self.inner.is_uwp_app(pid).await)
        }
        #[cfg(not(target_os = "windows"))]
        {
            Err(napi::Error::from_reason(
                "WindowManager is only supported on Windows",
            ))
        }
    }

    /// Track a window as the target for restoration
    #[napi]
    pub async fn set_target_window(&self, #[allow(unused_variables)] hwnd: i64) -> napi::Result<()> {
        #[cfg(target_os = "windows")]
        {
            self.inner.set_target_window(hwnd as isize).await;
            Ok(())
        }
        #[cfg(not(target_os = "windows"))]
        {
            Err(napi::Error::from_reason(
                "WindowManager is only supported on Windows",
            ))
        }
    }
}
