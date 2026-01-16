//! Application management and process-related functions for Windows

use super::engine::WindowsEngine;
use super::types::{HandleGuard, ThreadSafeWinUIElement};

use crate::{AutomationError, UIElement};
use serde_json::Value;
use std::collections::HashMap;
use std::os::windows::process::CommandExt;

/// Windows constant to prevent console window creation during process spawn
const CREATE_NO_WINDOW: u32 = 0x08000000;
use std::sync::atomic::{AtomicIsize, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tracing::{debug, info, warn};
use uiautomation::controls::ControlType;
use uiautomation::filters::{ControlTypeFilter, OrFilter};
use uiautomation::types::{TreeScope, UIProperty};
use uiautomation::variants::Variant;

// Windows API imports
use windows::core::{HRESULT, HSTRING, PCWSTR};
use windows::Win32::Foundation::LPARAM;
use windows::Win32::Foundation::{CloseHandle, HANDLE, HINSTANCE, HWND};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    CreateProcessW, GetProcessId, CREATE_NEW_CONSOLE, PROCESS_INFORMATION, STARTUPINFOW,
};
use windows::Win32::UI::Shell::{
    ApplicationActivationManager, IApplicationActivationManager, ShellExecuteExW, ShellExecuteW,
    ACTIVATEOPTIONS, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowThreadProcessId, IsWindowVisible, SW_SHOWNORMAL,
};

use super::utils::WindowsUIElement;

// Constants
const DEFAULT_FIND_TIMEOUT: Duration = Duration::from_millis(5000);

// Storage for EnumWindows callback - using atomics for thread safety and to avoid UB
static ENUM_TARGET_PID: AtomicU32 = AtomicU32::new(0);
static ENUM_FOUND_HWND: AtomicIsize = AtomicIsize::new(0);

/// Known browser process names for detection (without .exe)
pub const KNOWN_BROWSER_PROCESS_NAMES: &[&str] = &[
    "chrome", "firefox", "msedge", "edge", "iexplore", "opera", "brave", "vivaldi", "browser",
    "arc",
];

/// Fast window finder using Win32 EnumWindows API
/// This is 10-100x faster than UI Automation tree traversal
unsafe extern "system" fn enum_windows_callback(hwnd: HWND, _lparam: LPARAM) -> i32 {
    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid as *mut u32));

    // Check if this window matches our target PID
    if pid == ENUM_TARGET_PID.load(Ordering::Relaxed) {
        // Only consider visible windows
        if IsWindowVisible(hwnd).as_bool() {
            ENUM_FOUND_HWND.store(hwnd.0 as isize, Ordering::Relaxed);
            return 0; // FALSE - Stop enumeration
        }
    }

    1 // TRUE - Continue enumeration
}

/// Find window HWND by PID using fast Win32 EnumWindows
/// Returns HWND if found, 0 if not found
fn find_hwnd_by_pid_fast(target_pid: u32) -> isize {
    unsafe {
        ENUM_TARGET_PID.store(target_pid, Ordering::Relaxed);
        ENUM_FOUND_HWND.store(0, Ordering::Relaxed);

        debug!("[TIMING] Starting EnumWindows for PID {}", target_pid);
        let start = std::time::Instant::now();

        // Transmute the callback to match Windows API signature (i32 -> BOOL)
        let callback = std::mem::transmute::<
            unsafe extern "system" fn(HWND, LPARAM) -> i32,
            unsafe extern "system" fn(HWND, LPARAM) -> _,
        >(enum_windows_callback);
        let _ = EnumWindows(Some(callback), LPARAM(0));

        let hwnd = ENUM_FOUND_HWND.load(Ordering::Relaxed);
        debug!(
            "[TIMING] EnumWindows completed in {}ms, HWND: 0x{:X}",
            start.elapsed().as_millis(),
            hwnd
        );

        hwnd
    }
}

