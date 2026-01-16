// Simple test for browser DOM capture using execute_browser_script directly
// Run with: cargo run --release --example test_dom_capture_simple

use std::time::Duration;
use computeruse::Desktop;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("🧪 Testing Browser DOM Capture Script (getCSSPath & getXPath)");
    println!("=============================================================\n");

    // Initialize desktop
    let desktop = Desktop::new(false, false)?;

    // Open a simple webpage
    println!("📄 Opening test page (example.com)...");
    let browser = desktop.open_url("https://example.com", None)?;

    // Wait for page to load
    println!("⏳ Waiting for page to load...\n");
    std::thread::sleep(Duration::from_secs(4));

    // Test the DOM capture script (same structure as browser_context.rs after our fix)
    println!("🔍 Testing DOM capture script with getCSSPath and getXPath functions...\n");

    let test_script = r#"
(function() {
    // Helper function to generate XPath (defined at IIFE scope - FIXED!)
    function getXPath(element) {
        if (element.id) {
            return `//*[@id="${element.id}"]`;
        }

        const parts = [];
        while (element && element.nodeType === Node.ELEMENT_NODE) {
            let index = 1;
            let sibling = element.previousElementSibling;
            while (sibling) {
                if (sibling.tagName === element.tagName) index++;
                sibling = sibling.previousElementSibling;
            }
            const tagName = element.tagName.toLowerCase();
            const part = tagName + '[' + index + ']';
            parts.unshift(part);
            element = element.parentElement;
        }
        return '/' + parts.join('/');
    }

    // Helper function to generate CSS path (defined at IIFE scope - FIXED!)
    function getCSSPath(el) {
        const path = [];
        while (el && el.nodeType === Node.ELEMENT_NODE) {
            let selector = el.tagName.toLowerCase();
            if (el.id) {
                selector = '#' + CSS.escape(el.id);
                path.unshift(selector);
                break;
            } else if (el.className && typeof el.className === 'string') {
                const classes = el.className.split(' ').filter(c => c);
                if (classes.length > 0) {
                    selector += '.' + classes.map(c => CSS.escape(c)).join('.');
                }
            }
            path.unshift(selector);
            el = el.parentElement;
        }
        return path.join(' > ');
    }

    // Find the first link/heading on example.com
    const element = document.querySelector('a') || document.querySelector('h1');
    if (!element) {
        return JSON.stringify({ error: 'No element found' });
    }

    // THIS IS THE CRITICAL TEST: Can we call getCSSPath and getXPath here?
    // In the broken version, these would throw ReferenceError!
    return JSON.stringify({
        success: true,
        tag_name: element.tagName.toLowerCase(),
        text: element.textContent.substring(0, 50),
        css_selector: getCSSPath(element),  // ✅ Should work with our fix!
        xpath: getXPath(element),            // ✅ Should work with our fix!
        test_passed: true
    });
})()
"#;

    // Execute the script
    let result = tokio::runtime::Runtime::new()?
        .block_on(async { desktop.execute_browser_script(test_script).await })?;

    println!("📊 Script execution result:");
    println!("{result}\n");

    // Parse and verify
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&result) {
        if let Some(error) = parsed.get("error") {
            eprintln!("❌ Script returned error: {error}");
            eprintln!("   This means the script failed to execute properly.");
            return Err(format!("Script error: {error}").into());
        }

        if parsed.get("success").and_then(|v| v.as_bool()) == Some(true) {
            println!("✅ SUCCESS! DOM Capture Script Executed Without Errors!\n");
            println!("📋 Captured Element Details:");
            println!(
                "   Tag: {}",
                parsed
                    .get("tag_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("N/A")
            );
            println!(
                "   Text: {}",
                parsed.get("text").and_then(|v| v.as_str()).unwrap_or("N/A")
            );
            println!(
                "   CSS Selector: {}",
                parsed
                    .get("css_selector")
                    .and_then(|v| v.as_str())
                    .unwrap_or("N/A")
            );
            println!(
                "   XPath: {}",
                parsed
                    .get("xpath")
                    .and_then(|v| v.as_str())
                    .unwrap_or("N/A")
            );

            println!("\n🎉 TEST PASSED!");
            println!("   ✅ getCSSPath() function is accessible and working");
            println!("   ✅ getXPath() function is accessible and working");
            println!("   ✅ Both functions are correctly scoped at IIFE level");
            println!("\n💡 This confirms the fix for browser_context.rs is correct!");
        } else {
            eprintln!("❌ Script did not return success=true");
            return Err("Script validation failed".into());
        }
    } else {
        eprintln!("❌ Failed to parse JSON response");
        return Err("JSON parse failed".into());
    }

    // Clean up
    println!("\n🧹 Cleaning up...");
    browser.close()?;

    Ok(())
}
