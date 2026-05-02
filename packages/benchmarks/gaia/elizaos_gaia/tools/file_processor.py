"""
File Processor Tool for GAIA Benchmark

Handles various file formats including PDFs, images, spreadsheets, and audio.
"""

import base64
import logging
import mimetypes
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)


@dataclass
class FileContent:
    """Extracted content from a file."""
    file_path: str
    file_type: str
    content: str
    metadata: dict[str, str | int | float]
    success: bool
    error: str | None = None


@dataclass
class ImageAnalysis:
    """Analysis result from an image."""
    file_path: str
    description: str
    text_detected: str
    objects: list[str]
    success: bool
    error: str | None = None


class FileProcessor:
    """Process various file types for GAIA benchmark tasks."""

    def __init__(
        self,
        vision_model: str | None = None,
        max_content_length: int = 50000,
    ):
        """
        Initialize file processor.

        Args:
            vision_model: Model to use for image analysis (e.g., 'gpt-4-vision')
            max_content_length: Maximum characters to extract
        """
        self.vision_model = vision_model
        self.max_content_length = max_content_length

    async def process(self, file_path: Path | str) -> FileContent:
        """
        Process a file and extract its content.

        Args:
            file_path: Path to the file

        Returns:
            FileContent with extracted data
        """
        file_path = Path(file_path)

        if not file_path.exists():
            return FileContent(
                file_path=str(file_path),
                file_type="unknown",
                content="",
                metadata={},
                success=False,
                error=f"File not found: {file_path}",
            )

        # Determine file type
        mime_type, _ = mimetypes.guess_type(str(file_path))
        ext = file_path.suffix.lower()

        try:
            if ext == ".pdf":
                return await self.read_pdf(file_path)
            elif ext in [".xlsx", ".xls"]:
                return await self.read_excel(file_path)
            elif ext == ".csv":
                return await self.read_csv(file_path)
            elif ext in [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]:
                return await self.read_image(file_path)
            elif ext in [".mp3", ".wav", ".m4a", ".flac", ".ogg"]:
                return await self.read_audio(file_path)
            elif ext in [".json"]:
                return await self.read_json(file_path)
            elif ext in [".txt", ".md", ".rst", ".py", ".js", ".html", ".xml"]:
                return await self.read_text(file_path)
            else:
                # Try to read as text
                return await self.read_text(file_path)
        except Exception as e:
            logger.error(f"Failed to process file {file_path}: {e}")
            return FileContent(
                file_path=str(file_path),
                file_type=ext,
                content="",
                metadata={},
                success=False,
                error=str(e),
            )

    async def read_pdf(self, file_path: Path) -> FileContent:
        """Extract text from PDF file."""
        try:
            import pdfplumber
        except ImportError:
            try:
                import PyPDF2  # noqa: F401 - testing availability
                return await self._read_pdf_pypdf2(file_path)
            except ImportError:
                return FileContent(
                    file_path=str(file_path),
                    file_type="pdf",
                    content="",
                    metadata={},
                    success=False,
                    error="PDF libraries not installed. Install pdfplumber or PyPDF2.",
                )

        text_parts: list[str] = []
        metadata: dict[str, str | int | float] = {}

        with pdfplumber.open(file_path) as pdf:
            metadata["pages"] = len(pdf.pages)

            for i, page in enumerate(pdf.pages):
                page_text = page.extract_text() or ""
                if page_text:
                    text_parts.append(f"--- Page {i + 1} ---\n{page_text}")

                # Extract tables
                tables = page.extract_tables()
                for j, table in enumerate(tables):
                    if table:
                        table_text = self._format_table(table)
                        text_parts.append(f"\n[Table {j + 1} on page {i + 1}]\n{table_text}")

        content = "\n\n".join(text_parts)

        return FileContent(
            file_path=str(file_path),
            file_type="pdf",
            content=content[:self.max_content_length],
            metadata=metadata,
            success=True,
        )

    async def _read_pdf_pypdf2(self, file_path: Path) -> FileContent:
        """Fallback PDF reading with PyPDF2."""
        import PyPDF2

        text_parts: list[str] = []
        metadata: dict[str, str | int | float] = {}

        with open(file_path, "rb") as f:
            reader = PyPDF2.PdfReader(f)
            metadata["pages"] = len(reader.pages)

            for i, page in enumerate(reader.pages):
                page_text = page.extract_text() or ""
                if page_text:
                    text_parts.append(f"--- Page {i + 1} ---\n{page_text}")

        content = "\n\n".join(text_parts)

        return FileContent(
            file_path=str(file_path),
            file_type="pdf",
            content=content[:self.max_content_length],
            metadata=metadata,
            success=True,
        )

    async def read_excel(self, file_path: Path) -> FileContent:
        """Read Excel file."""
        try:
            import pandas as pd
        except ImportError:
            return FileContent(
                file_path=str(file_path),
                file_type="excel",
                content="",
                metadata={},
                success=False,
                error="pandas not installed. Install pandas and openpyxl.",
            )

        text_parts: list[str] = []
        metadata: dict[str, str | int | float] = {}

        # Read all sheets
        excel_file = pd.ExcelFile(file_path)
        metadata["sheets"] = len(excel_file.sheet_names)

        for sheet_name in excel_file.sheet_names:
            df = pd.read_excel(file_path, sheet_name=sheet_name)
            metadata[f"rows_{sheet_name}"] = len(df)
            metadata[f"cols_{sheet_name}"] = len(df.columns)

            # Convert to string representation
            text_parts.append(f"=== Sheet: {sheet_name} ===")
            text_parts.append(df.to_string(index=False))

        content = "\n\n".join(text_parts)

        return FileContent(
            file_path=str(file_path),
            file_type="excel",
            content=content[:self.max_content_length],
            metadata=metadata,
            success=True,
        )

    async def read_csv(self, file_path: Path) -> FileContent:
        """Read CSV file."""
        try:
            import pandas as pd
        except ImportError:
            # Fallback to basic CSV reading
            import csv

            rows: list[str] = []
            with open(file_path, encoding="utf-8") as f:
                reader = csv.reader(f)
                for row in reader:
                    rows.append(",".join(row))

            return FileContent(
                file_path=str(file_path),
                file_type="csv",
                content="\n".join(rows)[:self.max_content_length],
                metadata={"rows": len(rows)},
                success=True,
            )

        df = pd.read_csv(file_path)
        metadata: dict[str, str | int | float] = {
            "rows": len(df),
            "columns": len(df.columns),
        }

        content = df.to_string(index=False)

        return FileContent(
            file_path=str(file_path),
            file_type="csv",
            content=content[:self.max_content_length],
            metadata=metadata,
            success=True,
        )

    async def read_image(self, file_path: Path) -> FileContent:
        """Read and analyze image file."""
        try:
            from PIL import Image
        except ImportError:
            return FileContent(
                file_path=str(file_path),
                file_type="image",
                content="",
                metadata={},
                success=False,
                error="Pillow not installed. Install pillow.",
            )

        metadata: dict[str, str | int | float] = {}

        with Image.open(file_path) as img:
            metadata["format"] = img.format or "unknown"
            metadata["mode"] = img.mode
            metadata["width"] = img.width
            metadata["height"] = img.height

        # Try OCR if available
        ocr_text = await self._extract_text_from_image(file_path)

        content = f"Image: {file_path.name}\n"
        content += f"Dimensions: {metadata['width']}x{metadata['height']}\n"
        content += f"Format: {metadata['format']}\n"

        if ocr_text:
            content += f"\nExtracted text:\n{ocr_text}"

        return FileContent(
            file_path=str(file_path),
            file_type="image",
            content=content[:self.max_content_length],
            metadata=metadata,
            success=True,
        )

    async def _extract_text_from_image(self, file_path: Path) -> str:
        """Extract text from image using OCR."""
        try:
            import pytesseract
            from PIL import Image

            with Image.open(file_path) as img:
                text = pytesseract.image_to_string(img)
                return text.strip()
        except ImportError:
            logger.debug("pytesseract not installed, skipping OCR")
            return ""
        except Exception as e:
            logger.warning(f"OCR failed for {file_path}: {e}")
            return ""

    async def read_audio(self, file_path: Path) -> FileContent:
        """Read and transcribe audio file."""
        metadata: dict[str, str | int | float] = {
            "format": file_path.suffix.lower(),
        }

        # Try to get audio duration
        try:
            from mutagen import File as MutagenFile
            audio = MutagenFile(file_path)
            if audio and audio.info:
                metadata["duration_seconds"] = audio.info.length
        except ImportError:
            pass
        except Exception:
            pass

        # Transcription would require a speech-to-text service
        content = f"Audio file: {file_path.name}\n"
        content += f"Format: {metadata.get('format', 'unknown')}\n"

        if "duration_seconds" in metadata:
            duration = metadata["duration_seconds"]
            content += f"Duration: {duration:.1f} seconds\n"

        content += "\n[Audio transcription requires speech-to-text service]"

        return FileContent(
            file_path=str(file_path),
            file_type="audio",
            content=content,
            metadata=metadata,
            success=True,
        )

    async def read_json(self, file_path: Path) -> FileContent:
        """Read JSON file."""
        import json

        with open(file_path, encoding="utf-8") as f:
            data = json.load(f)

        content = json.dumps(data, indent=2, ensure_ascii=False)

        return FileContent(
            file_path=str(file_path),
            file_type="json",
            content=content[:self.max_content_length],
            metadata={"type": type(data).__name__},
            success=True,
        )

    async def read_text(self, file_path: Path) -> FileContent:
        """Read plain text file."""
        try:
            with open(file_path, encoding="utf-8") as f:
                content = f.read()
        except UnicodeDecodeError:
            with open(file_path, encoding="latin-1") as f:
                content = f.read()

        return FileContent(
            file_path=str(file_path),
            file_type=file_path.suffix.lower() or "text",
            content=content[:self.max_content_length],
            metadata={"size_bytes": file_path.stat().st_size},
            success=True,
        )

    def _format_table(self, table: list[list[str | None]]) -> str:
        """Format a table as a string.

        Args:
            table: 2D list of cell values (strings or None)

        Returns:
            Formatted table as a string with pipe separators
        """
        if not table:
            return ""

        # Calculate column widths
        col_widths: list[int] = []
        for row in table:
            for i, cell in enumerate(row):
                cell_str = str(cell) if cell is not None else ""
                if i >= len(col_widths):
                    col_widths.append(len(cell_str))
                else:
                    col_widths[i] = max(col_widths[i], len(cell_str))

        # Build table string
        lines: list[str] = []
        for row in table:
            cells: list[str] = []
            for i, cell in enumerate(row):
                cell_str = str(cell) if cell is not None else ""
                width = col_widths[i] if i < len(col_widths) else len(cell_str)
                cells.append(cell_str.ljust(width))
            lines.append(" | ".join(cells))

        return "\n".join(lines)

    def get_base64_image(self, file_path: Path) -> str:
        """Get base64 encoded image for vision model APIs."""
        with open(file_path, "rb") as f:
            return base64.b64encode(f.read()).decode("utf-8")
