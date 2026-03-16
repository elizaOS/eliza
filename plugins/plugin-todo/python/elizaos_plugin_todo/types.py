from datetime import datetime
from enum import Enum
from uuid import UUID

from pydantic import BaseModel, Field


class TaskType(str, Enum):
    DAILY = "daily"
    ONE_OFF = "one-off"
    ASPIRATIONAL = "aspirational"


class Priority(int, Enum):
    CRITICAL = 1
    HIGH = 2
    MEDIUM = 3
    LOW = 4


class RecurringPattern(str, Enum):
    DAILY = "daily"
    WEEKLY = "weekly"
    MONTHLY = "monthly"


class NotificationType(str, Enum):
    OVERDUE = "overdue"
    UPCOMING = "upcoming"
    DAILY = "daily"
    SYSTEM = "system"


class TodoMetadata(BaseModel):
    """Metadata stored with todos."""

    created_at: str | None = None
    description: str | None = None
    due_date: str | None = None
    completed_at: str | None = None
    completed_today: bool | None = None
    last_completed_date: str | None = None
    streak: int | None = None
    recurring: RecurringPattern | None = None
    points_awarded: int | None = None

    class Config:
        extra = "allow"


class Todo(BaseModel):
    id: UUID
    agent_id: UUID
    world_id: UUID
    room_id: UUID
    entity_id: UUID
    name: str
    description: str | None = None
    type: TaskType
    priority: Priority | None = None
    is_urgent: bool = False
    is_completed: bool = False
    due_date: datetime | None = None
    completed_at: datetime | None = None
    created_at: datetime
    updated_at: datetime
    metadata: TodoMetadata = Field(default_factory=TodoMetadata)
    tags: list[str] = Field(default_factory=list)


class CreateTodoParams(BaseModel):
    agent_id: UUID
    world_id: UUID
    room_id: UUID
    entity_id: UUID
    name: str
    description: str | None = None
    type: TaskType
    priority: Priority | None = None
    is_urgent: bool = False
    due_date: datetime | None = None
    metadata: TodoMetadata | None = None
    tags: list[str] = Field(default_factory=list)


class UpdateTodoParams(BaseModel):
    name: str | None = None
    description: str | None = None
    priority: Priority | None = None
    is_urgent: bool | None = None
    is_completed: bool | None = None
    due_date: datetime | None = None
    completed_at: datetime | None = None
    metadata: TodoMetadata | None = None


class TodoFilters(BaseModel):
    agent_id: UUID | None = None
    world_id: UUID | None = None
    room_id: UUID | None = None
    entity_id: UUID | None = None
    type: TaskType | None = None
    is_completed: bool | None = None
    tags: list[str] | None = None
    limit: int | None = None


class ReminderMetadata(BaseModel):
    todo_id: UUID
    todo_name: str
    reminder_type: str
    due_date: datetime | None = None


class ReminderMessage(BaseModel):
    entity_id: UUID
    message: str
    priority: str  # 'low' | 'medium' | 'high'
    platforms: list[str] | None = None
    metadata: ReminderMetadata | None = None


class TodoPluginConfig(BaseModel):
    enable_reminders: bool = True
    reminder_interval: int = 30000  # milliseconds
    enable_integrations: bool = True


class TaskSelection(BaseModel):
    task_id: str
    task_name: str
    is_found: bool


class TaskUpdate(BaseModel):
    """Task update properties."""

    name: str | None = None
    description: str | None = None
    priority: Priority | None = None
    urgent: bool | None = None
    due_date: str | None = None
    recurring: RecurringPattern | None = None


class ConfirmationResponse(BaseModel):
    is_confirmation: bool
    should_proceed: bool
    modifications: str | None = None
