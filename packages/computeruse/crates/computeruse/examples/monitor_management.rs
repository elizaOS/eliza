use computeruse::{AutomationError, Desktop};

#[tokio::main]
async fn main() -> Result<(), AutomationError> {
    let desktop = Desktop::new_default()?;

    println!("=== Monitor Management Example ===\n");

    // List all monitors
    println!("📺 Available Monitors:");
    let monitors = desktop.list_monitors().await?;
    for (index, monitor) in monitors.iter().enumerate() {
        println!(
            "  {}. {} ({}x{}) at ({}, {}) - Scale: {:.2}x{}",
            index + 1,
            monitor.name,
            monitor.width,
            monitor.height,
            monitor.x,
            monitor.y,
            monitor.scale_factor,
            if monitor.is_primary { " [PRIMARY]" } else { "" }
        );
    }

    // Get the primary monitor
    println!("\n🎯 Primary Monitor:");
    let primary = desktop.get_primary_monitor().await?;
    println!(
        "  {} ({}x{}) at ({}, {})",
        primary.name, primary.width, primary.height, primary.x, primary.y
    );

    // Get the active monitor (containing focused window)
    println!("\n🔍 Active Monitor (with focused window):");
    let active = desktop.get_active_monitor().await?;
    println!(
        "  {} ({}x{}) at ({}, {})",
        active.name, active.width, active.height, active.x, active.y
    );

    // Capture screenshots of all monitors
    println!("\n📸 Capturing all monitors...");
    let screenshots = desktop.capture_all_monitors().await?;
    for (monitor, screenshot) in screenshots {
        println!(
            "  Captured {} - {}x{} pixels ({} bytes)",
            monitor.name,
            screenshot.width,
            screenshot.height,
            screenshot.image_data.len()
        );

        // Check if the screenshot has monitor metadata
        if let Some(meta_monitor) = &screenshot.monitor {
            println!("    Monitor metadata: {}", meta_monitor.name);
        }
    }

    // Demonstrate getting monitor by name
    if !monitors.is_empty() {
        let first_monitor_name = &monitors[0].name;
        println!("\n🔍 Getting monitor by name: '{first_monitor_name}'");
        let monitor_by_name = desktop.get_monitor_by_name(first_monitor_name).await?;
        println!(
            "  Found: {} ({}x{})",
            monitor_by_name.name, monitor_by_name.width, monitor_by_name.height
        );

        // Capture specific monitor
        println!("\n📸 Capturing specific monitor: '{first_monitor_name}'");
        let specific_screenshot = desktop.capture_monitor(&monitor_by_name).await?;
        println!(
            "  Captured {}x{} pixels ({} bytes)",
            specific_screenshot.width,
            specific_screenshot.height,
            specific_screenshot.image_data.len()
        );
    }

    // Demonstrate monitor utility methods
    if monitors.len() > 1 {
        println!("\n🧮 Monitor Utility Methods:");
        let first_monitor = &monitors[0];
        let (center_x, center_y) = first_monitor.center();
        println!(
            "  Center of '{}': ({}, {})",
            first_monitor.name, center_x, center_y
        );

        // Check if center point is contained within the monitor
        let contains_center = first_monitor.contains_point(center_x, center_y);
        println!("  Monitor contains its center point: {contains_center}");
    }

    println!("\n✅ Monitor management example completed!");

    Ok(())
}
