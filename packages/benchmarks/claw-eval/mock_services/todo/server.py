"""Mock Todo API service for agent evaluation (FastAPI on port 9102)."""

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

app = FastAPI(title="Mock Todo API")

from mock_services._base import add_error_injection
add_error_injection(app)

FIXTURES_PATH = Path(os.environ.get(
    "TODO_FIXTURES",
    str(Path(__file__).resolve().parent.parent.parent / "tasks" / "T007zh_todo_management" / "fixtures" / "todo" / "tasks.json"),
))

_tasks: list[dict[str, Any]] = []
_audit_log: list[dict[str, Any]] = []
_deleted: list[dict[str, Any]] = []
_updated_tasks: list[dict[str, Any]] = []


def _load_fixtures() -> None:
    global _tasks
    with open(FIXTURES_PATH) as f:
        _tasks = json.load(f)


_load_fixtures()


def _log_call(endpoint: str, request_body: dict[str, Any], response_body: Any) -> None:
    _audit_log.append({
        "endpoint": endpoint,
        "request_body": request_body,
        "response_body": response_body,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })


class ListTasksRequest(BaseModel):
    status: str = "all"


class UpdateTaskRequest(BaseModel):
    task_id: str
    title: str | None = None
    priority: str | None = None
    status: str | None = None
    tags: list[str] | None = None


class CreateTaskRequest(BaseModel):
    title: str
    description: str | None = None
    priority: str = "medium"
    due_date: str | None = None


class DeleteTaskRequest(BaseModel):
    task_id: str


class GetTaskRequest(BaseModel):
    task_id: str


@app.post("/todo/tasks")
def list_tasks(req: ListTasksRequest | None = None) -> dict[str, Any]:
    if req is None:
        req = ListTasksRequest()
    results = []
    for t in _tasks:
        if req.status == "all" or t["status"] == req.status:
            results.append(copy.deepcopy(t))
    resp = {"tasks": results, "total": len(results)}
    _log_call("/todo/tasks", req.model_dump(), resp)
    return resp


@app.post("/todo/tasks/get")
def get_task(req: GetTaskRequest) -> dict[str, Any]:
    for t in _tasks:
        if t["task_id"] == req.task_id:
            resp = copy.deepcopy(t)
            _log_call("/todo/tasks/get", req.model_dump(), resp)
            return resp
    resp = {"error": f"Task {req.task_id} not found"}
    _log_call("/todo/tasks/get", req.model_dump(), resp)
    return resp


@app.post("/todo/tasks/update")
def update_task(req: UpdateTaskRequest) -> dict[str, Any]:
    for t in _tasks:
        if t["task_id"] == req.task_id:
            if req.title is not None:
                t["title"] = req.title
            if req.priority is not None:
                t["priority"] = req.priority
            if req.status is not None:
                t["status"] = req.status
            if req.tags is not None:
                t["tags"] = req.tags
            updated = copy.deepcopy(t)
            _updated_tasks.append(updated)
            resp = {"status": "updated", "task": updated}
            _log_call("/todo/tasks/update", req.model_dump(), resp)
            return resp
    resp = {"error": f"Task {req.task_id} not found"}
    _log_call("/todo/tasks/update", req.model_dump(), resp)
    return resp


@app.post("/todo/tasks/create")
def create_task(req: CreateTaskRequest) -> dict[str, Any]:
    new_id = f"todo_{len(_tasks) + 1:03d}"
    task = {
        "task_id": new_id,
        "title": req.title,
        "description": req.description or "",
        "status": "pending",
        "priority": req.priority,
        "due_date": req.due_date,
        "tags": [],
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    _tasks.append(task)
    resp = {"status": "created", "task": task}
    _log_call("/todo/tasks/create", req.model_dump(), resp)
    return resp


@app.post("/todo/tasks/delete")
def delete_task(req: DeleteTaskRequest) -> dict[str, Any]:
    for i, t in enumerate(_tasks):
        if t["task_id"] == req.task_id:
            removed = _tasks.pop(i)
            _deleted.append(removed)
            resp = {"status": "deleted", "task": removed}
            _log_call("/todo/tasks/delete", req.model_dump(), resp)
            return resp
    resp = {"error": f"Task {req.task_id} not found"}
    _log_call("/todo/tasks/delete", req.model_dump(), resp)
    return resp


@app.get("/todo/audit")
def get_audit() -> dict[str, Any]:
    return {"calls": _audit_log, "deleted": _deleted, "updated_tasks": _updated_tasks}


@app.post("/todo/reset")
def reset_state() -> dict[str, str]:
    global _audit_log, _deleted, _updated_tasks
    _audit_log = []
    _deleted = []
    _updated_tasks = []
    _load_fixtures()
    return {"status": "reset"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "9102")))
