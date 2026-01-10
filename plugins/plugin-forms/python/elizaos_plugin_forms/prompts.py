"""
Shared XML prompts for the elizaOS Forms Plugin.

These prompts are auto-generated from prompts/*.txt files.
DO NOT EDIT - Generated from ../../dist/prompts/python/prompts.py

To modify prompts, edit the .txt files in prompts/ and run:
  npm run build:prompts
"""

# Import generated prompts
# Note: In a real deployment, these would be imported from the generated dist/prompts/python/prompts.py
# For now, we'll keep the builder functions here but reference the generated templates
try:
    from ...dist.prompts.python.prompts import (
        FORM_EXTRACTION_TEMPLATE,
        FORM_CREATION_TEMPLATE,
    )
except ImportError:
    # Fallback for development - import from generated location
    import sys
    from pathlib import Path
    
    # Add the dist/prompts/python directory to the path
    dist_path = Path(__file__).parent.parent.parent / "dist" / "prompts" / "python"
    if dist_path.exists():
        sys.path.insert(0, str(dist_path.parent))
        from prompts import (
            FORM_EXTRACTION_TEMPLATE,
            FORM_CREATION_TEMPLATE,
        )
    else:
        # Fallback to hardcoded templates if generated files don't exist
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
    """
    Build the form extraction prompt with the given user message and fields.
    
    Args:
        user_message: The user's message to extract values from
        fields: List of field dictionaries with id, type, label, description, and optional criteria
        
    Returns:
        The formatted prompt string
    """
    field_descriptions = "\n".join(
        f'  <field id="{f["id"]}" type="{f["type"]}" label="{f["label"]}"'
        f'{f" criteria=\"" + f["criteria"] + "\"" if f.get("criteria") else ""}>'
        f'{f.get("description", "")}</field>'
        for f in fields
    )
    
    field_templates = "\n".join(
        f'  <{f["id"]}>extracted value or omit if not found</{f["id"]}>'
        for f in fields
    )
    
    return (
        FORM_EXTRACTION_TEMPLATE
        .replace("{{user_message}}", user_message)
        .replace("{{field_descriptions}}", field_descriptions)
        .replace("{{field_templates}}", field_templates)
    )


# FORM_CREATION_TEMPLATE is imported above


def build_creation_prompt(
    user_message: str,
    available_types: list[str],
) -> str:
    """
    Build the form creation prompt with available form types.
    
    Args:
        user_message: The user's message requesting form creation
        available_types: List of available form type names
        
    Returns:
        The formatted prompt string
    """
    types_list = "\n".join(f"  <type>{t}</type>" for t in available_types)
    
    return (
        FORM_CREATION_TEMPLATE
        .replace("{{user_message}}", user_message)
        .replace("{{available_types}}", types_list)
    )

