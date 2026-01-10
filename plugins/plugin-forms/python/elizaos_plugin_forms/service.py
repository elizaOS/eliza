"""
Forms Service implementation for the elizaOS Forms Plugin.

This service manages form lifecycle and state, providing methods to create,
update, list, and cancel forms.
"""

import re
import uuid
from datetime import datetime
from typing import Protocol, TypeVar

from elizaos_plugin_forms.prompts import build_extraction_prompt
from elizaos_plugin_forms.types import (
    FieldError,
    Form,
    FormField,
    FormFieldType,
    FormStatus,
    FormStep,
    FormTemplate,
    FormUpdateResult,
)


T = TypeVar("T")


class RuntimeProtocol(Protocol):
    """Protocol for the agent runtime interface."""
    
    agent_id: uuid.UUID
    
    async def use_model(self, model_type: str, params: dict[str, object]) -> str:
        """Use a model to generate a response."""
        ...


def parse_key_value_xml(text: str) -> dict[str, str] | None:
    """
    Parse key-value pairs from a simple XML structure.
    
    This is a Python equivalent of the TypeScript parseKeyValueXml function.
    It looks for a <response> block and extracts text content from child elements.
    
    Args:
        text: The input text containing the XML structure
        
    Returns:
        Parsed dictionary or None if parsing fails
    """
    # Find the response block
    response_match = re.search(r"<response>(.*?)</response>", text, re.DOTALL)
    if not response_match:
        # Try any root element
        root_match = re.search(r"<(\w+)>(.*?)</\1>", text, re.DOTALL)
        if not root_match:
            return None
        xml_content = root_match.group(2)
    else:
        xml_content = response_match.group(1)
    
    # Extract child elements
    result: dict[str, str] = {}
    for match in re.finditer(r"<(\w+)>([^<]*)</\1>", xml_content):
        key = match.group(1)
        value = match.group(2).strip()
        # Unescape common XML entities
        value = (
            value
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&amp;", "&")
            .replace("&quot;", '"')
            .replace("&apos;", "'")
        )
        result[key] = value
    
    return result if result else None


