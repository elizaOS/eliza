from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import TYPE_CHECKING
from uuid import UUID

from elizaos.types import Service, ServiceType

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime


class ContactCategory(str, Enum):
    FRIEND = "friend"
    FAMILY = "family"
    COLLEAGUE = "colleague"
    ACQUAINTANCE = "acquaintance"
    VIP = "vip"
    BUSINESS = "business"


@dataclass
class ContactPreferences:
    preferred_channel: str | None = None
    timezone: str | None = None
    language: str | None = None
    contact_frequency: str | None = None
    do_not_disturb: bool = False
    notes: str | None = None


@dataclass
class ContactInfo:
    entity_id: UUID
    categories: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    preferences: ContactPreferences = field(default_factory=ContactPreferences)
    custom_fields: dict[str, str | int | float | bool] = field(default_factory=dict)
    privacy_level: str = "private"
    last_modified: str = ""


@dataclass
class RelationshipAnalytics:
    strength: float = 0.0
    interaction_count: int = 0
    last_interaction_at: str | None = None
    average_response_time: float | None = None
    sentiment_score: float | None = None
    topics_discussed: list[str] = field(default_factory=list)


def calculate_relationship_strength(
    interaction_count: int,
    last_interaction_at: str | None = None,
    message_quality: float = 5.0,
    relationship_type: str = "acquaintance",
) -> float:
    interaction_score = min(interaction_count * 2, 40)

    recency_score = 0.0
    if last_interaction_at:
        last_dt = datetime.fromisoformat(last_interaction_at.replace("Z", "+00:00"))
        days_since = (datetime.now(last_dt.tzinfo) - last_dt).days
        if days_since < 1:
            recency_score = 30
        elif days_since < 7:
            recency_score = 25
        elif days_since < 30:
            recency_score = 15
        elif days_since < 90:
            recency_score = 5

    quality_score = min(message_quality * 2, 20)

    relationship_bonus = {
        "family": 10,
        "friend": 8,
        "colleague": 6,
        "acquaintance": 4,
        "unknown": 0,
    }

    total = (
        interaction_score
        + recency_score
        + quality_score
        + relationship_bonus.get(relationship_type, 0)
    )
    return max(0.0, min(100.0, round(total, 1)))


class RolodexService(Service):
    name = "rolodex"
    service_type = ServiceType.UNKNOWN

    @property
    def capability_description(self) -> str:
        return "Comprehensive contact and relationship management service"

    def __init__(self) -> None:
        self._contacts: dict[UUID, ContactInfo] = {}
        self._analytics: dict[str, RelationshipAnalytics] = {}
        self._runtime: IAgentRuntime | None = None

    @classmethod
    async def start(cls, runtime: IAgentRuntime) -> RolodexService:
        service = cls()
        service._runtime = runtime
        runtime.logger.info(
            "Rolodex service started",
            src="service:rolodex",
            agentId=str(runtime.agent_id),
        )
        return service

    async def stop(self) -> None:
        if self._runtime:
            self._runtime.logger.info(
                "Rolodex service stopped",
                src="service:rolodex",
                agentId=str(self._runtime.agent_id),
            )
        self._contacts.clear()
        self._analytics.clear()
        self._runtime = None

    async def add_contact(
        self,
        entity_id: UUID,
        categories: list[str] | None = None,
        preferences: ContactPreferences | None = None,
        custom_fields: dict[str, str | int | float | bool] | None = None,
    ) -> ContactInfo:
        contact = ContactInfo(
            entity_id=entity_id,
            categories=categories or ["acquaintance"],
            tags=[],
            preferences=preferences or ContactPreferences(),
            custom_fields=custom_fields or {},
            privacy_level="private",
            last_modified=datetime.utcnow().isoformat(),
        )

        self._contacts[entity_id] = contact

        if self._runtime:
            self._runtime.logger.info(
                f"Added contact {entity_id}",
                src="service:rolodex",
                categories=contact.categories,
            )

        return contact

    async def get_contact(self, entity_id: UUID) -> ContactInfo | None:
        return self._contacts.get(entity_id)

    async def update_contact(
        self,
        entity_id: UUID,
        categories: list[str] | None = None,
        tags: list[str] | None = None,
        preferences: ContactPreferences | None = None,
        custom_fields: dict[str, str | int | float | bool] | None = None,
    ) -> ContactInfo | None:
        contact = self._contacts.get(entity_id)
        if not contact:
            return None

        if categories is not None:
            contact.categories = categories
        if tags is not None:
            contact.tags = tags
        if preferences is not None:
            contact.preferences = preferences
        if custom_fields is not None:
            contact.custom_fields = custom_fields

        contact.last_modified = datetime.utcnow().isoformat()

        return contact

    async def remove_contact(self, entity_id: UUID) -> bool:
        if entity_id in self._contacts:
            del self._contacts[entity_id]
            return True
        return False

    async def search_contacts(
        self,
        categories: list[str] | None = None,
        tags: list[str] | None = None,
        search_term: str | None = None,
    ) -> list[ContactInfo]:
        results = list(self._contacts.values())

        if categories:
            results = [c for c in results if any(cat in c.categories for cat in categories)]

        if tags:
            results = [c for c in results if any(tag in c.tags for tag in tags)]

        return results

    async def get_all_contacts(self) -> list[ContactInfo]:
        return list(self._contacts.values())

    async def get_relationship_analytics(
        self,
        entity_id: UUID,
    ) -> RelationshipAnalytics | None:
        key = str(entity_id)
        return self._analytics.get(key)

    async def update_relationship_analytics(
        self,
        entity_id: UUID,
        interaction_count: int | None = None,
        last_interaction_at: str | None = None,
    ) -> RelationshipAnalytics:
        key = str(entity_id)
        analytics = self._analytics.get(key) or RelationshipAnalytics()

        if interaction_count is not None:
            analytics.interaction_count = interaction_count
        if last_interaction_at is not None:
            analytics.last_interaction_at = last_interaction_at

        contact = self._contacts.get(entity_id)
        relationship_type = "acquaintance"
        if contact and contact.categories:
            relationship_type = contact.categories[0]

        analytics.strength = calculate_relationship_strength(
            analytics.interaction_count,
            analytics.last_interaction_at,
            relationship_type=relationship_type,
        )

        self._analytics[key] = analytics
        return analytics
