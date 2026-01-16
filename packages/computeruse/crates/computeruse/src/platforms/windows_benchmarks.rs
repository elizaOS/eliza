#[cfg(test)]
mod performance_benchmarks {
    use super::super::windows::WindowsEngine;
    use crate::platforms::AccessibilityEngine;
    use crate::Browser;
    use std::process::Command;
    use std::time::{Duration, Instant};

    /// Comprehensive benchmark test for window tree building performance
    /// Tests both browser pages and system applications to measure:
    /// - Execution speed
    /// - Memory usage during operation  
    /// - Tree complexity (elements processed)
    /// Goal: Validate high-frequency operation on low-end machines
    #[tokio::test]
    #[ignore]
    async fn benchmark_tree_building_performance() {
        println!("🚀 Starting Window Tree Building Performance Benchmark");
        println!("============================================================");

        let engine = WindowsEngine::new(false, false).expect("Failed to create Windows engine");

        // Enhanced test scenarios: browser pages, complex websites, and heavy desktop apps
        let test_scenarios = vec![
            // Light websites for baseline
            (
                "Browser: Luma Event Page",
                "https://lu.ma/airstreet",
                "browser",
            ),
            (
                "Browser: Dataiku AI Guide",
                "https://pages.dataiku.com/guide-to-ai-agents",
                "browser",
            ),
            // Heavy websites with lots of elements
            (
                "Browser: GitHub Trending",
                "https://github.com/trending",
                "browser",
            ),
            (
                "Browser: Reddit Front Page",
                "https://reddit.com",
                "browser",
            ),
            ("Browser: Amazon Homepage", "https://amazon.com", "browser"),
            (
                "Browser: YouTube Homepage",
                "https://youtube.com",
                "browser",
            ),
            ("Browser: Twitter/X Homepage", "https://x.com", "browser"),
            (
                "Browser: LinkedIn Feed",
                "https://linkedin.com/feed",
                "browser",
            ),
            (
                "Browser: Stack Overflow",
                "https://stackoverflow.com",
                "browser",
            ),
            (
                "Browser: Wikipedia Main Page",
                "https://en.wikipedia.org/wiki/Main_Page",
                "browser",
            ),
            // Complex web applications
            (
                "Browser: Figma Community",
                "https://figma.com/community",
                "browser",
            ),
            ("Browser: Notion Homepage", "https://notion.so", "browser"),
            (
                "Browser: Slack Web App",
                "https://slack.com/signin",
                "browser",
            ),
            // System applications (light)
            ("System: Calculator", "calc", "system"),
            ("System: Notepad", "notepad", "system"),
            ("System: Paint", "mspaint", "system"),
            // Heavy desktop applications
            ("System: File Explorer", "explorer", "system"),
            ("System: Task Manager", "taskmgr", "system"),
            ("System: Control Panel", "control", "system"),
            ("System: Windows Settings", "ms-settings:", "system"),
            ("System: Device Manager", "devmgmt.msc", "system"),
            ("System: Registry Editor", "regedit", "system"),
            // Microsoft Office suite (if available)
            ("System: Microsoft Word", "winword", "system"),
            ("System: Microsoft Excel", "excel", "system"),
            ("System: Microsoft PowerPoint", "powerpnt", "system"),
            // Development tools (if available)
            ("System: Visual Studio Code", "code", "system"),
            ("System: Windows Terminal", "wt", "system"),
        ];

        for (name, target, app_type) in test_scenarios {
            println!("\n📊 Testing: {name}");
            println!("----------------------------------------");

            // Launch application/open URL with improved browser handling
            let app_element = match app_type {
                "browser" => {
                    // Try different browsers in order of preference
                    let browsers = vec![
                        ("Chrome", Browser::Chrome),
                        ("Edge", Browser::Edge),
                        ("Firefox", Browser::Firefox),
                    ];

                    let mut last_error = None;
                    let mut opened_element = None;

                    for (browser_name, browser_cmd) in browsers {
                        match engine.open_url(target, Some(browser_cmd)) {
                            Ok(element) => {
                                println!("  ✅ Opened in {browser_name}");
                                opened_element = Some(element);
                                break;
                            }
                            Err(e) => {
                                println!("  ⚠️ {browser_name} not available: {e}");
                                last_error = Some(e);
                            }
                        }
                    }

                    match opened_element {
                        Some(element) => {
                            tokio::time::sleep(Duration::from_secs(5)).await; // Longer wait for heavy pages
                            element
                        }
                        None => {
                            println!("❌ Failed to open {target} in any browser: {last_error:?}");
                            continue;
                        }
                    }
                }
                "system" => {
                    match engine.open_application(target) {
                        Ok(element) => {
                            tokio::time::sleep(Duration::from_millis(1000)).await; // Wait for app startup
                            element
                        }
                        Err(e) => {
                            println!("❌ Failed to open {target}: {e} (app may not be installed)");
                            continue;
                        }
                    }
                }
                _ => continue,
            };

            // Get window title for tree building
            let window_title = match app_element.attributes().name {
                Some(title) => title,
                None => {
                    println!("❌ Could not get window title");
                    // Try to close the app before continuing
                    let _ = app_element.close();
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    continue;
                }
            };

            // Get PID for the window tree API
            let pid = match app_element.process_id() {
                Ok(pid) => pid,
                Err(e) => {
                    println!("❌ Could not get process ID: {e}");
                    let _ = app_element.close();
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    continue;
                }
            };

            // Get baseline metrics before operation
            let memory_before = get_process_memory_mb();
            let cpu_before = get_system_cpu_usage();
            let process_cpu_before = get_process_cpu_time();

            let start_time = Instant::now();

            // Test with Fast property loading mode (current optimized version)
            let config = crate::platforms::TreeBuildConfig {
                property_mode: crate::platforms::PropertyLoadingMode::Fast,
                timeout_per_operation_ms: Some(50),
                yield_every_n_elements: Some(50),
                batch_size: Some(50),
                max_depth: None,
                include_all_bounds: false,
                ui_settle_delay_ms: None,
                format_output: false,
                show_overlay: false,
                overlay_display_mode: None,
                from_selector: None,
            };

            match engine.get_window_tree(pid, Some(&window_title), config) {
                Ok(tree) => {
                    let duration = start_time.elapsed();
                    let element_count = count_tree_elements(&tree);

                    // Get final metrics after operation
                    let memory_after = get_process_memory_mb();
                    let cpu_after = get_system_cpu_usage();
                    let process_cpu_after = get_process_cpu_time();

                    let memory_delta = memory_after.saturating_sub(memory_before);
                    let cpu_delta = cpu_after.saturating_sub(cpu_before);
                    let process_cpu_delta = process_cpu_after.saturating_sub(process_cpu_before);

                    println!(
                        "✅ {}ms ({} elements, +{}% CPU)",
                        duration.as_millis(),
                        element_count,
                        cpu_delta
                    );

                    // Display detailed metrics
                    println!("\n  📈 Performance Metrics:");
                    println!("     Duration: {}ms", duration.as_millis());
                    println!("     Elements Processed: {element_count}");
                    println!("     Memory Delta: {memory_delta}MB");
                    println!("     CPU Load: {cpu_delta}%");
                    println!("     Process CPU Time: {process_cpu_delta}ms");
                    println!(
                        "     Throughput: {:.1} elements/ms",
                        element_count as f64 / duration.as_millis() as f64
                    );

                    // Enhanced performance assessment including CPU load
                    let performance_rating = assess_performance_enhanced(
                        duration,
                        element_count,
                        memory_delta,
                        cpu_delta,
                        app_type,
                    );
                    println!("     Performance Rating: {performance_rating}");

                    // Add complexity assessment
                    let complexity_rating = assess_complexity(element_count);
                    println!("     Complexity Level: {complexity_rating}");

                    // Add CPU efficiency assessment
                    let cpu_efficiency = assess_cpu_efficiency(cpu_delta, element_count);
                    println!("     CPU Efficiency: {cpu_efficiency}");
                }
                Err(e) => {
                    println!("❌ Failed: {e}");
                    continue;
                }
            }

            // Enhanced close handling with retry logic
            println!("  🔄 Closing application...");
            let close_result = close_application_with_retry(&app_element, app_type).await;
            match close_result {
                Ok(method) => println!("  ✅ Closed successfully using: {method}"),
                Err(e) => println!("  ⚠️ Close failed: {e}"),
            }

            tokio::time::sleep(Duration::from_millis(1000)).await; // Longer cleanup wait
        }

        println!("\n============================================================");
        println!("🎯 Benchmark completed!");
        println!("📊 Performance ratings help assess suitability for high-frequency automation");
        println!("🔍 Complexity levels indicate UI tree depth and element density");
    }

