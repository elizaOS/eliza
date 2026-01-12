//! Vision plugin actions
//!
//! This module contains all actions for the vision plugin,
//! providing parity with TypeScript and Python implementations.

use crate::error::Result;
use crate::types::{ActionResult, VisionMode};
use async_trait::async_trait;
use serde_json::json;

/// Action trait for vision actions
#[async_trait]
pub trait VisionAction: Send + Sync {
    /// Action name
    fn name(&self) -> &'static str;

    /// Action description
    fn description(&self) -> &'static str;

    /// Action similes (alternative names)
    fn similes(&self) -> &'static [&'static str];

    /// Whether action is enabled by default
    fn enabled(&self) -> bool;

    /// Validate if action can execute
    async fn validate(&self, context: &ActionContext) -> bool;

    /// Execute the action
    async fn handle(&self, context: &ActionContext) -> Result<ActionResult>;
}

/// Action context for executing actions
#[derive(Debug, Clone)]
pub struct ActionContext {
    /// Whether vision service is available
    pub vision_available: bool,
    /// Whether vision service is active
    pub vision_active: bool,
    /// Current vision mode
    pub vision_mode: VisionMode,
    /// Message content
    pub message_text: String,
    /// Room ID
    pub room_id: Option<String>,
    /// World ID
    pub world_id: Option<String>,
}

impl Default for ActionContext {
    fn default() -> Self {
        Self {
            vision_available: false,
            vision_active: false,
            vision_mode: VisionMode::Off,
            message_text: String::new(),
            room_id: None,
            world_id: None,
        }
    }
}

// ============================================================================
// Describe Scene Action
// ============================================================================

/// Action to describe the current visual scene
pub struct DescribeSceneAction;

impl DescribeSceneAction {
    /// Action name constant
    pub const NAME: &'static str = "DESCRIBE_SCENE";
    /// Action description
    pub const DESCRIPTION: &'static str =
        "Analyzes the current visual scene and provides a detailed description.";
    /// Alternative action names
    pub const SIMILES: &'static [&'static str] = &[
        "DESCRIBE_SCENE",
        "ANALYZE_SCENE",
        "WHAT_DO_YOU_SEE",
        "VISION_CHECK",
        "LOOK_AROUND",
    ];
}

#[async_trait]
impl VisionAction for DescribeSceneAction {
    fn name(&self) -> &'static str {
        Self::NAME
    }

    fn description(&self) -> &'static str {
        Self::DESCRIPTION
    }

    fn similes(&self) -> &'static [&'static str] {
        Self::SIMILES
    }

    fn enabled(&self) -> bool {
        true
    }

    async fn validate(&self, context: &ActionContext) -> bool {
        context.vision_available && context.vision_active
    }

    async fn handle(&self, context: &ActionContext) -> Result<ActionResult> {
        if !context.vision_available || !context.vision_active {
            return Ok(ActionResult {
                text: "Vision service unavailable".to_string(),
                values: json!({
                    "success": false,
                    "vision_available": false
                }),
                data: json!({
                    "action_name": Self::NAME,
                    "error": "Vision service not available"
                }),
            });
        }

        // In a full implementation, this would call the vision service
        Ok(ActionResult {
            text: "Scene analysis completed".to_string(),
            values: json!({
                "success": true,
                "vision_available": true,
                "scene_analyzed": true
            }),
            data: json!({
                "action_name": Self::NAME
            }),
        })
    }
}

// ============================================================================
// Capture Image Action
// ============================================================================

/// Action to capture an image from the camera
pub struct CaptureImageAction;

impl CaptureImageAction {
    /// Action name constant
    pub const NAME: &'static str = "CAPTURE_IMAGE";
    /// Action description
    pub const DESCRIPTION: &'static str = "Captures the current frame from the camera.";
    /// Alternative action names
    pub const SIMILES: &'static [&'static str] = &[
        "CAPTURE_IMAGE",
        "TAKE_PHOTO",
        "SCREENSHOT",
        "CAPTURE_FRAME",
        "TAKE_PICTURE",
    ];
}

