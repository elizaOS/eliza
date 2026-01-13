#![allow(missing_docs)]

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default)]
pub struct PdfExtractionOptions {
    pub start_page: Option<usize>,
    pub end_page: Option<usize>,
    pub preserve_whitespace: bool,
    pub clean_content: bool,
}

impl PdfExtractionOptions {
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

    pub fn failure(error: String) -> Self {
        Self {
            success: false,
            text: None,
            page_count: None,
            error: Some(error),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PdfPageInfo {
    pub page_number: usize,
    pub width: f64,
    pub height: f64,
    pub text: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PdfMetadata {
    pub title: Option<String>,
    pub author: Option<String>,
    pub subject: Option<String>,
    pub keywords: Option<String>,
    pub creator: Option<String>,
    pub producer: Option<String>,
    pub creation_date: Option<DateTime<Utc>>,
    pub modification_date: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PdfDocumentInfo {
    pub page_count: usize,
    pub metadata: PdfMetadata,
    pub text: String,
    pub pages: Vec<PdfPageInfo>,
}
