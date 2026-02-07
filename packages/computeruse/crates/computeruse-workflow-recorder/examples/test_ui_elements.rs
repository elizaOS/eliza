use std::time::Duration;
use computeruse_workflow_recorder::{WorkflowEvent, WorkflowRecorder, WorkflowRecorderConfig};
use tokio_stream::StreamExt;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("Testing UI element capture for keyboard events...");

    let config = WorkflowRecorderConfig {
        record_mouse: false,
        record_keyboard: true,
        capture_ui_elements: true,
        record_clipboard: false,
        record_hotkeys: false,
        max_clipboard_content_length: 1024,
        track_modifier_states: true,
        mouse_move_throttle_ms: 50,
        min_drag_distance: 5.0,
        ..Default::default()
    };

    let mut recorder = WorkflowRecorder::new("UI Element Test".to_string(), config);
    let mut event_stream = recorder.event_stream();

    recorder.start().await?;

    println!("Recorder started! Type some keys to test UI element capture...");
    println!("Press Ctrl+C to stop.");

    let mut event_count = 0;

    // Listen for events for a short time
    let timeout = tokio::time::timeout(Duration::from_secs(30), async {
        while let Some(event) = event_stream.next().await {
            event_count += 1;

            if let WorkflowEvent::Keyboard(kb_event) = event {
                if kb_event.is_key_down {
                    println!(
                        "🔍 Keyboard Event #{}: Key {}",
                        event_count, kb_event.key_code
                    );

                    if let Some(ref ui_element) = kb_event.metadata.ui_element {
                        println!("  ✅ UI Element captured!");
                        println!("     App: {:?}", ui_element.application_name());
                        println!("     Window: {:?}", ui_element.window_title());
                        println!("     Control: {:?}", ui_element.role());
                        println!("     Name: {:?}", ui_element.name());
                        println!("     Has Focus: {:?}", ui_element.is_focused());
                    } else {
                        println!("  ❌ No UI Element captured");
                    }
                    println!();

                    // Stop after capturing a few events
                    if event_count >= 5 {
                        break;
                    }
                }
            }
        }
    });

    match timeout.await {
        Ok(_) => println!("Test completed successfully!"),
        Err(_) => println!("Test timed out after 30 seconds"),
    }

    recorder.stop().await?;
    println!("Recorder stopped.");

    Ok(())
}
