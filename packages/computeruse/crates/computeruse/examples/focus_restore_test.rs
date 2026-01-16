//! Test script for keyboard focus and caret position restoration
//!
//! Run with: cargo run --example focus_restore_test -p computeruse-rs
//!
//! Test scenario:
//! 1. Opens Notepad, types text, positions cursor in middle
//! 2. Saves focus and caret position
//! 3. Opens another Notepad (stealing focus)
//! 4. Restores focus and caret to original Notepad
//! 5. Verifies cursor is back where it was

#![allow(
    dead_code,
    unused_imports,
    unused_must_use,
    clippy::zombie_processes,
    clippy::to_string_in_format_args
)]

use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

#[cfg(target_os = "windows")]
fn main() {
    println!("=== Simple Caret + Mouse Restore Test ===\n");
    println!("INSTRUCTIONS:");
    println!("  1. Click in Notepad or Chrome text field");
    println!("  2. Position your caret where you want");
    println!("  3. Wait 5 seconds - test will save and restore\n");

    std::thread::sleep(std::time::Duration::from_secs(5));

    unsafe {
        test_simple_save_restore();
    }
}

#[cfg(target_os = "windows")]
unsafe fn test_simple_save_restore() {
    use windows::core::BOOL;
    use windows::Win32::Foundation::POINT;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    };
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationTextPattern2, IUIAutomationTextRange,
        UIA_TextPattern2Id,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, SetCursorPos};

    // Initialize COM
    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

    let automation: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
        .expect("Failed to create UIAutomation");

    // === SAVE ===
    println!("=== SAVING ===");
    let save_start = Instant::now();

    // Save mouse
    let t0 = Instant::now();
    let mut saved_mouse = POINT { x: 0, y: 0 };
    let _ = GetCursorPos(&mut saved_mouse);
    println!(
        "  - GetCursorPos: {:?} -> ({}, {})",
        t0.elapsed(),
        saved_mouse.x,
        saved_mouse.y
    );

    // Save focused element + caret
    let t1 = Instant::now();
    let focused = automation
        .GetFocusedElement()
        .expect("GetFocusedElement failed");
    println!("  - GetFocusedElement: {:?}", t1.elapsed());

    if let Ok(name) = focused.CurrentName() {
        println!("    Name: '{}'", name);
    }
    if let Ok(ctrl_type) = focused.CurrentControlType() {
        println!("    Control type: {}", ctrl_type.0);
    }

    let t2 = Instant::now();
    let saved_caret: Option<IUIAutomationTextRange> = if let Ok(pattern) =
        focused.GetCurrentPatternAs::<IUIAutomationTextPattern2>(UIA_TextPattern2Id)
    {
        let pattern_time = t2.elapsed();
        let t3 = Instant::now();
        let mut is_active = BOOL::default();
        if let Ok(range) = pattern.GetCaretRange(&mut is_active) {
            let caret_time = t3.elapsed();
            let t4 = Instant::now();
            let cloned = range.Clone().ok();
            println!("  - GetCurrentPatternAs<TextPattern2>: {:?}", pattern_time);
            println!(
                "  - GetCaretRange: {:?} (active: {})",
                caret_time,
                is_active.as_bool()
            );
            println!("  - Clone: {:?}", t4.elapsed());
            cloned
        } else {
            println!("  - GetCurrentPatternAs<TextPattern2>: {:?}", pattern_time);
            println!("  - GetCaretRange: FAILED");
            None
        }
    } else {
        println!("  TextPattern2: NOT supported (focus-only fallback)");
        None
    };

    println!("  Save time: {:?}", save_start.elapsed());

    // === TYPE INTO NOTEPAD ===
    println!("\n=== TYPING INTO NOTEPAD ===");

    // Spawn a new Notepad instance and type into it
    use std::process::Command;
    let _ = Command::new("notepad.exe").spawn();
    thread::sleep(Duration::from_millis(1000)); // Wait for Notepad to open

    // Find the Notepad window and bring to front
    use windows::core::w;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, SetForegroundWindow};

    // Win11 Notepad class name
    let notepad_hwnd = FindWindowW(w!("Notepad"), None)
        .ok()
        .filter(|h| *h != HWND(std::ptr::null_mut()));

    if let Some(hwnd) = notepad_hwnd {
        let _ = SetForegroundWindow(hwnd);
        thread::sleep(Duration::from_millis(300));

        // Click in the center of the window to focus the text area
        let mut rect = windows::Win32::Foundation::RECT::default();
        let _ = windows::Win32::UI::WindowsAndMessaging::GetWindowRect(hwnd, &mut rect);
        let center_x = (rect.left + rect.right) / 2;
        let center_y = (rect.top + rect.bottom) / 2;

        // Click to focus the text area
        click_at(center_x, center_y);
        thread::sleep(Duration::from_millis(200));

        type_text("<<AUTOMATION TYPED THIS>>");
        println!("  Typed into Notepad at ({}, {})!", center_x, center_y);
    } else {
        println!("  No Notepad found, skipping type");
    }
    thread::sleep(Duration::from_millis(500));

    // Move mouse to prove it changed
    let _ = SetCursorPos(100, 100);
    println!("  Mouse moved to (100, 100)");

    // === RESTORE ===
    println!("\n=== RESTORING ===");
    let restore_start = Instant::now();

    // Restore focus
    let t5 = Instant::now();
    let _ = focused.SetFocus();
    println!("  - SetFocus: {:?}", t5.elapsed());

    // Restore caret if we have it
    if let Some(ref range) = saved_caret {
        thread::sleep(Duration::from_millis(50)); // let focus settle
        let t6 = Instant::now();
        let _ = range.Select();
        println!("  - Select (caret restore): {:?}", t6.elapsed());
    }

    // Restore mouse
    let t7 = Instant::now();
    let _ = SetCursorPos(saved_mouse.x, saved_mouse.y);
    println!(
        "  - SetCursorPos: {:?} -> ({}, {})",
        t7.elapsed(),
        saved_mouse.x,
        saved_mouse.y
    );

    println!(
        "  Total restore: {:?} (includes 50ms settle delay)",
        restore_start.elapsed()
    );
    println!("\n=== DONE ===");
}

