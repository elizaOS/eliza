# Define default prompts (may be overridden by generated prompts if available)
FORM_EXTRACTION_TEMPLATE: str
FORM_CREATION_TEMPLATE: str

try:
    from elizaos_plugin_forms._generated_prompts import (  # type: ignore[import-not-found]
        FORM_CREATION_TEMPLATE as _FORM_CREATION_TEMPLATE,
    )
    from elizaos_plugin_forms._generated_prompts import (
        FORM_EXTRACTION_TEMPLATE as _FORM_EXTRACTION_TEMPLATE,
    )
    FORM_EXTRACTION_TEMPLATE = _FORM_EXTRACTION_TEMPLATE
    FORM_CREATION_TEMPLATE = _FORM_CREATION_TEMPLATE
except ImportError:
    # Use default prompts when generated prompts are not available
    FORM_EXTRACTION_TEMPLATE = """# Task: Extract Form Field Values

## User Message
<user_message>
{{user_message}}
</user_message>

## Fields to Extract
<fields>
{{field_descriptions}}
</fields>

## Instructions
Parse the user's message and extract values for the listed form fields.
Only extract values that are explicitly stated in the message.
If a value cannot be found, omit that field from the response.

Return your response in XML format:
<response>
{{field_templates}}
</response>

Be precise and extract only what is explicitly stated."""

    FORM_CREATION_TEMPLATE = """# Task: Identify Form Type

## User Message
<user_message>
{{user_message}}
</user_message>

## Available Form Types
<form_types>
{{available_types}}
</form_types>

## Instructions
Analyze the user's message and determine which form type they want to create.
If the request doesn't match any available type, suggest the closest match.

Return your response in XML format:
<response>
  <form_type>the matched form type name</form_type>
  <confidence>high, medium, or low</confidence>
  <reasoning>brief explanation of why this type was selected</reasoning>
</response>"""


def _format_field_xml(field: dict[str, str]) -> str:
    """Format a field as XML for extraction prompt."""
    field_id = field["id"]
    field_type = field["type"]
    label = field["label"]
    criteria = field.get("criteria")
    description = field.get("description", "")
    criteria_attr = f' criteria="{criteria}"' if criteria else ""
    return f'  <field id="{field_id}" type="{field_type}" label="{label}"{criteria_attr}>{description}</field>'


def build_extraction_prompt(
    user_message: str,
    fields: list[dict[str, str]],
) -> str:
    field_descriptions = "\n".join(_format_field_xml(f) for f in fields)

    field_templates = "\n".join(
        f"  <{f['id']}>extracted value or omit if not found</{f['id']}>" for f in fields
    )

    return (
        FORM_EXTRACTION_TEMPLATE.replace("{{user_message}}", user_message)
        .replace("{{field_descriptions}}", field_descriptions)
        .replace("{{field_templates}}", field_templates)
    )


def build_creation_prompt(
    user_message: str,
    available_types: list[str],
) -> str:
    types_list = "\n".join(f"  <type>{t}</type>" for t in available_types)

    return FORM_CREATION_TEMPLATE.replace("{{user_message}}", user_message).replace(
        "{{available_types}}", types_list
    )
