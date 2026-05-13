"""Mock Contacts API service for agent evaluation (FastAPI on port 9103)."""

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
from pydantic import BaseModel

app = FastAPI(title="Mock Contacts API")

from mock_services._base import add_error_injection
add_error_injection(app)

FIXTURES_PATH = Path(os.environ.get(
    "CONTACTS_FIXTURES",
    str(Path(__file__).resolve().parent.parent.parent / "tasks" / "T009zh_contact_lookup" / "fixtures" / "contacts" / "contacts.json"),
))

_contacts: list[dict[str, Any]] = []
_audit_log: list[dict[str, Any]] = []
_sent_messages: list[dict[str, Any]] = []


def _load_fixtures() -> None:
    global _contacts
    with open(FIXTURES_PATH) as f:
        _contacts = json.load(f)


_load_fixtures()


def _log_call(endpoint: str, request_body: dict[str, Any], response_body: Any) -> None:
    _audit_log.append({
        "endpoint": endpoint,
        "request_body": request_body,
        "response_body": response_body,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })


class SearchRequest(BaseModel):
    query: str
    department: str | None = None


class GetRequest(BaseModel):
    contact_id: str


class SendMessageRequest(BaseModel):
    contact_id: str
    message: str


@app.post("/contacts/search")
def search_contacts(req: SearchRequest) -> dict[str, Any]:
    results = []
    for c in _contacts:
        name_match = req.query in c["name"]
        dept_match = req.department is None or req.department in c["department"]
        if name_match and dept_match:
            results.append(copy.deepcopy(c))
    resp = {"contacts": results, "total": len(results)}
    _log_call("/contacts/search", req.model_dump(), resp)
    return resp


@app.post("/contacts/get")
def get_contact(req: GetRequest) -> dict[str, Any]:
    for c in _contacts:
        if c["contact_id"] == req.contact_id:
            resp = copy.deepcopy(c)
            _log_call("/contacts/get", req.model_dump(), resp)
            return resp
    resp = {"error": f"Contact {req.contact_id} not found"}
    _log_call("/contacts/get", req.model_dump(), resp)
    return resp


@app.post("/contacts/send_message")
def send_message(req: SendMessageRequest) -> dict[str, Any]:
    record = {
        "contact_id": req.contact_id,
        "message": req.message,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    _sent_messages.append(record)
    resp = {"status": "sent", "record": record}
    _log_call("/contacts/send_message", req.model_dump(), resp)
    return resp


@app.get("/contacts/audit")
def get_audit() -> dict[str, Any]:
    return {"calls": _audit_log, "sent_messages": _sent_messages}


@app.post("/contacts/reset")
def reset_state() -> dict[str, str]:
    global _audit_log, _sent_messages
    _audit_log = []
    _sent_messages = []
    _load_fixtures()
    return {"status": "reset"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "9103")))
