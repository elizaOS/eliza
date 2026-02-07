use std::time::Duration;
use computeruse::{Desktop, Selector};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize tracing
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::DEBUG)
        .init();

    println!("=== Analyzing Parent Chain ===\n");

    let desktop = Desktop::new_default()?;

    // Find the Notepad document element
    let element = desktop
        .locator(Selector::from("role:Document|name:Text editor"))
        .first(Some(Duration::from_secs(3)))
        .await?;

    println!("Starting element:");
    println!("  - Name: {:?}", element.name());
    println!("  - Role: {}", element.role());
    println!("  - ID: {:?}", element.id());
    println!();

    // Manually traverse up the parent chain
    println!("Parent chain:");
    let mut current = element.clone();
    for i in 0..20 {
        match current.parent() {
            Ok(Some(parent)) => {
                let role = parent.role();
                let name = parent.name().unwrap_or_else(|| "<no name>".to_string());
                println!("  Level {}: Role={}, Name={}", i + 1, role, name);

                // Check if this is Window or Pane
                if role == "Window" || role == "Pane" {
                    println!("    ^^^ Found {role} - this should be returned by element.window()");
                }

                current = parent;
            }
            Ok(None) => {
                println!("  Level {}: No parent (reached top)", i + 1);
                break;
            }
            Err(e) => {
                println!("  Level {}: Error getting parent: {}", i + 1, e);
                break;
            }
        }
    }

    println!();
    println!("Now testing element.window():");
    match element.window() {
        Ok(Some(window)) => {
            println!("✓ SUCCESS - Got window:");
            println!("  - Name: {:?}", window.name());
            println!("  - Role: {}", window.role());
        }
        Ok(None) => {
            println!("✗ FAILED - element.window() returned None");
        }
        Err(e) => {
            println!("✗ ERROR - element.window() error: {e}");
        }
    }

    Ok(())
}
