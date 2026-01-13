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
    # Generated prompts not available - this should not happen in production
    # Prompts should be generated via build:prompts script
    raise ImportError(
        "Generated prompts not found. Run 'npm run build:prompts' to generate prompts."
    )


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
