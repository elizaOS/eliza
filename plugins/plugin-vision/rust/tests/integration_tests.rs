//! Integration tests for vision plugin.

use elizaos_vision::{
    ActionContext, BoundingBox, CaptureImageAction, DescribeSceneAction, EntityTrackingProvider,
    IdentifyPersonAction, KillAutonomousAction, NameEntityAction, Point2D, ProviderContext,
    SceneDescription, SetVisionModeAction, TrackEntityAction, TrackingStatistics, VisionAction,
    VisionConfig, VisionMode, VisionPlugin, VisionProvider, VisionService, VisionStateProvider,
};

// ============================================================================
// Type Tests
// ============================================================================

#[test]
fn test_vision_config_default() {
    let config = VisionConfig::default();
    assert!(!config.enable_ocr);
    assert!(!config.enable_opencv);
    assert_eq!(config.vision_mode, VisionMode::Camera);
}

#[test]
fn test_vision_config_serialization() {
    let config = VisionConfig {
        enable_ocr: true,
        enable_opencv: true,
        vision_mode: VisionMode::Both,
        ..Default::default()
    };

    let json = serde_json::to_string(&config).unwrap();
    assert!(json.contains("enable_ocr"));
    assert!(json.contains("true"));

    let parsed: VisionConfig = serde_json::from_str(&json).unwrap();
    assert!(parsed.enable_ocr);
    assert!(parsed.enable_opencv);
    assert_eq!(parsed.vision_mode, VisionMode::Both);
}

#[test]
fn test_vision_config_deserialization() {
    let json = r#"{"enable_ocr": false, "enable_opencv": true}"#;
    let config: VisionConfig = serde_json::from_str(json).unwrap();
    assert!(!config.enable_ocr);
    assert!(config.enable_opencv);
}

#[test]
fn test_vision_mode_values() {
    assert_eq!(VisionMode::Off.to_string(), "OFF");
    assert_eq!(VisionMode::Camera.to_string(), "CAMERA");
    assert_eq!(VisionMode::Screen.to_string(), "SCREEN");
    assert_eq!(VisionMode::Both.to_string(), "BOTH");
}

#[test]
fn test_bounding_box_center() {
    let bbox = BoundingBox::new(100.0, 100.0, 200.0, 300.0);
    let center = bbox.center();
    assert!((center.x - 200.0).abs() < f64::EPSILON);
    assert!((center.y - 250.0).abs() < f64::EPSILON);
}

#[test]
fn test_bounding_box_area() {
    let bbox = BoundingBox::new(0.0, 0.0, 200.0, 300.0);
    assert!((bbox.area() - 60000.0).abs() < f64::EPSILON);
}

#[test]
fn test_bounding_box_aspect_ratio() {
    let bbox = BoundingBox::new(0.0, 0.0, 400.0, 200.0);
    assert!((bbox.aspect_ratio() - 2.0).abs() < f64::EPSILON);

    let zero_height = BoundingBox::new(0.0, 0.0, 100.0, 0.0);
    assert!((zero_height.aspect_ratio() - 0.0).abs() < f64::EPSILON);
}

#[test]
fn test_point2d_creation() {
    let point = Point2D::new(10.5, 20.5);
    assert!((point.x - 10.5).abs() < f64::EPSILON);
    assert!((point.y - 20.5).abs() < f64::EPSILON);
}

// ============================================================================
// Service Tests
// ============================================================================

#[tokio::test]
async fn test_service_creation() {
    let service = VisionService::new();
    assert!(!service.is_active());
    assert_eq!(service.get_mode(), VisionMode::Camera);
}

#[tokio::test]
async fn test_service_start_stop() {
    let service = VisionService::new();

    service.start().await.unwrap();
    assert!(service.is_active());

    service.stop().await.unwrap();
    assert!(!service.is_active());
}

#[tokio::test]
async fn test_service_with_config() {
    let config = VisionConfig {
        vision_mode: VisionMode::Screen,
        enable_ocr: true,
        ..Default::default()
    };
    let service = VisionService::with_config(config);
    assert_eq!(service.get_mode(), VisionMode::Screen);
    assert!(service.config().enable_ocr);
}

#[tokio::test]
async fn test_service_scene_description() {
    let service = VisionService::new();
    service.start().await.unwrap();

    assert!(service.get_scene_description().await.is_none());

    let scene = SceneDescription {
        timestamp: 1000,
        description: "Test scene".to_string(),
        objects: vec![],
        people: vec![],
        scene_changed: false,
        change_percentage: 0.0,
        audio_transcription: None,
    };

    service.update_scene(scene);

    let retrieved = service.get_scene_description().await.unwrap();
    assert_eq!(retrieved.description, "Test scene");
}

