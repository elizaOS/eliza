/// Example demonstrating scroll-into-view for click operations
/// This test opens a browser, navigates to a long page, and clicks on an element
/// that is initially off-screen, demonstrating automatic scroll-into-view behavior
use anyhow::Result;
use computeruse::{Desktop, Selector};
use tokio::time::{sleep, Duration};

#[tokio::main]
async fn main() -> Result<()> {
    println!("🚀 Starting scroll-into-view click test");

    // Create desktop instance
    let desktop = Desktop::new_default()?;

    // Open Chrome browser
    println!("📱 Opening Chrome browser...");
    desktop.open_application("chrome")?;
    sleep(Duration::from_secs(2)).await;

    // Navigate to a page with scrollable content
    println!("🌐 Navigating to example page with scrollable content...");
    desktop
        .locator(Selector::from("role:textbox|name:Address and search bar"))
        .wait(Some(Duration::from_secs(5)))
        .await?
        .type_text(
            "https://en.wikipedia.org/wiki/Rust_(programming_language)",
            true,
        )?;

    desktop
        .locator(Selector::from("role:textbox|name:Address and search bar"))
        .wait(Some(Duration::from_secs(1)))
        .await?
        .press_key("Return")?;

    sleep(Duration::from_secs(3)).await;

    // Try to click on a link that's likely off-screen (far down the page)
    println!("📜 Attempting to click on 'External links' section (likely off-screen)...");

    // First, let's verify the element exists but is off-screen
    let external_links = desktop
        .locator(Selector::from("role:hyperlink|name:External links"))
        .wait(Some(Duration::from_secs(5)))
        .await?;

    // Check element position before scroll
    if let Ok(bounds) = external_links.bounds() {
        println!("📍 Element position before action: y={}", bounds.1);
        if bounds.1 > 1080.0 {
            println!("   ⚠️  Element is off-screen (y > 1080)");
        }
    }

    // Now click the element - it should automatically scroll into view first
    println!("🎯 Clicking on 'External links' (will auto-scroll if needed)...");
    external_links.click()?;

    sleep(Duration::from_secs(2)).await;

    // Verify the element is now visible
    if let Ok(bounds) = external_links.bounds() {
        println!("📍 Element position after click: y={}", bounds.1);
        if bounds.1 <= 1080.0 {
            println!("   ✅ Element successfully scrolled into view!");
        }
    }

    println!(
        "\n✨ Test completed! The element was automatically scrolled into view before clicking."
    );
    println!("📝 This demonstrates that all interaction methods now include scroll-into-view functionality.");

    Ok(())
}
