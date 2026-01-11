"""
Type definitions for the Todo Plugin.
"""

from datetime import datetime
from enum import Enum
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field


class TaskType(str, Enum):
    """Task types supported by the plugin."""

    DAILY = "daily"
    ONE_OFF = "one-off"
    ASPIRATIONAL = "aspirational"


class Priority(int, Enum):
    """Priority levels (1 = highest, 4 = lowest)."""

    CRITICAL = 1
    HIGH = 2
    MEDIUM = 3
    LOW = 4


class RecurringPattern(str, Enum):
    """Recurring patterns for daily tasks."""

    DAILY = "daily"
    WEEKLY = "weekly"
    MONTHLY = "monthly"


class NotificationType(str, Enum):
    """Notification types."""

    OVERDUE = "overdue"
    UPCOMING = "upcoming"
    DAILY = "daily"
    SYSTEM = "system"


class TodoMetadata(BaseModel):
    """Metadata stored with todos."""

    created_at: Optional[str] = None
    description: Optional[str] = None
    due_date: Optional[str] = None
    completed_at: Optional[str] = None
    completed_today: Optional[bool] = None
    last_completed_date: Optional[str] = None
    streak: Optional[int] = None
    recurring: Optional[RecurringPattern] = None
    points_awarded: Optional[int] = None

    class Config:
        """Pydantic config."""

        extra = "allow"


class Todo(BaseModel):
    """Core todo item structure."""

    id: UUID
    agent_id: UUID
    world_id: UUID
    room_id: UUID
    entity_id: UUID
    name: str
    description: Optional[str] = None
    type: TaskType
    priority: Optional[Priority] = None
    is_urgent: bool = False
    is_completed: bool = False
    due_date: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime
    metadata: TodoMetadata = Field(default_factory=TodoMetadata)
    tags: list[str] = Field(default_factory=list)


class CreateTodoParams(BaseModel):
    """Parameters for creating a new todo."""

    agent_id: UUID
    world_id: UUID
    room_id: UUID
    entity_id: UUID
    name: str
    description: Optional[str] = None
    type: TaskType
    priority: Optional[Priority] = None
    is_urgent: bool = False
    due_date: Optional[datetime] = None
    metadata: Optional[TodoMetadata] = None
    tags: list[str] = Field(default_factory=list)


class UpdateTodoParams(BaseModel):
    """Parameters for updating a todo."""

    name: Optional[str] = None
    description: Optional[str] = None
    priority: Optional[Priority] = None
    is_urgent: Optional[bool] = None
    is_completed: Optional[bool] = None
    due_date: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    metadata: Optional[TodoMetadata] = None


class TodoFilters(BaseModel):
    """Filter parameters for querying todos."""

    agent_id: Optional[UUID] = None
    world_id: Optional[UUID] = None
    room_id: Optional[UUID] = None
    entity_id: Optional[UUID] = None
    type: Optional[TaskType] = None
    is_completed: Optional[bool] = None
    tags: Optional[list[str]] = None
    limit: Optional[int] = None


class ReminderMetadata(BaseModel):
    """Metadata for reminder messages."""

    todo_id: UUID
    todo_name: str
    reminder_type: str
    due_date: Optional[datetime] = None


class ReminderMessage(BaseModel):
    """Reminder message structure."""

    entity_id: UUID
    message: str
    priority: str  # 'low' | 'medium' | 'high'
    platforms: Optional[list[str]] = None
    metadata: Optional[ReminderMetadata] = None


class TodoPluginConfig(BaseModel):
    """Plugin configuration."""

    enable_reminders: bool = True
    reminder_interval: int = 30000  # milliseconds
    enable_integrations: bool = True


class TaskSelection(BaseModel):
    """Task selection from extraction."""

    task_id: str
    task_name: str
    is_found: bool


class TaskUpdate(BaseModel):
    """Task update properties."""

    name: Optional[str] = None
    description: Optional[str] = None
    priority: Optional[Priority] = None
    urgent: Optional[bool] = None
    due_date: Optional[str] = None
    recurring: Optional[RecurringPattern] = None


class ConfirmationResponse(BaseModel):
    """Confirmation response from user."""

    is_confirmation: bool
    should_proceed: bool
    modifications: Optional[str] = None


