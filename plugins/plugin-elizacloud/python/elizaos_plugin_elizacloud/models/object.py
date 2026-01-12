import json
import re

from elizaos_plugin_elizacloud.providers import ElizaCloudClient
from elizaos_plugin_elizacloud.types import ElizaCloudConfig, ObjectGenerationParams


def _parse_json_response(content: str) -> dict[str, object]:
    json_match = re.search(r"```(?:json)?\s*([\s\S]*?)```", content)
    if json_match:
        content = json_match.group(1).strip()

    try:
        return dict(json.loads(content))
    except json.JSONDecodeError:
        obj_match = re.search(r"\{[\s\S]*\}", content)
        if obj_match:
            return dict(json.loads(obj_match.group(0)))
        raise


async def handle_object_small(
    config: ElizaCloudConfig,
    params: ObjectGenerationParams,
) -> dict[str, object]:
    from elizaos_plugin_elizacloud.types import TextGenerationParams

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
    from elizaos_plugin_elizacloud.types import TextGenerationParams

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