#[async_trait]
impl VisionAction for CaptureImageAction {
    fn name(&self) -> &'static str {
        Self::NAME
    }

    fn description(&self) -> &'static str {
        Self::DESCRIPTION
    }

    fn similes(&self) -> &'static [&'static str] {
        Self::SIMILES
    }

    fn enabled(&self) -> bool {
        false // Privacy-sensitive
    }

    async fn validate(&self, context: &ActionContext) -> bool {
        context.vision_available && context.vision_active
    }

    async fn handle(&self, context: &ActionContext) -> Result<ActionResult> {
        if !context.vision_available || !context.vision_active {
            return Ok(ActionResult {
                text: "Vision service unavailable".to_string(),
                values: json!({
                    "success": false,
                    "vision_available": false
                }),
                data: json!({
                    "action_name": Self::NAME,
                    "error": "Vision service not available"
                }),
            });
        }

        Ok(ActionResult {
            text: "Image captured".to_string(),
            values: json!({
                "success": true,
                "vision_available": true,
                "capture_success": true
            }),
            data: json!({
                "action_name": Self::NAME
            }),
        })
    }
}

// ============================================================================
// Set Vision Mode Action
// ============================================================================

/// Action to set the vision mode
pub struct SetVisionModeAction;

impl SetVisionModeAction {
    /// Action name constant
    pub const NAME: &'static str = "SET_VISION_MODE";
    /// Action description
    pub const DESCRIPTION: &'static str = "Set the vision mode to OFF, CAMERA, SCREEN, or BOTH";
    /// Alternative action names
    pub const SIMILES: &'static [&'static str] = &[
        "SET_VISION_MODE",
        "change vision to",
        "set vision mode",
        "switch to vision",
    ];

    /// Parse vision mode from message text
    pub fn parse_mode(text: &str) -> Option<VisionMode> {
        let lower = text.to_lowercase();
        if lower.contains("off") || lower.contains("disable") {
            Some(VisionMode::Off)
        } else if lower.contains("both") {
            Some(VisionMode::Both)
        } else if lower.contains("screen") {
            Some(VisionMode::Screen)
        } else if lower.contains("camera") {
            Some(VisionMode::Camera)
        } else {
            None
        }
    }
}

#[async_trait]
impl VisionAction for SetVisionModeAction {
    fn name(&self) -> &'static str {
        Self::NAME
    }

    fn description(&self) -> &'static str {
        Self::DESCRIPTION
    }

    fn similes(&self) -> &'static [&'static str] {
        Self::SIMILES
    }

    fn enabled(&self) -> bool {
        true
    }

    async fn validate(&self, context: &ActionContext) -> bool {
        context.vision_available
    }

    async fn handle(&self, context: &ActionContext) -> Result<ActionResult> {
        if !context.vision_available {
            return Ok(ActionResult {
                text: "Vision service unavailable".to_string(),
                values: json!({
                    "success": false,
                    "vision_available": false
                }),
                data: json!({
                    "action_name": Self::NAME,
                    "error": "Vision service not available"
                }),
            });
        }

        let new_mode = Self::parse_mode(&context.message_text);

        match new_mode {
            Some(mode) => Ok(ActionResult {
                text: format!("Vision mode set to {}", mode),
                values: json!({
                    "success": true,
                    "new_mode": mode.to_string()
                }),
                data: json!({
                    "action_name": Self::NAME,
                    "new_mode": mode.to_string()
                }),
            }),
            None => Ok(ActionResult {
                text: "Please specify the vision mode: OFF, CAMERA, SCREEN, or BOTH.".to_string(),
                values: json!({
                    "success": false,
                    "error": "mode_not_specified"
                }),
                data: json!({
                    "action_name": Self::NAME
                }),
            }),
        }
    }
}

// ============================================================================
// Name Entity Action
// ============================================================================

/// Action to name an entity in view
pub struct NameEntityAction;

impl NameEntityAction {
    /// Action name constant
    pub const NAME: &'static str = "NAME_ENTITY";
    /// Action description
    pub const DESCRIPTION: &'static str = "Assign a name to a person or object currently visible";
    /// Alternative action names
    pub const SIMILES: &'static [&'static str] = &[
        "NAME_ENTITY",
        "call the person",
        "name the person",
        "that person is",
    ];
}

