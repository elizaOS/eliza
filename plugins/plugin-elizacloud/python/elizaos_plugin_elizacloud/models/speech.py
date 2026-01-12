from elizaos_plugin_elizacloud.providers import ElizaCloudClient
from elizaos_plugin_elizacloud.types import ElizaCloudConfig, TextToSpeechParams


async def handle_text_to_speech(
    config: ElizaCloudConfig,
    params: TextToSpeechParams,
) -> bytes:
    async with ElizaCloudClient(config) as client:
        return await client.generate_speech(params)
