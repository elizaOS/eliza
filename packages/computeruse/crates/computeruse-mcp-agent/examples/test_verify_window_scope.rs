use std::time::Duration;
use computeruse::{Desktop, Selector};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize tracing for detailed debug output
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::DEBUG)
        .with_target(true)
        .with_line_number(true)
        .init();

    println!("=== Testing Window-Scoped Verification ===\n");

    let desktop = Desktop::new_default()?;

    // Find the Notepad document element
    let element = desktop
        .locator(Selector::from("role:Document|name:Text editor"))
        .first(Some(Duration::from_secs(3)))
        .await?;

    println!("✓ Found element:");
    println!("  - Name: {:?}", element.name());
    println!("  - Role: {}", element.role());
    println!("  - PID: {:?}", element.process_id());
    println!();

    // Test 1: Try to get the window
    println!("Test 1: Getting window element...");
    match element.window() {
        Ok(Some(window)) => {
            println!("✓ Got window element:");
            println!("  - Name: {:?}", window.name());
            println!("  - Role: {}", window.role());
            println!("  - ID: {:?}", window.id());
            println!();

            // Test 2: Try window-scoped search
            println!("Test 2: Window-scoped search for 'text:Check logs now'...");
            let locator = desktop
                .locator(Selector::from("text:Check logs now"))
                .within(window.clone());

            match locator.wait(Some(Duration::from_millis(500))).await {
                Ok(found) => {
                    println!("✓ Window-scoped search SUCCESS!");
                    println!("  - Found: {:?}", found.name());
                    println!("  - Text: {:?}", found.text(0));
                }
                Err(e) => {
                    println!("✗ Window-scoped search FAILED: {e}");
                }
            }
            println!();

            // Test 3: Desktop-wide search (for comparison)
            println!("Test 3: Desktop-wide search for 'text:Check logs now'...");
            let locator = desktop.locator(Selector::from("text:Check logs now"));

            match locator.wait(Some(Duration::from_millis(500))).await {
                Ok(found) => {
                    println!("✓ Desktop-wide search SUCCESS!");
                    println!("  - Found: {:?}", found.name());
                    println!("  - Text: {:?}", found.text(0));
                }
                Err(e) => {
                    println!("✗ Desktop-wide search FAILED: {e}");
                }
            }
        }
        Ok(None) => {
            println!("✗ element.window() returned None (no window found in parent chain)");
        }
        Err(e) => {
            println!("✗ element.window() returned Error: {e}");
        }
    }

    Ok(())
}
