#![allow(missing_docs)]
//! PDF Plugin Types
//!
//! Strong types for PDF processing operations.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Options for PDF text extraction.
#[derive(Debug, Clone, Default)]
pub struct PdfExtractionOptions {
    /// Starting page (1-indexed)
    pub start_page: Option<usize>,
    /// Ending page (1-indexed)
    pub end_page: Option<usize>,
    /// Whether to preserve whitespace
    pub preserve_whitespace: bool,
    /// Whether to clean control characters
    pub clean_content: bool,
}

impl PdfExtractionOptions {
    /// Create new extraction options.
    pub fn new() -> Self {
        Self {
            start_page: None,
            end_page: None,
            preserve_whitespace: false,
            clean_content: true,
        }
    }

    /// Set starting page.
    pub fn start_page(mut self, page: usize) -> Self {
        self.start_page = Some(page);
        self
    }

    /// Set ending page.
    pub fn end_page(mut self, page: usize) -> Self {
        self.end_page = Some(page);
        self
    }

    /// Set whether to preserve whitespace.
    pub fn preserve_whitespace(mut self, preserve: bool) -> Self {
        self.preserve_whitespace = preserve;
        self
    }

    /// Set whether to clean content.
    pub fn clean_content(mut self, clean: bool) -> Self {
        self.clean_content = clean;
        self
    }
}

/// Result of a PDF conversion operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PdfConversionResult {
    /// Whether the conversion was successful
    pub success: bool,
    /// The extracted text content
    pub text: Option<String>,
    /// Number of pages in the PDF
    pub page_count: Option<usize>,
    /// Error message if unsuccessful
    pub error: Option<String>,
}

impl PdfConversionResult {
    /// Create a successful result.
    pub fn success(text: String, page_count: usize) -> Self {
        Self {
            success: true,
            text: Some(text),
            page_count: Some(page_count),
            error: None,
        }
    }

    /// Create a failed result.
    pub fn failure(error: String) -> Self {
        Self {
            success: false,
            text: None,
            page_count: None,
            error: Some(error),
        }
    }
}

/// PDF page information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PdfPageInfo {
    /// Page number (1-indexed)
    pub page_number: usize,
    /// Page width in points
    pub width: f64,
    /// Page height in points
    pub height: f64,
    /// Text content of the page
    pub text: String,
}

/// PDF document metadata.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PdfMetadata {
    /// Document title
    pub title: Option<String>,
    /// Document author
    pub author: Option<String>,
    /// Document subject
    pub subject: Option<String>,
    /// Document keywords
    pub keywords: Option<String>,
    /// Document creator
    pub creator: Option<String>,
    /// Document producer
    pub producer: Option<String>,
    /// Creation date
    pub creation_date: Option<DateTime<Utc>>,
    /// Modification date
    pub modification_date: Option<DateTime<Utc>>,
}

/// Full PDF document information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PdfDocumentInfo {
    /// Number of pages
    pub page_count: usize,
    /// Document metadata
    pub metadata: PdfMetadata,
    /// Full text content
    pub text: String,
    /// Per-page information
    pub pages: Vec<PdfPageInfo>,
}







