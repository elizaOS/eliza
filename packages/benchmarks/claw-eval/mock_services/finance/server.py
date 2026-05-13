"""Mock Finance API service for agent evaluation (FastAPI on port 9104)."""

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

app = FastAPI(title="Mock Finance API")

from mock_services._base import add_error_injection
add_error_injection(app)

FIXTURES_PATH = Path(os.environ.get(
    "FINANCE_FIXTURES",
    str(Path(__file__).resolve().parent.parent.parent / "tasks" / "T011zh_expense_report" / "fixtures" / "finance" / "transactions.json"),
))

_transactions: list[dict[str, Any]] = []
_audit_log: list[dict[str, Any]] = []
_submitted_reports: list[dict[str, Any]] = []


def _load_fixtures() -> None:
    global _transactions
    with open(FIXTURES_PATH) as f:
        _transactions = json.load(f)


_load_fixtures()


def _log_call(endpoint: str, request_body: dict[str, Any], response_body: Any) -> None:
    _audit_log.append({
        "endpoint": endpoint,
        "request_body": request_body,
        "response_body": response_body,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })


class ListTransactionsRequest(BaseModel):
    start_date: str | None = None
    end_date: str | None = None


class GetTransactionRequest(BaseModel):
    transaction_id: str


class SubmitReportRequest(BaseModel):
    title: str
    transactions: list[str]
    total_amount: float


@app.post("/finance/transactions")
def list_transactions(req: ListTransactionsRequest | None = None) -> dict[str, Any]:
    if req is None:
        req = ListTransactionsRequest()
    results = []
    for t in _transactions:
        if req.start_date and t["date"] < req.start_date:
            continue
        if req.end_date and t["date"] > req.end_date:
            continue
        results.append(copy.deepcopy(t))
    resp = {"transactions": results, "total": len(results)}
    _log_call("/finance/transactions", req.model_dump(), resp)
    return resp


@app.post("/finance/transactions/get")
def get_transaction(req: GetTransactionRequest) -> dict[str, Any]:
    for t in _transactions:
        if t["transaction_id"] == req.transaction_id:
            resp = copy.deepcopy(t)
            _log_call("/finance/transactions/get", req.model_dump(), resp)
            return resp
    resp = {"error": f"Transaction {req.transaction_id} not found"}
    _log_call("/finance/transactions/get", req.model_dump(), resp)
    return resp


@app.post("/finance/report/submit")
def submit_report(req: SubmitReportRequest) -> dict[str, Any]:
    report = {
        "title": req.title,
        "transactions": req.transactions,
        "total_amount": req.total_amount,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    _submitted_reports.append(report)
    resp = {"status": "submitted", "report": report}
    _log_call("/finance/report/submit", req.model_dump(), resp)
    return resp


@app.get("/finance/audit")
def get_audit() -> dict[str, Any]:
    return {"calls": _audit_log, "submitted_reports": _submitted_reports}


@app.post("/finance/reset")
def reset_state() -> dict[str, str]:
    global _audit_log, _submitted_reports
    _audit_log = []
    _submitted_reports = []
    _load_fixtures()
    return {"status": "reset"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "9104")))
