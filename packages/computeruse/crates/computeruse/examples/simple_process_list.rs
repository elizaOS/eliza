use std::collections::HashMap;
use computeruse::{AutomationError, Desktop};

#[tokio::main]
async fn main() -> Result<(), AutomationError> {
    // Initialize tracing
    tracing_subscriber::fmt().with_env_filter("info").init();

    println!("Starting process and window enumeration...");

    // Create desktop automation instance
    let desktop = Desktop::new(false, false)?;

    // Get all applications
    let applications = desktop.applications()?;
    println!("Found {} applications", applications.len());

    // Group windows by process ID to show the relationship
    let mut process_windows: HashMap<u32, Vec<String>> = HashMap::new();
    let mut process_names: HashMap<u32, String> = HashMap::new();

    println!("\n=== Process ID and Window/App Mapping ===");
    println!(
        "{:<8} {:<30} {:<50}",
        "PID", "Process Name", "Window/App Title"
    );
    println!("{}", "-".repeat(90));

    for (index, app) in applications.iter().enumerate() {
        match get_app_info(app, index) {
            Ok((pid, process_name, window_title)) => {
                // Store process name
                process_names
                    .entry(pid)
                    .or_insert_with(|| process_name.clone());

                // Add window title to this process
                process_windows
                    .entry(pid)
                    .or_default()
                    .push(window_title.clone());

                println!(
                    "{:<8} {:<30} {:<50}",
                    pid,
                    truncate_string(&process_name, 29),
                    truncate_string(&window_title, 49)
                );
            }
            Err(e) => {
                eprintln!("Failed to get info for application {index}: {e}");
            }
        }
    }

    // Show summary of processes with multiple windows
    println!("\n=== Processes with Multiple Windows ===");
    println!(
        "{:<8} {:<30} {:<10} Titles",
        "PID", "Process Name", "Windows"
    );
    println!("{}", "-".repeat(100));

    for (pid, windows) in process_windows.iter() {
        if windows.len() > 1 {
            let unknown_process = "Unknown".to_string();
            let process_name = process_names.get(pid).unwrap_or(&unknown_process);
            println!(
                "{:<8} {:<30} {:<10} {}",
                pid,
                truncate_string(process_name, 29),
                windows.len(),
                truncate_string(&windows.join(", "), 50)
            );
        }
    }

    // Show browser processes specifically
    println!("\n=== Browser Processes ===");
    for (pid, process_name) in process_names.iter() {
        if is_browser_process(*pid) {
            let windows = process_windows.get(pid).unwrap();
            println!(
                "Browser PID {}: {} ({} windows)",
                pid,
                process_name,
                windows.len()
            );
            for (i, window) in windows.iter().enumerate() {
                println!("  Window {}: {}", i + 1, truncate_string(window, 70));
            }
        }
    }

    Ok(())
}

fn get_app_info(
    app: &computeruse::UIElement,
    index: usize,
) -> Result<(u32, String, String), AutomationError> {
    // Get process ID
    let pid = app.process_id()?;

    // Get process name using the process ID
    #[cfg(target_os = "windows")]
    let process_name = {
        use computeruse::platforms::windows::get_process_name_by_pid;
        get_process_name_by_pid(pid as i32).unwrap_or_else(|_| format!("Unknown-{pid}"))
    };

    #[cfg(not(target_os = "windows"))]
    let process_name = format!("Process-{}", pid);

    // Get window/app title
    let attributes = app.attributes();
    let window_title = attributes
        .name
        .unwrap_or_else(|| format!("Unnamed-App-{index}"));

    Ok((pid, process_name, window_title))
}

fn is_browser_process(pid: u32) -> bool {
    const KNOWN_BROWSER_PROCESS_NAMES: &[&str] = &[
        "chrome", "firefox", "msedge", "iexplore", "opera", "brave", "vivaldi", "browser", "arc",
    ];

    #[cfg(target_os = "windows")]
    {
        use computeruse::platforms::windows::get_process_name_by_pid;
        if let Ok(process_name) = get_process_name_by_pid(pid as i32) {
            let process_name_lower = process_name.to_lowercase();
            KNOWN_BROWSER_PROCESS_NAMES
                .iter()
                .any(|&browser| process_name_lower.contains(browser))
        } else {
            false
        }
    }

    #[cfg(not(target_os = "windows"))]
    false
}

fn truncate_string(s: &str, max_len: usize) -> String {
    if s.len() <= max_len {
        s.to_string()
    } else {
        format!("{}...", &s[..max_len.saturating_sub(3)])
    }
}
