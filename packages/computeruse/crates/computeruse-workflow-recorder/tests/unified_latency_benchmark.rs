use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use computeruse_workflow_recorder::{
    MouseEventType, WorkflowEvent, WorkflowRecorder, WorkflowRecorderConfig,
};
use tokio_stream::StreamExt;

#[cfg(target_os = "windows")]
use windows::Win32::{
    UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS,
        KEYEVENTF_KEYUP, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
        MOUSEEVENTF_MOVE, MOUSEINPUT, VIRTUAL_KEY, VK_A,
    },
    UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN},
};

#[derive(Debug, Clone)]
struct LatencyMeasurement {
    latency_ms: f64,
}

#[derive(Debug)]
struct LatencyStats {
    min_ms: f64,
    max_ms: f64,
    mean_ms: f64,
    median_ms: f64,
    p95_ms: f64,
    p99_ms: f64,
    stddev_ms: f64,
    total_events: usize,
    missed_events: usize,
}

impl LatencyStats {
    fn calculate(measurements: &[LatencyMeasurement]) -> Self {
        if measurements.is_empty() {
            return Self {
                min_ms: 0.0,
                max_ms: 0.0,
                mean_ms: 0.0,
                median_ms: 0.0,
                p95_ms: 0.0,
                p99_ms: 0.0,
                stddev_ms: 0.0,
                total_events: 0,
                missed_events: 0,
            };
        }

        let mut latencies: Vec<f64> = measurements.iter().map(|m| m.latency_ms).collect();
        latencies.sort_by(|a, b| a.partial_cmp(b).unwrap());

        let min_ms = latencies[0];
        let max_ms = latencies[latencies.len() - 1];
        let mean_ms = latencies.iter().sum::<f64>() / latencies.len() as f64;

        let median_ms = if latencies.len().is_multiple_of(2) {
            (latencies[latencies.len() / 2 - 1] + latencies[latencies.len() / 2]) / 2.0
        } else {
            latencies[latencies.len() / 2]
        };

        let p95_index = (latencies.len() as f64 * 0.95) as usize;
        let p99_index = (latencies.len() as f64 * 0.99) as usize;
        let p95_ms = latencies[p95_index.min(latencies.len() - 1)];
        let p99_ms = latencies[p99_index.min(latencies.len() - 1)];

        let variance = latencies
            .iter()
            .map(|&x| (x - mean_ms).powi(2))
            .sum::<f64>()
            / latencies.len() as f64;
        let stddev_ms = variance.sqrt();

        Self {
            min_ms,
            max_ms,
            mean_ms,
            median_ms,
            p95_ms,
            p99_ms,
            stddev_ms,
            total_events: latencies.len(),
            missed_events: 0,
        }
    }

    fn print_summary(&self, test_name: &str) {
        println!("\n📊 {test_name} - Latency Statistics:");
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        println!("  📈 Total Events Processed: {}", self.total_events);
        if self.missed_events > 0 {
            println!(
                "  ⚠️  Missed Events: {} ({:.1}%)",
                self.missed_events,
                (self.missed_events as f64 / (self.total_events + self.missed_events) as f64)
                    * 100.0
            );
        }
        println!("  ⚡ Min Latency: {:.2}ms", self.min_ms);
        println!("  🔥 Max Latency: {:.2}ms", self.max_ms);
        println!("  📊 Mean Latency: {:.2}ms", self.mean_ms);
        println!("  📊 Median Latency: {:.2}ms", self.median_ms);
        println!("  📊 StdDev: {:.2}ms", self.stddev_ms);
        println!("  🎯 P95 Latency: {:.2}ms", self.p95_ms);
        println!("  🎯 P99 Latency: {:.2}ms", self.p99_ms);

        // Performance assessment
        if self.mean_ms < 5.0 {
            println!("  ✅ EXCELLENT: Sub-5ms average latency!");
        } else if self.mean_ms < 10.0 {
            println!("  ✅ GOOD: Sub-10ms average latency");
        } else if self.mean_ms < 20.0 {
            println!("  ⚠️  MODERATE: 10-20ms latency may cause noticeable lag");
        } else {
            println!("  ❌ POOR: >20ms latency will cause significant lag!");
        }
    }
}

