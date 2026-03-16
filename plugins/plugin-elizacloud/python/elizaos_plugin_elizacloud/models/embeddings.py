from elizaos_plugin_elizacloud.providers import ElizaCloudClient
from elizaos_plugin_elizacloud.types import ElizaCloudConfig, TextEmbeddingParams


async def handle_text_embedding(
    config: ElizaCloudConfig,
    text: str,
) -> list[float]:
    async with ElizaCloudClient(config) as client:
        params = TextEmbeddingParams(text=text)
        result = await client.generate_embedding(params)
        if isinstance(result[0], float):
            return result  # type: ignore[return-value]
        return result[0]


async def handle_batch_text_embedding(
    config: ElizaCloudConfig,
    texts: list[str],
) -> list[list[float]]:
    if not texts:
        return []

    async with ElizaCloudClient(config) as client:
        params = TextEmbeddingParams(texts=texts)
        result = await client.generate_embedding(params)
        if isinstance(result[0], list):
            return result  # type: ignore[return-value]
        return [result]  # type: ignore[list-item]
