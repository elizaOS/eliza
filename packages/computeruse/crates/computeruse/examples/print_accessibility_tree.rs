use computeruse::{AutomationError, Desktop};
use tracing::info;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), AutomationError> {
    // Initialize tracing (optional, for debug)
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    // Hardcoded application name
    let app_name = "Calculator";
    info!("Starting accessibility tree print for app: {}", app_name);

    // Create desktop automation instance
    let desktop = Desktop::new(false, true)?;

    // Open or get the application
    let app = desktop.application(app_name)?;

    // Build the tree as SerializableUIElement (limit depth to avoid huge output)
    let max_depth = 20;
    let tree = app.to_serializable_tree(max_depth);

    // Print the JSON tree using serde_json
    match serde_json::to_string_pretty(&tree) {
        Ok(json_str) => println!("{json_str}"),
        Err(e) => eprintln!("Failed to serialize tree to JSON: {e}"),
    }

    Ok(())
}
