from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from typing import TYPE_CHECKING
from uuid import UUID

from elizaos.types import Service, ServiceType

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime


class ContactCategoryEnum(StrEnum):
    FRIEND = "friend"
    FAMILY = "family"
    COLLEAGUE = "colleague"
    ACQUAINTANCE = "acquaintance"
    VIP = "vip"
    BUSINESS = "business"


@dataclass
class ContactCategory:
    id: str
    name: str
    description: str = ""
    color: str = ""


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


@dataclass
class RelationshipInsight:
    entity_id: str
    analytics: RelationshipAnalytics


@dataclass
class NeedsAttention:
    entity_id: str
    days_since_contact: int


@dataclass
class RelationshipInsights:
    strongest_relationships: list[RelationshipInsight] = field(default_factory=list)
    needs_attention: list[NeedsAttention] = field(default_factory=list)
    recent_interactions: list[RelationshipInsight] = field(default_factory=list)


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


class RelationshipsService(Service):
    name = "relationships"
    service_type = ServiceType.RELATIONSHIPS

    @property
    def capability_description(self) -> str:
        return "Comprehensive contact and relationship management service"

    _DEFAULT_CATEGORIES: list[ContactCategory] = [
        ContactCategory(id="friend", name="Friend", color="#4CAF50"),
        ContactCategory(id="family", name="Family", color="#2196F3"),
        ContactCategory(id="colleague", name="Colleague", color="#FF9800"),
        ContactCategory(id="acquaintance", name="Acquaintance", color="#9E9E9E"),
        ContactCategory(id="vip", name="VIP", color="#9C27B0"),
        ContactCategory(id="business", name="Business", color="#795548"),
    ]

    def __init__(self) -> None:
        self._contacts: dict[UUID, ContactInfo] = {}
        self._analytics: dict[str, RelationshipAnalytics] = {}
        self._categories: list[ContactCategory] = list(self._DEFAULT_CATEGORIES)
        self._runtime: IAgentRuntime | None = None

    @classmethod
    async def start(cls, runtime: IAgentRuntime) -> RelationshipsService:
        service = cls()
        service._runtime = runtime
        runtime.logger.info(
            "Relationships service started",
            src="service:relationships",
            agentId=str(runtime.agent_id),
        )
        return service

    async def stop(self) -> None:
        if self._runtime:
            self._runtime.logger.info(
                "Relationships service stopped",
                src="service:relationships",
                agentId=str(self._runtime.agent_id),
            )
        self._contacts.clear()
        self._analytics.clear()
        self._categories.clear()
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
                src="service:relationships",
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

        normalized_search = (search_term or "").strip().lower()
        if normalized_search:
            filtered: list[ContactInfo] = []
            for contact in results:
                if normalized_search in str(contact.entity_id).lower():
                    filtered.append(contact)
                    continue

                entity = None
                if self._runtime is not None:
                    entity = await self._runtime.get_entity(str(contact.entity_id))

                entity_name = getattr(entity, "name", None)
                if isinstance(entity_name, str) and normalized_search in entity_name.lower():
                    filtered.append(contact)
                    continue

                entity_names = getattr(entity, "names", None)
                if isinstance(entity_names, list) and any(
                    isinstance(name, str) and normalized_search in name.lower()
                    for name in entity_names
                ):
                    filtered.append(contact)

            results = filtered

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

    # ------------------------------------------------------------------
    # Relationship analysis
    # ------------------------------------------------------------------

    async def analyze_relationship(
        self,
        source_entity_id: str,
        target_entity_id: str,
    ) -> RelationshipAnalytics | None:
        """Analyze the relationship between two specific entities.

        Looks up the analytics stored for *source* -> *target* (or
        *target* -> *source*).  Returns ``None`` when no analytics exist
        for either direction.
        """
        for key in (
            f"{source_entity_id}-{target_entity_id}",
            f"{target_entity_id}-{source_entity_id}",
        ):
            analytics = self._analytics.get(key)
            if analytics is not None:
                return analytics
        return None

    async def get_relationship_insights(
        self,
        entity_id: str,
    ) -> RelationshipInsights:
        """Return categorized insights for all relationships of *entity_id*.

        * **strongest_relationships** -- top 10 by strength (descending).
        * **needs_attention** -- contacts with no interaction in 30+ days,
          sorted by days since contact descending.
        * **recent_interactions** -- last 10 by timestamp (most recent first).
        """
        strongest: list[RelationshipInsight] = []
        attention: list[NeedsAttention] = []
        recent: list[tuple[str, RelationshipInsight]] = []  # (iso-ts, insight)

        now = datetime.utcnow()

        for key, analytics in self._analytics.items():
            parts = key.split("-", 1)
            if len(parts) != 2:
                continue

            # Only consider analytics that involve *entity_id*.
            if entity_id not in parts:
                continue

            other_id = parts[1] if parts[0] == entity_id else parts[0]
            insight = RelationshipInsight(entity_id=other_id, analytics=analytics)

            strongest.append(insight)

            if analytics.last_interaction_at:
                last_dt = datetime.fromisoformat(
                    analytics.last_interaction_at.replace("Z", "+00:00")
                )
                # Make *now* offset-aware when the stored timestamp is.
                ref = now if last_dt.tzinfo is None else now.replace(tzinfo=last_dt.tzinfo)
                days_since = (ref - last_dt).days
                if days_since >= 30:
                    attention.append(
                        NeedsAttention(entity_id=other_id, days_since_contact=days_since)
                    )
                recent.append((analytics.last_interaction_at, insight))

        # Top 10 strongest by strength descending.
        strongest.sort(key=lambda i: i.analytics.strength, reverse=True)
        strongest = strongest[:10]

        # Needs attention sorted by staleness descending.
        attention.sort(key=lambda a: a.days_since_contact, reverse=True)

        # Last 10 recent interactions by timestamp descending.
        recent.sort(key=lambda pair: pair[0], reverse=True)
        recent_insights = [pair[1] for pair in recent[:10]]

        return RelationshipInsights(
            strongest_relationships=strongest,
            needs_attention=attention,
            recent_interactions=recent_insights,
        )

    # ------------------------------------------------------------------
    # Category management
    # ------------------------------------------------------------------

    async def get_categories(self) -> list[ContactCategory]:
        """Return all contact categories."""
        return list(self._categories)

    async def add_category(self, category: ContactCategory) -> None:
        """Add a new category.

        Raises ``ValueError`` if a category with the same *id* already
        exists.
        """
        if any(c.id == category.id for c in self._categories):
            raise ValueError(f"Category '{category.id}' already exists")
        self._categories.append(category)
        if self._runtime:
            self._runtime.logger.info(
                f"Added category {category.name}",
                src="service:relationships",
            )

    # ------------------------------------------------------------------
    # Privacy management
    # ------------------------------------------------------------------

    async def set_contact_privacy(
        self,
        entity_id: str,
        privacy_level: str,
    ) -> bool:
        """Set the privacy level on a contact.

        Returns ``True`` on success, ``False`` if the contact does not
        exist.
        """
        if privacy_level not in ("public", "private", "restricted"):
            return False
        uid = UUID(entity_id) if isinstance(entity_id, str) else entity_id
        contact = self._contacts.get(uid)
        if contact is None:
            return False
        contact.privacy_level = privacy_level
        contact.last_modified = datetime.utcnow().isoformat()
        if self._runtime:
            self._runtime.logger.info(
                f"Set privacy for {entity_id} to {privacy_level}",
                src="service:relationships",
            )
        return True

    async def can_access_contact(
        self,
        requesting_entity_id: str,
        target_entity_id: str,
    ) -> bool:
        """Check whether *requesting_entity_id* may access *target_entity_id*.

        Access rules based on the target contact's ``privacy_level``:

        * ``"public"``     -- always accessible.
        * ``"private"``    -- accessible only to the entity itself.
        * ``"restricted"`` -- agent-only (returns ``False`` for all
          external callers; the owning agent bypasses this check).
        """
        uid = UUID(target_entity_id) if isinstance(target_entity_id, str) else target_entity_id
        contact = self._contacts.get(uid)
        if contact is None:
            return False

        level = contact.privacy_level

        if level == "public":
            return True

        if level == "private":
            return requesting_entity_id == target_entity_id

        # "restricted" — agent-only; non-agent callers always denied.
        return False


RelationshipsService = RelationshipsService
