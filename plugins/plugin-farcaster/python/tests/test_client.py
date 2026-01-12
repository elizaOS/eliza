from __future__ import annotations

import pytest

from elizaos_plugin_farcaster.client import FarcasterClient, _split_post_content
from elizaos_plugin_farcaster.config import FarcasterConfig


@pytest.fixture
def client(mock_config: FarcasterConfig) -> FarcasterClient:
    return FarcasterClient(mock_config)


def test_split_post_content_short() -> None:
    text = "This is a short message."
    chunks = _split_post_content(text, max_length=320)
    assert len(chunks) == 1
    assert chunks[0] == text


def test_split_post_content_long() -> None:
    text = "A" * 400
    chunks = _split_post_content(text, max_length=320)
    assert len(chunks) == 2
    assert all(len(chunk) <= 320 for chunk in chunks)


def test_split_post_content_paragraphs() -> None:
    text = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph."
    chunks = _split_post_content(text, max_length=320)
    assert len(chunks) == 1


def test_split_post_content_long_paragraph() -> None:
    text = " ".join(["word"] * 100)
    chunks = _split_post_content(text, max_length=50)
    assert len(chunks) > 1
    assert all(len(chunk) <= 50 for chunk in chunks)


@pytest.mark.asyncio
async def test_client_send_cast_dry_run(client: FarcasterClient) -> None:
    casts = await client.send_cast("Hello Farcaster!")
    assert len(casts) == 1
    assert casts[0].hash == "dry_run_hash"
    assert casts[0].text == "Hello Farcaster!"


@pytest.mark.asyncio
async def test_client_send_cast_empty(client: FarcasterClient) -> None:
    casts = await client.send_cast("")
    assert len(casts) == 0


@pytest.mark.asyncio
async def test_client_send_cast_whitespace(client: FarcasterClient) -> None:
    casts = await client.send_cast("   ")
    assert len(casts) == 0


def test_client_clear_cache(client: FarcasterClient) -> None:
    client._profile_cache[12345] = None  # type: ignore
    client._cast_cache["abc"] = None  # type: ignore
    client.clear_cache()
    assert len(client._profile_cache) == 0
    assert len(client._cast_cache) == 0
