use computeruse::{Desktop, SerializableUIElement};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("UIElement Serialization & Deserialization Example");
    println!("==================================================");

    // Initialize the desktop automation
    let desktop = Desktop::new(false, false)?;

    // Get the root element (desktop)
    let root = desktop.root();

    println!("=== Direct UIElement Serialization ===");
    // Serialize UIElement directly (using our Serialize implementation)
    let json = serde_json::to_string_pretty(&root)?;
    println!("Serialized UIElement:");
    println!("{json}");

    println!("\n=== SerializableUIElement Round-trip ===");
    // Convert to SerializableUIElement and serialize
    let serializable = root.to_serializable();
    let serializable_json = serializable.to_json()?;
    println!("Serialized SerializableUIElement:");
    println!("{serializable_json}");

    // Deserialize back from JSON
    let deserialized = SerializableUIElement::from_json(&serializable_json)?;
    println!("\nDeserialized SerializableUIElement:");
    println!("Role: {}", deserialized.role);
    println!("Name: {:?}", deserialized.name);
    println!("Display Name: {}", deserialized.display_name());
    println!("Bounds: {:?}", deserialized.bounds);

    println!("\n=== Working with Collections ===");
    // Get some child elements and work with collections
    if let Ok(children) = root.children() {
        if !children.is_empty() {
            // Convert all children to serializable form
            let serializable_children: Vec<SerializableUIElement> = children
                .iter()
                .map(|child| child.to_serializable())
                .collect();

            // Serialize the collection
            let children_json = serde_json::to_string_pretty(&serializable_children)?;
            println!("Serialized children collection:");
            println!("{children_json}");

            // Deserialize the collection
            let deserialized_children: Vec<SerializableUIElement> =
                serde_json::from_str(&children_json)?;

            println!("\nDeserialized {} children:", deserialized_children.len());
            for (i, child) in deserialized_children.iter().take(3).enumerate() {
                println!("  {}: {} ({})", i + 1, child.display_name(), child.role);
            }
        }
    }

    println!("\n=== Creating SerializableUIElement from scratch ===");
    // Create a SerializableUIElement manually
    let mut custom_element = SerializableUIElement::new("Button".to_string());
    custom_element.name = Some("Click Me".to_string());
    custom_element.bounds = Some((100.0, 200.0, 80.0, 30.0));
    custom_element.window_and_application_name = Some("My App".to_string());

    let custom_json = custom_element.to_json()?;
    println!("Custom SerializableUIElement:");
    println!("{custom_json}");

    // Round-trip test
    let custom_deserialized = SerializableUIElement::from_json(&custom_json)?;
    println!(
        "Round-trip successful: {}",
        custom_deserialized.name == custom_element.name
    );

    Ok(())
}
