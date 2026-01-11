#![allow(missing_docs)]
//! Types for the vision plugin

use serde::{Deserialize, Serialize};

/// Vision configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VisionConfig {
    /// Enable OCR
    pub enable_ocr: bool,
    /// Enable OpenCV
    pub enable_opencv: bool,
}


impl Default for VisionConfig {
    fn default() -> Self {
        Self {
            enable_ocr: false,
            enable_opencv: false,
        }
    }
}

