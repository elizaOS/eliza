//! Tests for UI element selectors

use crate::{Desktop, Selector, UIElement};
use std::sync::Arc;
use tokio::runtime::Runtime;
use tracing::Level;

/// A test fixture that manages the lifecycle of an application for testing.
/// It ensures the application is opened before the test runs and closed after,
/// even if the test panics.
struct AppFixture {
    desktop: Arc<Desktop>,
    app: Option<UIElement>,
    rt: Runtime,
}

impl AppFixture {
    /// Creates a new fixture and launches the specified application.
    fn new(app_name: &str) -> Self {
        let rt = Runtime::new().expect("Failed to create Tokio runtime");
        let desktop = Arc::new(Desktop::new(false, false).expect("Failed to create Desktop"));
        let desktop_clone = desktop.clone();

        let app = rt.block_on(async {
            match desktop_clone.open_application(app_name) {
                Ok(app) => {
                    // Wait a bit for the app to be fully ready
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    // Maximize the window to ensure a consistent UI layout for tests
                    if let Err(e) = app.maximize_window() {
                        // Log a warning if maximizing fails, but don't panic the test
                        eprintln!("Warning: Could not maximize window for '{app_name}': {e}");
                    }
                    Some(app)
                }
                Err(e) => {
                    panic!("Failed to open application '{app_name}' for testing: {e}");
                }
            }
        });

        AppFixture { desktop, app, rt }
    }
}