    /// Enhanced close handling with retry logic for different application types
    async fn close_application_with_retry(
        app_element: &crate::UIElement,
        app_type: &str,
    ) -> Result<String, String> {
        // Try the built-in close method first
        match app_element.close() {
            Ok(_) => return Ok("UIElement.close()".to_string()),
            Err(e) => println!("    ⚠️ UIElement.close() failed: {e}"),
        }

        // For browsers, try specific close methods
        if app_type == "browser" {
            // Try Ctrl+W (close tab) first
            if app_element.press_key("ctrl+w").is_ok() {
                tokio::time::sleep(Duration::from_millis(500)).await;
                return Ok("Ctrl+W".to_string());
            }

            // Try Alt+F4 (close window)
            if app_element.press_key("alt+f4").is_ok() {
                tokio::time::sleep(Duration::from_millis(500)).await;
                return Ok("Alt+F4".to_string());
            }
        }

        // For system apps, try Alt+F4
        if app_type == "system" {
            if app_element.press_key("alt+f4").is_ok() {
                tokio::time::sleep(Duration::from_millis(500)).await;
                return Ok("Alt+F4".to_string());
            }

            // Try Escape for some system dialogs
            if app_element.press_key("escape").is_ok() {
                tokio::time::sleep(Duration::from_millis(500)).await;
                return Ok("Escape".to_string());
            }
        }

        // Last resort: try to kill the process (be careful with this)
        Err("All close methods failed".to_string())
    }

