use std::sync::LazyLock;
use std::time::Duration;
use computeruse::platforms::AccessibilityEngine;
use computeruse::Browser;
use computeruse::UIElement;
use computeruse::{platforms, AutomationError};
use tracing::{info, Level};

/// Test helper to setup logging for debugging
fn setup_logging() {
    let _ = tracing_subscriber::fmt::Subscriber::builder()
        .with_max_level(Level::DEBUG)
        .try_init();
}

/// Test helper to create engine
fn create_test_engine() -> Result<std::sync::Arc<dyn AccessibilityEngine>, AutomationError> {
    platforms::create_engine(false, false)
}

// Ensures any opened UIElement (app/window) is closed when going out of scope
struct CloseOnDrop<'a>(&'a UIElement);
impl<'a> Drop for CloseOnDrop<'a> {
    fn drop(&mut self) {
        let _ = self.0.close();
    }
}

#[tokio::test]
async fn test_open_url_basic_functionality() -> Result<(), AutomationError> {
    setup_logging();
    let engine = create_test_engine()?;

    // Test with a simple, fast-loading page
    let start = std::time::Instant::now();
    let result = engine.open_url("https://example.com", Some(Browser::Default));
    let elapsed = start.elapsed();

    info!("Basic URL test took: {:?}", elapsed);

    match result {
        Ok(element) => {
            let _guard = CloseOnDrop(&element);
            info!("✅ Successfully opened URL and found element");
            info!("Element name: {:?}", element.name());
            info!("Element role: {}", element.role());
            Ok(())
        }
        Err(e) => {
            info!("❌ Failed to open URL: {}", e);
            Err(e)
        }
    }
}

#[tokio::test]
async fn test_open_url_browser_detection() -> Result<(), AutomationError> {
    setup_logging();
    let engine = create_test_engine()?;

    let test_cases = vec![
        (
            "https://httpbin.org/html",
            Browser::Default,
            "Should work with default browser",
        ),
        (
            "https://httpbin.org/json",
            Browser::Chrome,
            "Chrome browser test",
        ),
        (
            "https://httpbin.org/xml",
            Browser::Firefox,
            "Firefox browser test",
        ),
        (
            "https://httpbin.org/status/200",
            Browser::Edge,
            "Edge browser test",
        ),
    ];

    for (url, browser, description) in test_cases {
        info!("🧪 Testing: {}", description);
        let start = std::time::Instant::now();

        match engine.open_url(url, Some(browser.clone())) {
            Ok(element) => {
                let _guard = CloseOnDrop(&element);
                info!("✅ {} - Success in {:?}", description, start.elapsed());
                info!(
                    "   Element: {} ({})",
                    element.name().unwrap_or("No name".to_string()),
                    element.role()
                );
            }
            Err(e) => {
                info!(
                    "❌ {} - Failed in {:?}: {}",
                    description,
                    start.elapsed(),
                    e
                );

                // Continue testing other browsers instead of failing immediately
                if e.to_string()
                    .contains("ShellExecuteW returned error code: 2")
                {
                    info!("   Browser not installed, continuing...");
                } else if e.to_string().contains("Timeout waiting for") {
                    info!("   Browser detection timeout, this is the issue we're debugging");
                } else {
                    info!("   Unexpected error type");
                }
            }
        }

        // Small delay between tests
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    Ok(())
}

#[tokio::test]
async fn test_browser_window_enumeration() -> Result<(), AutomationError> {
    setup_logging();
    let engine = create_test_engine()?;

    info!("🔍 Testing browser window detection after launch...");

    // First, try to open a URL
    let url = "https://httpbin.org/status/200";
    info!("Opening URL: {}", url);

    match engine.open_url(url, Some(Browser::Default)) {
        Ok(element) => {
            let _guard = CloseOnDrop(&element);
            info!("✅ URL opened successfully")
        }
        Err(e) => info!("❌ URL opening failed: {}", e),
    }

    // Now check what applications are currently running
    info!("📋 Enumerating all applications:");
    match engine.get_applications() {
        Ok(apps) => {
            for (i, app) in apps.iter().enumerate() {
                let name = app.name().unwrap_or("Unknown".to_string());
                let role = app.role();
                info!("  {}: {} ({})", i + 1, name, role);

                // Check if this looks like a browser
                if name.to_lowercase().contains("chrome")
                    || name.to_lowercase().contains("firefox")
                    || name.to_lowercase().contains("edge")
                    || name.to_lowercase().contains("browser")
                {
                    info!("    ^ This looks like a browser window!");
                }
            }
        }
        Err(e) => info!("❌ Failed to get applications: {}", e),
    }

    Ok(())
}

#[tokio::test]
async fn test_browser_search_by_name() -> Result<(), AutomationError> {
    setup_logging();
    let engine = create_test_engine()?;

    info!("🔍 Testing direct browser search methods...");

    let browser_names = vec!["chrome", "firefox", "msedge", "edge"];

    for browser_name in browser_names {
        info!("Searching for browser: {}", browser_name);

        match engine.get_application_by_name(browser_name) {
            Ok(app) => {
                info!(
                    "✅ Found {}: {}",
                    browser_name,
                    app.name().unwrap_or("No name".to_string())
                );
            }
            Err(e) => {
                info!("❌ Could not find {}: {}", browser_name, e);
            }
        }
    }

    Ok(())
}

#[tokio::test]
async fn test_url_title_extraction() -> Result<(), AutomationError> {
    setup_logging();

    info!("🧪 Testing URL title extraction logic...");

    let test_urls = vec![
        "https://example.com",
        "https://httpbin.org/html",
        "https://www.google.com",
        "https://github.com",
    ];

    static TITLE_RE: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"(?is)<title>(.*?)</title>").unwrap());

    for url in test_urls {
        info!("Testing title extraction for: {}", url);

        // Simulate the title extraction logic from open_url
        let url_clone = url.to_string();
        let handle = std::thread::spawn(move || -> Result<String, AutomationError> {
            let client = reqwest::blocking::Client::builder()
                .danger_accept_invalid_certs(true)
                .timeout(Duration::from_secs(10))
                .build()
                .map_err(|e| {
                    AutomationError::PlatformError(format!("Failed to build http client: {e}"))
                })?;

            let html = client
                .get(&url_clone)
                .send()
                .map_err(|e| AutomationError::PlatformError(format!("Failed to fetch url: {e}")))?
                .text()
                .map_err(|e| {
                    AutomationError::PlatformError(format!("Fetched url content is not valid: {e}"))
                })?;

            let title = TITLE_RE
                .captures(&html)
                .and_then(|caps| caps.get(1).map(|m| m.as_str().trim().to_string()))
                .unwrap_or_default();

            Ok(title)
        });

        match handle.join() {
            Ok(Ok(title)) => {
                info!("✅ Title extracted: '{}'", title);
                if title.is_empty() {
                    info!("   ⚠️  Empty title might cause window detection issues");
                }
            }
            Ok(Err(e)) => info!("❌ Title extraction failed: {}", e),
            Err(_) => info!("❌ Title extraction thread panicked"),
        }
    }

    Ok(())
}

