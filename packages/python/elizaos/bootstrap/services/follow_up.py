"""
Follow-Up Service - Manages follow-up scheduling and reminders.

This service provides follow-up management capabilities for tracking
when to reconnect with contacts.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import TYPE_CHECKING
from uuid import UUID, uuid4

from elizaos.types import Service, ServiceType

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Task


@dataclass
class FollowUpTask:
    """Follow-up task data."""
    
    entity_id: UUID
    reason: str
    message: str | None = None
    priority: str = "medium"  # high, medium, low
    scheduled_at: str = ""
    metadata: dict[str, str | int | float | bool] = field(default_factory=dict)


@dataclass
class FollowUpSuggestion:
    """Follow-up suggestion."""
    
    entity_id: UUID
    entity_name: str
    days_since_last_contact: int
    relationship_strength: float
    suggested_reason: str


class FollowUpService(Service):
    """
    Service for managing follow-up reminders.
    
    Provides capabilities for:
    - Scheduling follow-ups with contacts
    - Getting upcoming follow-ups
    - Generating follow-up suggestions
    """
    
    name = "follow_up"
    service_type = ServiceType.TASK
    
    @property
    def capability_description(self) -> str:
        """Get the capability description for this service."""
        return "Follow-up scheduling and reminder management service"
    
    def __init__(self) -> None:
        """Initialize the follow-up service."""
        self._follow_ups: dict[UUID, FollowUpTask] = {}
        self._runtime: IAgentRuntime | None = None
    
    async def start(self, runtime: IAgentRuntime) -> None:
        """Start the follow-up service."""
        self._runtime = runtime
        runtime.logger.info(
            "Follow-up service started",
            src="service:follow_up",
            agentId=str(runtime.agent_id),
        )
    
    async def stop(self) -> None:
        """Stop the follow-up service."""
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
        """Schedule a follow-up with a contact."""
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
        """Get a scheduled follow-up by entity ID."""
        return self._follow_ups.get(entity_id)
    
    async def cancel_follow_up(self, entity_id: UUID) -> bool:
        """Cancel a scheduled follow-up."""
        if entity_id in self._follow_ups:
            del self._follow_ups[entity_id]
            return True
        return False
    
    async def get_upcoming_follow_ups(
        self,
        days_ahead: int = 7,
        include_overdue: bool = True,
    ) -> list[FollowUpTask]:
        """Get upcoming follow-ups within the specified timeframe."""
        now = datetime.now(timezone.utc)
        results: list[FollowUpTask] = []
        
        for task in self._follow_ups.values():
            try:
                scheduled = datetime.fromisoformat(task.scheduled_at.replace("Z", "+00:00"))
                days_until = (scheduled - now).days
                
                if include_overdue and days_until < 0:
                    results.append(task)
                elif 0 <= days_until <= days_ahead:
                    results.append(task)
            except Exception:
                continue
        
        # Sort by scheduled time
        results.sort(key=lambda t: t.scheduled_at)
        return results
    
    async def get_overdue_follow_ups(self) -> list[FollowUpTask]:
        """Get all overdue follow-ups."""
        now = datetime.now(timezone.utc)
        results: list[FollowUpTask] = []
        
        for task in self._follow_ups.values():
            try:
                scheduled = datetime.fromisoformat(task.scheduled_at.replace("Z", "+00:00"))
                if scheduled < now:
                    results.append(task)
            except Exception:
                continue
        
        return results
    
    async def get_follow_up_suggestions(
        self,
        max_suggestions: int = 5,
    ) -> list[FollowUpSuggestion]:
        """Generate follow-up suggestions based on contact activity."""
        # This would integrate with RolodexService in a full implementation
        # For now, return empty list as placeholder
        return []
    
    async def complete_follow_up(self, entity_id: UUID) -> bool:
        """Mark a follow-up as completed."""
        return await self.cancel_follow_up(entity_id)

