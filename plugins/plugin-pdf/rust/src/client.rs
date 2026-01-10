//! PDF Client
//!
//! Async client for PDF text extraction.

use lopdf::Document;
use regex::Regex;
use std::path::Path;
use tokio::fs;
use tracing::debug;

use crate::error::{PdfError, Result};
use crate::types::{
    PdfConversionResult, PdfDocumentInfo, PdfExtractionOptions, PdfMetadata, PdfPageInfo,
};

/// PDF processing client.
pub struct PdfClient {
    control_char_regex: Regex,
    whitespace_regex: Regex,
    trailing_space_regex: Regex,
}

impl PdfClient {
    /// Create a new PDF client.
    pub fn new() -> Self {
        Self {
            control_char_regex: Regex::new(r"[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]").unwrap(),
            whitespace_regex: Regex::new(r"[^\S\r\n]+").unwrap(),
            trailing_space_regex: Regex::new(r"[ \t]+(\r?\n)").unwrap(),
        }
    }

    /// Clean up PDF text content.
    fn clean_content(&self, content: &str) -> String {
        // Remove control characters
        let cleaned = self.control_char_regex.replace_all(content, "");
        // Collapse whitespace
        let cleaned = self.whitespace_regex.replace_all(&cleaned, " ");
        // Remove trailing spaces
        let cleaned = self.trailing_space_regex.replace_all(&cleaned, "$1");
        cleaned.trim().to_string()
    }

    /// Extract text from PDF bytes.
    pub async fn extract_text(
        &self,
        pdf_bytes: &[u8],
        options: Option<PdfExtractionOptions>,
    ) -> Result<String> {
        debug!("Extracting text from PDF ({} bytes)", pdf_bytes.len());

        let bytes = pdf_bytes.to_vec();
        let opts = options.unwrap_or_default();
        let clean = opts.clean_content;

        // Parse in blocking task
        let text = tokio::task::spawn_blocking(move || -> Result<String> {
            let doc =
                Document::load_mem(&bytes).map_err(|e| PdfError::ParseError(e.to_string()))?;

            let page_count = doc.get_pages().len();
            if page_count == 0 {
                return Err(PdfError::EmptyDocument);
            }

            let start = opts.start_page.unwrap_or(1).saturating_sub(1);
            let end = opts.end_page.unwrap_or(page_count).min(page_count);

            if start >= end {
                return Err(PdfError::InvalidPageRange { start, end });
            }

            // Extract text using pdf-extract
            let full_text = pdf_extract::extract_text_from_mem(&bytes)
                .map_err(|e| PdfError::ExtractionError(e.to_string()))?;

            Ok(full_text)
        })
        .await
        .map_err(|e| PdfError::ExtractionError(e.to_string()))??;

        if clean {
            Ok(self.clean_content(&text))
        } else {
            Ok(text)
        }
    }

    /// Extract text from a PDF file.
    pub async fn extract_text_from_file(
        &self,
        file_path: &str,
        options: Option<PdfExtractionOptions>,
    ) -> Result<String> {
        debug!("Extracting text from PDF file: {}", file_path);

        let path = Path::new(file_path);
        if !path.exists() {
            return Err(PdfError::FileError(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("File not found: {}", file_path),
            )));
        }

        let bytes = fs::read(path).await?;
        self.extract_text(&bytes, options).await
    }

    /// Convert PDF to text with full result information.
    pub async fn convert_to_text(
        &self,
        pdf_bytes: &[u8],
        options: Option<PdfExtractionOptions>,
    ) -> PdfConversionResult {
        let bytes = pdf_bytes.to_vec();

        // Get page count first
        let page_count = match tokio::task::spawn_blocking({
            let bytes = bytes.clone();
            move || -> Result<usize> {
                let doc = Document::load_mem(&bytes)
                    .map_err(|e| PdfError::ParseError(e.to_string()))?;
                Ok(doc.get_pages().len())
            }
        })
        .await
        {
            Ok(Ok(count)) => count,
            Ok(Err(e)) => return PdfConversionResult::failure(e.to_string()),
            Err(e) => return PdfConversionResult::failure(e.to_string()),
        };

        match self.extract_text(pdf_bytes, options).await {
            Ok(text) => PdfConversionResult::success(text, page_count),
            Err(e) => PdfConversionResult::failure(e.to_string()),
        }
    }

    /// Get full document information.
    pub async fn get_document_info(&self, pdf_bytes: &[u8]) -> Result<PdfDocumentInfo> {
        debug!("Getting document info from PDF ({} bytes)", pdf_bytes.len());

        let bytes = pdf_bytes.to_vec();
        let client = Self::new();

        tokio::task::spawn_blocking(move || -> Result<PdfDocumentInfo> {
            let doc =
                Document::load_mem(&bytes).map_err(|e| PdfError::ParseError(e.to_string()))?;

            let page_count = doc.get_pages().len();
            if page_count == 0 {
                return Err(PdfError::EmptyDocument);
            }

            // Extract metadata (simplified - metadata extraction is optional)
            let metadata = PdfMetadata::default();

            // Extract text
            let full_text = pdf_extract::extract_text_from_mem(&bytes)
                .map_err(|e| PdfError::ExtractionError(e.to_string()))?;

            // Create page info (simplified - using full text for all pages)
            let mut pages = Vec::new();
            for page_num in 1..=page_count {
                pages.push(PdfPageInfo {
                    page_number: page_num,
                    width: 612.0,  // Default US Letter width
                    height: 792.0, // Default US Letter height
                    text: String::new(), // Simplified: per-page extraction not implemented
                });
            }

            Ok(PdfDocumentInfo {
                page_count,
                metadata,
                text: client.clean_content(&full_text),
                pages,
            })
        })
        .await
        .map_err(|e| PdfError::ExtractionError(e.to_string()))?
    }

    /// Get the number of pages in a PDF.
    pub async fn get_page_count(&self, pdf_bytes: &[u8]) -> Result<usize> {
        debug!("Getting page count from PDF ({} bytes)", pdf_bytes.len());

        let bytes = pdf_bytes.to_vec();

        tokio::task::spawn_blocking(move || -> Result<usize> {
            let doc =
                Document::load_mem(&bytes).map_err(|e| PdfError::ParseError(e.to_string()))?;
            Ok(doc.get_pages().len())
        })
        .await
        .map_err(|e| PdfError::ExtractionError(e.to_string()))?
    }
}

impl Default for PdfClient {
    fn default() -> Self {
        Self::new()
    }
}
