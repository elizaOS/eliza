use std::{sync::Arc, time::Duration};
use computeruse::UIElement;

// Ensures any opened UIElement (app/window) is closed when going out of scope
struct CloseOnDrop<'a>(&'a UIElement);
impl<'a> Drop for CloseOnDrop<'a> {
    fn drop(&mut self) {
        let _ = self.0.close();
    }
}

fn start_test_server() -> (String, Arc<tiny_http::Server>) {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    let server_arc = Arc::new(server);
    let server_clone = server_arc.clone();

    std::thread::spawn(move || {
        for request in server_clone.incoming_requests() {
            let html_content = include_str!("click_timing_test_page.html");
            let header: tiny_http::Header = "Content-Type: text/html".parse().unwrap();
            let response = tiny_http::Response::from_string(html_content).with_header(header);
            let _ = request.respond(response);
        }
    });

    (format!("http://127.0.0.1:{port}"), server_arc)
}

#[tokio::test]
#[cfg(target_os = "windows")]
#[ignore]
async fn test_click_hover_layout_shift_flaky() {
    use computeruse::{Desktop, Selector};

    let (server_url, _server) = start_test_server();
    let desktop = Desktop::new(false, false).expect("Failed to create Desktop");

    // Open the local test page that triggers a hover-based layout shift
    let browser_window = desktop
        .open_url(&server_url, None)
        .expect("Failed to open test page");
    let _guard = CloseOnDrop(&browser_window);

    // Find the target element (a div with role=button and name "Click Area")
    let target = browser_window
        .locator(Selector::Role {
            role: "Button".to_string(),
            name: Some("Click Area".to_string()),
        })
        .expect("Failed to create locator")
        .first(Some(Duration::from_secs(5)))
        .await
        .expect("Failed to find target element");

    // Attempt a single click. With the new validation implementation, the click should succeed
    // because we now wait for stable bounds before clicking (Playwright-style actionability checks).
    let click_result = target
        .click()
        .expect("Click should succeed with validated implementation");

    // Verify the click used validated approach
    assert!(
        click_result.details.contains("validated=true"),
        "Click should use validated implementation"
    );

    // Give the page a brief moment to process events
    tokio::time::sleep(Duration::from_millis(200)).await;

    // The click should succeed and the page should show "clicked" status
    let clicked_probe = browser_window
        .locator(Selector::Role {
            role: "Text".to_string(),
            name: Some("clicked".to_string()),
        })
        .expect("Failed to create clicked probe locator")
        .first(Some(Duration::from_millis(500)))
        .await;

    // This assertion now expects success because bounds stability prevents the hover layout shift bug
    assert!(
        clicked_probe.is_ok(),
        "Expected click to succeed with validated implementation that waits for stable bounds"
    );
}
