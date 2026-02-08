/// Test to reproduce "Failed to enable debugger domains: Debugger is not attached" error
///
/// This error occurs when:
/// 1. Execute JS on a browser tab (attaches debugger)
/// 2. Tab state changes (close, navigate, or user cancels debugger)
/// 3. Try to execute JS again on same tab (extension thinks it's attached but it's not)
/// 4. Chrome rejects: "Debugger is not attached to the tab with id: XXXXX"
use std::time::Duration;
use computeruse::{Browser, Desktop};

#[tokio::test]
#[ignore] // Extension client connection timeout in CI
async fn test_debugger_stale_state_after_navigation() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("debug")
        .with_test_writer()
        .try_init();

    println!("\n🔍 Testing debugger stale state after navigation...");
    println!("This reproduces: 'Failed to enable debugger domains: Debugger is not attached'");

    let desktop = Desktop::new(false, false).expect("Failed to create Desktop");

    // Step 1: Open a browser tab
    println!("\n1️⃣ Opening browser to https://example.com");
    let browser = desktop
        .open_url("https://example.com", Some(Browser::Chrome))
        .expect("Failed to open browser");

    tokio::time::sleep(Duration::from_secs(3)).await;

    // Step 2: Execute JavaScript (this attaches debugger and enables domains)
    println!("\n2️⃣ Executing first JavaScript (attaches debugger)");
    let script1 = "document.title";
    match browser.execute_browser_script(script1).await {
        Ok(result) => println!("✅ First script succeeded: {result}"),
        Err(e) => {
            println!("❌ First script failed: {e}");
            panic!("First script should succeed");
        }
    }

    // Step 3: Navigate to new URL (this may detach debugger but extension still thinks it's attached)
    println!("\n3️⃣ Navigating to new page (may detach debugger)");
    browser
        .locator("nativeid:4")
        .unwrap()
        .first(Some(Duration::from_secs(2)))
        .await
        .ok();

    // Use keyboard shortcut to focus address bar and navigate
    browser.press_key("{Ctrl}l").ok();
    tokio::time::sleep(Duration::from_millis(500)).await;
    browser.type_text("https://httpbin.org", false).ok();
    browser.press_key("{Enter}").ok();
    tokio::time::sleep(Duration::from_secs(4)).await;

    // Step 4: Try to execute JavaScript again (should trigger the error if state is stale)
    println!("\n4️⃣ Executing second JavaScript (may fail with stale debugger state)");
    let script2 = "document.title";
    match browser.execute_browser_script(script2).await {
        Ok(result) => {
            println!("✅ Second script succeeded: {result}");
            println!("   Extension successfully recovered from potential stale state");
        }
        Err(e) => {
            println!("❌ Second script failed: {e}");
            if e.to_string().contains("Failed to enable debugger domains")
                || e.to_string().contains("Debugger is not attached")
            {
                println!("🎯 REPRODUCED THE ERROR!");
                println!("   This is the 'Debugger is not attached to the tab' error");
            }
            // Don't panic - this error is what we're testing for
        }
    }

    // Clean up
    println!("\n🧹 Cleaning up...");
    browser.close().ok();
}

#[tokio::test]
#[ignore] // Extension client connection timeout in CI
async fn test_debugger_stale_state_after_close_and_reopen() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("debug")
        .with_test_writer()
        .try_init();

    println!("\n🔍 Testing debugger stale state after tab close/reopen...");

    let desktop = Desktop::new(false, false).expect("Failed to create Desktop");

    // Step 1: Open browser and execute script
    println!("\n1️⃣ Opening first tab and executing script");
    let browser1 = desktop
        .open_url("https://example.com", Some(Browser::Chrome))
        .expect("Failed to open browser");
    tokio::time::sleep(Duration::from_secs(3)).await;

    let script = "document.title";
    match browser1.execute_browser_script(script).await {
        Ok(result) => println!("✅ Script on first tab succeeded: {result}"),
        Err(e) => println!("❌ Script on first tab failed: {e}"),
    }

    // Step 2: Close the tab
    println!("\n2️⃣ Closing the tab");
    browser1.close().ok();
    tokio::time::sleep(Duration::from_secs(2)).await;

    // Step 3: Open new tab (might reuse same tab ID internally)
    println!("\n3️⃣ Opening new tab");
    let browser2 = desktop
        .open_url("https://httpbin.org", Some(Browser::Chrome))
        .expect("Failed to open second browser");
    tokio::time::sleep(Duration::from_secs(3)).await;

    // Step 4: Try to execute script (may fail if extension has stale state)
    println!("\n4️⃣ Executing script on new tab");
    match browser2.execute_browser_script(script).await {
        Ok(result) => {
            println!("✅ Script on second tab succeeded: {result}");
            println!("   Extension correctly handled tab replacement");
        }
        Err(e) => {
            println!("❌ Script on second tab failed: {e}");
            if e.to_string().contains("Failed to enable debugger domains")
                || e.to_string().contains("Debugger is not attached")
            {
                println!("🎯 REPRODUCED THE ERROR!");
            }
        }
    }

    // Clean up
    browser2.close().ok();
}