#[tokio::test]
async fn test_service_camera_info_on_start() {
    let service = VisionService::new();

    // Camera info is None before start
    assert!(service.get_camera_info().is_none());

    // Start the service - this initializes camera info
    service.start().await.unwrap();

    // Camera info should now be available
    let info = service.get_camera_info().unwrap();
    assert!(info.connected);

    // Stop the service
    service.stop().await.unwrap();

    // Camera info should be None again
    assert!(service.get_camera_info().is_none());
}

// ============================================================================
// Plugin Tests
// ============================================================================

#[test]
fn test_plugin_creation() {
    let plugin = VisionPlugin::new();
    assert!(plugin.service().is_none());
}

#[test]
fn test_plugin_metadata() {
    let metadata = VisionPlugin::metadata();
    assert_eq!(metadata.name, "vision");
    assert!(!metadata.description.is_empty());
    assert_eq!(metadata.actions.len(), 7);
    assert_eq!(metadata.providers.len(), 3);
}

#[test]
fn test_plugin_actions_list() {
    let actions = VisionPlugin::actions();
    assert!(actions.contains(&"DESCRIBE_SCENE"));
    assert!(actions.contains(&"CAPTURE_IMAGE"));
    assert!(actions.contains(&"SET_VISION_MODE"));
    assert!(actions.contains(&"NAME_ENTITY"));
    assert!(actions.contains(&"IDENTIFY_PERSON"));
    assert!(actions.contains(&"TRACK_ENTITY"));
    assert!(actions.contains(&"KILL_AUTONOMOUS"));
}

#[test]
fn test_plugin_providers_list() {
    let providers = VisionPlugin::providers();
    assert!(providers.contains(&"VISION"));
    assert!(providers.contains(&"ENTITY_TRACKING"));
    assert!(providers.contains(&"CAMERA_INFO"));
}

#[tokio::test]
async fn test_plugin_init() {
    let mut plugin = VisionPlugin::new();
    plugin.init().await.unwrap();
    assert!(plugin.service().is_some());
}

// ============================================================================
// Action Tests
// ============================================================================

#[test]
fn test_describe_scene_action_metadata() {
    let action = DescribeSceneAction;
    assert_eq!(action.name(), "DESCRIBE_SCENE");
    assert!(!action.description().is_empty());
    assert!(action.similes().contains(&"ANALYZE_SCENE"));
    assert!(action.enabled());
}

#[test]
fn test_capture_image_action_metadata() {
    let action = CaptureImageAction;
    assert_eq!(action.name(), "CAPTURE_IMAGE");
    assert!(action.similes().contains(&"TAKE_PHOTO"));
    assert!(!action.enabled()); // Privacy-sensitive
}

#[test]
fn test_set_vision_mode_action_metadata() {
    let action = SetVisionModeAction;
    assert_eq!(action.name(), "SET_VISION_MODE");
    assert!(action.enabled());
}

#[test]
fn test_set_vision_mode_parse() {
    assert_eq!(
        SetVisionModeAction::parse_mode("turn off vision"),
        Some(VisionMode::Off)
    );
    assert_eq!(
        SetVisionModeAction::parse_mode("disable vision"),
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
    assert_eq!(SetVisionModeAction::parse_mode("hello world"), None);
}

#[test]
fn test_name_entity_action_metadata() {
    let action = NameEntityAction;
    assert_eq!(action.name(), "NAME_ENTITY");
    assert!(action.enabled());
}

#[test]
fn test_identify_person_action_metadata() {
    let action = IdentifyPersonAction;
    assert_eq!(action.name(), "IDENTIFY_PERSON");
    assert!(!action.enabled()); // Privacy-sensitive
}

#[test]
fn test_track_entity_action_metadata() {
    let action = TrackEntityAction;
    assert_eq!(action.name(), "TRACK_ENTITY");
    assert!(!action.enabled()); // Privacy-sensitive
}

#[test]
fn test_kill_autonomous_action_metadata() {
    let action = KillAutonomousAction;
    assert_eq!(action.name(), "KILL_AUTONOMOUS");
    assert!(!action.enabled()); // Potentially dangerous
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

// ============================================================================
// Provider Tests
// ============================================================================

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

#[tokio::test]
async fn test_vision_provider_no_service() {
    let provider = VisionStateProvider;
    let context = ProviderContext::default();
    let result = provider.get(&context).await;
    assert!(result.text.contains("not available"));
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
async fn test_entity_tracking_provider_with_stats() {
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
