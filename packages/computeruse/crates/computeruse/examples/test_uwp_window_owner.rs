// Investigate UWP window ownership
use computeruse::Desktop;

#[cfg(not(target_os = "windows"))]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    eprintln!("This example is currently Windows-only.");
    Ok(())
}

#[cfg(target_os = "windows")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("🔍 Investigating UWP window ownership...\n");

    let desktop = Desktop::new(false, true)?;
    let ui_element = desktop.open_application("Calculator")?;

    let calc_pid = ui_element.process_id().unwrap_or(0);
    println!("Calculator content PID: {calc_pid}");
    println!("Calculator title: {}", ui_element.window_title());

    // Try to get the window element
    if let Ok(Some(window)) = ui_element.window() {
        let window_pid = window.process_id().unwrap_or(0);
        println!("\nWindow element PID: {window_pid}");
        println!("Window element name: {}", window.name_or_empty());

        // Get process name
        if let Ok(process_name) = computeruse::get_process_name_by_pid(window_pid as i32) {
            println!("Window process name: {process_name}");
        }
    } else {
        println!("\n❌ Could not get window element");
    }

    Ok(())
}
