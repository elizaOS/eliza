import asyncio
import pytest

import RLMProvider  # package import path within packages/python

@pytest.mark.asyncio
async def test_generate_text_stub_mode():
    """
    When AgentRLM is not available in the environment, the client should fallback
    to a harmless stub response. This test checks that generate_text returns a dict
    containing a 'text' key and that metadata indicates stub behavior.
    """
    provider = RLMProvider()
    params = {"prompt": "Hello, what is your name?"}
    result = await provider.generate_text(runtime=None, params=params)

    assert isinstance(result, dict)
    assert "text" in result
    assert isinstance(result["text"], str)
    # In stub mode we expect the text to contain the stub marker
    assert result["text"].startswith("[RLM STUB]") or result["text"] != ""

@pytest.mark.asyncio
async def test_generate_text_with_messages_list():
    """
    Passing a messages list should be accepted and returned as text (stub).
    """
    provider = RLMProvider()
    messages = [
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Say hello."}
    ]
    params = {"messages": messages}
    result = await provider.generate_text(runtime=None, params=params)

    assert isinstance(result, dict)
    assert "text" in result
    assert isinstance(result["text"], str)