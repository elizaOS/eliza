//! Monitoring and alerting module for production deployments
//!
//! Provides hooks for observability, metrics collection, and alerting.

use crate::types::AgentRunResult;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Metrics for monitoring agent performance
#[derive(Debug, Default)]
pub struct AgentMetrics {
    /// Total runs started
    pub runs_started: AtomicU64,
    /// Total runs completed successfully
    pub runs_completed: AtomicU64,
    /// Total runs failed
    pub runs_failed: AtomicU64,
    /// Total cost in micro-dollars
    pub total_cost_micros: AtomicU64,
    /// Total tokens sent
    pub total_tokens_sent: AtomicU64,
    /// Total tokens received
    pub total_tokens_received: AtomicU64,
    /// Total API calls
    pub total_api_calls: AtomicU64,
    /// Total execution time in milliseconds
    pub total_execution_time_ms: AtomicU64,
}

impl AgentMetrics {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record_run_start(&self) {
        self.runs_started.fetch_add(1, Ordering::SeqCst);
    }

    pub fn record_run_complete(&self, result: &AgentRunResult) {
        let is_error = result
            .info
            .exit_status
            .as_ref()
            .map(|s| s.contains("error"))
            .unwrap_or(false);

        if is_error {
            self.runs_failed.fetch_add(1, Ordering::SeqCst);
        } else {
            self.runs_completed.fetch_add(1, Ordering::SeqCst);
        }

        // Record model stats if available
        if let Some(ref stats) = result.info.model_stats {
            self.total_cost_micros
                .fetch_add((stats.instance_cost * 1_000_000.0) as u64, Ordering::SeqCst);
            self.total_tokens_sent
                .fetch_add(stats.tokens_sent, Ordering::SeqCst);
            self.total_tokens_received
                .fetch_add(stats.tokens_received, Ordering::SeqCst);
            self.total_api_calls
                .fetch_add(stats.api_calls, Ordering::SeqCst);
        }
    }

    pub fn record_execution_time(&self, duration: Duration) {
        self.total_execution_time_ms
            .fetch_add(duration.as_millis() as u64, Ordering::SeqCst);
    }

    /// Get current metrics as a snapshot
    pub fn snapshot(&self) -> MetricsSnapshot {
        MetricsSnapshot {
            runs_started: self.runs_started.load(Ordering::SeqCst),
            runs_completed: self.runs_completed.load(Ordering::SeqCst),
            runs_failed: self.runs_failed.load(Ordering::SeqCst),
            total_cost: self.total_cost_micros.load(Ordering::SeqCst) as f64 / 1_000_000.0,
            total_tokens_sent: self.total_tokens_sent.load(Ordering::SeqCst),
            total_tokens_received: self.total_tokens_received.load(Ordering::SeqCst),
            total_api_calls: self.total_api_calls.load(Ordering::SeqCst),
            total_execution_time_ms: self.total_execution_time_ms.load(Ordering::SeqCst),
        }
    }
}

/// Immutable snapshot of metrics for reporting
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetricsSnapshot {
    pub runs_started: u64,
    pub runs_completed: u64,
    pub runs_failed: u64,
    pub total_cost: f64,
    pub total_tokens_sent: u64,
    pub total_tokens_received: u64,
    pub total_api_calls: u64,
    pub total_execution_time_ms: u64,
}

impl MetricsSnapshot {
    /// Calculate success rate
    pub fn success_rate(&self) -> f64 {
        if self.runs_started == 0 {
            return 0.0;
        }
        self.runs_completed as f64 / self.runs_started as f64
    }

    /// Calculate average cost per run
    pub fn avg_cost_per_run(&self) -> f64 {
        if self.runs_started == 0 {
            return 0.0;
        }
        self.total_cost / self.runs_started as f64
    }

    /// Calculate average execution time
    pub fn avg_execution_time_ms(&self) -> f64 {
        if self.runs_started == 0 {
            return 0.0;
        }
        self.total_execution_time_ms as f64 / self.runs_started as f64
    }
}

/// Alert severity levels
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AlertSeverity {
    Info,
    Warning,
    Error,
    Critical,
}

/// Alert information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Alert {
    pub severity: AlertSeverity,
    pub message: String,
    pub timestamp: chrono::DateTime<chrono::Utc>,
    pub context: HashMap<String, serde_json::Value>,
}

