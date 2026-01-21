//! Autonomy Types for elizaOS - Rust implementation.
//!
//! Defines types for autonomous agent operation.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Status information for the autonomy service.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutonomyStatus {
    /// Whether autonomy is enabled in settings.
    pub enabled: bool,
    /// Whether the autonomy loop is currently running.
    pub running: bool,
    /// Whether an autonomous think cycle is currently in progress.
    pub thinking: bool,
    /// Interval between autonomous thoughts in milliseconds.
    pub interval: u64,
    /// ID of the dedicated autonomous room.
    pub autonomous_room_id: Uuid,
}

/// Configuration for autonomous operation.
#[derive(Debug, Clone)]
pub struct AutonomyConfig {
    /// Interval between autonomous thoughts in milliseconds (default: 30000).
    pub interval_ms: u64,
    /// Auto-start autonomy when enabled in settings.
    pub auto_start: bool,
}

impl Default for AutonomyConfig {
    fn default() -> Self {
        Self {
            interval_ms: 30000,
            auto_start: false,
        }
    }
}
