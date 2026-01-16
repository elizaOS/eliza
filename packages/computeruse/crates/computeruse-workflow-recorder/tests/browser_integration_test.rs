use std::time::Duration;
use computeruse::Desktop;
use computeruse_workflow_recorder::{
    BrowserTabNavigationEvent, ClickEvent, TextInputCompletedEvent, WorkflowEvent,
    WorkflowRecorder, WorkflowRecorderConfig,
};
use tokio_stream::{Stream, StreamExt};

/// Helper function to expect a specific event within a timeout.
/// Panics if the event is not found.
async fn expect_event<S, F>(event_stream: &mut S, description: &str, predicate: F) -> WorkflowEvent
where
    S: Stream<Item = WorkflowEvent> + Unpin + ?Sized,
    F: Fn(&WorkflowEvent) -> bool,
{
    let timeout = Duration::from_secs(5);
    match tokio::time::timeout(timeout, async {
        while let Some(event) = event_stream.next().await {
            if predicate(&event) {
                println!("✅ {description}: Found expected event.");
                return Some(event);
            }
        }
        None
    })
    .await
    {
        Ok(Some(event)) => event,
        Ok(None) => panic!("❌ {description}: Stream ended before event was found."),
        Err(_) => panic!("❌ {description}: Timed out waiting for event."),
    }
}

