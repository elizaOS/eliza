use computeruse_workflow_recorder::{WorkflowRecorder, WorkflowRecorderConfig};
use tokio::signal::ctrl_c;
use tokio_stream::StreamExt;
use tracing::{info, Level};
use tracing_subscriber::FmtSubscriber;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("[EARLY] Alt+Tab detection test started");
    let subscriber = FmtSubscriber::builder()
        .with_max_level(Level::INFO)
        .with_target(false)
        .with_thread_ids(false)
        .with_file(false)
        .with_line_number(false)
        .finish();
    tracing::subscriber::set_global_default(subscriber)?;

    // Minimal configuration focused on Alt+Tab detection
    let config = WorkflowRecorderConfig {
        // Basic input recording
        record_mouse: false,
        record_keyboard: false,
        capture_ui_elements: false,

        // Only what we need for Alt+Tab
        record_clipboard: false,
        record_hotkeys: true, // For detecting Alt+Tab hotkey
        record_text_input_completion: false,
        record_browser_tab_navigation: false,
        record_application_switches: true, // For detecting app switches

        // Performance optimized
        max_clipboard_content_length: 0,
        track_modifier_states: true,
        mouse_move_throttle_ms: 1000,
        min_drag_distance: 50.0,
        enable_multithreading: false,

        ..Default::default()
    };

    let mut recorder = WorkflowRecorder::new("Alt+Tab Detection Test".to_string(), config);

    let mut event_stream = recorder.event_stream();
    recorder.start().await.expect("Failed to start recorder");

    info!("🚀 Alt+Tab Detection Test Running!");
    info!("⌨️ This test focuses specifically on Alt+Tab application switching");
    info!("");
    info!("🔄 How to test:");
    info!("   1. Press Alt+Tab to switch between applications");
    info!("   2. You should see both events:");
    info!("      • 🔥 Hotkey event for Alt+Tab combination");
    info!("      • 🔄 ApplicationSwitch event with AltTab method");
    info!("   3. Try switching between different apps multiple times");
    info!("   4. Watch the timing - app switch should happen within 2 seconds of hotkey");
    info!("");
    info!("💡 Expected behavior:");
    info!("   • Alt+Tab hotkey detected → marks pending state");
    info!("   • Application focus change → checks for pending Alt+Tab");
    info!("   • If within 2 seconds → attributes switch to Alt+Tab");
    info!("   • Otherwise → attributes to WindowClick or other method");
    info!("");
    info!("🛑 Press Ctrl+C to stop test");

    // Process events and show only relevant ones
    let event_display_task = tokio::spawn(async move {
        let mut event_count = 0;
        while let Some(event) = event_stream.next().await {
            event_count += 1;

            match &event {
                computeruse_workflow_recorder::WorkflowEvent::Hotkey(hotkey_event) => {
                    if hotkey_event.action.as_deref() == Some("Switch Window") {
                        println!(
                            "🔥 HOTKEY {}: Alt+Tab detected! ({})",
                            event_count, hotkey_event.combination
                        );
                        println!("     └─ ⏰ Marking for application switch attribution...");
                    } else {
                        println!(
                            "🔥 Other Hotkey {}: {} ({})",
                            event_count,
                            hotkey_event
                                .action
                                .as_ref()
                                .unwrap_or(&"Unknown".to_string()),
                            hotkey_event.combination
                        );
                    }
                }
                computeruse_workflow_recorder::WorkflowEvent::ApplicationSwitch(
                    app_switch_event,
                ) => {
                    let method_icon = match app_switch_event.switch_method {
                        computeruse_workflow_recorder::ApplicationSwitchMethod::AltTab => "⌨️ Alt+Tab",
                        computeruse_workflow_recorder::ApplicationSwitchMethod::TaskbarClick => "🖱️ Taskbar",
                        computeruse_workflow_recorder::ApplicationSwitchMethod::WindowClick => "🖱️ Window",
                        computeruse_workflow_recorder::ApplicationSwitchMethod::WindowsKeyShortcut => "⌨️ Win+Key",
                        computeruse_workflow_recorder::ApplicationSwitchMethod::StartMenu => "🔍 Start",
                        computeruse_workflow_recorder::ApplicationSwitchMethod::Other => "❓ Other",
                    };

                    println!(
                        "🔄 APP SWITCH {}: {} → {}",
                        event_count,
                        app_switch_event
                            .from_window_and_application_name
                            .as_ref()
                            .unwrap_or(&"(unknown)".to_string()),
                        app_switch_event.to_window_and_application_name
                    );
                    println!("     └─ Method: {method_icon}");

                    if let Some(dwell_time) = app_switch_event.dwell_time_ms {
                        println!("     └─ Previous app duration: {dwell_time}ms");
                    }

                    if app_switch_event.switch_method
                        == computeruse_workflow_recorder::ApplicationSwitchMethod::AltTab
                    {
                        println!("     └─ 🎯 SUCCESS! Alt+Tab correctly attributed!");
                    } else {
                        println!("     └─ ℹ️  Switch not attributed to Alt+Tab (may be timeout or different method)");
                    }
                    println!();
                }
                _ => {
                    // Ignore other events for this focused test
                }
            }
        }
    });

    // Wait for Ctrl+C
    ctrl_c().await.expect("Failed to wait for Ctrl+C");

    info!("🛑 Stopping Alt+Tab detection test...");
    recorder.stop().await.expect("Failed to stop recorder");
    event_display_task.abort();

    info!("✅ Alt+Tab detection test completed!");
    info!("📊 This test demonstrated hotkey detection and application switch attribution");

    Ok(())
}