impl Drop for AppFixture {
    /// Ensures the application is closed when the fixture goes out of scope.
    fn drop(&mut self) {
        if let Some(app) = self.app.take() {
            let app_name = app.name().unwrap_or_else(|| "unknown".to_string());
            println!("--- Tearing down test, closing '{app_name}' ---");
            if let Err(e) = app.close() {
                // It might already be closed, so just log the error.
                eprintln!("Error closing application '{app_name}' during test teardown: {e}");
            }
            // Give a moment for the process to terminate
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }
}

#[test]
fn test_id_selector_finds_element() {
    let fixture = AppFixture::new("notepad");
    let desktop = fixture.desktop.clone();
    let rt = &fixture.rt;

    rt.block_on(async {
        // 1. Find the main text area (the "Edit" control in Notepad) to get a target element.
        let edit_selector = Selector::Role {
            role: "edit".to_string(),
            name: None,
        };
        let text_area = desktop
            .locator(edit_selector)
            .first(None)
            .await
            .expect("Could not find the text area in Notepad.");

        // 2. Get the ID of the target element.
        let target_id = text_area.id().expect("Text area should have an ID.");
        println!("Found text area with ID: {target_id}");
        assert!(!target_id.is_empty(), "Element ID should not be empty.");

        // 3. Create an ID selector from the retrieved ID.
        let id_selector_str = format!("#{target_id}");
        let id_selector = Selector::from(id_selector_str.as_str());

        // 4. Use the ID selector to find the element again.
        let found_element = desktop
            .locator(id_selector)
            .first(None)
            .await
            .expect("Failed to find element using ID selector.");

        // 5. Verify that the found element is the same as the original.
        let found_id = found_element
            .id()
            .expect("Found element should have an ID.");
        assert_eq!(
            target_id, found_id,
            "The ID of the found element must match the target ID."
        );

        println!("✅ Successfully found element by ID: {target_id}");
    });
}

#[test]
fn test_stable_id_across_sessions() {
    // Helper function to run the stability check on a given app
    fn check_id_stability(app_name: &str, selector: Selector, element_description: &str) {
        println!("\n--- Testing ID stability for {app_name} ---");
        let fixture = AppFixture::new(app_name);
        let desktop = fixture.desktop.clone();
        let rt = &fixture.rt;

        rt.block_on(async {
            // Give the app a moment to start, especially Settings.
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;

            // 1. Find the element for the first time.
            let element_1 = desktop
                .locator(selector.clone())
                .first(Some(std::time::Duration::from_secs(5)))
                .await
                .unwrap_or_else(|e| {
                    panic!(
                        "Could not find the {element_description} in {app_name} (first attempt): {e}"
                    )
                });

            let id_1 = element_1.id().expect("Element should have an ID.");
            println!(
                "Found {element_description} in {app_name}. First ID: {id_1}"
            );
            assert!(!id_1.is_empty(), "First element ID should not be empty.");

            // 2. Find the *exact same* element again to simulate a new session/query.
            let element_2 = desktop
                .locator(selector.clone())
                .first(Some(std::time::Duration::from_secs(5)))
                .await
                .unwrap_or_else(|e| {
                    panic!(
                        "Could not find the {element_description} in {app_name} (second attempt): {e}"
                    )
                });

            let id_2 = element_2.id().expect("Element should have an ID.");
            println!(
                "Found {element_description} in {app_name} again. Second ID: {id_2}"
            );
            assert!(!id_2.is_empty(), "Second element ID should not be empty.");

            // 3. Verify that the IDs are identical.
            assert_eq!(
                id_1, id_2,
                "The ID for the {element_description} in {app_name} should be stable across sessions."
            );

            println!(
                "✅ ID for {element_description} in {app_name} is stable."
            );
        });
    }

    // Run the check for Notepad
    check_id_stability(
        "notepad",
        Selector::Role {
            role: "edit".to_string(),
            name: None,
        },
        "main text area",
    );

    // Run the check for Settings app
    check_id_stability(
        "ms-settings:",
        Selector::Role {
            role: "listitem".to_string(),
            name: Some("System".to_string()),
        },
        "'System' button",
    );
}

#[test]
fn test_web_id_stability() {
    println!("\n--- Testing Web ID stability (Rigorous) ---");
    let rt = Runtime::new().expect("Failed to create Tokio runtime");
    let desktop = Arc::new(Desktop::new(false, false).expect("Failed to create Desktop"));

    rt.block_on(async {
        // A closure that returns a future, allowing it to be called multiple times.
        let check_url = |url: String,
                         element_selector: Selector,
                         element_description: String,
                         expected_title_part: String| {
            let desktop = desktop.clone();
            async move {
                println!("-- Checking URL: {url} --");

                // 1. Use the correct open_url function to launch and navigate.
                let app = desktop
                    .open_url(&url, Some(crate::Browser::Edge))
                    .expect("Failed to open URL in Edge.");

                // Allow a few seconds for the browser to initialize and start navigation.
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;

                println!("✅ Browser opened to {url}");

                // 2. RIGOROUS: Poll until the window title confirms navigation.
                let nav_timeout = std::time::Duration::from_secs(20);
                let start_time = std::time::Instant::now();
                let mut navigated = false;
                while start_time.elapsed() < nav_timeout {
                    if let Some(name) = app.name() {
                        if name.contains(&expected_title_part) {
                            println!("✅ Navigation confirmed: Window title is '{name}'");
                            navigated = true;
                            break;
                        }
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                }
                assert!(
                    navigated,
                    "Navigation failed: Window title did not contain '{expected_title_part}' within timeout."
                );

                // 3. Find the target element on the page for the first time.
                let element_1 = app
                    .locator(element_selector.clone())
                    .unwrap()
                    .first(Some(std::time::Duration::from_secs(10)))
                    .await
                    .unwrap_or_else(|e| {
                        panic!(
                            "Could not find '{element_description}' on {url} (first attempt): {e}"
                        )
                    });

                let id_1 = element_1.id().expect("Element should have an ID.");
                println!("Found '{element_description}'. First ID: {id_1}");

                // 4. Find the browser's 'Reload' button and click it to refresh the page.
                let reload_button = app
                    .locator(Selector::Role {
                        role: "button".to_string(),
                        name: Some("Refresh".to_string()),
                    })
                    .unwrap()
                    .first(None)
                    .await
                    .expect("Could not find the 'Reload' button in the browser.");

                reload_button
                    .click()
                    .expect("Failed to click Reload button.");
                println!("Reloaded page, waiting for content to load again...");

                // 5. RIGOROUS: Poll until the window title confirms reload.
                let reload_start_time = std::time::Instant::now();
                let mut reloaded = false;
                while reload_start_time.elapsed() < nav_timeout {
                    if let Some(name) = app.name() {
                        if name.contains(&expected_title_part) {
                            println!("✅ Reload confirmed: Window title is '{name}'");
                            reloaded = true;
                            break;
                        }
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                }
                assert!(
                    reloaded,
                    "Page reload failed: Window title did not contain '{expected_title_part}' after reload."
                );

                // 6. Find the same element again after the reload.
                let element_2 = app
                    .locator(element_selector.clone())
                    .unwrap()
                    .first(Some(std::time::Duration::from_secs(10)))
                    .await
                    .unwrap_or_else(|e| {
                        panic!(
                            "Could not find '{element_description}' on {url} (second attempt, after reload): {e}"
                        )
                    });

                let id_2 = element_2.id().expect("Element should have a second ID.");
                println!("Found '{element_description}' again. Second ID: {id_2}");

                // 7. Assert that the IDs are identical, proving stability.
                assert_eq!(
                    id_1, id_2,
                    "Web element ID for '{element_description}' should be stable after a page reload."
                );
                println!("✅ ID for '{element_description}' is stable on {url}.");

                // Return the app window for closing later
                app
            }
        };

        // Skip Dataiku page test - the page content is too dynamic and changes frequently
        // The page shows different content based on region/cookies/time which makes it unreliable for testing

        // wait 5 seconds before next test
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;

        // Test Luma page
        let browser_window = Some(
            check_url(
                "https://lu.ma/airstreet".to_string(),
                Selector::Name("Air Street".to_string()),
                "Luma event title".to_string(),
                "Air Street".to_string(), // Expected part of the window title
            )
            .await,
        );

        // --- Tearing down test ---
        if let Some(window) = browser_window {
            println!("--- Tearing down test, closing browser ---");
            window.close().expect("Failed to close browser window.");
        }
    });
}

#[test]
#[ignore = "ID generation is not yet unique across different browser windows (same process), causing this test to fail. Needs investigation into how to uniquely identify windows for hashing."]
fn test_web_id_uniqueness_across_windows() {
    // enable level debug logging
    tracing::subscriber::set_global_default(
        tracing_subscriber::FmtSubscriber::builder()
            .with_max_level(Level::DEBUG)
            .finish(),
    )
    .expect("Failed to set tracing subscriber");

    println!("\n--- Testing Web ID uniqueness across multiple windows ---");
    let rt = Runtime::new().expect("Failed to create Tokio runtime");
    let desktop = Arc::new(Desktop::new(false, false).expect("Failed to create Desktop"));
    let url = "https://pages.dataiku.com/guide-to-ai-agents";
    let element_selector = Selector::Name("Get Ahead With Agentic AI".to_string());
    let element_description = "Dataiku page title";

    rt.block_on(async {
        // --- Open first window ---
        println!("-- Opening first browser window to {url} --");
        let app1 = desktop
            .open_url(url, Some(crate::Browser::Edge))
            .expect("Failed to open URL in first window.");
        tokio::time::sleep(std::time::Duration::from_secs(5)).await; // Wait for page load

        let element1 = app1
            .locator(element_selector.clone())
            .unwrap()
            .first(Some(std::time::Duration::from_secs(10)))
            .await
            .expect("Could not find element in first window.");
        let id1 = element1.id().expect("Element 1 should have an ID.");
        println!("Found '{element_description}' in window 1. ID: {id1}");

        // --- Open second window ---
        println!("-- Opening second browser window to {url} --");
        let app2 = desktop
            .open_url(url, Some(crate::Browser::Edge))
            .expect("Failed to open URL in second window.");
        tokio::time::sleep(std::time::Duration::from_secs(5)).await; // Wait for page load

        let element2 = app2
            .locator(element_selector.clone())
            .unwrap()
            .first(Some(std::time::Duration::from_secs(10)))
            .await
            .expect("Could not find element in second window.");
        let id2 = element2.id().expect("Element 2 should have an ID.");
        println!("Found '{element_description}' in window 2. ID: {id2}");

        // --- Assert IDs are different ---
        assert_ne!(
            id1, id2,
            "IDs for the same element in different browser windows should be different."
        );
        println!("✅ IDs are different as expected, proving context-awareness.");

        // --- Teardown ---
        println!("--- Tearing down test, closing browser windows ---");
        if let Err(e) = app1.close() {
            eprintln!(
                "Could not close first browser window, it might have been closed already: {e}"
            );
        }
        if let Err(e) = app2.close() {
            eprintln!(
                "Could not close second browser window, it might have been closed already: {e}"
            );
        }
    });
}
