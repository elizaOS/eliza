use crate::{
    platforms::windows::{generate_element_id, WindowsUIElement},
    AutomationError, Desktop, Selector, UIElement,
};
use std::process::Command;
use std::thread;
use std::time::Duration;

struct NotepadGuard(std::process::Child);

impl Drop for NotepadGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
        // Just in case kill failed, run taskkill
        let _ = Command::new("taskkill")
            .args(["/F", "/IM", "notepad.exe"])
            .output();
    }
}

fn setup_notepad() -> (NotepadGuard, Desktop, UIElement) {
    // Ensure notepad is closed first
    let _ = Command::new("taskkill")
        .args(["/F", "/IM", "notepad.exe"])
        .output();
    thread::sleep(Duration::from_millis(500));

    // Start notepad
    let child = Command::new("notepad.exe")
        .spawn()
        .expect("Failed to start Notepad");
    thread::sleep(Duration::from_millis(1000)); // Wait for notepad to open

    let desktop = Desktop::new(false, false).unwrap();
    // The window title can be localized. Let's find it by process name which is more reliable.
    let notepad_app = desktop
        .engine
        .get_application_by_name("notepad")
        .expect("Failed to get Notepad application");

    // Type something to make sure the window is active and ready.
    notepad_app
        .type_text("hello", false)
        .expect("Failed to type in Notepad");

    (NotepadGuard(child), desktop, notepad_app)
}

/// This test verifies that our current `generate_element_id` function produces a stable ID
/// even when the application is restarted. This is a rigorous regression test to ensure
/// that IDs for core elements remain deterministic across sessions.
///
/// It works by:
/// 1. Launching Notepad, finding the main document element, and getting its hash.
/// 2. Closing Notepad completely.
/// 3. Launching Notepad again, finding the element, and getting a second hash.
/// 4. Asserting that the hashes are EQUAL, proving the ID is stable across sessions.
#[tokio::test]
#[ignore] // This test interacts with the UI and should be run manually.
async fn test_element_id_stability_across_restarts() -> Result<(), AutomationError> {
    let get_notepad_document_hash = || -> Result<usize, AutomationError> {
        let (_guard, desktop, notepad_app) = setup_notepad();
        let document_selector = Selector::Role {
            role: "document".to_string(),
            name: None,
        };
        let doc_element =
            desktop
                .engine
                .find_element(&document_selector, Some(&notepad_app), None)?;
        let doc_impl = doc_element
            .as_any()
            .downcast_ref::<WindowsUIElement>()
            .ok_or_else(|| {
                AutomationError::PlatformError("Failed to downcast UIElement".to_string())
            })?;
        generate_element_id(&doc_impl.element.0)
    };

    // 1. Get first hash. `_guard` from `setup_notepad` will close Notepad when it goes out of scope.
    let hash1 = get_notepad_document_hash()?;

    // Wait a moment for the process to terminate fully.
    thread::sleep(Duration::from_millis(500));

    // 2. Get second hash from a new Notepad instance.
    let hash2 = get_notepad_document_hash()?;

    // 3. Assert that the hash is stable across restarts.
    assert_eq!(
        hash1, hash2,
        "The element ID should be stable when the application is restarted. If this fails, a regression has occurred."
    );

    Ok(())
}
