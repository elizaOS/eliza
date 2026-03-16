import tiktoken

from elizaos_plugin_elizacloud.types import (
    DetokenizeTextParams,
    ElizaCloudConfig,
    TokenizeTextParams,
)


def _get_model_name(config: ElizaCloudConfig, model_type: str) -> str:
    if model_type == "TEXT_SMALL":
        return config.small_model
    return config.large_model


def _get_encoding(model_name: str) -> tiktoken.Encoding:
    try:
        return tiktoken.encoding_for_model(model_name)
    except KeyError:
        return tiktoken.get_encoding("cl100k_base")


async def handle_tokenizer_encode(
    config: ElizaCloudConfig,
    params: TokenizeTextParams,
) -> list[int]:
    model_name = _get_model_name(config, params.model_type)
    encoding = _get_encoding(model_name)
    return encoding.encode(params.prompt)


async def handle_tokenizer_decode(
    config: ElizaCloudConfig,
    params: DetokenizeTextParams,
) -> str:
    model_name = _get_model_name(config, params.model_type)
    encoding = _get_encoding(model_name)
    return encoding.decode(params.tokens)
