use std::time::Duration;
use computeruse::{AutomationError, Desktop, FontStyle, TextPosition};

#[tokio::main]
async fn main() -> Result<(), AutomationError> {
    // Initialize logging
    tracing_subscriber::fmt::init();
    // 1) Open Amazon homepage
    let desktop = Desktop::new(false, false)?;
    let app = desktop.open_url("https://www.amazon.com/", None)?;

    // Allow a short settle time for the page to render dynamic regions
    tokio::time::sleep(Duration::from_millis(800)).await;

    // 2) Candidate selectors for the country/region button (icp-button)
    // Prefer role+name contains to be resilient to locale/wording variations
    let candidates = [
        "role:Button|name:contains:Choose a country",
        "role:Button|name:contains:country/region",
        "role:Button|name:contains:country",
        "role:Pane|name:contains:Amazon >> role:Button|name:contains:Choose a country",
        "role:Pane|name:contains:Amazon >> role:Button|name:contains:country/region",
    ];

    // 3) Locate the first match
    let mut target = None;
    for sel in candidates {
        if let Ok(locator) = app.locator(sel) {
            if let Ok(el) = locator.first(None).await {
                println!("Found element with selector: {sel}");
                target = Some((sel, el));
                break;
            }
        }
    }
    let (selector_used, element) = target.ok_or_else(|| {
        AutomationError::PlatformError("Failed to find Amazon country/region button".to_string())
    })?;

    // 4) Log element bounds if available (skip window-bounds checks)
    if let Ok((ex, ey, ew, eh)) = element.bounds() {
        println!(
            "Selector: {selector_used}\nElement bounds:  x={ex:.0} y={ey:.0} w={ew:.0} h={eh:.0}"
        );
    } else {
        println!("Selector: {selector_used}\nElement bounds: <unavailable>");
    }

    // 5) Highlight (uses internal pre-scroll if element is offscreen)
    let font_style = FontStyle {
        size: 14,
        bold: true,
        color: 0xFFFFFF,
    };
    let _handle = element.highlight(
        Some(0x00FF00),                    // green border (BGR)
        Some(Duration::from_millis(2500)), // 2.5s
        Some("Country/Region"),
        Some(TextPosition::TopRight),
        Some(font_style),
    )?;

    tokio::time::sleep(Duration::from_millis(2600)).await;
    println!("Done");
    Ok(())
}
