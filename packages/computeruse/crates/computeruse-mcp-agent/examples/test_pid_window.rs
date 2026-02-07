use std::time::Duration;
use computeruse::{Desktop, Selector};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize tracing
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::DEBUG)
        .init();

    println!("=== Testing PID-Based Window Lookup ===\n");

    let desktop = Desktop::new_default()?;

    // Find the Notepad document element
    let element = desktop
        .locator(Selector::from("role:Document|name:Text editor"))
        .first(Some(Duration::from_secs(3)))
        .await?;

    println!("✓ Found element:");
    println!("  - Name: {:?}", element.name());
    println!("  - Role: {}", element.role());
    let pid = element.process_id()?;
    println!("  - PID: {pid}");
    println!();

    // Test 1: element.window() (we know this returns None)
    println!("Test 1: element.window()");
    match element.window() {
        Ok(Some(w)) => println!("  ✓ Got window: {:?} (role: {})", w.name(), w.role()),
        Ok(None) => println!("  ✗ Returned None"),
        Err(e) => println!("  ✗ Error: {e}"),
    }
    println!();

    // Test 2: element.application() (PID-based lookup)
    println!("Test 2: element.application() (PID-based lookup)");
    match element.application() {
        Ok(Some(app)) => {
            println!("  ✓ Got application window:");
            println!("    - Name: {:?}", app.name());
            println!("    - Role: {}", app.role());
            println!("    - PID: {:?}", app.process_id());
            println!();

            // Test 3: Now try window-scoped search using this!
            println!("Test 3: Window-scoped search using application window...");
            let locator = desktop
                .locator(Selector::from("text:Check logs now"))
                .within(app.clone());

            match locator.wait(Some(Duration::from_millis(1000))).await {
                Ok(found) => {
                    println!("  ✓ SUCCESS! Found element:");
                    println!("    - Name: {:?}", found.name());
                    println!("    - Text: {:?}", found.text(0));
                }
                Err(e) => {
                    println!("  ✗ FAILED: {e}");
                }
            }
        }
        Ok(None) => println!("  ✗ Returned None"),
        Err(e) => println!("  ✗ Error: {e}"),
    }

    Ok(())
}
