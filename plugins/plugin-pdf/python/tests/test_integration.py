"""Integration tests for the PDF plugin."""

import pytest


class TestPdfPluginStructure:
    """Tests for plugin structure."""

    def test_import_plugin(self) -> None:
        """Test that plugin can be imported."""
        from elizaos_plugin_pdf import PdfPlugin
        assert PdfPlugin is not None

    def test_import_client(self) -> None:
        """Test that client can be imported."""
        from elizaos_plugin_pdf import PdfClient
        assert PdfClient is not None

    def test_import_types(self) -> None:
        """Test that types can be imported."""
        from elizaos_plugin_pdf import (
            PdfConversionResult,
            PdfExtractionOptions,
            PdfDocumentInfo,
        )
        assert PdfConversionResult is not None
        assert PdfExtractionOptions is not None
        assert PdfDocumentInfo is not None


class TestPdfPluginCreation:
    """Tests for plugin creation."""

    def test_create_plugin(self) -> None:
        """Test creating a plugin instance."""
        from elizaos_plugin_pdf import PdfPlugin
        
        plugin = PdfPlugin()
        assert plugin is not None

    def test_get_pdf_plugin(self) -> None:
        """Test get_pdf_plugin helper."""
        from elizaos_plugin_pdf import get_pdf_plugin
        
        plugin = get_pdf_plugin()
        assert plugin is not None


class TestPdfTypes:
    """Tests for PDF types."""

    def test_extraction_options(self) -> None:
        """Test extraction options type."""
        from elizaos_plugin_pdf import PdfExtractionOptions
        
        options = PdfExtractionOptions(
            start_page=1,
            end_page=10,
            preserve_whitespace=True,
        )
        assert options.start_page == 1
        assert options.end_page == 10

    def test_conversion_result_success(self) -> None:
        """Test successful conversion result."""
        from elizaos_plugin_pdf import PdfConversionResult
        
        result = PdfConversionResult(
            success=True,
            text="Sample PDF content",
            page_count=5,
        )
        assert result.success is True
        assert result.text == "Sample PDF content"

    def test_conversion_result_error(self) -> None:
        """Test error conversion result."""
        from elizaos_plugin_pdf import PdfConversionResult
        
        result = PdfConversionResult(
            success=False,
            error="Failed to parse PDF",
        )
        assert result.success is False
        assert result.error == "Failed to parse PDF"
