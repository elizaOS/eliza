//! Autonomy types.

use crate::types::primitives::UUID;
use serde::{Deserialize, Serialize};

/// Current autonomy status (mirrors TS `AutonomyStatus`).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutonomyStatus {
    /// Whether autonomy is enabled (setting state).
    pub enabled: bool,
    /// Whether the loop is currently running.
    pub running: bool,
    /// Whether a think cycle is currently in progress.
    pub thinking: bool,
    /// Think interval in milliseconds.
    pub interval: u64,
    /// The autonomous room ID used for internal thoughts.
    pub autonomous_room_id: UUID,
}
