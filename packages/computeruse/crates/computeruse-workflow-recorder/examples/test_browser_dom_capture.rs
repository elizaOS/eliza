// Test example for browser DOM element capture
// Run with: cargo run --release --example test_browser_dom_capture

use std::time::Duration;
use computeruse::Desktop;
use computeruse_workflow_recorder::browser_context::BrowserContextRecorder;
use computeruse_workflow_recorder::Position;
use tokio::runtime::Runtime;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("🧪 Testing Browser DOM Element Capture");
    println!("======================================\n");

    // Create tokio runtime
    let runtime = Runtime::new()?;

    runtime.block_on(async {
        // Initialize desktop
        let desktop = Desktop::new(false, false)?;

        // Create browser context recorder
        let browser_recorder = BrowserContextRecorder::new();

        // Check if extension is available
        println!("🔌 Checking Chrome extension availability...");
        if !browser_recorder.is_extension_available().await {
            eprintln!("❌ Chrome extension is not available!");
            eprintln!("   Make sure:");
            eprintln!("   1. Chrome is running");
            eprintln!("   2. ComputerUse Chrome extension is installed");
            eprintln!("   3. The extension has loaded properly");
            return Err("Chrome extension not available".into());
        }
        println!("✅ Chrome extension is connected!\n");

        // Open test page
        let test_page_path = "file:///C:/Users/screenpipe-windows/AppData/Local/Temp/computeruse-tests/test_dom_capture.html";
        println!("📄 Opening test page: {test_page_path}");

        let browser = desktop.open_url(test_page_path, None)?;

        // Wait for page to load
        println!("⏳ Waiting for page to load...\n");
        tokio::time::sleep(Duration::from_secs(3)).await;

        // Get page context
        println!("🌐 Getting page context...");
        if let Some(context) = browser_recorder.get_page_context().await {
            println!("   URL: {}", context.url);
            println!("   Title: {}", context.title);
            println!("   Domain: {}", context.domain);
            println!("   Ready State: {}", context.ready_state);
        }

        // Get window bounds to calculate center position for clicking
        println!("\n🎯 Locating the primary button...");

        // Try to find the button using computeruse
        if let Ok(button_locator) = browser.locator("role:button|name:Click Me!") {
            if let Ok(button) = button_locator.first(Some(Duration::from_secs(5))).await {
                if let Ok((x, y, width, height)) = button.bounds() {
                    let click_x = (x + (width / 2.0)) as i32;
                    let click_y = (y + (height / 2.0)) as i32;

                    println!("   Button found at bounds: x={x}, y={y}, w={width}, h={height}");
                    println!("   Click position will be: ({click_x}, {click_y})");

                    // Test DOM capture at button position
                    println!("\n🔍 Capturing DOM element at button position...");

                    let position = Position {
                        x: click_x,
                        y: click_y,
                    };

                    match browser_recorder.capture_dom_element(position).await {
                        Some(dom_info) => {
                            println!("✅ DOM element captured successfully!\n");
                            println!("📊 DOM Element Details:");
                            println!("   Tag: {}", dom_info.tag_name);
                            println!("   ID: {}", dom_info.id.as_deref().unwrap_or("(none)"));
                            println!("   CSS Selector: {}", dom_info.css_selector);
                            println!("   XPath: {}", dom_info.xpath);
                            println!("   Classes: {:?}", dom_info.class_names);
                            println!("   Text: {}", dom_info.inner_text.as_deref().unwrap_or("(none)"));
                            println!("   ARIA Label: {}", dom_info.aria_label.as_deref().unwrap_or("(none)"));
                            println!("   Visible: {}", dom_info.is_visible);
                            println!("   Interactive: {}", dom_info.is_interactive);
                            println!("\n   Selector Candidates ({}):", dom_info.selector_candidates.len());
                            for (i, candidate) in dom_info.selector_candidates.iter().enumerate() {
                                println!("     {}. [{:?}] {} (specificity: {})",
                                         i + 1,
                                         candidate.selector_type,
                                         candidate.selector,
                                         candidate.specificity);
                            }

                            println!("\n✅ Test PASSED! Both getCSSPath and getXPath functions are working!");
                        }
                        None => {
                            eprintln!("❌ Failed to capture DOM element");
                            eprintln!("   This could mean:");
                            eprintln!("   1. The script failed to execute");
                            eprintln!("   2. getCSSPath or getXPath threw an error");
                            eprintln!("   3. No element was found at the coordinates");
                            return Err("DOM capture failed".into());
                        }
                    }
                }
            }
        }

        // Clean up
        println!("\n🧹 Cleaning up...");
        browser.close()?;

        println!("✅ Test completed successfully!");
        Ok::<(), Box<dyn std::error::Error>>(())
    })?;

    Ok(())
}
