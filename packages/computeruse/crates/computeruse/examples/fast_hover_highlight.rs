#[cfg(not(target_os = "windows"))]
fn main() -> Result<(), computeruse::AutomationError> {
    eprintln!("This example is currently Windows-only.");
    Ok(())
}

#[cfg(target_os = "windows")]
use std::time::{Duration, Instant};
#[cfg(target_os = "windows")]
use computeruse::{AutomationError, Desktop, FontStyle, TextPosition};
#[cfg(target_os = "windows")]
use tokio::time::sleep;
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::POINT;
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

#[cfg(target_os = "windows")]
#[derive(Debug)]
struct CachedElement {
    element: computeruse::UIElement,
    bounds: (f64, f64, f64, f64), // x, y, width, height
    id: String,
    name: String,
}

#[cfg(target_os = "windows")]
#[tokio::main]
async fn main() -> Result<(), AutomationError> {
    println!("⚡ Fast Real-Time Hover Highlighting");
    println!("{}", "=".repeat(50));

    let desktop = Desktop::new(false, false)?;

    println!("\n🚀 Starting optimized hover mode...");
    println!("   Move your mouse around Calculator to see fast highlighting!");
    println!("   Press Ctrl+C to exit");

    let mut cached_elements: Vec<CachedElement> = Vec::new();
    let mut last_highlighted_id: Option<String> = None;
    let mut last_highlight_handle: Option<computeruse::HighlightHandle> = None;
    let mut last_update = Instant::now();
    let mut last_cursor_pos = POINT { x: -1, y: -1 };

    // Font style for hover text
    let font_style = FontStyle {
        size: 12,
        bold: true,
        color: 0x000000, // Black text
    };

    // Cache refresh interval (rebuild element cache every 2 seconds)
    let cache_refresh_interval = Duration::from_secs(2);

    loop {
        let now = Instant::now();

        // Get current mouse position
        let mut cursor_pos = POINT { x: 0, y: 0 };
        unsafe {
            let _ = GetCursorPos(&mut cursor_pos);
        }

        // Skip if mouse hasn't moved (optimization)
        if cursor_pos.x == last_cursor_pos.x && cursor_pos.y == last_cursor_pos.y {
            sleep(Duration::from_millis(100)).await;
            continue;
        }
        last_cursor_pos = cursor_pos;

        // Refresh element cache periodically or on first run
        if cached_elements.is_empty() || (now.duration_since(last_update) > cache_refresh_interval)
        {
            cached_elements.clear();

            // Find Calculator and cache its interactive elements
            let apps = desktop.applications()?;
            if let Some(calculator) = apps.iter().find(|app| {
                app.name()
                    .unwrap_or_default()
                    .to_lowercase()
                    .contains("calculator")
            }) {
                // Cache buttons and other interactive elements
                for selector in &["role:Button", "role:MenuItem"] {
                    if let Ok(locator) = calculator.locator(*selector) {
                        if let Ok(elements) = locator.all(None, None).await {
                            for element in elements {
                                if let Ok(bounds) = element.bounds() {
                                    let id = element
                                        .id()
                                        .unwrap_or_else(|| format!("elem_{:p}", &element));
                                    let name = element.name().unwrap_or("Element".to_string());

                                    cached_elements.push(CachedElement {
                                        element,
                                        bounds,
                                        id,
                                        name,
                                    });
                                }
                            }
                        }
                    }
                }
            }

            last_update = now;
            if !cached_elements.is_empty() {
                println!(
                    "   🔄 Cached {} interactive elements",
                    cached_elements.len()
                );
            }
        }

        // Find element under cursor (fast lookup using cached bounds)
        let mut found_element_id = None;
        let cursor_x = cursor_pos.x as f64;
        let cursor_y = cursor_pos.y as f64;

        for cached in &cached_elements {
            let (x, y, width, height) = cached.bounds;
            if cursor_x >= x && cursor_x <= (x + width) && cursor_y >= y && cursor_y <= (y + height)
            {
                found_element_id = Some(cached.id.clone());
                break;
            }
        }

        // Update highlight only if element changed (debouncing)
        if found_element_id != last_highlighted_id {
            // Close previous highlight
            if let Some(handle) = last_highlight_handle.take() {
                handle.close();
            }

            // Start new highlight if we have an element
            if let Some(element_id) = &found_element_id {
                if let Some(cached) = cached_elements.iter().find(|c| &c.id == element_id) {
                    let text = format!("🎯 {}", cached.name);

                    if let Ok(handle) = cached.element.highlight(
                        Some(0x0000FF),           // Red border
                        None,                     // No auto-close
                        Some(&text),              // Element name
                        Some(TextPosition::Top),  // Above element
                        Some(font_style.clone()), // Font styling
                    ) {
                        last_highlight_handle = Some(handle);
                        println!("   ⚡ {}", cached.name);
                    }
                }
            }

            last_highlighted_id = found_element_id;
        }

        // Optimized polling interval (balanced for responsiveness)
        sleep(Duration::from_millis(100)).await;
    }
}
