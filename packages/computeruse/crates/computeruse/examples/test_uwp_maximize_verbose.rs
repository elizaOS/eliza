// Test if Win32 ShowWindow works with verbose output
use computeruse::Desktop;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("🧪 Testing UWP window maximize with verbose output...\n");

    let desktop = Desktop::new(false, true)?;
    let ui_element = desktop.open_application("Calculator")?;

    let pid = ui_element.process_id().unwrap_or(0);
    println!("Calculator PID: {pid}");

    // Get initial bounds
    let (init_x, init_y, init_w, init_h) = ui_element.bounds()?;
    println!("Initial bounds: {init_w}x{init_h} at ({init_x}, {init_y})");

    // Call maximize
    println!("\nCalling maximize_window()...");
    ui_element.maximize_window()?;
    println!("maximize_window() returned Ok");

    // Wait
    std::thread::sleep(std::time::Duration::from_millis(1000));

    // Get final bounds
    let (final_x, final_y, final_w, final_h) = ui_element.bounds()?;
    println!("\nFinal bounds: {final_w}x{final_h} at ({final_x}, {final_y})");

    // Check if it actually maximized
    let _screen_width = 1920; // Typical
    let changed = (final_w - init_w).abs() > 100.0 || (final_h - init_h).abs() > 100.0;

    if changed {
        println!("\n✅ SUCCESS: Window bounds changed significantly!");
        println!(
            "   Width: {} → {} (Δ{})",
            init_w,
            final_w,
            final_w as i32 - init_w as i32
        );
        println!(
            "   Height: {} → {} (Δ{})",
            init_h,
            final_h,
            final_h as i32 - init_h as i32
        );
    } else {
        println!("\n❌ FAILED: Window bounds did NOT change significantly");
        println!(
            "   Width: {} → {} (Δ{})",
            init_w,
            final_w,
            final_w as i32 - init_w as i32
        );
        println!(
            "   Height: {} → {} (Δ{})",
            init_h,
            final_h,
            final_h as i32 - init_h as i32
        );
    }

    Ok(())
}
