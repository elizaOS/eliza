#![allow(missing_docs)]

use lopdf::Document;
use regex::Regex;
use std::path::Path;
use tokio::fs;
use tracing::debug;

use crate::error::{PdfError, Result};
use crate::types::{
    PdfConversionResult, PdfDocumentInfo, PdfExtractionOptions, PdfMetadata, PdfPageInfo,
};

pub struct PdfClient {
    control_char_regex: Regex,
    whitespace_regex: Regex,
    trailing_space_regex: Regex,
}

impl PdfClient {
    pub fn new() -> Self {
        Self {
            control_char_regex: Regex::new(r"[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]").unwrap(),
            whitespace_regex: Regex::new(r"[^\S\r\n]+").unwrap(),
            trailing_space_regex: Regex::new(r"[ \t]+(\r?\n)").unwrap(),
        }
    }

    fn clean_content(&self, content: &str) -> String {
        let cleaned = self.control_char_regex.replace_all(content, "");
        let cleaned = self.whitespace_regex.replace_all(&cleaned, " ");
        let cleaned = self.trailing_space_regex.replace_all(&cleaned, "$1");
        cleaned.trim().to_string()
    }

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

        let page_count = match tokio::task::spawn_blocking({
            let bytes = bytes.clone();
            move || -> Result<usize> {
                let doc =
                    Document::load_mem(&bytes).map_err(|e| PdfError::ParseError(e.to_string()))?;
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

            let metadata = PdfMetadata::default();

            let full_text = pdf_extract::extract_text_from_mem(&bytes)
                .map_err(|e| PdfError::ExtractionError(e.to_string()))?;

            let mut pages = Vec::new();
            for page_num in 1..=page_count {
                pages.push(PdfPageInfo {
                    page_number: page_num,
                    width: 612.0,
                    height: 792.0,
                    text: String::new(),
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
