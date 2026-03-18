"""Shared test fixtures for the scheduling plugin tests."""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any, Optional

import pytest

from elizaos_plugin_scheduling.config import SchedulingServiceConfig
from elizaos_plugin_scheduling.service import SchedulingService
from elizaos_plugin_scheduling.types import (
    Availability,
    AvailabilityWindow,
    DayOfWeek,
    LocationType,
    Meeting,
    MeetingLocation,
    MeetingParticipant,
    MeetingStatus,
    Participant,
    ParticipantRole,
    SchedulingConstraints,
    SchedulingRequest,
    SchedulingUrgency,
    TimeSlot,
)


# ============================================================================
# MOCK COMPONENT
# ============================================================================


@dataclass
class MockComponent:
    id: str
    entity_id: str
    agent_id: str
    room_id: str
    world_id: str
    source_entity_id: str
    type: str
    created_at: int
    data: dict[str, Any]


# ============================================================================
# MOCK RUNTIME
# ============================================================================


class MockAgentRuntime:
    """Mock elizaOS agent runtime for testing."""

    def __init__(self) -> None:
        self._agent_id = str(uuid.uuid4())
        self._components: dict[str, dict[str, MockComponent]] = {}
        self._services: dict[str, Any] = {}

    @property
    def agent_id(self) -> str:
        return self._agent_id

    async def get_component(self, entity_id: str, component_type: str) -> Optional[MockComponent]:
        entity_comps = self._components.get(entity_id, {})
        return entity_comps.get(component_type)

    async def create_component(self, component: Any) -> None:
        data = component if isinstance(component, dict) else vars(component)
        entity_id = data["entity_id"]
        comp_type = data["type"]
        if entity_id not in self._components:
            self._components[entity_id] = {}
        self._components[entity_id][comp_type] = MockComponent(**data)

    async def update_component(self, component: Any) -> None:
        await self.create_component(component)

    async def delete_component(self, component_id: str) -> None:
        for entity_id in list(self._components):
            for comp_type, comp in list(self._components[entity_id].items()):
                if comp.id == component_id:
                    del self._components[entity_id][comp_type]
                    return

    async def get_components(self, entity_id: str) -> list[MockComponent]:
        return list(self._components.get(entity_id, {}).values())

    def get_service(self, service_type: str) -> Optional[Any]:
        return self._services.get(service_type)

    def register_service(self, service_type: str, service: Any) -> None:
        self._services[service_type] = service


# ============================================================================
# FIXTURES
# ============================================================================


@pytest.fixture
def mock_runtime() -> MockAgentRuntime:
    return MockAgentRuntime()


@pytest.fixture
def scheduling_service(mock_runtime: MockAgentRuntime) -> SchedulingService:
    config = SchedulingServiceConfig(
        auto_send_calendar_invites=False,
        auto_schedule_reminders=False,
    )
    return SchedulingService(mock_runtime, config)


@pytest.fixture
def sample_availability() -> Availability:
    return Availability(
        time_zone="America/New_York",
        weekly=[
            AvailabilityWindow(day=DayOfWeek.MON, start_minutes=540, end_minutes=1020),
            AvailabilityWindow(day=DayOfWeek.TUE, start_minutes=540, end_minutes=1020),
            AvailabilityWindow(day=DayOfWeek.WED, start_minutes=540, end_minutes=1020),
            AvailabilityWindow(day=DayOfWeek.THU, start_minutes=540, end_minutes=1020),
            AvailabilityWindow(day=DayOfWeek.FRI, start_minutes=540, end_minutes=1020),
        ],
        exceptions=[],
    )


@pytest.fixture
def sample_participant(sample_availability: Availability) -> Participant:
    return Participant(
        entity_id=str(uuid.uuid4()),
        name="Alice",
        email="alice@example.com",
        availability=sample_availability,
    )


@pytest.fixture
def sample_participant_b() -> Participant:
    return Participant(
        entity_id=str(uuid.uuid4()),
        name="Bob",
        email="bob@example.com",
        availability=Availability(
            time_zone="America/New_York",
            weekly=[
                AvailabilityWindow(day=DayOfWeek.MON, start_minutes=600, end_minutes=960),
                AvailabilityWindow(day=DayOfWeek.WED, start_minutes=600, end_minutes=960),
                AvailabilityWindow(day=DayOfWeek.FRI, start_minutes=600, end_minutes=960),
            ],
            exceptions=[],
        ),
    )


@pytest.fixture
def sample_scheduling_request(
    sample_participant: Participant, sample_participant_b: Participant
) -> SchedulingRequest:
    return SchedulingRequest(
        id=str(uuid.uuid4()),
        room_id=str(uuid.uuid4()),
        title="Test Meeting",
        participants=[sample_participant, sample_participant_b],
        constraints=SchedulingConstraints(
            min_duration_minutes=30,
            preferred_duration_minutes=60,
            max_days_out=7,
        ),
        urgency=SchedulingUrgency.FLEXIBLE,
        created_at=1700000000000,
    )


@pytest.fixture
def sample_meeting(sample_participant: Participant) -> Meeting:
    return Meeting(
        id=str(uuid.uuid4()),
        request_id=str(uuid.uuid4()),
        room_id=str(uuid.uuid4()),
        title="Coffee Chat",
        slot=TimeSlot(
            start="2030-01-20T15:00:00Z",
            end="2030-01-20T16:00:00Z",
            time_zone="America/New_York",
        ),
        location=MeetingLocation(
            type=LocationType.VIRTUAL,
            video_url="https://meet.example.com/abc",
        ),
        participants=[
            MeetingParticipant(
                entity_id=sample_participant.entity_id,
                name="Alice",
                email="alice@example.com",
                role=ParticipantRole.ORGANIZER,
                confirmed=False,
            ),
            MeetingParticipant(
                entity_id=str(uuid.uuid4()),
                name="Bob",
                email="bob@example.com",
                role=ParticipantRole.REQUIRED,
                confirmed=False,
            ),
        ],
        status=MeetingStatus.PROPOSED,
        reschedule_count=0,
        created_at=1700000000000,
        updated_at=1700000000000,
    )
