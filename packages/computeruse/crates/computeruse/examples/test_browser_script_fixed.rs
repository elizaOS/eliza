//! Test the fixed browser script functionality
//! This tests the console result extraction with the improved methods

use computeruse::{AutomationError, Desktop};

#[tokio::main]
async fn main() -> Result<(), AutomationError> {
    println!("🧪 Testing fixed browser script functionality...");

    let desktop = Desktop::new(true, false)?;

    // Find browser window
    match desktop.locator("role:pane").all(None, None).await {
        Ok(windows) => {
            for window in &windows {
                if let Some(name) = window.name() {
                    if name.contains("Chrome") {
                        println!("🌐 Found Chrome window: {name}");

                        // Test the browser script with a simple command
                        let test_script = "2 + 2";
                        println!("🧮 Testing script: {test_script}");

                        match computeruse::browser_script::execute_script(window, test_script).await
                        {
                            Ok(result) => {
                                println!("✅ Success! Result: {result}");
                                if result.contains("4") {
                                    println!("🎯 Correct mathematical result!");
                                } else {
                                    println!("⚠️ Unexpected result: {result}");
                                }
                            }
                            Err(e) => {
                                println!("❌ Error: {e}");
                            }
                        }
                        break;
                    }
                }
            }
        }
        Err(e) => {
            println!("❌ Failed to find windows: {e}");
        }
    }

    Ok(())
}
