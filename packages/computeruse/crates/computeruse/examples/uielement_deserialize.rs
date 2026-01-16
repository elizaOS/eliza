use computeruse::Desktop;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("UIElement Deserialization Example");
    println!("=================================");

    // Initialize the desktop automation
    let desktop = Desktop::new(false, false)?;

    // Get the root element and serialize it
    let root_element = desktop.root();
    println!(
        "Root element: {} ({})",
        root_element.name_or_empty(),
        root_element.role()
    );

    // Serialize to JSON
    let json = serde_json::to_string_pretty(&root_element)?;
    println!("\nSerialized JSON:");
    println!("{json}");

    // Deserialize back to UIElement
    // This will find the actual element in the current UI tree
    println!("\nAttempting to deserialize...");
    match serde_json::from_str::<computeruse::UIElement>(&json) {
        Ok(deserialized) => {
            println!("✅ Successfully deserialized!");
            println!(
                "Deserialized element: {} ({})",
                deserialized.name_or_empty(),
                deserialized.role()
            );

            // Verify properties match
            println!("\nProperty verification:");
            println!("Original ID: {:?}", root_element.id());
            println!("Deserialized ID: {:?}", deserialized.id());
            println!("Original role: {}", root_element.role());
            println!("Deserialized role: {}", deserialized.role());

            // Test that we can perform operations
            println!("\nTesting operations:");
            match deserialized.children() {
                Ok(children) => println!("✅ Got {} children", children.len()),
                Err(e) => println!("❌ Failed to get children: {e}"),
            }

            match deserialized.bounds() {
                Ok(bounds) => println!("✅ Bounds: {bounds:?}"),
                Err(e) => println!("❌ Failed to get bounds: {e}"),
            }
        }
        Err(e) => {
            println!("❌ Deserialization failed: {e}");
            println!("This can happen if the UI tree has changed since serialization");
        }
    }

    // Example with a non-existent element
    println!("\n=== Testing Non-existent Element ===");
    let fake_json = r#"
    {
        "id": "fake-element-123",
        "role": "Button",
        "name": "Fake Button",
        "bounds": [0.0, 0.0, 100.0, 30.0],
        "value": null,
        "description": null,
        "application": "Fake App",
        "window_title": "Fake Window"
    }"#;

    match serde_json::from_str::<computeruse::UIElement>(fake_json) {
        Ok(_) => println!("❌ Unexpectedly succeeded with fake element"),
        Err(e) => println!("✅ Correctly failed with fake element: {e}"),
    }

    println!("\n=== Key Points ===");
    println!("• All UIElement instances are 'live' and can perform operations");
    println!("• Deserialization only works if the element exists in the current UI tree");
    println!("• Elements are found by ID first, then by role+name+bounds");
    println!("• No need for is_live() checks or find_live() methods");

    Ok(())
}
