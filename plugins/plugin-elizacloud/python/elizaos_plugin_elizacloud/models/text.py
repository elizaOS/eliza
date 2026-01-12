from elizaos_plugin_elizacloud.providers import ElizaCloudClient
from elizaos_plugin_elizacloud.types import ElizaCloudConfig, TextGenerationParams


async def handle_text_small(
    config: ElizaCloudConfig,
    params: TextGenerationParams,
) -> str:
    async with ElizaCloudClient(config) as client:
        return await client.generate_text(params, model_size="small")


async def handle_text_large(
    config: ElizaCloudConfig,
    params: TextGenerationParams,
) -> str:
    async with ElizaCloudClient(config) as client:
        return await client.generate_text(params, model_size="large")
