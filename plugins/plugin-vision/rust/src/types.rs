//! Types for the vision plugin
//!
//! This module contains all type definitions for vision processing,
//! including scene descriptions, entity tracking, and configuration.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Vision processing modes
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "UPPERCASE")]
pub enum VisionMode {
    /// Vision disabled
    Off,
    /// Camera only
    #[default]
    Camera,
    /// Screen capture only
    Screen,
    /// Both camera and screen
    Both,
}

impl std::fmt::Display for VisionMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VisionMode::Off => write!(f, "OFF"),
            VisionMode::Camera => write!(f, "CAMERA"),
            VisionMode::Screen => write!(f, "SCREEN"),
            VisionMode::Both => write!(f, "BOTH"),
        }
    }
}

/// Point in 2D space
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Point2D {
    /// X coordinate
    pub x: f64,
    /// Y coordinate
    pub y: f64,
}

impl Point2D {
    /// Create a new 2D point
    pub fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }
}

/// Bounding box for detected objects
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct BoundingBox {
    /// X coordinate (left edge)
    pub x: f64,
    /// Y coordinate (top edge)
    pub y: f64,
    /// Width
    pub width: f64,
    /// Height
    pub height: f64,
}

impl BoundingBox {
    /// Create a new bounding box
    pub fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    /// Get the center point of the bounding box
    pub fn center(&self) -> Point2D {
        Point2D::new(self.x + self.width / 2.0, self.y + self.height / 2.0)
    }

    /// Get the area of the bounding box
    pub fn area(&self) -> f64 {
        self.width * self.height
    }

    /// Get the aspect ratio (width/height)
    pub fn aspect_ratio(&self) -> f64 {
        if self.height > 0.0 {
            self.width / self.height
        } else {
            0.0
        }
    }
}

/// Camera device information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CameraInfo {
    /// Camera ID
    pub id: String,
    /// Camera name
    pub name: String,
    /// Whether camera is connected
    pub connected: bool,
}

/// Vision frame captured from camera
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VisionFrame {
    /// Timestamp in milliseconds
    pub timestamp: i64,
    /// Frame width
    pub width: u32,
    /// Frame height
    pub height: u32,
    /// Frame data
    #[serde(skip)]
    pub data: Vec<u8>,
    /// Frame format
    pub format: FrameFormat,
}

/// Frame format
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FrameFormat {
    /// RGB format
    Rgb,
    /// RGBA format
    Rgba,
    /// JPEG format
    Jpeg,
    /// PNG format
    Png,
}

/// Detected object in a scene
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectedObject {
    /// Object ID
    pub id: String,
    /// Object type (e.g., "laptop", "chair")
    #[serde(rename = "type")]
    pub object_type: String,
    /// Detection confidence (0.0 - 1.0)
    pub confidence: f64,
    /// Bounding box
    pub bounding_box: BoundingBox,
}

/// Keypoint for pose detection
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Keypoint {
    /// Body part name
    pub part: String,
    /// Position
    pub position: Point2D,
    /// Detection score
    pub score: f64,
}

/// Pose of a detected person
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Pose {
    /// Person is sitting
    Sitting,
    /// Person is standing
    Standing,
    /// Person is lying down
    Lying,
    /// Unknown pose
    Unknown,
}

/// Direction person is facing
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FacingDirection {
    /// Facing the camera
    Camera,
    /// Facing away
    Away,
    /// Facing left
    Left,
    /// Facing right
    Right,
    /// Unknown direction
    Unknown,
}

/// Detected person information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersonInfo {
    /// Person ID
    pub id: String,
    /// Detected pose
    pub pose: Pose,
    /// Direction person is facing
    pub facing: FacingDirection,
    /// Detection confidence
    pub confidence: f64,
    /// Bounding box
    pub bounding_box: BoundingBox,
    /// Detected keypoints
    #[serde(default)]
    pub keypoints: Vec<Keypoint>,
}

