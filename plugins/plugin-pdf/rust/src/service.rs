#![allow(missing_docs)]

use crate::client::PdfClient;
use crate::error::Result;
use crate::types::{PdfConversionResult, PdfDocumentInfo, PdfExtractionOptions};

/// Minimal service wrapper for PDF processing (TS parity: `PdfService`).
pub struct PdfService {
    client: PdfClient,
}

impl PdfService {
    pub const SERVICE_TYPE: &'static str = "PDF";
    pub const CAPABILITY_DESCRIPTION: &'static str = "Convert PDF files to text";

    pub fn new() -> Self {
        Self {
            client: PdfClient::new(),
        }
    }

    pub async fn extract_text(
        &self,
        pdf_bytes: &[u8],
        options: Option<PdfExtractionOptions>,
    ) -> Result<String> {
        self.client.extract_text(pdf_bytes, options).await
    }

    pub async fn convert_to_text(
        &self,
        pdf_bytes: &[u8],
        options: Option<PdfExtractionOptions>,
    ) -> PdfConversionResult {
        self.client.convert_to_text(pdf_bytes, options).await
    }

    pub async fn get_document_info(&self, pdf_bytes: &[u8]) -> Result<PdfDocumentInfo> {
        self.client.get_document_info(pdf_bytes).await
    }

    pub fn client(&self) -> &PdfClient {
        &self.client
    }
}

impl Default for PdfService {
    fn default() -> Self {
        Self::new()
    }
}