    /// Count total elements in a UI tree recursively
    fn count_tree_elements(node: &crate::UINode) -> usize {
        1 + node.children.iter().map(count_tree_elements).sum::<usize>()
    }

    /// Get current process memory usage in MB
    fn get_process_memory_mb() -> u64 {
        let output = Command::new("powershell")
            .args([
                "-Command",
                "Get-Process -Id $PID | Select-Object -ExpandProperty WorkingSet64",
            ])
            .output();

        match output {
            Ok(output) => {
                let memory_str = String::from_utf8_lossy(&output.stdout);
                memory_str.trim().parse::<u64>().unwrap_or(0) / 1024 / 1024
            }
            Err(_) => 0,
        }
    }

    /// Get system CPU usage in percentage
    fn get_system_cpu_usage() -> u64 {
        let output = Command::new("powershell")
            .args(["-Command", 
                   "Get-Counter '\\Processor(_Total)\\% Processor Time' -SampleInterval 1 -MaxSamples 1 | Select-Object -ExpandProperty CounterSamples | Select-Object -ExpandProperty CookedValue"])
            .output();

        match output {
            Ok(output) => {
                let cpu_str = String::from_utf8_lossy(&output.stdout);
                cpu_str.trim().parse::<f64>().unwrap_or(0.0) as u64
            }
            Err(_) => 0,
        }
    }

