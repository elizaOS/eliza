"""Object/structured generation model handlers."""

import json
import re

from elizaos_plugin_elizacloud.providers import ElizaCloudClient
from elizaos_plugin_elizacloud.types import ElizaCloudConfig, ObjectGenerationParams


def _parse_json_response(content: str) -> dict[str, object]:
    """Parse JSON from model response, handling markdown code blocks."""
    # Try to extract JSON from markdown code blocks
    json_match = re.search(r"```(?:json)?\s*([\s\S]*?)```", content)
    if json_match:
        content = json_match.group(1).strip()
    
    # Try to parse as JSON
    try:
        return dict(json.loads(content))
    except json.JSONDecodeError:
        # If it fails, try to find JSON object in the content
        obj_match = re.search(r"\{[\s\S]*\}", content)
        if obj_match:
            return dict(json.loads(obj_match.group(0)))
        raise


async def handle_object_small(
    config: ElizaCloudConfig,
    params: ObjectGenerationParams,
) -> dict[str, object]:
    """Handle OBJECT_SMALL model generation.
    
    Generates structured JSON objects using the small model.
    
    Args:
        config: ElizaOS Cloud configuration.
        params: Object generation parameters.
        
    Returns:
        Generated object as a dictionary.
    """
    from elizaos_plugin_elizacloud.types import TextGenerationParams
    
    # Add JSON instruction to prompt
    enhanced_prompt = f"{params.prompt}\n\nRespond with valid JSON only."
    
    async with ElizaCloudClient(config) as client:
        text = await client.generate_text(
            TextGenerationParams(
                prompt=enhanced_prompt,
                temperature=params.temperature,
            ),
            model_size="small",
        )
        return _parse_json_response(text)


async def handle_object_large(
    config: ElizaCloudConfig,
    params: ObjectGenerationParams,
) -> dict[str, object]:
    """Handle OBJECT_LARGE model generation.
    
    Generates structured JSON objects using the large model.
    
    Args:
        config: ElizaOS Cloud configuration.
        params: Object generation parameters.
        
    Returns:
        Generated object as a dictionary.
    """
    from elizaos_plugin_elizacloud.types import TextGenerationParams
    
    # Add JSON instruction to prompt
    enhanced_prompt = f"{params.prompt}\n\nRespond with valid JSON only."
    
    async with ElizaCloudClient(config) as client:
        text = await client.generate_text(
            TextGenerationParams(
                prompt=enhanced_prompt,
                temperature=params.temperature,
            ),
            model_size="large",
        )
        return _parse_json_response(text)

