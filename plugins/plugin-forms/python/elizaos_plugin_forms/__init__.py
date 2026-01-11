"""
elizaOS Forms Plugin - Structured conversational data collection.

This plugin provides form management capabilities for collecting structured data
from users through natural conversation.
"""

from elizaos_plugin_forms.prompts import FORM_EXTRACTION_PROMPT
from elizaos_plugin_forms.service import FormsService
from elizaos_plugin_forms.types import (
    Form,
    FormField,
    FormFieldType,
    FormStatus,
    FormStep,
    FormTemplate,
    FormUpdateResult,
)

__all__ = [
    "Form",
    "FormField",
    "FormFieldType",
    "FormStatus",
    "FormStep",
    "FormTemplate",
    "FormUpdateResult",
    "FormsService",
    "FORM_EXTRACTION_PROMPT",
]

__version__ = "1.2.0"