/// Convert HWND to UIElement using UI Automation
fn hwnd_to_uielement(engine: &WindowsEngine, hwnd: isize) -> Result<UIElement, AutomationError> {
    debug!("[TIMING] Converting HWND 0x{:X} to UIElement", hwnd);
    let start = std::time::Instant::now();

    // Use UI Automation to get the element from HWND
    // Convert hwnd (isize) to Handle via Into trait
    let uia_element = engine
        .automation
        .0
        .element_from_handle(hwnd.into())
        .map_err(|e| {
            AutomationError::PlatformError(format!(
                "Failed to get UIElement from HWND 0x{hwnd:X}: {e:?}"
            ))
        })?;

    debug!(
        "[TIMING] HWND to UIElement conversion took {}ms",
        start.elapsed().as_millis()
    );

    #[allow(clippy::arc_with_non_send_sync)]
    let arc_ele = ThreadSafeWinUIElement(Arc::new(uia_element));

    Ok(UIElement::new(Box::new(WindowsUIElement {
        element: arc_ele,
        engine: None,
    })))
}

/// Helper function to get process name by PID using native Windows API
pub fn get_process_name_by_pid(pid: i32) -> Result<String, AutomationError> {
    unsafe {
        // Create a snapshot of all processes
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).map_err(|e| {
            AutomationError::PlatformError(format!("Failed to create process snapshot: {e}"))
        })?;

        if snapshot.is_invalid() {
            return Err(AutomationError::PlatformError(
                "Invalid snapshot handle".to_string(),
            ));
        }

        // Ensure we close the handle when done
        let _guard = HandleGuard(snapshot);

        let mut process_entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };

        // Get the first process
        if Process32FirstW(snapshot, &mut process_entry).is_err() {
            return Err(AutomationError::PlatformError(
                "Failed to get first process".to_string(),
            ));
        }

        // Iterate through processes to find the one with matching PID
        loop {
            if process_entry.th32ProcessID == pid as u32 {
                // Convert the process name from wide string to String
                let name_slice = &process_entry.szExeFile;
                let name_len = name_slice
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(name_slice.len());
                let process_name = String::from_utf16_lossy(&name_slice[..name_len]);

                // Remove .exe extension if present
                let clean_name = process_name
                    .strip_suffix(".exe")
                    .or_else(|| process_name.strip_suffix(".EXE"))
                    .unwrap_or(&process_name);

                return Ok(clean_name.to_string());
            }

            // Get the next process
            if Process32NextW(snapshot, &mut process_entry).is_err() {
                break;
            }
        }

        Err(AutomationError::PlatformError(format!(
            "Process with PID {pid} not found"
        )))
    }
}

/// Check if a process (by PID) is a known browser
/// Returns true if the process name matches any known browser, false otherwise
pub fn is_browser_process(pid: u32) -> bool {
    if let Ok(process_name) = get_process_name_by_pid(pid as i32) {
        let process_name_lower = process_name.to_lowercase();
        KNOWN_BROWSER_PROCESS_NAMES
            .iter()
            .any(|&browser| process_name_lower.contains(browser))
    } else {
        false
    }
}

