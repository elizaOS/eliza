use std::time::Duration;
use computeruse::Desktop;
use computeruse_workflow_recorder::{
    ApplicationSwitchMethod, HotkeyEvent, WorkflowEvent, WorkflowRecorder, WorkflowRecorderConfig,
};
use tokio_stream::{Stream, StreamExt};

/// Helper function to expect a specific event within a timeout
async fn expect_event<S, F>(
    event_stream: &mut S,
    description: &str,
    predicate: F,
    timeout_secs: u64,
) -> Result<WorkflowEvent, String>
where
    S: Stream<Item = WorkflowEvent> + Unpin + ?Sized,
    F: Fn(&WorkflowEvent) -> bool,
{
    let timeout = Duration::from_secs(timeout_secs);
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
        Ok(Some(event)) => Ok(event),
        Ok(None) => Err(format!(
            "❌ {description}: Stream ended before event was found."
        )),
        Err(_) => Err(format!("❌ {description}: Timed out waiting for event.")),
    }
}

/// Helper function to wait for any application switch events (for debugging)
async fn collect_events_for_duration<S>(
    event_stream: &mut S,
    duration_secs: u64,
) -> Vec<WorkflowEvent>
where
    S: Stream<Item = WorkflowEvent> + Unpin + ?Sized,
{
    let mut events = Vec::new();
    let timeout = Duration::from_secs(duration_secs);

    let _ = tokio::time::timeout(timeout, async {
        while let Some(event) = event_stream.next().await {
            events.push(event);
        }
    })
    .await;

    events
}

