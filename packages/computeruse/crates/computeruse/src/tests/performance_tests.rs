//! Performance tests for the ComputerUse SDK
//!
//! This module contains performance tests that measure the execution time
//! of various SDK functions against real applications.

use crate::{AutomationError, Desktop};
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// Helper struct to measure and report performance
struct PerfMeasurement {
    name: String,
    durations: Vec<Duration>,
}

impl PerfMeasurement {
    fn new(name: &str) -> Self {
        Self {
            name: name.to_string(),
            durations: Vec::new(),
        }
    }

    fn add_measurement(&mut self, duration: Duration) {
        self.durations.push(duration);
    }

    fn report(&self) {
        if self.durations.is_empty() {
            println!("❌ {} - No measurements", self.name);
            return;
        }

        let total: Duration = self.durations.iter().sum();
        let avg = total / self.durations.len() as u32;
        let min = self.durations.iter().min().unwrap();
        let max = self.durations.iter().max().unwrap();

        println!("📊 {}", self.name);
        println!("   Samples: {}", self.durations.len());
        println!("   Average: {avg:?}");
        println!("   Min:     {min:?}");
        println!("   Max:     {max:?}");
        println!("   Total:   {total:?}");
    }
}

/// Common test applications for Windows
const TEST_APPS: &[(&str, &str)] = &[
    ("Calculator", "calc"),
    ("Notepad", "notepad"),
    ("Paint", "mspaint"),
    ("Snipping Tool", "snippingtool"),
];

/// Run a performance test multiple times and collect measurements
fn measure_performance<F>(name: &str, iterations: usize, mut f: F) -> PerfMeasurement
where
    F: FnMut() -> Result<(), AutomationError>,
{
    let mut perf = PerfMeasurement::new(name);

    for _ in 0..iterations {
        let start = Instant::now();
        match f() {
            Ok(_) => {
                let duration = start.elapsed();
                perf.add_measurement(duration);
            }
            Err(e) => {
                eprintln!("Error in {name}: {e:?}");
            }
        }
    }

    perf
}

#[test]
#[ignore] // Run with: cargo test test_real_app_performance -- --ignored --nocapture
fn test_real_app_performance() {
    println!("\n🚀 Real Application Performance Test Suite");
    println!("==========================================\n");

    let desktop = Desktop::new(false, false).expect("Failed to create Desktop");

    // Test 1: Application enumeration
    println!("📱 Testing Application Enumeration...");
    let apps_perf = measure_performance("Desktop::applications()", 5, || {
        let apps = desktop.applications()?;
        println!("   Found {} applications", apps.len());
        Ok(())
    });
    apps_perf.report();

    // Test 2: Find specific applications
    println!("\n🔍 Testing Application Lookup...");
    let mut app_lookup_perfs = HashMap::new();

    for (app_name, _) in TEST_APPS {
        let perf = measure_performance(&format!("Find {app_name}"), 3, || {
            match desktop.application(app_name) {
                Ok(_) => Ok(()),
                Err(_) => {
                    // App might not be running, that's okay
                    Ok(())
                }
            }
        });
        app_lookup_perfs.insert(*app_name, perf);
    }

    for (app_name, perf) in app_lookup_perfs {
        println!("\n  Application: {app_name}");
        perf.report();
    }
}

#[test]
#[ignore]
fn test_notepad_interaction_performance() {
    println!("\n📝 Notepad Interaction Performance Test");
    println!("=======================================\n");

    let desktop = Desktop::new(false, false).expect("Failed to create Desktop");

    // Check if Notepad is running
    match desktop.application("Notepad") {
        Ok(notepad) => {
            println!("✅ Found Notepad, testing interactions...");

            // Test 1: Get all children
            let children_perf = measure_performance("Get Notepad children", 5, || {
                let children = notepad.children()?;
                println!("   Found {} children", children.len());
                Ok(())
            });
            children_perf.report();

            // Test 2: Get element attributes
            let attr_perf = measure_performance("Get Notepad attributes", 10, || {
                let _ = notepad.name();
                let _ = notepad.role();
                let _ = notepad.attributes();
                Ok(())
            });
            attr_perf.report();
        }
        Err(_) => {
            println!("⚠️  Notepad not running. Skipping interaction tests.");
            println!("   Tip: Open Notepad to test interactions");
        }
    }
}

#[test]
#[ignore]
fn test_window_operations_performance() {
    println!("\n🪟 Window Operations Performance Test");
    println!("=====================================\n");

    let desktop = Desktop::new(false, false).expect("Failed to create Desktop");

    // Test focused window
    let focused_perf = measure_performance("Get focused element", 20, || {
        match desktop.focused_element() {
            Ok(_) => Ok(()),
            Err(_) => Ok(()), // Might fail if no focus, that's ok
        }
    });
    focused_perf.report();

    // Test desktop root
    let root_perf = measure_performance("Get desktop root", 20, || {
        let _root = desktop.root();
        Ok(())
    });
    root_perf.report();
}

