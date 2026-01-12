from elizaos_plugin_pdf.types import (
    PdfConversionResult,
    PdfDocumentInfo,
    PdfExtractionOptions,
    PdfMetadata,
    PdfPageInfo,
)


class TestPdfExtractionOptions:
    def test_default_options(self) -> None:
        options = PdfExtractionOptions()
        assert options.start_page is None
        assert options.end_page is None
        assert options.preserve_whitespace is False
        assert options.clean_content is True

    def test_custom_options(self) -> None:
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
    def test_success_result(self) -> None:
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
        result = PdfConversionResult(
            success=False,
            error="Failed to parse PDF",
        )
        assert result.success is False
        assert result.text is None
        assert result.error == "Failed to parse PDF"


class TestPdfPageInfo:
    def test_page_info(self) -> None:
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
    def test_empty_metadata(self) -> None:
        metadata = PdfMetadata()
        assert metadata.title is None
        assert metadata.author is None

    def test_full_metadata(self) -> None:
        metadata = PdfMetadata(
            title="Test Document",
            author="Test Author",
            subject="Testing",
        )
        assert metadata.title == "Test Document"
        assert metadata.author == "Test Author"
        assert metadata.subject == "Testing"


class TestPdfDocumentInfo:
    def test_document_info(self) -> None:
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
