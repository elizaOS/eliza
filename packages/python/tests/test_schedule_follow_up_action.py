from __future__ import annotations

from dataclasses import dataclass
from types import SimpleNamespace
from typing import Protocol

import pytest

from elizaos.advanced_capabilities.actions.schedule_follow_up import (
    schedule_follow_up_action as advanced_schedule_follow_up_action,
)
from elizaos.advanced_capabilities.actions.schedule_follow_up import (
    schedule_follow_up_action as basic_capabilities_schedule_follow_up_action,
)
from elizaos.advanced_capabilities.services.follow_up import FollowUpService
from elizaos.advanced_capabilities.services.rolodex import RolodexService
from elizaos.types import Content, Memory, as_uuid


class RolodexLike(Protocol):
    async def search_contacts(
        self,
        categories: list[str] | None = None,
        tags: list[str] | None = None,
        search_term: str | None = None,
    ) -> list[SimpleNamespace]: ...

    async def get_contact(self, entity_id: object) -> SimpleNamespace | None: ...


class ActionLike(Protocol):
    async def handler(
        self,
        runtime: object,
        message: Memory,
        state: object | None,
        options: object | None,
        callback: object | None,
        responses: list[Memory] | None,
    ) -> object: ...


@dataclass
class FakeFollowUpCall:
    entity_id: object
    priority: str


class FakeFollowUpService(FollowUpService):
    def __init__(self) -> None:
        self.calls: list[FakeFollowUpCall] = []

    async def schedule_follow_up(
        self,
        entity_id: object,
        scheduled_at: object,
        reason: str,
        priority: str = "medium",
        message: str | None = None,
    ) -> SimpleNamespace:
        self.calls.append(FakeFollowUpCall(entity_id=entity_id, priority=priority))
        return SimpleNamespace(
            entity_id=entity_id,
            scheduled_at=str(scheduled_at),
            reason=reason,
            priority=priority,
            message=message,
        )


class FakeRolodexService(RolodexService):
    def __init__(self, contacts: list[SimpleNamespace]) -> None:
        self._contacts = contacts

    async def search_contacts(
        self,
        categories: list[str] | None = None,
        tags: list[str] | None = None,
        search_term: str | None = None,
    ) -> list[SimpleNamespace]:
        if not search_term:
            return self._contacts
        lowered = search_term.lower()
        return [
            contact
            for contact in self._contacts
            if lowered in str(contact.entity_id).lower()
            or lowered in str(getattr(contact, "name", "")).lower()
        ]

    async def get_contact(self, entity_id: object) -> SimpleNamespace | None:
        for contact in self._contacts:
            if contact.entity_id == entity_id:
                return contact
        return None


class FakeRuntime:
    def __init__(self, rolodex: RolodexLike, follow_up: FakeFollowUpService, response: str) -> None:
        self._rolodex = rolodex
        self._follow_up = follow_up
        self._response = response

    def get_service(self, name: str) -> object | None:
        if name == "rolodex":
            return self._rolodex
        if name == "follow_up":
            return self._follow_up
        return None

    async def compose_state(self, _message: Memory, _providers: list[str]) -> SimpleNamespace:
        return SimpleNamespace(values={}, data={}, text="")

    def get_setting(self, _key: str) -> object | None:
        return None

    def compose_prompt_from_state(self, state: object, template: str) -> str:
        return f"{template}\n{state}"

    async def use_model(self, _model_type: object, _params: dict[str, object]) -> str:
        return self._response


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "action_under_test",
    [basic_capabilities_schedule_follow_up_action, advanced_schedule_follow_up_action],
)
async def test_schedule_follow_up_fails_when_contact_unresolved(
    action_under_test: ActionLike,
) -> None:
    follow_up_service = FakeFollowUpService()
    rolodex_service = FakeRolodexService(contacts=[])
    runtime = FakeRuntime(
        rolodex=rolodex_service,
        follow_up=follow_up_service,
        response=(
            "<response>"
            "<contactName>missing-contact</contactName>"
            "<scheduledAt>2026-01-02T12:00:00Z</scheduledAt>"
            "<reason>Check-in</reason>"
            "<priority>high</priority>"
            "</response>"
        ),
    )

    message = Memory(
        id=as_uuid("70000000-0000-0000-0000-000000000001"),
        room_id=as_uuid("70000000-0000-0000-0000-000000000002"),
        entity_id=None,
        content=Content(text="follow up with missing-contact next week"),
    )

    result = await action_under_test.handler(
        runtime,
        message,
        None,
        None,
        None,
        None,
    )

    assert result is not None
    assert result.success is False
    assert len(follow_up_service.calls) == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "action_under_test",
    [basic_capabilities_schedule_follow_up_action, advanced_schedule_follow_up_action],
)
async def test_schedule_follow_up_normalizes_priority_and_schedules(
    action_under_test: ActionLike,
) -> None:
    follow_up_service = FakeFollowUpService()
    contact_id = as_uuid("80000000-0000-0000-0000-000000000001")
    rolodex_service = FakeRolodexService(
        contacts=[SimpleNamespace(entity_id=contact_id, name="known-contact")]
    )
    runtime = FakeRuntime(
        rolodex=rolodex_service,
        follow_up=follow_up_service,
        response=(
            "<response>"
            "<contactName>known-contact</contactName>"
            "<scheduledAt>2026-01-03T09:30:00Z</scheduledAt>"
            "<reason>Status update</reason>"
            "<priority>urgent</priority>"
            "</response>"
        ),
    )

    message = Memory(
        id=as_uuid("80000000-0000-0000-0000-000000000002"),
        room_id=as_uuid("80000000-0000-0000-0000-000000000003"),
        entity_id=None,
        content=Content(text="schedule follow-up with known-contact"),
    )

    result = await action_under_test.handler(
        runtime,
        message,
        None,
        None,
        None,
        None,
    )

    assert result is not None
    assert result.success is True
    assert len(follow_up_service.calls) == 1
    assert follow_up_service.calls[0].priority == "medium"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "action_under_test",
    [basic_capabilities_schedule_follow_up_action, advanced_schedule_follow_up_action],
)
async def test_schedule_follow_up_rejects_invalid_scheduled_at(
    action_under_test: ActionLike,
) -> None:
    follow_up_service = FakeFollowUpService()
    contact_id = as_uuid("90000000-0000-0000-0000-000000000001")
    rolodex_service = FakeRolodexService(
        contacts=[SimpleNamespace(entity_id=contact_id, name="known-contact")]
    )
    runtime = FakeRuntime(
        rolodex=rolodex_service,
        follow_up=follow_up_service,
        response=(
            "<response>"
            "<contactName>known-contact</contactName>"
            "<scheduledAt>not-a-date</scheduledAt>"
            "<reason>Status update</reason>"
            "<priority>high</priority>"
            "</response>"
        ),
    )

    message = Memory(
        id=as_uuid("90000000-0000-0000-0000-000000000002"),
        room_id=as_uuid("90000000-0000-0000-0000-000000000003"),
        entity_id=None,
        content=Content(text="schedule follow-up with known-contact"),
    )

    result = await action_under_test.handler(
        runtime,
        message,
        None,
        None,
        None,
        None,
    )

    assert result is not None
    assert result.success is False
    assert len(follow_up_service.calls) == 0
