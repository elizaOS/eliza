"""Image generation and description model handlers."""

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
    """Handle IMAGE model generation.
    
    Uses ElizaOS Cloud's custom /generate-image endpoint.
    
    Args:
        config: ElizaOS Cloud configuration.
        params: Image generation parameters.
        
    Returns:
        List of generated image data with URLs.
    """
    async with ElizaCloudClient(config) as client:
        return await client.generate_image(params)


async def handle_image_description(
    config: ElizaCloudConfig,
    params: ImageDescriptionParams | str,
) -> ImageDescriptionResult:
    """Handle IMAGE_DESCRIPTION model.
    
    Args:
        config: ElizaOS Cloud configuration.
        params: Image URL string or ImageDescriptionParams.
        
    Returns:
        Image description with title and description.
    """
    async with ElizaCloudClient(config) as client:
        return await client.describe_image(params)
