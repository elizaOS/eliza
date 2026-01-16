use computeruse::{AutomationError, Desktop, Selector};
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), AutomationError> {
    // Initialize tracing
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    println!("Starting script to find the 'Cursor' application and a button inside it.");

    // Create desktop automation instance
    let desktop = Desktop::new(false, false)?;

    // --- List all applications ---
    println!("\n--- Listing Running Applications ---");
    match desktop.applications() {
        Ok(apps) => {
            let app_names: Vec<String> = apps.iter().filter_map(|app| app.name()).collect();
            println!("Currently running applications: {app_names:?}");
            info!("Found {} applications", apps.len());
        }
        Err(e) => {
            error!("Failed to get applications: {}", e);
            return Err(e);
        }
    }

    // --- Find the "Cursor" application ---
    println!("\n--- Finding 'Cursor' Application ---");
    match desktop.application("Cursor") {
        Ok(cursor_app) => {
            println!("Found Cursor application object:");
            let attrs = cursor_app.attributes();
            println!("  Name: {:?}", attrs.name);
            println!("  Role: {}", attrs.role);
            if let Ok(pid) = cursor_app.process_id() {
                println!("  Process ID: {pid}");
            }

            // --- Find a button within "Cursor" using locator('role:button').first() ---
            println!("\n--- Finding a Button in 'Cursor' ---");

            // Create a role-based selector for buttons
            let button_selector = Selector::Role {
                // role: "button".to_string(),
                role: "AXButton".to_string(),
                name: None,
            };
            let locator = cursor_app.locator(button_selector)?;
            println!("Created locator for button with role 'button'");

            match locator
                .first(Some(std::time::Duration::from_secs(10)))
                .await
            {
                Ok(button) => {
                    println!("Found button object:");
                    let button_attrs = button.attributes();
                    println!("  Button Name: {:?}", button_attrs.name);
                    println!("  Button Role: {}", button_attrs.role);
                    if let Some(value) = &button_attrs.value {
                        println!("  Button Value: {value}");
                    }
                    if let Some(description) = &button_attrs.description {
                        println!("  Button Description: {description}");
                    }
                }
                Err(e) => match e {
                    AutomationError::ElementNotFound(_) => {
                        println!("No button found in Cursor application.");
                    }
                    _ => {
                        warn!("Error finding button: {}", e);
                        return Err(e);
                    }
                },
            }

            // --- Retrieve and print the entire window tree ---
            println!("\n--- Retrieving Window Tree for 'Cursor' ---");
            if let Ok(pid) = cursor_app.process_id() {
                match desktop.get_window_tree(pid, None, None) {
                    Ok(window_tree) => match serde_json::to_string_pretty(&window_tree) {
                        Ok(json) => {
                            println!("Window Tree JSON:\n{json}");
                        }
                        Err(e) => {
                            warn!("Failed to serialize window tree: {}", e);
                        }
                    },
                    Err(e) => {
                        warn!("Failed to get window tree: {}", e);
                    }
                }
            } else {
                warn!("Could not determine process ID for Cursor application");
            }

            println!("\nScript finished successfully.");
        }
        Err(e) => {
            match e {
                AutomationError::ElementNotFound(_) => {
                    error!(
                        "Error: Could not find the requested element. Is 'Cursor' running? {}",
                        e
                    );
                }
                AutomationError::PlatformError(_) => {
                    error!(
                        "Error: A platform error occurred. Is 'Cursor' running? {}",
                        e
                    );
                }
                _ => {
                    error!("An unexpected error occurred: {}", e);
                }
            }
            return Err(e);
        }
    }

    Ok(())
}