/// Integration test for browser navigation events through keyboard shortcuts
/// Tests that browser shortcuts and navigation are properly captured
#[tokio::test]
#[ignore] // Run with: cargo test test_browser_navigation_shortcuts -- --ignored --nocapture
async fn test_browser_navigation_shortcuts() {
    println!("\n🌐 Starting Browser Navigation Shortcuts Integration Test");
    println!("========================================================");

    // Step 1: Configure recorder for browser events
    let config = WorkflowRecorderConfig {
        ..Default::default()
    };

    let mut recorder = WorkflowRecorder::new("Browser Navigation Test".to_string(), config);
    let mut event_stream = recorder.event_stream();

    println!("✅ Workflow recorder configured for browser navigation");

    // Step 2: Start recording
    println!("🎬 Starting recording...");
    recorder.start().await.expect("Failed to start recording");
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Step 3: Initialize desktop automation
    println!("🖥️  Initializing ComputerUse Desktop...");
    let desktop = Desktop::new(false, false).expect("Failed to create Desktop");

    // Step 4: Open browser and navigate to test page
    println!("🌍 Opening browser and navigating to test page...");
    let browser = desktop
        .open_url("https://httpbin.org", None)
        .expect("Failed to open browser");

    // Wait for page to load
    tokio::time::sleep(Duration::from_secs(3)).await;

    // Step 5: Test various browser shortcuts
    println!("⌨️  Testing browser keyboard shortcuts...");

    let shortcuts = vec![
        ("{Ctrl}{T}", "New Tab"),
        ("{Ctrl}{L}", "Focus Address Bar"),
        ("{Ctrl}{R}", "Refresh Page"),
        ("{Alt}{Left}", "Back Navigation"),
        ("{Alt}{Right}", "Forward Navigation"),
        ("{F5}", "Refresh"),
    ];

    for (shortcut, description) in shortcuts {
        println!("   Testing {description}: {shortcut}");
        let _ = browser.press_key(shortcut);
        tokio::time::sleep(Duration::from_millis(2000)).await;
    }

    // Step 6: Test tab navigation
    println!("🔄 Testing tab navigation...");
    let _ = browser.press_key("{Ctrl}{1}"); // Switch to first tab
    tokio::time::sleep(Duration::from_millis(1000)).await;
    let _ = browser.press_key("{Ctrl}{T}"); // New tab
    tokio::time::sleep(Duration::from_millis(1000)).await;
    let _ = browser.press_key("{Ctrl}{2}"); // Switch to second tab
    tokio::time::sleep(Duration::from_millis(1000)).await;

    // Step 7: Test address bar typing
    println!("🌐 Testing address bar navigation...");
    let _ = browser.press_key("{Ctrl}{L}"); // Focus address bar
    tokio::time::sleep(Duration::from_millis(500)).await;
    let _ = browser.type_text("https://example.com", false);
    let _ = browser.press_key("{Enter}");
    tokio::time::sleep(Duration::from_secs(3)).await;

    // Step 8: Stop recording
    println!("⏹️  Stopping recording...");
    recorder.stop().await.expect("Failed to stop recording");
    tokio::time::sleep(Duration::from_millis(1000)).await;

    // Step 9: Collect and analyze events
    println!("📊 Collecting and analyzing captured events...");
    let mut captured_events = Vec::new();
    let mut timeout_count = 0;
    const MAX_TIMEOUTS: usize = 15;

    while timeout_count < MAX_TIMEOUTS {
        tokio::select! {
            event = event_stream.next() => {
                if let Some(event) = event {
                    captured_events.push(event);
                    timeout_count = 0;
                } else {
                    break;
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(100)) => {
                timeout_count += 1;
            }
        }
    }

    println!("📈 Total events captured: {}", captured_events.len());

    // Step 10: Analyze browser navigation events
    let mut button_click_events = Vec::new();
    let mut browser_nav_events = Vec::new();
    let mut keyboard_events = 0;
    let mut hotkey_events = 0;

    for event in &captured_events {
        match event {
            WorkflowEvent::Click(click_event) => {
                button_click_events.push(click_event);
            }
            WorkflowEvent::BrowserTabNavigation(nav_event) => {
                browser_nav_events.push(nav_event);
            }
            WorkflowEvent::Keyboard(kb_event) => {
                keyboard_events += 1;
                if kb_event.ctrl_pressed || kb_event.alt_pressed || kb_event.shift_pressed {
                    hotkey_events += 1;
                }
            }
            _ => {}
        }
    }

    println!("📊 Browser Navigation Event Analysis:");
    println!("   - Button clicks: {}", button_click_events.len());
    println!("   - Browser tab navigation: {}", browser_nav_events.len());
    println!("   - Keyboard events: {keyboard_events}");
    println!("   - Hotkey combinations: {hotkey_events}");

    // Step 11: Verify browser navigation events
    println!("\n🔍 Verifying Browser Navigation Events:");

    // Verify we captured some events
    assert!(
        keyboard_events > 0,
        "❌ No keyboard events captured! Expected browser shortcuts."
    );

    assert!(
        hotkey_events > 0,
        "❌ No hotkey combinations captured! Expected browser shortcuts."
    );

    // Verify browser navigation events contain meaningful data
    for (i, event) in browser_nav_events.iter().enumerate() {
        println!(
            "   Browser Nav {}: Action={:?}, Method={:?}",
            i + 1,
            event.action,
            event.method
        );

        if let Some(ref to_url) = event.to_url {
            println!("     - To URL: '{to_url}'");
        }
        if let Some(ref to_title) = event.to_title {
            println!("     - To Title: '{to_title}'");
        }
        println!("     - Browser: '{}'", event.browser);
    }

    // Step 12: Clean up - Close browser
    println!("🧹 Cleaning up...");
    let _ = browser.close();

    println!("\n✅ Browser Navigation Shortcuts Test PASSED!");
    println!("   - Keyboard events: {keyboard_events}");
    println!("   - Hotkey combinations: {hotkey_events}");
    println!("   - Browser navigation: {}", browser_nav_events.len());
    println!("   - Button interactions: {}", button_click_events.len());
}

/// Integration test for browser form interactions
/// Tests form filling and text input completion events
#[tokio::test]
#[ignore] // Run with: cargo test test_browser_form_interactions -- --ignored --nocapture
async fn test_browser_form_interactions() {
    println!("\n📝 Starting Complex Browser Form Interactions Integration Test");
    println!("============================================================");

    let config = WorkflowRecorderConfig {
        ..Default::default()
    };

    let mut recorder = WorkflowRecorder::new("Complex Browser Form Test".to_string(), config);
    let mut event_stream = recorder.event_stream();

    println!("✅ Workflow recorder configured for complex form interactions");

    recorder.start().await.expect("Failed to start recording");
    tokio::time::sleep(Duration::from_millis(500)).await;

    let desktop = Desktop::new(false, false).expect("Failed to create Desktop");

    println!("📄 Opening test form page: https://pages.dataiku.com/guide-to-ai-agents");
    let browser = desktop
        .open_url("https://pages.dataiku.com/guide-to-ai-agents", None)
        .expect("Failed to open form page");

    tokio::time::sleep(Duration::from_secs(5)).await; // Wait for page and form to load

    // 1. Open a new tab to example.com
    println!("🌐 Opening new tab to https://example.com");
    browser.press_key("{Ctrl}t").unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    browser.press_key("{Ctrl}l").unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    browser
        .type_text("https://example.com", false)
        .expect("Failed to type URL");
    browser.press_key("{Enter}").unwrap();
    tokio::time::sleep(Duration::from_secs(3)).await;

    // Assert BrowserTabNavigationEvent for example.com
    let nav_event = expect_event(&mut event_stream, "Wait for example.com navigation", |e| {
        if let WorkflowEvent::BrowserTabNavigation(nav) = e {
            nav.to_url.as_deref() == Some("https://example.com/")
        } else {
            false
        }
    })
    .await;

    if let WorkflowEvent::BrowserTabNavigation(BrowserTabNavigationEvent {
        to_url, to_title, ..
    }) = nav_event
    {
        assert_eq!(to_url.as_deref(), Some("https://example.com/"));
        assert!(to_title.as_deref().unwrap_or("").contains("Example Domain"));
    } else {
        panic!("Expected BrowserTabNavigationEvent");
    }

    // 2. Switch back to the original tab
    println!("🔄 Switching back to the form tab");
    browser.press_key("{Ctrl}{Shift}{Tab}").unwrap();
    tokio::time::sleep(Duration::from_secs(3)).await;

    // Assert BrowserTabNavigationEvent for dataiku page
    let nav_event_back = expect_event(&mut event_stream, "Wait for dataiku.com navigation", |e| {
        if let WorkflowEvent::BrowserTabNavigation(nav) = e {
            nav.to_url
                .as_deref()
                .unwrap_or("")
                .contains("dataiku.com/guide-to-ai-agents")
        } else {
            false
        }
    })
    .await;

    if let WorkflowEvent::BrowserTabNavigation(BrowserTabNavigationEvent { to_url, .. }) =
        nav_event_back
    {
        assert!(to_url
            .as_deref()
            .unwrap_or("")
            .contains("dataiku.com/guide-to-ai-agents"));
    } else {
        panic!("Expected BrowserTabNavigationEvent");
    }

    // 3. Fill out the form
    println!("📝 Filling out the form...");

    // The form is inside an iframe, so we need to locate it first.
    println!("🔍 Locating the form iframe...");
    let iframe = browser
        .locator("role:pane") // iframes are often exposed as panes or documents
        .unwrap()
        .first(Some(Duration::from_secs(10)))
        .await
        .expect("Could not find the form iframe.");

    let form_data = vec![
        ("firstname", "John"),
        ("lastname", "Doe"),
        ("email", "john.doe@example.com"),
        ("company", "ACME Corp"),
    ];

    for (field_name, value) in form_data {
        println!("   Filling '{field_name}' with '{value}'");
        let locator_str = format!("name:{field_name}");
        // Search for the input within the iframe
        let input = iframe
            .locator(locator_str.as_str())
            .unwrap()
            .first(Some(Duration::from_secs(5)))
            .await
            .unwrap_or_else(|_| panic!("Could not find input for {field_name}"));

        input.click().unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        input
            .type_text(value, true)
            .unwrap_or_else(|_| panic!("Failed to type into {field_name}"));
        tokio::time::sleep(Duration::from_millis(500)).await;
        input.press_key("{Tab}").unwrap(); // Trigger completion

        let text_event = expect_event(
            &mut event_stream,
            &format!("Wait for '{field_name}' text input completion"),
            |e| {
                if let WorkflowEvent::TextInputCompleted(evt) = e {
                    evt.field_name.as_deref().unwrap_or("").contains(field_name)
                } else {
                    false
                }
            },
        )
        .await;

        if let WorkflowEvent::TextInputCompleted(TextInputCompletedEvent {
            text_value,
            field_name: event_field_name,
            ..
        }) = text_event
        {
            assert_eq!(text_value, value);
            assert!(event_field_name
                .as_deref()
                .unwrap_or("")
                .contains(field_name));
        } else {
            panic!("Expected TextInputCompletedEvent for {field_name}");
        }
    }

    // 4. Click the submit button
    println!("🚀 Clicking submit button...");
    // The submit button is also within the iframe
    let submit_button = iframe
        .locator("role:button >> name:Download the report")
        .unwrap()
        .first(Some(Duration::from_secs(5)))
        .await
        .expect("Could not find submit button");
    submit_button.click().unwrap();

    let button_event = expect_event(&mut event_stream, "Wait for submit button click", |e| {
        if let WorkflowEvent::Click(evt) = e {
            evt.element_text.contains("Download the report")
        } else {
            false
        }
    })
    .await;

    if let WorkflowEvent::Click(ClickEvent { element_text, .. }) = button_event {
        assert!(element_text.contains("Download the report"));
    } else {
        panic!("Expected Click event for submit");
    }

    // Stop recording
    println!("⏹️  Stopping recording...");
    recorder.stop().await.expect("Failed to stop recording");

    let _ = browser.close();

    println!("\n✅ Complex Browser Form Interactions Test PASSED!");
}

/// Integration test for mouse click events in browser
/// Tests button clicks and UI interactions
#[tokio::test]
#[ignore] // Run with: cargo test test_browser_mouse_interactions -- --ignored --nocapture
async fn test_browser_mouse_interactions() {
    println!("\n🖱️  Starting Browser Mouse Interactions Integration Test");
    println!("========================================================");

    let config = WorkflowRecorderConfig {
        ..Default::default()
    };

    let mut recorder = WorkflowRecorder::new("Browser Mouse Test".to_string(), config);
    let mut event_stream = recorder.event_stream();

    // Start recording
    recorder.start().await.expect("Failed to start recording");
    tokio::time::sleep(Duration::from_millis(500)).await;

    let desktop = Desktop::new(false, false).expect("Failed to create Desktop");

    // Open browser
    println!("🌐 Opening browser...");
    let browser = desktop
        .open_url("https://httpbin.org", None)
        .expect("Failed to open browser");

    tokio::time::sleep(Duration::from_secs(3)).await;

    // Test various mouse interactions
    println!("🖱️  Testing mouse interactions...");

    // Try to click on elements
    if let Ok(elements) = browser
        .locator("role:Hyperlink")
        .unwrap()
        .all(Some(Duration::from_secs(5)), None)
        .await
    {
        if !elements.is_empty() {
            println!(
                "   Found {} clickable elements, clicking first few",
                elements.len()
            );
            for (i, element) in elements.iter().enumerate().take(2) {
                println!(
                    "   Clicking element {} ({})",
                    i + 1,
                    element.name().unwrap_or_default()
                );
                let _ = element.click();
                tokio::time::sleep(Duration::from_millis(1500)).await;
            }
        }
    }

    // Test browser navigation with mouse (back button simulation)
    println!("🔙 Testing browser back navigation...");
    let _ = browser.press_key("{Alt}{Left}"); // Back
    tokio::time::sleep(Duration::from_millis(2000)).await;

    // Stop recording
    recorder.stop().await.expect("Failed to stop recording");
    tokio::time::sleep(Duration::from_millis(1000)).await;

    // Collect events
    let mut captured_events = Vec::new();
    let mut timeout_count = 0;
    const MAX_TIMEOUTS: usize = 10;

    while timeout_count < MAX_TIMEOUTS {
        tokio::select! {
            event = event_stream.next() => {
                if let Some(event) = event {
                    captured_events.push(event);
                    timeout_count = 0;
                } else {
                    break;
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(100)) => {
                timeout_count += 1;
            }
        }
    }

    // Analyze mouse events
    let mut mouse_events = 0;
    let mut button_click_events = Vec::new();
    let mut browser_nav_events = Vec::new();

    for event in &captured_events {
        match event {
            WorkflowEvent::Mouse(_) => mouse_events += 1,
            WorkflowEvent::Click(click_event) => {
                button_click_events.push(click_event);
            }
            WorkflowEvent::BrowserTabNavigation(nav_event) => {
                browser_nav_events.push(nav_event);
            }
            _ => {}
        }
    }

    println!("📊 Mouse Interaction Analysis:");
    println!("   - Mouse events: {mouse_events}");
    println!("   - Button clicks: {}", button_click_events.len());
    println!("   - Browser navigation: {}", browser_nav_events.len());

    // Verify we captured mouse interactions
    assert!(
        mouse_events > 0 || !button_click_events.is_empty(),
        "❌ No mouse interaction events captured!"
    );

    // Clean up
    let _ = browser.close();

    println!("\n✅ Browser Mouse Interactions Test PASSED!");
    println!("   - Mouse events: {mouse_events}");
    println!("   - Button clicks: {}", button_click_events.len());
    println!("   - Browser navigation: {}", browser_nav_events.len());
}
