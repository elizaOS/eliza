import pytest

from elizaos_plugin_groq.client import GroqClient, _extract_json
from elizaos_plugin_groq.error import GroqError, GroqErrorCode


class TestExtractJson:
    def test_code_block(self) -> None:
        text = '```json\n{"a": 1}\n```'
        assert _extract_json(text) == '{"a": 1}'

    def test_direct(self) -> None:
        text = 'Here is {"a": 1} the json'
        assert _extract_json(text) == '{"a": 1}'

    def test_array(self) -> None:
        text = "The array: [1, 2, 3]"
        assert _extract_json(text) == "[1, 2, 3]"


class TestGroqClient:
    def test_creation(self) -> None:
        client = GroqClient(api_key="test-key")
        assert client.config.api_key == "test-key"

    def test_no_key(self) -> None:
        with pytest.raises(GroqError) as exc:
            GroqClient(api_key="")
        assert exc.value.code == GroqErrorCode.INVALID_API_KEY

    def test_custom_url(self) -> None:
        client = GroqClient(api_key="key", base_url="https://custom.api.com")
        assert client.config.base_url == "https://custom.api.com"


class TestGroqError:
    def test_401(self) -> None:
        error = GroqError.from_response(401, "Unauthorized")
        assert error.code == GroqErrorCode.INVALID_API_KEY

    def test_429(self) -> None:
        error = GroqError.from_response(429, "Rate limit. try again in 2.5s")
        assert error.code == GroqErrorCode.RATE_LIMIT_EXCEEDED
        assert error.retry_after == 2.5
        assert error.is_retryable

    def test_500(self) -> None:
        error = GroqError.from_response(500, "Server error")
        assert error.code == GroqErrorCode.SERVER_ERROR
