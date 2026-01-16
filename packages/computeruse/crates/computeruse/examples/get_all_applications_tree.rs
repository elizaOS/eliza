use std::time::Instant;

use computeruse::{AutomationError, Desktop};

#[tokio::main]
async fn main() -> Result<(), AutomationError> {
    // Initialize the logger to see output from the library.
    tracing_subscriber::fmt::init();

    println!("Getting all application trees. This might take a moment...");

    // log how long it takes to get all application trees
    let start_time = Instant::now();

    let desktop = Desktop::new_default()?;

    let app_trees = desktop.get_all_applications_tree().await?;

    if app_trees.is_empty() {
        println!("No application trees could be retrieved.");
    } else {
        println!("\nFound {} application trees:", app_trees.len());
        for (i, tree) in app_trees.iter().enumerate() {
            println!("\n----- Tree {} -----", i + 1);
            // Using debug print for a detailed view of the UINode struct.
            println!("{tree:#?}");
        }
    }

    println!("\nExample finished successfully.");
    println!("Time taken: {:?}", start_time.elapsed());
    Ok(())
}
