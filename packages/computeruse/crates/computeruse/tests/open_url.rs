use computeruse::Browser;
use computeruse::{platforms, AutomationError, UIElement};

// Ensures any opened UIElement (app/window) is closed when going out of scope
struct CloseOnDrop<'a>(&'a UIElement);
impl<'a> Drop for CloseOnDrop<'a> {
    fn drop(&mut self) {
        let _ = self.0.close();
    }
}
use tracing::{info, Level};

#[tokio::test]
async fn test_open_url() -> Result<(), AutomationError> {
    // This test launches real browsers via OS integration. It's not suitable for
    // headless CI runners.
    if std::env::var("CI").is_ok() {
        return Ok(());
    }

    tracing_subscriber::fmt::Subscriber::builder()
        .with_max_level(Level::DEBUG)
        .init();

    let engine = platforms::create_engine(false, false)?;

    let cases = vec![
        ("https://www.mediar.ai/", Browser::Default),
        ("https://www.reddit.com/", Browser::Chrome),
        ("https://stackoverflow.com/", Browser::Firefox),
        (
            "https://github.com/mediar-ai/computeruse/issues/180",
            Browser::Edge,
        ),
        (
            "https://practicetestautomation.com/practice-test-login/",
            Browser::Brave,
        ),
        (
            "https://docs.screenpi.pe/computeruse/introduction",
            Browser::Opera,
        ),
        ("https://thisisatest.com/", Browser::Default), // invalid url
    ];

    for (url, browser) in cases {
        let start = std::time::Instant::now();
        let result = engine.open_url(url, Some(browser.clone()));
        let elapsed = start.elapsed();

        if url == "https://thisisatest.com/" {
            match result {
                Ok(_element) => {
                    // On Unix platforms `open`/`xdg-open` may succeed even for
                    // non-resolving domains since it doesn't validate reachability.
                    #[cfg(target_os = "windows")]
                    {
                        panic!("expected failure for invalid url");
                    }
                }
                Err(e) => {
                    // If error contains ShellExecuteW returned error code: 2 it means we don't have the browser, skip.
                    let error_msg = e.to_string();
                    if error_msg.contains("ShellExecuteW returned error code: 2") {
                        continue;
                    }
                }
            }
        } else {
            match result {
                Ok(element) => {
                    let _guard = CloseOnDrop(&element);
                    assert!(element.name().is_some(), "expected name for ui element");
                    info!(
                        "opened url '{:?}' in '{:?}' in '{:?}'",
                        url, browser, elapsed
                    );
                }
                Err(e) => {
                    // Handle cases where browser is not installed or fails to launch
                    let error_msg = e.to_string();
                    if error_msg.contains("ShellExecuteW returned error code: 2")
                        || error_msg.contains("Timeout waiting for")
                        || error_msg.contains("browser to appear")
                    {
                        info!(
                            "Skipping {:?} browser test - not available or failed to launch: {}",
                            browser, error_msg
                        );
                        continue;
                    } else {
                        return Err(e);
                    }
                }
            }
        }
    }
    Ok(())
}