#[cfg(target_os = "windows")]
unsafe fn test_textpattern2_with_mouse_restore() {
    use windows::core::w;
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, POINT};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    };
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationTextPattern2, IUIAutomationTextRange,
        UIA_TextPattern2Id,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{VK_HOME, VK_RIGHT};
    use windows::Win32::UI::WindowsAndMessaging::{
        FindWindowW, GetCursorPos, SetCursorPos, SetForegroundWindow, ShowWindow, SW_RESTORE,
    };

    // Initialize COM
    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

    let automation: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
        .expect("Failed to create UIAutomation");

    // Step 1: Open Notepad #1 and set up text with caret in middle
    println!("Step 1: Opening Notepad #1, typing text, positioning caret...");
    Command::new("notepad.exe")
        .spawn()
        .expect("Failed to open notepad");
    thread::sleep(Duration::from_secs(1));

    // Activate it
    match FindWindowW(w!("Notepad"), None) {
        Ok(hwnd) if hwnd != HWND(std::ptr::null_mut()) => {
            let _ = ShowWindow(hwnd, SW_RESTORE);
            let _ = SetForegroundWindow(hwnd);
        }
        _ => {}
    }
    thread::sleep(Duration::from_millis(300));

    // Type text
    type_text("Hello World - CARET HERE - End of text");
    thread::sleep(Duration::from_millis(200));

    // Move caret to middle (after "Hello World - ")
    send_key(VK_HOME.0);
    thread::sleep(Duration::from_millis(50));
    for _ in 0..14 {
        send_key(VK_RIGHT.0);
        thread::sleep(Duration::from_millis(10));
    }
    thread::sleep(Duration::from_millis(500)); // Give more time for focus to settle
    println!("  [LOG] Caret positioned after 'Hello World - '");

    // Position mouse at known location
    let _ = SetCursorPos(500, 500);
    thread::sleep(Duration::from_millis(100));
    println!("  [LOG] Mouse positioned at (500, 500)");

    // === STEP 2: SAVE BOTH MOUSE AND CARET ===
    println!("\nStep 2: Saving mouse cursor + caret position...");
    let save_start = Instant::now();

    // Save mouse cursor
    let t_mouse = Instant::now();
    let mut saved_mouse = POINT { x: 0, y: 0 };
    let _ = GetCursorPos(&mut saved_mouse);
    println!("  [TIMING] GetCursorPos: {:?}", t_mouse.elapsed());
    println!(
        "  [LOG] Mouse saved at: ({}, {})",
        saved_mouse.x, saved_mouse.y
    );

    // Save focused element + caret via TextPattern2
    let t_focus = Instant::now();
    let focused: windows::Win32::UI::Accessibility::IUIAutomationElement = automation
        .GetFocusedElement()
        .expect("GetFocusedElement failed");
    println!("  [TIMING] GetFocusedElement: {:?}", t_focus.elapsed());

    // Debug: print element info
    if let Ok(name) = focused.CurrentName() {
        println!("  [LOG] Focused element name: '{}'", name);
    }
    if let Ok(ctrl_type) = focused.CurrentControlType() {
        println!("  [LOG] Control type: {}", ctrl_type.0);
    }

    let t_pattern = Instant::now();
    let pattern_result: Result<IUIAutomationTextPattern2, _> =
        focused.GetCurrentPatternAs(UIA_TextPattern2Id);
    println!(
        "  [TIMING] GetCurrentPatternAs<TextPattern2>: {:?}",
        t_pattern.elapsed()
    );

    let saved_caret_range: Option<IUIAutomationTextRange> = match pattern_result {
        Ok(pattern) => {
            println!("  [LOG] TextPattern2 supported!");
            let t_caret = Instant::now();
            let mut is_active = BOOL::default();
            match pattern.GetCaretRange(&mut is_active) {
                Ok(range) => {
                    println!("  [TIMING] GetCaretRange: {:?}", t_caret.elapsed());
                    println!("  [LOG] Caret is active: {}", is_active.as_bool());
                    let t_clone = Instant::now();
                    let cloned = range.Clone().ok();
                    println!("  [TIMING] Clone range: {:?}", t_clone.elapsed());
                    cloned
                }
                Err(e) => {
                    println!("  [ERROR] GetCaretRange failed: {:?}", e);
                    None
                }
            }
        }
        Err(_) => {
            println!("  [WARNING] TextPattern2 not supported - caret restore unavailable");
            None
        }
    };

    let save_time = save_start.elapsed();
    println!("  [TIMING] Total save: {:?}", save_time);

    // === STEP 3: STEAL FOCUS ===
    println!("\nStep 3: Opening Notepad #2 (stealing focus)...");
    Command::new("notepad.exe")
        .spawn()
        .expect("Failed to open notepad #2");
    thread::sleep(Duration::from_millis(800));
    type_text("NOTEPAD #2 - Automation typed here!");
    println!("  [LOG] Typed into Notepad #2");

    // Move mouse elsewhere
    let _ = SetCursorPos(1000, 800);
    println!("  [LOG] Mouse moved to (1000, 800)");
    thread::sleep(Duration::from_millis(300));

    // === STEP 4: RESTORE BOTH ===
    println!("\nStep 4: Restoring focus + caret + mouse cursor...");
    let restore_start = Instant::now();

    // Restore focus
    let t_focus_restore = Instant::now();
    let _ = focused.SetFocus();
    println!("  [TIMING] SetFocus: {:?}", t_focus_restore.elapsed());

    // Restore caret (if we saved it)
    if let Some(ref range) = saved_caret_range {
        thread::sleep(Duration::from_millis(50));
        let t_select = Instant::now();
        let _ = range.Select();
        println!(
            "  [TIMING] Select (restore caret): {:?}",
            t_select.elapsed()
        );
    } else {
        println!("  [LOG] No caret range to restore (focus-only fallback)");
    }

    // Restore mouse cursor
    let t_mouse_restore = Instant::now();
    let _ = SetCursorPos(saved_mouse.x, saved_mouse.y);
    println!("  [TIMING] SetCursorPos: {:?}", t_mouse_restore.elapsed());

    let restore_time = restore_start.elapsed();
    println!("  [TIMING] Total restore: {:?}", restore_time);

    println!("\n=== Test Complete ===");
    println!("Save overhead: {:?}", save_time);
    println!("Restore overhead: {:?}", restore_time);
    println!("\nNotepad #1 should have focus with caret after 'Hello World - '");
    println!(
        "Mouse cursor should be back at ({}, {})",
        saved_mouse.x, saved_mouse.y
    );
}

