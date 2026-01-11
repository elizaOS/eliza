"""Audio transcription model handler."""

from elizaos_plugin_elizacloud.providers import ElizaCloudClient
from elizaos_plugin_elizacloud.types import ElizaCloudConfig, TranscriptionParams


async def handle_transcription(
    config: ElizaCloudConfig,
    params: TranscriptionParams,
) -> str:
    """Handle TRANSCRIPTION model.
    
    Args:
        config: ElizaOS Cloud configuration.
        params: Transcription parameters.
        
    Returns:
        Transcribed text.
    """
    async with ElizaCloudClient(config) as client:
        return await client.transcribe_audio(params)


