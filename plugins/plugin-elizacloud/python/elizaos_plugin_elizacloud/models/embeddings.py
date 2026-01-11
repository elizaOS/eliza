"""Text embedding model handlers."""

from elizaos_plugin_elizacloud.providers import ElizaCloudClient
from elizaos_plugin_elizacloud.types import ElizaCloudConfig, TextEmbeddingParams


async def handle_text_embedding(
    config: ElizaCloudConfig,
    text: str,
) -> list[float]:
    """Handle TEXT_EMBEDDING model for a single text.
    
    Args:
        config: ElizaOS Cloud configuration.
        text: Text to embed.
        
    Returns:
        Embedding vector as list of floats.
    """
    async with ElizaCloudClient(config) as client:
        params = TextEmbeddingParams(text=text)
        result = await client.generate_embedding(params)
        # Single text returns single embedding
        if isinstance(result[0], float):
            return result  # type: ignore[return-value]
        return result[0]


async def handle_batch_text_embedding(
    config: ElizaCloudConfig,
    texts: list[str],
) -> list[list[float]]:
    """Handle batch TEXT_EMBEDDING for multiple texts.
    
    Args:
        config: ElizaOS Cloud configuration.
        texts: List of texts to embed.
        
    Returns:
        List of embedding vectors.
    """
    if not texts:
        return []
    
    async with ElizaCloudClient(config) as client:
        params = TextEmbeddingParams(texts=texts)
        result = await client.generate_embedding(params)
        # Batch returns list of embeddings
        if isinstance(result[0], list):
            return result  # type: ignore[return-value]
        return [result]  # type: ignore[list-item]


