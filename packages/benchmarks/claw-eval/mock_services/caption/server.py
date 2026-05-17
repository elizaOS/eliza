"""Mock Caption service — returns pre-loaded image caption from task fixtures.

Port: 9118
Endpoints:
  POST /caption/describe   — return caption text for the given image
  GET  /caption/health     — health check
  POST /caption/reset      — reset state
  GET  /caption/audit      — return call log
"""

from __future__ import annotations

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

app = FastAPI(title="Mock Caption API")
add_error_injection(app)

# ── Fixture loading ──────────────────────────────────────────────────
_FIXTURE_DIR = os.environ.get("CAPTION_FIXTURES", "")
_caption_text: str = ""
_call_log: list[dict] = []


def _load_fixtures():
    global _caption_text
    if _FIXTURE_DIR:
        caption_file = Path(_FIXTURE_DIR) / "caption.txt"
        if caption_file.exists():
            _caption_text = caption_file.read_text(encoding="utf-8")
            return
    _caption_text = ""


_load_fixtures()


# ── Request / Response models ────────────────────────────────────────
class CaptionRequest(BaseModel):
    image_path: str = ""


class CaptionResponse(BaseModel):
    caption: str
    confidence: float = 0.92


# ── Endpoints ────────────────────────────────────────────────────────
@app.post("/caption/describe", response_model=CaptionResponse)
async def caption_describe(req: CaptionRequest):
    _call_log.append({
        "endpoint": "/caption/describe",
        "request_body": req.model_dump(),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })
    return CaptionResponse(caption=_caption_text)


@app.get("/caption/health")
async def health():
    return {"status": "ok", "service": "caption"}


@app.post("/caption/reset")
async def reset():
    global _call_log
    _call_log = []
    _load_fixtures()
    return {"status": "reset"}


@app.get("/caption/audit")
async def audit():
    return {"calls": _call_log}


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "9118"))
    uvicorn.run(app, host="0.0.0.0", port=port)
