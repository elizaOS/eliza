from __future__ import annotations

# Import types directly - they only depend on pydantic
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
    "PdfService",
    "PdfClient",
    "PdfError",
    "PdfConversionResult",
    "PdfExtractionOptions",
    "PdfPageInfo",
    "PdfMetadata",
    "PdfDocumentInfo",
]


def __getattr__(name: str) -> object:
    """Lazy import heavy dependencies (pypdf, aiofiles) only when needed."""
    if name in ("PdfClient", "PdfError"):
        from elizaos_plugin_pdf.client import PdfClient, PdfError

        if name == "PdfClient":
            return PdfClient
        return PdfError
    if name in ("PdfPlugin", "create_plugin", "get_pdf_plugin"):
        from elizaos_plugin_pdf.plugin import PdfPlugin, create_plugin, get_pdf_plugin

        if name == "PdfPlugin":
            return PdfPlugin
        if name == "create_plugin":
            return create_plugin
        return get_pdf_plugin
    if name == "PdfService":
        from elizaos_plugin_pdf.service import PdfService

        return PdfService
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
