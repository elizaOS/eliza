//! Vision plugin implementation

use crate::actions::{
    CaptureImageAction, DescribeSceneAction, IdentifyPersonAction, KillAutonomousAction,
    NameEntityAction, SetVisionModeAction, TrackEntityAction,
};
use crate::providers::{CameraInfoProvider, EntityTrackingProvider, VisionStateProvider};
use crate::service::VisionService;
use crate::types::VisionConfig;
use std::sync::Arc;

/// Vision plugin
pub struct VisionPlugin {
    /// Plugin configuration
    config: VisionConfig,
    /// Vision service
    service: Option<Arc<VisionService>>,
}

impl VisionPlugin {
    /// Plugin name constant
    pub const NAME: &'static str = "vision";
    /// Plugin description
    pub const DESCRIPTION: &'static str =
        "Provides visual perception through camera integration and scene analysis";

    /// Create a new vision plugin with default configuration
    pub fn new() -> Self {
        Self::with_config(VisionConfig::default())
    }

    /// Create a new vision plugin with custom configuration
    pub fn with_config(config: VisionConfig) -> Self {
        Self {
            config,
            service: None,
        }
    }

    /// Get the plugin configuration
    pub fn config(&self) -> &VisionConfig {
        &self.config
    }

    /// Get the vision service
    pub fn service(&self) -> Option<Arc<VisionService>> {
        self.service.clone()
    }

    /// Initialize the plugin
    pub async fn init(&mut self) -> crate::Result<()> {
        let service = VisionService::with_config(self.config.clone());
        self.service = Some(Arc::new(service));
        tracing::info!("Vision plugin initialized");
        Ok(())
    }

    /// Start the plugin
    pub async fn start(&self) -> crate::Result<()> {
        if let Some(ref service) = self.service {
            service.start().await?;
        }
        Ok(())
    }

    /// Stop the plugin
    pub async fn stop(&self) -> crate::Result<()> {
        if let Some(ref service) = self.service {
            service.stop().await?;
        }
        Ok(())
    }

    /// Get all available actions
    pub fn actions() -> Vec<&'static str> {
        vec![
            DescribeSceneAction::NAME,
            CaptureImageAction::NAME,
            SetVisionModeAction::NAME,
            NameEntityAction::NAME,
            IdentifyPersonAction::NAME,
            TrackEntityAction::NAME,
            KillAutonomousAction::NAME,
        ]
    }

    /// Get all available providers
    pub fn providers() -> Vec<&'static str> {
        vec![
            VisionStateProvider::NAME,
            EntityTrackingProvider::NAME,
            CameraInfoProvider::NAME,
        ]
    }

    /// Get plugin metadata
    pub fn metadata() -> PluginMetadata {
        PluginMetadata {
            name: Self::NAME.to_string(),
            description: Self::DESCRIPTION.to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            actions: Self::actions().iter().map(|s| s.to_string()).collect(),
            providers: Self::providers().iter().map(|s| s.to_string()).collect(),
        }
    }
}

impl Default for VisionPlugin {
    fn default() -> Self {
        Self::new()
    }
}

/// Plugin metadata
#[derive(Debug, Clone)]
pub struct PluginMetadata {
    /// Plugin name
    pub name: String,
    /// Plugin description
    pub description: String,
    /// Plugin version
    pub version: String,
    /// Available actions
    pub actions: Vec<String>,
    /// Available providers
    pub providers: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_plugin_creation() {
        let plugin = VisionPlugin::new();
        assert!(plugin.service().is_none());
    }

    #[test]
    fn test_plugin_with_config() {
        let config = VisionConfig {
            enable_ocr: true,
            ..Default::default()
        };
        let plugin = VisionPlugin::with_config(config);
        assert!(plugin.config().enable_ocr);
    }

    #[test]
    fn test_plugin_actions() {
        let actions = VisionPlugin::actions();
        assert!(actions.contains(&"DESCRIBE_SCENE"));
        assert!(actions.contains(&"CAPTURE_IMAGE"));
        assert!(actions.contains(&"SET_VISION_MODE"));
        assert!(actions.contains(&"NAME_ENTITY"));
        assert!(actions.contains(&"IDENTIFY_PERSON"));
        assert!(actions.contains(&"TRACK_ENTITY"));
        assert!(actions.contains(&"KILL_AUTONOMOUS"));
        assert_eq!(actions.len(), 7);
    }

    #[test]
    fn test_plugin_providers() {
        let providers = VisionPlugin::providers();
        assert!(providers.contains(&"VISION"));
        assert!(providers.contains(&"ENTITY_TRACKING"));
        assert!(providers.contains(&"CAMERA_INFO"));
        assert_eq!(providers.len(), 3);
    }

    #[test]
    fn test_plugin_metadata() {
        let metadata = VisionPlugin::metadata();
        assert_eq!(metadata.name, "vision");
        assert!(!metadata.description.is_empty());
        assert!(!metadata.version.is_empty());
        assert_eq!(metadata.actions.len(), 7);
        assert_eq!(metadata.providers.len(), 3);
    }

    #[tokio::test]
    async fn test_plugin_init() {
        let mut plugin = VisionPlugin::new();
        plugin.init().await.unwrap();
        assert!(plugin.service().is_some());
    }

    #[tokio::test]
    async fn test_plugin_start_stop() {
        let mut plugin = VisionPlugin::new();
        plugin.init().await.unwrap();
        plugin.start().await.unwrap();
        plugin.stop().await.unwrap();
    }
}
