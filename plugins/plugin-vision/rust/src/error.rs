#![allow(missing_docs)]
//! Error types for the vision plugin

use thiserror::Error;

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
}

