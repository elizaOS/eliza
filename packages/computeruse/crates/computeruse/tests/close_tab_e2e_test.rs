//! End-to-end tests for close_tab functionality
//!
//! These tests require:
//! - Chrome browser installed
//! - ComputerUse browser extension installed and enabled

use std::time::Duration;
use computeruse::extension_bridge::ExtensionBridge;
use computeruse::{Browser, Desktop};
use tracing::info;

/// Test closing a tab by URL
#[tokio::test]
#[ignore = "requires browser with extension installed"]
async fn test_close_tab_by_url() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("debug")
        .with_test_writer()
        .try_init();

    // Initialize the bridge FIRST so extension can connect
    info!("Initializing extension bridge...");
    let bridge = ExtensionBridge::global().await;

    // Wait for extension to connect (it should auto-reconnect)
    info!("Waiting for extension to connect...");
    for i in 0..20 {
        if bridge.is_client_connected().await {
            info!("Extension connected after {}ms", i * 500);
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    if !bridge.is_client_connected().await {
        panic!("Extension did not connect within 10 seconds - is it installed in Chrome?");
    }

    let desktop = Desktop::new(false, false).expect("Failed to create Desktop");

    // Open a test URL
    let test_url = "https://example.com/";
    info!("Opening URL: {}", test_url);

    let element = desktop
        .open_url(test_url, Some(Browser::Chrome))
        .expect("Failed to open URL");

    info!("Opened browser window: {:?}", element.name());

    // Wait for page to load
    tokio::time::sleep(Duration::from_secs(2)).await;

    // Close the tab by URL
    info!("Attempting to close tab by URL: {}", test_url);
    let result = desktop
        .close_tab(None, Some("example.com"), None)
        .await
        .expect("close_tab failed");

    match result {
        Some(closed_info) => {
            info!("Successfully closed tab: {:?}", closed_info);
            assert!(closed_info.closed, "Tab should be marked as closed");
            assert!(
                closed_info
                    .tab
                    .url
                    .as_ref()
                    .map(|u| u.contains("example.com"))
                    .unwrap_or(false),
                "Closed tab URL should contain example.com, got: {:?}",
                closed_info.tab.url
            );
        }
        None => {
            panic!("close_tab returned None - something went wrong");
        }
    }
}

/// Test closing active tab
#[tokio::test]
#[ignore = "requires browser with extension installed"]
async fn test_close_active_tab() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("debug")
        .with_test_writer()
        .try_init();

    let bridge = ExtensionBridge::global().await;

    // Wait for extension
    for _ in 0..20 {
        if bridge.is_client_connected().await {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    if !bridge.is_client_connected().await {
        panic!("Extension not connected");
    }

    let desktop = Desktop::new(false, false).expect("Failed to create Desktop");

    // Open test URL
    desktop
        .open_url("https://httpbin.org/html", Some(Browser::Chrome))
        .expect("Failed to open URL");

    tokio::time::sleep(Duration::from_secs(2)).await;

    // Close active tab
    info!("Closing active tab...");
    let result = desktop
        .close_tab(None, None, None)
        .await
        .expect("close_tab failed");

    assert!(result.is_some(), "Should have closed a tab");
    let closed = result.unwrap();
    info!("Closed: id={}, url={:?}", closed.tab.id, closed.tab.url);
    assert!(closed.closed);
}
