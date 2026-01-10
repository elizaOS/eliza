//! Error types for PDF Plugin

use thiserror::Error;

/// PDF processing error type.
#[derive(Error, Debug)]
pub enum PdfError {
    /// Parse error
    #[error("Failed to parse PDF: {0}")]
    ParseError(String),

    /// File system error
    #[error("File error: {0}")]
    FileError(#[from] std::io::Error),

    /// Page not found
    #[error("Page not found: {0}")]
    PageNotFound(usize),

    /// Invalid page range
    #[error("Invalid page range: start {start} > end {end}")]
    InvalidPageRange {
        /// Start page
        start: usize,
        /// End page
        end: usize,
    },

    /// Empty document
    #[error("PDF document is empty")]
    EmptyDocument,

    /// Extraction error
    #[error("Text extraction failed: {0}")]
    ExtractionError(String),
}

/// Result type alias for PDF operations.
pub type Result<T> = std::result::Result<T, PdfError>;

