"""Tests for forms plugin providers."""

import uuid
from datetime import datetime

import pytest

from elizaos_plugin_forms import (
    Form,
    FormField,
    FormFieldType,
    FormStatus,
    FormStep,
    FormsContextProvider,
    ProviderResult,
)


class TestProviderResult:
    """Tests for ProviderResult dataclass."""

    def test_empty_result(self) -> None:
        """Test creating an empty result."""
        result = ProviderResult()
        assert result.text == ""
        assert result.values == {}
        assert result.data == {}

    def test_result_with_content(self) -> None:
        """Test creating a result with content."""
        result = ProviderResult(
            text="Test context",
            values={"count": 1},
            data={"forms": []},
        )
        assert result.text == "Test context"
        assert result.values["count"] == 1
        assert result.data["forms"] == []


class TestFormsContextProvider:
    """Tests for FormsContextProvider."""

    def test_provider_properties(self) -> None:
        """Test provider class properties."""
        assert FormsContextProvider.name == "FORMS_CONTEXT"
        assert FormsContextProvider.dynamic is True
        assert FormsContextProvider.position == 50
        assert "active forms" in FormsContextProvider.description.lower()

    def test_generate_context_empty(self) -> None:
        """Test generating context with no forms."""
        result = FormsContextProvider.generate_context([])
        assert result.text == ""
        assert result.values == {}
        assert result.data == {}

    def test_generate_context_with_form(self) -> None:
        """Test generating context with a form."""
        form = Form(
            id=uuid.uuid4(),
            agent_id=uuid.uuid4(),
            name="Test Form",
            description="A test form",
            steps=[
                FormStep(
                    id="step1",
                    name="Step 1",
                    fields=[
                        FormField(
                            id="name",
                            label="Name",
                            type=FormFieldType.TEXT,
                            description="Your name",
                            value="John Doe",
                        ),
                        FormField(
                            id="email",
                            label="Email",
                            type=FormFieldType.EMAIL,
                            description="Your email",
                        ),
                    ],
                ),
            ],
            status=FormStatus.ACTIVE,
            created_at=datetime.now(),
            updated_at=datetime.now(),
        )

        result = FormsContextProvider.generate_context([form])

        # Check text contains expected content
        assert "[FORMS]" in result.text
        assert "Test Form" in result.text
        assert "Step 1" in result.text
        assert "John Doe" in result.text  # Completed field value
        assert "Email" in result.text  # Required field

        # Check values
        assert result.values["activeFormsCount"] == 1

        # Check data
        assert "forms" in result.data
        assert len(result.data["forms"]) == 1
        assert result.data["forms"][0]["name"] == "Test Form"

    def test_generate_context_masks_secrets(self) -> None:
        """Test that secret fields are masked in context."""
        form = Form(
            id=uuid.uuid4(),
            agent_id=uuid.uuid4(),
            name="Secret Form",
            steps=[
                FormStep(
                    id="step1",
                    name="Step 1",
                    fields=[
                        FormField(
                            id="password",
                            label="Password",
                            type=FormFieldType.TEXT,
                            secret=True,
                            value="supersecret123",
                        ),
                    ],
                ),
            ],
            status=FormStatus.ACTIVE,
            created_at=datetime.now(),
            updated_at=datetime.now(),
        )

        result = FormsContextProvider.generate_context([form])

        # Secret value should be masked
        assert "[SECRET]" in result.text
        assert "supersecret123" not in result.text

    def test_generate_context_shows_optional_fields(self) -> None:
        """Test that optional fields are shown separately."""
        form = Form(
            id=uuid.uuid4(),
            agent_id=uuid.uuid4(),
            name="Form with Optional",
            steps=[
                FormStep(
                    id="step1",
                    name="Step 1",
                    fields=[
                        FormField(
                            id="name",
                            label="Name",
                            type=FormFieldType.TEXT,
                        ),
                        FormField(
                            id="notes",
                            label="Notes",
                            type=FormFieldType.TEXTAREA,
                            optional=True,
                        ),
                    ],
                ),
            ],
            status=FormStatus.ACTIVE,
            created_at=datetime.now(),
            updated_at=datetime.now(),
        )

        result = FormsContextProvider.generate_context([form])

        # Both required and optional should be shown
        assert "Required fields:" in result.text
        assert "Optional fields:" in result.text
        assert "Name" in result.text
        assert "Notes" in result.text

    def test_generate_context_multiple_forms(self) -> None:
        """Test generating context with multiple forms."""
        forms = [
            Form(
                id=uuid.uuid4(),
                agent_id=uuid.uuid4(),
                name="Form 1",
                steps=[
                    FormStep(
                        id="step1",
                        name="Step 1",
                        fields=[
                            FormField(id="f1", label="Field 1", type=FormFieldType.TEXT),
                        ],
                    ),
                ],
                status=FormStatus.ACTIVE,
                created_at=datetime.now(),
                updated_at=datetime.now(),
            ),
            Form(
                id=uuid.uuid4(),
                agent_id=uuid.uuid4(),
                name="Form 2",
                steps=[
                    FormStep(
                        id="step1",
                        name="Step 1",
                        fields=[
                            FormField(id="f2", label="Field 2", type=FormFieldType.TEXT),
                        ],
                    ),
                ],
                status=FormStatus.ACTIVE,
                created_at=datetime.now(),
                updated_at=datetime.now(),
            ),
        ]

        result = FormsContextProvider.generate_context(forms)

        # Both forms should be in context
        assert "Form 1" in result.text
        assert "Form 2" in result.text
        assert result.values["activeFormsCount"] == 2
        assert len(result.data["forms"]) == 2