impl Alert {
    pub fn new(severity: AlertSeverity, message: impl Into<String>) -> Self {
        Self {
            severity,
            message: message.into(),
            timestamp: chrono::Utc::now(),
            context: HashMap::new(),
        }
    }

    pub fn with_context(mut self, key: impl Into<String>, value: impl Serialize) -> Self {
        self.context
            .insert(key.into(), serde_json::to_value(value).unwrap_or_default());
        self
    }
}

/// Trait for alert handlers
pub trait AlertHandler: Send + Sync {
    fn handle(&self, alert: &Alert);
}

/// Log-based alert handler (default)
pub struct LogAlertHandler;

impl AlertHandler for LogAlertHandler {
    fn handle(&self, alert: &Alert) {
        match alert.severity {
            AlertSeverity::Info => tracing::info!(
                message = %alert.message,
                context = ?alert.context,
                "Alert"
            ),
            AlertSeverity::Warning => tracing::warn!(
                message = %alert.message,
                context = ?alert.context,
                "Alert"
            ),
            AlertSeverity::Error => tracing::error!(
                message = %alert.message,
                context = ?alert.context,
                "Alert"
            ),
            AlertSeverity::Critical => tracing::error!(
                message = %alert.message,
                context = ?alert.context,
                severity = "CRITICAL",
                "Alert"
            ),
        }
    }
}

/// Webhook-based alert handler for external services (Slack, PagerDuty, etc.)
pub struct WebhookAlertHandler {
    url: String,
    client: reqwest::Client,
    min_severity: AlertSeverity,
}

impl WebhookAlertHandler {
    pub fn new(url: impl Into<String>, min_severity: AlertSeverity) -> Self {
        Self {
            url: url.into(),
            client: reqwest::Client::new(),
            min_severity,
        }
    }

    fn should_send(&self, severity: AlertSeverity) -> bool {
        matches!(
            (self.min_severity, severity),
            (AlertSeverity::Critical, AlertSeverity::Critical)
                | (AlertSeverity::Error, AlertSeverity::Critical | AlertSeverity::Error)
                | (AlertSeverity::Warning, AlertSeverity::Critical | AlertSeverity::Error | AlertSeverity::Warning)
                | (AlertSeverity::Info, _)
        )
    }
}

impl AlertHandler for WebhookAlertHandler {
    fn handle(&self, alert: &Alert) {
        if !self.should_send(alert.severity) {
            return;
        }

        let url = self.url.clone();
        let payload = serde_json::json!({
            "severity": alert.severity,
            "message": alert.message,
            "timestamp": alert.timestamp.to_rfc3339(),
            "context": alert.context,
        });

        let client = self.client.clone();

        // Fire and forget - don't block on webhook
        tokio::spawn(async move {
            if let Err(e) = client.post(&url).json(&payload).send().await {
                tracing::warn!(error = %e, "Failed to send webhook alert");
            }
        });
    }
}

/// Alert thresholds for automatic alerting
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlertThresholds {
    /// Alert if cost exceeds this amount
    pub cost_limit: f64,
    /// Alert if failure rate exceeds this percentage
    pub failure_rate_percent: f64,
    /// Alert if average execution time exceeds this (ms)
    pub execution_time_ms: u64,
    /// Alert if API calls exceed this limit
    pub api_calls_limit: u64,
}

impl Default for AlertThresholds {
    fn default() -> Self {
        Self {
            cost_limit: 100.0,          // $100
            failure_rate_percent: 20.0, // 20%
            execution_time_ms: 600_000, // 10 minutes
            api_calls_limit: 10_000,    // 10k calls
        }
    }
}

/// Monitor that checks metrics against thresholds
pub struct MetricsMonitor {
    metrics: Arc<AgentMetrics>,
    thresholds: AlertThresholds,
    handlers: Vec<Box<dyn AlertHandler>>,
    #[allow(dead_code)]
    last_check: std::sync::Mutex<Instant>,
}

impl MetricsMonitor {
    pub fn new(metrics: Arc<AgentMetrics>, thresholds: AlertThresholds) -> Self {
        Self {
            metrics,
            thresholds,
            handlers: vec![Box::new(LogAlertHandler)],
            last_check: std::sync::Mutex::new(Instant::now()),
        }
    }

    pub fn add_handler(&mut self, handler: Box<dyn AlertHandler>) {
        self.handlers.push(handler);
    }