/// Automated integration test for Alt+Tab detection
/// Tests that Alt+Tab hotkey and application switch events are properly captured and attributed
#[tokio::test]
#[ignore] // Run with: cargo test test_alt_tab_automation -- --ignored --nocapture
async fn test_alt_tab_automation() {
    println!("\n🚀 Starting Alt+Tab Automation Integration Test");
    println!("===================================================");

    // Step 1: Setup recorder with optimized configuration for Alt+Tab testing
    println!("📊 Setting up workflow recorder...");
    let config = WorkflowRecorderConfig {
        // Minimal recording for focused testing
        record_mouse: false,
        record_keyboard: false, // We don't need individual keystrokes, just hotkeys
        capture_ui_elements: false, // Skip UI element capture for performance

        // Core features for Alt+Tab testing
        record_clipboard: false,
        record_hotkeys: true, // CRITICAL: For detecting Alt+Tab hotkey
        record_text_input_completion: false,
        record_browser_tab_navigation: false,
        record_application_switches: true, // CRITICAL: For detecting app switches

        // Performance optimizations
        track_modifier_states: true,
        mouse_move_throttle_ms: 1000,
        min_drag_distance: 50.0,
        enable_multithreading: false,

        // Disable non-essential features for cleaner test
        ignore_focus_patterns: std::collections::HashSet::from([
            "taskbar".to_string(),
            "notification".to_string(),
            "tooltip".to_string(),
        ]),

        ..Default::default()
    };

    let mut recorder = WorkflowRecorder::new("Alt+Tab Automation Test".to_string(), config);
    let mut event_stream = recorder.event_stream();

    println!("▶️ Starting recorder...");
    recorder.start().await.expect("Failed to start recorder");

    // Step 2: Setup Desktop and prepare applications for switching
    println!("🖥️ Setting up Desktop SDK...");
    let desktop = Desktop::new(false, false).expect("Failed to create Desktop");

    // Step 3: Open applications to switch between
    println!("📱 Opening applications for Alt+Tab testing...");

    // Open Notepad as first application
    println!("   📝 Opening Notepad...");
    let notepad = desktop
        .open_application("notepad.exe")
        .expect("Failed to open Notepad");
    tokio::time::sleep(Duration::from_millis(2000)).await; // Let it fully load

    // Open Calculator as second application
    println!("   🧮 Opening Calculator...");
    let calculator = desktop
        .open_application("calc.exe")
        .expect("Failed to open Calculator");
    tokio::time::sleep(Duration::from_millis(2000)).await; // Let it fully load

    // Step 4: Perform automated Alt+Tab test sequence
    println!("\n🔄 Starting Alt+Tab test sequence...");

    // Test 1: Alt+Tab from Calculator to Notepad
    println!("   Test 1: Alt+Tab from Calculator → Notepad");

    // Ensure Calculator is focused first
    let _ = calculator.click(); // Focus calculator
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Simulate Alt+Tab
    println!("      ⌨️ Simulating Alt+Tab...");
    let _ = calculator.press_key("{Alt}{Tab}");

    // Wait for hotkey event
    println!("      🔍 Waiting for Alt+Tab hotkey event...");
    let hotkey_event = expect_event(
        &mut event_stream,
        "Alt+Tab Hotkey",
        |event| {
            matches!(event, WorkflowEvent::Hotkey(HotkeyEvent { action: Some(action), .. }) if action == "Switch Window")
        },
        5,
    ).await.expect("Failed to capture Alt+Tab hotkey event");

    if let WorkflowEvent::Hotkey(hotkey) = hotkey_event {
        println!("      ✅ Alt+Tab hotkey captured: {}", hotkey.combination);
    }

    // Wait for application switch event
    println!("      🔍 Waiting for application switch event...");
    let app_switch_event = expect_event(
        &mut event_stream,
        "Application Switch",
        |event| matches!(event, WorkflowEvent::ApplicationSwitch(_)),
        8, // Longer timeout to account for app switching delay
    )
    .await
    .expect("Failed to capture application switch event");

    if let WorkflowEvent::ApplicationSwitch(switch) = app_switch_event {
        println!(
            "      ✅ App switch captured: {} → {} via {:?}",
            switch
                .from_window_and_application_name
                .as_ref()
                .unwrap_or(&"(unknown)".to_string()),
            switch.to_window_and_application_name,
            switch.switch_method
        );

        // CRITICAL TEST: Verify that the switch method is attributed to Alt+Tab
        assert_eq!(
            switch.switch_method,
            ApplicationSwitchMethod::AltTab,
            "❌ FAIL: Application switch was not attributed to Alt+Tab! Got: {:?}",
            switch.switch_method
        );
        println!("      🎯 SUCCESS: Application switch correctly attributed to Alt+Tab!");
    }

    // Step 5: Test reverse Alt+Tab (back to Calculator)
    println!("\n   Test 2: Alt+Tab from Notepad → Calculator");
    tokio::time::sleep(Duration::from_millis(1000)).await; // Brief pause

    // Focus notepad first
    let _ = notepad.click();
    tokio::time::sleep(Duration::from_millis(500)).await;

    println!("      ⌨️ Simulating second Alt+Tab...");
    let _ = notepad.press_key("{Alt}{Tab}");

    // Wait for second hotkey event
    println!("      🔍 Waiting for second Alt+Tab hotkey event...");
    let hotkey_event2 = expect_event(
        &mut event_stream,
        "Second Alt+Tab Hotkey",
        |event| {
            matches!(event, WorkflowEvent::Hotkey(HotkeyEvent { action: Some(action), .. }) if action == "Switch Window")
        },
        5,
    ).await.expect("Failed to capture second Alt+Tab hotkey event");

    if let WorkflowEvent::Hotkey(hotkey) = hotkey_event2 {
        println!(
            "      ✅ Second Alt+Tab hotkey captured: {}",
            hotkey.combination
        );
    }

    // Wait for second application switch event
    println!("      🔍 Waiting for second application switch event...");
    let app_switch_event2 = expect_event(
        &mut event_stream,
        "Second Application Switch",
        |event| matches!(event, WorkflowEvent::ApplicationSwitch(_)),
        8,
    )
    .await
    .expect("Failed to capture second application switch event");

    if let WorkflowEvent::ApplicationSwitch(switch) = app_switch_event2 {
        println!(
            "      ✅ Second app switch captured: {} → {} via {:?}",
            switch
                .from_window_and_application_name
                .as_ref()
                .unwrap_or(&"(unknown)".to_string()),
            switch.to_window_and_application_name,
            switch.switch_method
        );

        // CRITICAL TEST: Verify second switch is also attributed to Alt+Tab
        assert_eq!(
            switch.switch_method,
            ApplicationSwitchMethod::AltTab,
            "❌ FAIL: Second application switch was not attributed to Alt+Tab! Got: {:?}",
            switch.switch_method
        );
        println!("      🎯 SUCCESS: Second application switch correctly attributed to Alt+Tab!");
    }

    // Step 6: Test timeout behavior (click switch without Alt+Tab)
    println!("\n   Test 3: Window click switch (should NOT be attributed to Alt+Tab)");
    tokio::time::sleep(Duration::from_millis(3000)).await; // Wait for Alt+Tab timeout

    // Click on calculator directly (should be WindowClick method)
    println!("      🖱️ Clicking Calculator directly (no Alt+Tab)...");
    let _ = calculator.click();

    // Collect events for a few seconds to see what we get
    println!("      🔍 Collecting events for timeout test...");
    let timeout_events = collect_events_for_duration(&mut event_stream, 3).await;

    // Look for any application switch events
    let app_switches: Vec<_> = timeout_events
        .iter()
        .filter_map(|e| match e {
            WorkflowEvent::ApplicationSwitch(switch) => Some(switch),
            _ => None,
        })
        .collect();

    if let Some(switch) = app_switches.first() {
        println!(
            "      ✅ Window click switch captured: {} → {} via {:?}",
            switch
                .from_window_and_application_name
                .as_ref()
                .unwrap_or(&"(unknown)".to_string()),
            switch.to_window_and_application_name,
            switch.switch_method
        );

        // This should NOT be attributed to Alt+Tab since we waited for timeout
        assert_ne!(
            switch.switch_method,
            ApplicationSwitchMethod::AltTab,
            "❌ FAIL: Window click was incorrectly attributed to Alt+Tab!"
        );
        println!(
            "      🎯 SUCCESS: Window click correctly NOT attributed to Alt+Tab (got {:?})",
            switch.switch_method
        );
    } else {
        println!("      ℹ️ No application switch detected for window click (this is also valid)");
    }

    // Step 7: Cleanup
    println!("\n🧹 Cleaning up...");
    recorder.stop().await.expect("Failed to stop recorder");

    // Close applications
    println!("   Closing applications...");
    let _ = calculator.close();
    let _ = notepad.close();
    tokio::time::sleep(Duration::from_millis(1000)).await;

    println!("\n✅ Alt+Tab Automation Test PASSED!");
    println!("📊 Summary:");
    println!("   • Alt+Tab hotkey detection: ✅ Working");
    println!("   • Application switch attribution: ✅ Working");
    println!("   • Timeout behavior: ✅ Working");
    println!("   • Event capture pipeline: ✅ Working");
    println!("\n🎯 Alt+Tab functionality is working correctly!");
}

