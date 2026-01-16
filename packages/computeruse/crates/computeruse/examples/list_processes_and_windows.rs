use std::collections::HashMap;
use computeruse::{AutomationError, Desktop};
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

const UNKNOWN_APP_NAME: &str = "Unknown";

#[tokio::main]
async fn main() -> Result<(), AutomationError> {
    // Initialize tracing
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    info!("Starting process and window enumeration...");

    // Create desktop automation instance
    let desktop = Desktop::new(false, false)?;

    // Get all applications
    let applications = desktop.applications()?;
    info!("Found {} applications", applications.len());

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
                warn!("Failed to get info for application {}: {}", index, e);
            }
        }
    }

    // Show summary of processes with multiple windows
    println!("\n=== Process Summary (Processes with Multiple Windows) ===");
    println!(
        "{:<8} {:<30} {:<10} Window Titles",
        "PID", "Process Name", "Windows"
    );
    println!("{}", "-".repeat(100));

    for (pid, windows) in process_windows.iter() {
        if windows.len() > 1 {
            let false_process_name = "Unknown".to_string();
            let process_name = process_names.get(pid).unwrap_or(&false_process_name);
            println!(
                "{:<8} {:<30} {:<10} {}",
                pid,
                truncate_string(process_name, 29),
                windows.len(),
                windows.join(", ")
            );
        }
    }

    // Demonstrate browser tab detection
    println!("\n=== Browser Tab Detection Example ===");
    detect_browser_tabs(&desktop).await?;

    // List all window names for each application/process using the new windows_for_application method
    println!("\n=== Windows for Each Application/Process (via windows_for_application) ===");
    for app in applications.iter() {
        let pid = match app.process_id() {
            Ok(pid) => pid,
            Err(_) => continue,
        };
        // Get application accessible name/title if available
        let app_attrs = app.attributes();

        // Get fallback process name if needed
        #[cfg(target_os = "windows")]
        let fallback_process_name = {
            use computeruse::platforms::windows::get_process_name_by_pid;
            get_process_name_by_pid(pid as i32).unwrap_or_else(|_| UNKNOWN_APP_NAME.to_string())
        };
        #[cfg(not(target_os = "windows"))]
        let fallback_process_name = UNKNOWN_APP_NAME.to_string();

        let app_title = app_attrs
            .name
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(&fallback_process_name);

        // Skip unknown apps
        if app_title == UNKNOWN_APP_NAME {
            continue;
        }

        // Use the new windows_for_application method
        let windows_result = desktop.windows_for_application(app_title).await;
        let mut window_titles = Vec::new();
        match windows_result {
            Ok(windows) => {
                for window in windows {
                    let attrs = window.attributes();
                    let window_title = attrs.name.unwrap_or_else(|| "<Unnamed Window>".to_string());
                    window_titles.push(window_title);
                }
            }
            Err(_e) => {
                #[cfg(debug_assertions)]
                eprintln!("[DEBUG] Failed to get windows for app '{app_title}': {_e}");
            }
        }

        println!("Application: {app_title} (PID: {pid})");
        if window_titles.is_empty() {
            println!("  (No windows found)");
        } else {
            for (i, title) in window_titles.iter().enumerate() {
                println!("  {}. {}", i + 1, title);
            }
        }
        println!();
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
    let window_title = app.name().unwrap_or_else(|| format!("Unnamed-App-{index}"));

    Ok((pid, process_name, window_title))
}

async fn detect_browser_tabs(desktop: &Desktop) -> Result<(), AutomationError> {
    info!("Attempting to detect browser tabs...");

    // Try to get the current browser window
    match desktop.get_current_browser_window().await {
        Ok(browser_window) => {
            let pid = browser_window.process_id()?;
            let attrs = browser_window.attributes();
            let title = attrs.name.unwrap_or("Unknown".to_string());

            println!("Current browser window:");
            println!("  PID: {pid}");
            println!("  Title: {title}");
            println!("  Role: {}", attrs.role);

            // Try to find all browser tabs/documents
            info!("Searching for browser tabs...");

            // Look for Document control types (common for browser content areas)
            let document_selector = computeruse::Selector::Role {
                role: "document".to_string(),
                name: None,
            };
            let document_locator = desktop.locator(document_selector);

            match document_locator
                .all(Some(std::time::Duration::from_secs(2)), None)
                .await
            {
                Ok(documents) => {
                    println!(
                        "\nFound {} document elements (potential browser tabs):",
                        documents.len()
                    );

                    for (i, doc) in documents.iter().take(5).enumerate() {
                        // Limit to first 5
                        if let Ok(doc_pid) = doc.process_id() {
                            let doc_attrs = doc.attributes();
                            let doc_title = doc_attrs.name.unwrap_or("Untitled".to_string());

                            // Check if this document belongs to a browser process
                            if is_browser_process(doc_pid) {
                                println!(
                                    "  Tab {}: PID={}, Title={}",
                                    i + 1,
                                    doc_pid,
                                    truncate_string(&doc_title, 50)
                                );
                            }
                        }
                    }
                }
                Err(e) => {
                    warn!("Failed to find document elements: {}", e);
                }
            }
        }
        Err(e) => {
            warn!("No current browser window detected: {}", e);
        }
    }

    Ok(())
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
