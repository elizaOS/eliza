//! Autonomy routes for HTTP API control.

use crate::types::plugin::{HttpMethod, RouteDefinition};

/// Create autonomy route definitions.
///
/// These routes provide HTTP API control for the autonomy service:
/// - GET /autonomy/status - Get current autonomy status
/// - POST /autonomy/enable - Enable autonomy
/// - POST /autonomy/disable - Disable autonomy
/// - POST /autonomy/toggle - Toggle autonomy state
/// - POST /autonomy/interval - Set loop interval
pub fn autonomy_routes() -> Vec<RouteDefinition> {
    vec![
        RouteDefinition {
            method: HttpMethod::Get,
            path: "/autonomy/status".to_string(),
            file_path: None,
            public: None,
            name: Some("Autonomy Status".to_string()),
            is_multipart: None,
        },
        RouteDefinition {
            method: HttpMethod::Post,
            path: "/autonomy/enable".to_string(),
            file_path: None,
            public: None,
            name: Some("Enable Autonomy".to_string()),
            is_multipart: None,
        },
        RouteDefinition {
            method: HttpMethod::Post,
            path: "/autonomy/disable".to_string(),
            file_path: None,
            public: None,
            name: Some("Disable Autonomy".to_string()),
            is_multipart: None,
        },
        RouteDefinition {
            method: HttpMethod::Post,
            path: "/autonomy/toggle".to_string(),
            file_path: None,
            public: None,
            name: Some("Toggle Autonomy".to_string()),
            is_multipart: None,
        },
        RouteDefinition {
            method: HttpMethod::Post,
            path: "/autonomy/interval".to_string(),
            file_path: None,
            public: None,
            name: Some("Set Autonomy Interval".to_string()),
            is_multipart: None,
        },
    ]
}
