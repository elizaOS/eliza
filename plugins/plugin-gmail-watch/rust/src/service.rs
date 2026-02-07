use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::RwLock;
use tokio::task::JoinHandle;
use tracing::{debug, error, info, warn};

use crate::config::GmailWatchConfig;
use crate::error::{GmailWatchError, Result};

/// Maximum consecutive restart attempts before giving up.
pub const MAX_RESTART_ATTEMPTS: u32 = 10;
/// Initial delay before the first restart (in seconds).
pub const INITIAL_RESTART_DELAY_SECS: f64 = 10.0;
/// Maximum delay between restarts (in seconds).
pub const MAX_RESTART_DELAY_SECS: f64 = 300.0;

/// Calculate exponential backoff delay for a given attempt number.
///
/// # Arguments
/// * `attempt` - 1-based restart attempt number.
///
/// # Returns
/// The delay in seconds, clamped to [`MAX_RESTART_DELAY_SECS`].
pub fn calculate_backoff_delay(attempt: u32) -> f64 {
    if attempt < 1 {
        return INITIAL_RESTART_DELAY_SECS;
    }
    let delay = INITIAL_RESTART_DELAY_SECS * 2.0_f64.powi((attempt as i32) - 1);
    delay.min(MAX_RESTART_DELAY_SECS)
}

/// Build the argument list for `gog gmail watch serve`.
pub fn build_serve_args(config: &GmailWatchConfig) -> Vec<String> {
    let mut args = vec![
        "gmail".to_string(),
        "watch".to_string(),
        "serve".to_string(),
        "--account".to_string(),
        config.account.clone(),
        "--bind".to_string(),
        config.serve.bind.clone(),
        "--port".to_string(),
        config.serve.port.to_string(),
        "--path".to_string(),
        config.serve.path.clone(),
        "--hook-url".to_string(),
        config.hook_url.clone(),
    ];

    if !config.hook_token.is_empty() {
        args.push("--hook-token".to_string());
        args.push(config.hook_token.clone());
    }
    if !config.push_token.is_empty() {
        args.push("--token".to_string());
        args.push(config.push_token.clone());
    }
    if config.include_body {
        args.push("--include-body".to_string());
    }
    if config.max_bytes > 0 {
        args.push("--max-bytes".to_string());
        args.push(config.max_bytes.to_string());
    }

    args
}

/// Build the argument list for `gog gmail watch start` (renewal).
pub fn build_renew_args(config: &GmailWatchConfig) -> Vec<String> {
    let mut args = vec![
        "gmail".to_string(),
        "watch".to_string(),
        "start".to_string(),
        "--account".to_string(),
        config.account.clone(),
        "--label".to_string(),
        config.label.clone(),
    ];

    if !config.topic.is_empty() {
        args.push("--topic".to_string());
        args.push(config.topic.clone());
    }

    args
}

/// Locate the `gog` binary on the system PATH.
pub fn find_gog_binary() -> Option<std::path::PathBuf> {
    which::which("gog").ok()
}

#[derive(Default)]
struct ServiceState {
    is_running: bool,
    restart_attempts: u32,
}

/// Gmail Watch service that manages the `gog gmail watch serve` child process.
///
/// The service spawns a long-running `gog` process that receives
/// Google Pub/Sub push notifications, fetches message content via
/// the Gmail API, and forwards structured payloads to the webhooks
/// plugin. It also auto-renews the Gmail watch on a configurable
/// interval and restarts the child process with exponential backoff
/// on unexpected exits.
pub struct GmailWatchService {
    config: GmailWatchConfig,
    state: Arc<RwLock<ServiceState>>,
    child: Arc<RwLock<Option<Child>>>,
    renew_handle: Arc<RwLock<Option<JoinHandle<()>>>>,
    monitor_handle: Arc<RwLock<Option<JoinHandle<()>>>>,
}

