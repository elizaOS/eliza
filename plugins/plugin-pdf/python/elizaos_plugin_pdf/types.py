from datetime import datetime

from pydantic import BaseModel, Field


class PdfExtractionOptions(BaseModel):
    start_page: int | None = Field(default=None, ge=1)
    end_page: int | None = Field(default=None, ge=1)
    preserve_whitespace: bool = Field(default=False)
    clean_content: bool = Field(default=True)


class PdfConversionResult(BaseModel):
    success: bool = Field(...)
    text: str | None = Field(default=None)
    page_count: int | None = Field(default=None, ge=0)
    error: str | None = Field(default=None)


class PdfPageInfo(BaseModel):
    page_number: int = Field(..., ge=1)
    width: float = Field(..., ge=0)
    height: float = Field(..., ge=0)
    text: str = Field(...)


class PdfMetadata(BaseModel):
    title: str | None = Field(default=None)
    author: str | None = Field(default=None)
    subject: str | None = Field(default=None)
    keywords: str | None = Field(default=None)
    creator: str | None = Field(default=None)
    producer: str | None = Field(default=None)
    creation_date: datetime | None = Field(default=None)
    modification_date: datetime | None = Field(default=None)


class PdfDocumentInfo(BaseModel):
    page_count: int = Field(...)
    metadata: PdfMetadata = Field(...)
    text: str = Field(...)
    pages: list[PdfPageInfo] = Field(...)