#[cfg(target_os = "windows")]
unsafe fn test_universal_caret_restore_self_contained() {
    use windows::Win32::Foundation::{HWND, POINT};
    use windows::Win32::Graphics::Gdi::ClientToScreen;
    use windows::Win32::UI::Input::KeyboardAndMouse::{VK_HOME, VK_RIGHT};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetCursorPos, GetForegroundWindow, GetGUIThreadInfo, GetWindowThreadProcessId,
        SetCursorPos, SetForegroundWindow, GUITHREADINFO, GUI_CARETBLINKING,
    };

    // === STEP 1: SETUP Notepad #1 ===
    println!("Step 1: Opening Notepad #1, typing text, positioning caret...");
    Command::new("notepad.exe")
        .spawn()
        .expect("Failed to open notepad #1");
    thread::sleep(Duration::from_millis(800));

    // Type test text
    type_text("Hello World - TYPE HERE - End of line");
    thread::sleep(Duration::from_millis(200));

    // Position caret: go to beginning, then move right 14 times (after "Hello World - ")
    send_key(VK_HOME.0);
    thread::sleep(Duration::from_millis(50));
    for _ in 0..14 {
        send_key(VK_RIGHT.0);
        thread::sleep(Duration::from_millis(10));
    }
    thread::sleep(Duration::from_millis(200));
    println!("  [LOG] Caret positioned after 'Hello World - '");

    // Move mouse to a known position
    let original_mouse = POINT { x: 500, y: 500 };
    let _ = SetCursorPos(original_mouse.x, original_mouse.y);
    thread::sleep(Duration::from_millis(100));
    println!(
        "  [LOG] Mouse positioned at ({}, {})",
        original_mouse.x, original_mouse.y
    );

    // === STEP 2: SAVE ===
    println!("\nStep 2: Saving mouse cursor + caret position...");
    let total_start = Instant::now();

    // Save mouse cursor position
    let t_mouse = Instant::now();
    let mut mouse_pos = POINT { x: 0, y: 0 };
    let _ = GetCursorPos(&mut mouse_pos);
    println!("  [TIMING] GetCursorPos: {:?}", t_mouse.elapsed());
    println!(
        "  [LOG] Mouse cursor at: ({}, {})",
        mouse_pos.x, mouse_pos.y
    );

    // Get foreground window
    let t_fg = Instant::now();
    let fg_window = GetForegroundWindow();
    println!("  [TIMING] GetForegroundWindow: {:?}", t_fg.elapsed());
    println!("  [LOG] Foreground window: {:?}", fg_window);

    // Get GUI thread info (contains caret position)
    let t_gui = Instant::now();
    let thread_id = GetWindowThreadProcessId(fg_window, None);
    let mut gui_info = GUITHREADINFO {
        cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    let gui_result = GetGUIThreadInfo(thread_id, &mut gui_info);
    println!("  [TIMING] GetGUIThreadInfo: {:?}", t_gui.elapsed());

    if gui_result.is_err() {
        println!("  [ERROR] GetGUIThreadInfo failed");
        return;
    }

    let has_caret = (gui_info.flags.0 & GUI_CARETBLINKING.0) != 0;
    println!("  [LOG] Caret blinking: {}", has_caret);
    println!("  [LOG] Caret window: {:?}", gui_info.hwndCaret);
    println!(
        "  [LOG] Caret rect (client): left={}, top={}, right={}, bottom={}",
        gui_info.rcCaret.left,
        gui_info.rcCaret.top,
        gui_info.rcCaret.right,
        gui_info.rcCaret.bottom
    );

    if gui_info.hwndCaret == HWND(std::ptr::null_mut()) {
        println!("  [WARNING] No caret found via GetGUIThreadInfo!");
        println!("  [INFO] This app may use custom caret rendering (Win11 Notepad, WPF, etc.)");
        println!("  [INFO] Falling back to TextPattern2 approach may be needed");
        return;
    }

    // Convert caret position to screen coordinates
    let mut caret_screen = POINT {
        x: gui_info.rcCaret.left,
        y: gui_info.rcCaret.top,
    };
    let _ = ClientToScreen(gui_info.hwndCaret, &mut caret_screen);
    println!(
        "  [LOG] Caret position (screen): ({}, {})",
        caret_screen.x, caret_screen.y
    );

    let save_time = total_start.elapsed();
    println!("  [TIMING] Total save: {:?}", save_time);

    // === STEP 3: STEAL FOCUS ===
    println!("\nStep 3: Opening Notepad #2 (stealing focus)...");
    Command::new("notepad.exe")
        .spawn()
        .expect("Failed to open notepad #2");
    thread::sleep(Duration::from_millis(800));
    type_text("THIS IS NOTEPAD #2 - Automation typed here!");
    println!("  [LOG] Typed into Notepad #2");
    thread::sleep(Duration::from_millis(300));

    // Move mouse somewhere else
    let _ = SetCursorPos(1000, 800);
    println!("  [LOG] Mouse moved to (1000, 800)");

    // === STEP 4: RESTORE ===
    println!("\nStep 4: Restoring...");
    let restore_start = Instant::now();

    // 1. Restore foreground window
    let t_restore_fg = Instant::now();
    let _ = SetForegroundWindow(fg_window);
    println!(
        "  [TIMING] SetForegroundWindow: {:?}",
        t_restore_fg.elapsed()
    );
    thread::sleep(Duration::from_millis(100));

    // 2. Click at caret position to restore text cursor
    let t_click = Instant::now();
    click_at(caret_screen.x, caret_screen.y);
    println!("  [TIMING] Click at caret: {:?}", t_click.elapsed());

    // 3. Restore mouse cursor position
    let t_restore_mouse = Instant::now();
    let _ = SetCursorPos(mouse_pos.x, mouse_pos.y);
    println!("  [TIMING] SetCursorPos: {:?}", t_restore_mouse.elapsed());

    let restore_time = restore_start.elapsed();
    println!("  [TIMING] Total restore: {:?}", restore_time);

    println!("\n=== Test Complete ===");
    println!("Save overhead: {:?}", save_time);
    println!("Restore overhead: {:?}", restore_time);
    println!("\nNotepad #1 should have focus with caret after 'Hello World - '");
    println!(
        "Mouse cursor should be back at ({}, {})",
        mouse_pos.x, mouse_pos.y
    );
}