/// Scene description from vision analysis
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SceneDescription {
    /// Timestamp in milliseconds
    pub timestamp: i64,
    /// Human-readable scene description
    pub description: String,
    /// Detected objects
    pub objects: Vec<DetectedObject>,
    /// Detected people
    pub people: Vec<PersonInfo>,
    /// Whether scene has changed significantly
    pub scene_changed: bool,
    /// Percentage of change
    pub change_percentage: f64,
    /// Optional audio transcription
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_transcription: Option<String>,
}

/// OCR word
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrWord {
    /// Detected text
    pub text: String,
    /// Bounding box
    pub bbox: BoundingBox,
    /// Detection confidence
    pub confidence: f64,
}

/// OCR text block
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrBlock {
    /// Detected text
    pub text: String,
    /// Bounding box
    pub bbox: BoundingBox,
    /// Detection confidence
    pub confidence: f64,
    /// Individual words
    #[serde(default)]
    pub words: Vec<OcrWord>,
}

/// OCR result from text extraction
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrResult {
    /// Primary text
    pub text: String,
    /// Text blocks
    pub blocks: Vec<OcrBlock>,
    /// Full concatenated text
    pub full_text: String,
}

/// Screen tile for tiled processing
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenTile {
    /// Tile ID
    pub id: String,
    /// Row index
    pub row: u32,
    /// Column index
    pub col: u32,
    /// X position
    pub x: u32,
    /// Y position
    pub y: u32,
    /// Width
    pub width: u32,
    /// Height
    pub height: u32,
    /// Tile data
    #[serde(skip)]
    pub data: Option<Vec<u8>>,
}

/// Screen capture result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenCapture {
    /// Timestamp
    pub timestamp: i64,
    /// Screen width
    pub width: u32,
    /// Screen height
    pub height: u32,
    /// Screen data
    #[serde(skip)]
    pub data: Vec<u8>,
    /// Screen tiles
    pub tiles: Vec<ScreenTile>,
}

/// Entity appearance record
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EntityAppearance {
    /// Timestamp
    pub timestamp: i64,
    /// Bounding box
    pub bounding_box: BoundingBox,
    /// Confidence score
    pub confidence: f64,
    /// Optional embedding vector
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embedding: Option<Vec<f32>>,
    /// Detected keypoints
    #[serde(default)]
    pub keypoints: Vec<Keypoint>,
}

/// Entity size
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntitySize {
    /// Small entity
    Small,
    /// Medium entity
    Medium,
    /// Large entity
    Large,
}

/// Entity attributes
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EntityAttributes {
    /// Person name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Face embedding for recognition
    #[serde(skip_serializing_if = "Option::is_none")]
    pub face_embedding: Option<Vec<f32>>,
    /// Face ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub face_id: Option<String>,
    /// Clothing descriptions
    #[serde(default)]
    pub clothing: Vec<String>,
    /// Hair color
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hair_color: Option<String>,
    /// Accessories
    #[serde(default)]
    pub accessories: Vec<String>,
    /// Object type
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object_type: Option<String>,
    /// Color
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Size
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<EntitySize>,
    /// Description
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Tags
    #[serde(default)]
    pub tags: Vec<String>,
}

/// Entity type
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntityType {
    /// Person
    Person,
    /// Object
    Object,
    /// Pet
    Pet,
}

/// Tracked entity
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackedEntity {
    /// Entity ID
    pub id: String,
    /// Entity type
    pub entity_type: EntityType,
    /// First seen timestamp
    pub first_seen: i64,
    /// Last seen timestamp
    pub last_seen: i64,
    /// Last known position
    pub last_position: BoundingBox,
    /// Appearance history
    pub appearances: Vec<EntityAppearance>,
    /// Entity attributes
    pub attributes: EntityAttributes,
    /// World ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub world_id: Option<String>,
    /// Room ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub room_id: Option<String>,
}

/// Recently departed entity
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentlyLeftEntity {
    /// Entity ID
    pub entity_id: String,
    /// Departure timestamp
    pub left_at: i64,
    /// Last known position
    pub last_position: BoundingBox,
}