pub fn get_application_by_name(
    engine: &WindowsEngine,
    name: &str,
) -> Result<UIElement, AutomationError> {
    debug!("searching application from name: {}", name);

    // Strip .exe suffix if present
    let search_name = name
        .strip_suffix(".exe")
        .or_else(|| name.strip_suffix(".EXE"))
        .unwrap_or(name);

    let search_name_lower = search_name.to_lowercase();
    let is_browser = KNOWN_BROWSER_PROCESS_NAMES
        .iter()
        .any(|&browser| search_name_lower.contains(browser));

    // For non-browsers, try fast PID lookup first
    if !is_browser {
        if let Some(pid) = get_pid_by_name(search_name) {
            debug!(
                "Found process PID {} for non-browser app: {}",
                pid, search_name
            );

            let condition = engine
                .automation
                .0
                .create_property_condition(UIProperty::ProcessId, Variant::from(pid), None)
                .map_err(|e| {
                    AutomationError::PlatformError(format!(
                        "Failed to create ProcessId condition for PID {} at {}:{}: {:?}",
                        pid,
                        file!(),
                        line!(),
                        e
                    ))
                })?;
            let root_ele = engine.automation.0.get_root_element().map_err(|e| {
                AutomationError::PlatformError(format!(
                    "Failed to get root element for PID {} lookup at {}:{}: {:?}",
                    pid,
                    file!(),
                    line!(),
                    e
                ))
            })?;

            // Try direct window lookup by PID
            if let Ok(ele) = root_ele.find_first(TreeScope::Children, &condition) {
                debug!("Found application window for PID {}", pid);
                #[allow(clippy::arc_with_non_send_sync)]
                let arc_ele = ThreadSafeWinUIElement(Arc::new(ele));
                return Ok(UIElement::new(Box::new(WindowsUIElement {
                    element: arc_ele,
                    engine: None,
                })));
            }
        }
    }

    // For browsers and fallback: Use window title search
    debug!("Using window title search for: {}", search_name);
    let root_ele = engine.automation.0.get_root_element().map_err(|e| {
        AutomationError::PlatformError(format!(
            "Failed to get root element for browser search '{}' at {}:{}: {:?}",
            search_name,
            file!(),
            line!(),
            e
        ))
    })?;

    let matcher = engine
        .automation
        .0
        .create_matcher()
        .control_type(ControlType::Window)
        .filter_fn(Box::new(move |e: &uiautomation::UIElement| {
            let window_name = e.get_name().unwrap_or_default();
            let window_name_lower = window_name.to_lowercase();

            // Enhanced browser matching logic with better detection
            let matches = match search_name_lower.as_str() {
                "chrome" => {
                    window_name_lower.contains("chrome")
                        || window_name_lower.contains("google chrome")
                        || (window_name_lower.contains("google")
                            && window_name_lower.contains("browser"))
                }
                "firefox" => {
                    window_name_lower.contains("firefox")
                        || window_name_lower.contains("mozilla")
                        || window_name_lower.contains("mozilla firefox")
                }
                "msedge" | "edge" => {
                    // Enhanced Edge detection
                    if window_name_lower.contains("edge")
                        || window_name_lower.contains("microsoft edge")
                        || window_name_lower.contains("microsoft")
                    {
                        true
                    } else if let Ok(pid) = e.get_process_id() {
                        get_process_name_by_pid(pid as i32)
                            .map(|p| {
                                let proc_name = p.to_lowercase();
                                proc_name == "msedge" || proc_name == "edge"
                            })
                            .unwrap_or(false)
                    } else {
                        false
                    }
                }
                "brave" => {
                    window_name_lower.contains("brave")
                        || window_name_lower.contains("brave browser")
                }
                "opera" => {
                    window_name_lower.contains("opera")
                        || window_name_lower.contains("opera browser")
                }
                "vivaldi" => {
                    window_name_lower.contains("vivaldi")
                        || window_name_lower.contains("vivaldi browser")
                }
                "arc" => {
                    window_name_lower.contains("arc") || window_name_lower.contains("arc browser")
                }
                _ => {
                    // For non-browsers, use more flexible matching
                    window_name_lower.contains(&search_name_lower)
                        || search_name_lower.contains(&window_name_lower)
                }
            };
            Ok(matches)
        }))
        .from_ref(&root_ele)
        .depth(3)
        .timeout(3000);

    let ele = matcher.find_first().map_err(|e| {
        AutomationError::PlatformError(format!("No window found for application '{name}': {e}"))
    })?;

    debug!("Found window: {}", ele.get_name().unwrap_or_default());
    #[allow(clippy::arc_with_non_send_sync)]
    let arc_ele = ThreadSafeWinUIElement(Arc::new(ele));
    Ok(UIElement::new(Box::new(WindowsUIElement {
        element: arc_ele,
        engine: None,
    })))
}

