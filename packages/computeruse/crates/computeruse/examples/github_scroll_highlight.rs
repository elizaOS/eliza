use std::time::Duration;
use computeruse::{AutomationError, Desktop, FontStyle, TextPosition};

#[tokio::main]
async fn main() -> Result<(), AutomationError> {
    // 1) Open GitHub
    let desktop = Desktop::new(false, false)?;
    let app = desktop.open_url("https://github.com/", None)?;

    // 2) Try multiple selectors for “More”
    let candidates = [
        "role:Button|name:More",
        "role:Hyperlink|name:More",
        "role:Pane|name:contains:GitHub >> role:Button|name:More",
        "role:Pane|name:contains:GitHub >> role:Hyperlink|name:More",
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
        AutomationError::PlatformError("Failed to find ‘More’ element".to_string())
    })?;

    // 4) Log element bounds if available; skip window-bounds check to avoid failures on some browser setups
    if let Ok((ex, ey, ew, eh)) = element.bounds() {
        println!(
            "Selector: {selector_used}\nElement bounds:  x={ex:.0} y={ey:.0} w={ew:.0} h={eh:.0}"
        );
    } else {
        println!("Selector: {selector_used}\nElement bounds: <unavailable>");
    }

    // 5) Highlight (triggers fast scroll if offscreen)
    let font_style = FontStyle {
        size: 14,
        bold: true,
        color: 0xFFFFFF,
    };
    let _handle = element.highlight(
        Some(0x00FF00),                    // green border (BGR)
        Some(Duration::from_millis(2000)), // 2s
        Some("More"),
        Some(TextPosition::TopRight),
        Some(font_style),
    )?;
    tokio::time::sleep(Duration::from_millis(2200)).await;

    println!("Done");
    Ok(())
}
