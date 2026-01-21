//! Autonomy Service for elizaOS - Rust implementation.
//!
//! Provides autonomous operation loop for agents.

use std::sync::Arc;
use uuid::Uuid;

use super::types::AutonomyStatus;
use crate::bootstrap::error::PluginResult;
use crate::bootstrap::runtime::IAgentRuntime;
use crate::bootstrap::services::{Service, ServiceType};
use crate::prompts::{
    AUTONOMY_CONTINUOUS_CONTINUE_TEMPLATE, AUTONOMY_CONTINUOUS_FIRST_TEMPLATE,
    AUTONOMY_TASK_CONTINUE_TEMPLATE, AUTONOMY_TASK_FIRST_TEMPLATE,
};

/// Service type constant for autonomy.
pub const AUTONOMY_SERVICE_TYPE: &str = "AUTONOMY";

/// AutonomyService - Manages autonomous agent operation.
///
/// This service runs an autonomous loop that triggers agent thinking
/// in a dedicated room context, separate from user conversations.
pub struct AutonomyService {
    is_enabled: bool, // Whether autonomy is enabled in settings
    is_running: bool,
    is_thinking: bool, // Guard to prevent overlapping think cycles
    is_stopped: bool,  // Flag to indicate service has been stopped
    interval_ms: u64,
    autonomous_room_id: Uuid,
    autonomous_world_id: Uuid,
}

impl AutonomyService {
    /// Create a new AutonomyService.
    pub fn new() -> Self {
        Self {
            is_enabled: false,
            is_running: false,
            is_thinking: false,
            is_stopped: false,
            interval_ms: 30000,
            autonomous_room_id: Uuid::new_v4(),
            autonomous_world_id: Uuid::parse_str("00000000-0000-0000-0000-000000000001").unwrap(),
        }
    }

    /// Check if autonomy is enabled.
    pub fn is_enabled(&self) -> bool {
        self.is_enabled
    }

    /// Check if the service has been stopped.
    pub fn is_stopped(&self) -> bool {
        self.is_stopped
    }

    /// Check if currently processing an autonomous thought.
    /// Alias for `is_thinking_in_progress()` for internal use.
    pub fn is_thinking(&self) -> bool {
        self.is_thinking
    }

    /// Check if currently processing an autonomous thought (parity with TS/Python).
    pub fn is_thinking_in_progress(&self) -> bool {
        self.is_thinking
    }

    /// Set the thinking state (used by the autonomous loop).
    pub fn set_thinking(&mut self, thinking: bool) {
        self.is_thinking = thinking;
    }

    /// Check if the loop is currently running.
    pub fn is_loop_running(&self) -> bool {
        self.is_running
    }

    /// Start the autonomous loop.
    /// Returns false if the service has been stopped or is already running.
    pub async fn start_loop(&mut self) -> bool {
        // Don't start if service has been stopped
        if self.is_stopped {
            return false;
        }
        if self.is_running {
            return false;
        }
        self.is_running = true;
        // Note: Full loop implementation requires tokio spawn
        // This sets the state for parity with TS/Python
        true
    }

    /// Stop the autonomous loop.
    /// Returns false if not running.
    pub async fn stop_loop(&mut self) -> bool {
        if !self.is_running {
            return false;
        }
        self.is_running = false;
        // Note: Full loop cancellation requires tokio task management
        true
    }

    /// Completely stop the service (cannot be restarted).
    pub async fn stop_service(&mut self) {
        self.is_stopped = true;
        self.stop_loop().await;
    }

    /// Get current loop interval in milliseconds.
    pub fn get_loop_interval(&self) -> u64 {
        self.interval_ms
    }

    /// Set loop interval (takes effect on next iteration).
    /// Enforces minimum of 5000ms and maximum of 600000ms.
    pub fn set_loop_interval(&mut self, ms: u64) {
        const MIN_INTERVAL: u64 = 5000;
        const MAX_INTERVAL: u64 = 600000;

        // Note: In full implementation, would log warnings like TS/Python
        // when interval is clamped
        self.interval_ms = ms.max(MIN_INTERVAL).min(MAX_INTERVAL);
    }

    /// Get the capability description.
    pub fn capability_description(&self) -> &str {
        "Autonomous operation loop for continuous agent thinking and actions"
    }

    /// Create the continuous prompt for autonomous thinking.
    pub fn create_continuous_prompt(
        &self,
        last_thought: Option<&str>,
        is_first_thought: bool,
    ) -> String {
        let template = if is_first_thought {
            AUTONOMY_CONTINUOUS_FIRST_TEMPLATE
        } else {
            AUTONOMY_CONTINUOUS_CONTINUE_TEMPLATE
        };
        Self::fill_autonomy_template(template, last_thought)
    }

