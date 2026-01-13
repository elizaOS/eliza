from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Literal, TypedDict


class Priority(Enum):
    NONE = 0
    URGENT = 1
    HIGH = 2
    NORMAL = 3
    LOW = 4


ResourceType = Literal["issue", "project", "comment", "label", "user", "team"]


@dataclass
class LinearConfig:
    api_key: str
    workspace_id: str | None = None
    default_team_key: str | None = None


@dataclass
class LinearActivityItem:
    id: str
    timestamp: str
    action: str
    resource_type: ResourceType
    resource_id: str
    details: dict[str, str | int | float | bool | None]
    success: bool
    error: str | None = None


@dataclass
class LinearIssueInput:
    title: str
    team_id: str
    description: str | None = None
    priority: int | None = None
    assignee_id: str | None = None
    label_ids: list[str] = field(default_factory=list)
    project_id: str | None = None
    state_id: str | None = None
    estimate: int | None = None
    due_date: datetime | None = None


@dataclass
class LinearCommentInput:
    body: str
    issue_id: str


@dataclass
class LinearSearchFilters:
    state: list[str] | None = None
    assignee: list[str] | None = None
    label: list[str] | None = None
    project: str | None = None
    team: str | None = None
    priority: list[int] | None = None
    query: str | None = None
    limit: int = 50


class LinearAPIError(Exception):
    def __init__(
        self,
        message: str,
        status: int | None = None,
        response: dict[str, str | int | float | bool | list | dict | None] | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.response = response


class LinearAuthenticationError(LinearAPIError):
    def __init__(self, message: str) -> None:
        super().__init__(message, status=401)


class LinearRateLimitError(LinearAPIError):
    def __init__(self, message: str, reset_time: int) -> None:
        super().__init__(message, status=429)
        self.reset_time = reset_time


class TeamData(TypedDict):
    id: str
    name: str
    key: str
    description: str | None


class UserData(TypedDict):
    id: str
    name: str
    email: str


class StateData(TypedDict):
    id: str
    name: str
    type: str
    color: str


class LabelData(TypedDict):
    id: str
    name: str
    color: str


class IssueData(TypedDict):
    id: str
    identifier: str
    title: str
    description: str | None
    priority: int
    priorityLabel: str
    url: str
    createdAt: str
    updatedAt: str


class ProjectData(TypedDict):
    id: str
    name: str
    description: str | None
    state: str | None
    progress: float | None
    startDate: str | None
    targetDate: str | None
    url: str


class CommentData(TypedDict):
    id: str
    body: str
    createdAt: str
