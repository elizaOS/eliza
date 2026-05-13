"""Mock OCR service — returns pre-loaded text from task fixtures.

Port: 9116
Endpoints:
  POST /ocr/extract   — return OCR text for the given image
  GET  /ocr/health    — health check
  POST /ocr/reset     — reset state
  GET  /ocr/audit     — return call log
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from pydantic import BaseModel

# ── Error injection ──────────────────────────────────────────────────
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))
from mock_services._base import add_error_injection

app = FastAPI(title="Mock OCR API")
add_error_injection(app)

# ── Fixture loading ──────────────────────────────────────────────────
_FIXTURE_DIR = os.environ.get("OCR_FIXTURES", "")
_OCR_FILENAME = os.environ.get("OCR_FILENAME", "menu_ocr.txt")
# Multi-file mode: comma-separated filenames (e.g. "file1.txt,file2.txt")
_OCR_FILENAMES = os.environ.get("OCR_FILENAMES", "")
_ocr_text: str = ""
_call_log: list[dict] = []


def _load_fixtures():
    global _ocr_text
    if _FIXTURE_DIR:
        # Multi-file mode: concatenate files with document separators
        if _OCR_FILENAMES:
            parts: list[str] = []
            for i, fname in enumerate(_OCR_FILENAMES.split(","), 1):
                fname = fname.strip()
                ocr_file = Path(_FIXTURE_DIR) / "ocr" / fname
                if ocr_file.exists():
                    parts.append(
                        f"--- Document {i}: {fname} ---\n"
                        + ocr_file.read_text(encoding="utf-8")
                    )
            if parts:
                _ocr_text = "\n\n".join(parts)
                return
        # Single-file mode
        ocr_file = Path(_FIXTURE_DIR) / "ocr" / _OCR_FILENAME
        if ocr_file.exists():
            _ocr_text = ocr_file.read_text(encoding="utf-8")
            return
    # Fallback: look in the default task fixture location
    default_path = Path(__file__).resolve().parents[2] / "tasks" / "T072_restaurant_menu_contact" / "fixtures" / "ocr" / "menu_ocr.txt"
    if default_path.exists():
        _ocr_text = default_path.read_text(encoding="utf-8")


_load_fixtures()


# ── Request / Response models ────────────────────────────────────────
class OCRExtractRequest(BaseModel):
    image_path: str = ""


class OCRExtractResponse(BaseModel):
    text: str
    confidence: float = 0.95
    language: str = "mixed"


# ── Endpoints ────────────────────────────────────────────────────────
@app.post("/ocr/extract", response_model=OCRExtractResponse)
async def ocr_extract(req: OCRExtractRequest):
    _call_log.append({
        "endpoint": "/ocr/extract",
        "request_body": req.model_dump(),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })
    return OCRExtractResponse(text=_ocr_text)


@app.get("/ocr/health")
async def health():
    return {"status": "ok", "service": "ocr"}


@app.post("/ocr/reset")
async def reset():
    global _call_log
    _call_log = []
    _load_fixtures()
    return {"status": "reset"}


@app.get("/ocr/audit")
async def audit():
    return {"calls": _call_log}


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "9116"))
    uvicorn.run(app, host="0.0.0.0", port=port)