    /// Create the task prompt for autonomous thinking.
    pub fn create_task_prompt(&self, last_thought: Option<&str>, is_first_thought: bool) -> String {
        let template = if is_first_thought {
            AUTONOMY_TASK_FIRST_TEMPLATE
        } else {
            AUTONOMY_TASK_CONTINUE_TEMPLATE
        };
        Self::fill_autonomy_template(template, last_thought)
    }

    fn fill_autonomy_template(template: &str, last_thought: Option<&str>) -> String {
        let mut output = template.replace("{{targetRoomContext}}", "(no target room configured)");
        output = output.replace("{{lastThought}}", last_thought.unwrap_or(""));
        output
    }

    /// Get the autonomous room ID.
    pub fn get_autonomous_room_id(&self) -> Uuid {
        self.autonomous_room_id
    }

    /// Get current autonomy status.
    pub fn get_status(&self) -> AutonomyStatus {
        AutonomyStatus {
            enabled: self.is_enabled,
            running: self.is_running,
            thinking: self.is_thinking,
            interval: self.interval_ms,
            autonomous_room_id: self.autonomous_room_id,
        }
    }

    /// Enable autonomy (sets enabled flag and starts loop if not stopped).
    pub async fn enable_autonomy(&mut self) {
        self.is_enabled = true;
        if !self.is_stopped && !self.is_running {
            self.start_loop().await;
        }
    }

    /// Disable autonomy (sets enabled flag and stops loop).
    pub async fn disable_autonomy(&mut self) {
        self.is_enabled = false;
        if self.is_running {
            self.stop_loop().await;
        }
    }
}

impl Default for AutonomyService {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl Service for AutonomyService {
    fn name(&self) -> &'static str {
        AUTONOMY_SERVICE_TYPE
    }

    fn service_type(&self) -> ServiceType {
        ServiceType::Core
    }

    async fn start(&mut self, runtime: Arc<dyn IAgentRuntime>) -> PluginResult<()> {
        runtime.log_info(
            "autonomy",
            &format!("Using autonomous room ID: {}", self.autonomous_room_id),
        );

        // Note: Full autonomous loop implementation would require async runtime integration
        // This is a simplified version that sets up the service structure

        runtime.log_info("autonomy", "Autonomy service initialized");
        Ok(())
    }

