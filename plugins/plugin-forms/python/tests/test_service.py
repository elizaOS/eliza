"""Tests for forms plugin service."""

import uuid
from typing import TYPE_CHECKING

import pytest

from elizaos_plugin_forms import (
    FormField,
    FormFieldType,
    FormsService,
    FormStatus,
    FormStep,
    FormTemplate,
)

if TYPE_CHECKING:
    from tests.conftest import MockRuntime


class TestFormsService:
    """Tests for FormsService."""

    @pytest.mark.asyncio
    async def test_create_form_from_template(self, mock_runtime: "MockRuntime") -> None:
        """Test creating a form from a template."""
        service = FormsService(mock_runtime)

        # Contact template should exist by default
        form = await service.create_form("contact")

        assert form.name == "contact"
        assert form.status == FormStatus.ACTIVE
        assert form.agent_id == mock_runtime.agent_id
        assert len(form.steps) == 1
        assert form.current_step_index == 0

    @pytest.mark.asyncio
    async def test_create_form_invalid_template(self, mock_runtime: "MockRuntime") -> None:
        """Test creating a form with invalid template raises error."""
        service = FormsService(mock_runtime)

        with pytest.raises(ValueError, match="Template.*not found"):
            await service.create_form("nonexistent_template")

    @pytest.mark.asyncio
    async def test_list_forms(self, mock_runtime: "MockRuntime") -> None:
        """Test listing forms."""
        service = FormsService(mock_runtime)

        # Initially empty
        forms = await service.list_forms()
        assert len(forms) == 0

        # Create a form
        await service.create_form("contact")
        forms = await service.list_forms()
        assert len(forms) == 1

    @pytest.mark.asyncio
    async def test_list_forms_by_status(self, mock_runtime: "MockRuntime") -> None:
        """Test listing forms filtered by status."""
        service = FormsService(mock_runtime)

        # Create forms
        form1 = await service.create_form("contact")
        form2 = await service.create_form("contact")

        # Cancel one form
        await service.cancel_form(form2.id)

        active_forms = await service.list_forms(FormStatus.ACTIVE)
        cancelled_forms = await service.list_forms(FormStatus.CANCELLED)

        assert len(active_forms) == 1
        assert len(cancelled_forms) == 1
        assert active_forms[0].id == form1.id
        assert cancelled_forms[0].id == form2.id

    @pytest.mark.asyncio
    async def test_get_form(self, mock_runtime: "MockRuntime") -> None:
        """Test getting a specific form."""
        service = FormsService(mock_runtime)

        form = await service.create_form("contact")
        retrieved = await service.get_form(form.id)

        assert retrieved is not None
        assert retrieved.id == form.id
        assert retrieved.name == form.name

    @pytest.mark.asyncio
    async def test_get_form_nonexistent(self, mock_runtime: "MockRuntime") -> None:
        """Test getting a nonexistent form returns None."""
        service = FormsService(mock_runtime)

        result = await service.get_form(uuid.uuid4())
        assert result is None

    @pytest.mark.asyncio
    async def test_cancel_form(self, mock_runtime: "MockRuntime") -> None:
        """Test cancelling a form."""
        service = FormsService(mock_runtime)

        form = await service.create_form("contact")
        assert form.status == FormStatus.ACTIVE

        success = await service.cancel_form(form.id)
        assert success is True

        # Check form is cancelled
        updated_form = await service.get_form(form.id)
        assert updated_form is not None
        assert updated_form.status == FormStatus.CANCELLED

    @pytest.mark.asyncio
    async def test_cancel_form_nonexistent(self, mock_runtime: "MockRuntime") -> None:
        """Test cancelling a nonexistent form returns False."""
        service = FormsService(mock_runtime)

        success = await service.cancel_form(uuid.uuid4())
        assert success is False

    @pytest.mark.asyncio
    async def test_register_template(self, mock_runtime: "MockRuntime") -> None:
        """Test registering a custom template."""
        service = FormsService(mock_runtime)

        template = FormTemplate(
            name="custom",
            description="Custom form",
            steps=[
                FormStep(
                    id="step1",
                    name="Custom Step",
                    fields=[
                        FormField(
                            id="custom_field",
                            label="Custom Field",
                            type=FormFieldType.TEXT,
                        ),
                    ],
                ),
            ],
        )

        service.register_template(template)

        # Should be able to create form from custom template
        form = await service.create_form("custom")
        assert form.name == "custom"
        assert len(form.steps[0].fields) == 1

    @pytest.mark.asyncio
    async def test_get_templates(self, mock_runtime: "MockRuntime") -> None:
        """Test getting all templates."""
        service = FormsService(mock_runtime)

        templates = service.get_templates()

        # Should have at least the contact template
        assert len(templates) >= 1
        template_names = [t.name for t in templates]
        assert "contact" in template_names

    @pytest.mark.asyncio
    async def test_update_form(self, mock_runtime: "MockRuntime") -> None:
        """Test updating a form with extracted values."""
        service = FormsService(mock_runtime)

        form = await service.create_form("contact")

        # Update with user message
        result = await service.update_form(form.id, "My name is John Doe")

        assert result.success is True
        # The mock runtime returns name and email, so name should be updated
        assert result.updated_fields is not None

    @pytest.mark.asyncio
    async def test_update_form_nonexistent(self, mock_runtime: "MockRuntime") -> None:
        """Test updating a nonexistent form."""
        service = FormsService(mock_runtime)

        result = await service.update_form(uuid.uuid4(), "test")
        assert result.success is False
        assert "not found" in result.message.lower()

    @pytest.mark.asyncio
    async def test_update_cancelled_form(self, mock_runtime: "MockRuntime") -> None:
        """Test updating a cancelled form fails."""
        service = FormsService(mock_runtime)

        form = await service.create_form("contact")
        await service.cancel_form(form.id)

        result = await service.update_form(form.id, "test")
        assert result.success is False
        assert "not active" in result.message.lower()


class TestParseKeyValueXml:
    """Tests for XML parsing utility."""

    def test_parse_simple_xml(self) -> None:
        """Test parsing simple XML response."""
        from elizaos_plugin_forms.service import parse_key_value_xml

        xml = """<response>
            <name>John Doe</name>
            <email>john@example.com</email>
        </response>"""

        result = parse_key_value_xml(xml)
        assert result is not None
        assert result["name"] == "John Doe"
        assert result["email"] == "john@example.com"

    def test_parse_xml_with_entities(self) -> None:
        """Test parsing XML with escaped entities."""
        from elizaos_plugin_forms.service import parse_key_value_xml

        xml = """<response>
            <text>Hello &amp; World</text>
        </response>"""

        result = parse_key_value_xml(xml)
        assert result is not None
        assert result["text"] == "Hello & World"

    def test_parse_invalid_xml(self) -> None:
        """Test parsing invalid XML returns None."""
        from elizaos_plugin_forms.service import parse_key_value_xml

        result = parse_key_value_xml("not xml at all")
        assert result is None

    def test_parse_alternative_root(self) -> None:
        """Test parsing XML with alternative root element."""
        from elizaos_plugin_forms.service import parse_key_value_xml

        xml = """<data>
            <field>value</field>
        </data>"""

        result = parse_key_value_xml(xml)
        assert result is not None
        assert result["field"] == "value"
