//! Check caret position via GetGUIThreadInfo - works for legacy Win32 carets

fn main() {
    #[cfg(target_os = "windows")]
    unsafe {
        use windows::Win32::Foundation::{HWND, POINT};
        use windows::Win32::Graphics::Gdi::ClientToScreen;
        use windows::Win32::UI::WindowsAndMessaging::{
            GetForegroundWindow, GetGUIThreadInfo, GetWindowThreadProcessId, GUITHREADINFO,
            GUI_CARETBLINKING,
        };

        let fg = GetForegroundWindow();
        println!("Foreground window: {:?}", fg);

        let thread_id = GetWindowThreadProcessId(fg, None);
        println!("Thread ID: {}", thread_id);

        let mut gui = GUITHREADINFO {
            cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };

        if GetGUIThreadInfo(thread_id, &mut gui).is_ok() {
            let blinking = (gui.flags.0 & GUI_CARETBLINKING.0) != 0;
            println!("Caret blinking: {}", blinking);
            println!("Caret window: {:?}", gui.hwndCaret);
            println!(
                "Caret rect (client): ({}, {}) to ({}, {})",
                gui.rcCaret.left, gui.rcCaret.top, gui.rcCaret.right, gui.rcCaret.bottom
            );

            if gui.hwndCaret != HWND(std::ptr::null_mut()) {
                let mut pt = POINT {
                    x: gui.rcCaret.left,
                    y: gui.rcCaret.top,
                };
                let _ = ClientToScreen(gui.hwndCaret, &mut pt);
                println!("Caret screen position: ({}, {})", pt.x, pt.y);
            } else {
                println!("No Win32 caret found (app uses custom rendering)");
            }
        } else {
            println!("GetGUIThreadInfo failed");
        }
    }
}
