from __future__ import annotations

from pathlib import Path

from elizaos_plugin_pdf.client import PdfClient
from elizaos_plugin_pdf.types import (
    PdfConversionResult,
    PdfDocumentInfo,
    PdfExtractionOptions,
)


class PdfPlugin:
    def __init__(self) -> None:
        self._client = PdfClient()

    async def extract_text(
        self,
        pdf_bytes: bytes,
        *,
        start_page: int | None = None,
        end_page: int | None = None,
        clean_content: bool = True,
    ) -> str:
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
        options = PdfExtractionOptions(
            start_page=start_page,
            end_page=end_page,
        )
        return await self._client.convert_pdf_to_text(pdf_bytes, options)

    async def get_document_info(self, pdf_bytes: bytes) -> PdfDocumentInfo:
        return await self._client.get_document_info(pdf_bytes)

    async def get_document_info_from_file(self, file_path: str | Path) -> PdfDocumentInfo:
        return await self._client.get_document_info_from_file(file_path)

    async def get_page_count(self, pdf_bytes: bytes) -> int:
        return await self._client.get_page_count(pdf_bytes)


def create_plugin() -> PdfPlugin:
    return PdfPlugin()


_pdf_plugin_instance: PdfPlugin | None = None


def get_pdf_plugin() -> PdfPlugin:
    global _pdf_plugin_instance
    if _pdf_plugin_instance is None:
        _pdf_plugin_instance = create_plugin()
    return _pdf_plugin_instance
