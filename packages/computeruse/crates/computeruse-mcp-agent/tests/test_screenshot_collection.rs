//! Tests for screenshot collection from workflow events
//!
//! These tests verify that screenshots emitted during workflow execution
//! are properly collected with metadata (index, timestamp, annotation, element)
//! and can be returned as MCP image content.

#![allow(clippy::type_complexity)]

use serde_json::json;
use std::sync::{Arc, Mutex};
use computeruse_mcp_agent::event_pipe::{create_event_channel, WorkflowEvent};

/// Test that screenshot events are collected with proper metadata
#[tokio::test]
async fn test_screenshot_collection_with_metadata() {
    let (event_tx, mut event_rx) = create_event_channel();

    // Storage for collected screenshots: (index, timestamp, annotation, element, base64)
    let collected_screenshots: Arc<
        Mutex<Vec<(usize, String, Option<String>, Option<String>, String)>>,
    > = Arc::new(Mutex::new(Vec::new()));
    let screenshots_clone = collected_screenshots.clone();

    // Spawn collector task (simulates what run_command does)
    let collector = tokio::spawn(async move {
        let mut index = 0usize;
        while let Some(event) = event_rx.recv().await {
            if let WorkflowEvent::Screenshot {
                base64: Some(b64),
                timestamp,
                annotation,
                element,
                ..
            } = event
            {
                if let Ok(mut screenshots) = screenshots_clone.lock() {
                    screenshots.push((index, timestamp, annotation, element, b64));
                    index += 1;
                }
            }
        }
    });

    // Send multiple screenshot events (simulates workflow emitting screenshots)
    event_tx
        .send(WorkflowEvent::Screenshot {
            path: None,
            base64: Some("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==".to_string()),
            annotation: Some("Step 1: Login screen".to_string()),
            element: Some("role:Button && name:Login".to_string()),
            timestamp: "2025-01-01T00:00:01Z".to_string(),
        })
        .unwrap();

    event_tx
        .send(WorkflowEvent::Screenshot {
            path: None,
            base64: Some("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==".to_string()),
            annotation: Some("Step 2: Dashboard".to_string()),
            element: None,
            timestamp: "2025-01-01T00:00:02Z".to_string(),
        })
        .unwrap();

    event_tx
        .send(WorkflowEvent::Screenshot {
            path: None,
            base64: Some("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==".to_string()),
            annotation: None,
            element: Some("role:TextField".to_string()),
            timestamp: "2025-01-01T00:00:03Z".to_string(),
        })
        .unwrap();

    // Drop sender to close channel
    drop(event_tx);

    // Wait for collector to finish
    collector.await.unwrap();

    // Verify collected screenshots
    let screenshots = collected_screenshots.lock().unwrap();
    assert_eq!(screenshots.len(), 3);

    // Check first screenshot
    let (idx, ts, annotation, element, _) = &screenshots[0];
    assert_eq!(*idx, 0);
    assert_eq!(ts, "2025-01-01T00:00:01Z");
    assert_eq!(annotation, &Some("Step 1: Login screen".to_string()));
    assert_eq!(element, &Some("role:Button && name:Login".to_string()));

    // Check second screenshot
    let (idx, ts, annotation, element, _) = &screenshots[1];
    assert_eq!(*idx, 1);
    assert_eq!(ts, "2025-01-01T00:00:02Z");
    assert_eq!(annotation, &Some("Step 2: Dashboard".to_string()));
    assert_eq!(element, &None);

    // Check third screenshot
    let (idx, ts, annotation, element, _) = &screenshots[2];
    assert_eq!(*idx, 2);
    assert_eq!(ts, "2025-01-01T00:00:03Z");
    assert_eq!(annotation, &None);
    assert_eq!(element, &Some("role:TextField".to_string()));
}