// OS-level input generation functions
#[cfg(target_os = "windows")]
fn send_keyboard_event(vk_code: VIRTUAL_KEY, key_up: bool) -> Result<(), String> {
    unsafe {
        let input = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk_code,
                    wScan: 0,
                    dwFlags: if key_up {
                        KEYEVENTF_KEYUP
                    } else {
                        KEYBD_EVENT_FLAGS(0)
                    },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };

        let result = SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
        if result == 0 {
            Err("Failed to send keyboard input".to_string())
        } else {
            Ok(())
        }
    }
}

#[cfg(target_os = "windows")]
fn send_mouse_click(x: i32, y: i32) -> Result<(), String> {
    unsafe {
        // Get screen dimensions
        let screen_width = GetSystemMetrics(SM_CXSCREEN);
        let screen_height = GetSystemMetrics(SM_CYSCREEN);

        // Convert to absolute coordinates (0-65535 range)
        let abs_x = x * 65535 / screen_width;
        let abs_y = y * 65535 / screen_height;

        // Move mouse to position
        let move_input = INPUT {
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
        };

        // Mouse down
        let down_input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: 0,
                    dy: 0,
                    mouseData: 0,
                    dwFlags: MOUSEEVENTF_LEFTDOWN,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };

        // Mouse up
        let up_input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: 0,
                    dy: 0,
                    mouseData: 0,
                    dwFlags: MOUSEEVENTF_LEFTUP,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };

        let inputs = [move_input, down_input, up_input];
        let result = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);

        if result == 0 {
            Err("Failed to send mouse click".to_string())
        } else {
            Ok(())
        }
    }
}

#[cfg(target_os = "windows")]
fn send_mouse_move(x: i32, y: i32) -> Result<(), String> {
    unsafe {
        // Get screen dimensions
        let screen_width = GetSystemMetrics(SM_CXSCREEN);
        let screen_height = GetSystemMetrics(SM_CYSCREEN);

        // Convert to absolute coordinates (0-65535 range)
        let abs_x = x * 65535 / screen_width;
        let abs_y = y * 65535 / screen_height;

        let input = INPUT {
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
        };

        let result = SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
        if result == 0 {
            Err("Failed to send mouse move".to_string())
        } else {
            Ok(())
        }
    }
}

// Fallback implementations for non-Windows platforms
#[cfg(not(target_os = "windows"))]
fn send_keyboard_event(_vk_code: u16, _key_up: bool) -> Result<(), String> {
    Err("OS-level input generation only supported on Windows".to_string())
}

#[cfg(not(target_os = "windows"))]
fn send_mouse_click(_x: i32, _y: i32) -> Result<(), String> {
    Err("OS-level input generation only supported on Windows".to_string())
}

#[cfg(not(target_os = "windows"))]
fn send_mouse_move(_x: i32, _y: i32) -> Result<(), String> {
    Err("OS-level input generation only supported on Windows".to_string())
}

