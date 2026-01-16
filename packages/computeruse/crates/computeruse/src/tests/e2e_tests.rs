use super::init_tracing;
use crate::{Browser, Desktop};
use serde_json::json;
use std::time::Duration;
use tokio::time::sleep;
use tracing::{debug, error, info};

const API_BASE_URL: &str = "http://localhost:9375";
const TEST_URL: &str = "https://pages.dataiku.com/guide-to-ai-agents";

// Helper function to make API calls
async fn make_api_request(
    endpoint: &str,
    payload: serde_json::Value,
) -> Result<reqwest::Response, reqwest::Error> {
    let client = reqwest::Client::new();
    client
        .post(format!("{API_BASE_URL}{endpoint}"))
        .json(&payload)
        .send()
        .await
}

// Helper function to make GET API calls
async fn make_get_request(endpoint: &str) -> Result<reqwest::Response, reqwest::Error> {
    let client = reqwest::Client::new();
    client.get(format!("{API_BASE_URL}{endpoint}")).send().await
}

#[tokio::test]
#[ignore]
async fn test_fill_edit_elements_http() {
    init_tracing();
    info!("Starting HTTP API test for filling edit elements");

    // 1. Open the website
    info!("Opening URL: {}", TEST_URL);
    let open_url_response = make_api_request(
        "/open_url",
        json!({
            "url": TEST_URL,
            "browser": "chrome"
        }),
    )
    .await
    .unwrap();
    assert!(open_url_response.status().is_success());
    info!("Successfully opened URL");

    // Wait for page load
    info!("Waiting for page load...");
    sleep(Duration::from_secs(2)).await;

    // 2. Get current browser window ID
    info!("Getting current browser window ID...");
    let window_response = make_get_request("/current_browser_window").await.unwrap();
    assert!(window_response.status().is_success());

    let window_data: serde_json::Value = window_response.json().await.unwrap();
    let window_id = window_data["id"]
        .as_str()
        .expect("No window ID in response");
    info!("Got current browser window ID: {}", window_id);

    // 3. Find all edit elements within the current window
    info!("Searching for edit elements in window {}...", window_id);
    let edit_elements_response = make_api_request(
        "/all",
        json!({
            "selector_chain": [
                format!("#{}", window_id),
                "role:edit"
            ],
            "timeout_ms": 5000,
            "depth": 50
        }),
    )
    .await
    .unwrap();
    assert!(edit_elements_response.status().is_success());

    let elements_data: serde_json::Value = edit_elements_response.json().await.unwrap();
    let elements = elements_data["elements"].as_array().unwrap();
    info!("Found {} edit elements", elements.len());

    // Store element IDs and their initial properties for verification
    let mut element_info: Vec<(String, serde_json::Value)> = Vec::new();
    for element in elements {
        if let Some(id) = element["id"].as_str() {
            element_info.push((id.to_string(), element.clone()));
            info!(
                "Found element with ID: {} and properties: {:?}",
                id, element
            );
        }
    }

    // 4. Fill each edit element with test text
    for (index, (element_id, _)) in element_info.iter().enumerate() {
        info!(
            "Processing element {} of {} (ID: {})",
            index + 1,
            element_info.len(),
            element_id
        );

        // Type text into the element
        info!("Attempting to type text into element {}", element_id);
        let type_response = make_api_request(
            "/type_text",
            json!({
                "selector_chain": [
                    format!("#{}", window_id),
                    format!("#{}", element_id)
                ],
                "text": "Test input text",
                "timeout_ms": 10000,
                "use_clipboard": true
            }),
        )
        .await
        .unwrap();

        if !type_response.status().is_success() {
            error!(
                "Failed to type into element {}: {:?}",
                element_id,
                type_response.text().await
            );
            panic!("Failed to type into element with ID: {element_id}");
        }
        info!("Successfully typed text into element {}", element_id);

        // Small delay between typing operations
        sleep(Duration::from_millis(500)).await;
    }
    info!("HTTP API test completed successfully");
}

#[tokio::test]
#[ignore]
async fn test_fill_edit_elements_direct() {
    init_tracing();
    info!("Starting direct Rust test for filling edit elements");

    // 1. Initialize Desktop automation
    info!("Initializing Desktop automation");
    let desktop = Desktop::new(false, false).unwrap();

    // 2. Open the website
    info!("Opening URL: {}", TEST_URL);
    desktop.open_url(TEST_URL, Some(Browser::Chrome)).unwrap();
    info!("Successfully opened URL");

    // Wait for page load
    info!("Waiting for page load...");
    sleep(Duration::from_secs(2)).await;

    // 3. Find all edit elements
    info!("Searching for edit elements...");
    let edit_elements = desktop
        .locator("role:edit")
        .all(Some(Duration::from_secs(5)), Some(50))
        .await
        .unwrap();
    info!("Found {} edit elements", edit_elements.len());

    // 4. Fill each edit element with test text
    for (index, element) in edit_elements.iter().enumerate() {
        let element_id = element.id().unwrap();
        info!(
            "Processing element {} of {} (ID: {})",
            index + 1,
            edit_elements.len(),
            element_id
        );

        // Log element details
        let attrs = element.attributes();
        debug!(
            "Element attributes: role={}, name={:?}, label={:?}",
            attrs.role, attrs.name, attrs.label
        );

        // Check if element is keyboard focusable
        match element.is_keyboard_focusable() {
            Ok(true) => {
                info!(
                    "Element {} is keyboard focusable, proceeding with typing",
                    element_id
                );
            }
            Ok(false) => {
                info!(
                    "Skipping element {} as it's not keyboard focusable",
                    element_id
                );
                continue;
            }
            Err(e) => {
                error!(
                    "Failed to check keyboard focusable state for element {}: {:?}",
                    element_id, e
                );
                continue;
            }
        }

        // Type text into the element
        info!("Attempting to type text into element {}", element_id);
        match element.type_text("Test input text", true) {
            Ok(_) => info!("Successfully typed text into element {}", element_id),
            Err(e) => {
                error!("Failed to type into element {}: {:?}", element_id, e);
                panic!("Failed to type into element with ID: {element_id}: {e:?}");
            }
        }

        // Small delay between typing operations
        sleep(Duration::from_millis(500)).await;
    }
    info!("Direct Rust test completed successfully");
}