/// Test that screenshots without base64 data are skipped
#[tokio::test]
async fn test_screenshot_collection_skips_path_only() {
    let (event_tx, mut event_rx) = create_event_channel();

    let collected_screenshots: Arc<
        Mutex<Vec<(usize, String, Option<String>, Option<String>, String)>>,
    > = Arc::new(Mutex::new(Vec::new()));
    let screenshots_clone = collected_screenshots.clone();

    let collector = tokio::spawn(async move {
        let mut index = 0usize;
        while let Some(event) = event_rx.recv().await {
            if let WorkflowEvent::Screenshot {
                base64: Some(b64),
                timestamp,
                annotation,
                element,
                ..
            } = event
            {
                if let Ok(mut screenshots) = screenshots_clone.lock() {
                    screenshots.push((index, timestamp, annotation, element, b64));
                    index += 1;
                }
            }
        }
    });

    // Send screenshot with only path (no base64) - should be skipped
    event_tx
        .send(WorkflowEvent::Screenshot {
            path: Some("/tmp/screenshot1.png".to_string()),
            base64: None,
            annotation: Some("Path only screenshot".to_string()),
            element: None,
            timestamp: "2025-01-01T00:00:01Z".to_string(),
        })
        .unwrap();

    // Send screenshot with base64 - should be collected
    event_tx
        .send(WorkflowEvent::Screenshot {
            path: None,
            base64: Some("base64data".to_string()),
            annotation: Some("Base64 screenshot".to_string()),
            element: None,
            timestamp: "2025-01-01T00:00:02Z".to_string(),
        })
        .unwrap();

    drop(event_tx);
    collector.await.unwrap();

    let screenshots = collected_screenshots.lock().unwrap();
    assert_eq!(screenshots.len(), 1);
    assert_eq!(screenshots[0].2, Some("Base64 screenshot".to_string()));
}

/// Test that screenshot metadata can be serialized to JSON for response
#[tokio::test]
async fn test_screenshot_metadata_json_serialization() {
    let screenshots: Vec<(usize, String, Option<String>, Option<String>, String)> = vec![
        (
            0,
            "2025-01-01T00:00:01Z".to_string(),
            Some("First screenshot".to_string()),
            Some("role:Button".to_string()),
            "base64data1".to_string(),
        ),
        (
            1,
            "2025-01-01T00:00:02Z".to_string(),
            None,
            None,
            "base64data2".to_string(),
        ),
    ];

    // Build metadata JSON (as done in run_command)
    let screenshot_metadata: Vec<serde_json::Value> = screenshots
        .iter()
        .map(|(idx, ts, annotation, element, _)| {
            json!({
                "index": idx,
                "timestamp": ts,
                "annotation": annotation,
                "element": element
            })
        })
        .collect();

    let metadata_json = json!(screenshot_metadata);

    // Verify JSON structure
    let arr = metadata_json.as_array().unwrap();
    assert_eq!(arr.len(), 2);

    // First screenshot metadata
    assert_eq!(arr[0]["index"], 0);
    assert_eq!(arr[0]["timestamp"], "2025-01-01T00:00:01Z");
    assert_eq!(arr[0]["annotation"], "First screenshot");
    assert_eq!(arr[0]["element"], "role:Button");

    // Second screenshot metadata (with null values)
    assert_eq!(arr[1]["index"], 1);
    assert_eq!(arr[1]["timestamp"], "2025-01-01T00:00:02Z");
    assert!(arr[1]["annotation"].is_null());
    assert!(arr[1]["element"].is_null());
}

