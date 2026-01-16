use computeruse::Desktop;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("🚀 Testing browser script execution...");

    // Get desktop and find a browser
    let desktop = Desktop::new_default()?;

    println!("📋 Looking for browser windows...");
    let apps = desktop.applications()?;

    for app in apps {
        let name = app.name().unwrap_or("Unknown".to_string());
        println!("  📱 App: {name}");

        if name.contains("Chrome") || name.contains("Edge") || name.contains("Firefox") {
            println!("🎯 Found browser: {name}");

            // Get the main window
            if let Some(window) = app.window()? {
                println!("🪟 Found browser window, testing script execution...");

                // Test simple JavaScript
                let script = "document.getElementsByClassName('container-fluid body-container')[0].innerText";
                println!("⚡ Executing: {script}");

                match window.execute_browser_script(script).await {
                    Ok(result) => {
                        println!("✅ SUCCESS! Result: {result}");
                        return Ok(());
                    }
                    Err(e) => {
                        println!("❌ FAILED: {e}");
                    }
                }
            }
        }
    }

    println!("❌ No browser found or script execution failed");
    println!("💡 Make sure you have Chrome/Edge open before running this test!");

    Ok(())
}