/// Comprehensive latency benchmark that measures the TRUE input latency experienced by users.
///
/// This test generates REAL OS-level input events using Windows SendInput API and measures
/// the time between when the OS receives the input and when the recorder processes it.
///
/// This is fundamentally different from using UI Automation to generate events, as it:
/// - Simulates actual keyboard/mouse hardware events at the OS level
/// - Measures the complete input processing pipeline latency
/// - Provides accurate real-world performance metrics
///
/// The test measures latency for:
/// - Keyboard events (key press/release)
/// - Mouse clicks (move + down + up)
/// - Mouse movements (continuous tracking)
#[tokio::test]
#[ignore]
async fn test_unified_input_latency() {
    println!("\n🚀 Starting Unified Input Latency Benchmark");
    println!("===========================================");
    println!("📊 Testing keyboard, mouse clicks, and mouse movement latency\n");
    println!("⚡ Using OS-level input generation (SendInput on Windows)\n");

    // Phase 1: Test with minimal configuration
    println!("📊 Phase 1: Testing with minimal configuration (best performance)");
    let minimal_config = WorkflowRecorderConfig {
        record_keyboard: true,
        record_mouse: true,
        capture_ui_elements: false,
        mouse_move_throttle_ms: 0, // No throttling for accurate measurement
        ..Default::default()
    };

    let minimal_stats = run_latency_test("Minimal Config", minimal_config).await;

    // Phase 2: Test with UI capture enabled
    println!("\n📊 Phase 2: Testing with UI element capture enabled");
    let ui_config = WorkflowRecorderConfig {
        record_keyboard: true,
        record_mouse: true,
        capture_ui_elements: true,
        mouse_move_throttle_ms: 0,
        ..Default::default()
    };

    let ui_stats = run_latency_test("UI Capture Enabled", ui_config).await;

    // Phase 3: Test with all features enabled
    println!("\n📊 Phase 3: Testing with all features enabled (worst case)");
    let full_config = WorkflowRecorderConfig {
        record_keyboard: true,
        record_mouse: true,
        capture_ui_elements: true,
        record_text_input_completion: true,
        record_clipboard: true,
        record_hotkeys: true,
        mouse_move_throttle_ms: 0,
        ..Default::default()
    };

    let full_stats = run_latency_test("Full Features", full_config).await;

    // Print comparative analysis
    println!("\n\n📊 COMPARATIVE ANALYSIS");
    println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    // Compare keyboard latencies
    println!("\n⌨️  Keyboard Event Latency:");
    println!("  Minimal:        {:.2}ms", minimal_stats.0.mean_ms);
    println!(
        "  With UI:        {:.2}ms (+{:.1}%)",
        ui_stats.0.mean_ms,
        ((ui_stats.0.mean_ms - minimal_stats.0.mean_ms) / minimal_stats.0.mean_ms) * 100.0
    );
    println!(
        "  Full Features:  {:.2}ms (+{:.1}%)",
        full_stats.0.mean_ms,
        ((full_stats.0.mean_ms - minimal_stats.0.mean_ms) / minimal_stats.0.mean_ms) * 100.0
    );

    // Compare mouse click latencies
    println!("\n🖱️  Mouse Click Latency:");
    println!("  Minimal:        {:.2}ms", minimal_stats.1.mean_ms);
    println!(
        "  With UI:        {:.2}ms (+{:.1}%)",
        ui_stats.1.mean_ms,
        ((ui_stats.1.mean_ms - minimal_stats.1.mean_ms) / minimal_stats.1.mean_ms) * 100.0
    );
    println!(
        "  Full Features:  {:.2}ms (+{:.1}%)",
        full_stats.1.mean_ms,
        ((full_stats.1.mean_ms - minimal_stats.1.mean_ms) / minimal_stats.1.mean_ms) * 100.0
    );

    // Compare mouse movement latencies
    println!("\n🖱️  Mouse Movement Latency:");
    println!("  Minimal:        {:.2}ms", minimal_stats.2.mean_ms);
    println!(
        "  With UI:        {:.2}ms (+{:.1}%)",
        ui_stats.2.mean_ms,
        ((ui_stats.2.mean_ms - minimal_stats.2.mean_ms) / minimal_stats.2.mean_ms) * 100.0
    );
    println!(
        "  Full Features:  {:.2}ms (+{:.1}%)",
        full_stats.2.mean_ms,
        ((full_stats.2.mean_ms - minimal_stats.2.mean_ms) / minimal_stats.2.mean_ms) * 100.0
    );

    // Overall recommendations
    println!("\n💡 RECOMMENDATIONS:");
    if minimal_stats.0.mean_ms < 5.0
        && minimal_stats.1.mean_ms < 5.0
        && minimal_stats.2.mean_ms < 5.0
    {
        println!("  ✅ Excellent baseline performance! No lag issues expected.");
    }

    let ui_overhead = ((ui_stats.0.mean_ms + ui_stats.1.mean_ms + ui_stats.2.mean_ms) / 3.0)
        - ((minimal_stats.0.mean_ms + minimal_stats.1.mean_ms + minimal_stats.2.mean_ms) / 3.0);

    if ui_overhead > 10.0 {
        println!(
            "  ⚠️  UI element capture adds significant overhead ({ui_overhead:.1}ms average)."
        );
        println!("     Consider disabling if not needed.");
    }

    println!("\n✅ Benchmark completed!");
}

