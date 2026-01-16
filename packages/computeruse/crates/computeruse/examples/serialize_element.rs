use computeruse::Desktop;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("UIElement Serialization Example");
    println!("================================");

    // Initialize the desktop automation
    // Parameters: use_background_apps: bool, activate_app: bool
    let desktop = Desktop::new(false, false)?;

    // Get the root element (desktop)
    let root = desktop.root();

    // Serialize the root element to JSON
    let json = serde_json::to_string_pretty(&root)?;
    println!("Serialized root element:");
    println!("{json}");

    // Get some child elements and serialize them
    if let Ok(children) = root.children() {
        if !children.is_empty() {
            println!("\nSerializing first child element:");
            let first_child_json = serde_json::to_string_pretty(&children[0])?;
            println!("{first_child_json}");
        }
    }

    // Example of serializing to a compact format
    let compact_json = serde_json::to_string(&root)?;
    println!("\nCompact JSON format:");
    println!("{compact_json}");

    // Example of serializing a collection of elements
    if let Ok(children) = root.children() {
        let children_json = serde_json::to_string_pretty(&children)?;
        println!("\nSerialized children collection:");
        println!("{children_json}");
    }

    Ok(())
}
