use computeruse_workflow_recorder::{
    ApplicationSwitchEvent, ApplicationSwitchMethod, EventMetadata,
};

fn main() {
    println!("Testing new ApplicationSwitchEvent fields...\n");

    // Create a test event with the new fields
    let event = ApplicationSwitchEvent {
        from_window_and_application_name: Some("*Document1 - Notepad".to_string()),
        to_window_and_application_name: "Wikipedia - Google Chrome".to_string(),
        from_process_name: Some("Notepad.exe".to_string()),
        to_process_name: Some("chrome.exe".to_string()),
        from_process_id: Some(12345),
        to_process_id: 67890,
        switch_method: ApplicationSwitchMethod::AltTab,
        dwell_time_ms: Some(5000),
        switch_count: None,
        metadata: EventMetadata::empty(),
    };

    println!("Event structure:");
    println!(
        "  from_window_and_application_name: {:?}",
        event.from_window_and_application_name
    );
    println!(
        "  to_window_and_application_name: {}",
        event.to_window_and_application_name
    );
    println!("  from_process_name: {:?}", event.from_process_name);
    println!("  to_process_name: {:?}", event.to_process_name);
    println!("  from_process_id: {:?}", event.from_process_id);
    println!("  to_process_id: {}", event.to_process_id);

    // Serialize to JSON to show the actual output format
    let json = serde_json::to_string_pretty(&event).expect("Failed to serialize");
    println!("\nJSON output:");
    println!("{json}");

    println!("\n✅ SUCCESS: All new fields are present and working!");
}
