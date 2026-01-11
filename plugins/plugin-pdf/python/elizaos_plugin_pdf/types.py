"""
PDF Plugin Types

Strong types with Pydantic validation for PDF operations.
"""

from datetime import datetime

from pydantic import BaseModel, Field


class PdfExtractionOptions(BaseModel):
    """Options for PDF text extraction."""

    start_page: int | None = Field(default=None, ge=1, description="Starting page (1-indexed)")
    end_page: int | None = Field(default=None, ge=1, description="Ending page (1-indexed)")
    preserve_whitespace: bool = Field(default=False, description="Whether to preserve whitespace")
    clean_content: bool = Field(default=True, description="Whether to clean control characters")


class PdfConversionResult(BaseModel):
    """Result of a PDF conversion operation."""

    success: bool = Field(..., description="Whether the conversion was successful")
    text: str | None = Field(default=None, description="The extracted text content")
    page_count: int | None = Field(default=None, ge=0, description="Number of pages in the PDF")
    error: str | None = Field(default=None, description="Error message if unsuccessful")


class PdfPageInfo(BaseModel):
    """PDF page information."""

    page_number: int = Field(..., ge=1, description="Page number (1-indexed)")
    width: float = Field(..., ge=0, description="Page width in points")
    height: float = Field(..., ge=0, description="Page height in points")
    text: str = Field(..., description="Text content of the page")


class PdfMetadata(BaseModel):
    """PDF document metadata."""

    title: str | None = Field(default=None, description="Document title")
    author: str | None = Field(default=None, description="Document author")
    subject: str | None = Field(default=None, description="Document subject")
    keywords: str | None = Field(default=None, description="Document keywords")
    creator: str | None = Field(default=None, description="Document creator")
    producer: str | None = Field(default=None, description="Document producer")
    creation_date: datetime | None = Field(default=None, description="Creation date")
    modification_date: datetime | None = Field(default=None, description="Modification date")


class PdfDocumentInfo(BaseModel):
    """Full PDF document information."""

    page_count: int = Field(..., ge=0, description="Number of pages")
    metadata: PdfMetadata = Field(..., description="Document metadata")
    text: str = Field(..., description="Full text content")
    pages: list[PdfPageInfo] = Field(..., description="Per-page information")


