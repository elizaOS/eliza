//! Error types for the vision plugin

use thiserror::Error;

/// Result type for vision operations
pub type Result<T> = std::result::Result<T, VisionError>;

/// Vision plugin errors
#[derive(Debug, Error)]
pub enum VisionError {
    /// Image processing error
    #[error("Image processing error: {0}")]
    ImageProcessing(String),

    /// OCR error
    #[error("OCR error: {0}")]
    Ocr(String),

    /// OpenCV error
    #[error("OpenCV error: {0}")]
    OpenCv(String),

    /// Camera not available
    #[error("Camera not available: {0}")]
    CameraNotAvailable(String),

    /// Screen capture error
    #[error("Screen capture error: {0}")]
    ScreenCaptureError(String),

    /// Model initialization error
    #[error("Model initialization error: {0}")]
    ModelInitialization(String),

    /// Processing error
    #[error("Processing error: {0}")]
    Processing(String),

    /// Configuration error
    #[error("Configuration error: {0}")]
    Configuration(String),

    /// Service not running
    #[error("Service not running: {0}")]
    ServiceNotRunning(String),

    /// Entity tracking error
    #[error("Entity tracking error: {0}")]
    EntityTracking(String),

    /// IO error
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    /// Serialization error
    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
}
