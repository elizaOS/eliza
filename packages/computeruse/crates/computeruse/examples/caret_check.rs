//! Quick caret position check - runs immediately

#[cfg(not(target_os = "windows"))]
fn main() {
    println!("Windows only");
}

#[cfg(target_os = "windows")]
fn main() {
    use windows::core::BOOL;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    };
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationTextPattern2, UIA_TextPattern2Id,
    };

    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).unwrap();

        let focused = automation.GetFocusedElement().unwrap();

        if let Ok(name) = focused.CurrentName() {
            println!("Focused: '{}'", name);
        }
        if let Ok(ct) = focused.CurrentControlType() {
            println!("Control type: {}", ct.0);
        }

        match focused.GetCurrentPatternAs::<IUIAutomationTextPattern2>(UIA_TextPattern2Id) {
            Ok(pattern) => {
                println!("TextPattern2: SUPPORTED");
                let mut active = BOOL::default();
                if let Ok(range) = pattern.GetCaretRange(&mut active) {
                    println!("Caret active: {}", active.as_bool());
                    if let Ok(text) = range.GetText(50) {
                        println!("Text from caret position: '{}'", text);
                    }
                }
            }
            Err(_) => println!("TextPattern2: NOT SUPPORTED"),
        }
    }
}