impl GmailWatchService {
    /// Creates a new service from a validated [`GmailWatchConfig`].
    pub fn new(config: GmailWatchConfig) -> Self {
        Self {
            config,
            state: Arc::new(RwLock::new(ServiceState::default())),
            child: Arc::new(RwLock::new(None)),
            renew_handle: Arc::new(RwLock::new(None)),
            monitor_handle: Arc::new(RwLock::new(None)),
        }
    }

    /// Returns the service configuration.
    pub fn config(&self) -> &GmailWatchConfig {
        &self.config
    }

    /// Returns whether the service is currently running.
    pub async fn is_running(&self) -> bool {
        self.state.read().await.is_running
    }

    /// Returns the current number of consecutive restart attempts.
    pub async fn restart_attempts(&self) -> u32 {
        self.state.read().await.restart_attempts
    }

    /// Start the Gmail Watch service.
    ///
    /// This locates the `gog` binary, spawns the watcher process,
    /// and starts the periodic renewal timer.
    pub async fn start(&self) -> Result<()> {
        self.config.validate()?;

        if find_gog_binary().is_none() {
            warn!(
                "[GmailWatch] gog binary not found in PATH. \
                 Install gogcli: https://gogcli.sh/"
            );
            return Err(GmailWatchError::GogBinaryNotFound);
        }

        self.spawn_watcher().await?;
        self.start_renew_timer().await;

        {
            let mut state = self.state.write().await;
            state.is_running = true;
        }

        info!(
            "[GmailWatch] Started for {} (renew every {}m)",
            self.config.account, self.config.renew_every_minutes
        );

        Ok(())
    }

    /// Stop the Gmail Watch service.
    ///
    /// Kills the child process and cancels the renewal timer.
    pub async fn stop(&self) -> Result<()> {
        {
            let mut state = self.state.write().await;
            state.is_running = false;
        }

        // Cancel the renewal timer
        {
            let mut handle = self.renew_handle.write().await;
            if let Some(h) = handle.take() {
                h.abort();
            }
        }

        // Cancel the process monitor
        {
            let mut handle = self.monitor_handle.write().await;
            if let Some(h) = handle.take() {
                h.abort();
            }
        }

        // Kill the child process
        {
            let mut child_lock = self.child.write().await;
            if let Some(ref mut child) = *child_lock {
                let _ = child.kill().await;
            }
            *child_lock = None;
        }

        info!("[GmailWatch] Stopped");
        Ok(())
    }

    /// Spawn the `gog gmail watch serve` child process.
    async fn spawn_watcher(&self) -> Result<()> {
        let args = build_serve_args(&self.config);
        debug!("[GmailWatch] Spawning: gog {}", args.join(" "));

        let mut child = Command::new("gog")
            .args(&args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| GmailWatchError::ProcessError(e.to_string()))?;

        // Reset restart counter
        {
            let mut state = self.state.write().await;
            state.restart_attempts = 0;
        }

        // Spawn stdout reader
        if let Some(stdout) = child.stdout.take() {
            tokio::spawn(async move {
                let reader = BufReader::new(stdout);
                let mut lines = reader.lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if !line.is_empty() {
                        debug!("[GmailWatch:stdout] {}", line);
                    }
                }
            });
        }

