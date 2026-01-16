use crate::{AutomationError, Desktop};

/// Normalize a string by removing zero-width and special Unicode whitespace characters and lowercasing it.
pub fn normalize(s: &str) -> String {
    s.chars()
        .filter(|c| {
            // Remove zero-width and non-breaking spaces, but keep regular spaces
            !matches!(
                *c,
                '\u{200B}' | // zero-width space
                '\u{200C}' | // zero-width non-joiner
                '\u{200D}' | // zero-width joiner
                '\u{00A0}' | // non-breaking space
                '\u{FEFF}' // zero-width no-break space
            )
        })
        .collect::<String>()
        .to_lowercase()
}

/// Find the PID for a process by name (case-insensitive substring match).
///
/// This is the shared implementation used by both MCP agent and Node.js SDK.
/// It scans running applications and matches the process name.
///
/// # Arguments
/// * `desktop` - The Desktop instance to use for finding applications
/// * `process_name` - The process name to search for (e.g., "chrome", "notepad")
///
/// # Returns
/// * `Ok(u32)` - The PID of the first matching process
/// * `Err(AutomationError)` - If no matching process is found
///
/// # Example
/// ```ignore
/// let desktop = Desktop::new(false, false)?;
/// let pid = find_pid_for_process(&desktop, "chrome")?;
/// ```
pub fn find_pid_for_process(desktop: &Desktop, process_name: &str) -> Result<u32, AutomationError> {
    use sysinfo::{ProcessesToUpdate, System};

    let apps = desktop.applications()?;
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::All, true);

    let process_lower = process_name.to_lowercase();

    // Find first matching process
    apps.iter()
        .filter_map(|app| {
            let app_pid = app.process_id().unwrap_or(0);
            if app_pid > 0 {
                system
                    .process(sysinfo::Pid::from_u32(app_pid))
                    .and_then(|p| {
                        let name = p.name().to_string_lossy().to_string();
                        if name.to_lowercase().contains(&process_lower) {
                            Some(app_pid)
                        } else {
                            None
                        }
                    })
            } else {
                None
            }
        })
        .next()
        .ok_or_else(|| {
            AutomationError::ElementNotFound(format!(
                "Process '{}' not found. Use open_application() to start it first.",
                process_name
            ))
        })
}