#[tokio::test]
#[ignore] // Extension client connection timeout in CI
async fn test_rapid_script_execution_stale_state() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("debug")
        .with_test_writer()
        .try_init();

    println!("\n🔍 Testing rapid script execution (stress test for stale state)...");

    let desktop = Desktop::new(false, false).expect("Failed to create Desktop");
    let browser = desktop
        .open_url("https://example.com", Some(Browser::Chrome))
        .expect("Failed to open browser");
    tokio::time::sleep(Duration::from_secs(3)).await;

    println!("\n⚡ Executing multiple scripts rapidly...");

    for i in 1..=10 {
        println!("\n  Execution {i}/10");

        // Execute script
        let script = format!("document.title + ' - {i}'");
        match browser.execute_browser_script(&script).await {
            Ok(result) => println!("    ✅ Success: {result}"),
            Err(e) => {
                println!("    ❌ Failed: {e}");
                if e.to_string().contains("Failed to enable debugger domains")
                    || e.to_string().contains("Debugger is not attached")
                {
                    println!("    🎯 REPRODUCED ERROR at iteration {i}");
                }
            }
        }

        // Navigate between executions to stress test state management
        if i % 3 == 0 {
            println!("    🔄 Triggering page refresh");
            browser.press_key("{F5}").ok();
            tokio::time::sleep(Duration::from_secs(2)).await;
        } else {
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    browser.close().ok();
}

#[tokio::test]
#[ignore] // Extension client connection timeout in CI
async fn test_sap_login_scenario() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("debug")
        .with_test_writer()
        .try_init();

    println!("\n🔍 Simulating SAP login workflow scenario...");
    println!("This mimics the error from: Login to SAP step");

    let desktop = Desktop::new(false, false).expect("Failed to create Desktop");

    // Open a page that simulates SAP login (using httpbin for testing)
    println!("\n1️⃣ Opening login page");
    let browser = desktop
        .open_url("https://httpbin.org/forms/post", Some(Browser::Chrome))
        .expect("Failed to open browser");
    tokio::time::sleep(Duration::from_secs(3)).await;

    // Step 1: Check page loaded (like workflow would do)
    println!("\n2️⃣ Checking page loaded");
    let check_script = "document.readyState";
    match browser.execute_browser_script(check_script).await {
        Ok(result) => println!("✅ Page state: {result}"),
        Err(e) => println!("❌ Page check failed: {e}"),
    }

    // Step 2: Fill form fields (simulating SAP login fields)
    println!("\n3️⃣ Filling login form");
    if let Ok(username_field) = browser
        .locator("name:custname")
        .unwrap()
        .first(Some(Duration::from_secs(5)))
        .await
    {
        username_field.click().ok();
        username_field.type_text("testuser", false).ok();
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    // Step 3: Execute JavaScript to validate (like "Logging in to SAP" step)
    println!("\n4️⃣ Executing login validation script");
    let login_script = r#"
        (function() {
            const username = document.querySelector('input[name="custname"]');
            if (!username || !username.value) {
                throw new Error('Username not filled');
            }
            return 'Login validation passed';
        })()
    "#;

    match browser.execute_browser_script(login_script).await {
        Ok(result) => println!("✅ Login validation: {result}"),
        Err(e) => {
            println!("❌ Login validation failed: {e}");
            if e.to_string().contains("Failed to enable debugger domains")
                || e.to_string().contains("Debugger is not attached")
            {
                println!("🎯 REPRODUCED SAP LOGIN ERROR!");
                println!("   This is the same error from your workflow");
            }
        }
    }

    // Step 4: Try another script execution (like post-login navigation check)
    println!("\n5️⃣ Post-login navigation check");
    let nav_script = "window.location.href";
    match browser.execute_browser_script(nav_script).await {
        Ok(result) => println!("✅ Current URL: {result}"),
        Err(e) => {
            println!("❌ Navigation check failed: {e}");
            if e.to_string().contains("Failed to enable debugger domains")
                || e.to_string().contains("Debugger is not attached")
            {
                println!("🎯 ERROR REPRODUCED!");
            }
        }
    }

    browser.close().ok();
}
