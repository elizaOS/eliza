// Test the new maximize_window_keyboard() method
use computeruse::Desktop;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let desktop = Desktop::new(false, true)?;
    let ui_element = desktop.open_application("Calculator")?;

    let (init_x, init_y, init_w, init_h) = ui_element.bounds()?;
    println!("Initial: {init_w}x{init_h} at ({init_x}, {init_y})");

    println!("\nCalling maximize_window_keyboard()...");
    ui_element.maximize_window_keyboard()?;

    std::thread::sleep(std::time::Duration::from_millis(500));

    let (final_x, final_y, final_w, final_h) = ui_element.bounds()?;
    println!("Final: {final_w}x{final_h} at ({final_x}, {final_y})");

    if (final_w - init_w).abs() > 100.0 {
        println!("\n✅ SUCCESS!");
    } else {
        println!("\n❌ FAILED");
    }

    Ok(())
}
