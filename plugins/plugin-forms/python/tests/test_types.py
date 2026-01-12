"""Tests for forms plugin types."""

import uuid
from datetime import datetime

import pytest

from elizaos_plugin_forms import (
    FieldError,
    Form,
    FormField,
    FormFieldType,
    FormStatus,
    FormStep,
    FormTemplate,
    FormUpdateResult,
)


class TestFormFieldType:
    """Tests for FormFieldType enum."""

    def test_all_types_exist(self) -> None:
        """Test that all expected field types exist."""
        assert FormFieldType.TEXT == "text"
        assert FormFieldType.NUMBER == "number"
        assert FormFieldType.EMAIL == "email"
        assert FormFieldType.TEL == "tel"
        assert FormFieldType.URL == "url"
        assert FormFieldType.TEXTAREA == "textarea"
        assert FormFieldType.CHOICE == "choice"
        assert FormFieldType.CHECKBOX == "checkbox"
        assert FormFieldType.DATE == "date"
        assert FormFieldType.TIME == "time"
        assert FormFieldType.DATETIME == "datetime"


class TestFormStatus:
    """Tests for FormStatus enum."""

    def test_all_statuses_exist(self) -> None:
        """Test that all expected statuses exist."""
        assert FormStatus.ACTIVE == "active"
        assert FormStatus.COMPLETED == "completed"
        assert FormStatus.CANCELLED == "cancelled"


class TestFormField:
    """Tests for FormField model."""

    def test_create_basic_field(self) -> None:
        """Test creating a basic form field."""
        field = FormField(
            id="name",
            label="Name",
            type=FormFieldType.TEXT,
        )
        assert field.id == "name"
        assert field.label == "Name"
        assert field.type == FormFieldType.TEXT
        assert field.optional is False
        assert field.secret is False
        assert field.value is None

    def test_create_field_with_all_options(self) -> None:
        """Test creating a field with all options."""
        field = FormField(
            id="email",
            label="Email Address",
            type=FormFieldType.EMAIL,
            description="Your email address",
            criteria="Must be a valid email",
            optional=True,
            secret=False,
            value="test@example.com",
        )
        assert field.description == "Your email address"
        assert field.criteria == "Must be a valid email"
        assert field.optional is True
        assert field.value == "test@example.com"

    def test_field_serialization(self) -> None:
        """Test field serialization to dict."""
        field = FormField(
            id="test",
            label="Test",
            type=FormFieldType.NUMBER,
        )
        data = field.model_dump()
        assert data["id"] == "test"
        assert data["type"] == "number"


class TestFormStep:
    """Tests for FormStep model."""

    def test_create_step(self) -> None:
        """Test creating a form step."""
        fields = [
            FormField(id="name", label="Name", type=FormFieldType.TEXT),
            FormField(id="email", label="Email", type=FormFieldType.EMAIL),
        ]
        step = FormStep(
            id="step1",
            name="Personal Info",
            fields=fields,
        )
        assert step.id == "step1"
        assert step.name == "Personal Info"
        assert len(step.fields) == 2
        assert step.completed is False


class TestForm:
    """Tests for Form model."""

    def test_create_form(self) -> None:
        """Test creating a form."""
        form = Form(
            id=uuid.uuid4(),
            agent_id=uuid.uuid4(),
            name="Test Form",
            steps=[
                FormStep(
                    id="step1",
                    name="Step 1",
                    fields=[
                        FormField(id="name", label="Name", type=FormFieldType.TEXT),
                    ],
                ),
            ],
        )
        assert form.name == "Test Form"
        assert form.status == FormStatus.ACTIVE
        assert form.current_step_index == 0


class TestFormTemplate:
    """Tests for FormTemplate model."""

    def test_create_template(self) -> None:
        """Test creating a form template."""
        template = FormTemplate(
            name="Contact",
            description="Contact form template",
            steps=[
                FormStep(
                    id="info",
                    name="Information",
                    fields=[
                        FormField(id="name", label="Name", type=FormFieldType.TEXT),
                    ],
                ),
            ],
        )
        assert template.name == "Contact"
        assert template.description == "Contact form template"


class TestFormUpdateResult:
    """Tests for FormUpdateResult model."""

    def test_success_result(self) -> None:
        """Test creating a success result."""
        result = FormUpdateResult(
            success=True,
            message="Updated successfully",
            updated_fields=["name", "email"],
        )
        assert result.success is True
        assert result.message == "Updated successfully"
        assert result.updated_fields == ["name", "email"]

    def test_failure_result(self) -> None:
        """Test creating a failure result."""
        result = FormUpdateResult(
            success=False,
            message="Form not found",
        )
        assert result.success is False
        assert result.message == "Form not found"


class TestFieldError:
    """Tests for FieldError model."""

    def test_create_error(self) -> None:
        """Test creating a field error."""
        error = FieldError(
            field_id="email",
            message="Invalid email format",
        )
        assert error.field_id == "email"
        assert error.message == "Invalid email format"