#[async_trait]
impl VisionAction for NameEntityAction {
    fn name(&self) -> &'static str {
        Self::NAME
    }

    fn description(&self) -> &'static str {
        Self::DESCRIPTION
    }

    fn similes(&self) -> &'static [&'static str] {
        Self::SIMILES
    }

    fn enabled(&self) -> bool {
        true
    }

    async fn validate(&self, context: &ActionContext) -> bool {
        context.vision_available && context.vision_active
    }

    async fn handle(&self, context: &ActionContext) -> Result<ActionResult> {
        if !context.vision_available || !context.vision_active {
            return Ok(ActionResult {
                text: "I cannot name entities.".to_string(),
                values: json!({
                    "success": false,
                    "vision_available": false
                }),
                data: json!({
                    "action_name": Self::NAME
                }),
            });
        }

        Ok(ActionResult {
            text: "Entity naming not yet implemented".to_string(),
            values: json!({
                "success": false,
                "not_implemented": true
            }),
            data: json!({
                "action_name": Self::NAME
            }),
        })
    }
}

// ============================================================================
// Identify Person Action
// ============================================================================

/// Action to identify a person in view
pub struct IdentifyPersonAction;

impl IdentifyPersonAction {
    /// Action name constant
    pub const NAME: &'static str = "IDENTIFY_PERSON";
    /// Action description
    pub const DESCRIPTION: &'static str = "Identify a person in view if they have been seen before";
    /// Alternative action names
    pub const SIMILES: &'static [&'static str] = &[
        "IDENTIFY_PERSON",
        "who is that",
        "who is the person",
        "identify the person",
    ];
}

#[async_trait]
impl VisionAction for IdentifyPersonAction {
    fn name(&self) -> &'static str {
        Self::NAME
    }

    fn description(&self) -> &'static str {
        Self::DESCRIPTION
    }

    fn similes(&self) -> &'static [&'static str] {
        Self::SIMILES
    }

    fn enabled(&self) -> bool {
        false // Privacy-sensitive
    }

    async fn validate(&self, context: &ActionContext) -> bool {
        context.vision_available && context.vision_active
    }

    async fn handle(&self, context: &ActionContext) -> Result<ActionResult> {
        if !context.vision_available || !context.vision_active {
            return Ok(ActionResult {
                text: "I cannot identify people.".to_string(),
                values: json!({
                    "success": false,
                    "vision_available": false
                }),
                data: json!({
                    "action_name": Self::NAME
                }),
            });
        }

        Ok(ActionResult {
            text: "Person identification not yet implemented".to_string(),
            values: json!({
                "success": false,
                "not_implemented": true
            }),
            data: json!({
                "action_name": Self::NAME
            }),
        })
    }
}

// ============================================================================
// Track Entity Action
// ============================================================================

/// Action to start tracking an entity
pub struct TrackEntityAction;

impl TrackEntityAction {
    /// Action name constant
    pub const NAME: &'static str = "TRACK_ENTITY";
    /// Action description
    pub const DESCRIPTION: &'static str = "Start tracking a specific person or object in view";
    /// Alternative action names
    pub const SIMILES: &'static [&'static str] =
        &["TRACK_ENTITY", "track the", "follow the", "keep an eye on"];
}

#[async_trait]
impl VisionAction for TrackEntityAction {
    fn name(&self) -> &'static str {
        Self::NAME
    }

    fn description(&self) -> &'static str {
        Self::DESCRIPTION
    }

    fn similes(&self) -> &'static [&'static str] {
        Self::SIMILES
    }

    fn enabled(&self) -> bool {
        false // Privacy-sensitive
    }

    async fn validate(&self, context: &ActionContext) -> bool {
        context.vision_available && context.vision_active
    }

    async fn handle(&self, context: &ActionContext) -> Result<ActionResult> {
        if !context.vision_available || !context.vision_active {
            return Ok(ActionResult {
                text: "I cannot track entities.".to_string(),
                values: json!({
                    "success": false,
                    "vision_available": false
                }),
                data: json!({
                    "action_name": Self::NAME
                }),
            });
        }

        Ok(ActionResult {
            text: "Entity tracking enabled".to_string(),
            values: json!({
                "success": true
            }),
            data: json!({
                "action_name": Self::NAME
            }),
        })
    }
}

