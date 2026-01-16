//! Simple Dataiku Element Extraction Example
//!
//! This demonstrates the new simplified approach:
//! 1. Open browser to Dataiku page  
//! 2. Call element.execute_browser_script() with JavaScript
//! 3. Get the result directly - no complex setup needed!
//!
//! The script execution:
//! - Opens dev tools with F12
//! - Switches to console tab  
//! - Runs your JavaScript
//! - Copies the result from console
//! - Closes dev tools
//! - Returns the result as a string

use std::time::Duration;
use computeruse::{Browser, Desktop};
use tokio::time::sleep;
use tracing::info;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize logging
    tracing_subscriber::fmt::init();

    info!("🚀 Simple Dataiku Element Extraction Example");

    // Create desktop instance
    let desktop = Desktop::new(false, true)?;

    // Target Dataiku page
    let target_url = "https://pages.dataiku.com/guide-to-ai-agents";

    println!("🌐 Opening Dataiku page: {target_url}");

    // Open browser
    let browser_element = desktop.open_url(target_url, Some(Browser::Edge))?;

    println!("⏳ Waiting for page to load...");
    sleep(Duration::from_secs(5)).await;

    // Example 1: Get page title
    println!("\n🔍 Example 1: Getting page title");
    let title_script = "document.title";
    match browser_element.execute_browser_script(title_script).await {
        Ok(title) => println!("📄 Page title: {title}"),
        Err(e) => println!("❌ Error: {e}"),
    }

    // Example 2: Get specific element by ID (Dataiku form)
    println!("\n🔍 Example 2: Getting Dataiku form element HTML");
    let form_script = r#"
        const formElement = document.getElementById('hs_form_target_form_735002917');
        if (formElement) {
            formElement.outerHTML.substring(0, 500) + '...';
        } else {
            'Form element not found';
        }
    "#;

    match browser_element.execute_browser_script(form_script).await {
        Ok(html) => {
            if html.contains("not found") {
                println!("ℹ️  Form element not found on this page");
            } else {
                println!("🎉 Found form element!");
                println!("📊 HTML: {html}");
            }
        }
        Err(e) => println!("❌ Error: {e}"),
    }

    // Example 3: Get element by class name
    println!("\n🔍 Example 3: Getting hero banner element");
    let hero_script = r#"
        const heroElement = document.querySelector('.hero-banner__title');
        if (heroElement) {
            'Found: ' + heroElement.textContent.substring(0, 100);
        } else {
            'Hero banner not found';
        }
    "#;

    match browser_element.execute_browser_script(hero_script).await {
        Ok(result) => println!("📄 Hero banner: {result}"),
        Err(e) => println!("❌ Error: {e}"),
    }

    // Example 4: Get comprehensive page analysis
    println!("\n🔍 Example 4: Comprehensive page analysis");
    let analysis_script = r#"
        JSON.stringify({
            title: document.title,
            url: window.location.href,
            totalForms: document.querySelectorAll('form').length,
            hsFormElements: document.querySelectorAll('[id*="hs_form"]').length,
            hasTargetForm: document.getElementById('hs_form_target_form_735002917') !== null,
            hasHeroTitle: document.querySelector('.hero-banner__title') !== null
        }, null, 2)
    "#;

    match browser_element
        .execute_browser_script(analysis_script)
        .await
    {
        Ok(analysis) => {
            println!("📊 Page analysis:");
            println!("{analysis}");
        }
        Err(e) => println!("❌ Error: {e}"),
    }

    // Example 5: Custom element extraction
    println!("\n🔍 Example 5: Custom element extraction");
    let custom_script = r#"
        // Find all interesting elements and return their info
        const elements = [];
        
        // Look for forms
        document.querySelectorAll('form').forEach(form => {
            elements.push({
                type: 'form',
                id: form.id || 'no-id',
                action: form.action || 'no-action'
            });
        });
        
        // Look for buttons
        document.querySelectorAll('button').forEach(button => {
            elements.push({
                type: 'button', 
                text: button.textContent.substring(0, 50),
                id: button.id || 'no-id'
            });
        });
        
        JSON.stringify({
            timestamp: new Date().toISOString(),
            elementsFound: elements.length,
            elements: elements.slice(0, 10) // First 10 elements
        }, null, 2)
    "#;

    match browser_element.execute_browser_script(custom_script).await {
        Ok(result) => {
            println!("📋 Custom extraction result:");
            println!("{result}");
        }
        Err(e) => println!("❌ Error: {e}"),
    }

    println!("\n✨ Example completed!");
    println!("\n🔧 Key benefits of this approach:");
    println!("  ✅ Single function: element.execute_browser_script()");
    println!("  ✅ No remote debugging port setup needed");
    println!("  ✅ Works with any JavaScript - you write the extraction logic");
    println!("  ✅ Direct keyboard automation - reliable and simple");
    println!("  ✅ Returns results as strings ready to use");

    Ok(())
}
