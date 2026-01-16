use std::env;
use computeruse::{AutomationError, Desktop};
use tracing::info;

#[cfg(not(target_os = "windows"))]
fn main() -> Result<(), AutomationError> {
    eprintln!("This example is currently Windows-only.");
    Ok(())
}

#[cfg(target_os = "windows")]
use computeruse::platforms::windows::{HeadlessConfig, VirtualDisplayConfig, WindowsEngine};

#[cfg(target_os = "windows")]
fn main() -> Result<(), AutomationError> {
    // Initialize logging
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("computeruse=debug".parse().unwrap()),
        )
        .init();

    info!("Starting virtual display test");

    // Check if we should run in headless mode
    let headless = env::var("COMPUTERUSE_HEADLESS")
        .map(|v| {
            info!("COMPUTERUSE_HEADLESS env var value: '{}'", v);
            v == "1" || v.to_lowercase() == "true"
        })
        .unwrap_or_else(|_| {
            info!("COMPUTERUSE_HEADLESS env var not set, using default (false)");
            false
        });

    info!("Headless mode detected: {}", headless);

    if headless {
        info!("Running in HEADLESS mode with virtual display");
        test_with_virtual_display()?;
    } else {
        info!("Running in NORMAL mode");
        test_normal_mode()?;
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn test_with_virtual_display() -> Result<(), AutomationError> {
    info!("Initializing virtual display configuration");

    // Create headless configuration
    let headless_config = HeadlessConfig {
        use_virtual_display: true,
        virtual_display_config: VirtualDisplayConfig {
            width: 1920,
            height: 1080,
            color_depth: 32,
            refresh_rate: 60,
            driver_path: env::var("VIRTUAL_DISPLAY_DRIVER").ok(),
        },
        fallback_to_memory: true,
    };

    // Create Windows engine with virtual display
    let engine = WindowsEngine::new_with_headless(false, false, headless_config)?;

    info!(
        "Virtual display active: {}",
        engine.is_virtual_display_active()
    );
    if let Some(session_id) = engine.get_virtual_session_id() {
        info!("Virtual session ID: {}", session_id);
    }

    // Test basic UI automation with virtual display
    test_ui_automation()?;

    Ok(())
}

#[cfg(target_os = "windows")]
fn test_normal_mode() -> Result<(), AutomationError> {
    info!("Testing in normal display mode");
    test_ui_automation()?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn test_ui_automation() -> Result<(), AutomationError> {
    info!("Initializing desktop automation");

    // Create desktop instance with default settings
    let desktop = Desktop::new_default()?;

    // Try to find desktop root
    let root = desktop.root();
    info!("Found root element: {:?}", root.name());

    // List available applications
    match desktop.applications() {
        Ok(apps) => {
            info!("Found {} applications", apps.len());
            for app in apps.iter().take(5) {
                if let Some(name) = app.name() {
                    info!("  - {}", name);
                }
            }
        }
        Err(e) => {
            info!("Failed to get applications: {}", e);
        }
    }

    // Try to open calculator (if available)
    info!("Attempting to open calculator...");
    match desktop.open_application("calc") {
        Ok(calc) => {
            info!("Calculator opened successfully");

            // Wait a moment for it to load
            std::thread::sleep(std::time::Duration::from_secs(2));

            // Try to get calculator name
            if let Some(name) = calc.name() {
                info!("Calculator window name: {}", name);
            }
        }
        Err(e) => {
            info!("Failed to open calculator: {}", e);
        }
    }

    info!("UI automation test completed");
    Ok(())
}