        // Spawn stderr reader
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let reader = BufReader::new(stderr);
                let mut lines = reader.lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if !line.is_empty() {
                        warn!("[GmailWatch:stderr] {}", line);
                    }
                }
            });
        }

        // Store the child process
        {
            let mut child_lock = self.child.write().await;
            *child_lock = Some(child);
        }

        // Start monitoring for unexpected exit
        let state = Arc::clone(&self.state);
        let child_arc = Arc::clone(&self.child);
        let config = self.config.clone();
        let monitor = tokio::spawn(async move {
            Self::monitor_process(state, child_arc, config).await;
        });

        {
            let mut handle = self.monitor_handle.write().await;
            *handle = Some(monitor);
        }

        Ok(())
    }

    /// Wait for the child process to exit and optionally auto-restart.
    async fn monitor_process(
        state: Arc<RwLock<ServiceState>>,
        child_arc: Arc<RwLock<Option<Child>>>,
        config: GmailWatchConfig,
    ) {
        let exit_status = {
            let mut child_lock = child_arc.write().await;
            match child_lock.as_mut() {
                Some(child) => child.wait().await.ok(),
                None => return,
            }
        };

        let code = exit_status.and_then(|s| s.code());
        warn!(
            "[GmailWatch] Child process exited (code={:?})",
            code
        );

        // Clear the child reference
        {
            let mut child_lock = child_arc.write().await;
            *child_lock = None;
        }

        let is_running = state.read().await.is_running;
        if !is_running {
            return;
        }

        let attempt = {
            let mut st = state.write().await;
            st.restart_attempts += 1;
            st.restart_attempts
        };

        if attempt > MAX_RESTART_ATTEMPTS {
            error!(
                "[GmailWatch] Max restart attempts ({}) reached. \
                 Giving up. Check gog configuration and restart the service manually.",
                MAX_RESTART_ATTEMPTS
            );
            return;
        }

        let delay = calculate_backoff_delay(attempt);
        info!(
            "[GmailWatch] Auto-restarting in {:.0}s (attempt {}/{})",
            delay, attempt, MAX_RESTART_ATTEMPTS
        );

        tokio::time::sleep(Duration::from_secs_f64(delay)).await;

        let still_running = state.read().await.is_running;
        if !still_running {
            return;
        }

        // Re-spawn
        let args = build_serve_args(&config);
        match Command::new("gog")
            .args(&args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(child) => {
                let mut child_lock = child_arc.write().await;
                *child_lock = Some(child);
                let mut st = state.write().await;
                st.restart_attempts = 0;
                info!("[GmailWatch] Restarted successfully");
            }
            Err(e) => {
                error!("[GmailWatch] Failed to restart: {}", e);
            }
        }
    }

    /// Start the periodic watch renewal timer.
    async fn start_renew_timer(&self) {
        let interval = Duration::from_secs(
            (self.config.renew_every_minutes as u64) * 60,
        );
        let config = self.config.clone();

        let handle = tokio::spawn(async move {
            loop {
                tokio::time::sleep(interval).await;
                Self::renew_watch_static(&config).await;
            }
        });

        let mut renew_lock = self.renew_handle.write().await;
        *renew_lock = Some(handle);
    }

    /// Renew the Gmail watch by running `gog gmail watch start`.
    async fn renew_watch_static(config: &GmailWatchConfig) {
        info!("[GmailWatch] Renewing watch for {}", config.account);

        if find_gog_binary().is_none() {
            warn!("[GmailWatch] gog binary not found, cannot renew");
            return;
        }

        let args = build_renew_args(config);
        match Command::new("gog")
            .args(&args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .await
        {
            Ok(output) => {
                if !output.stdout.is_empty() {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    debug!("[GmailWatch:renew:stdout] {}", stdout.trim());
                }
                if !output.stderr.is_empty() {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    warn!("[GmailWatch:renew:stderr] {}", stderr.trim());
                }

                if output.status.success() {
                    info!("[GmailWatch] Watch renewed successfully");
                } else {
                    warn!(
                        "[GmailWatch] Watch renewal exited with code {:?}",
                        output.status.code()
                    );
                }
            }
            Err(e) => {
                warn!("[GmailWatch] Failed to run renewal command: {}", e);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_calculate_backoff_first() {
        assert!((calculate_backoff_delay(1) - INITIAL_RESTART_DELAY_SECS).abs() < f64::EPSILON);
    }

    #[test]
    fn test_calculate_backoff_second() {
        assert!(
            (calculate_backoff_delay(2) - INITIAL_RESTART_DELAY_SECS * 2.0).abs() < f64::EPSILON
        );
    }

    #[test]
    fn test_calculate_backoff_clamped() {
        assert!((calculate_backoff_delay(50) - MAX_RESTART_DELAY_SECS).abs() < f64::EPSILON);
    }

    #[test]
    fn test_calculate_backoff_zero_attempt() {
        assert!(
            (calculate_backoff_delay(0) - INITIAL_RESTART_DELAY_SECS).abs() < f64::EPSILON
        );
    }

    #[test]
    fn test_backoff_monotonically_non_decreasing() {
        let mut prev = 0.0;
        for i in 1..20 {
            let delay = calculate_backoff_delay(i);
            assert!(delay >= prev);
            prev = delay;
        }
    }

    #[test]
    fn test_all_attempts_within_bounds() {
        for i in 1..=MAX_RESTART_ATTEMPTS {
            let delay = calculate_backoff_delay(i);
            assert!(delay >= INITIAL_RESTART_DELAY_SECS);
            assert!(delay <= MAX_RESTART_DELAY_SECS);
        }
    }

    #[test]
    fn test_build_serve_args_basic() {
        let config = GmailWatchConfig::new("user@gmail.com".to_string())
            .with_hook_token("secret".to_string());
        let args = build_serve_args(&config);

        assert_eq!(&args[0..3], &["gmail", "watch", "serve"]);
        assert!(args.contains(&"--account".to_string()));
        assert!(args.contains(&"user@gmail.com".to_string()));
        assert!(args.contains(&"--bind".to_string()));
        assert!(args.contains(&"--port".to_string()));
        assert!(args.contains(&"--path".to_string()));
        assert!(args.contains(&"--hook-url".to_string()));
        assert!(args.contains(&"--hook-token".to_string()));
        assert!(args.contains(&"secret".to_string()));
    }

    #[test]
    fn test_build_serve_args_no_hook_token() {
        let config = GmailWatchConfig::new("a@b.com".to_string());
        let args = build_serve_args(&config);
        assert!(!args.contains(&"--hook-token".to_string()));
    }

    #[test]
    fn test_build_serve_args_include_body() {
        let config = GmailWatchConfig::new("a@b.com".to_string());
        let args = build_serve_args(&config);
        assert!(args.contains(&"--include-body".to_string()));
    }

    #[test]
    fn test_build_serve_args_no_include_body() {
        let config = GmailWatchConfig::new("a@b.com".to_string()).with_include_body(false);
        let args = build_serve_args(&config);
        assert!(!args.contains(&"--include-body".to_string()));
    }

    #[test]
    fn test_build_serve_args_push_token() {
        let config =
            GmailWatchConfig::new("a@b.com".to_string()).with_push_token("tok123".to_string());
        let args = build_serve_args(&config);
        assert!(args.contains(&"--token".to_string()));
        assert!(args.contains(&"tok123".to_string()));
    }

    #[test]
    fn test_build_renew_args_basic() {
        let config = GmailWatchConfig::new("a@b.com".to_string())
            .with_topic("projects/p/topics/t".to_string());
        let args = build_renew_args(&config);

        assert_eq!(&args[0..3], &["gmail", "watch", "start"]);
        assert!(args.contains(&"--account".to_string()));
        assert!(args.contains(&"--label".to_string()));
        assert!(args.contains(&"--topic".to_string()));
    }

    #[test]
    fn test_build_renew_args_no_topic() {
        let config = GmailWatchConfig::new("a@b.com".to_string());
        let args = build_renew_args(&config);
        assert!(!args.contains(&"--topic".to_string()));
    }

    #[test]
    fn test_service_creation() {
        let config = GmailWatchConfig::new("user@gmail.com".to_string());
        let service = GmailWatchService::new(config);
        assert_eq!(service.config().account, "user@gmail.com");
    }

    #[tokio::test]
    async fn test_service_initial_state() {
        let config = GmailWatchConfig::new("user@gmail.com".to_string());
        let service = GmailWatchService::new(config);
        assert!(!service.is_running().await);
        assert_eq!(service.restart_attempts().await, 0);
    }
}
