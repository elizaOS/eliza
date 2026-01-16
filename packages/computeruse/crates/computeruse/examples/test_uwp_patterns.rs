// Test what patterns Calculator supports
use computeruse::Desktop;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("🔍 Testing UWP patterns support...\n");

    let desktop = Desktop::new(false, true)?;
    let ui_element = desktop.open_application("Calculator")?;

    println!("📱 Calculator opened");
    println!("   PID: {}", ui_element.process_id().unwrap_or(0));
    println!("   Title: {}", ui_element.window_title());

    // Get initial bounds
    if let Ok((x, y, width, height)) = ui_element.bounds() {
        println!("\n📏 Initial bounds: x:{x}, y:{y}, width:{width}, height:{height}");
    }

    // Try different approaches
    println!("\n🔬 Testing maximize approaches:");

    // 1. WindowPattern maximize (we know this doesn't work)
    println!("\n1️⃣ WindowPattern.SetWindowVisualState(Maximized):");
    match ui_element.maximize_window() {
        Ok(_) => println!("   ✓ Call succeeded (but may not actually maximize)"),
        Err(e) => println!("   ✗ Failed: {e}"),
    }

    std::thread::sleep(std::time::Duration::from_millis(500));

    if let Ok((x, y, width, height)) = ui_element.bounds() {
        println!("   Bounds after: x:{x}, y:{y}, width:{width}, height:{height}");
    }

    println!("\n✨ Test complete!");
    Ok(())
}