    pub fn check(&self) {
        let snapshot = self.metrics.snapshot();

        // Check cost limit
        if snapshot.total_cost > self.thresholds.cost_limit {
            self.alert(
                Alert::new(
                    AlertSeverity::Warning,
                    format!(
                        "Cost limit exceeded: ${:.2} > ${:.2}",
                        snapshot.total_cost, self.thresholds.cost_limit
                    ),
                )
                .with_context("total_cost", snapshot.total_cost),
            );
        }

        // Check failure rate
        let failure_rate = if snapshot.runs_started > 0 {
            100.0 * snapshot.runs_failed as f64 / snapshot.runs_started as f64
        } else {
            0.0
        };

        if failure_rate > self.thresholds.failure_rate_percent && snapshot.runs_started >= 10 {
            self.alert(
                Alert::new(
                    AlertSeverity::Error,
                    format!(
                        "High failure rate: {:.1}% > {:.1}%",
                        failure_rate, self.thresholds.failure_rate_percent
                    ),
                )
                .with_context("failure_rate", failure_rate)
                .with_context("runs_failed", snapshot.runs_failed)
                .with_context("runs_started", snapshot.runs_started),
            );
        }

        // Check API calls
        if snapshot.total_api_calls > self.thresholds.api_calls_limit {
            self.alert(
                Alert::new(
                    AlertSeverity::Warning,
                    format!(
                        "API call limit exceeded: {} > {}",
                        snapshot.total_api_calls, self.thresholds.api_calls_limit
                    ),
                )
                .with_context("api_calls", snapshot.total_api_calls),
            );
        }
    }

    fn alert(&self, alert: Alert) {
        for handler in &self.handlers {
            handler.handle(&alert);
        }
    }
}

/// Health check status
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthStatus {
    pub healthy: bool,
    pub components: HashMap<String, ComponentHealth>,
    pub timestamp: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComponentHealth {
    pub healthy: bool,
    pub message: String,
}

impl HealthStatus {
    pub fn new() -> Self {
        Self {
            healthy: true,
            components: HashMap::new(),
            timestamp: chrono::Utc::now(),
        }
    }

    pub fn add_component(
        &mut self,
        name: impl Into<String>,
        healthy: bool,
        message: impl Into<String>,
    ) {
        let name = name.into();
        if !healthy {
            self.healthy = false;
        }
        self.components.insert(
            name,
            ComponentHealth {
                healthy,
                message: message.into(),
            },
        );
    }
}

impl Default for HealthStatus {
    fn default() -> Self {
        Self::new()
    }
}

/// Perform a health check
pub async fn health_check() -> HealthStatus {
    let mut status = HealthStatus::new();

    // Check Docker availability
    let docker_check = tokio::process::Command::new("docker")
        .arg("info")
        .output()
        .await;

    match docker_check {
        Ok(output) if output.status.success() => {
            status.add_component("docker", true, "Docker daemon is running");
        }
        Ok(_) => {
            status.add_component("docker", false, "Docker daemon not responding");
        }
        Err(e) => {
            status.add_component("docker", false, format!("Docker not available: {}", e));
        }
    }

    // Check environment variables
    let has_api_key =
        std::env::var("OPENAI_API_KEY").is_ok() || std::env::var("ANTHROPIC_API_KEY").is_ok();

    status.add_component(
        "api_keys",
        has_api_key,
        if has_api_key {
            "API keys configured"
        } else {
            "No API keys found"
        },
    );

    status
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_metrics_snapshot() {
        let metrics = AgentMetrics::new();
        metrics.runs_started.store(10, Ordering::SeqCst);
        metrics.runs_completed.store(8, Ordering::SeqCst);
        metrics.runs_failed.store(2, Ordering::SeqCst);

        let snapshot = metrics.snapshot();
        assert_eq!(snapshot.runs_started, 10);
        assert!((snapshot.success_rate() - 0.8).abs() < 0.001);
    }

    #[test]
    fn test_alert_with_context() {
        let alert = Alert::new(AlertSeverity::Warning, "Test alert")
            .with_context("count", 42)
            .with_context("name", "test");

        assert_eq!(alert.severity, AlertSeverity::Warning);
        assert_eq!(alert.context.len(), 2);
    }

    #[test]
    fn test_health_status() {
        let mut status = HealthStatus::new();
        assert!(status.healthy);

        status.add_component("test", false, "Failed");
        assert!(!status.healthy);
    }
}