pub fn get_application_by_pid(
    engine: &WindowsEngine,
    pid: i32,
    timeout: Option<Duration>,
) -> Result<UIElement, AutomationError> {
    debug!("[TIMING] get_application_by_pid called for PID {}", pid);
    let overall_start = std::time::Instant::now();

    // OPTIMIZED: Use fast Win32 EnumWindows instead of slow UI Automation tree traversal
    // This is 10-100x faster!
    let timeout_duration = timeout.unwrap_or(DEFAULT_FIND_TIMEOUT);
    let timeout_ms = timeout_duration.as_millis() as u64;
    let retry_interval = Duration::from_millis(100);
    let max_retries = (timeout_ms / retry_interval.as_millis() as u64) as usize;

    // Try to find the window with retries
    for attempt in 0..max_retries {
        let hwnd = find_hwnd_by_pid_fast(pid as u32);

        if hwnd != 0 {
            // Found the window! Convert HWND to UIElement
            debug!(
                "[TIMING] Window found on attempt {}, converting to UIElement",
                attempt + 1
            );
            let result = hwnd_to_uielement(engine, hwnd);
            debug!(
                "[TIMING] get_application_by_pid total time: {}ms",
                overall_start.elapsed().as_millis()
            );
            return result;
        }

        // Window not found yet, wait a bit before retry
        if attempt < max_retries - 1 {
            std::thread::sleep(retry_interval);
        }
    }

    debug!(
        "[TIMING] Window not found after {}ms, falling back to UI Automation",
        overall_start.elapsed().as_millis()
    );

    // FALLBACK: If EnumWindows didn't find it, try the old UI Automation approach
    // (This handles edge cases like child windows or special panes)
    let root_ele = engine.automation.0.get_root_element().map_err(|e| {
        AutomationError::PlatformError(format!(
            "Failed to get root element for PID {} wait at {}:{}: {:?}",
            pid,
            file!(),
            line!(),
            e
        ))
    })?;

    let matcher = engine
        .automation
        .0
        .create_matcher()
        .from_ref(&root_ele)
        .filter(Box::new(OrFilter {
            left: Box::new(ControlTypeFilter {
                control_type: ControlType::Window,
            }),
            right: Box::new(ControlTypeFilter {
                control_type: ControlType::Pane,
            }),
        }))
        .filter_fn(Box::new(move |e: &uiautomation::UIElement| {
            match e.get_process_id() {
                Ok(element_pid) => Ok(element_pid == pid as u32),
                Err(_) => Ok(false),
            }
        }))
        .timeout(1000); // Shorter timeout for fallback

    let ele = matcher.find_first().map_err(|e| {
        AutomationError::ElementNotFound(format!(
            "Application with PID {pid} not found within {timeout_ms}ms timeout: {e}"
        ))
    })?;

    #[allow(clippy::arc_with_non_send_sync)]
    let arc_ele = ThreadSafeWinUIElement(Arc::new(ele));

    debug!(
        "[TIMING] get_application_by_pid total time (with fallback): {}ms",
        overall_start.elapsed().as_millis()
    );

    Ok(UIElement::new(Box::new(WindowsUIElement {
        element: arc_ele,
        engine: None,
    })))
}