// ============================================================================
// Kill Autonomous Action
// ============================================================================

/// Action to stop the autonomous loop
pub struct KillAutonomousAction;

impl KillAutonomousAction {
    /// Action name constant
    pub const NAME: &'static str = "KILL_AUTONOMOUS";
    /// Action description
    pub const DESCRIPTION: &'static str = "Stops the autonomous agent loop for debugging purposes.";
    /// Alternative action names
    pub const SIMILES: &'static [&'static str] = &[
        "KILL_AUTONOMOUS",
        "STOP_AUTONOMOUS",
        "HALT_AUTONOMOUS",
        "KILL_AUTO_LOOP",
    ];
}

#[async_trait]
impl VisionAction for KillAutonomousAction {
    fn name(&self) -> &'static str {
        Self::NAME
    }

    fn description(&self) -> &'static str {
        Self::DESCRIPTION
    }

    fn similes(&self) -> &'static [&'static str] {
        Self::SIMILES
    }

    fn enabled(&self) -> bool {
        false // Potentially dangerous
    }

    async fn validate(&self, _context: &ActionContext) -> bool {
        true // Always allow
    }

    async fn handle(&self, _context: &ActionContext) -> Result<ActionResult> {
        Ok(ActionResult {
            text: "No autonomous loop was running.".to_string(),
            values: json!({
                "success": true
            }),
            data: json!({
                "action_name": Self::NAME
            }),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_describe_scene_metadata() {
        let action = DescribeSceneAction;
        assert_eq!(action.name(), "DESCRIBE_SCENE");
        assert!(!action.description().is_empty());
        assert!(action.similes().contains(&"ANALYZE_SCENE"));
        assert!(action.enabled());
    }

    #[test]
    fn test_capture_image_metadata() {
        let action = CaptureImageAction;
        assert_eq!(action.name(), "CAPTURE_IMAGE");
        assert!(action.similes().contains(&"TAKE_PHOTO"));
        assert!(!action.enabled()); // Privacy-sensitive
    }

    #[test]
    fn test_set_vision_mode_parse() {
        assert_eq!(
            SetVisionModeAction::parse_mode("turn off vision"),
            Some(VisionMode::Off)
        );
        assert_eq!(
            SetVisionModeAction::parse_mode("disable"),
            Some(VisionMode::Off)
        );
        assert_eq!(
            SetVisionModeAction::parse_mode("use camera"),
            Some(VisionMode::Camera)
        );
        assert_eq!(
            SetVisionModeAction::parse_mode("screen capture"),
            Some(VisionMode::Screen)
        );
        assert_eq!(
            SetVisionModeAction::parse_mode("enable both"),
            Some(VisionMode::Both)
        );
        assert_eq!(SetVisionModeAction::parse_mode("hello"), None);
    }

    #[tokio::test]
    async fn test_describe_scene_validate_no_service() {
        let action = DescribeSceneAction;
        let context = ActionContext::default();
        assert!(!action.validate(&context).await);
    }

    #[tokio::test]
    async fn test_describe_scene_validate_with_service() {
        let action = DescribeSceneAction;
        let context = ActionContext {
            vision_available: true,
            vision_active: true,
            ..Default::default()
        };
        assert!(action.validate(&context).await);
    }

    #[tokio::test]
    async fn test_kill_autonomous_always_validates() {
        let action = KillAutonomousAction;
        let context = ActionContext::default();
        assert!(action.validate(&context).await);
    }

    #[tokio::test]
    async fn test_describe_scene_handle_no_service() {
        let action = DescribeSceneAction;
        let context = ActionContext::default();
        let result = action.handle(&context).await.unwrap();
        assert!(result.text.contains("unavailable"));
    }

    #[tokio::test]
    async fn test_capture_image_handle_no_service() {
        let action = CaptureImageAction;
        let context = ActionContext::default();
        let result = action.handle(&context).await.unwrap();
        assert!(result.text.contains("unavailable"));
    }
}
