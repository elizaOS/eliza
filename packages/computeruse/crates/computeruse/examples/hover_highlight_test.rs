#[cfg(not(target_os = "windows"))]
fn main() -> Result<(), computeruse::AutomationError> {
    eprintln!("This example is currently Windows-only.");
    Ok(())
}

#[cfg(target_os = "windows")]
use std::time::Duration;
#[cfg(target_os = "windows")]
use computeruse::{AutomationError, Desktop, FontStyle, TextPosition};
#[cfg(target_os = "windows")]
use tokio::time::sleep;
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::POINT;
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

#[cfg(target_os = "windows")]
#[tokio::main]
async fn main() -> Result<(), AutomationError> {
    println!("🎯 Testing Real-Time Hover Highlighting");
    println!("{}", "=".repeat(50));

    // Create desktop instance
    let desktop = Desktop::new(false, false)?;

    println!("\n1. Starting hover highlight mode...");
    println!("   Move your mouse around to see elements highlighted!");
    println!("   Press Ctrl+C to exit");

    let mut last_highlighted_element: Option<computeruse::UIElement> = None;
    let mut last_highlight_handle: Option<computeruse::HighlightHandle> = None;

    // Font style for hover text
    let font_style = FontStyle {
        size: 14,
        bold: true,
        color: 0x000000, // Black text
    };

    loop {
        // Get current mouse position
        let mut cursor_pos = POINT { x: 0, y: 0 };
        unsafe {
            let _ = GetCursorPos(&mut cursor_pos);
        }

        // Try to find element at cursor position
        // For now, let's use Calculator as a test app and find elements within it
        let apps = desktop.applications()?;
        if let Some(calculator) = apps.iter().find(|app| {
            app.name()
                .unwrap_or_default()
                .to_lowercase()
                .contains("calculator")
        }) {
            // Get all buttons/elements in Calculator
            match calculator.locator("role:Button") {
                Ok(locator) => {
                    match locator.all(None, None).await {
                        Ok(buttons) => {
                            let mut found_element = None;

                            // Check if cursor is over any button
                            for button in buttons {
                                if let Ok((x, y, width, height)) = button.bounds() {
                                    if cursor_pos.x as f64 >= x
                                        && cursor_pos.x as f64 <= (x + width)
                                        && cursor_pos.y as f64 >= y
                                        && cursor_pos.y as f64 <= (y + height)
                                    {
                                        found_element = Some(button);
                                        break;
                                    }
                                }
                            }

                            // If we found a different element than before, update highlight
                            let element_changed = match (&last_highlighted_element, &found_element)
                            {
                                (None, None) => false,
                                (Some(_), None) | (None, Some(_)) => true,
                                (Some(last), Some(current)) => {
                                    // Compare element identities (simplified check using name and position)
                                    last.name().unwrap_or_default()
                                        != current.name().unwrap_or_default()
                                }
                            };

                            if element_changed {
                                // Close previous highlight
                                if let Some(handle) = last_highlight_handle.take() {
                                    handle.close();
                                }

                                // Start new highlight if we have an element
                                if let Some(ref element) = found_element {
                                    let element_name =
                                        element.name().unwrap_or("Element".to_string());

                                    if let Ok(handle) = element.highlight(
                                        Some(0x0000FF),                      // Red border (BGR format)
                                        None,                                // No auto-close
                                        Some(&format!("🎯 {element_name}")), // Text with element name
                                        Some(TextPosition::Top), // Position above element
                                        Some(font_style.clone()), // Custom font style
                                    ) {
                                        last_highlight_handle = Some(handle);
                                        println!("   📍 Highlighting: {element_name}");
                                    }
                                }

                                last_highlighted_element = found_element;
                            }
                        }
                        Err(_) => {
                            // No buttons found, clear highlight
                            if let Some(handle) = last_highlight_handle.take() {
                                handle.close();
                            }
                            last_highlighted_element = None;
                        }
                    }
                }
                Err(_) => {
                    // Locator creation failed
                }
            }
        }

        // Small delay to avoid overwhelming the system
        sleep(Duration::from_millis(50)).await;
    }
}
