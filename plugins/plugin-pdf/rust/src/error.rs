#![allow(missing_docs)]

use thiserror::Error;

#[derive(Error, Debug)]
pub enum PdfError {
    #[error("Failed to parse PDF: {0}")]
    ParseError(String),

    #[error("File error: {0}")]
    FileError(#[from] std::io::Error),

    #[error("Page not found: {0}")]
    PageNotFound(usize),

    #[error("Invalid page range: start {start} > end {end}")]
    InvalidPageRange { start: usize, end: usize },

    #[error("PDF document is empty")]
    EmptyDocument,

    #[error("Text extraction failed: {0}")]
    ExtractionError(String),
}

pub type Result<T> = std::result::Result<T, PdfError>;
