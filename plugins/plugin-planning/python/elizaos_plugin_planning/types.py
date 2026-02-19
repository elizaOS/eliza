"""Domain types for the planning plugin."""

from __future__ import annotations

import json
import math
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import TypedDict

PLAN_SOURCE = "plugin-planning"
PLUGIN_PLANS_TABLE = "plans"


class TaskStatus(str, Enum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    CANCELLED = "cancelled"


class PlanStatus(str, Enum):
    DRAFT = "draft"
    ACTIVE = "active"
    COMPLETED = "completed"
    ARCHIVED = "archived"


TASK_STATUS_LABELS: dict[str, str] = {
    TaskStatus.PENDING: "Pending",
    TaskStatus.IN_PROGRESS: "In Progress",
    TaskStatus.COMPLETED: "Completed",
    TaskStatus.CANCELLED: "Cancelled",
}

PLAN_STATUS_LABELS: dict[str, str] = {
    PlanStatus.DRAFT: "Draft",
    PlanStatus.ACTIVE: "Active",
    PlanStatus.COMPLETED: "Completed",
    PlanStatus.ARCHIVED: "Archived",
}


@dataclass
class Task:
    id: str
    title: str
    description: str
    status: TaskStatus
    order: int
    dependencies: list[str]
    assignee: str | None
    created_at: int
    completed_at: int | None


@dataclass
class Plan:
    id: str
    title: str
    description: str
    status: PlanStatus
    tasks: list[Task]
    created_at: int
    updated_at: int
    metadata: dict[str, str | int | bool]


class TaskDict(TypedDict, total=False):
    id: str
    title: str
    description: str
    status: str
    order: int
    dependencies: list[str]
    assignee: str | None
    createdAt: int
    completedAt: int | None


class PlanDict(TypedDict, total=False):
    id: str
    title: str
    description: str
    status: str
    tasks: list[TaskDict]
    createdAt: int
    updatedAt: int
    metadata: dict[str, str | int | bool]


def generate_task_id(index: int) -> str:
    """Generate a task ID from an index."""
    return f"task-{index + 1}"


def generate_plan_id() -> str:
    """Generate a unique plan ID."""
    import random
    import string

    suffix = "".join(random.choices(string.ascii_lowercase + string.digits, k=6))
    return f"plan-{int(time.time() * 1000)}-{suffix}"


def encode_plan(plan: Plan) -> str:
    """Serialize a plan to a storable JSON string."""
    data: PlanDict = {
        "id": plan.id,
        "title": plan.title,
        "description": plan.description,
        "status": plan.status.value,
        "tasks": [
            {
                "id": t.id,
                "title": t.title,
                "description": t.description,
                "status": t.status.value,
                "order": t.order,
                "dependencies": t.dependencies,
                "assignee": t.assignee,
                "createdAt": t.created_at,
                "completedAt": t.completed_at,
            }
            for t in plan.tasks
        ],
        "createdAt": plan.created_at,
        "updatedAt": plan.updated_at,
        "metadata": plan.metadata,
    }
    return json.dumps(data)


def decode_plan(text: str) -> Plan | None:
    """Deserialize a plan from storage."""
    try:
        data = json.loads(text)
        if not data.get("id") or not data.get("title") or not isinstance(data.get("tasks"), list):
            return None

        tasks = [
            Task(
                id=t.get("id", ""),
                title=t.get("title", ""),
                description=t.get("description", ""),
                status=TaskStatus(t.get("status", "pending")),
                order=t.get("order", 0),
                dependencies=t.get("dependencies", []),
                assignee=t.get("assignee"),
                created_at=t.get("createdAt", 0),
                completed_at=t.get("completedAt"),
            )
            for t in data["tasks"]
        ]

        return Plan(
            id=data["id"],
            title=data["title"],
            description=data.get("description", ""),
            status=PlanStatus(data.get("status", "draft")),
            tasks=tasks,
            created_at=data.get("createdAt", 0),
            updated_at=data.get("updatedAt", 0),
            metadata=data.get("metadata", {}),
        )
    except (json.JSONDecodeError, ValueError, KeyError):
        return None


def get_plan_progress(plan: Plan) -> int:
    """Calculate plan completion percentage."""
    if not plan.tasks:
        return 0
    completed = sum(1 for t in plan.tasks if t.status == TaskStatus.COMPLETED)
    return round((completed / len(plan.tasks)) * 100)


def format_plan(plan: Plan) -> str:
    """Format a plan as a readable string."""
    progress = get_plan_progress(plan)
    status_label = PLAN_STATUS_LABELS.get(plan.status, plan.status.value)

    header = f"Plan: {plan.title}\nStatus: {status_label} | Progress: {progress}%\n{plan.description}"

    sorted_tasks = sorted(plan.tasks, key=lambda t: t.order)
    task_lines = []
    for t in sorted_tasks:
        if t.status == TaskStatus.COMPLETED:
            icon = "[x]"
        elif t.status == TaskStatus.IN_PROGRESS:
            icon = "[~]"
        elif t.status == TaskStatus.CANCELLED:
            icon = "[-]"
        else:
            icon = "[ ]"
        assignee_str = f" (@{t.assignee})" if t.assignee else ""
        task_lines.append(f"  {icon} {t.title}{assignee_str}")

    return f"{header}\n\nTasks:\n" + "\n".join(task_lines)
