//! Vision plugin providers
//!
//! This module contains all providers for the vision plugin,
//! providing parity with TypeScript and Python implementations.

use crate::types::{ProviderResult, SceneDescription, TrackingStatistics, VisionMode};
use async_trait::async_trait;
use serde_json::json;

/// Provider trait for vision providers
#[async_trait]
pub trait VisionProvider: Send + Sync {
    /// Provider name
    fn name(&self) -> &'static str;

    /// Provider description
    fn description(&self) -> &'static str;

    /// Whether provider is dynamic
    fn dynamic(&self) -> bool;

    /// Get provider state
    async fn get(&self, context: &ProviderContext) -> ProviderResult;
}

/// Provider context
#[derive(Debug, Clone, Default)]
pub struct ProviderContext {
    /// Whether vision service is available
    pub vision_available: bool,
    /// Whether vision service is active
    pub vision_active: bool,
    /// Current vision mode
    pub vision_mode: VisionMode,
    /// Current scene description
    pub scene: Option<SceneDescription>,
    /// Entity tracking statistics
    pub tracking_stats: Option<TrackingStatistics>,
    /// Room ID
    pub room_id: Option<String>,
    /// World ID
    pub world_id: Option<String>,
}

// ============================================================================
// Vision Provider
// ============================================================================

/// Main vision state provider
pub struct VisionStateProvider;

impl VisionStateProvider {
    /// Provider name constant
    pub const NAME: &'static str = "VISION";
    /// Provider description
    pub const DESCRIPTION: &'static str = "Provides current visual perception state including scene analysis, detected entities, and tracking information";
}

#[async_trait]
impl VisionProvider for VisionStateProvider {
    fn name(&self) -> &'static str {
        Self::NAME
    }

    fn description(&self) -> &'static str {
        Self::DESCRIPTION
    }

    fn dynamic(&self) -> bool {
        true
    }

    async fn get(&self, context: &ProviderContext) -> ProviderResult {
        if !context.vision_available {
            return ProviderResult {
                text: "Vision service is not available.".to_string(),
                values: json!({
                    "vision_available": false
                }),
                data: json!({
                    "provider_name": Self::NAME
                }),
            };
        }

        if !context.vision_active {
            return ProviderResult {
                text: format!("Vision mode is currently {}.", context.vision_mode),
                values: json!({
                    "vision_available": true,
                    "vision_active": false,
                    "vision_mode": context.vision_mode.to_string()
                }),
                data: json!({
                    "provider_name": Self::NAME
                }),
            };
        }

        let mut text_parts = vec![format!("Vision is active in {} mode.", context.vision_mode)];

        if let Some(ref scene) = context.scene {
            text_parts.push(format!("Scene: {}", scene.description));

            if !scene.people.is_empty() {
                let people_count = scene.people.len();
                text_parts.push(format!(
                    "Detected {} {}.",
                    people_count,
                    if people_count == 1 {
                        "person"
                    } else {
                        "people"
                    }
                ));
            }

            if !scene.objects.is_empty() {
                let object_count = scene.objects.len();
                text_parts.push(format!(
                    "Detected {} {}.",
                    object_count,
                    if object_count == 1 {
                        "object"
                    } else {
                        "objects"
                    }
                ));
            }
        }

        if let Some(ref stats) = context.tracking_stats {
            text_parts.push(format!(
                "Tracking {} entities ({} people, {} objects).",
                stats.active_entities, stats.people, stats.objects
            ));
        }

        ProviderResult {
            text: text_parts.join(" "),
            values: json!({
                "vision_available": true,
                "vision_active": true,
                "vision_mode": context.vision_mode.to_string(),
                "has_scene": context.scene.is_some(),
                "people_count": context.scene.as_ref().map(|s| s.people.len()).unwrap_or(0),
                "object_count": context.scene.as_ref().map(|s| s.objects.len()).unwrap_or(0),
                "active_entities": context.tracking_stats.as_ref().map(|s| s.active_entities).unwrap_or(0)
            }),
            data: json!({
                "provider_name": Self::NAME,
                "scene": context.scene,
                "tracking_stats": context.tracking_stats
            }),
        }
    }
}

/// TS-parity alias provider (name: `VISION_PERCEPTION`).
pub struct VisionPerceptionProvider;

impl VisionPerceptionProvider {
    /// The provider name used for TS-parity routing/registration.
    pub const NAME: &'static str = "VISION_PERCEPTION";

    /// A human-readable description of what this provider returns.
    pub const DESCRIPTION: &'static str =
        "Provides current visual perception data including scene description, detected objects, people, and entity tracking.";
}

#[async_trait]
impl VisionProvider for VisionPerceptionProvider {
    fn name(&self) -> &'static str {
        Self::NAME
    }

    fn description(&self) -> &'static str {
        Self::DESCRIPTION
    }

    fn dynamic(&self) -> bool {
        false
    }

    async fn get(&self, context: &ProviderContext) -> ProviderResult {
        let mut result = VisionStateProvider.get(context).await;
        // Prefer the TS-parity provider name in the structured data.
        if let Some(obj) = result.data.as_object_mut() {
            obj.insert("provider_name".to_string(), json!(Self::NAME));
        }
        result
    }
}

// ============================================================================
// Entity Tracking Provider
// ============================================================================

/// Entity tracking state provider
pub struct EntityTrackingProvider;

impl EntityTrackingProvider {
    /// Provider name constant
    pub const NAME: &'static str = "ENTITY_TRACKING";
    /// Provider description
    pub const DESCRIPTION: &'static str =
        "Provides information about tracked entities in the visual field";
}

