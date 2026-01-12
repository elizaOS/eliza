"""Pytest configuration and fixtures for simple-voice tests."""

import sys
from pathlib import Path

import pytest

# Add src to path for imports
src_path = Path(__file__).parent.parent / "src"
if str(src_path) not in sys.path:
    sys.path.insert(0, str(src_path))


class MockMemory:
    """Mock memory class for testing."""

    def __init__(self, text: str) -> None:
        self._content: dict[str, str] = {"text": text}

    @property
    def content(self) -> dict[str, str]:
        return self._content


class MockHardwareBridge:
    """Mock hardware bridge for testing."""

    def __init__(self) -> None:
        self.last_audio: bytes | None = None

    async def send_audio_data(self, audio_buffer: bytes) -> None:
        self.last_audio = audio_buffer


class MockRuntime:
    """Mock runtime class for testing."""

    def __init__(self) -> None:
        self._services: dict[str, object] = {}

    def get_service(self, service_type: str) -> object | None:
        return self._services.get(service_type)

    def register_service(self, service_type: str, service: object) -> None:
        self._services[service_type] = service


@pytest.fixture
def mock_runtime() -> MockRuntime:
    """Provide a mock runtime."""
    return MockRuntime()


@pytest.fixture
def mock_memory() -> type[MockMemory]:
    """Provide mock memory factory."""
    return MockMemory


@pytest.fixture
def mock_hardware_bridge() -> MockHardwareBridge:
    """Provide a mock hardware bridge."""
    return MockHardwareBridge()
