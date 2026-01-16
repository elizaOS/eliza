use rmcp::model::Content;
use serde_json::json;

// Import the helper function for testing
use computeruse_mcp_agent::extract_content_json;

#[test]
fn test_extract_content_json_fix() {
    // Create the same JSON as before
    let element_info = json!({
        "name": "You must scroll and read all of the text before you are allowed to click on agree below.",
        "role": "Group",
        "id": "264463",
        "suggested_selector": "Group|You must scroll and read all of the text before you are allowed to click on agree below.",
        "application": "I94 - Official Website - Google Chrome",
        "window_title": "",
        "process_id": 8548,
        "is_focused": true,
        "text": "",
        "bounds": {
            "x": 30.0,
            "y": -234.0,
            "width": 763.0,
            "height": 1010.0
        },
        "enabled": true,
        "is_selected": true,
        "is_toggled": false,
        "keyboard_focusable": true
    });

    let result_json = json!({
        "action": "click",
        "status": "success",
        "element": element_info,
        "selector_used": "some_selector",
        "timestamp": "2024-01-01T00:00:00Z"
    });

    // Create Content::json (what the tool returns)
    let content = Content::json(result_json.clone()).expect("Failed to create Content::json");

    // Use the fixed extraction function
    let extracted_content = extract_content_json(&content).expect("Failed to extract content");

    // Serialize and check for excessive escaping
    let json_string =
        serde_json::to_string_pretty(&extracted_content).expect("Failed to stringify");
    println!("Fixed extraction result:\n{json_string}");

    let backslash_count = json_string.matches('\\').count();
    println!("Backslash count: {backslash_count}");

    // Should have minimal escaping now
    assert!(
        backslash_count < 10,
        "Backslash count should be minimal: {backslash_count}"
    );

    // Verify the extracted content matches the original
    assert_eq!(
        extracted_content, result_json,
        "Extracted content should match original JSON"
    );
}

#[test]
fn test_json_double_serialization_issue() {
    // Simulate what happens in the server when a tool returns a result

    // This is similar to what build_element_info creates
    let element_info = json!({
        "name": "You must scroll and read all of the text before you are allowed to click on agree below.",
        "role": "Group",
        "id": "264463",
        "suggested_selector": "Group|You must scroll and read all of the text before you are allowed to click on agree below.",
        "application": "I94 - Official Website - Google Chrome",
        "window_title": "",
        "process_id": 8548,
        "is_focused": true,
        "text": "",
        "bounds": {
            "x": 30.0,
            "y": -234.0,
            "width": 763.0,
            "height": 1010.0
        },
        "enabled": true,
        "is_selected": true,
        "is_toggled": false,
        "keyboard_focusable": true
    });

    // This is what the click_element function creates
    let result_json = json!({
        "action": "click",
        "status": "success",
        "element": element_info,
        "selector_used": "some_selector",
        "timestamp": "2024-01-01T00:00:00Z"
    });

    // Create Content::json (what the tool returns)
    let content = Content::json(result_json).expect("Failed to create Content::json");

    // Simulate what execute_single_tool does - this causes the double serialization
    let extracted_content = serde_json::to_value(&content).expect("Failed to serialize content");

    // Print the result to see the excessive escaping
    let json_string =
        serde_json::to_string_pretty(&extracted_content).expect("Failed to stringify");
    println!("Double serialized result:\n{json_string}");

    // The issue: Check if the element info is excessively escaped
    let content_str = json_string;

    // Count backslashes - there should be way too many
    let backslash_count = content_str.matches('\\').count();
    println!("Backslash count: {backslash_count}");

    // This should fail initially, showing the issue exists
    assert!(
        backslash_count > 50,
        "Should have many backslashes to demonstrate the issue: {backslash_count}"
    );
}

#[test]
fn test_correct_serialization_approach() {
    // This demonstrates how it should be done

    let element_info = json!({
        "name": "You must scroll and read all of the text before you are allowed to click on agree below.",
        "role": "Group",
        "id": "264463"
    });

    let result_json = json!({
        "action": "click",
        "status": "success",
        "element": element_info
    });

    // Instead of serializing the Content object, we should work with the raw JSON
    let json_string = serde_json::to_string_pretty(&result_json).expect("Failed to stringify");
    println!("Correct serialization:\n{json_string}");

    let backslash_count = json_string.matches('\\').count();
    println!("Backslash count: {backslash_count}");

    // This should pass - minimal escaping
    assert!(
        backslash_count < 10,
        "Backslash count should be minimal: {backslash_count}"
    );
}
