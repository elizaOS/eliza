import pytest

pypdf = pytest.importorskip("pypdf", reason="pypdf not installed")


class TestPdfPluginStructure:
    def test_import_plugin(self) -> None:
        from elizaos_plugin_pdf import PdfPlugin

        assert PdfPlugin is not None

    def test_import_client(self) -> None:
        from elizaos_plugin_pdf import PdfClient

        assert PdfClient is not None

    def test_import_types(self) -> None:
        from elizaos_plugin_pdf import (
            PdfConversionResult,
            PdfDocumentInfo,
            PdfExtractionOptions,
        )

        assert PdfConversionResult is not None
        assert PdfExtractionOptions is not None
        assert PdfDocumentInfo is not None


class TestPdfPluginCreation:
    def test_create_plugin(self) -> None:
        from elizaos_plugin_pdf import PdfPlugin

        plugin = PdfPlugin()
        assert plugin is not None

    def test_get_pdf_plugin(self) -> None:
        from elizaos_plugin_pdf import get_pdf_plugin

        plugin = get_pdf_plugin()
        assert plugin is not None


class TestPdfTypes:
    def test_extraction_options(self) -> None:
        from elizaos_plugin_pdf import PdfExtractionOptions

        options = PdfExtractionOptions(
            start_page=1,
            end_page=10,
            preserve_whitespace=True,
        )
        assert options.start_page == 1
        assert options.end_page == 10

    def test_conversion_result_success(self) -> None:
        from elizaos_plugin_pdf import PdfConversionResult

        result = PdfConversionResult(
            success=True,
            text="Sample PDF content",
            page_count=5,
        )
        assert result.success is True
        assert result.text == "Sample PDF content"

    def test_conversion_result_error(self) -> None:
        from elizaos_plugin_pdf import PdfConversionResult

        result = PdfConversionResult(
            success=False,
            error="Failed to parse PDF",
        )
        assert result.success is False
        assert result.error == "Failed to parse PDF"
