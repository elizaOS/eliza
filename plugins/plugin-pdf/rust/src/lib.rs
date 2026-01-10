//! PDF Plugin for elizaOS
//!
//! This crate provides PDF reading and text extraction for elizaOS agents.
//!
//! # Example
//!
//! ```rust,no_run
//! use elizaos_plugin_pdf::{PdfClient, PdfExtractionOptions};
//!
//! # async fn example() -> anyhow::Result<()> {
//! let client = PdfClient::new();
//!
//! let pdf_bytes = std::fs::read("document.pdf")?;
//! let text = client.extract_text(&pdf_bytes, None).await?;
//! println!("Extracted: {}", text);
//! # Ok(())
//! # }
//! ```

#![warn(missing_docs)]

pub mod client;
pub mod error;
pub mod types;

pub use client::PdfClient;
pub use error::{PdfError, Result};
pub use types::*;

#[allow(unused_imports)]
use anyhow::Result as AnyhowResult;

/// PDF plugin for elizaOS.
///
/// This struct wraps the PDF client and provides a simple interface
/// for PDF processing operations.
pub struct PdfPlugin {
    client: PdfClient,
}

impl PdfPlugin {
    /// Create a new PDF plugin.
    pub fn new() -> Self {
        Self {
            client: PdfClient::new(),
        }
    }

    /// Extract text from PDF bytes.
    pub async fn extract_text(
        &self,
        pdf_bytes: &[u8],
        options: Option<PdfExtractionOptions>,
    ) -> Result<String> {
        self.client.extract_text(pdf_bytes, options).await
    }

    /// Extract text from a PDF file.
    pub async fn extract_text_from_file(
        &self,
        file_path: &str,
        options: Option<PdfExtractionOptions>,
    ) -> Result<String> {
        self.client.extract_text_from_file(file_path, options).await
    }

    /// Convert PDF to text with full result information.
    pub async fn convert_to_text(
        &self,
        pdf_bytes: &[u8],
        options: Option<PdfExtractionOptions>,
    ) -> PdfConversionResult {
        self.client.convert_to_text(pdf_bytes, options).await
    }

    /// Get full document information.
    pub async fn get_document_info(&self, pdf_bytes: &[u8]) -> Result<PdfDocumentInfo> {
        self.client.get_document_info(pdf_bytes).await
    }

    /// Get the number of pages in a PDF.
    pub async fn get_page_count(&self, pdf_bytes: &[u8]) -> Result<usize> {
        self.client.get_page_count(pdf_bytes).await
    }

    /// Get the underlying client for advanced operations.
    pub fn client(&self) -> &PdfClient {
        &self.client
    }
}

impl Default for PdfPlugin {
    fn default() -> Self {
        Self::new()
    }
}

/// Create a PDF plugin instance.
pub fn get_pdf_plugin() -> PdfPlugin {
    PdfPlugin::new()
}