/// Test that non-screenshot events are ignored by the collector
#[tokio::test]
async fn test_screenshot_collection_ignores_other_events() {
    let (event_tx, mut event_rx) = create_event_channel();

    let collected_screenshots: Arc<
        Mutex<Vec<(usize, String, Option<String>, Option<String>, String)>>,
    > = Arc::new(Mutex::new(Vec::new()));
    let screenshots_clone = collected_screenshots.clone();

    let collector = tokio::spawn(async move {
        let mut index = 0usize;
        while let Some(event) = event_rx.recv().await {
            if let WorkflowEvent::Screenshot {
                base64: Some(b64),
                timestamp,
                annotation,
                element,
                ..
            } = event
            {
                if let Ok(mut screenshots) = screenshots_clone.lock() {
                    screenshots.push((index, timestamp, annotation, element, b64));
                    index += 1;
                }
            }
        }
    });

    // Send various non-screenshot events
    event_tx
        .send(WorkflowEvent::Progress {
            current: 1.0,
            total: Some(5.0),
            message: Some("Starting".to_string()),
            timestamp: "2025-01-01T00:00:01Z".to_string(),
        })
        .unwrap();

    event_tx
        .send(WorkflowEvent::StepStarted {
            step_id: "step1".to_string(),
            step_name: "First Step".to_string(),
            step_index: Some(0),
            total_steps: Some(3),
            timestamp: "2025-01-01T00:00:02Z".to_string(),
        })
        .unwrap();

    event_tx
        .send(WorkflowEvent::Log {
            level: "info".to_string(),
            message: "Some log message".to_string(),
            data: None,
            timestamp: "2025-01-01T00:00:03Z".to_string(),
        })
        .unwrap();

    // Send one screenshot
    event_tx
        .send(WorkflowEvent::Screenshot {
            path: None,
            base64: Some("actualscreenshot".to_string()),
            annotation: Some("The only screenshot".to_string()),
            element: None,
            timestamp: "2025-01-01T00:00:04Z".to_string(),
        })
        .unwrap();

    event_tx
        .send(WorkflowEvent::Data {
            key: "result".to_string(),
            value: json!({"status": "ok"}),
            timestamp: "2025-01-01T00:00:05Z".to_string(),
        })
        .unwrap();

    drop(event_tx);
    collector.await.unwrap();

    // Only the screenshot should be collected
    let screenshots = collected_screenshots.lock().unwrap();
    assert_eq!(screenshots.len(), 1);
    assert_eq!(screenshots[0].2, Some("The only screenshot".to_string()));
}

/// Test ordering preservation across multiple screenshots
#[tokio::test]
async fn test_screenshot_ordering_preserved() {
    let (event_tx, mut event_rx) = create_event_channel();

    let collected_screenshots: Arc<
        Mutex<Vec<(usize, String, Option<String>, Option<String>, String)>>,
    > = Arc::new(Mutex::new(Vec::new()));
    let screenshots_clone = collected_screenshots.clone();

    let collector = tokio::spawn(async move {
        let mut index = 0usize;
        while let Some(event) = event_rx.recv().await {
            if let WorkflowEvent::Screenshot {
                base64: Some(b64),
                timestamp,
                annotation,
                element,
                ..
            } = event
            {
                if let Ok(mut screenshots) = screenshots_clone.lock() {
                    screenshots.push((index, timestamp, annotation, element, b64));
                    index += 1;
                }
            }
        }
    });

    // Send 10 screenshots in sequence
    for i in 0..10 {
        event_tx
            .send(WorkflowEvent::Screenshot {
                path: None,
                base64: Some(format!("screenshot_data_{}", i)),
                annotation: Some(format!("Screenshot {}", i)),
                element: None,
                timestamp: format!("2025-01-01T00:00:{:02}Z", i),
            })
            .unwrap();
    }

    drop(event_tx);
    collector.await.unwrap();

    let screenshots = collected_screenshots.lock().unwrap();
    assert_eq!(screenshots.len(), 10);

    // Verify ordering is preserved
    for i in 0..10 {
        assert_eq!(screenshots[i].0, i); // index
        assert_eq!(screenshots[i].1, format!("2025-01-01T00:00:{:02}Z", i)); // timestamp
        assert_eq!(screenshots[i].2, Some(format!("Screenshot {}", i))); // annotation
        assert_eq!(screenshots[i].4, format!("screenshot_data_{}", i)); // base64
    }
}
