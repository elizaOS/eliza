#![cfg(target_os = "windows")]

use std::time::Duration;
use tracing::info;

// Test the double click tracker logic directly
#[tokio::test]
async fn test_double_click_tracker_integration() {
    use computeruse_workflow_recorder::structs::DoubleClickTracker;
    use computeruse_workflow_recorder::{MouseButton, Position};

    let _ = tracing_subscriber::fmt::try_init();

    info!("🧪 Testing DoubleClickTracker integration...");

    let mut tracker = DoubleClickTracker::new();
    let position = Position { x: 100, y: 100 };
    let button = MouseButton::Left;

    // Test sequence: first click, then second click within threshold
    let time1 = std::time::Instant::now();
    let is_double1 = tracker.is_double_click(button, position, time1);
    assert!(!is_double1, "First click should not be double click");

    // Second click within threshold
    let time2 = time1 + Duration::from_millis(200); // Within 500ms threshold
    let is_double2 = tracker.is_double_click(button, position, time2);
    assert!(
        is_double2,
        "Second click within threshold should be double click"
    );

    // Third click should not be double click (different threshold)
    let time3 = time2 + Duration::from_millis(300);
    let is_double3 = tracker.is_double_click(button, position, time3);
    assert!(!is_double3, "Third click should not be double click");

    info!("✅ DoubleClickTracker integration test passed!");
}
