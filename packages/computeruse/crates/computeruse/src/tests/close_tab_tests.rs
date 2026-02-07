//! Tests for the close_tab functionality

use crate::extension_bridge::{CloseTabResult, ClosedTabInfo};

#[test]
fn test_close_tab_result_structure() {
    // Test that CloseTabResult can be constructed and serialized
    let result = CloseTabResult {
        closed: true,
        tab: ClosedTabInfo {
            id: 123,
            url: Some("https://example.com".to_string()),
            title: Some("Example Page".to_string()),
            window_id: Some(1),
        },
    };

    assert!(result.closed);
    assert_eq!(result.tab.id, 123);
    assert_eq!(result.tab.url, Some("https://example.com".to_string()));
    assert_eq!(result.tab.title, Some("Example Page".to_string()));
    assert_eq!(result.tab.window_id, Some(1));
}

#[test]
fn test_close_tab_result_serialization() {
    let result = CloseTabResult {
        closed: true,
        tab: ClosedTabInfo {
            id: 456,
            url: Some("https://test.com".to_string()),
            title: None,
            window_id: None,
        },
    };

    // Test JSON serialization
    let json = serde_json::to_string(&result).expect("Should serialize");
    assert!(json.contains("\"closed\":true"));
    assert!(json.contains("\"id\":456"));
    assert!(json.contains("\"url\":\"https://test.com\""));

    // Test deserialization
    let parsed: CloseTabResult = serde_json::from_str(&json).expect("Should deserialize");
    assert!(parsed.closed);
    assert_eq!(parsed.tab.id, 456);
}

#[test]
fn test_close_tab_result_with_null_fields() {
    let json = r#"{"closed":true,"tab":{"id":789,"url":null,"title":null,"windowId":null}}"#;
    let result: CloseTabResult = serde_json::from_str(json).expect("Should parse with nulls");

    assert!(result.closed);
    assert_eq!(result.tab.id, 789);
    assert!(result.tab.url.is_none());
    assert!(result.tab.title.is_none());
    assert!(result.tab.window_id.is_none());
}
