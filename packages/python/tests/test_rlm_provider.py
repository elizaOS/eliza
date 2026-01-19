import pytest

from elizaos.providers.rlm_provider import RLMProvider


@pytest.mark.asyncio
async def test_generate_text_stub_mode():
    """
    When AgentRLM is not available in the environment, the client should fallback
    to a harmless stub response.
    """
    provider = RLMProvider()
    params = {"prompt": "Hello, what is your name?"}
    result = await provider.generate_text(runtime=None, params=params)

    assert isinstance(result, dict)
    assert "text" in result
    assert isinstance(result["text"], str)
    assert result["text"] != ""


@pytest.mark.asyncio
async def test_generate_text_with_messages_list():
    """
    Passing a messages list should be accepted and returned as text (stub or real).
    """
    provider = RLMProvider()
    messages = [
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Say hello."},
    ]
    params = {"messages": messages}
    result = await provider.generate_text(runtime=None, params=params)

    assert isinstance(result, dict)
    assert "text" in result
    assert isinstance(result["text"], str)