pub fn open_application(
    engine: &WindowsEngine,
    app_name: &str,
) -> Result<UIElement, AutomationError> {
    info!("Opening application on Windows: {}", app_name);

    // Handle modern ms-settings apps
    if app_name.starts_with("ms-settings:") {
        info!("Launching ms-settings URI: {}", app_name);
        unsafe {
            let app_name_hstring = HSTRING::from(app_name);
            let verb_hstring = HSTRING::from("open");
            let result = ShellExecuteW(
                None,
                PCWSTR(verb_hstring.as_ptr()),
                PCWSTR(app_name_hstring.as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            );
            // A value > 32 indicates success for ShellExecuteW
            if result.0 as isize <= 32 {
                return Err(AutomationError::PlatformError(format!(
                    "Failed to open ms-settings URI: {}. Error code: {:?}",
                    app_name, result.0
                )));
            }
        }
        // After launching, wait a bit for the app to initialize.
        std::thread::sleep(Duration::from_secs(2));
        // The window name for settings is just "Settings"
        return get_application_by_name(engine, "Settings");
    }

    // Try to get app info from StartApps first
    if let Ok((app_id, display_name)) = get_app_info_from_startapps(app_name) {
        return launch_app(engine, &app_id, &display_name);
    }

    // If it's not a start menu app, assume it's a legacy executable
    warn!(
        "Could not find '{}' in StartApps, attempting to launch as executable.",
        app_name
    );
    launch_legacy_app(engine, app_name)
}

/// Cache structure for Get-StartApps results
struct StartAppsCache {
    apps: Vec<Value>,
    last_updated: Instant,
}

/// Helper function to fetch apps from PowerShell
fn fetch_startapps_from_powershell() -> Result<Vec<Value>, AutomationError> {
    debug!("[TIMING] Starting Get-StartApps PowerShell query");
    let start = std::time::Instant::now();

    let command = r#"Get-StartApps | Select-Object Name, AppID | ConvertTo-Json"#.to_string();

    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-WindowStyle", "hidden", "-Command", &command])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| AutomationError::PlatformError(e.to_string()))?;

    if !output.status.success() {
        let error_msg = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(AutomationError::PlatformError(format!(
            "Failed to get UWP apps list: {error_msg}"
        )));
    }

    let output_str = String::from_utf8_lossy(&output.stdout);
    let apps: Vec<Value> = serde_json::from_str(&output_str)
        .map_err(|e| AutomationError::PlatformError(format!("Failed to parse apps list: {e}")))?;

    debug!(
        "[TIMING] Get-StartApps completed in {}ms",
        start.elapsed().as_millis()
    );

    Ok(apps)
}

/// Get apps information using Get-StartApps with caching
/// Cache TTL is 30 seconds to avoid repeated PowerShell calls
pub fn get_app_info_from_startapps(app_name: &str) -> Result<(String, String), AutomationError> {
    // OPTIMIZATION: Cache Get-StartApps results to avoid slow PowerShell calls (saves ~566ms)
    static STARTAPPS_CACHE: Mutex<Option<StartAppsCache>> = Mutex::new(None);
    const CACHE_TTL: Duration = Duration::from_secs(30);

    // Try to get apps list from cache first
    let apps: Vec<Value> = {
        let cache_guard = STARTAPPS_CACHE.lock().unwrap();

        if let Some(ref cache) = *cache_guard {
            if cache.last_updated.elapsed() < CACHE_TTL {
                debug!(
                    "[TIMING] Using cached Get-StartApps results (age: {}ms)",
                    cache.last_updated.elapsed().as_millis()
                );
                cache.apps.clone()
            } else {
                debug!("[TIMING] Get-StartApps cache expired, refreshing");
                // Cache expired, need to refresh
                drop(cache_guard); // Release lock before expensive operation
                let apps = fetch_startapps_from_powershell()?;

                // Update cache
                let mut cache_guard = STARTAPPS_CACHE.lock().unwrap();
                *cache_guard = Some(StartAppsCache {
                    apps: apps.clone(),
                    last_updated: Instant::now(),
                });
                apps
            }
        } else {
            debug!("[TIMING] Get-StartApps cache empty, initializing");
            // No cache yet, fetch and populate
            drop(cache_guard); // Release lock before expensive operation
            let apps = fetch_startapps_from_powershell()?;

            // Update cache
            let mut cache_guard = STARTAPPS_CACHE.lock().unwrap();
            *cache_guard = Some(StartAppsCache {
                apps: apps.clone(),
                last_updated: Instant::now(),
            });
            apps
        }
    };

    // two parts
    let search_terms: Vec<String> = app_name
        .to_lowercase()
        .split_whitespace()
        .map(|s| s.to_string())
        .collect();

    // Search for matching app by name or AppID
    let matching_app = apps.iter().find(|app| {
        let name = app
            .get("Name")
            .and_then(|n| n.as_str())
            .unwrap_or("")
            .to_lowercase();
        let app_id = app
            .get("AppID")
            .and_then(|id| id.as_str())
            .unwrap_or("")
            .to_lowercase();

        // make sure both parts exists
        search_terms
            .iter()
            .all(|term| name.contains(term) || app_id.contains(term))
    });

    match matching_app {
        Some(app) => {
            let display_name = app.get("Name").and_then(|n| n.as_str()).ok_or_else(|| {
                AutomationError::PlatformError("Failed to get app name".to_string())
            })?;
            let app_id = app.get("AppID").and_then(|id| id.as_str()).ok_or_else(|| {
                AutomationError::PlatformError("Failed to get app ID".to_string())
            })?;
            Ok((app_id.to_string(), display_name.to_string()))
        }
        None => Err(AutomationError::PlatformError(format!(
            "No app found matching '{app_name}' in Get-StartApps list"
        ))),
    }
}

/// Helper function to get application by PID with fallback to child process and name
fn get_application_pid(
    engine: &WindowsEngine,
    pid: i32,
    app_name: &str,
) -> Result<UIElement, AutomationError> {
    unsafe {
        // Check if the process with this PID exists
        let mut pid_exists = false;
        let snapshot = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            Ok(handle) => handle,
            Err(_) => {
                debug!(
                    "Failed to create process snapshot for PID existence check, falling back to name"
                );
                let app = get_application_by_name(engine, app_name)?;
                app.activate_window()?;
                return Ok(app);
            }
        };
        if !snapshot.is_invalid() {
            let _guard = HandleGuard(snapshot);
            let mut process_entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            if Process32FirstW(snapshot, &mut process_entry).is_ok() {
                loop {
                    if process_entry.th32ProcessID == pid as u32 {
                        pid_exists = true;
                        break;
                    }
                    if Process32NextW(snapshot, &mut process_entry).is_err() {
                        break;
                    }
                }
            }
        }

        if pid_exists {
            match get_application_by_pid(engine, pid, Some(DEFAULT_FIND_TIMEOUT)) {
                Ok(app) => {
                    app.activate_window()?;
                    return Ok(app);
                }
                Err(_) => {
                    debug!("Failed to get application by PID, will try child PID logic");
                }
            }
        }

        // If PID does not exist or get_application_by_pid failed, try to find a child process with this as parent
        let parent_pid = pid as u32;
        let snapshot = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            Ok(handle) => handle,
            Err(_) => {
                debug!("Failed to create process snapshot for child search, falling back to name");
                let app = get_application_by_name(engine, app_name)?;
                app.activate_window()?;
                return Ok(app);
            }
        };
        if snapshot.is_invalid() {
            debug!("Invalid snapshot handle for child search, falling back to name");
            let app = get_application_by_name(engine, app_name)?;
            app.activate_window()?;
            return Ok(app);
        }
        let _guard = HandleGuard(snapshot);
        let mut process_entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut found_child_pid: Option<u32> = None;
        if Process32FirstW(snapshot, &mut process_entry).is_ok() {
            loop {
                if process_entry.th32ParentProcessID == parent_pid {
                    found_child_pid = Some(process_entry.th32ProcessID);
                    break;
                }
                if Process32NextW(snapshot, &mut process_entry).is_err() {
                    break;
                }
            }
        }
        if let Some(child_pid) = found_child_pid {
            match get_application_by_pid(engine, child_pid as i32, Some(DEFAULT_FIND_TIMEOUT)) {
                Ok(app) => {
                    app.activate_window()?;
                    return Ok(app);
                }
                Err(_) => {
                    debug!("Failed to get application by child PID, falling back to name");
                }
            }
        }
        // If all else fails, try to find the application by name
        debug!(
            "Failed to get application by PID and child PID, trying by name: {}",
            app_name
        );
        let app = get_application_by_name(engine, app_name)?;
        app.activate_window()?;
        Ok(app)
    }
}

