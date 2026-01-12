try:
    from ...typescript.generated.prompts.python.prompts import (
        FORM_CREATION_TEMPLATE,
        FORM_EXTRACTION_TEMPLATE,
    )
except ImportError:
    import sys
    from pathlib import Path

    # Add the generated prompts directory to the path
    dist_path = (
        Path(__file__).parent.parent.parent / "typescript" / "generated" / "prompts" / "python"
    )
    if dist_path.exists():
        sys.path.insert(0, str(dist_path.parent))
        from prompts import (
            FORM_CREATION_TEMPLATE,
            FORM_EXTRACTION_TEMPLATE,
        )
    else:
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


def build_extraction_prompt(
    user_message: str,
    fields: list[dict[str, str]],
) -> str:
    field_descriptions = "\n".join(
        f'  <field id="{f["id"]}" type="{f["type"]}" label="{f["label"]}"'
        f"{' criteria="' + f['criteria'] + '"' if f.get('criteria') else ''}>"
        f"{f.get('description', '')}</field>"
        for f in fields
    )

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