    /// Get process CPU time in milliseconds
    fn get_process_cpu_time() -> u64 {
        let output = Command::new("powershell")
            .args(["-Command", 
                   &format!("Get-Process -Id {} | Select-Object -ExpandProperty TotalProcessorTime | Select-Object -ExpandProperty TotalMilliseconds", 
                           std::process::id())])
            .output();

        match output {
            Ok(output) => {
                let cpu_str = String::from_utf8_lossy(&output.stdout);
                cpu_str.trim().parse::<f64>().unwrap_or(0.0) as u64
            }
            Err(_) => 0,
        }
    }

    /// Enhanced performance assessment with different criteria for different app types
    fn assess_performance_enhanced(
        duration: Duration,
        elements: usize,
        memory_mb: u64,
        cpu_per_run: u64,
        app_type: &str,
    ) -> &'static str {
        let ms = duration.as_millis();

        // Different thresholds based on application type and complexity
        match app_type {
            "browser" => {
                // Browsers are expected to be slower due to complex web content
                match (ms, elements, memory_mb, cpu_per_run) {
                    (0..=100, 0..=100, 0..=15, 0..=10) => {
                        "🟢 Excellent - Fast even for web content"
                    }
                    (101..=300, 0..=300, 0..=25, 0..=20) => {
                        "🟡 Good - Acceptable for web automation"
                    }
                    (301..=600, 0..=500, 0..=50, 0..=30) => {
                        "🟠 Fair - May struggle with complex sites"
                    }
                    (601..=1200, 0..=1000, 0..=100, 0..=40) => {
                        "🔴 Poor - Too slow for frequent web automation"
                    }
                    _ => "🔴 Very Poor - Unsuitable for web automation",
                }
            }
            "system" => {
                // System apps should be faster
                match (ms, elements, memory_mb, cpu_per_run) {
                    (0..=50, 0..=50, 0..=10, 0..=10) => {
                        "🟢 Excellent - Perfect for high-frequency system automation"
                    }
                    (51..=150, 0..=150, 0..=20, 0..=20) => {
                        "🟡 Good - Suitable for system automation"
                    }
                    (151..=300, 0..=300, 0..=35, 0..=30) => {
                        "🟠 Fair - May struggle with frequent system calls"
                    }
                    (301..=600, 0..=600, 0..=75, 0..=40) => {
                        "🔴 Poor - Too slow for system automation"
                    }
                    _ => "🔴 Very Poor - Unsuitable for system automation",
                }
            }
            _ => {
                // Generic assessment
                match (ms, memory_mb, cpu_per_run) {
                    (0..=100, 0..=15, 0..=10) => "🟢 Excellent",
                    (101..=250, 0..=30, 0..=20) => "🟡 Good",
                    (251..=500, 0..=60, 0..=30) => "🟠 Fair",
                    (501..=1000, 0..=120, 0..=40) => "🔴 Poor",
                    _ => "🔴 Very Poor",
                }
            }
        }
    }

    /// Assess UI complexity based on element count
    fn assess_complexity(elements: usize) -> &'static str {
        match elements {
            0..=25 => "🟢 Simple - Basic UI with few elements",
            26..=100 => "🟡 Moderate - Standard application complexity",
            101..=300 => "🟠 Complex - Rich interface with many elements",
            301..=600 => "🔴 Heavy - Dense UI requiring careful optimization",
            _ => "🟣 Extreme - Very complex interface, high processing cost",
        }
    }

    /// Assess CPU efficiency based on CPU load and element count
    fn assess_cpu_efficiency(cpu_per_run: u64, elements: usize) -> &'static str {
        if elements == 0 {
            return "⚠️ No data";
        }

        let elements_per_cpu_percent = elements as f64 / (cpu_per_run as f64 + 0.1); // +0.1 to avoid division by zero

        match elements_per_cpu_percent as u64 {
            0..=5 => "🔴 Poor - High CPU cost per element",
            6..=15 => "🟠 Fair - Moderate CPU efficiency",
            16..=30 => "🟡 Good - Decent CPU efficiency",
            31..=60 => "🟢 Very Good - Efficient CPU usage",
            _ => "🟢 Excellent - Outstanding CPU efficiency",
        }
    }
}