#[tokio::test]
#[ignore]
async fn benchmark_find_edit_elements() {
    init_tracing();
    info!("Starting benchmark for finding edit elements");

    // --- HTTP API Benchmark ---
    info!("--- Starting HTTP API Benchmark ---");

    // 1. Open the website
    info!("(HTTP) Opening URL: {}", TEST_URL);
    let open_url_response = make_api_request(
        "/open_url",
        json!({
            "url": TEST_URL,
            "browser": "chrome"
        }),
    )
    .await
    .unwrap();
    assert!(open_url_response.status().is_success());
    info!("(HTTP) Successfully opened URL");
    sleep(Duration::from_secs(2)).await; // Wait for page load

    // 2. Get current browser window ID
    info!("(HTTP) Getting current browser window ID...");
    let window_response = make_get_request("/current_browser_window").await.unwrap();
    assert!(window_response.status().is_success());
    let window_data: serde_json::Value = window_response.json().await.unwrap();
    let window_id = window_data["id"]
        .as_str()
        .expect("No window ID in response");
    info!("(HTTP) Got current browser window ID: {}", window_id);

    // 3. Find all edit elements (Benchmark this part)
    info!(
        "(HTTP) Searching for edit elements in window {}...",
        window_id
    );
    let find_elements_http_start = std::time::Instant::now();
    let edit_elements_response = make_api_request(
        "/all",
        json!({
            "selector_chain": [
                format!("#{}", window_id),
                "role:edit"
            ],
            "timeout_ms": 10000, // Increased timeout for benchmark stability
            "depth": 50,
            "detail_level": "minimal"
        }),
    )
    .await
    .unwrap();
    assert!(edit_elements_response.status().is_success());
    let http_duration = find_elements_http_start.elapsed();

    let elements_data: serde_json::Value = edit_elements_response.json().await.unwrap();
    let elements = elements_data["elements"].as_array().unwrap();
    info!(
        "(HTTP) Found {} edit elements in {:?}",
        elements.len(),
        http_duration
    );
    info!(
        "--- HTTP API Benchmark Completed in {:?} (total for finding elements) ---",
        http_duration
    );

    // Close the browser opened by HTTP API to avoid interference
    // Assuming there's no direct API to close browser via HTTP, manual or OS-level close might be needed
    // For now, we'll proceed, but in a real scenario, ensure a clean state.
    // Consider adding a close_browser API endpoint if needed.
    info!("(HTTP) Benchmark done. Note: Browser window from HTTP test might still be open.");

    // --- Direct Rust API Benchmark ---
    info!("--- Starting Direct Rust API Benchmark ---");

    // 1. Initialize Desktop automation
    info!("(Direct) Initializing Desktop automation");
    let desktop = Desktop::new(false, false).unwrap();

    // 2. Open the website
    info!("(Direct) Opening URL: {}", TEST_URL);
    desktop.open_url(TEST_URL, Some(Browser::Chrome)).unwrap();
    info!("(Direct) Successfully opened URL");
    sleep(Duration::from_secs(2)).await; // Wait for page load

    // Get the current browser window to scope the search
    info!("(Direct) Getting current browser window...");
    let browser_window = desktop.get_current_browser_window().await.unwrap();
    info!(
        "(Direct) Got browser window with ID: {:?}",
        browser_window.id().unwrap_or_default()
    );

    // 3. Find all edit elements (Benchmark this part, scoped to the browser window)
    info!("(Direct) Searching for edit elements within the browser window...");
    let find_elements_direct_start = std::time::Instant::now();
    // Use browser_window.locator(...) to scope the search
    let edit_elements_direct = browser_window
        .locator("role:edit")
        .unwrap()
        .all(Some(Duration::from_secs(10)), Some(50))
        .await
        .unwrap();
    let direct_duration = find_elements_direct_start.elapsed();
    info!(
        "(Direct) Found {} edit elements in {:?}",
        edit_elements_direct.len(),
        direct_duration
    );
    info!(
        "--- Direct Rust API Benchmark Completed in {:?} (total for finding elements) ---",
        direct_duration
    );

    // Cleanup: Close the browser if possible/needed.
    // This might involve finding the browser process and terminating it, or using a browser-specific command.
    // For this example, we'll skip explicit browser closing for the direct API part as well.
    info!("(Direct) Benchmark done.");

    info!("Benchmark for finding edit elements completed.");
    // Here you could add assertions or write results to a file if needed
}