/// Test with multiple rapid Alt+Tab presses (stress test)
#[tokio::test]
#[ignore] // Run with: cargo test test_alt_tab_rapid_switching -- --ignored --nocapture
async fn test_alt_tab_rapid_switching() {
    println!("\n⚡ Starting Alt+Tab Rapid Switching Stress Test");
    println!("=================================================");

    // Minimal recorder configuration
    let config = WorkflowRecorderConfig {
        record_mouse: false,
        record_keyboard: false,
        capture_ui_elements: false,
        record_clipboard: false,
        record_hotkeys: true,
        record_text_input_completion: false,
        record_browser_tab_navigation: false,
        record_application_switches: true,
        track_modifier_states: true,
        enable_multithreading: false,
        ..Default::default()
    };

    let mut recorder = WorkflowRecorder::new("Alt+Tab Stress Test".to_string(), config);
    let mut event_stream = recorder.event_stream();
    recorder.start().await.expect("Failed to start recorder");

    // Setup applications
    let desktop = Desktop::new(false, false).expect("Failed to create Desktop");
    let notepad = desktop
        .open_application("notepad.exe")
        .expect("Failed to open Notepad");
    tokio::time::sleep(Duration::from_millis(1500)).await;

    let calculator = desktop
        .open_application("calc.exe")
        .expect("Failed to open Calculator");
    tokio::time::sleep(Duration::from_millis(1500)).await;

    // Rapid Alt+Tab test
    println!("🔄 Testing rapid Alt+Tab switching...");

    let mut hotkey_count = 0;
    let mut switch_count = 0;
    let mut alt_tab_attributed_count = 0;

    // Perform 5 rapid Alt+Tab presses
    for i in 1..=5 {
        println!("   Rapid Alt+Tab #{i}");
        let _ = calculator.press_key("{Alt}{Tab}");
        tokio::time::sleep(Duration::from_millis(800)).await; // Rapid but not too fast
    }

    // Collect events for analysis
    println!("📊 Collecting events for analysis...");
    let events = collect_events_for_duration(&mut event_stream, 10).await;

    // Analyze events
    for event in &events {
        match event {
            WorkflowEvent::Hotkey(HotkeyEvent {
                action: Some(action),
                ..
            }) if action == "Switch Window" => {
                hotkey_count += 1;
                println!("   ⌨️ Alt+Tab hotkey #{hotkey_count}");
            }
            WorkflowEvent::ApplicationSwitch(switch) => {
                switch_count += 1;
                if switch.switch_method == ApplicationSwitchMethod::AltTab {
                    alt_tab_attributed_count += 1;
                    println!(
                        "   🔄 App switch #{} attributed to Alt+Tab: {} → {}",
                        switch_count,
                        switch
                            .from_window_and_application_name
                            .as_ref()
                            .unwrap_or(&"(unknown)".to_string()),
                        switch.to_window_and_application_name
                    );
                } else {
                    println!(
                        "   🔄 App switch #{} NOT attributed to Alt+Tab: {} → {} (method: {:?})",
                        switch_count,
                        switch
                            .from_window_and_application_name
                            .as_ref()
                            .unwrap_or(&"(unknown)".to_string()),
                        switch.to_window_and_application_name,
                        switch.switch_method
                    );
                }
            }
            _ => {}
        }
    }

    // Cleanup
    recorder.stop().await.expect("Failed to stop recorder");
    let _ = calculator.close();
    let _ = notepad.close();

    // Analysis
    println!("\n📈 Rapid Switching Test Results:");
    println!("   • Alt+Tab hotkeys detected: {hotkey_count}");
    println!("   • Application switches detected: {switch_count}");
    println!("   • Switches attributed to Alt+Tab: {alt_tab_attributed_count}");
    println!(
        "   • Attribution rate: {:.1}%",
        if switch_count > 0 {
            (alt_tab_attributed_count as f64 / switch_count as f64) * 100.0
        } else {
            0.0
        }
    );

    // Validation
    assert!(
        hotkey_count >= 3,
        "Expected at least 3 Alt+Tab hotkeys, got {hotkey_count}"
    );
    assert!(
        switch_count >= 2,
        "Expected at least 2 app switches, got {switch_count}"
    );
    assert!(
        alt_tab_attributed_count >= 1,
        "Expected at least 1 Alt+Tab attribution, got {alt_tab_attributed_count}"
    );

    println!("✅ Rapid switching stress test PASSED!");
}
