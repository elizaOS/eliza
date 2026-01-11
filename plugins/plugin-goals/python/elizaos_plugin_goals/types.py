"""Type definitions for the Goals plugin."""

from datetime import datetime
from enum import Enum

from pydantic import BaseModel, Field


class GoalStatus(str, Enum):
    """Goal completion status."""

    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    CANCELLED = "cancelled"


class GoalOwnerType(str, Enum):
    """Goal owner type - either agent or entity (user)."""

    AGENT = "agent"
    ENTITY = "entity"


class Goal(BaseModel):
    """Goal data structure."""

    id: str
    agent_id: str
    owner_type: GoalOwnerType
    owner_id: str
    name: str
    description: str | None = None
    is_completed: bool = False
    completed_at: datetime | None = None
    created_at: datetime
    updated_at: datetime
    metadata: dict[str, object] = Field(default_factory=dict)
    tags: list[str] = Field(default_factory=list)


class GoalTag(BaseModel):
    """Goal tag data structure."""

    id: str
    goal_id: str
    tag: str
    created_at: datetime


class CreateGoalParams(BaseModel):
    """Parameters for creating a goal."""

    agent_id: str
    owner_type: GoalOwnerType
    owner_id: str
    name: str
    description: str | None = None
    metadata: dict[str, object] = Field(default_factory=dict)
    tags: list[str] = Field(default_factory=list)


class UpdateGoalParams(BaseModel):
    """Parameters for updating a goal."""

    name: str | None = None
    description: str | None = None
    is_completed: bool | None = None
    completed_at: datetime | None = None
    metadata: dict[str, object] | None = None
    tags: list[str] | None = None


class GoalFilters(BaseModel):
    """Filters for querying goals."""

    owner_type: GoalOwnerType | None = None
    owner_id: str | None = None
    is_completed: bool | None = None
    tags: list[str] | None = None


class ExtractedGoalInfo(BaseModel):
    """Information extracted from user message about a goal."""

    name: str
    description: str | None = None
    owner_type: GoalOwnerType = GoalOwnerType.ENTITY


class SimilarityCheckResult(BaseModel):
    """Result of checking goal similarity."""

    has_similar: bool
    similar_goal_name: str | None = None
    confidence: int = 0


class GoalSelectionResult(BaseModel):
    """Result of goal selection extraction."""

    goal_id: str | None = None
    goal_name: str | None = None
    is_found: bool = False


class ConfirmationResult(BaseModel):
    """Result of confirmation intent extraction."""

    is_confirmation: bool
    should_proceed: bool
    modifications: str | None = None
