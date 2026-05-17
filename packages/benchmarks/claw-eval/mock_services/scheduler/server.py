"""Mock Scheduler API service for agent evaluation (FastAPI on port 9112).

Manages cron/scheduled jobs with execution history tracking.
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

app = FastAPI(title="Mock Scheduler API")

from mock_services._base import add_error_injection

add_error_injection(app)

FIXTURES_PATH = Path(os.environ.get(
    "SCHEDULER_FIXTURES",
    str(Path(__file__).resolve().parent.parent.parent / "tasks" / "T041zh_scheduled_task_management" / "fixtures" / "scheduler" / "jobs.json"),
))

_jobs: list[dict[str, Any]] = []
_audit_log: list[dict[str, Any]] = []
_created_jobs: list[dict[str, Any]] = []
_updated_jobs: list[dict[str, Any]] = []
_deleted_jobs: list[dict[str, Any]] = []


def _load_fixtures() -> None:
    global _jobs
    with open(FIXTURES_PATH) as f:
        _jobs = json.load(f)


_load_fixtures()


def _log_call(endpoint: str, request_body: dict[str, Any], response_body: Any) -> None:
    _audit_log.append({
        "endpoint": endpoint,
        "request_body": request_body,
        "response_body": response_body,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })


class ListJobsRequest(BaseModel):
    status: str | None = None
    enabled: bool | None = None
    tag: str | None = None


class GetJobRequest(BaseModel):
    job_id: str


class CreateJobRequest(BaseModel):
    name: str
    cron_expression: str
    action: str
    enabled: bool = True
    tags: list[str] | None = None
    created_by: str | None = None


class UpdateJobRequest(BaseModel):
    job_id: str
    enabled: bool | None = None
    cron_expression: str | None = None
    name: str | None = None
    action: str | None = None
    tags: list[str] | None = None


class DeleteJobRequest(BaseModel):
    job_id: str


class JobHistoryRequest(BaseModel):
    job_id: str
    limit: int = 10


@app.post("/scheduler/jobs")
def list_jobs(req: ListJobsRequest | None = None) -> dict[str, Any]:
    if req is None:
        req = ListJobsRequest()
    results = []
    for j in _jobs:
        if req.status and j.get("last_status") != req.status:
            continue
        if req.enabled is not None and j.get("enabled") != req.enabled:
            continue
        if req.tag and req.tag not in j.get("tags", []):
            continue
        results.append({
            "job_id": j["job_id"],
            "name": j["name"],
            "cron_expression": j["cron_expression"],
            "enabled": j["enabled"],
            "last_status": j.get("last_status"),
            "last_run": j.get("last_run"),
            "next_run": j.get("next_run"),
            "tags": j.get("tags", []),
        })
    resp = {"jobs": results, "total": len(results)}
    _log_call("/scheduler/jobs", req.model_dump(), resp)
    return resp


@app.post("/scheduler/jobs/get")
def get_job(req: GetJobRequest) -> dict[str, Any]:
    for j in _jobs:
        if j["job_id"] == req.job_id:
            resp = copy.deepcopy(j)
            _log_call("/scheduler/jobs/get", req.model_dump(), resp)
            return resp
    resp = {"error": f"Job {req.job_id} not found"}
    _log_call("/scheduler/jobs/get", req.model_dump(), resp)
    return resp


@app.post("/scheduler/jobs/create")
def create_job(req: CreateJobRequest) -> dict[str, Any]:
    new_id = f"JOB-{len(_jobs) + 1:03d}"
    job = {
        "job_id": new_id,
        "name": req.name,
        "cron_expression": req.cron_expression,
        "action": req.action,
        "enabled": req.enabled,
        "last_run": None,
        "next_run": None,
        "last_status": None,
        "created_by": req.created_by,
        "tags": req.tags or [],
        "created_at": datetime.now(timezone.utc).isoformat(),
        "execution_history": [],
    }
    _jobs.append(job)
    _created_jobs.append(copy.deepcopy(job))
    resp = {"status": "created", "job": copy.deepcopy(job)}
    _log_call("/scheduler/jobs/create", req.model_dump(), resp)
    return resp


@app.post("/scheduler/jobs/update")
def update_job(req: UpdateJobRequest) -> dict[str, Any]:
    for j in _jobs:
        if j["job_id"] == req.job_id:
            if req.enabled is not None:
                j["enabled"] = req.enabled
            if req.cron_expression is not None:
                j["cron_expression"] = req.cron_expression
            if req.name is not None:
                j["name"] = req.name
            if req.action is not None:
                j["action"] = req.action
            if req.tags is not None:
                j["tags"] = req.tags
            updated = copy.deepcopy(j)
            _updated_jobs.append(updated)
            resp = {"status": "updated", "job": updated}
            _log_call("/scheduler/jobs/update", req.model_dump(), resp)
            return resp
    resp = {"error": f"Job {req.job_id} not found"}
    _log_call("/scheduler/jobs/update", req.model_dump(), resp)
    return resp


@app.post("/scheduler/jobs/delete")
def delete_job(req: DeleteJobRequest) -> dict[str, Any]:
    for i, j in enumerate(_jobs):
        if j["job_id"] == req.job_id:
            removed = _jobs.pop(i)
            _deleted_jobs.append(removed)
            resp = {"status": "deleted", "job": removed}
            _log_call("/scheduler/jobs/delete", req.model_dump(), resp)
            return resp
    resp = {"error": f"Job {req.job_id} not found"}
    _log_call("/scheduler/jobs/delete", req.model_dump(), resp)
    return resp


@app.post("/scheduler/jobs/history")
def job_history(req: JobHistoryRequest) -> dict[str, Any]:
    for j in _jobs:
        if j["job_id"] == req.job_id:
            history = j.get("execution_history", [])
            limited = history[:req.limit]
            resp = {"job_id": req.job_id, "history": limited, "total": len(history)}
            _log_call("/scheduler/jobs/history", req.model_dump(), resp)
            return resp
    resp = {"error": f"Job {req.job_id} not found"}
    _log_call("/scheduler/jobs/history", req.model_dump(), resp)
    return resp


@app.get("/scheduler/audit")
def get_audit() -> dict[str, Any]:
    return {
        "calls": _audit_log,
        "created_jobs": _created_jobs,
        "updated_jobs": _updated_jobs,
        "deleted_jobs": _deleted_jobs,
    }


@app.post("/scheduler/reset")
def reset_state() -> dict[str, str]:
    global _audit_log, _created_jobs, _updated_jobs, _deleted_jobs
    _audit_log = []
    _created_jobs = []
    _updated_jobs = []
    _deleted_jobs = []
    _load_fixtures()
    return {"status": "reset"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "9112")))
