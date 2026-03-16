use chrono::{DateTime, Utc};
use std::collections::HashMap;
use std::sync::RwLock;

/// A named waypoint with coordinates
#[derive(Debug, Clone)]
pub struct Waypoint {
    pub name: String,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub created_at: DateTime<Utc>,
}

/// Service for managing waypoints in memory
/// Note: For persistent storage, integrate with plugin-sql or a database
pub struct WaypointsService {
    waypoints: RwLock<HashMap<String, Waypoint>>,
}

impl Default for WaypointsService {
    fn default() -> Self {
        Self::new()
    }
}

impl WaypointsService {
    pub fn new() -> Self {
        Self {
            waypoints: RwLock::new(HashMap::new()),
        }
    }

    /// Set a waypoint at the given coordinates
    pub fn set_waypoint(&self, name: &str, x: f64, y: f64, z: f64) -> Waypoint {
        let waypoint = Waypoint {
            name: name.to_string(),
            x,
            y,
            z,
            created_at: Utc::now(),
        };
        let mut waypoints = self.waypoints.write().unwrap();
        waypoints.insert(name.to_string(), waypoint.clone());
        waypoint
    }

    /// Get a waypoint by name
    pub fn get_waypoint(&self, name: &str) -> Option<Waypoint> {
        let waypoints = self.waypoints.read().unwrap();
        waypoints.get(name).cloned()
    }

    /// Delete a waypoint by name
    pub fn delete_waypoint(&self, name: &str) -> bool {
        let mut waypoints = self.waypoints.write().unwrap();
        waypoints.remove(name).is_some()
    }

    /// List all waypoints
    pub fn list_waypoints(&self) -> Vec<Waypoint> {
        let waypoints = self.waypoints.read().unwrap();
        waypoints.values().cloned().collect()
    }
}
