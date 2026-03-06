"""
Shared fixtures for Signal plugin tests.

Provides mock runtimes, messages, rooms, and service instances
used across all test modules.
"""

import asyncio
from dataclasses import dataclass, field
from typing import Optional
from unittest.mock import AsyncMock, MagicMock

import pytest

from elizaos_plugin_signal.types import (
    SignalContact,
    SignalGroup,
    SignalGroupMember,
    SignalSettings,
    SIGNAL_SERVICE_NAME,
)


# ---------------------------------------------------------------------------
# Helpers – lightweight stand-ins for elizaOS runtime objects
# ---------------------------------------------------------------------------

class MockMessage:
    """Minimal message object matching what actions/providers expect."""

    def __init__(
        self,
        *,
        source: str = "signal",
        text: str = "",
        room_id: str = "room-1",
    ):
        self.content: dict[str, str] = {"source": source, "text": text}
        self.room_id = room_id


class MockRuntime:
    """Configurable mock runtime that actions/providers call into."""

    def __init__(
        self,
        *,
        settings: Optional[dict[str, str]] = None,
        service: object = None,
        room: Optional[dict] = None,
        model_response: str = "",
    ):
        self._settings = settings or {}
        self._service = service
        self._room = room
        self._model_response = model_response

    def get_setting(self, key: str) -> Optional[str]:
        return self._settings.get(key)

    def get_service(self, name: str) -> Optional[object]:
        if name == SIGNAL_SERVICE_NAME:
            return self._service
        return None

    async def get_room(self, room_id: str) -> Optional[dict]:
        return self._room

    async def use_model(self, model_name: str, params: dict) -> str:
        return self._model_response

    async def emit_event(self, event_type: str, data: dict) -> None:
        pass


class MockSignalService:
    """Mock for ``SignalService`` – every public method is an ``AsyncMock``."""

    def __init__(
        self,
        *,
        connected: bool = True,
        account_number: str = "+14155550100",
        contacts: Optional[list[SignalContact]] = None,
        groups: Optional[list[SignalGroup]] = None,
    ):
        self._connected = connected
        self._account_number = account_number
        self._contacts = contacts or []
        self._groups = groups or []

        # Expose async mocks for network-dependent methods
        self.send_message = AsyncMock(return_value={"timestamp": 1700000000000})
        self.send_group_message = AsyncMock(return_value={"timestamp": 1700000000001})
        self.send_reaction = AsyncMock(return_value={"success": True})
        self.remove_reaction = AsyncMock(return_value={"success": True})

    def is_service_connected(self) -> bool:
        return self._connected

    def get_account_number(self) -> str:
        return self._account_number

    async def get_contacts(self) -> list[SignalContact]:
        return list(self._contacts)

    async def get_groups(self) -> list[SignalGroup]:
        return list(self._groups)

    def get_contact(self, number: str) -> Optional[SignalContact]:
        for c in self._contacts:
            if c.number == number:
                return c
        return None

    def get_cached_group(self, group_id: str) -> Optional[SignalGroup]:
        for g in self._groups:
            if g.id == group_id:
                return g
        return None


# ---------------------------------------------------------------------------
# Reusable sample data
# ---------------------------------------------------------------------------

SAMPLE_CONTACTS = [
    SignalContact(
        number="+14155550101",
        uuid="a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
        name="Alice Johnson",
    ),
    SignalContact(
        number="+14155550102",
        uuid="b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e",
        profile_name="Bob",
    ),
    SignalContact(
        number="+14155550103",
        uuid="c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f",
        given_name="Charlie",
        family_name="Brown",
    ),
    SignalContact(
        number="+14155550104",
        blocked=True,
        name="Blocked User",
    ),
]

SAMPLE_MEMBERS = [
    SignalGroupMember(uuid="u1", number="+14155550101", role="ADMINISTRATOR"),
    SignalGroupMember(uuid="u2", number="+14155550102", role="DEFAULT"),
    SignalGroupMember(uuid="u3", number="+14155550103", role="DEFAULT"),
]

SAMPLE_GROUPS = [
    SignalGroup(
        id="YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=",
        name="Family Chat",
        description="A group for family members",
        members=SAMPLE_MEMBERS,
        is_member=True,
    ),
    SignalGroup(
        id="eHl6YWJjZGVmZ2hpamtsbW5vcHFyc3R1dg==",
        name="Work Team",
        members=SAMPLE_MEMBERS[:2],
        is_member=True,
    ),
    SignalGroup(
        id="bm90YW1lbWJlcmFueW1vcmVhdGFsbA====",
        name="Old Group",
        members=[],
        is_member=False,
    ),
    SignalGroup(
        id="YmxvY2tlZGdyb3VwaWRiYXNlNjRlbmM9",
        name="Spam Group",
        members=[],
        is_blocked=True,
    ),
]


# ---------------------------------------------------------------------------
# Pytest fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def sample_contacts() -> list[SignalContact]:
    return list(SAMPLE_CONTACTS)


@pytest.fixture
def sample_groups() -> list[SignalGroup]:
    return list(SAMPLE_GROUPS)


@pytest.fixture
def mock_signal_service(sample_contacts, sample_groups) -> MockSignalService:
    return MockSignalService(
        contacts=sample_contacts,
        groups=sample_groups,
    )


@pytest.fixture
def disconnected_signal_service() -> MockSignalService:
    return MockSignalService(connected=False)


@pytest.fixture
def signal_message() -> MockMessage:
    return MockMessage(source="signal", text="Hello from Signal")


@pytest.fixture
def non_signal_message() -> MockMessage:
    return MockMessage(source="discord", text="Hello from Discord")


@pytest.fixture
def dm_room() -> dict:
    return {
        "channel_id": "+14155550101",
        "name": "Alice DM",
        "metadata": {"is_group": False},
    }


@pytest.fixture
def group_room() -> dict:
    return {
        "channel_id": "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=",
        "name": "Family Chat",
        "metadata": {
            "is_group": True,
            "group_id": "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=",
        },
    }


@pytest.fixture
def dm_runtime(mock_signal_service, dm_room) -> MockRuntime:
    return MockRuntime(service=mock_signal_service, room=dm_room)


@pytest.fixture
def group_runtime(mock_signal_service, group_room) -> MockRuntime:
    return MockRuntime(service=mock_signal_service, room=group_room)
