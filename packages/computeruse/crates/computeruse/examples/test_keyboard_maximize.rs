// Test keyboard-based maximize (Win+Up)
use std::thread::sleep;
use std::time::Duration;
use computeruse::Desktop;

#[cfg(not(target_os = "windows"))]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    eprintln!("This example is currently Windows-only.");
    Ok(())
}

#[cfg(target_os = "windows")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("🧪 Testing keyboard maximize (Win+Up)...\n");

    let desktop = Desktop::new(false, true)?;
    let ui_element = desktop.open_application("Calculator")?;

    let (init_x, init_y, init_w, init_h) = ui_element.bounds()?;
    println!("Initial: {init_w}x{init_h} at ({init_x}, {init_y})");

    // Ensure Calculator has focus
    ui_element.activate_window()?;
    sleep(Duration::from_millis(200));

    // Send Win+Up keyboard shortcut to maximize
    println!("\nSending Win+Up to maximize...");

    // Get the keyboard input module
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_LWIN, VK_UP,
    };

    unsafe {
        // Press Win key
        let mut inputs = vec![INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_LWIN,
                    ..Default::default()
                },
            },
        }];

        // Press Up key
        inputs.push(INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_UP,
                    ..Default::default()
                },
            },
        });

        SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);

        sleep(Duration::from_millis(50));

        // Release Up key
        inputs.clear();
        inputs.push(INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_UP,
                    dwFlags: KEYEVENTF_KEYUP,
                    ..Default::default()
                },
            },
        });

        // Release Win key
        inputs.push(INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_LWIN,
                    dwFlags: KEYEVENTF_KEYUP,
                    ..Default::default()
                },
            },
        });

        SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    }

    sleep(Duration::from_millis(500));

    let (final_x, final_y, final_w, final_h) = ui_element.bounds()?;
    println!("\nFinal: {final_w}x{final_h} at ({final_x}, {final_y})");

    if (final_w - init_w).abs() > 100.0 {
        println!("\n✅ SUCCESS: Window maximized via keyboard!");
    } else {
        println!("\n❌ FAILED: Window did not maximize");
    }

    Ok(())
}
