from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State


async def get_contacts_context(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    from elizaos.bootstrap.services.rolodex import RolodexService

    rolodex_service = runtime.get_service("rolodex")
    if not rolodex_service or not isinstance(rolodex_service, RolodexService):
        return ProviderResult(text="", values={}, data={})

    contacts = await rolodex_service.get_all_contacts()

    if not contacts:
        return ProviderResult(text="No contacts in rolodex.", values={"contactCount": 0}, data={})

    entities = await asyncio.gather(
        *(runtime.get_entity(str(contact.entity_id)) for contact in contacts)
    )
    contact_details: list[dict[str, str]] = []
    for contact, entity in zip(contacts, entities, strict=False):
        name = entity.name if entity and entity.name else "Unknown"
        contact_details.append(
            {
                "id": str(contact.entity_id),
                "name": name,
                "categories": ",".join(contact.categories),
                "tags": ",".join(contact.tags),
            }
        )

    grouped: dict[str, list[dict[str, str]]] = {}
    for detail in contact_details:
        for cat in detail["categories"].split(","):
            cat = cat.strip()
            if cat:
                grouped.setdefault(cat, []).append(detail)

    text_summary = f"You have {len(contacts)} contacts in your rolodex:\n"

    for category, items in grouped.items():
        text_summary += f"\n{category.capitalize()}s ({len(items)}):\n"
        for item in items:
            text_summary += f"- {item['name']}"
            if item["tags"]:
                text_summary += f" [{item['tags']}]"
            text_summary += "\n"

    category_counts = {cat: len(items) for cat, items in grouped.items()}

    return ProviderResult(
        text=text_summary.strip(),
        values={
            "contactCount": len(contacts),
            **category_counts,
        },
        data=category_counts,
    )


contacts_provider = Provider(
    name="CONTACTS",
    description="Provides contact information from the rolodex",
    get=get_contacts_context,
    dynamic=True,
)
