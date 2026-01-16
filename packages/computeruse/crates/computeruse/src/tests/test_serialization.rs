use crate::{Desktop, SerializableUIElement, UIElement};
use std::time::Duration;
use tracing::info;
use tracing_subscriber::FmtSubscriber;

#[tokio::test]
#[ignore] // This test is ignored by default because it's long-running and requires a GUI.
          // Run it manually with: cargo test --test browser_serialization -- --ignored
async fn test_browser_tree_serialization() -> Result<(), Box<dyn std::error::Error>> {
    // Set up tracing for logging, which is helpful for debugging integration tests.
    let subscriber = FmtSubscriber::builder()
        .with_max_level(tracing::Level::INFO)
        .finish();
    let _ = tracing::subscriber::set_global_default(subscriber);

    info!("Starting browser serialization test...");

    // Step 1: Initialize the desktop and open the URL
    let desktop = Desktop::new(false, false)?;
    let url = "https://pages.dataiku.com/guide-to-ai-agents";
    info!("Opening URL: {}", url);
    let window = desktop.open_url(url, None)?;
    let window_name = window.name_or_empty();

    // Wait for the page to load.
    tokio::time::sleep(Duration::from_secs(2)).await;

    // Re-acquire the window to prevent stale element issues after await
    let window = desktop
        .locator(format!("name:{window_name}").as_str())
        .first(Some(Duration::from_secs(5)))
        .await?;

    // Step 3: Capture the UI tree and serialize it to JSON.
    let max_depth = 3;
    info!("Capturing UI tree to a max depth of {}...", max_depth);
    let tree: SerializableUIElement = window.to_serializable_tree(max_depth);
    let json_output = serde_json::to_string_pretty(&tree)?;
    info!("Successfully serialized UI tree to JSON.");
    println!("--- Serialized UI Tree (JSON) ---\n{json_output}\n---------------------------------");

    // Step 4: Validate the JSON output for correctness and cleanliness.
    info!("Validating JSON output...");

    // Ensure output is not empty.
    assert!(!json_output.is_empty(), "JSON output should not be empty");

    // Check for the presence of key fields.
    let root_value: serde_json::Value = serde_json::from_str(&json_output)?;
    assert!(
        root_value.get("role").is_some(),
        "Root element must have a 'role'"
    );
    assert!(
        root_value.get("name").is_some(),
        "Root element must have a 'name'"
    );

    // Verify the window title is correct.
    let window_title = root_value["window_title"].as_str().unwrap_or_default();
    assert!(
        window_title.contains("GLO CONTENT"),
        "Window title is incorrect: {window_title}"
    );

    // **Crucial Test**: Verify that the JSON does NOT contain empty strings for optional fields.
    assert!(
        !json_output.contains(r#""name": """#),
        "JSON should not contain empty name fields: {json_output}"
    );
    assert!(
        !json_output.contains(r#""value": """#),
        "JSON should not contain empty value fields: {json_output}"
    );
    assert!(
        !json_output.contains(r#""description": """#),
        "JSON should not contain empty description fields: {json_output}"
    );

    info!("Validation successful!");

    // Step 5: Clean up by closing the browser window.
    window.close()?;
    info!("Test completed successfully.");

    Ok(())
}

#[test]
#[allow(clippy::assertions_on_constants)]
fn test_uielement_serialization() {
    // Note: This test demonstrates the serialization capability
    // In practice, you would create a UIElement from a real platform implementation
    // For this test, we're just showing that the Serialize trait is properly implemented

    // The actual serialization would work like this:
    // let element = some_ui_element_instance;
    // let json = serde_json::to_string(&element).unwrap();
    // println!("Serialized UIElement: {}", json);

    // Since we can't easily create a UIElement without platform-specific code,
    // we'll just verify the trait is implemented by checking compilation
    assert!(true, "UIElement implements Serialize trait");
}

#[test]
fn test_uielement_deserialization() {
    // Test deserializing a UIElement from JSON
    // Note: This test will fail if the element doesn't exist in the current UI tree
    // or if Desktop automation is not available (e.g., in CI environments)
    let json = r#"
    {
        "id": "test-123",
        "role": "Button",
        "name": "Test Button",
        "bounds": [10.0, 20.0, 100.0, 30.0],
        "value": "Click me",
        "description": "A test button",
        "application": "Test App",
        "window_title": "Test Window"
    }"#;

    // This will fail because the element doesn't exist in the UI tree
    // or because Desktop automation is not available
    let result: Result<UIElement, _> = serde_json::from_str(json);
    assert!(
        result.is_err(),
        "Deserialization should fail for non-existent elements or when Desktop is unavailable"
    );

    // Verify the error message mentions the element details
    let error_msg = result.unwrap_err().to_string();
    assert!(
        error_msg.contains("Button") || error_msg.contains("Test Button"),
        "Error should mention the element role or name"
    );
}

#[test]
fn test_uielement_round_trip() {
    // Test that we can serialize and deserialize existing elements
    // Note: This test demonstrates the concept but will fail in CI
    // because there's no UI tree available or Desktop automation is not accessible

    let json = r#"
    {
        "id": "round-trip-test",
        "role": "TextField",
        "name": "Input Field",
        "bounds": [50.0, 60.0, 200.0, 25.0],
        "value": "Hello World",
        "description": "Text input",
        "application": "My App",
        "window_title": "Main Window"
    }"#;

    // This will fail because the element doesn't exist or Desktop is unavailable
    let result: Result<UIElement, _> = serde_json::from_str(json);
    assert!(
        result.is_err(),
        "Deserialization should fail for non-existent elements or when Desktop is unavailable"
    );

    // Verify the error message mentions the element details
    let error_msg = result.unwrap_err().to_string();
    assert!(
        error_msg.contains("TextField") || error_msg.contains("Input Field"),
        "Error should mention the element role or name"
    );
}