/// launches any windows application returns its UIElement
pub(crate) fn launch_app(
    engine: &WindowsEngine,
    app_id: &str,
    display_name: &str,
) -> Result<UIElement, AutomationError> {
    debug!("[TIMING] Starting launch_app for: {}", display_name);
    let launch_start = std::time::Instant::now();

    let pid = unsafe {
        // Initialize COM with proper error handling
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        if hr.is_err() && hr != HRESULT(0x80010106u32 as i32) {
            // Only return error if it's not the "already initialized" case
            return Err(AutomationError::PlatformError(format!(
                "Failed to initialize COM: {hr}"
            )));
        }
        // If we get here, either initialization succeeded or it was already initialized
        if hr == HRESULT(0x80010106u32 as i32) {
            debug!("COM already initialized in this thread");
        }

        // Create the ApplicationActivationManager COM object
        let manager: IApplicationActivationManager =
            CoCreateInstance(&ApplicationActivationManager, None, CLSCTX_ALL).map_err(|e| {
                AutomationError::PlatformError(format!(
                    "Failed to create ApplicationActivationManager: {e}"
                ))
            })?;

        // Set options (e.g., NoSplashScreen)
        let options = ACTIVATEOPTIONS(super::types::ActivateOptions::None as i32);

        match manager.ActivateApplication(
            &HSTRING::from(app_id),
            &HSTRING::from(""), // no arguments
            options,
        ) {
            Ok(pid) => pid,
            Err(_) => {
                let shell_app_id: Vec<u16> = format!("shell:AppsFolder\\{app_id}")
                    .encode_utf16()
                    .chain(Some(0))
                    .collect();
                let operation_wide: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
                let mut sei = SHELLEXECUTEINFOW {
                    cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
                    fMask: SEE_MASK_NOASYNC | SEE_MASK_NOCLOSEPROCESS,
                    hwnd: HWND(std::ptr::null_mut()),
                    lpVerb: PCWSTR(operation_wide.as_ptr()),
                    lpFile: PCWSTR::from_raw(shell_app_id.as_ptr()),
                    lpParameters: PCWSTR::null(),
                    lpDirectory: PCWSTR::null(),
                    nShow: SW_SHOWNORMAL.0,
                    hInstApp: HINSTANCE(std::ptr::null_mut()),
                    lpIDList: std::ptr::null_mut(),
                    lpClass: PCWSTR::null(),
                    hkeyClass: windows::Win32::System::Registry::HKEY(std::ptr::null_mut()),
                    dwHotKey: 0,
                    Anonymous: Default::default(),
                    hProcess: HANDLE(std::ptr::null_mut()),
                };

                ShellExecuteExW(&mut sei).map_err(|e| {
                    AutomationError::PlatformError(format!(
                        "ShellExecuteExW failed:
                        '{e}' to launch app '{display_name}':"
                    ))
                })?;

                let process_handle = sei.hProcess;

                if process_handle.is_invalid() {
                    let _ = CloseHandle(process_handle);
                    debug!(
                        "Failed to get pid of launched app: '{:?}' using `ShellExecuteExW`, will get the ui element of by its name ",
                        display_name
                    );
                    return get_application_by_name(engine, display_name);
                }

                let pid = GetProcessId(process_handle);
                let _ = CloseHandle(process_handle); // we can use HandleGuard too

                pid
            }
        }
    };

    if pid > 0 {
        // OPTIMIZED: Reduced sleep from 1000ms to 300ms
        // The new EnumWindows-based search with retries handles slow-starting apps better
        debug!("[TIMING] App launched, starting 300ms sleep");
        let sleep_start = std::time::Instant::now();
        std::thread::sleep(std::time::Duration::from_millis(300));
        debug!(
            "[TIMING] Sleep completed in {}ms, now searching for window",
            sleep_start.elapsed().as_millis()
        );

        let result = get_application_pid(engine, pid as i32, display_name);
        debug!(
            "[TIMING] launch_app total time: {}ms",
            launch_start.elapsed().as_millis()
        );
        result
    } else {
        Err(AutomationError::PlatformError(
            "Failed to launch the application".to_string(),
        ))
    }
}

