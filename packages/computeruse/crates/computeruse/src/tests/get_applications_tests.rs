use crate::{AutomationError, Desktop};
use tracing::Level;

#[tokio::test]
async fn get_applications_test() -> Result<(), AutomationError> {
    tracing_subscriber::fmt::Subscriber::builder()
        .with_max_level(Level::INFO)
        .init();

    let desktop = Desktop::new(false, false)?;

    let applications_to_open = vec!["notepad", "calculator", "paint"];

    let mut opened_apps = Vec::new();
    for app_name in &applications_to_open {
        let opened_app = desktop.open_application(app_name)?;
        tracing::info!("Opened application: {:?}", app_name);
        opened_apps.push(opened_app);
        std::thread::sleep(std::time::Duration::from_secs(5));
    }

    let running_apps = desktop.applications()?;
    tracing::info!("Total running applications: {:?}", running_apps.len());

    for app_name in &applications_to_open {
        let is_app_running = running_apps.iter().any(|app| {
            app.name()
                .map(|name| name.to_lowercase().contains(app_name))
                .unwrap_or(false)
        });
        assert!(
            is_app_running,
            "Application '{app_name}' is not found in the running applications list"
        );
    }

    for opened_app in opened_apps {
        if let Ok(process_id) = opened_app.process_id() {
            let output = std::process::Command::new("powershell")
                .arg("-Command")
                .arg(format!(
                    "Get-WmiObject Win32_Process | Where-Object {{ $_.ProcessId -eq {process_id} }} | ForEach-Object {{ taskkill.exe /F /PID $_.ProcessId }}"
                ))
                .output()
                .unwrap();

            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                tracing::info!("Closed application with PID {}: {}", process_id, stdout);
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                tracing::error!(
                    "Failed to close application with PID {}: {}",
                    process_id,
                    stderr
                );
            }
        }
    }

    Ok(())
}
