from __future__ import annotations

import asyncio
import io
import re
from datetime import datetime
from functools import partial
from pathlib import Path

import aiofiles
from pypdf import PdfReader

from elizaos_plugin_pdf.types import (
    PdfConversionResult,
    PdfDocumentInfo,
    PdfExtractionOptions,
    PdfMetadata,
    PdfPageInfo,
)


class PdfError(Exception):
    def __init__(self, message: str, cause: Exception | None = None) -> None:
        super().__init__(message)
        self.cause = cause


class PdfClient:
    def __init__(self) -> None:
        pass

    def _clean_content(self, content: str) -> str:
        try:
            filtered = "".join(
                char
                for char in content
                if not (
                    ord(char) == 0
                    or 1 <= ord(char) <= 8
                    or 11 <= ord(char) <= 12
                    or 14 <= ord(char) <= 31
                    or ord(char) == 127
                )
            )

            cleaned = re.sub(r"[^\S\r\n]+", " ", filtered)
            cleaned = re.sub(r"[ \t]+(\r?\n)", r"\1", cleaned)
            cleaned = cleaned.strip()

            return cleaned
        except Exception:
            return content

    def _extract_text_sync(
        self, pdf_bytes: bytes, options: PdfExtractionOptions
    ) -> PdfConversionResult:
        try:
            reader = PdfReader(io.BytesIO(pdf_bytes))
            num_pages = len(reader.pages)

            start_page = max(0, (options.start_page or 1) - 1)
            end_page = min(num_pages, options.end_page or num_pages)

            text_pages: list[str] = []
            for page_num in range(start_page, end_page):
                page = reader.pages[page_num]
                page_text = page.extract_text() or ""
                text_pages.append(page_text)

            text = "\n".join(text_pages)

            if options.clean_content:
                text = self._clean_content(text)

            return PdfConversionResult(
                success=True,
                text=text,
                page_count=num_pages,
            )
        except Exception as e:
            return PdfConversionResult(
                success=False,
                error=str(e),
            )

    async def extract_text(
        self,
        pdf_bytes: bytes,
        options: PdfExtractionOptions | None = None,
    ) -> str:
        opts = options or PdfExtractionOptions()
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(None, partial(self._extract_text_sync, pdf_bytes, opts))

        if not result.success:
            raise PdfError(result.error or "PDF extraction failed")

        return result.text or ""

    async def extract_text_from_file(
        self,
        file_path: str | Path,
        options: PdfExtractionOptions | None = None,
    ) -> str:
        path = Path(file_path)
        if not path.exists():
            raise FileNotFoundError(f"File not found: {file_path}")

        async with aiofiles.open(path, "rb") as f:
            pdf_bytes = await f.read()

        return await self.extract_text(pdf_bytes, options)

    async def convert_pdf_to_text(
        self,
        pdf_bytes: bytes,
        options: PdfExtractionOptions | None = None,
    ) -> PdfConversionResult:
        opts = options or PdfExtractionOptions()
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, partial(self._extract_text_sync, pdf_bytes, opts))

    def _get_document_info_sync(self, pdf_bytes: bytes) -> PdfDocumentInfo:
        reader = PdfReader(io.BytesIO(pdf_bytes))
        num_pages = len(reader.pages)

        pdf_meta = reader.metadata
        metadata = PdfMetadata()

        if pdf_meta:
            metadata = PdfMetadata(
                title=pdf_meta.title,
                author=pdf_meta.author,
                subject=pdf_meta.subject,
                keywords=getattr(pdf_meta, "keywords", None),
                creator=pdf_meta.creator,
                producer=pdf_meta.producer,
                creation_date=self._parse_pdf_date(pdf_meta.creation_date),
                modification_date=self._parse_pdf_date(pdf_meta.modification_date),
            )

        pages: list[PdfPageInfo] = []
        all_text: list[str] = []

        for i, page in enumerate(reader.pages):
            page_text = page.extract_text() or ""
            cleaned_text = self._clean_content(page_text)

            mediabox = page.mediabox
            pages.append(
                PdfPageInfo(
                    page_number=i + 1,
                    width=float(mediabox.width),
                    height=float(mediabox.height),
                    text=cleaned_text,
                )
            )
            all_text.append(page_text)

        return PdfDocumentInfo(
            page_count=num_pages,
            metadata=metadata,
            text=self._clean_content("\n".join(all_text)),
            pages=pages,
        )

    def _parse_pdf_date(self, date_str: str | None) -> datetime | None:
        if not date_str:
            return None

        try:
            if date_str.startswith("D:"):
                date_str = date_str[2:]

            for fmt in [
                "%Y%m%d%H%M%S",
                "%Y%m%d%H%M",
                "%Y%m%d",
                "%Y-%m-%d %H:%M:%S",
                "%Y-%m-%dT%H:%M:%S",
            ]:
                try:
                    return datetime.strptime(date_str[: len(fmt.replace("%", ""))], fmt)
                except ValueError:
                    continue

            return None
        except Exception:
            return None

    async def get_document_info(self, pdf_bytes: bytes) -> PdfDocumentInfo:
        try:
            loop = asyncio.get_running_loop()
            return await loop.run_in_executor(
                None, partial(self._get_document_info_sync, pdf_bytes)
            )
        except Exception as e:
            raise PdfError(f"Failed to get document info: {e}", cause=e) from e

    async def get_document_info_from_file(self, file_path: str | Path) -> PdfDocumentInfo:
        path = Path(file_path)
        if not path.exists():
            raise FileNotFoundError(f"File not found: {file_path}")

        async with aiofiles.open(path, "rb") as f:
            pdf_bytes = await f.read()

        return await self.get_document_info(pdf_bytes)

    async def get_page_count(self, pdf_bytes: bytes) -> int:
        def _count_pages() -> int:
            reader = PdfReader(io.BytesIO(pdf_bytes))
            return len(reader.pages)

        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, _count_pages)