pub(crate) fn launch_legacy_app(
    engine: &WindowsEngine,
    app_name: &str,
) -> Result<UIElement, AutomationError> {
    info!("Launching legacy app: {}", app_name);
    unsafe {
        // Convert app_name to wide string
        let mut app_name_wide: Vec<u16> =
            app_name.encode_utf16().chain(std::iter::once(0)).collect();

        // Prepare process startup info
        let startup_info = STARTUPINFOW {
            cb: std::mem::size_of::<STARTUPINFOW>() as u32,
            ..Default::default()
        };

        // Prepare process info
        let mut process_info = PROCESS_INFORMATION::default();

        // Create the process
        let result = CreateProcessW(
            None, // Application name (null means use command line)
            Some(windows::core::PWSTR::from_raw(app_name_wide.as_mut_ptr())), // Command line
            None, // Process security attributes
            None, // Thread security attributes
            false, // Inherit handles
            CREATE_NEW_CONSOLE, // Creation flags
            None, // Environment
            None, // Current directory
            &startup_info,
            &mut process_info,
        );

        if result.is_err() {
            return Err(AutomationError::PlatformError(format!(
                "Failed to launch application '{app_name}'"
            )));
        }

        // Close thread handle as we don't need it
        let _ = CloseHandle(process_info.hThread);

        // Store process handle in a guard to ensure it's closed
        let _process_handle = HandleGuard(process_info.hProcess);

        // Get the PID
        let pid = process_info.dwProcessId as i32;

        // Extract process name from process_info (unused variable)
        let process_name = get_process_name_by_pid(pid).unwrap_or_else(|_| app_name.to_string());

        match get_application_pid(engine, pid, app_name) {
            Ok(app) => Ok(app),
            Err(_) => {
                let new_pid = get_pid_by_name(&process_name);
                if new_pid.is_none() {
                    return Err(AutomationError::PlatformError(format!(
                        "Failed to get PID for launched process: {process_name}"
                    )));
                }
                // Try again with the extracted PID
                get_application_pid(engine, new_pid.unwrap(), app_name)
            }
        }
    }
}

