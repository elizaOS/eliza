"""
Contacts Provider - Provides contact information from the rolodex.

This provider retrieves and formats contact information from the
rolodex service for use in prompts.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State


async def get_contacts_context(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    """
    Get contact information from the rolodex.

    Returns formatted information about contacts including
    categories, tags, and preferences.
    """
    from elizaos.bootstrap.services.rolodex import RolodexService

    rolodex_service = runtime.get_service("rolodex")
    if not rolodex_service or not isinstance(rolodex_service, RolodexService):
        return ProviderResult(
            text="",
            values={},
            data={},
        )

    try:
        # Get all contacts
        contacts = await rolodex_service.get_all_contacts()

        if not contacts:
            return ProviderResult(
                text="No contacts in rolodex.",
                values={"contactCount": 0},
                data={},
            )

        # Get entity details and categorize
        contact_details: list[dict[str, str]] = []
        for contact in contacts:
            entity = await runtime.get_entity(contact.entity_id)
            name = entity.name if entity and entity.name else "Unknown"
            contact_details.append(
                {
                    "id": str(contact.entity_id),
                    "name": name,
                    "categories": ",".join(contact.categories),
                    "tags": ",".join(contact.tags),
                }
            )

        # Group by category
        grouped: dict[str, list[dict[str, str]]] = {}
        for detail in contact_details:
            for cat in detail["categories"].split(","):
                cat = cat.strip()
                if cat:
                    if cat not in grouped:
                        grouped[cat] = []
                    grouped[cat].append(detail)

        # Build text summary
        text_summary = f"You have {len(contacts)} contacts in your rolodex:\n"

        for category, items in grouped.items():
            text_summary += f"\n{category.capitalize()}s ({len(items)}):\n"
            for item in items:
                text_summary += f"- {item['name']}"
                if item["tags"]:
                    text_summary += f" [{item['tags']}]"
                text_summary += "\n"

        # Build category counts
        category_counts: dict[str, int] = {}
        for cat, items in grouped.items():
            category_counts[cat] = len(items)

        return ProviderResult(
            text=text_summary.strip(),
            values={
                "contactCount": len(contacts),
                **category_counts,
            },
            data=category_counts,
        )

    except Exception as e:
        runtime.logger.error(
            {"src": "provider:contacts", "error": str(e)},
            "Error getting contacts",
        )
        return ProviderResult(
            text="Error retrieving contact information.",
            values={},
            data={},
        )


# Create the provider instance
contacts_provider = Provider(
    name="CONTACTS",
    description="Provides contact information from the rolodex",
    get=get_contacts_context,
    dynamic=True,
)
