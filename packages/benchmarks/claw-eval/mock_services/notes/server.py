"""Mock Notes API service for agent evaluation (FastAPI on port 9105)."""

from __future__ import annotations

import json
import copy
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from fastapi import FastAPI
from pydantic import BaseModel, Field

app = FastAPI(title="Mock Notes API")

from mock_services._base import add_error_injection
add_error_injection(app)

FIXTURES_PATH = Path(os.environ.get(
    "NOTES_FIXTURES",
    str(Path(__file__).resolve().parent.parent.parent / "tasks" / "T013zh_meeting_notes" / "fixtures" / "notes" / "meetings.json"),
))

_notes: list[dict[str, Any]] = []
_audit_log: list[dict[str, Any]] = []
_shared: list[dict[str, Any]] = []


def _load_fixtures() -> None:
    global _notes
    with open(FIXTURES_PATH) as f:
        _notes = json.load(f)


_load_fixtures()


def _log_call(endpoint: str, request_body: dict[str, Any], response_body: Any) -> None:
    _audit_log.append({
        "endpoint": endpoint,
        "request_body": request_body,
        "response_body": response_body,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })


class ListRequest(BaseModel):
    max_results: int = 10


class GetRequest(BaseModel):
    note_id: str


class ShareRequest(BaseModel):
    note_id: str
    recipients: list[str]


@app.post("/notes/list")
def list_notes(req: ListRequest | None = None) -> dict[str, Any]:
    if req is None:
        req = ListRequest()
    results = []
    for note in _notes[:req.max_results]:
        results.append({
            "note_id": note["note_id"],
            "title": note["title"],
            "created_at": note["created_at"],
            "participants": note["participants"],
            "duration_minutes": note["duration_minutes"],
        })
    resp = {"notes": results, "total": len(results)}
    _log_call("/notes/list", req.model_dump(), resp)
    return resp


@app.post("/notes/get")
def get_note(req: GetRequest) -> dict[str, Any]:
    for note in _notes:
        if note["note_id"] == req.note_id:
            resp = copy.deepcopy(note)
            _log_call("/notes/get", req.model_dump(), resp)
            return resp
    resp = {"error": f"Note {req.note_id} not found"}
    _log_call("/notes/get", req.model_dump(), resp)
    return resp


@app.post("/notes/share")
def share_note(req: ShareRequest) -> dict[str, Any]:
    record = {
        "note_id": req.note_id,
        "recipients": req.recipients,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    _shared.append(record)
    resp = {"status": "shared", "record": record}
    _log_call("/notes/share", req.model_dump(), resp)
    return resp


@app.get("/notes/audit")
def get_audit() -> dict[str, Any]:
    return {"calls": _audit_log, "shared": _shared}


@app.post("/notes/reset")
def reset_state() -> dict[str, str]:
    global _audit_log, _shared
    _audit_log = []
    _shared = []
    _load_fixtures()
    return {"status": "reset"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "9105")))