/// World state for entity tracking
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorldState {
    /// World ID
    pub world_id: String,
    /// All tracked entities
    pub entities: HashMap<String, TrackedEntity>,
    /// Last update timestamp
    pub last_update: i64,
    /// Active entity IDs
    pub active_entities: Vec<String>,
    /// Recently departed entities
    pub recently_left: Vec<RecentlyLeftEntity>,
}

/// Tile processing order
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TileProcessingOrder {
    /// Sequential processing
    Sequential,
    /// Priority-based processing
    #[default]
    Priority,
    /// Random processing
    Random,
}

/// Vision configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VisionConfig {
    /// Camera name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub camera_name: Option<String>,
    /// Pixel change threshold
    #[serde(default = "default_pixel_change_threshold")]
    pub pixel_change_threshold: f64,
    /// Update interval in milliseconds
    #[serde(default = "default_update_interval")]
    pub update_interval: u64,
    /// Enable pose detection
    #[serde(default)]
    pub enable_pose_detection: bool,
    /// Enable object detection
    #[serde(default)]
    pub enable_object_detection: bool,
    /// Enable face recognition
    #[serde(default)]
    pub enable_face_recognition: bool,
    /// TensorFlow update interval
    #[serde(default = "default_tf_update_interval")]
    pub tf_update_interval: u64,
    /// VLM update interval
    #[serde(default = "default_vlm_update_interval")]
    pub vlm_update_interval: u64,
    /// TensorFlow change threshold
    #[serde(default = "default_tf_change_threshold")]
    pub tf_change_threshold: f64,
    /// VLM change threshold
    #[serde(default = "default_vlm_change_threshold")]
    pub vlm_change_threshold: f64,
    /// Vision mode
    #[serde(default)]
    pub vision_mode: VisionMode,
    /// Screen capture interval
    #[serde(default = "default_screen_capture_interval")]
    pub screen_capture_interval: u64,
    /// Tile size
    #[serde(default = "default_tile_size")]
    pub tile_size: u32,
    /// Tile processing order
    #[serde(default)]
    pub tile_processing_order: TileProcessingOrder,
    /// OCR enabled
    #[serde(default = "default_true")]
    pub ocr_enabled: bool,
    /// Florence-2 enabled
    #[serde(default = "default_true")]
    pub florence2_enabled: bool,
    /// Display index
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_index: Option<u32>,
    /// Capture all displays
    #[serde(default)]
    pub capture_all_displays: bool,
    /// Target screen FPS
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_screen_fps: Option<u32>,
    /// Enable GPU acceleration
    #[serde(default = "default_true")]
    pub enable_gpu_acceleration: bool,
    /// Maximum memory usage in MB
    #[serde(default = "default_max_memory")]
    pub max_memory_usage_mb: u32,
    /// Entity timeout in milliseconds
    #[serde(default = "default_entity_timeout")]
    pub entity_timeout: u64,
    /// Maximum tracked entities
    #[serde(default = "default_max_entities")]
    pub max_tracked_entities: u32,
    /// Face match threshold
    #[serde(default = "default_face_match_threshold")]
    pub face_match_threshold: f64,
    /// Maximum face profiles
    #[serde(default = "default_max_face_profiles")]
    pub max_face_profiles: u32,
    /// Debug mode
    #[serde(default)]
    pub debug_mode: bool,
    /// Enable OCR (feature flag)
    #[serde(default)]
    pub enable_ocr: bool,
    /// Enable OpenCV (feature flag)
    #[serde(default)]
    pub enable_opencv: bool,
}

fn default_pixel_change_threshold() -> f64 {
    50.0
}
fn default_update_interval() -> u64 {
    100
}
fn default_tf_update_interval() -> u64 {
    1000
}
fn default_vlm_update_interval() -> u64 {
    10000
}
fn default_tf_change_threshold() -> f64 {
    10.0
}
fn default_vlm_change_threshold() -> f64 {
    50.0
}
fn default_screen_capture_interval() -> u64 {
    2000
}
fn default_tile_size() -> u32 {
    256
}
fn default_true() -> bool {
    true
}
fn default_max_memory() -> u32 {
    2000
}
fn default_entity_timeout() -> u64 {
    30000
}
fn default_max_entities() -> u32 {
    100
}
fn default_face_match_threshold() -> f64 {
    0.6
}
fn default_max_face_profiles() -> u32 {
    1000
}

