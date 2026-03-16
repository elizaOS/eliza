from elizaos_plugin_elizacloud.providers import ElizaCloudClient
from elizaos_plugin_elizacloud.types import ElizaCloudConfig, TranscriptionParams


async def handle_transcription(
    config: ElizaCloudConfig,
    params: TranscriptionParams,
) -> str:
    async with ElizaCloudClient(config) as client:
        return await client.transcribe_audio(params)