    async fn stop(&mut self) -> PluginResult<()> {
        self.is_enabled = false;
        self.is_thinking = false;
        self.is_stopped = true;
        self.is_running = false;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_service_type() {
        assert_eq!(AUTONOMY_SERVICE_TYPE, "AUTONOMY");
    }

    #[test]
    fn test_service_creation() {
        let service = AutonomyService::new();

        assert!(!service.is_loop_running());
        assert_eq!(service.get_loop_interval(), 30000);

        // Room ID should be a valid UUID
        let room_id = service.get_autonomous_room_id();
        assert!(!room_id.is_nil());
    }

    #[test]
    fn test_default_impl() {
        let service = AutonomyService::default();

        assert!(!service.is_loop_running());
        assert_eq!(service.get_loop_interval(), 30000);
    }

    #[test]
    fn test_interval_configuration() {
        let mut service = AutonomyService::new();

        // Set valid interval
        service.set_loop_interval(60000);
        assert_eq!(service.get_loop_interval(), 60000);
    }

    #[test]
    fn test_interval_minimum_enforced() {
        let mut service = AutonomyService::new();

        // Try to set interval below minimum (5000ms)
        service.set_loop_interval(1000);
        assert_eq!(service.get_loop_interval(), 5000);
    }

    #[test]
    fn test_interval_maximum_enforced() {
        let mut service = AutonomyService::new();

        // Try to set interval above maximum (600000ms)
        service.set_loop_interval(1000000);
        assert_eq!(service.get_loop_interval(), 600000);
    }

    #[test]
    fn test_get_status() {
        let service = AutonomyService::new();
        let status = service.get_status();

        // Initially: not enabled, not running, not thinking
        assert!(!status.enabled);
        assert!(!status.running);
        assert!(!status.thinking);
        assert_eq!(status.interval, 30000);
        assert_eq!(status.autonomous_room_id, service.get_autonomous_room_id());
    }

    #[test]
    fn test_is_enabled() {
        let service = AutonomyService::new();
        assert!(!service.is_enabled());
    }

    #[test]
    fn test_thinking_guard() {
        let mut service = AutonomyService::new();

        // Initially not thinking
        assert!(!service.is_thinking());

        // Set thinking
        service.set_thinking(true);
        assert!(service.is_thinking());
        assert!(service.get_status().thinking);

        // Clear thinking
        service.set_thinking(false);
        assert!(!service.is_thinking());
        assert!(!service.get_status().thinking);
    }

    #[tokio::test]
    async fn test_enable_autonomy() {
        let mut service = AutonomyService::new();

        assert!(!service.is_loop_running());
        assert!(!service.is_enabled());

        service.enable_autonomy().await;

        assert!(service.is_loop_running());
        assert!(service.is_enabled());
        assert!(service.get_status().enabled);
    }

    #[tokio::test]
    async fn test_disable_autonomy() {
        let mut service = AutonomyService::new();

        service.enable_autonomy().await;
        assert!(service.is_loop_running());
        assert!(service.is_enabled());

        service.disable_autonomy().await;
        assert!(!service.is_loop_running());
        assert!(!service.is_enabled());
    }

    #[tokio::test]
    async fn test_enable_disable_cycle() {
        let mut service = AutonomyService::new();

        // Initial state
        assert!(!service.is_loop_running());
        assert!(!service.is_enabled());

        // Enable
        service.enable_autonomy().await;
        assert!(service.is_loop_running());
        assert!(service.is_enabled());
        assert!(service.get_status().enabled);
        assert!(service.get_status().running);

        // Disable
        service.disable_autonomy().await;
        assert!(!service.is_loop_running());
        assert!(!service.is_enabled());
        assert!(!service.get_status().enabled);
        assert!(!service.get_status().running);

        // Re-enable
        service.enable_autonomy().await;
        assert!(service.is_loop_running());
        assert!(service.is_enabled());
    }

    #[tokio::test]
    async fn test_start_stop_loop() {
        let mut service = AutonomyService::new();

        // Initially not running
        assert!(!service.is_loop_running());

        // Start loop
        service.start_loop().await;
        assert!(service.is_loop_running());

        // Start again should be no-op
        service.start_loop().await;
        assert!(service.is_loop_running());

        // Stop loop
        service.stop_loop().await;
        assert!(!service.is_loop_running());

        // Stop again should be no-op
        service.stop_loop().await;
        assert!(!service.is_loop_running());
    }

    #[test]
    fn test_is_thinking_in_progress_alias() {
        let mut service = AutonomyService::new();

        // Both methods should return same value
        assert_eq!(service.is_thinking(), service.is_thinking_in_progress());

        service.set_thinking(true);
        assert_eq!(service.is_thinking(), service.is_thinking_in_progress());
        assert!(service.is_thinking_in_progress());

        service.set_thinking(false);
        assert_eq!(service.is_thinking(), service.is_thinking_in_progress());
        assert!(!service.is_thinking_in_progress());
    }

    #[test]
    fn test_capability_description() {
        let service = AutonomyService::new();

        assert!(service.capability_description().contains("Autonomous"));
        assert!(service.capability_description().contains("thinking"));
    }

    #[test]
    fn test_create_continuous_prompt_first_thought() {
        let service = AutonomyService::new();

        let prompt = service.create_continuous_prompt(None, true);

        assert!(prompt.contains("AUTONOMOUS CONTINUOUS MODE"));
        assert!(prompt.contains("decide what you want to do next"));
    }

    #[test]
    fn test_create_continuous_prompt_continuation() {
        let service = AutonomyService::new();

        let prompt =
            service.create_continuous_prompt(Some("I was thinking about consciousness"), false);

        assert!(prompt.contains("Your last autonomous note"));
        assert!(prompt.contains("I was thinking about consciousness"));
    }

    #[test]
    fn test_create_task_prompt_first_thought() {
        let service = AutonomyService::new();

        let prompt = service.create_task_prompt(None, true);

        assert!(prompt.contains("AUTONOMOUS TASK MODE"));
        assert!(prompt.contains("ComputerUse"));
        assert!(prompt.contains("MCP mode"));
    }

    #[test]
    fn test_create_task_prompt_continuation() {
        let service = AutonomyService::new();

        let prompt = service.create_task_prompt(Some("Working on the task"), false);

        assert!(prompt.contains("Your last autonomous note"));
        assert!(prompt.contains("Working on the task"));
    }

    #[test]
    fn test_is_stopped_initial() {
        let service = AutonomyService::new();

        assert!(!service.is_stopped());
    }

    #[tokio::test]
    async fn test_stop_service() {
        let mut service = AutonomyService::new();

        // Start the loop
        assert!(service.start_loop().await);
        assert!(service.is_loop_running());

        // Stop the service completely
        service.stop_service().await;

        assert!(service.is_stopped());
        assert!(!service.is_loop_running());
    }

    #[tokio::test]
    async fn test_cannot_start_after_stop() {
        let mut service = AutonomyService::new();

        // Stop the service
        service.stop_service().await;

        // Try to start - should fail
        let started = service.start_loop().await;

        assert!(!started);
        assert!(!service.is_loop_running());
    }

    #[tokio::test]
    async fn test_start_loop_returns_false_when_already_running() {
        let mut service = AutonomyService::new();

        // First start should succeed
        assert!(service.start_loop().await);

        // Second start should return false (already running)
        assert!(!service.start_loop().await);
    }

    #[tokio::test]
    async fn test_stop_loop_returns_false_when_not_running() {
        let mut service = AutonomyService::new();

        // Stop when not running should return false
        assert!(!service.stop_loop().await);
    }
}
