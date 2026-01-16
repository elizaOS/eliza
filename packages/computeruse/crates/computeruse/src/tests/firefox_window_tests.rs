use crate::tests::init_tracing;
use crate::{AutomationError, Browser, Desktop, Selector};
use std::time::Duration;

#[tokio::test]
#[ignore]
async fn test_get_firefox_window_tree() -> Result<(), AutomationError> {
    init_tracing();
    let desktop = Desktop::new(false, true)?;

    // Try to find the Firefox window by title.
    // This might need adjustment based on the actual window title.
    // let firefox_window_title_contains = "Best";

    // Now get the tree for the found/active Firefox window.
    // We'll use a common part of Firefox window titles. This might need to be made more robust.
    // Get window tree for Firefox by finding it first
    // let app = desktop
    //     .application("chrome")
    //     .or_else(|_| desktop.application("Chrome"))?;
    // let pid = firefox_app.process_id()?;
    // let window_tree = desktop.get_window_tree(pid, Some(firefox_window_title_contains), None)?;

    // // Write the JSON to a file
    // let json_output = serde_json::to_string_pretty(&window_tree).unwrap();
    // fs::write("firefox_window_tree.json", json_output).expect("Failed to write JSON to file");
    // println!("Window tree written to firefox_window_tree.json");

    // assert!(
    //     !window_tree.children.is_empty(),
    //     "Window tree should have children."
    // );

    let locator = desktop.locator(Selector::Chain(vec![
        Selector::Role {
            role: "Document".to_string(),
            name: Some("Agent Desktop Plus".to_string()),
        },
        // Selector::Text("Ready".to_string()),
        Selector::Role {
            role: "Button".to_string(),
            name: Some("Ready".to_string()),
        },
        // Selector::Role {
        //     role: "ListItem".to_string(),
        //     name: Some("Ready".to_string()),
        // },
    ]));
    let element = locator.first(Some(Duration::from_secs(5))).await?;
    println!("Element: {:?}", element.name_or_empty());

    Ok(())
}

#[tokio::test]
#[ignore]
async fn test_get_browser_url() -> Result<(), AutomationError> {
    init_tracing();
    let desktop = Desktop::new(false, true)?;
    let test_url = "https://www.google.com/";
    let browsers_to_test = [Browser::Chrome, Browser::Firefox, Browser::Edge];

    for browser_name in browsers_to_test {
        println!("Testing URL retrieval in {browser_name:?}");

        let browser_app = match desktop.open_url(test_url, Some(browser_name.clone())) {
            Ok(app) => app,
            Err(e) => {
                println!("Could not open browser {browser_name:?}: {e}. Skipping.");
                continue; // Skip browsers that can't be opened
            }
        };

        tokio::time::sleep(Duration::from_secs(3)).await;

        let url = browser_app.url().unwrap_or_default();

        println!("Retrieved URL from {browser_name:?}: {url:?}");

        assert!(
            url.contains("google.com") || url.contains("www.google.com"),
            "URL should be retrieved from {browser_name:?} and contain 'google.com', but was '{url}'"
        );

        browser_app.close()?;

        tokio::time::sleep(Duration::from_secs(1)).await;
    }

    Ok(())
}
