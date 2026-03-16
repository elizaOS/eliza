"""Type definitions for the Scratchpad Plugin."""

from datetime import datetime

from pydantic import BaseModel, Field


class ScratchpadEntry(BaseModel):
    """A scratchpad file entry with metadata."""

    id: str = Field(description="Unique identifier (filename without extension)")
    path: str = Field(description="Full path to the scratchpad file")
    title: str = Field(description="Title/name of the scratchpad entry")
    content: str = Field(description="Content of the scratchpad entry")
    created_at: datetime = Field(description="Creation timestamp")
    modified_at: datetime = Field(description="Last modified timestamp")
    tags: list[str] = Field(default_factory=list, description="Tags for categorization")


class ScratchpadSearchResult(BaseModel):
    """A search result from the scratchpad."""

    path: str = Field(description="Path to the file")
    start_line: int = Field(description="Starting line number of the match")
    end_line: int = Field(description="Ending line number of the match")
    score: float = Field(description="Relevance score (0-1)")
    snippet: str = Field(description="The matching snippet")
    entry_id: str = Field(description="Entry ID (filename without extension)")


class ScratchpadReadOptions(BaseModel):
    """Options for reading a scratchpad entry."""

    from_line: int | None = Field(default=None, description="Starting line number (1-indexed)")
    lines: int | None = Field(default=None, description="Number of lines to read")


class ScratchpadWriteOptions(BaseModel):
    """Options for writing a scratchpad entry."""

    tags: list[str] | None = Field(default=None, description="Tags to associate with the entry")
    append: bool = Field(default=False, description="Whether to append to existing content")


class ScratchpadSearchOptions(BaseModel):
    """Options for searching scratchpad entries."""

    max_results: int = Field(default=10, description="Maximum number of results to return")
    min_score: float = Field(default=0.1, description="Minimum relevance score (0-1)")
