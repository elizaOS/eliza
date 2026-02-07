use computeruse_workflow_recorder::{WorkflowEvent, WorkflowRecorder, WorkflowRecorderConfig};
use tokio_stream::StreamExt;

/// Demo of the text input completion feature
///
/// This example shows how to:
/// 1. Configure the workflow recorder to capture text input completion events
/// 2. Start recording
/// 3. Capture both individual keystrokes AND high-level text input completion events
/// 4. Analyze the captured events
///
/// Run with: cargo run --example text_input_completion_demo
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("🚀 Text Input Completion Demo");
    println!("============================");
    println!();
    println!("This demo shows how the workflow recorder captures both:");
    println!("  📝 Individual keyboard events (every keystroke)");
    println!("  🎯 High-level text input completion events (semantic aggregation)");
    println!();

    // Step 1: Configure the recorder with text input completion enabled
    let config = WorkflowRecorderConfig {
        // Enable text input completion feature
        record_text_input_completion: true,

        // Enable UI element capture to identify input fields
        capture_ui_elements: true,

        // Enable basic event recording
        record_keyboard: true,
        record_mouse: true,

        // Disable noisy events for this demo
        record_clipboard: false,
        record_hotkeys: false,

        ..Default::default()
    };

    let mut recorder = WorkflowRecorder::new("Text Input Demo".to_string(), config);
    let mut event_stream = recorder.event_stream();

    println!("✅ Workflow recorder configured");
    println!("   - Text input completion: ENABLED");
    println!("   - Completion timeout: 2000ms");
    println!("   - UI element capture: ENABLED");
    println!();

    // Step 2: Start recording
    println!("🎬 Starting recording...");
    recorder.start().await?;

    println!("✅ Recording started!");
    println!();
    println!("💡 INSTRUCTIONS:");
    println!("   1. Open any text editor (Notepad, VS Code, browser, etc.)");
    println!("   2. Click in a text input field");
    println!("   3. Type some text");
    println!("   4. Wait 2+ seconds or click elsewhere");
    println!("   5. Type more text in another field");
    println!("   6. Press Ctrl+C to stop recording");
    println!();
    println!("📊 Monitoring events (press Ctrl+C to stop)...");
    println!("================================================");

    // Step 3: Monitor events and display them in real-time
    let mut keyboard_count = 0;
    let mut text_completion_count = 0;
    let mut mouse_count = 0;
    let mut other_count = 0;

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            println!("\n⏹️  Ctrl+C received, stopping recording...");
        }
        _ = async {
            while let Some(event) = event_stream.next().await {
                match &event {
                    WorkflowEvent::Keyboard(kb_event) => {
                        keyboard_count += 1;
                        if kb_event.is_key_down {
                            if let Some(ch) = kb_event.character {
                                println!("  ⌨️  Keystroke: '{}' (key_code: {})", ch, kb_event.key_code);
                            } else {
                                println!("  ⌨️  Special key: {} (down)", kb_event.key_code);
                            }
                        }
                    }
                    WorkflowEvent::TextInputCompleted(text_event) => {
                        text_completion_count += 1;
                        println!("\n  🎯 TEXT INPUT COMPLETED:");
                        println!("     📝 Text: \"{}\"", text_event.text_value);
                        println!("     🏷️  Field: {} ({})",
                            text_event.field_name.as_deref().unwrap_or("Unknown"),
                            text_event.field_type
                        );
                        println!("     ⚡ Method: {:?}", text_event.input_method);
                        println!("     ⏱️  Duration: {}ms", text_event.typing_duration_ms);
                        println!("     🔢 Keystrokes: {}", text_event.keystroke_count);
                        println!();
                    }
                    WorkflowEvent::Mouse(mouse_event) => {
                        mouse_count += 1;
                        if matches!(mouse_event.event_type, computeruse_workflow_recorder::MouseEventType::Down) {
                            println!("  🖱️  Mouse click at ({}, {})", mouse_event.position.x, mouse_event.position.y);
                        }
                    }
                    _ => {
                        other_count += 1;
                    }
                }
            }
        } => {
            println!("\n📡 Event stream ended");
        }
    }

    // Step 4: Stop recording
    recorder.stop().await?;

    // Step 5: Display summary
    println!();
    println!("📊 RECORDING SUMMARY");
    println!("===================");
    println!("  ⌨️  Keyboard events: {keyboard_count}");
    println!("  🎯 Text completion events: {text_completion_count}");
    println!("  🖱️  Mouse events: {mouse_count}");
    println!("  📋 Other events: {other_count}");
    println!(
        "  📈 Total events: {}",
        keyboard_count + text_completion_count + mouse_count + other_count
    );
    println!();

    if text_completion_count > 0 {
        println!("✅ SUCCESS! Text input completion events were captured!");
        println!("   The workflow recorder successfully aggregated individual keystrokes");
        println!("   into high-level semantic events showing what text was entered where.");
        println!();
        println!("💡 Key Benefits:");
        println!("   • High-level workflow understanding (what was typed)");
        println!("   • Reduced noise (fewer events to process)");
        println!("   • Semantic meaning (field names, input methods)");
        println!("   • Better automation replay capabilities");
    } else {
        println!("ℹ️  No text input completion events were captured.");
        println!("   This might be because:");
        println!("   • No text was typed in input fields");
        println!("   • Text was typed too quickly (less than 2 second timeout)");
        println!("   • Text was typed in unsupported applications");
        println!("   • Try typing in Notepad, browser forms, or VS Code");
    }

    println!();
    println!("🎉 Demo completed!");

    Ok(())
}
