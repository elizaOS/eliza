use std::{sync::Arc, thread};

fn start_test_server() -> (String, Arc<tiny_http::Server>) {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    let server_arc = Arc::new(server);
    let server_clone = server_arc.clone();

    thread::spawn(move || {
        for request in server_clone.incoming_requests() {
            let html_content = include_str!("wait_test_page.html");
            let header: tiny_http::Header = "Content-Type: text/html".parse().unwrap();
            let response = tiny_http::Response::from_string(html_content).with_header(header);
            request.respond(response).unwrap();
        }
    });

    (format!("http://127.0.0.1:{port}"), server_arc)
}

#[tokio::test]
#[cfg(target_os = "windows")]
#[ignore = "Flaky in CI - browser accessibility tree mapping is unreliable across environments"]
async fn test_wait_for_element_on_webpage() {
    use std::time::Duration;

    use computeruse::{Desktop, Selector};

    let (server_url, _server) = start_test_server();
    println!("Test server started at: {server_url}");

    let desktop = Desktop::new(false, false).unwrap();

    // Open the local test page
    println!("Opening URL in browser...");
    let browser_window = desktop.open_url(&server_url, None).unwrap();
    println!("Browser window opened successfully");

    // Give browser time to fully load
    tokio::time::sleep(Duration::from_secs(1)).await;

    // Try to find Text elements to see what's initially available
    println!("Checking for initial Text elements...");

    // 1. Test that waiting for a delayed element succeeds
    println!("Creating locator for 'I have arrived!' text...");
    let locator = browser_window
        .locator(Selector::Role {
            role: "Text".to_string(),
            name: Some("I have arrived!".to_string()),
        })
        .unwrap();

    // Wait for up to 5 seconds. The element should appear after 2.
    println!("Waiting for element to appear (max 5 seconds)...");
    let wait_result = locator.wait(Some(Duration::from_secs(5))).await;

    // If it fails, let's check what's wrong
    if wait_result.is_err() {
        println!("Wait failed! Error: {:?}", wait_result.as_ref().err());
        println!("Waiting extra 3 seconds to ensure JavaScript has executed...");
        tokio::time::sleep(Duration::from_secs(3)).await; // Extra wait to ensure JS has run

        // Try to find the element directly after extra wait
        println!("Trying to find element directly after extra wait...");
        let direct_find = browser_window.locator(Selector::Role {
            role: "Text".to_string(),
            name: Some("I have arrived!".to_string()),
        });

        if let Ok(locator) = direct_find {
            // Try to find with immediate timeout
            if let Ok(elem) = locator.first(None).await {
                println!(
                    "Element WAS found after extra wait! Name: {:?}",
                    elem.name()
                );
            } else {
                println!("Element still not found even after extra wait");
            }
        }
    } else {
        println!("Element found successfully!");
    }

    assert!(
        wait_result.is_ok(),
        "wait() should succeed for an element that appears after a delay. Error: {:?}",
        wait_result.err()
    );
    let found_element = wait_result.unwrap();
    assert_eq!(found_element.name().unwrap(), "I have arrived!");

    // 2. Test that waiting for a non-existent element times out
    let locator_non_existent = browser_window
        .locator(Selector::Role {
            role: "Text".to_string(),
            name: Some("non-existent-element".to_string()),
        })
        .unwrap();

    let wait_result_timeout = locator_non_existent
        .wait(Some(Duration::from_secs(1)))
        .await;
    assert!(
        wait_result_timeout.is_err(),
        "wait() should fail for an element that never appears"
    );

    // Verify it's a Timeout error specifically
    match wait_result_timeout.err().unwrap() {
        computeruse::AutomationError::Timeout(_) => {
            // This is the expected outcome
        }
        e => panic!("Expected a Timeout error, but got {e:?}"),
    }

    browser_window.close().unwrap();
}
