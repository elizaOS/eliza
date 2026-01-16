// Test if we can maximize Calculator (UWP app) using UI Automation

use computeruse::Desktop;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("🧪 Testing UWP window maximize...\n");

    // Initialize desktop
    let desktop = Desktop::new(false, true)?; // use_background_apps=false, activate_app=true
    println!("✅ Desktop initialized");

    // Open Calculator
    println!("📱 Opening Calculator...");
    let ui_element = desktop.open_application("Calculator")?;
    println!("✅ Calculator opened");

    // Get process info
    let pid = ui_element.process_id().unwrap_or(0);
    let window_title = ui_element.window_title();
    println!("   PID: {pid}");
    println!("   Window: {window_title}");

    // Get initial bounds
    if let Ok((x, y, width, height)) = ui_element.bounds() {
        println!("\n📏 Initial bounds:");
        println!("   x: {x}, y: {y}, width: {width}, height: {height}");
    }

    // Try to maximize using UI Automation
    println!("\n🔄 Attempting to maximize via UI Automation...");
    match ui_element.maximize_window() {
        Ok(_) => {
            println!("✅ maximize_window() call succeeded");
        }
        Err(e) => {
            println!("❌ maximize_window() failed: {e}");
            return Err(e.into());
        }
    }

    // Wait a moment for window to update
    std::thread::sleep(std::time::Duration::from_millis(500));

    // Get final bounds
    if let Ok((x, y, width, height)) = ui_element.bounds() {
        println!("\n📏 Final bounds:");
        println!("   x: {x}, y: {y}, width: {width}, height: {height}");
    }

    println!("\n✨ Test complete! Check if Calculator is maximized.");

    Ok(())
}