#[test]
#[ignore]
fn test_ui_tree_performance() {
    println!("\n🌳 UI Tree Performance Test");
    println!("===========================\n");

    let desktop = Desktop::new(false, false).expect("Failed to create Desktop");

    // Get current applications for testing
    let apps = desktop.applications().unwrap_or_default();

    if apps.is_empty() {
        println!("⚠️  No applications found");
        return;
    }

    // Test tree traversal for first few apps
    let test_count = apps.len().min(3);

    for app in apps.iter().take(test_count) {
        let app_name = app.name().unwrap_or_else(|| "Unknown".to_string());

        println!("\n📱 Testing UI tree for: {app_name}");

        // Test getting immediate children
        let children_perf = measure_performance("Get immediate children", 5, || {
            let children = app.children()?;
            println!("   {} has {} children", app_name, children.len());
            Ok(())
        });
        children_perf.report();

        // Test depth traversal
        let traverse_perf = measure_performance("Traverse 2 levels deep", 3, || {
            let mut total_elements = 1; // The app itself

            if let Ok(children) = app.children() {
                total_elements += children.len();

                // Go one more level
                for child in children.iter().take(5) {
                    if let Ok(grandchildren) = child.children() {
                        total_elements += grandchildren.len();
                    }
                }
            }

            println!("   Total elements found: {total_elements}");
            Ok(())
        });
        traverse_perf.report();
    }
}

#[test]
#[ignore]
fn test_browser_automation_performance() {
    println!("\n🌐 Browser Automation Performance Test");
    println!("=====================================\n");

    let desktop = Desktop::new(false, false).expect("Failed to create Desktop");

    // Test Chrome lookup
    let chrome_apps = ["Google Chrome", "Chrome", "chrome"];
    let mut found_chrome = false;

    for chrome_name in &chrome_apps {
        let start = Instant::now();
        match desktop.application(chrome_name) {
            Ok(_) => {
                let duration = start.elapsed();
                println!("✅ Found Chrome as '{chrome_name}' in {duration:?}");
                found_chrome = true;
                break;
            }
            Err(_) => continue,
        }
    }

    if !found_chrome {
        println!("⚠️  Chrome not running. Trying Edge...");

        let edge_apps = ["Microsoft Edge", "Edge", "msedge"];
        for edge_name in &edge_apps {
            let start = Instant::now();
            match desktop.application(edge_name) {
                Ok(_) => {
                    let duration = start.elapsed();
                    println!("✅ Found Edge as '{edge_name}' in {duration:?}");
                    break;
                }
                Err(_) => continue,
            }
        }
    }
}

#[test]
#[ignore]
fn test_basic_operations_performance() {
    println!("\n⚡ Basic Operations Performance Test");
    println!("====================================\n");

    // Test Desktop initialization
    let init_perf = measure_performance("Desktop::new()", 10, || {
        let _desktop = Desktop::new(false, false)?;
        Ok(())
    });
    init_perf.report();

    let desktop = Desktop::new(false, false).expect("Failed to create Desktop");

    // Test locator creation
    let locator_perf = measure_performance("Desktop::locator()", 50, || {
        let _locator = desktop.locator("name:Calculator");
        Ok(())
    });
    locator_perf.report();

    // Test root element access
    let root_perf = measure_performance("Desktop::root()", 50, || {
        let _root = desktop.root();
        Ok(())
    });
    root_perf.report();
}

#[test]
#[ignore]
fn test_comprehensive_performance_report() {
    println!("\n📊 Comprehensive Performance Report");
    println!("===================================");
    println!("Running all synchronous performance tests...\n");

    test_basic_operations_performance();
    println!("\n{}\n", "=".repeat(50));

    test_real_app_performance();
    println!("\n{}\n", "=".repeat(50));

    test_notepad_interaction_performance();
    println!("\n{}\n", "=".repeat(50));

    test_window_operations_performance();
    println!("\n{}\n", "=".repeat(50));

    test_ui_tree_performance();
    println!("\n{}\n", "=".repeat(50));

    test_browser_automation_performance();

    println!("\n✅ Performance test suite completed!");
    println!("\n📝 Summary:");
    println!("- Desktop initialization and basic operations are fast");
    println!("- Element searches depend on UI complexity");
    println!("- Tree traversal scales with element count");
    println!("- Real app interactions add overhead");
    println!("\n💡 Individual tests can be run with:");
    println!("  cargo test test_basic_operations_performance -- --ignored --nocapture");
    println!("  cargo test test_real_app_performance -- --ignored --nocapture");
    println!("  cargo test test_ui_tree_performance -- --ignored --nocapture");
}