#[async_trait]
impl VisionProvider for EntityTrackingProvider {
    fn name(&self) -> &'static str {
        Self::NAME
    }

    fn description(&self) -> &'static str {
        Self::DESCRIPTION
    }

    fn dynamic(&self) -> bool {
        true
    }

    async fn get(&self, context: &ProviderContext) -> ProviderResult {
        if !context.vision_available || !context.vision_active {
            return ProviderResult {
                text: "Entity tracking is not available.".to_string(),
                values: json!({
                    "tracking_available": false
                }),
                data: json!({
                    "provider_name": Self::NAME
                }),
            };
        }

        match &context.tracking_stats {
            Some(stats) => {
                let text = if stats.active_entities == 0 {
                    "No entities currently being tracked.".to_string()
                } else {
                    format!(
                        "Tracking {} entities: {} people, {} objects. {} named entities.",
                        stats.active_entities, stats.people, stats.objects, stats.named_entities
                    )
                };

                ProviderResult {
                    text,
                    values: json!({
                        "tracking_available": true,
                        "active_entities": stats.active_entities,
                        "people": stats.people,
                        "objects": stats.objects,
                        "named_entities": stats.named_entities,
                        "recently_left": stats.recently_left
                    }),
                    data: json!({
                        "provider_name": Self::NAME,
                        "stats": stats
                    }),
                }
            }
            None => ProviderResult {
                text: "Entity tracking statistics not available.".to_string(),
                values: json!({
                    "tracking_available": true,
                    "stats_available": false
                }),
                data: json!({
                    "provider_name": Self::NAME
                }),
            },
        }
    }
}

// ============================================================================
// Camera Info Provider
// ============================================================================

/// Camera information provider
pub struct CameraInfoProvider;

impl CameraInfoProvider {
    /// Provider name constant
    pub const NAME: &'static str = "CAMERA_INFO";
    /// Provider description
    pub const DESCRIPTION: &'static str = "Provides information about connected cameras";
}

#[async_trait]
impl VisionProvider for CameraInfoProvider {
    fn name(&self) -> &'static str {
        Self::NAME
    }

    fn description(&self) -> &'static str {
        Self::DESCRIPTION
    }

    fn dynamic(&self) -> bool {
        false
    }

    async fn get(&self, context: &ProviderContext) -> ProviderResult {
        if !context.vision_available {
            return ProviderResult {
                text: "Camera information not available - vision service offline.".to_string(),
                values: json!({
                    "camera_available": false
                }),
                data: json!({
                    "provider_name": Self::NAME
                }),
            };
        }

        // In a full implementation, this would query actual camera info
        ProviderResult {
            text: "Camera service is available.".to_string(),
            values: json!({
                "camera_available": true,
                "vision_mode": context.vision_mode.to_string()
            }),
            data: json!({
                "provider_name": Self::NAME
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_vision_provider_metadata() {
        let provider = VisionStateProvider;
        assert_eq!(provider.name(), "VISION");
        assert!(!provider.description().is_empty());
        assert!(provider.dynamic());
    }

    #[test]
    fn test_entity_tracking_provider_metadata() {
        let provider = EntityTrackingProvider;
        assert_eq!(provider.name(), "ENTITY_TRACKING");
        assert!(provider.dynamic());
    }

    #[test]
    fn test_camera_info_provider_metadata() {
        let provider = CameraInfoProvider;
        assert_eq!(provider.name(), "CAMERA_INFO");
        assert!(!provider.dynamic());
    }

    #[tokio::test]
    async fn test_vision_provider_no_service() {
        let provider = VisionStateProvider;
        let context = ProviderContext::default();
        let result = provider.get(&context).await;
        assert!(result.text.contains("not available"));
    }

    #[tokio::test]
    async fn test_vision_provider_inactive() {
        let provider = VisionStateProvider;
        let context = ProviderContext {
            vision_available: true,
            vision_active: false,
            vision_mode: VisionMode::Off,
            ..Default::default()
        };
        let result = provider.get(&context).await;
        assert!(result.text.contains("OFF"));
    }

    #[tokio::test]
    async fn test_vision_provider_active() {
        let provider = VisionStateProvider;
        let context = ProviderContext {
            vision_available: true,
            vision_active: true,
            vision_mode: VisionMode::Camera,
            scene: Some(SceneDescription {
                timestamp: 0,
                description: "Test scene".to_string(),
                objects: vec![],
                people: vec![],
                scene_changed: false,
                change_percentage: 0.0,
                audio_transcription: None,
            }),
            ..Default::default()
        };
        let result = provider.get(&context).await;
        assert!(result.text.contains("active"));
        assert!(result.text.contains("CAMERA"));
    }

    #[tokio::test]
    async fn test_entity_tracking_provider_no_entities() {
        let provider = EntityTrackingProvider;
        let context = ProviderContext {
            vision_available: true,
            vision_active: true,
            tracking_stats: Some(TrackingStatistics {
                active_entities: 0,
                people: 0,
                objects: 0,
                named_entities: 0,
                recently_left: 0,
            }),
            ..Default::default()
        };
        let result = provider.get(&context).await;
        assert!(result.text.contains("No entities"));
    }

    #[tokio::test]
    async fn test_entity_tracking_provider_with_entities() {
        let provider = EntityTrackingProvider;
        let context = ProviderContext {
            vision_available: true,
            vision_active: true,
            tracking_stats: Some(TrackingStatistics {
                active_entities: 5,
                people: 2,
                objects: 3,
                named_entities: 1,
                recently_left: 0,
            }),
            ..Default::default()
        };
        let result = provider.get(&context).await;
        assert!(result.text.contains("5 entities"));
        assert!(result.text.contains("2 people"));
        assert!(result.text.contains("3 objects"));
    }
}