pub(crate) fn get_pid_by_name(name: &str) -> Option<i32> {
    // OPTIMIZATION: Use a static cache to avoid repeated process enumeration
    struct ProcessCache {
        processes: HashMap<String, i32>,
        last_updated: Instant,
    }

    static PROCESS_CACHE: Mutex<Option<ProcessCache>> = Mutex::new(None);
    const CACHE_DURATION: Duration = Duration::from_secs(2); // Cache for 2 seconds

    let search_name_lower = name.to_lowercase();

    // Check cache first
    {
        let cache_guard = PROCESS_CACHE.lock().unwrap();
        if let Some(ref cache) = *cache_guard {
            if cache.last_updated.elapsed() < CACHE_DURATION {
                // Cache is still valid, check if we have the process
                for (cached_name, &pid) in &cache.processes {
                    if cached_name.contains(&search_name_lower) {
                        debug!("Found PID {} for '{}' in cache", pid, name);
                        return Some(pid);
                    }
                }
                // If we reach here, process not found in valid cache
                return None;
            }
        }
    }

    // Cache is stale or doesn't exist, refresh it
    debug!("Refreshing process cache for PID lookup");
    unsafe {
        // Create a snapshot of all processes
        let snapshot = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            Ok(handle) => handle,
            Err(_) => return None,
        };

        if snapshot.is_invalid() {
            return None;
        }

        // Ensure we close the handle when done
        let _guard = HandleGuard(snapshot);

        let mut process_entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };

        // Get the first process
        if Process32FirstW(snapshot, &mut process_entry).is_err() {
            return None;
        }

        let mut new_processes = HashMap::new();
        let mut found_pid: Option<i32> = None;

        // Iterate through processes to build cache and find our target
        loop {
            // Convert the process name from wide string to String
            let name_slice = &process_entry.szExeFile;
            let name_len = name_slice
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(name_slice.len());
            let process_name = String::from_utf16_lossy(&name_slice[..name_len]);

            // Remove .exe extension if present for comparison
            let clean_name = process_name
                .strip_suffix(".exe")
                .or_else(|| process_name.strip_suffix(".EXE"))
                .unwrap_or(&process_name);

            let clean_name_lower = clean_name.to_lowercase();
            let pid = process_entry.th32ProcessID as i32;

            // Add to cache
            new_processes.insert(clean_name_lower.clone(), pid);

            // Check if this is our target process
            if found_pid.is_none() && clean_name_lower.contains(&search_name_lower) {
                found_pid = Some(pid);
            }

            // Get the next process
            if Process32NextW(snapshot, &mut process_entry).is_err() {
                break;
            }
        }

        // Update cache
        {
            let mut cache_guard = PROCESS_CACHE.lock().unwrap();
            *cache_guard = Some(ProcessCache {
                processes: new_processes,
                last_updated: Instant::now(),
            });
        }

        if let Some(pid) = found_pid {
            debug!("Found PID {} for '{}' via process enumeration", pid, name);
        }

        found_pid
    }
}
