use computeruse::Desktop;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("UIElement Deserialization Example");
    println!("=================================");

    // Initialize the desktop automation
    let desktop = Desktop::new(false, false)?;

    // Get a live element and serialize it
    let live_element = desktop.root();
    println!("=== Original Live Element ===");
    println!(
        "Element: {} ({})",
        live_element.name_or_empty(),
        live_element.role()
    );

    // Serialize to JSON
    let json = serde_json::to_string_pretty(&live_element)?;
    println!("\n=== Serialized JSON ===");
    println!("{json}");

    // Deserialize back to UIElement
    // This will find the actual element in the UI tree
    match serde_json::from_str::<computeruse::UIElement>(&json) {
        Ok(deserialized) => {
            println!("\n=== Successfully Deserialized Element ===");
            println!(
                "Element: {} ({})",
                deserialized.name_or_empty(),
                deserialized.role()
            );

            // Test property access
            println!("ID: {:?}", deserialized.id());
            println!("Bounds: {:?}", deserialized.bounds());

            // Test that operations work (since it's a live element)
            println!("\n=== Testing Element Operations ===");
            match deserialized.children() {
                Ok(children) => println!("✅ Successfully got {} children", children.len()),
                Err(e) => println!("❌ Failed to get children: {e}"),
            }

            // Test bounds access
            match deserialized.bounds() {
                Ok(bounds) => println!("✅ Bounds: {bounds:?}"),
                Err(e) => println!("❌ Failed to get bounds: {e}"),
            }
        }
        Err(e) => {
            println!("\n=== Deserialization Failed ===");
            println!("Error: {e}");
            println!("This is expected if the element no longer exists in the UI tree");
        }
    }

    // Demonstrate with a child element
    println!("\n=== Testing with Child Element ===");
    if let Ok(children) = live_element.children() {
        if let Some(child) = children.first() {
            println!(
                "Original child: {} ({})",
                child.name_or_empty(),
                child.role()
            );

            // Serialize and deserialize the child
            let child_json = serde_json::to_string_pretty(child)?;

            match serde_json::from_str::<computeruse::UIElement>(&child_json) {
                Ok(deserialized_child) => {
                    println!("✅ Successfully deserialized child!");
                    println!(
                        "Child: {} ({})",
                        deserialized_child.name_or_empty(),
                        deserialized_child.role()
                    );

                    // Test that we can interact with it
                    match deserialized_child.bounds() {
                        Ok(bounds) => println!("Child bounds: {bounds:?}"),
                        Err(e) => println!("Failed to get child bounds: {e}"),
                    }
                }
                Err(e) => {
                    println!("❌ Failed to deserialize child: {e}");
                }
            }
        }
    }

    // Test with manually created JSON (this should fail)
    println!("\n=== Testing with Non-existent Element ===");
    let manual_json = r#"
    {
        "id": "nonexistent-123",
        "role": "Button",
        "name": "Nonexistent Button",
        "bounds": [100.0, 200.0, 80.0, 30.0],
        "value": "Click me",
        "description": "A button that doesn't exist",
        "application": "Test App",
        "window_title": "Test Window"
    }"#;

    match serde_json::from_str::<computeruse::UIElement>(manual_json) {
        Ok(_) => println!("❌ Unexpectedly succeeded in deserializing non-existent element"),
        Err(e) => println!("✅ Correctly failed to deserialize non-existent element: {e}"),
    }

    println!("\n=== Summary ===");
    println!("✅ All UIElement instances are now 'live' and can perform operations");
    println!("✅ Deserialization only succeeds if the element exists in the current UI tree");
    println!("✅ No more mock elements or is_live() checks needed");

    Ok(())
}
