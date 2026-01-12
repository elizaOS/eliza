from elizaos_plugin_pdf.client import PdfClient, PdfError
from elizaos_plugin_pdf.plugin import PdfPlugin, create_plugin, get_pdf_plugin
from elizaos_plugin_pdf.types import (
    PdfConversionResult,
    PdfDocumentInfo,
    PdfExtractionOptions,
    PdfMetadata,
    PdfPageInfo,
)

__version__ = "1.0.0"

__all__ = [
    "PdfPlugin",
    "create_plugin",
    "get_pdf_plugin",
    "PdfClient",
    "PdfError",
    "PdfConversionResult",
    "PdfExtractionOptions",
    "PdfPageInfo",
    "PdfMetadata",
    "PdfDocumentInfo",
]
