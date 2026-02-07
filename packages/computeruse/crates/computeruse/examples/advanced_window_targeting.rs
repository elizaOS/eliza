use std::collections::HashMap;
use computeruse::{AutomationError, Desktop};

#[tokio::main]
async fn main() -> Result<(), AutomationError> {
    // Initialize tracing
    tracing_subscriber::fmt().with_env_filter("info").init();

    println!("Advanced Window Targeting Example");
    println!("=================================\n");

    // Create desktop automation instance
    let desktop = Desktop::new(false, false)?;

    // Get all applications and organize by PID
    let applications = desktop.applications()?;
    let mut apps_by_pid: HashMap<u32, Vec<String>> = HashMap::new();

    println!("Available applications:");
    for app in &applications {
        if let Ok(pid) = app.process_id() {
            let attrs = app.attributes();
            let name = attrs.name.unwrap_or_else(|| "Unnamed".to_string());

            apps_by_pid.entry(pid).or_default().push(name.clone());

            #[cfg(target_os = "windows")]
            {
                use computeruse::platforms::windows::get_process_name_by_pid;
                let process_name =
                    get_process_name_by_pid(pid as i32).unwrap_or_else(|_| "Unknown".to_string());
                println!("  PID {pid}: {process_name} - {name}");
            }

            #[cfg(not(target_os = "windows"))]
            {
                println!("  PID {}: {}", pid, name);
            }
        }
    }

    // Find browser processes for demonstration
    println!("\n=== Browser Process Examples ===");
    for (pid, windows) in &apps_by_pid {
        if is_browser_process(*pid) {
            #[cfg(target_os = "windows")]
            {
                use computeruse::platforms::windows::get_process_name_by_pid;
                let process_name =
                    get_process_name_by_pid(*pid as i32).unwrap_or_else(|_| "Unknown".to_string());
                println!("\nBrowser found - {process_name} (PID: {pid})");
            }

            #[cfg(not(target_os = "windows"))]
            {
                println!("\nBrowser found - PID: {}", pid);
            }

            for (i, window) in windows.iter().enumerate() {
                println!("  Window {}: {}", i + 1, truncate_string(window, 70));
            }

            // Demonstrate the new functionality
            demonstrate_window_targeting(&desktop, *pid, windows).await?;
        }
    }

    Ok(())
}

async fn demonstrate_window_targeting(
    desktop: &Desktop,
    pid: u32,
    windows: &[String],
) -> Result<(), AutomationError> {
    if windows.is_empty() {
        return Ok(());
    }

    println!("\n  --- Window Targeting Examples for PID {pid} ---");

    // Example 1: Get window tree by PID only (no title filter)
    println!("  1. Getting window tree by PID only...");
    match desktop.get_window_tree(pid, None, None) {
        Ok(tree) => {
            println!(
                "     ✓ Successfully got window tree ({}+ elements)",
                count_tree_elements(&tree)
            );
        }
        Err(e) => {
            println!("     ✗ Failed: {e}");
        }
    }

    // Example 2: Get window tree by PID + specific title
    if let Some(first_window_title) = windows.first() {
        // Extract a meaningful part of the title for targeting
        let title_part = extract_meaningful_title_part(first_window_title);
        println!("  2. Getting window tree by PID + title filter '{title_part}'...");

        match desktop.get_window_tree(pid, Some(&title_part), None) {
            Ok(tree) => {
                println!(
                    "     ✓ Successfully got specific window tree ({}+ elements)",
                    count_tree_elements(&tree)
                );
            }
            Err(e) => {
                println!("     ✗ Failed: {e}");
            }
        }
    }

    // Example 3: Try with non-existent title (should fall back to PID)
    println!("  3. Getting window tree with non-existent title (fallback test)...");
    match desktop.get_window_tree(pid, Some("NonExistentTitle12345"), None) {
        Ok(tree) => {
            println!(
                "     ✓ Successfully fell back to PID-based selection ({}+ elements)",
                count_tree_elements(&tree)
            );
        }
        Err(e) => {
            println!("     ✗ Failed: {e}");
        }
    }

    // Example 4: Compare with traditional title-only approach
    if let Some(first_window_title) = windows.first() {
        let title_part = extract_meaningful_title_part(first_window_title);
        println!("  4. Comparing with traditional title-only approach...");

        match desktop.get_window_tree(0, Some(&title_part), None) {
            Ok(tree) => {
                println!(
                    "     ✓ Title-only approach worked ({}+ elements)",
                    count_tree_elements(&tree)
                );
            }
            Err(e) => {
                println!("     ✗ Title-only approach failed: {e}");
                println!("       (This shows why PID+title approach is more reliable)");
            }
        }
    }

    Ok(())
}

fn extract_meaningful_title_part(title: &str) -> String {
    // Extract a meaningful part from browser titles
    // Remove common browser suffixes and get a unique part
    let title = title
        .replace(" — Mozilla Firefox", "")
        .replace(" - Google Chrome", "")
        .replace(" - Microsoft Edge", "")
        .replace("- YouTube", "");

    // Get first few words or characters that would be unique
    let words: Vec<&str> = title.split_whitespace().collect();
    if words.len() > 2 {
        words[0..2].join(" ")
    } else if !words.is_empty() {
        words[0].to_string()
    } else {
        title.chars().take(10).collect()
    }
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

fn count_tree_elements(node: &computeruse::UINode) -> usize {
    1 + node.children.iter().map(count_tree_elements).sum::<usize>()
}

fn truncate_string(s: &str, max_len: usize) -> String {
    if s.len() <= max_len {
        s.to_string()
    } else {
        format!("{}...", &s[..max_len.saturating_sub(3)])
    }
}
