from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

from elizaos_plugin_google_genai import (
    EmbeddingParams,
    ObjectGenerationParams,
    TextGenerationParams,
)

if TYPE_CHECKING:
    from elizaos_plugin_google_genai import GoogleGenAIClient


@pytest.mark.asyncio
async def test_generate_text_small(client: GoogleGenAIClient) -> None:
    params = TextGenerationParams(
        prompt="What is 2+2? Answer with just the number.",
        max_tokens=10,
    )
    response = await client.generate_text_small(params)

    assert response.text
    assert "4" in response.text
    assert response.model


@pytest.mark.asyncio
async def test_generate_text_large(client: GoogleGenAIClient) -> None:
    response = await client.generate_text_large("Say hello in French.")

    assert response.text
    assert response.model


@pytest.mark.asyncio
async def test_generate_embedding(client: GoogleGenAIClient) -> None:
    params = EmbeddingParams(text="Hello, world!")
    response = await client.generate_embedding(params)

    assert response.embedding
    assert len(response.embedding) > 0
    assert response.model


@pytest.mark.asyncio
async def test_generate_object_small(client: GoogleGenAIClient) -> None:
    params = ObjectGenerationParams(
        prompt="Create a JSON object with a 'greeting' field that says 'hello'.",
    )
    response = await client.generate_object_small(params)

    assert response.object
    assert isinstance(response.object, dict)
    assert response.model


@pytest.mark.asyncio
async def test_generate_object_with_schema(client: GoogleGenAIClient) -> None:
    params = ObjectGenerationParams(
        prompt="Generate a person profile.",
        json_schema={
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "age": {"type": "number"},
            },
            "required": ["name", "age"],
        },
    )
    response = await client.generate_object_small(params)

    assert response.object
    assert "name" in response.object
    assert "age" in response.object