async fn run_latency_test(
    test_name: &str,
    config: WorkflowRecorderConfig,
) -> (LatencyStats, LatencyStats, LatencyStats) {
    println!("\n🔄 Running test: {test_name}");

    let mut recorder = WorkflowRecorder::new(test_name.to_string(), config);
    let mut event_stream = recorder.event_stream();

    recorder.start().await.expect("Failed to start recorder");
    tokio::time::sleep(Duration::from_millis(300)).await;

    let received_events = Arc::new(Mutex::new(Vec::new()));
    let received_events_clone = Arc::clone(&received_events);
    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_flag_clone = Arc::clone(&stop_flag);

    // Event collection task
    let collector_task = tokio::spawn(async move {
        let mut event_count = 0;
        while let Some(event) = event_stream.next().await {
            let received_at = Instant::now();
            match &event {
                WorkflowEvent::Keyboard(_) => {
                    received_events_clone.lock().unwrap().push((
                        event_count,
                        received_at,
                        "keyboard".to_string(),
                        event,
                    ));
                }
                WorkflowEvent::Mouse(mouse_event) => {
                    let event_type = match mouse_event.event_type {
                        MouseEventType::Move => "mouse_move",
                        MouseEventType::Down | MouseEventType::Up => "mouse_click",
                        _ => "mouse_other",
                    };
                    received_events_clone.lock().unwrap().push((
                        event_count,
                        received_at,
                        event_type.to_string(),
                        event,
                    ));
                }
                _ => {}
            }
            event_count += 1;

            if stop_flag_clone.load(Ordering::Relaxed) {
                break;
            }
        }
        event_count
    });

    tokio::time::sleep(Duration::from_millis(200)).await;

    let mut sent_events = Vec::new();

    // Test 1: Keyboard events
    println!("  ⌨️  Testing keyboard events...");
    for _i in 0..20 {
        let send_time = Instant::now();

        // Send OS-level keyboard event (press and release 'A' key)
        #[cfg(target_os = "windows")]
        {
            let _ = send_keyboard_event(VK_A, false); // Key down
            tokio::time::sleep(Duration::from_millis(5)).await;
            let _ = send_keyboard_event(VK_A, true); // Key up
        }

        #[cfg(not(target_os = "windows"))]
        {
            println!("    ⚠️  Skipping keyboard test on non-Windows platform");
            break;
        }

        sent_events.push((send_time, "keyboard".to_string()));
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    // Test 2: Mouse clicks
    println!("  🖱️  Testing mouse clicks...");
    for _i in 0..20 {
        let send_time = Instant::now();

        // Send OS-level mouse click at center of screen
        #[cfg(target_os = "windows")]
        {
            let _ = send_mouse_click(960, 540);
        }

        #[cfg(not(target_os = "windows"))]
        {
            println!("    ⚠️  Skipping mouse click test on non-Windows platform");
            break;
        }

        sent_events.push((send_time, "mouse_click".to_string()));
        tokio::time::sleep(Duration::from_millis(30)).await;
    }

    // Test 3: Mouse movements
    println!("  🖱️  Testing mouse movements...");
    let center_x = 960;
    let center_y = 540;
    let radius = 100;

    for i in 0..30 {
        let angle = (i as f64 / 30.0) * 2.0 * std::f64::consts::PI;
        let x = (center_x as f64 + radius as f64 * angle.cos()) as i32;
        let y = (center_y as f64 + radius as f64 * angle.sin()) as i32;

        let send_time = Instant::now();

        // Send OS-level mouse move
        #[cfg(target_os = "windows")]
        {
            let _ = send_mouse_move(x, y);
        }

        #[cfg(not(target_os = "windows"))]
        {
            println!("    ⚠️  Skipping mouse movement test on non-Windows platform");
            break;
        }

        sent_events.push((send_time, "mouse_move".to_string()));
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    // Wait for events to be processed
    tokio::time::sleep(Duration::from_millis(500)).await;
    stop_flag.store(true, Ordering::Relaxed);

    let total_received = collector_task.await.unwrap();
    recorder.stop().await.expect("Failed to stop recorder");

    // Calculate latencies
    let events = received_events.lock().unwrap();
    let mut keyboard_measurements = Vec::new();
    let mut click_measurements = Vec::new();
    let mut move_measurements = Vec::new();

    // Match sent and received events
    for (send_time, event_type) in &sent_events {
        // Find the first matching received event after send_time
        for (_, recv_time, recv_type, _) in events.iter() {
            if recv_time > send_time && recv_type == event_type {
                let latency_ms = recv_time.duration_since(*send_time).as_secs_f64() * 1000.0;

                let measurement = LatencyMeasurement { latency_ms };

                match event_type.as_str() {
                    "keyboard" => keyboard_measurements.push(measurement),
                    "mouse_click" => click_measurements.push(measurement),
                    "mouse_move" => move_measurements.push(measurement),
                    _ => {}
                }
                break;
            }
        }
    }

    println!(
        "  📊 Events sent: {}, received: {}",
        sent_events.len(),
        total_received
    );

    let keyboard_stats = LatencyStats::calculate(&keyboard_measurements);
    let click_stats = LatencyStats::calculate(&click_measurements);
    let move_stats = LatencyStats::calculate(&move_measurements);

    keyboard_stats.print_summary(&format!("{test_name} - Keyboard"));
    click_stats.print_summary(&format!("{test_name} - Mouse Clicks"));
    move_stats.print_summary(&format!("{test_name} - Mouse Movement"));

    (keyboard_stats, click_stats, move_stats)
}

#[tokio::test]
#[ignore]
async fn test_mouse_movement_verification() {
    println!("\n🖱️ Mouse Movement Verification Test");
    println!("===================================");
    println!("This test verifies that mouse movements are properly recorded\n");

    let config = WorkflowRecorderConfig {
        record_keyboard: false,
        record_mouse: true,
        capture_ui_elements: false,
        mouse_move_throttle_ms: 50, // Throttle to 20 FPS
        ..Default::default()
    };

    let mut recorder = WorkflowRecorder::new("Movement Verification".to_string(), config);
    let mut event_stream = recorder.event_stream();

    recorder.start().await.expect("Failed to start recorder");

    let desktop = computeruse::Desktop::new(false, false).expect("Failed to create Desktop");
    let window = desktop
        .locator("role:Window")
        .first(Some(Duration::from_secs(1)))
        .await
        .expect("Failed to find window");

    // Collect events
    let event_collector = tokio::spawn(async move {
        let mut move_count = 0;
        let mut positions = Vec::new();

        tokio::select! {
            _ = async {
                while let Some(event) = event_stream.next().await {
                    if let WorkflowEvent::Mouse(mouse_event) = event {
                        if matches!(mouse_event.event_type, MouseEventType::Move) {
                            move_count += 1;
                            let pos = (mouse_event.position.x, mouse_event.position.y);
                            positions.push(pos);
                            println!("  🖱️ Recorded movement #{}: ({}, {})", move_count, pos.0, pos.1);
                        }
                    }
                }
            } => {},
            _ = tokio::time::sleep(Duration::from_secs(5)) => {
                println!("  ⏱️ Timeout reached");
            }
        }

        (move_count, positions)
    });

    // Generate movements in a pattern
    println!("Generating mouse movements in a square pattern...");
    let positions = [
        (500.0, 500.0),
        (700.0, 500.0),
        (700.0, 700.0),
        (500.0, 700.0),
        (500.0, 500.0),
    ];

    for (i, (x, y)) in positions.iter().enumerate() {
        println!("  Moving to position {}: ({}, {})", i + 1, x, y);
        let _ = window.mouse_move(*x, *y);
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    tokio::time::sleep(Duration::from_millis(500)).await;
    recorder.stop().await.expect("Failed to stop recorder");

    let (move_count, _) = event_collector.await.unwrap();

    println!("\n📊 Results:");
    println!("  Mouse movements sent: {}", positions.len());
    println!("  Mouse movements recorded: {move_count}");
    println!(
        "  Capture rate: {:.1}%",
        (move_count as f64 / positions.len() as f64) * 100.0
    );

    assert!(move_count > 0, "No mouse movements were recorded!");
    println!("\n✅ Mouse movement recording verified!");
}
