pub mod vision;
pub mod waypoints;
pub mod world_state;

use serde_json::Value;
use std::collections::HashMap;

/// Provider result struct used across all providers
pub struct ProviderResult {
    pub text: String,
    pub values: HashMap<String, Value>,
    pub data: HashMap<String, Value>,
}

pub use vision::get_vision;
pub use waypoints::get_waypoints;
pub use world_state::get_world_state;

