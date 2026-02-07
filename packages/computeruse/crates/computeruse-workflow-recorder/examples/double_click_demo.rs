use std::time::Duration;
use computeruse_workflow_recorder::{
    MouseEventType, WorkflowEvent, WorkflowRecorder, WorkflowRecorderConfig,
};
use tokio::time::timeout;
use tracing::info;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize tracing
    tracing_subscriber::fmt::init();

    info!("🖱️ Double Click Detection Demo");
    info!("This demo will record mouse events and detect double clicks.");
    info!("Try double clicking anywhere on the screen!");

    // Create a configuration for recording
    let config = WorkflowRecorderConfig {
        capture_ui_elements: true,
        record_mouse: false, // Reduce noise - correct field name
        record_hotkeys: false,
        record_clipboard: false,
        record_application_switches: false,
        record_browser_tab_navigation: false,
        record_text_input_completion: false,
        mouse_move_throttle_ms: 200,
        ..Default::default()
    };

    // Start the recorder - add name parameter
    let mut recorder = WorkflowRecorder::new("double_click_demo".to_string(), config);
    recorder.start().await?;

    // Get event stream
    let mut event_stream = recorder.event_stream();
    use tokio_stream::StreamExt;

    info!("✅ Recording started. Double click detection is active!");
    info!("Press Ctrl+C to stop the demo.");

    let mut double_click_count = 0;
    let mut single_click_count = 0;

    // Listen for events
    loop {
        match timeout(Duration::from_millis(100), event_stream.next()).await {
            Ok(Some(event)) => {
                match &event {
                    WorkflowEvent::Mouse(mouse_event) => match mouse_event.event_type {
                        MouseEventType::DoubleClick => {
                            double_click_count += 1;
                            info!(
                                "🖱️🖱️ DOUBLE CLICK #{} detected at position ({}, {})",
                                double_click_count, mouse_event.position.x, mouse_event.position.y
                            );

                            if let Some(ui_element) = &mouse_event.metadata.ui_element {
                                info!(
                                    "   Element: '{}' ({})",
                                    ui_element.name_or_empty(),
                                    ui_element.role()
                                );
                            }
                        }
                        MouseEventType::Down => {
                            single_click_count += 1;
                            info!(
                                "📍 Click #{} (down) at ({}, {})",
                                single_click_count, mouse_event.position.x, mouse_event.position.y
                            );
                        }
                        MouseEventType::Up => {
                            info!(
                                "📍 Click (up) at ({}, {})",
                                mouse_event.position.x, mouse_event.position.y
                            );
                        }
                        _ => {}
                    },
                    _ => {
                        // We can ignore other events for this demo
                    }
                }
            }
            Ok(None) => {
                // Stream ended
                break;
            }
            Err(_) => {
                // Timeout, continue listening
                continue;
            }
        }
    }

    // Clean shutdown
    info!("Stopping recorder...");
    recorder.stop().await?;

    info!("📊 Demo Summary:");
    info!("   Double clicks detected: {}", double_click_count);
    info!("   Single clicks detected: {}", single_click_count);
    info!("✅ Demo completed!");

    Ok(())
}
