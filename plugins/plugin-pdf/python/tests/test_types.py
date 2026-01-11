"""Tests for PDF plugin types."""

import pytest

from elizaos_plugin_pdf.types import (
    PdfConversionResult,
    PdfDocumentInfo,
    PdfExtractionOptions,
    PdfMetadata,
    PdfPageInfo,
)


class TestPdfExtractionOptions:
    """Tests for PdfExtractionOptions."""

    def test_default_options(self) -> None:
        """Test default extraction options."""
        options = PdfExtractionOptions()
        assert options.start_page is None
        assert options.end_page is None
        assert options.preserve_whitespace is False
        assert options.clean_content is True

    def test_custom_options(self) -> None:
        """Test custom extraction options."""
        options = PdfExtractionOptions(
            start_page=1,
            end_page=5,
            preserve_whitespace=True,
            clean_content=False,
        )
        assert options.start_page == 1
        assert options.end_page == 5
        assert options.preserve_whitespace is True
        assert options.clean_content is False


class TestPdfConversionResult:
    """Tests for PdfConversionResult."""

    def test_success_result(self) -> None:
        """Test successful conversion result."""
        result = PdfConversionResult(
            success=True,
            text="Hello World",
            page_count=1,
        )
        assert result.success is True
        assert result.text == "Hello World"
        assert result.page_count == 1
        assert result.error is None

    def test_error_result(self) -> None:
        """Test failed conversion result."""
        result = PdfConversionResult(
            success=False,
            error="Failed to parse PDF",
        )
        assert result.success is False
        assert result.text is None
        assert result.error == "Failed to parse PDF"


class TestPdfPageInfo:
    """Tests for PdfPageInfo."""

    def test_page_info(self) -> None:
        """Test page info creation."""
        page = PdfPageInfo(
            page_number=1,
            width=612.0,
            height=792.0,
            text="Page content",
        )
        assert page.page_number == 1
        assert page.width == 612.0
        assert page.height == 792.0
        assert page.text == "Page content"


class TestPdfMetadata:
    """Tests for PdfMetadata."""

    def test_empty_metadata(self) -> None:
        """Test empty metadata."""
        metadata = PdfMetadata()
        assert metadata.title is None
        assert metadata.author is None

    def test_full_metadata(self) -> None:
        """Test full metadata."""
        metadata = PdfMetadata(
            title="Test Document",
            author="Test Author",
            subject="Testing",
        )
        assert metadata.title == "Test Document"
        assert metadata.author == "Test Author"
        assert metadata.subject == "Testing"


class TestPdfDocumentInfo:
    """Tests for PdfDocumentInfo."""

    def test_document_info(self) -> None:
        """Test document info creation."""
        info = PdfDocumentInfo(
            page_count=1,
            metadata=PdfMetadata(title="Test"),
            text="Full text",
            pages=[
                PdfPageInfo(
                    page_number=1,
                    width=612.0,
                    height=792.0,
                    text="Page text",
                )
            ],
        )
        assert info.page_count == 1
        assert info.metadata.title == "Test"
        assert len(info.pages) == 1


