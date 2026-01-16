// Quick test to verify cursor save/restore works on Windows
// Run with: cargo run -p computeruse-rs --example cursor_restore_test

#[cfg(target_os = "windows")]
fn main() {
    use std::time::Instant;
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, SetCursorPos};

    unsafe {
        // 1. Get original cursor position (with timing)
        let t1 = Instant::now();
        let mut original_pos = POINT { x: 0, y: 0 };
        let result = GetCursorPos(&mut original_pos);
        let get_cursor_time = t1.elapsed();

        println!("GetCursorPos result: {:?}", result);
        println!(
            "Original cursor position: ({}, {})",
            original_pos.x, original_pos.y
        );
        println!("GetCursorPos took: {:?}", get_cursor_time);

        // 2. Move cursor somewhere else (with timing)
        println!("\nMoving cursor to (500, 500)...");
        let t2 = Instant::now();
        let move_result = SetCursorPos(500, 500);
        let set_cursor_time = t2.elapsed();

        println!("SetCursorPos(500,500) result: {:?}", move_result);
        println!("SetCursorPos took: {:?}", set_cursor_time);

        // Small delay to visually see it moved (100ms instead of 1s to reduce interference)
        std::thread::sleep(std::time::Duration::from_millis(100));

        // Verify it moved
        let mut new_pos = POINT { x: 0, y: 0 };
        let _ = GetCursorPos(&mut new_pos);
        println!("Current cursor position: ({}, {})", new_pos.x, new_pos.y);

        // 3. Restore original position (with timing)
        println!("\nRestoring cursor to original position...");
        let t3 = Instant::now();
        let restore_result = SetCursorPos(original_pos.x, original_pos.y);
        let restore_time = t3.elapsed();

        println!("SetCursorPos restore result: {:?}", restore_result);
        println!("SetCursorPos restore took: {:?}", restore_time);

        // Verify restoration
        std::thread::sleep(std::time::Duration::from_millis(100));
        let mut final_pos = POINT { x: 0, y: 0 };
        let _ = GetCursorPos(&mut final_pos);
        println!("Final cursor position: ({}, {})", final_pos.x, final_pos.y);

        // Summary
        println!("\n=== TIMING SUMMARY ===");
        println!("GetCursorPos:  {:?}", get_cursor_time);
        println!("SetCursorPos:  {:?}", set_cursor_time);
        println!("Restore:       {:?}", restore_time);
        println!(
            "Total overhead for save+restore: {:?}",
            get_cursor_time + restore_time
        );

        // Check if restoration worked
        if final_pos.x == original_pos.x && final_pos.y == original_pos.y {
            println!("\nCursor restore WORKS!");
        } else {
            println!("\nCursor restore FAILED - position mismatch");
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn main() {
    println!("This test only runs on Windows");
}
