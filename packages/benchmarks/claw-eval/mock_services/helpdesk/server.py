"""Mock Helpdesk API service for agent evaluation (FastAPI on port 9107)."""

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

app = FastAPI(title="Mock Helpdesk API")

from mock_services._base import add_error_injection
add_error_injection(app)

FIXTURES_PATH = Path(os.environ.get(
    "HELPDESK_FIXTURES",
    str(Path(__file__).resolve().parent.parent.parent / "tasks" / "T017zh_ticket_triage" / "fixtures" / "helpdesk" / "tickets.json"),
))

_tickets: list[dict[str, Any]] = []
_audit_log: list[dict[str, Any]] = []
_closed: list[dict[str, Any]] = []
_updated_tickets: list[dict[str, Any]] = []


def _load_fixtures() -> None:
    global _tickets
    with open(FIXTURES_PATH) as f:
        _tickets = json.load(f)


_load_fixtures()


def _log_call(endpoint: str, request_body: dict[str, Any], response_body: Any) -> None:
    _audit_log.append({
        "endpoint": endpoint,
        "request_body": request_body,
        "response_body": response_body,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })


class ListTicketsRequest(BaseModel):
    status: str = "open"


class GetTicketRequest(BaseModel):
    ticket_id: str


class UpdateTicketRequest(BaseModel):
    ticket_id: str
    priority: str | None = None
    tags: list[str] | None = None
    category: str | None = None


class CloseTicketRequest(BaseModel):
    ticket_id: str
    resolution: str


@app.post("/helpdesk/tickets")
def list_tickets(req: ListTicketsRequest | None = None) -> dict[str, Any]:
    if req is None:
        req = ListTicketsRequest()
    results = []
    for t in _tickets:
        if req.status == "all" or t["status"] == req.status:
            results.append({
                "ticket_id": t["ticket_id"],
                "title": t["title"],
                "reporter": t["reporter"],
                "department": t["department"],
                "priority": t["priority"],
                "status": t["status"],
                "created_at": t["created_at"],
            })
    resp = {"tickets": results, "total": len(results)}
    _log_call("/helpdesk/tickets", req.model_dump(), resp)
    return resp


@app.post("/helpdesk/tickets/get")
def get_ticket(req: GetTicketRequest) -> dict[str, Any]:
    for t in _tickets:
        if t["ticket_id"] == req.ticket_id:
            resp = copy.deepcopy(t)
            _log_call("/helpdesk/tickets/get", req.model_dump(), resp)
            return resp
    resp = {"error": f"Ticket {req.ticket_id} not found"}
    _log_call("/helpdesk/tickets/get", req.model_dump(), resp)
    return resp


@app.post("/helpdesk/tickets/update")
def update_ticket(req: UpdateTicketRequest) -> dict[str, Any]:
    for t in _tickets:
        if t["ticket_id"] == req.ticket_id:
            if req.priority is not None:
                t["priority"] = req.priority
            if req.tags is not None:
                t["tags"] = req.tags
            if req.category is not None:
                t["category"] = req.category
            updated = copy.deepcopy(t)
            _updated_tickets.append(updated)
            resp = {"status": "updated", "ticket": updated}
            _log_call("/helpdesk/tickets/update", req.model_dump(), resp)
            return resp
    resp = {"error": f"Ticket {req.ticket_id} not found"}
    _log_call("/helpdesk/tickets/update", req.model_dump(), resp)
    return resp


@app.post("/helpdesk/tickets/close")
def close_ticket(req: CloseTicketRequest) -> dict[str, Any]:
    for t in _tickets:
        if t["ticket_id"] == req.ticket_id:
            t["status"] = "closed"
            t["resolution"] = req.resolution
            _closed.append(copy.deepcopy(t))
            resp = {"status": "closed", "ticket": copy.deepcopy(t)}
            _log_call("/helpdesk/tickets/close", req.model_dump(), resp)
            return resp
    resp = {"error": f"Ticket {req.ticket_id} not found"}
    _log_call("/helpdesk/tickets/close", req.model_dump(), resp)
    return resp


@app.get("/helpdesk/audit")
def get_audit() -> dict[str, Any]:
    return {"calls": _audit_log, "closed": _closed, "updated_tickets": _updated_tickets}


@app.post("/helpdesk/reset")
def reset_state() -> dict[str, str]:
    global _audit_log, _closed, _updated_tickets
    _audit_log = []
    _closed = []
    _updated_tickets = []
    _load_fixtures()
    return {"status": "reset"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "9107")))
