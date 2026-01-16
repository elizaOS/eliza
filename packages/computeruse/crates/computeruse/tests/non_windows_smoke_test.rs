//! Non-Windows smoke tests.
//!
//! These are intentionally light-weight and avoid requiring OS-specific
//! accessibility permissions. They exist mainly to ensure we compile and the
//! basic runtime wiring works on macOS/Linux CI runners.

fn has_gui_session() -> bool {
    #[cfg(target_os = "macos")]
    {
        true // macOS always has a display in CI runners
    }
    #[cfg(target_os = "linux")]
    {
        std::env::var("DISPLAY").is_ok() || std::env::var("WAYLAND_DISPLAY").is_ok()
    }
    #[cfg(target_os = "windows")]
    {
        true
    }
}

#[cfg(not(target_os = "windows"))]
#[tokio::test]
async fn desktop_initializes_and_lists_monitors() {
    let desktop = computeruse::Desktop::new_default()
        .expect("Desktop::new_default() should succeed on non-Windows");

    // Linux CI is often headless; skip monitor assertions if no display is present.
    if !has_gui_session() {
        return;
    }

    let monitors = desktop
        .list_monitors()
        .await
        .expect("list_monitors() should succeed when a display is available");
    assert!(
        !monitors.is_empty(),
        "Expected at least one monitor when a display is available"
    );
}

#[cfg(not(target_os = "windows"))]
#[tokio::test]
async fn desktop_root_element_exists() {
    let desktop = computeruse::Desktop::new_default()
        .expect("Desktop::new_default() should succeed");

    let root = desktop.root();
    let role = root.role();
    
    // Root element should have a desktop-like role
    assert!(
        role.contains("Desktop") || role.contains("Root") || role.contains("Application"),
        "Root element should have a Desktop/Root/Application role, got: {}",
        role
    );
}

#[cfg(not(target_os = "windows"))]
#[tokio::test]
async fn desktop_get_primary_monitor() {
    if !has_gui_session() {
        return;
    }

    let desktop = computeruse::Desktop::new_default()
        .expect("Desktop::new_default() should succeed");

    let primary = desktop.get_primary_monitor().await;
    
    // On headless CI, this may fail - that's ok
    if let Ok(monitor) = primary {
        assert!(monitor.is_primary, "Primary monitor should be marked as primary");
        assert!(monitor.width > 0, "Monitor should have positive width");
        assert!(monitor.height > 0, "Monitor should have positive height");
    }
}

#[cfg(not(target_os = "windows"))]
#[tokio::test]
async fn desktop_run_command_unix() {
    let desktop = computeruse::Desktop::new_default()
        .expect("Desktop::new_default() should succeed");

    let result = desktop.run_command(None, Some("echo hello")).await;
    
    match result {
        Ok(output) => {
            assert_eq!(output.exit_status, Some(0), "echo should exit with 0");
            assert!(output.stdout.contains("hello"), "stdout should contain 'hello'");
        }
        Err(e) => {
            // Some CI environments might not have a shell
            eprintln!("run_command failed (may be expected in restricted CI): {:?}", e);
        }
    }
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn macos_get_applications_smoke() {
    // This test requires accessibility permissions which may not be available in CI
    // So we just verify it doesn't panic
    let desktop = computeruse::Desktop::new_default()
        .expect("Desktop::new_default() should succeed");

    let result = desktop.applications();
    
    // May fail due to permissions, but shouldn't panic
    match result {
        Ok(apps) => {
            println!("Found {} applications", apps.len());
            for app in apps {
                println!("  - {}: {}", app.role(), app.attributes().name.unwrap_or_default());
            }
        }
        Err(e) => {
            println!("applications() failed (may need accessibility permissions): {:?}", e);
        }
    }
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn linux_get_applications_smoke() {
    if !has_gui_session() {
        return;
    }

    let desktop = computeruse::Desktop::new_default()
        .expect("Desktop::new_default() should succeed");

    let result = desktop.applications();
    
    // May fail if wmctrl is not installed, but shouldn't panic
    match result {
        Ok(apps) => {
            println!("Found {} applications", apps.len());
            for app in apps {
                println!("  - {}: {}", app.role(), app.attributes().name.unwrap_or_default());
            }
        }
        Err(e) => {
            println!("applications() failed (may need wmctrl): {:?}", e);
        }
    }
}

