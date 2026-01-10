"""Text-to-speech model handler."""

from elizaos_plugin_elizacloud.providers import ElizaCloudClient
from elizaos_plugin_elizacloud.types import ElizaCloudConfig, TextToSpeechParams


async def handle_text_to_speech(
    config: ElizaCloudConfig,
    params: TextToSpeechParams,
) -> bytes:
    """Handle TEXT_TO_SPEECH model generation.
    
    Args:
        config: ElizaOS Cloud configuration.
        params: Text-to-speech parameters.
        
    Returns:
        Audio data as bytes.
    """
    async with ElizaCloudClient(config) as client:
        return await client.generate_speech(params)

