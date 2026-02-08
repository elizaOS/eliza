use std::time::Duration;
use computeruse::Desktop;
use computeruse_workflow_recorder::{WorkflowEvent, WorkflowRecorder, WorkflowRecorderConfig};
use tokio_stream::StreamExt;

/// End-to-end integration test for text input completion feature
/// This test actually opens Notepad, types text using ComputerUse SDK,
/// and verifies that both individual keyboard events and high-level
/// text input completion events are captured correctly.
#[tokio::test]
#[ignore] // Run with: cargo test test_e2e_text_input_completion -- --ignored --nocapture
async fn test_e2e_text_input_completion() {
    println!("\n🚀 Starting End-to-End Text Input Completion Integration Test");
    println!("==============================================================");

    // Step 1: Initialize the workflow recorder with text input completion enabled
    let config = WorkflowRecorderConfig {
        record_text_input_completion: true,
        capture_ui_elements: true,
        record_keyboard: true,
        record_mouse: true,
        record_clipboard: false, // Disable to reduce noise
        record_hotkeys: false,   // Disable to reduce noise
        track_modifier_states: true,
        ..Default::default()
    };

    let mut recorder = WorkflowRecorder::new("E2E Text Input Test".to_string(), config);
    let mut event_stream = recorder.event_stream();

    println!("✅ Workflow recorder initialized");

    // Step 2: Start recording
    println!("🎬 Starting recording...");
    recorder.start().await.expect("Failed to start recording");

    // Give the recorder a moment to start
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Step 3: Initialize ComputerUse Desktop for automation
    println!("🖥️  Initializing ComputerUse Desktop...");
    let desktop = Desktop::new(false, false).expect("Failed to create Desktop");

    // Step 4: Open Notepad
    println!("📝 Opening Notepad...");
    let _notepad_app = desktop
        .open_application("notepad.exe")
        .expect("Failed to open Notepad");

    // Wait for Notepad to fully load
    tokio::time::sleep(Duration::from_millis(2000)).await;

    // Step 5: Find the text editor element
    println!("🔍 Finding text editor element...");
    let locator = desktop.locator("role:Edit");
    let text_editor = locator
        .first(Some(Duration::from_secs(10)))
        .await
        .expect("Failed to find text editor in Notepad");

    // Step 6: Type some text using ComputerUse SDK
    println!("⌨️  Typing first text: 'Hello World'");
    text_editor
        .type_text("Hello World", false)
        .expect("Failed to type text");

    // Wait a bit for text input completion to trigger
    tokio::time::sleep(Duration::from_millis(2000)).await;

    // Step 7: Type more text after a pause
    println!("⌨️  Typing second text: ' from ComputerUse!'");
    text_editor
        .type_text(" from ComputerUse!", false)
        .expect("Failed to type second text");

    // Wait for second text input completion
    tokio::time::sleep(Duration::from_millis(2000)).await;

    // Step 8: Press Enter and type another line
    println!("↵ Pressing Enter and typing new line");
    text_editor
        .press_key("{Enter}")
        .expect("Failed to press Enter");

    text_editor
        .type_text("This is line 2", false)
        .expect("Failed to type third text");

    // Wait for third text input completion
    tokio::time::sleep(Duration::from_millis(2000)).await;

    // Step 9: Stop recording
    println!("⏹️  Stopping recording...");
    recorder.stop().await.expect("Failed to stop recording");

    // Give a moment for final events to be processed
    tokio::time::sleep(Duration::from_millis(1000)).await;

    // Step 10: Collect and analyze captured events
    println!("📊 Analyzing captured events...");
    let mut captured_events = Vec::new();
    let mut timeout_count = 0;
    const MAX_TIMEOUTS: usize = 10; // Allow up to 10 empty reads before stopping

    while timeout_count < MAX_TIMEOUTS {
        tokio::select! {
            event = event_stream.next() => {
                if let Some(event) = event {
                    captured_events.push(event);
                    timeout_count = 0; // Reset timeout counter
                } else {
                    break; // Stream ended
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(100)) => {
                timeout_count += 1;
            }
        }
    }

    println!("📈 Total events captured: {}", captured_events.len());

    // Step 11: Analyze the events
    let mut keyboard_events = 0;
    let mut text_input_completion_events = Vec::new();
    let mut mouse_events = 0;

    for event in &captured_events {
        match event {
            WorkflowEvent::Keyboard(_) => keyboard_events += 1,
            WorkflowEvent::TextInputCompleted(text_event) => {
                text_input_completion_events.push(text_event);
            }
            WorkflowEvent::Mouse(_) => mouse_events += 1,
            _ => {}
        }
    }

    println!("📊 Event Analysis:");
    println!("   - Keyboard events: {keyboard_events}");
    println!(
        "   - Text input completion events: {}",
        text_input_completion_events.len()
    );
    println!("   - Mouse events: {mouse_events}");

    // Step 12: Verify text input completion events
    println!("\n🔍 Verifying Text Input Completion Events:");

    assert!(
        !text_input_completion_events.is_empty(),
        "❌ No text input completion events were captured! Expected at least 1."
    );

    for (i, event) in text_input_completion_events.iter().enumerate() {
        println!("   Event {}: '{}'", i + 1, event.text_value);
        println!("     - Field type: {}", event.field_type);
        println!("     - Input method: {:?}", event.input_method);
        println!("     - Keystroke count: {}", event.keystroke_count);
        println!("     - Duration: {}ms", event.typing_duration_ms);

        // Verify the event has meaningful content
        assert!(
            !event.text_value.trim().is_empty(),
            "❌ Text input completion event {} has empty text",
            i + 1
        );

        // Verify it's identified as a text input field
        assert!(
            event.field_type.to_lowercase().contains("edit")
                || event.field_type.to_lowercase().contains("document")
                || event.field_type.to_lowercase().contains("text"),
            "❌ Event {} has unexpected field type: {}",
            i + 1,
            event.field_type
        );

        // Verify timing makes sense
        assert!(
            event.typing_duration_ms > 0,
            "❌ Event {} has zero typing duration",
            i + 1
        );

        // Verify keystroke count makes sense
        assert!(
            event.keystroke_count > 0,
            "❌ Event {} has zero keystroke count",
            i + 1
        );
    }

    // Step 13: Verify we captured both granular and high-level events
    assert!(
        keyboard_events > 0,
        "❌ No keyboard events captured! Expected individual keystroke events."
    );

    // The ratio of keyboard to text completion events should make sense
    // (there should be many more keyboard events than completion events)
    assert!(
        keyboard_events > text_input_completion_events.len(),
        "❌ Expected more keyboard events ({}) than text completion events ({})",
        keyboard_events,
        text_input_completion_events.len()
    );

    // Step 14: Verify specific text content was captured
    let all_captured_text: String = text_input_completion_events
        .iter()
        .map(|e| e.text_value.as_str())
        .collect::<Vec<_>>()
        .join(" ");

    println!("\n📝 All captured text: '{all_captured_text}'");

    // Should contain some of our typed content
    assert!(
        all_captured_text.contains("Hello")
            || all_captured_text.contains("World")
            || all_captured_text.contains("ComputerUse")
            || all_captured_text.contains("line 2"),
        "❌ Captured text doesn't contain expected content. Got: '{all_captured_text}'"
    );

    // Step 15: Clean up - Close Notepad
    println!("🧹 Cleaning up...");

    // Try to close Notepad gracefully
    if let Ok(notepad_window) = desktop
        .locator("window:Notepad")
        .first(Some(Duration::from_secs(2)))
        .await
    {
        if let Err(e) = notepad_window.press_key("{Alt}{F4}") {
            println!("⚠️  Failed to close Notepad gracefully: {e}");
        }

        // If there's a save dialog, click "Don't Save"
        tokio::time::sleep(Duration::from_millis(500)).await;
        if let Ok(save_dialog) = desktop
            .locator("window:Notepad")
            .locator("name:Don't Save")
            .first(Some(Duration::from_secs(2)))
            .await
        {
            let _ = save_dialog.click();
        }
    }

    println!("\n✅ End-to-End Text Input Completion Test PASSED!");
    println!(
        "   - Successfully captured {} text input completion events",
        text_input_completion_events.len()
    );
    println!("   - Successfully captured {keyboard_events} individual keyboard events");
    println!("   - High-level semantic aggregation is working correctly!");
    println!("   - Text content verification passed");
}

#[tokio::test]
#[ignore] // This test interacts with the live desktop and should be run manually
async fn test_text_input_event_latency() {
    use std::time::Instant;
    use tokio::time::timeout;
    println!("\n🚀 Starting Text Input Event Latency Test");
    println!("==============================================");

    // 1. Setup the recorder
    let config = WorkflowRecorderConfig {
        record_text_input_completion: true,
        ..Default::default()
    };
    let mut recorder = WorkflowRecorder::new("Latency Test".to_string(), config);
    let mut event_stream = recorder.event_stream();

    println!("✅ Workflow recorder initialized");

    // 2. Start recording
    println!("🎬 Starting recording...");
    recorder.start().await.expect("Failed to start recording");
    tokio::time::sleep(Duration::from_millis(500)).await;

    // 3. Automation task
    let automation_task = tokio::spawn(async move {
        println!("🖥️  Initializing ComputerUse Desktop for automation...");
        let desktop = Desktop::new(false, false).expect("Failed to create Desktop");

        println!("🌍 Opening URL...");
        let browser = desktop
            .open_url("https://pages.dataiku.com/guide-to-ai-agents", None)
            .expect("Failed to open URL");

        // Wait for page to load
        println!("⏳ Waiting for page to load...");
        tokio::time::sleep(Duration::from_secs(1)).await;

        println!("🔍 Finding email input element...");
        let email_input = browser
            .locator("role:edit")
            .unwrap()
            .all(Some(Duration::from_secs(10)), None)
            .await
            .expect("Failed to find email input");

        // 4. Type text and record time
        let test_text = format!(
            "test-{}",
            std::time::UNIX_EPOCH.elapsed().unwrap().as_millis()
        );
        let start_time = Instant::now();

        for input in email_input {
            println!("✅ Found email input element: {:?}", input.name());

            println!("⌨️  Typing text: '{}'", &test_text);

            input.type_text(&test_text, true).unwrap_or_else(|e| {
                println!("❌ Failed to type text: {e}");
                // std::process::exit(1);
            });
            input.press_key("{Tab}").unwrap_or_else(|e| {
                println!("❌ Failed to press Tab: {e}");
                // std::process::exit(1);
            });
        }

        browser.close().expect("Failed to close browser");

        (start_time, test_text)
    });

    // 5. Event listener task
    let event_listener_task = tokio::spawn(async move {
        println!("👂 Listening for TextInputCompleted event...");
        loop {
            match timeout(Duration::from_secs(5), event_stream.next()).await {
                Ok(Some(WorkflowEvent::TextInputCompleted(event))) => {
                    println!(
                        "🎉 Received TextInputCompleted event: '{}'",
                        event.text_value
                    );
                    return Some(event);
                }
                Ok(Some(_)) => {
                    // Ignore other events
                }
                _ => {
                    println!("Event stream ended, lagged, or timed out before event received.");
                    return None;
                }
            }
        }
    });

    let (start_time, typed_text) = automation_task.await.expect("Automation task panicked");
    let received_event = event_listener_task
        .await
        .expect("Event listener task panicked");

    // 6. Teardown and Assertion
    println!("⏹️  Stopping recording...");
    recorder.stop().await.expect("Failed to stop recording");

    assert!(
        received_event.is_some(),
        "❌ Did not receive the TextInputCompleted event"
    );

    let event = received_event.unwrap();
    // Note: Web pages can have tricky text retrieval. We check if the typed text is contained
    // in the retrieved value, which is more robust.
    assert!(
        event.text_value.contains(&typed_text),
        "❌ Received event text ('{}') does not contain typed text ('{}')",
        event.text_value,
        typed_text
    );

    let latency = start_time.elapsed();
    println!("✅ Text input event latency: {latency:?}");

    assert!(
        latency < Duration::from_secs(2),
        "❌ Event latency is too high: {latency:?}. Expected < 2s."
    );

    println!("\n✅ Latency Test PASSED!");
}
