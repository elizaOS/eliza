from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING
from uuid import UUID

from elizaos.types import Service, ServiceType

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime


@dataclass
class FollowUpTask:
    entity_id: UUID
    reason: str
    message: str | None = None
    priority: str = "medium"
    scheduled_at: str = ""
    metadata: dict[str, str | int | float | bool] = field(default_factory=dict)


@dataclass
class FollowUpSuggestion:
    entity_id: UUID
    entity_name: str
    days_since_last_contact: int
    relationship_strength: float
    suggested_reason: str


class FollowUpService(Service):
    name = "follow_up"
    service_type = ServiceType.TASK

    @property
    def capability_description(self) -> str:
        return "Follow-up scheduling and reminder management service"

    def __init__(self) -> None:
        self._follow_ups: dict[UUID, FollowUpTask] = {}
        self._runtime: IAgentRuntime | None = None

    @classmethod
    async def start(cls, runtime: IAgentRuntime) -> FollowUpService:
        service = cls()
        service._runtime = runtime
        runtime.logger.info(
            "Follow-up service started",
            src="service:follow_up",
            agentId=str(runtime.agent_id),
        )
        return service

    async def stop(self) -> None:
        if self._runtime:
            self._runtime.logger.info(
                "Follow-up service stopped",
                src="service:follow_up",
                agentId=str(self._runtime.agent_id),
            )
        self._follow_ups.clear()
        self._runtime = None

    async def schedule_follow_up(
        self,
        entity_id: UUID,
        scheduled_at: datetime,
        reason: str,
        priority: str = "medium",
        message: str | None = None,
    ) -> FollowUpTask:
        task = FollowUpTask(
            entity_id=entity_id,
            reason=reason,
            message=message,
            priority=priority,
            scheduled_at=scheduled_at.isoformat(),
        )

        self._follow_ups[entity_id] = task

        if self._runtime:
            self._runtime.logger.info(
                f"Scheduled follow-up with {entity_id}",
                src="service:follow_up",
                scheduled_at=task.scheduled_at,
            )

        return task

    async def get_follow_up(self, entity_id: UUID) -> FollowUpTask | None:
        return self._follow_ups.get(entity_id)

    async def cancel_follow_up(self, entity_id: UUID) -> bool:
        if entity_id in self._follow_ups:
            del self._follow_ups[entity_id]
            return True
        return False

    async def get_upcoming_follow_ups(
        self,
        days_ahead: int = 7,
        include_overdue: bool = True,
    ) -> list[FollowUpTask]:
        now = datetime.now(UTC)
        results: list[FollowUpTask] = []

        for task in self._follow_ups.values():
            scheduled = datetime.fromisoformat(task.scheduled_at.replace("Z", "+00:00"))
            days_until = (scheduled - now).days

            if include_overdue and days_until < 0 or 0 <= days_until <= days_ahead:
                results.append(task)

        results.sort(key=lambda t: t.scheduled_at)
        return results

    async def get_overdue_follow_ups(self) -> list[FollowUpTask]:
        now = datetime.now(UTC)
        results: list[FollowUpTask] = []

        for task in self._follow_ups.values():
            scheduled = datetime.fromisoformat(task.scheduled_at.replace("Z", "+00:00"))
            if scheduled < now:
                results.append(task)

        return results

    async def get_follow_up_suggestions(
        self,
        max_suggestions: int = 5,
    ) -> list[FollowUpSuggestion]:
        return []

    async def complete_follow_up(self, entity_id: UUID) -> bool:
        return await self.cancel_follow_up(entity_id)
