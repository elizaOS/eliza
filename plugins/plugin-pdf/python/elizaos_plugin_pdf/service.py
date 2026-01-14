from __future__ import annotations

from elizaos_plugin_pdf.client import PdfClient
from elizaos_plugin_pdf.types import (
    PdfConversionResult,
    PdfDocumentInfo,
    PdfExtractionOptions,
)


class PdfService:
    """
    Minimal service wrapper for PDF processing (TS parity: `PdfService`).
    """

    service_type: str = "PDF"
    capability_description: str = "The agent is able to convert PDF files to text"

    def __init__(self) -> None:
        self._client = PdfClient()

    @property
    def client(self) -> PdfClient:
        return self._client

    async def extract_text(
        self,
        pdf_bytes: bytes,
        options: PdfExtractionOptions | None = None,
    ) -> str:
        return await self._client.extract_text(pdf_bytes, options)

    async def convert_pdf_to_text(
        self,
        pdf_bytes: bytes,
        options: PdfExtractionOptions | None = None,
    ) -> PdfConversionResult:
        return await self._client.convert_pdf_to_text(pdf_bytes, options)

    async def get_document_info(self, pdf_bytes: bytes) -> PdfDocumentInfo:
        return await self._client.get_document_info(pdf_bytes)
