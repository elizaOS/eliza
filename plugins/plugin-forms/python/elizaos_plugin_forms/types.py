
from datetime import datetime
from enum import Enum
from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field


class FormFieldType(str, Enum):
    """Possible types for form fields."""

    TEXT = "text"
    NUMBER = "number"
    EMAIL = "email"
    TEL = "tel"
    URL = "url"
    TEXTAREA = "textarea"
    CHOICE = "choice"
    CHECKBOX = "checkbox"
    DATE = "date"
    TIME = "time"
    DATETIME = "datetime"


class FormStatus(str, Enum):
    """Possible statuses for a form."""

    ACTIVE = "active"
    COMPLETED = "completed"
    CANCELLED = "cancelled"


class FormField(BaseModel):
    """Represents a single field in a form."""

    id: str = Field(..., description="Unique identifier for the field")
    label: str = Field(..., description="Display label for the field")
    type: FormFieldType = Field(..., description="Field type")
    description: str | None = Field(None, description="Optional field description")
    criteria: str | None = Field(None, description="Optional validation criteria")
    optional: bool = Field(False, description="Whether this field is optional")
    secret: bool = Field(False, description="Whether this field contains sensitive data")
    value: str | int | float | bool | None = Field(None, description="Current value of the field")
    error: str | None = Field(None, description="Validation error message")
    metadata: dict[str, Any] | None = Field(None, description="Additional metadata")

    class Config:
        use_enum_values = True


class FormStep(BaseModel):
    """Represents a step in a multi-step form."""

    id: str = Field(..., description="Unique identifier for the step")
    name: str = Field(..., description="Display name for the step")
    fields: list[FormField] = Field(..., description="Fields in this step")
    completed: bool = Field(False, description="Whether this step is completed")

    class Config:
        use_enum_values = True


class Form(BaseModel):
    """Represents a complete form instance."""

    id: UUID = Field(..., description="Unique identifier for the form")
    name: str = Field(..., description="Form name/type")
    description: str | None = Field(None, description="Optional form description")
    steps: list[FormStep] = Field(..., description="Steps in the form")
    current_step_index: int = Field(0, description="Current step index")
    status: FormStatus = Field(FormStatus.ACTIVE, description="Form status")
    created_at: datetime = Field(default_factory=datetime.now, description="Creation timestamp")
    updated_at: datetime = Field(default_factory=datetime.now, description="Last update timestamp")
    completed_at: datetime | None = Field(None, description="Completion timestamp")
    agent_id: UUID = Field(..., description="Agent that owns this form")
    metadata: dict[str, Any] | None = Field(None, description="Additional metadata")

    class Config:
        use_enum_values = True


class FormTemplate(BaseModel):
    """Template for creating forms."""

    name: str = Field(..., description="Template name")
    description: str | None = Field(None, description="Template description")
    steps: list[FormStep] = Field(..., description="Template steps")
    metadata: dict[str, Any] | None = Field(None, description="Template metadata")

    class Config:
        use_enum_values = True


class FieldError(BaseModel):
    """Validation error for a field."""

    field_id: str = Field(..., description="ID of the field with error")
    message: str = Field(..., description="Error message")


class FormUpdateResult(BaseModel):
    """Result of a form update operation."""

    success: bool = Field(..., description="Whether the update was successful")
    form: Form | None = Field(None, description="Updated form data")
    updated_fields: list[str] | None = Field(None, description="Fields that were updated")
    errors: list[FieldError] | None = Field(None, description="Validation errors")
    step_completed: bool | None = Field(None, description="Whether the current step was completed")
    form_completed: bool | None = Field(None, description="Whether the entire form was completed")
    current_step: str | None = Field(None, description="Current step name")
    message: str | None = Field(None, description="Optional message")

    class Config:
        use_enum_values = True