class FormsService:
    """
    FormsService manages form lifecycle and state.
    
    It provides methods to create, update, list, and cancel forms.
    """
    
    service_name = "forms"
    service_type = "forms"
    
    def __init__(self, runtime: RuntimeProtocol) -> None:
        """Initialize the forms service."""
        self.runtime = runtime
        self._forms: dict[uuid.UUID, Form] = {}
        self._templates: dict[str, FormTemplate] = {}
        self._register_default_templates()
    
    def _register_default_templates(self) -> None:
        """Register the default form templates."""
        # Basic contact form template
        self._templates["contact"] = FormTemplate(
            name="contact",
            description="Basic contact information form",
            steps=[
                FormStep(
                    id="basic-info",
                    name="Basic Information",
                    fields=[
                        FormField(
                            id="name",
                            label="Name",
                            type=FormFieldType.TEXT,
                            description="Your full name",
                            criteria="First and last name",
                        ),
                        FormField(
                            id="email",
                            label="Email",
                            type=FormFieldType.EMAIL,
                            description="Your email address",
                            criteria="Valid email format",
                        ),
                        FormField(
                            id="message",
                            label="Message",
                            type=FormFieldType.TEXTAREA,
                            description="Your message",
                            optional=True,
                        ),
                    ],
                ),
            ],
        )
    
    async def create_form(
        self,
        template_or_form: str | Form,
        metadata: dict[str, object] | None = None,
    ) -> Form:
        """
        Create a new form from a template or custom definition.
        
        Args:
            template_or_form: Template name or Form object
            metadata: Optional metadata for the form
            
        Returns:
            The created form
            
        Raises:
            ValueError: If template is not found
        """
        if isinstance(template_or_form, str):
            template = self._templates.get(template_or_form)
            if not template:
                raise ValueError(f'Template "{template_or_form}" not found')
            
            form = Form(
                id=uuid.uuid4(),
                agent_id=self.runtime.agent_id,
                name=template.name,
                description=template.description,
                steps=[
                    FormStep(
                        id=step.id,
                        name=step.name,
                        fields=[FormField(**field.model_dump()) for field in step.fields],
                        completed=False,
                    )
                    for step in template.steps
                ],
                current_step_index=0,
                status=FormStatus.ACTIVE,
                metadata=metadata,
            )
        else:
            form = template_or_form
            form.id = uuid.uuid4()
            form.agent_id = self.runtime.agent_id
            form.status = FormStatus.ACTIVE
        
        self._forms[form.id] = form
        return form
    
    async def update_form(
        self,
        form_id: uuid.UUID,
        message_text: str,
    ) -> FormUpdateResult:
        """
        Update form with extracted values from user message.
        
        Args:
            form_id: ID of the form to update
            message_text: The user's message text
            
        Returns:
            Result of the update operation
        """
        form = self._forms.get(form_id)
        if not form:
            return FormUpdateResult(success=False, message="Form not found")
        
        if form.status != FormStatus.ACTIVE:
            return FormUpdateResult(success=False, message="Form is not active")
        
        current_step = form.steps[form.current_step_index]
        
        # Get fields that need values
        fields_to_extract = [
            field for field in current_step.fields
            if field.value is None and not field.optional
        ]
        
        if not fields_to_extract:
            fields_to_extract = [
                field for field in current_step.fields
                if field.value is None
            ]
        
        # Extract values using LLM
        extracted = await self._extract_form_values(message_text, fields_to_extract)
        
        updated_fields: list[str] = []
        errors: list[FieldError] = []
        
        for field_id, value in extracted.items():
            field = next((f for f in current_step.fields if f.id == field_id), None)
            if field and value is not None:
                validated = self._validate_field_value(value, field)
                if validated["is_valid"]:
                    field.value = validated["value"]
                    field.error = None
                    updated_fields.append(field_id)
                else:
                    field.error = validated.get("error")
                    errors.append(FieldError(field_id=field_id, message=validated.get("error", "Invalid value")))
        
        # Check if step is complete
        required_fields = [f for f in current_step.fields if not f.optional]
        filled_required = [f for f in required_fields if f.value is not None]
        step_completed = len(filled_required) == len(required_fields)
        
        form_completed = False
        message = ""
        
        if step_completed:
            current_step.completed = True
            
            if form.current_step_index < len(form.steps) - 1:
                form.current_step_index += 1
                next_step = form.steps[form.current_step_index]
                message = f'Step "{current_step.name}" completed. Moving to step "{next_step.name}".'
            else:
                form.status = FormStatus.COMPLETED
                form.completed_at = datetime.now()
                form_completed = True
                message = "Form completed successfully!"
        else:
            missing = [f.label for f in required_fields if f.value is None]
            if missing:
                message = f"Please provide: {', '.join(missing)}"
        
        form.updated_at = datetime.now()
        
        return FormUpdateResult(
            success=True,
            form=form,
            updated_fields=updated_fields,
            errors=errors if errors else None,
            step_completed=step_completed,
            form_completed=form_completed,
            message=message,
        )
    
    async def _extract_form_values(
        self,
        text: str,
        fields: list[FormField],
    ) -> dict[str, str | int | float | bool]:
        """
        Extract form values from text using LLM with XML prompts.
        
        Args:
            text: User's message text
            fields: Fields to extract values for
            
        Returns:
            Dictionary of field_id to extracted value
        """
        if not fields:
            return {}
        
        # Build the extraction prompt
        field_dicts = [
            {
                "id": f.id,
                "type": f.type.value if isinstance(f.type, FormFieldType) else f.type,
                "label": f.label,
                "description": f.description or "",
                "criteria": f.criteria,
            }
            for f in fields
        ]
        
        prompt = build_extraction_prompt(text, field_dicts)
        
        # Call the LLM
        response = await self.runtime.use_model("TEXT_SMALL", {"prompt": prompt})
        
        # Parse the XML response
        parsed = parse_key_value_xml(response)
        if not parsed:
            return {}
        
        # Transform values based on field type
        result: dict[str, str | int | float | bool] = {}
        for field in fields:
            raw_value = parsed.get(field.id)
            if raw_value is None or raw_value == "":
                continue
            
            field_type = field.type.value if isinstance(field.type, FormFieldType) else field.type
            
            if field_type == "number":
                try:
                    result[field.id] = float(raw_value)
                except ValueError:
                    pass
            elif field_type == "checkbox":
                result[field.id] = raw_value.lower() in ("true", "1", "yes")
            elif field_type == "email":
                if "@" in raw_value and "." in raw_value:
                    result[field.id] = raw_value.strip()
            elif field_type == "url":
                if raw_value.startswith(("http://", "https://")):
                    result[field.id] = raw_value.strip()
            else:
                result[field.id] = raw_value.strip()
        
        return result
    
    def _validate_field_value(
        self,
        value: object,
        field: FormField,
    ) -> dict[str, object]:
        """
        Validate a field value based on its type.
        
        Args:
            value: The value to validate
            field: The field definition
            
        Returns:
            Dict with is_valid, value, and optional error
        """
        field_type = field.type.value if isinstance(field.type, FormFieldType) else field.type
        
        if field_type == "number":
            try:
                num = float(value)  # type: ignore
                return {"is_valid": True, "value": num}
            except (ValueError, TypeError):
                return {"is_valid": False, "error": "Must be a valid number"}
        
        if field_type == "email":
            val = str(value).strip()
            if "@" in val and "." in val:
                return {"is_valid": True, "value": val}
            return {"is_valid": False, "error": "Must be a valid email address"}
        
        if field_type == "url":
            val = str(value).strip()
            if val.startswith(("http://", "https://")):
                return {"is_valid": True, "value": val}
            return {"is_valid": False, "error": "Must be a valid URL"}
        
        if field_type == "tel":
            val = str(value).strip()
            if len(val) >= 7:
                return {"is_valid": True, "value": val}
            return {"is_valid": False, "error": "Must be a valid phone number"}
        
        if field_type == "checkbox":
            return {"is_valid": True, "value": bool(value)}
        
        # Default: accept strings
        if value is not None:
            return {"is_valid": True, "value": str(value)}
        
        return {"is_valid": False, "error": "Value is required"}
    
    async def list_forms(self, status: FormStatus | None = None) -> list[Form]:
        """List all forms, optionally filtered by status."""
        forms = [
            f for f in self._forms.values()
            if f.agent_id == self.runtime.agent_id
        ]
        if status:
            forms = [f for f in forms if f.status == status]
        return forms
    
    async def get_form(self, form_id: uuid.UUID) -> Form | None:
        """Get a specific form by ID."""
        form = self._forms.get(form_id)
        if form and form.agent_id == self.runtime.agent_id:
            return form
        return None
    
    async def cancel_form(self, form_id: uuid.UUID) -> bool:
        """Cancel a form."""
        form = self._forms.get(form_id)
        if not form or form.agent_id != self.runtime.agent_id:
            return False
        
        form.status = FormStatus.CANCELLED
        form.updated_at = datetime.now()
        return True
    
    def register_template(self, template: FormTemplate) -> None:
        """Register a form template."""
        self._templates[template.name] = template
    
    def get_templates(self) -> list[FormTemplate]:
        """Get all registered templates."""
        return list(self._templates.values())