#[cfg(target_os = "windows")]
fn click_at(x: i32, y: i32) {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_LEFTDOWN,
        MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MOVE, MOUSEINPUT,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};

    unsafe {
        let screen_w = GetSystemMetrics(SM_CXSCREEN) as f64;
        let screen_h = GetSystemMetrics(SM_CYSCREEN) as f64;
        let abs_x = ((x as f64 * 65535.0) / screen_w) as i32;
        let abs_y = ((y as f64 * 65535.0) / screen_h) as i32;

        let inputs = [
            INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 {
                    mi: MOUSEINPUT {
                        dx: abs_x,
                        dy: abs_y,
                        mouseData: 0,
                        dwFlags: MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_MOVE,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
            INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 {
                    mi: MOUSEINPUT {
                        dx: abs_x,
                        dy: abs_y,
                        mouseData: 0,
                        dwFlags: MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_LEFTDOWN,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
            INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 {
                    mi: MOUSEINPUT {
                        dx: abs_x,
                        dy: abs_y,
                        mouseData: 0,
                        dwFlags: MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_LEFTUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
        ];

        SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

#[cfg(target_os = "windows")]
fn activate_notepad_window() {
    use windows::core::w;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        FindWindowW, SetForegroundWindow, ShowWindow, SW_RESTORE,
    };

    unsafe {
        match FindWindowW(w!("Notepad"), None) {
            Ok(hwnd) if hwnd != HWND(std::ptr::null_mut()) => {
                println!("  [LOG] Found Notepad window, activating...");
                ShowWindow(hwnd, SW_RESTORE);
                let _ = SetForegroundWindow(hwnd);
            }
            _ => {
                println!("  [LOG] Could not find Notepad window");
            }
        }
    }
}

#[cfg(target_os = "windows")]
unsafe fn test_self_contained() {
    use windows::core::w;
    use windows::core::BOOL;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    };
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationTextPattern2,
        IUIAutomationTextRange, UIA_TextPattern2Id, UIA_CONTROLTYPE_ID,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{VK_HOME, VK_RIGHT};
    use windows::Win32::UI::WindowsAndMessaging::{
        FindWindowW, SetForegroundWindow, ShowWindow, SW_RESTORE,
    };

    // Initialize COM
    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

    let automation: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
        .expect("Failed to create UIAutomation");

    // Step 1: Open Notepad #1 and set up text with caret in middle
    println!("Step 1: Opening Notepad #1, typing text, positioning caret...");
    Command::new("notepad.exe")
        .spawn()
        .expect("Failed to open notepad");
    thread::sleep(Duration::from_secs(1));

    // Activate it
    match FindWindowW(w!("Notepad"), None) {
        Ok(hwnd) if hwnd != HWND(std::ptr::null_mut()) => {
            let _ = ShowWindow(hwnd, SW_RESTORE);
            let _ = SetForegroundWindow(hwnd);
        }
        _ => {}
    }
    thread::sleep(Duration::from_millis(300));

    // Type text
    type_text("Hello World - CARET SHOULD BE HERE - End of text");
    thread::sleep(Duration::from_millis(200));

    // Move caret to middle (after "Hello World - ")
    send_key(VK_HOME.0);
    thread::sleep(Duration::from_millis(50));
    for _ in 0..14 {
        send_key(VK_RIGHT.0);
        thread::sleep(Duration::from_millis(20));
    }
    thread::sleep(Duration::from_millis(200));
    println!("  [LOG] Caret positioned after 'Hello World - '");

    // Step 2: Save the caret position
    println!("\nStep 2: Saving caret position...");
    let total_start = Instant::now();

    let t_get_focused = Instant::now();
    let notepad1_element: IUIAutomationElement = automation
        .GetFocusedElement()
        .expect("Failed to get focused element");
    println!(
        "  [TIMING] GetFocusedElement: {:?}",
        t_get_focused.elapsed()
    );

    let name = notepad1_element.CurrentName().unwrap_or_default();
    println!("  [LOG] Focused element: '{}'", name.to_string());

    let mut saved_caret_range: Option<IUIAutomationTextRange> = None;

    let t_get_pattern = Instant::now();
    match notepad1_element.GetCurrentPatternAs::<IUIAutomationTextPattern2>(UIA_TextPattern2Id) {
        Ok(text_pattern) => {
            println!(
                "  [TIMING] GetCurrentPatternAs<TextPattern2>: {:?}",
                t_get_pattern.elapsed()
            );
            println!("  [LOG] Element supports TextPattern2!");

            let mut active = BOOL::default();
            let t_get_caret = Instant::now();
            match text_pattern.GetCaretRange(&mut active) {
                Ok(range) => {
                    println!("  [TIMING] GetCaretRange: {:?}", t_get_caret.elapsed());
                    println!("  [LOG] Caret is active: {}", active.as_bool());

                    let t_clone = Instant::now();
                    if let Ok(cloned) = range.Clone() {
                        println!("  [TIMING] Clone range: {:?}", t_clone.elapsed());
                        saved_caret_range = Some(cloned);
                        println!("  [LOG] Caret position SAVED!");
                    }
                }
                Err(e) => println!("  [ERROR] Failed to get caret range: {:?}", e),
            }
        }
        Err(e) => {
            println!("  [ERROR] Element does NOT support TextPattern2: {:?}", e);
        }
    }

    // Step 3: Open Notepad #2 and type (simulate automation stealing focus)
    println!("\nStep 3: Opening Notepad #2 and typing (stealing focus)...");
    Command::new("notepad.exe")
        .spawn()
        .expect("Failed to open notepad");
    thread::sleep(Duration::from_secs(1));

    // Get the new notepad (it should have focus)
    type_text("THIS IS NOTEPAD #2 - Automation typed here!");
    println!("  [LOG] Typed into Notepad #2");
    thread::sleep(Duration::from_millis(300));

    // Verify focus was stolen
    let current: IUIAutomationElement = automation.GetFocusedElement().expect("get focus");
    let curr_name = current.CurrentName().unwrap_or_default();
    println!("  [LOG] Current focus: '{}'", curr_name.to_string());

    // Step 4: Restore focus and caret to Notepad #1
    println!("\nStep 4: Restoring focus and caret to Notepad #1...");

    let t_set_focus = Instant::now();
    match notepad1_element.SetFocus() {
        Ok(_) => {
            println!("  [TIMING] SetFocus: {:?}", t_set_focus.elapsed());
            println!("  [LOG] Focus restored to Notepad #1!");
        }
        Err(e) => println!("  [ERROR] SetFocus() failed: {:?}", e),
    }

    // Restore caret position
    if let Some(range) = saved_caret_range {
        let t_select = Instant::now();
        match range.Select() {
            Ok(_) => {
                println!(
                    "  [TIMING] Select (restore caret): {:?}",
                    t_select.elapsed()
                );
                println!("  [LOG] Caret restored!");
            }
            Err(e) => println!("  [ERROR] Failed to restore caret: {:?}", e),
        }
    } else {
        println!("  [LOG] No caret position saved");
    }

    println!(
        "\n  [TIMING] Save+Restore overhead: {:?}",
        total_start.elapsed()
    );

    println!("\n=== Test Complete ===");
    println!("Check Notepad #1 - caret should be after 'Hello World - '");
    println!("Type something to verify!");
}

#[cfg(target_os = "windows")]
fn type_text(text: &str) {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE,
    };

    for c in text.chars() {
        let inputs = [
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY(0),
                        wScan: c as u16,
                        dwFlags: KEYEVENTF_UNICODE,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY(0),
                        wScan: c as u16,
                        dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
        ];
        unsafe {
            SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

#[cfg(target_os = "windows")]
fn send_key(vk: u16) {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VIRTUAL_KEY,
    };

    let inputs = [
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(vk),
                    wScan: 0,
                    dwFlags: windows::Win32::UI::Input::KeyboardAndMouse::KEYBD_EVENT_FLAGS(0),
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        },
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(vk),
                    wScan: 0,
                    dwFlags: KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        },
    ];
    unsafe {
        SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

#[cfg(not(target_os = "windows"))]
fn main() {
    println!("This test only works on Windows");
}
