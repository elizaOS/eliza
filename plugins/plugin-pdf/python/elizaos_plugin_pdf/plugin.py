"""
PDF Plugin for elizaOS.

Provides a high-level interface to PDF processing.
"""

from __future__ import annotations

from pathlib import Path

from elizaos_plugin_pdf.client import PdfClient
from elizaos_plugin_pdf.types import (
    PdfConversionResult,
    PdfDocumentInfo,
    PdfExtractionOptions,
)


class PdfPlugin:
    """
    High-level PDF plugin for elizaOS.

    Provides convenient methods for PDF processing.
    """

    def __init__(self) -> None:
        """Initialize the PDF plugin."""
        self._client = PdfClient()

    # =========================================================================
    # Text Extraction
    # =========================================================================

    async def extract_text(
        self,
        pdf_bytes: bytes,
        *,
        start_page: int | None = None,
        end_page: int | None = None,
        clean_content: bool = True,
    ) -> str:
        """
        Extract text from PDF bytes.

        Args:
            pdf_bytes: The PDF file content as bytes.
            start_page: Optional starting page (1-indexed).
            end_page: Optional ending page (1-indexed).
            clean_content: Whether to clean control characters.

        Returns:
            Extracted text content.
        """
        options = PdfExtractionOptions(
            start_page=start_page,
            end_page=end_page,
            clean_content=clean_content,
        )
        return await self._client.extract_text(pdf_bytes, options)

    async def extract_text_from_file(
        self,
        file_path: str | Path,
        *,
        start_page: int | None = None,
        end_page: int | None = None,
        clean_content: bool = True,
    ) -> str:
        """
        Extract text from a PDF file.

        Args:
            file_path: Path to the PDF file.
            start_page: Optional starting page (1-indexed).
            end_page: Optional ending page (1-indexed).
            clean_content: Whether to clean control characters.

        Returns:
            Extracted text content.
        """
        options = PdfExtractionOptions(
            start_page=start_page,
            end_page=end_page,
            clean_content=clean_content,
        )
        return await self._client.extract_text_from_file(file_path, options)

    async def convert_to_text(
        self,
        pdf_bytes: bytes,
        *,
        start_page: int | None = None,
        end_page: int | None = None,
    ) -> PdfConversionResult:
        """
        Convert PDF to text with full result information.

        Args:
            pdf_bytes: The PDF file content as bytes.
            start_page: Optional starting page (1-indexed).
            end_page: Optional ending page (1-indexed).

        Returns:
            PdfConversionResult with success status and text.
        """
        options = PdfExtractionOptions(
            start_page=start_page,
            end_page=end_page,
        )
        return await self._client.convert_pdf_to_text(pdf_bytes, options)

    # =========================================================================
    # Document Information
    # =========================================================================

    async def get_document_info(self, pdf_bytes: bytes) -> PdfDocumentInfo:
        """
        Get full document information including metadata and per-page text.

        Args:
            pdf_bytes: The PDF file content as bytes.

        Returns:
            PdfDocumentInfo with all document information.
        """
        return await self._client.get_document_info(pdf_bytes)

    async def get_document_info_from_file(
        self, file_path: str | Path
    ) -> PdfDocumentInfo:
        """
        Get document information from a PDF file.

        Args:
            file_path: Path to the PDF file.

        Returns:
            PdfDocumentInfo with all document information.
        """
        return await self._client.get_document_info_from_file(file_path)

    async def get_page_count(self, pdf_bytes: bytes) -> int:
        """
        Get the number of pages in a PDF.

        Args:
            pdf_bytes: The PDF file content as bytes.

        Returns:
            Number of pages.
        """
        return await self._client.get_page_count(pdf_bytes)


# Convenience function to create plugin
def create_plugin() -> PdfPlugin:
    """
    Create a PDF plugin instance.

    Returns:
        PdfPlugin instance.
    """
    return PdfPlugin()


# Lazy plugin singleton
_pdf_plugin_instance: PdfPlugin | None = None


def get_pdf_plugin() -> PdfPlugin:
    """Get the singleton PDF plugin instance."""
    global _pdf_plugin_instance
    if _pdf_plugin_instance is None:
        _pdf_plugin_instance = create_plugin()
    return _pdf_plugin_instance

