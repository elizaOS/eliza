"""Mock Gmail API service for agent evaluation (FastAPI on port 9100)."""

from __future__ import annotations

import json
import copy
import os
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from fastapi import FastAPI
from pydantic import BaseModel, Field

app = FastAPI(title="Mock Gmail API")

from mock_services._base import add_error_injection
add_error_injection(app)

FIXTURES_PATH = Path(os.environ.get(
    "GMAIL_FIXTURES",
    str(Path(__file__).resolve().parent.parent.parent / "tasks" / "T001zh_email_triage" / "fixtures" / "gmail" / "inbox.json"),
))

# In-memory state
_emails: list[dict[str, Any]] = []
_audit_log: list[dict[str, Any]] = []
_sent_messages: list[dict[str, Any]] = []
_drafts: list[dict[str, Any]] = []


def _load_fixtures() -> None:
    """Load email fixtures and shift dates so the newest email is ~1 day ago.

    Fixture dates are absolute (e.g. 2026-02-27) and become stale as time
    passes.  We compute the offset between the newest fixture date and "now"
    and shift every email forward by that amount so the agent always sees
    recent mail with the default ``days_back=7`` window.

    When MOCK_TODAY is set, fixtures are already at correct dates — don't shift.
    """
    global _emails
    with open(FIXTURES_PATH) as f:
        _emails = json.load(f)

    if not _emails:
        return

    # When MOCK_TODAY is set, fixtures are already at correct dates — don't shift
    if os.environ.get("MOCK_TODAY"):
        return

    # Find the newest date in the fixtures
    dates = []
    for e in _emails:
        dates.append(datetime.fromisoformat(e["date"].replace("Z", "+00:00")))
    newest = max(dates)

    # Shift so the newest email is ~1 day ago
    target = datetime.now(timezone.utc) - timedelta(days=1)
    delta = target - newest

    for e in _emails:
        old_dt = datetime.fromisoformat(e["date"].replace("Z", "+00:00"))
        new_dt = old_dt + delta
        e["date"] = new_dt.strftime("%Y-%m-%dT%H:%M:%SZ")


# Load on startup
_load_fixtures()


def _log_call(endpoint: str, request_body: dict[str, Any], response_body: Any) -> None:
    _audit_log.append({
        "endpoint": endpoint,
        "request_body": request_body,
        "response_body": response_body,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })


# --- Request/Response models ---


class ListMessagesRequest(BaseModel):
    days_back: int = 7
    max_results: int = 20


class GetMessageRequest(BaseModel):
    message_id: str


class SendMessageRequest(BaseModel):
    to: str
    subject: str
    body: str


class SaveDraftRequest(BaseModel):
    to: str
    subject: str
    body: str
    reply_to_message_id: str | None = None


# --- Endpoints ---


@app.post("/gmail/messages")
def list_messages(req: ListMessagesRequest | None = None) -> dict[str, Any]:
    """List emails from inbox, filtered by recency."""
    if req is None:
        req = ListMessagesRequest()

    mock_today = os.environ.get("MOCK_TODAY")
    if mock_today:
        # MOCK_TODAY set: no offset was applied, use MOCK_TODAY as reference
        now = datetime.fromisoformat(mock_today + "T23:59:59+00:00")
    else:
        # No MOCK_TODAY: offset was applied, datetime.now() works correctly
        now = datetime.now(timezone.utc)

    cutoff = now - timedelta(days=req.days_back)
    results = []
    for email in _emails:
        email_date = datetime.fromisoformat(email["date"].replace("Z", "+00:00"))
        if email_date >= cutoff:
            results.append({
                "message_id": email["message_id"],
                "from": email["from"],
                "subject": email["subject"],
                "date": email["date"],
                "is_read": email["is_read"],
                "labels": email["labels"],
            })
    results = results[: req.max_results]

    resp = {"messages": results, "total": len(results)}
    _log_call("/gmail/messages", req.model_dump(), resp)
    return resp


@app.post("/gmail/messages/get")
def get_message(req: GetMessageRequest) -> dict[str, Any]:
    """Get a single email by message_id."""
    for email in _emails:
        if email["message_id"] == req.message_id:
            resp = copy.deepcopy(email)
            _log_call("/gmail/messages/get", req.model_dump(), resp)
            return resp

    resp = {"error": f"Message {req.message_id} not found"}
    _log_call("/gmail/messages/get", req.model_dump(), resp)
    return resp


@app.post("/gmail/send")
def send_message(req: SendMessageRequest) -> dict[str, Any]:
    """Send an email (recorded for audit)."""
    msg = {
        "to": req.to,
        "subject": req.subject,
        "body": req.body,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    _sent_messages.append(msg)
    resp = {"status": "sent", "message": msg}
    _log_call("/gmail/send", req.model_dump(), resp)
    return resp


@app.post("/gmail/drafts/save")
def save_draft(req: SaveDraftRequest) -> dict[str, Any]:
    """Save an email as draft (not sent)."""
    draft = {
        "to": req.to,
        "subject": req.subject,
        "body": req.body,
        "reply_to_message_id": req.reply_to_message_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    _drafts.append(draft)
    resp = {"status": "draft_saved", "draft": draft}
    _log_call("/gmail/drafts/save", req.model_dump(), resp)
    return resp


@app.get("/gmail/audit")
def get_audit() -> dict[str, Any]:
    """Return all API calls for grader inspection."""
    return {
        "calls": _audit_log,
        "sent_messages": _sent_messages,
        "drafts": _drafts,
    }


@app.post("/gmail/reset")
def reset_state() -> dict[str, str]:
    """Reset state between trials."""
    global _audit_log, _sent_messages, _drafts
    _audit_log = []
    _sent_messages = []
    _drafts = []
    _load_fixtures()
    return {"status": "reset"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "9100")))