#[tokio::test]
async fn test_timeout_scenarios() -> Result<(), AutomationError> {
    setup_logging();
    let engine = create_test_engine()?;

    info!("⏱️  Testing timeout scenarios...");

    // Test with a URL that should timeout or fail
    let start = std::time::Instant::now();
    match engine.open_url("https://httpbin.org/delay/30", Some(Browser::Default)) {
        Ok(_) => info!("✅ Unexpectedly succeeded with slow URL"),
        Err(e) => {
            let elapsed = start.elapsed();
            info!(
                "❌ Failed as expected with slow URL after {:?}: {}",
                elapsed, e
            );

            if elapsed > Duration::from_secs(15) {
                info!("   ⚠️  Timeout took too long, should fail faster");
            } else {
                info!("   ✅ Timeout happened in reasonable time");
            }
        }
    }

    Ok(())
}

#[tokio::test]
async fn test_invalid_url_handling() -> Result<(), AutomationError> {
    setup_logging();
    let engine = create_test_engine()?;

    info!("🚫 Testing invalid URL handling...");

    let invalid_urls = vec![
        "https://thisisnotarealdomainname12345.com",
        "https://localhost:99999",
        "not-a-url",
        "",
    ];

    for url in invalid_urls {
        info!("Testing invalid URL: '{}'", url);
        let start = std::time::Instant::now();

        match engine.open_url(url, Some(Browser::Default)) {
            Ok(_) => info!("❓ Unexpectedly succeeded with invalid URL"),
            Err(e) => {
                info!("✅ Failed as expected after {:?}: {}", start.elapsed(), e);
            }
        }
    }

    Ok(())
}

#[tokio::test]
async fn test_multiple_browser_windows() -> Result<(), AutomationError> {
    setup_logging();
    let engine = create_test_engine()?;

    info!("🪟 Testing multiple browser windows scenario...");

    // Open multiple URLs to create multiple browser windows
    let urls = vec!["https://example.com", "https://httpbin.org/json"];

    for url in urls {
        info!("Opening: {}", url);
        match engine.open_url(url, Some(Browser::Default)) {
            Ok(element) => {
                let _guard = CloseOnDrop(&element);
                info!(
                    "✅ Opened: {} -> {}",
                    url,
                    element.name().unwrap_or("No name".to_string())
                );
            }
            Err(e) => {
                info!("❌ Failed to open {}: {}", url, e);
            }
        }

        // Small delay between opens
        tokio::time::sleep(Duration::from_millis(1000)).await;
    }

    // Now check how many browser windows we can detect
    info!("📊 Checking browser window detection after multiple opens...");
    match engine.get_applications() {
        Ok(apps) => {
            let browser_count = apps
                .iter()
                .filter(|app| {
                    let name = app.name().unwrap_or("".to_string()).to_lowercase();
                    name.contains("chrome")
                        || name.contains("firefox")
                        || name.contains("edge")
                        || name.contains("browser")
                })
                .count();
            info!("Found {} browser-like applications", browser_count);
        }
        Err(e) => info!("❌ Failed to enumerate applications: {}", e),
    }

    Ok(())
}

#[tokio::test]
async fn test_focus_and_current_window() -> Result<(), AutomationError> {
    setup_logging();
    let engine = create_test_engine()?;

    info!("🎯 Testing focus detection after URL open...");

    // Open a URL
    match engine.open_url("https://example.com", Some(Browser::Default)) {
        Ok(element) => {
            let _guard = CloseOnDrop(&element);
            info!("✅ URL opened, now checking focus...");

            // Check what window is currently focused
            match engine.get_current_window().await {
                Ok(window) => {
                    info!(
                        "Current window: {}",
                        window.name().unwrap_or("No name".to_string())
                    );
                }
                Err(e) => {
                    info!("❌ Failed to get current window: {}", e);
                }
            }

            // Check what application is focused
            match engine.get_current_application().await {
                Ok(app) => {
                    info!(
                        "Current application: {}",
                        app.name().unwrap_or("No name".to_string())
                    );
                }
                Err(e) => {
                    info!("❌ Failed to get current application: {}", e);
                }
            }
        }
        Err(e) => {
            info!("❌ Failed to open URL: {}", e);
        }
    }

    Ok(())
}
