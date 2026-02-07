use crate::Selector;

#[cfg(target_os = "windows")]
#[tokio::test]
async fn test_open_notepad_and_type() {
    use crate::Desktop;
    use std::time::Duration;
    use tokio::time::sleep;

    // Create desktop instance with default settings
    let desktop = Desktop::new_default().expect("Failed to create Desktop instance");

    // Open Notepad (this is synchronous)
    let notepad_result = desktop.open_application("notepad");
    assert!(
        notepad_result.is_ok(),
        "Failed to open Notepad: {:?}",
        notepad_result.err()
    );

    // Wait for Notepad to fully load
    sleep(Duration::from_millis(1500)).await;

    // Find Notepad window using process with AND for additional filters
    let window_selector = Selector::from("process:notepad && name:Notepad");
    let notepad_window = desktop
        .locator(window_selector)
        .first(Some(Duration::from_secs(5)))
        .await;

    assert!(
        notepad_window.is_ok(),
        "Failed to find Notepad window: {:?}",
        notepad_window.err()
    );

    let window = notepad_window.unwrap();

    // Find the text editor element (Document or Edit role)
    let editor_selector = Selector::from("role:Document || role:Edit");
    let editor = window
        .locator(editor_selector)
        .expect("Failed to create locator")
        .first(Some(Duration::from_secs(2)))
        .await;

    assert!(
        editor.is_ok(),
        "Failed to find text editor: {:?}",
        editor.err()
    );

    let text_editor = editor.unwrap();

    // Type text into Notepad (use_clipboard = false for direct typing)
    let text = "Hello, World! This is a Rust integration test.";
    let type_result = text_editor.type_text(text, false);

    assert!(
        type_result.is_ok(),
        "Failed to type text: {:?}",
        type_result.err()
    );

    // Wait a moment to see the text
    sleep(Duration::from_millis(500)).await;

    // Verify text was typed by getting the value
    let value_result = text_editor.get_value();
    if let Ok(Some(typed_value)) = value_result {
        assert!(
            typed_value.contains("Hello, World!"),
            "Expected text not found in editor. Got: {typed_value}"
        );
    }

    // Clean up: Close Notepad without saving
    // Send Alt+F4 to close
    let close_result = desktop.press_key("{Alt}{F4}").await;
    assert!(close_result.is_ok(), "Failed to send Alt+F4");

    sleep(Duration::from_millis(500)).await;

    // If "Save changes" dialog appears, press "Don't Save" (N key)
    let dialog_selector = Selector::from("process:notepad && name:Notepad");
    if desktop
        .locator(dialog_selector)
        .first(Some(Duration::from_millis(500)))
        .await
        .is_ok()
    {
        let _ = desktop.press_key("n").await;
        sleep(Duration::from_millis(500)).await;
    }

    println!("✅ Notepad integration test passed!");
}

#[test]
fn test_window_and_name_notepad() {
    // Test the exact selector pattern we're using
    let sel = Selector::from("role:Window && name:Notepad");
    match sel {
        Selector::And(v) => {
            assert_eq!(v.len(), 2);
            match &v[0] {
                Selector::Role { role, name } => {
                    assert_eq!(role, "Window");
                    assert_eq!(*name, None);
                }
                _ => panic!("Expected Role selector for Window, got: {:?}", v[0]),
            }
            match &v[1] {
                Selector::Name(n) => {
                    assert_eq!(n, "Notepad");
                }
                _ => panic!("Expected Name selector, got: {:?}", v[1]),
            }
        }
        _ => panic!("Expected And selector, got: {sel:?}"),
    }
}

#[test]
fn test_document_or_edit() {
    let sel = Selector::from("role:Document || role:Edit");
    match sel {
        Selector::Or(v) => {
            assert_eq!(v.len(), 2);
            match &v[0] {
                Selector::Role { role, name } => {
                    assert_eq!(role, "Document");
                    assert_eq!(*name, None);
                }
                _ => panic!("Expected Role selector for Document, got: {:?}", v[0]),
            }
            match &v[1] {
                Selector::Role { role, name } => {
                    assert_eq!(role, "Edit");
                    assert_eq!(*name, None);
                }
                _ => panic!("Expected Role selector for Edit, got: {:?}", v[1]),
            }
        }
        _ => panic!("Expected Or selector, got: {sel:?}"),
    }
}

#[test]
fn test_chain_with_window_selector() {
    // Test the chain selector pattern: process >> (window && name) >> element
    let sel = Selector::from("process:notepad >> (role:Window && name:Notepad) >> role:Document");
    match sel {
        Selector::Chain(parts) => {
            assert_eq!(parts.len(), 3);
            // First part should be Process
            match &parts[0] {
                Selector::Process(process) => {
                    assert_eq!(process, "notepad");
                }
                _ => panic!(
                    "Expected Process selector in chain first part, got: {:?}",
                    parts[0]
                ),
            }
            // Second part should be And (Window && name:Notepad)
            match &parts[1] {
                Selector::And(v) => {
                    assert_eq!(v.len(), 2);
                }
                _ => panic!(
                    "Expected And selector in chain second part, got: {:?}",
                    parts[1]
                ),
            }
            // Third part should be Role (Document)
            match &parts[2] {
                Selector::Role { role, name } => {
                    assert_eq!(role, "Document");
                    assert_eq!(*name, None);
                }
                _ => panic!(
                    "Expected Role selector in chain third part, got: {:?}",
                    parts[2]
                ),
            }
        }
        _ => panic!("Expected Chain selector, got: {sel:?}"),
    }
}
