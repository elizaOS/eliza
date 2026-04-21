use sysinfo::System;
use std::path::PathBuf;

pub fn available_memory_gb() -> f64 {
    let sys = System::new_all();
    sys.available_memory() as f64 / 1_073_741_824.0
}

pub fn total_memory_gb() -> f64 {
    let sys = System::new_all();
    sys.total_memory() as f64 / 1_073_741_824.0
}

/// Pick the biggest ollama model tag that fits in available memory.
pub fn pick_model() -> &'static str {
    let available = available_memory_gb();
    if available >= 48.0 {
        "qwen2.5:72b"
    } else if available >= 20.0 {
        "qwen2.5:32b"
    } else if available >= 10.0 {
        "qwen2.5:14b"
    } else if available >= 5.0 {
        "qwen2.5:7b"
    } else {
        "qwen2.5:1.5b"
    }
}

pub fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

pub fn virus_dir() -> PathBuf {
    home_dir().join(".virus")
}

/// Seconds since last human input (mouse/keyboard).
/// Uses wrapping subtraction to handle GetTickCount's 49.7-day rollover.
#[cfg(windows)]
pub fn idle_seconds() -> u64 {
    use winapi::um::winuser::{GetLastInputInfo, LASTINPUTINFO};
    use winapi::um::sysinfoapi::GetTickCount;
    unsafe {
        let mut lii = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        if GetLastInputInfo(&mut lii) != 0 {
            let now = GetTickCount();
            let elapsed_ms = now.wrapping_sub(lii.dwTime);
            (elapsed_ms / 1000) as u64
        } else {
            0
        }
    }
}

#[cfg(not(windows))]
pub fn idle_seconds() -> u64 {
    0 // on non-windows, always "active" — won't auto-trigger
}

/// Register virus.exe to run on startup via the Windows registry.
#[cfg(windows)]
pub fn install_autostart() -> Result<(), String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use winapi::um::winreg::{RegCloseKey, RegSetValueExW, HKEY_CURRENT_USER, RegOpenKeyExW};
    use winapi::um::winnt::{KEY_WRITE, REG_SZ};

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_str = exe.to_string_lossy();
    let value: Vec<u16> = OsStr::new(&*exe_str).encode_wide().chain(Some(0)).collect();

    let subkey: Vec<u16> = OsStr::new("Software\\Microsoft\\Windows\\CurrentVersion\\Run")
        .encode_wide()
        .chain(Some(0))
        .collect();
    let name: Vec<u16> = OsStr::new("virus").encode_wide().chain(Some(0)).collect();

    unsafe {
        let mut hkey = std::ptr::null_mut();
        let res = RegOpenKeyExW(HKEY_CURRENT_USER, subkey.as_ptr(), 0, KEY_WRITE, &mut hkey);
        if res != 0 {
            return Err(format!("RegOpenKeyExW failed: {}", res));
        }
        let res = RegSetValueExW(
            hkey,
            name.as_ptr(),
            0,
            REG_SZ,
            value.as_ptr() as *const u8,
            (value.len() * 2) as u32,
        );
        RegCloseKey(hkey);
        if res != 0 {
            return Err(format!("RegSetValueExW failed: {}", res));
        }
    }
    Ok(())
}

/// Remove virus.exe from startup via the Windows registry.
#[cfg(windows)]
pub fn uninstall_autostart() -> Result<(), String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use winapi::um::winreg::{RegCloseKey, RegDeleteValueW, HKEY_CURRENT_USER, RegOpenKeyExW};
    use winapi::um::winnt::KEY_WRITE;

    let subkey: Vec<u16> = OsStr::new("Software\\Microsoft\\Windows\\CurrentVersion\\Run")
        .encode_wide()
        .chain(Some(0))
        .collect();
    let name: Vec<u16> = OsStr::new("virus").encode_wide().chain(Some(0)).collect();

    unsafe {
        let mut hkey = std::ptr::null_mut();
        let res = RegOpenKeyExW(HKEY_CURRENT_USER, subkey.as_ptr(), 0, KEY_WRITE, &mut hkey);
        if res != 0 {
            return Err(format!("RegOpenKeyExW failed: {}", res));
        }
        let res = RegDeleteValueW(hkey, name.as_ptr());
        RegCloseKey(hkey);
        if res != 0 {
            return Err(format!("RegDeleteValueW failed (may not be installed): {}", res));
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn install_autostart() -> Result<(), String> {
    Err("Auto-start not implemented for this platform".to_string())
}

#[cfg(not(windows))]
pub fn uninstall_autostart() -> Result<(), String> {
    Err("Auto-start not implemented for this platform".to_string())
}
