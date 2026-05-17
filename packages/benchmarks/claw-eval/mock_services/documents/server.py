"""Mock document parsing API service for agent evaluation (FastAPI on port 9115)."""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from pypdf import PdfReader

from mock_services._base import add_error_injection

app = FastAPI(title="Mock Documents API")
add_error_injection(app)

BASE_DIR = Path(os.environ.get("DOCUMENTS_BASE_DIR", str(Path.cwd()))).resolve()

_audit_log: list[dict[str, Any]] = []


def _log_call(endpoint: str, request_body: dict[str, Any], response_body: Any) -> None:
    _audit_log.append({
        "endpoint": endpoint,
        "request_body": request_body,
        "response_body": response_body,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })


def _resolve_path(raw_path: str) -> Path:
    candidate = Path(raw_path)
    resolved = candidate.resolve() if candidate.is_absolute() else (BASE_DIR / candidate).resolve()
    if not resolved.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {raw_path}")
    try:
        resolved.relative_to(BASE_DIR)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Path escapes base directory: {raw_path}") from exc
    return resolved


class ExtractTextRequest(BaseModel):
    path: str
    max_pages: int | None = None


@app.get("/documents/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/documents/extract_text")
def extract_text(req: ExtractTextRequest) -> dict[str, Any]:
    resolved = _resolve_path(req.path)
    if resolved.suffix.lower() != ".pdf":
        raise HTTPException(status_code=400, detail="Only PDF files are supported")

    reader = PdfReader(str(resolved))
    page_limit = min(req.max_pages or len(reader.pages), len(reader.pages))
    page_texts: list[str] = []
    for page in reader.pages[:page_limit]:
        page_texts.append(page.extract_text() or "")

    text = "\n\n".join(page_texts).strip()
    resp = {
        "path": str(resolved.relative_to(BASE_DIR)),
        "page_count": len(reader.pages),
        "pages_returned": page_limit,
        "text": text,
    }
    _log_call("/documents/extract_text", req.model_dump(), {
        "path": resp["path"],
        "page_count": resp["page_count"],
        "pages_returned": resp["pages_returned"],
        "text_length": len(text),
    })
    return resp


@app.get("/documents/audit")
def get_audit() -> dict[str, Any]:
    return {"calls": _audit_log}


@app.post("/documents/reset")
def reset_state() -> dict[str, str]:
    global _audit_log
    _audit_log = []
    return {"status": "reset"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "9119")))
