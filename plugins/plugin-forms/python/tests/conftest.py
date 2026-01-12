"""Pytest configuration and fixtures for forms plugin tests."""

import uuid
from typing import Any

import pytest


class MockRuntime:
    """Mock runtime for testing without API calls."""

    def __init__(self, agent_id: uuid.UUID | None = None) -> None:
        """Initialize mock runtime."""
        self._agent_id = agent_id or uuid.uuid4()
        self._model_responses: dict[str, str] = {}

    @property
    def agent_id(self) -> uuid.UUID:
        """Get the agent ID."""
        return self._agent_id

    def set_model_response(self, model_type: str, response: str) -> None:
        """Set a mock response for a model type."""
        self._model_responses[model_type] = response

    async def use_model(self, model_type: str, params: dict[str, Any]) -> str:
        """Mock model usage - returns predefined responses."""
        # Return a default XML response for form extraction
        if model_type == "TEXT_SMALL":
            if model_type in self._model_responses:
                return self._model_responses[model_type]
            # Default response that extracts name and email
            return """<response>
<name>John Doe</name>
<email>john@example.com</email>
</response>"""
        return ""


@pytest.fixture
def mock_runtime() -> MockRuntime:
    """Create a mock runtime fixture."""
    return MockRuntime()


@pytest.fixture
def agent_id() -> uuid.UUID:
    """Create a consistent agent ID for tests."""
    return uuid.UUID("12345678-1234-1234-1234-123456789012")
