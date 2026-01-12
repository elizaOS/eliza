//! Vision plugin for elizaOS
//!
//! Provides camera integration and visual awareness capabilities,
//! including scene analysis, entity tracking, and OCR.
//!
//! # Features
//!
//! - Scene description and analysis
//! - Entity tracking (people, objects, pets)
//! - OCR text extraction (with `ocr` feature)
//! - OpenCV integration (with `opencv` feature)
//! - Screen capture support
//!
//! # Example
//!
//! ```rust,no_run
//! use elizaos_vision::{VisionService, VisionConfig, VisionMode};
//!
//! # async fn example() -> anyhow::Result<()> {
//! let config = VisionConfig {
//!     vision_mode: VisionMode::Camera,
//!     enable_ocr: true,
//!     ..Default::default()
//! };
//!
//! let service = VisionService::with_config(config);
//! service.start().await?;
//!
//! // Get scene description
//! if let Some(scene) = service.get_scene_description().await {
//!     println!("Scene: {}", scene.description);
//! }
//! # Ok(())
//! # }
//! ```

#![warn(missing_docs)]
#![deny(unsafe_code)]

/// Error types
pub mod error;

/// Plugin module
pub mod plugin;

/// Types module
pub mod types;

/// Actions module
pub mod actions;

/// Providers module
pub mod providers;

/// Service module
pub mod service;

// Re-exports for convenience
pub use error::{Result, VisionError};
pub use plugin::VisionPlugin;
pub use service::VisionService;
pub use types::*;

// Re-export action types
pub use actions::{
    ActionContext, CaptureImageAction, DescribeSceneAction, IdentifyPersonAction,
    KillAutonomousAction, NameEntityAction, SetVisionModeAction, TrackEntityAction, VisionAction,
};

// Re-export provider types
pub use providers::{
    CameraInfoProvider, EntityTrackingProvider, ProviderContext, VisionPerceptionProvider,
    VisionProvider, VisionStateProvider,
};

/// Plugin metadata
pub const PLUGIN_NAME: &str = "vision";
/// Plugin description
pub const PLUGIN_DESCRIPTION: &str =
    "Provides visual perception through camera integration and scene analysis";
/// Plugin version
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Create the vision plugin with default configuration
pub fn create_plugin() -> VisionPlugin {
    VisionPlugin::new()
}

/// Create the vision plugin with custom configuration
pub fn create_plugin_with_config(config: VisionConfig) -> VisionPlugin {
    VisionPlugin::with_config(config)
}
