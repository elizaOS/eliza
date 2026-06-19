"""Mock CRM API service for agent evaluation (FastAPI on port 9110).

This service is designed for error-recovery testing: the task YAML sets
ERROR_RATE=0.5 so roughly half of tool calls will fail with 429/500.
The agent must retry to complete the data export.
"""

from __future__ import annotations

import copy
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="Mock CRM API")

from mock_services._base import add_error_injection

add_error_injection(app)

FIXTURES_PATH = Path(os.environ.get(
    "CRM_FIXTURES",
    str(Path(__file__).resolve().parent.parent.parent / "tasks" / "T023zh_crm_data_export" / "fixtures" / "crm" / "customers.json"),
))

_customers: list[dict[str, Any]] = []
_audit_log: list[dict[str, Any]] = []
_exported_reports: list[dict[str, Any]] = []


def _load_fixtures() -> None:
    global _customers
    with open(FIXTURES_PATH) as f:
        _customers = json.load(f)


_load_fixtures()


def _log_call(endpoint: str, request_body: dict[str, Any], response_body: Any) -> None:
    _audit_log.append({
        "endpoint": endpoint,
        "request_body": request_body,
        "response_body": response_body,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })


class ListCustomersRequest(BaseModel):
    status: str | None = None
    tier: str | None = None
    industry: str | None = None


class GetCustomerRequest(BaseModel):
    customer_id: str


class ExportReportRequest(BaseModel):
    title: str
    customer_ids: list[str]
    summary: str


@app.post("/crm/customers")
def list_customers(req: ListCustomersRequest | None = None) -> dict[str, Any]:
    if req is None:
        req = ListCustomersRequest()
    results = []
    for c in _customers:
        if req.status and c["status"] != req.status:
            continue
        if req.tier and c["tier"] != req.tier:
            continue
        if req.industry and c["industry"] != req.industry:
            continue
        results.append({
            "customer_id": c["customer_id"],
            "name": c["name"],
            "contact_person": c["contact_person"],
            "tier": c["tier"],
            "status": c["status"],
            "industry": c["industry"],
            "annual_revenue": c["annual_revenue"],
        })
    resp = {"customers": results, "total": len(results)}
    _log_call("/crm/customers", req.model_dump(), resp)
    return resp


@app.post("/crm/customers/get")
def get_customer(req: GetCustomerRequest) -> dict[str, Any]:
    for c in _customers:
        if c["customer_id"] == req.customer_id:
            resp = copy.deepcopy(c)
            _log_call("/crm/customers/get", req.model_dump(), resp)
            return resp
    resp = {"error": f"Customer {req.customer_id} not found"}
    _log_call("/crm/customers/get", req.model_dump(), resp)
    return resp


@app.post("/crm/export")
def export_report(req: ExportReportRequest) -> dict[str, Any]:
    report = {
        "title": req.title,
        "customer_ids": req.customer_ids,
        "summary": req.summary,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    _exported_reports.append(report)
    resp = {"status": "exported", "report": report}
    _log_call("/crm/export", req.model_dump(), resp)
    return resp


@app.get("/crm/audit")
def get_audit() -> dict[str, Any]:
    return {"calls": _audit_log, "exported_reports": _exported_reports}


@app.post("/crm/reset")
def reset_state() -> dict[str, str]:
    global _audit_log, _exported_reports
    _audit_log = []
    _exported_reports = []
    _load_fixtures()
    return {"status": "reset"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "9110")))
