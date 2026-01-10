"""
OCR Service
Text extraction from images with fallback support
"""

from __future__ import annotations

import logging
from io import BytesIO

from PIL import Image

from .types import BoundingBox, OCRBlock, OCRResult, ScreenTile

logger = logging.getLogger(__name__)


class OCRService:
    """OCR service for text extraction"""

    def __init__(self):
        self._initialized = False
        self._tesseract_available = False

    async def initialize(self) -> None:
        """Initialize the OCR service"""
        if self._initialized:
            return

        logger.info("[OCR] Initializing OCR service...")

        # Try to import pytesseract
        try:
            import pytesseract

            # Test if Tesseract is available
            pytesseract.get_tesseract_version()
            self._tesseract_available = True
            logger.info("[OCR] Tesseract OCR available")
        except Exception as e:
            logger.warning(f"[OCR] Tesseract not available: {e}")
            self._tesseract_available = False

        self._initialized = True
        logger.info("[OCR] OCR service initialized")

    async def extract_text(self, image_data: bytes) -> OCRResult:
        """Extract text from image data"""
        if not self._initialized:
            await self.initialize()

        if self._tesseract_available:
            try:
                return await self._tesseract_ocr(image_data)
            except Exception as e:
                logger.error(f"[OCR] Tesseract OCR failed: {e}")

        return self._fallback_ocr()

    async def extract_from_tile(self, tile: ScreenTile) -> OCRResult:
        """Extract text from a screen tile"""
        if not tile.data:
            return OCRResult(text="", blocks=[], full_text="")
        return await self.extract_text(tile.data)

    async def extract_from_image(self, image_data: bytes) -> OCRResult:
        """Extract text from image data"""
        return await self.extract_text(image_data)

    async def _tesseract_ocr(self, image_data: bytes) -> OCRResult:
        """Perform OCR using Tesseract"""
        import pytesseract

        # Load image
        img = Image.open(BytesIO(image_data))

        # Get detailed OCR data
        data = pytesseract.image_to_data(img, output_type=pytesseract.Output.DICT)

        blocks: list[OCRBlock] = []
        current_block: list[str] = []
        current_block_bbox: BoundingBox | None = None

        for i, text in enumerate(data["text"]):
            if text.strip():
                conf = float(data["conf"][i])
                if conf > 0:
                    x = data["left"][i]
                    y = data["top"][i]
                    w = data["width"][i]
                    h = data["height"][i]

                    if current_block_bbox is None:
                        current_block_bbox = BoundingBox(x=x, y=y, width=w, height=h)
                    else:
                        # Expand bounding box
                        min_x = min(current_block_bbox.x, x)
                        min_y = min(current_block_bbox.y, y)
                        max_x = max(
                            current_block_bbox.x + current_block_bbox.width, x + w
                        )
                        max_y = max(
                            current_block_bbox.y + current_block_bbox.height, y + h
                        )
                        current_block_bbox = BoundingBox(
                            x=min_x,
                            y=min_y,
                            width=max_x - min_x,
                            height=max_y - min_y,
                        )

                    current_block.append(text)
            else:
                if current_block and current_block_bbox:
                    blocks.append(
                        OCRBlock(
                            text=" ".join(current_block),
                            bbox=current_block_bbox,
                            confidence=0.9,
                        )
                    )
                    current_block = []
                    current_block_bbox = None

        # Don't forget the last block
        if current_block and current_block_bbox:
            blocks.append(
                OCRBlock(
                    text=" ".join(current_block),
                    bbox=current_block_bbox,
                    confidence=0.9,
                )
            )

        full_text = "\n".join(b.text for b in blocks)

        return OCRResult(text=full_text, blocks=blocks, full_text=full_text)

    def _fallback_ocr(self) -> OCRResult:
        """Fallback OCR implementation when Tesseract is not available"""
        logger.debug("[OCR] Using fallback OCR implementation")
        return OCRResult(text="", blocks=[], full_text="")

    async def extract_structured_data(
        self, image_data: bytes
    ) -> dict[str, list[dict]]:
        """Extract structured data (tables, forms, lists)"""
        # Placeholder for structured data extraction
        return {
            "tables": [],
            "forms": [],
            "lists": [],
        }

    def is_initialized(self) -> bool:
        """Check if the service is initialized"""
        return self._initialized

    async def dispose(self) -> None:
        """Dispose of resources"""
        self._initialized = False
        logger.info("[OCR] Service disposed")

