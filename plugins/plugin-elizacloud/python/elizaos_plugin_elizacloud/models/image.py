from elizaos_plugin_elizacloud.providers import ElizaCloudClient
from elizaos_plugin_elizacloud.types import (
    ElizaCloudConfig,
    ImageDescriptionParams,
    ImageDescriptionResult,
    ImageGenerationParams,
)


async def handle_image_generation(
    config: ElizaCloudConfig,
    params: ImageGenerationParams,
) -> list[dict[str, str]]:
    async with ElizaCloudClient(config) as client:
        return await client.generate_image(params)


async def handle_image_description(
    config: ElizaCloudConfig,
    params: ImageDescriptionParams | str,
) -> ImageDescriptionResult:
    async with ElizaCloudClient(config) as client:
        return await client.describe_image(params)