impl Default for VisionConfig {
    fn default() -> Self {
        Self {
            camera_name: None,
            pixel_change_threshold: 50.0,
            update_interval: 100,
            enable_pose_detection: false,
            enable_object_detection: false,
            enable_face_recognition: false,
            tf_update_interval: 1000,
            vlm_update_interval: 10000,
            tf_change_threshold: 10.0,
            vlm_change_threshold: 50.0,
            vision_mode: VisionMode::Camera,
            screen_capture_interval: 2000,
            tile_size: 256,
            tile_processing_order: TileProcessingOrder::Priority,
            ocr_enabled: true,
            florence2_enabled: true,
            display_index: None,
            capture_all_displays: false,
            target_screen_fps: None,
            enable_gpu_acceleration: true,
            max_memory_usage_mb: 2000,
            entity_timeout: 30000,
            max_tracked_entities: 100,
            face_match_threshold: 0.6,
            max_face_profiles: 1000,
            debug_mode: false,
            enable_ocr: false,
            enable_opencv: false,
        }
    }
}

/// Action result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionResult {
    /// Result text
    pub text: String,
    /// Result values
    pub values: serde_json::Value,
    /// Result data
    pub data: serde_json::Value,
}

/// Provider result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderResult {
    /// Result text
    pub text: String,
    /// Result values
    pub values: serde_json::Value,
    /// Result data
    pub data: serde_json::Value,
}

/// Entity tracking statistics
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackingStatistics {
    /// Number of active entities
    pub active_entities: usize,
    /// Number of tracked people
    pub people: usize,
    /// Number of tracked objects
    pub objects: usize,
    /// Number of named entities
    pub named_entities: usize,
    /// Number of recently departed
    pub recently_left: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_vision_mode_display() {
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
    fn test_vision_config_default() {
        let config = VisionConfig::default();
        assert!(!config.enable_ocr);
        assert!(!config.enable_opencv);
        assert_eq!(config.vision_mode, VisionMode::Camera);
        assert!((config.pixel_change_threshold - 50.0).abs() < f64::EPSILON);
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
    fn test_entity_attributes_default() {
        let attrs = EntityAttributes::default();
        assert!(attrs.name.is_none());
        assert!(attrs.clothing.is_empty());
        assert!(attrs.tags.is_empty());
    }

    #[test]
    fn test_point2d_creation() {
        let point = Point2D::new(10.5, 20.5);
        assert!((point.x - 10.5).abs() < f64::EPSILON);
        assert!((point.y - 20.5).abs() < f64::EPSILON);
    }

    #[test]
    fn test_scene_description_serialization() {
        let scene = SceneDescription {
            timestamp: 1704067200000,
            description: "A test scene".to_string(),
            objects: vec![],
            people: vec![],
            scene_changed: false,
            change_percentage: 5.0,
            audio_transcription: None,
        };

        let json = serde_json::to_string(&scene).unwrap();
        let parsed: SceneDescription = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.description, "A test scene");
    }

    #[test]
    fn test_tracked_entity_creation() {
        let entity = TrackedEntity {
            id: "entity-001".to_string(),
            entity_type: EntityType::Person,
            first_seen: 1000,
            last_seen: 2000,
            last_position: BoundingBox::new(0.0, 0.0, 100.0, 200.0),
            appearances: vec![],
            attributes: EntityAttributes::default(),
            world_id: Some("world-001".to_string()),
            room_id: Some("room-001".to_string()),
        };

        assert_eq!(entity.entity_type, EntityType::Person);
        assert!(entity.world_id.is_some());
    }

    #[test]
    fn test_world_state_creation() {
        let state = WorldState {
            world_id: "world-001".to_string(),
            entities: HashMap::new(),
            last_update: 1000,
            active_entities: vec![],
            recently_left: vec![],
        };

        assert_eq!(state.world_id, "world-001");
        assert!(state.entities.is_empty());
    }
}
