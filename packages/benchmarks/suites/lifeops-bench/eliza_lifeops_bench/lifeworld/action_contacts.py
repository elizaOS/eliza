"""LifeWorld contacts action semantics."""

from __future__ import annotations
import hashlib
import re
from typing import Any
from .world import LifeWorld
from .entities import EntityKind
from .entities import Contact
from .action_common import (
    UnsupportedAction,
    _contact_matches,
    _positive_limit,
    _required,
    _synthetic_id,
    _try_parse_iso,
    _validated_message_source,
)


def _h_contact_add(world: LifeWorld, kw: dict[str, Any], _name: str) -> dict[str, Any]:
    contact = Contact(
        id=kw["id"],
        display_name=kw["display_name"],
        given_name=kw["given_name"],
        family_name=kw["family_name"],
        primary_email=kw["primary_email"],
        phones=list(kw.get("phones", [])),
        company=kw.get("company"),
        role=kw.get("role"),
        relationship=kw.get("relationship", "acquaintance"),
        importance=int(kw.get("importance", 0)),
        tags=list(kw.get("tags", [])),
        birthday=kw.get("birthday"),
    )
    world.add(EntityKind.CONTACT, contact)
    return {"id": contact.id}


def _h_contact_update(
    world: LifeWorld, kw: dict[str, Any], _name: str
) -> dict[str, Any]:
    contact_id = kw["id"]
    patches = {k: v for k, v in kw.items() if k != "id"}
    updated = world.update(EntityKind.CONTACT, contact_id, **patches)
    return {"id": updated.id}


def _h_contact_delete(
    world: LifeWorld, kw: dict[str, Any], _name: str
) -> dict[str, Any]:
    world.delete(EntityKind.CONTACT, kw["id"])
    return {"id": kw["id"], "deleted": True}


def _u_entity(world: LifeWorld, kw: dict[str, Any], name: str) -> dict[str, Any]:
    """Dispatch the ENTITY umbrella on `subaction`.

    Canonical subaction is `create`; `add` is the legacy alias (kept for
    scenario-corpus compatibility). Agents also emit `create_contact` and
    the promoted `ENTITY_CREATE_CONTACT` / `CONTACT_CREATE` surface names —
    all four route to the same contact-creation handler (P1-5 vocab alignment).
    """
    sub = _required(kw, "subaction", action=name, sub="<missing>")
    # Normalise the four contact-create variants into a single branch.
    if sub in {"add", "create", "create_contact"}:
        display = kw.get("name") or "Unknown"
        parts = display.split(maxsplit=1)
        given = parts[0] if parts else display
        family = parts[1] if len(parts) > 1 else ""
        email = kw.get("email") or kw.get("handle") or "unknown@example.test"
        contact_id = kw.get("entityId") or _synthetic_id(
            "contact_auto", {"n": display, "e": email}
        )
        contact = Contact(
            id=contact_id,
            display_name=display,
            given_name=given,
            family_name=family,
            primary_email=email,
            phones=[kw["phone"]] if kw.get("phone") else [],
            relationship=kw.get("relationship", "acquaintance"),
            notes=kw.get("notes"),
            priority_flag=kw.get("priorityFlag") or kw.get("priority_flag"),
        )
        world.add(EntityKind.CONTACT, contact)
        return {"id": contact.id}
    if sub == "update":
        contact_id = kw.get("entityId") or kw.get("id")
        existing = (
            world.contacts.get(contact_id) if isinstance(contact_id, str) else None
        )
        display_name = kw.get("name") or kw.get("displayName")
        if existing is None and isinstance(display_name, str) and display_name:
            matches = [
                contact
                for contact in world.contacts.values()
                if contact.display_name.casefold() == display_name.casefold()
            ]
            if len(matches) > 1:
                raise ValueError(f"ENTITY/update name is ambiguous: {display_name!r}")
            existing = matches[0] if matches else None
        created = existing is None
        if existing is None:
            if not isinstance(display_name, str) or not display_name:
                raise KeyError("ENTITY/update needs entityId/id or a non-empty name")
            parts = display_name.split(maxsplit=1)
            contact_id = (
                contact_id
                if isinstance(contact_id, str) and contact_id
                else _synthetic_id("contact_auto", {"n": display_name})
            )
            existing = Contact(
                id=contact_id,
                display_name=display_name,
                given_name=parts[0],
                family_name=parts[1] if len(parts) > 1 else "",
                primary_email=f"{contact_id}@example.test",
            )
            world.add(EntityKind.CONTACT, existing)
        patches: dict[str, Any] = {}
        if isinstance(display_name, str) and display_name:
            parts = display_name.split(maxsplit=1)
            patches.update(
                display_name=display_name,
                given_name=parts[0],
                family_name=parts[1] if len(parts) > 1 else "",
            )
        if "notes" in kw:
            patches["notes"] = kw["notes"]
        if "priorityFlag" in kw or "priority_flag" in kw:
            patches["priority_flag"] = kw.get("priorityFlag") or kw.get("priority_flag")
        if "importance" in kw:
            patches["importance"] = int(kw["importance"])
        if "tags" in kw:
            patches["tags"] = list(kw["tags"])
        if not patches:
            raise ValueError("ENTITY/update contains no supported contact fields")
        updated = world.update(EntityKind.CONTACT, existing.id, **patches)
        return {"id": updated.id, "created": created}
    if sub == "set_identity":
        contact_id = _required(kw, "entityId", action=name, sub=sub)
        platform = kw.get("platform")
        handle = _required(kw, "handle", action=name, sub=sub)
        patches: dict[str, Any] = {}
        existing = world.contacts.get(contact_id)
        if platform == "phone":
            phones = [handle] + [
                p for p in (existing.phones if existing else []) if p != handle
            ]
            patches["phones"] = phones
        elif platform == "email":
            patches["primary_email"] = handle
        else:
            phones = [handle] + [
                p for p in (existing.phones if existing else []) if p != handle
            ]
            patches["phones"] = phones
        if "displayName" in kw:
            patches["display_name"] = kw["displayName"]
        updated = world.update(EntityKind.CONTACT, contact_id, **patches)
        return {"id": updated.id}
    if sub == "set_relationship":
        contact_id = _required(kw, "toEntityId", action=name, sub=sub)
        relationship_type = _required(kw, "relationshipType", action=name, sub=sub)
        if not isinstance(contact_id, str) or not contact_id:
            raise ValueError(
                "ENTITY/set_relationship toEntityId must be a non-empty string"
            )
        if not isinstance(relationship_type, str) or not relationship_type:
            raise ValueError(
                "ENTITY/set_relationship relationshipType must be a non-empty string"
            )
        relationship = {
            "family_of": "family",
            "co_parent_of": "family",
            "friend_of": "friend",
            "colleague_of": "work",
            "acquaintance_of": "acquaintance",
        }.get(relationship_type)
        if relationship is None:
            raise ValueError(
                f"ENTITY/set_relationship unsupported relationshipType={relationship_type!r}"
            )
        existing = world.contacts.get(contact_id)
        created = existing is None
        if existing is None:
            display_name = (
                contact_id.rsplit("-", maxsplit=1)[-1].replace("_", " ").title()
            )
            parts = display_name.split(maxsplit=1)
            existing = Contact(
                id=contact_id,
                display_name=display_name,
                given_name=parts[0],
                family_name=parts[1] if len(parts) > 1 else "",
                primary_email=f"{contact_id}@example.test",
            )
            world.add(EntityKind.CONTACT, existing)
        metadata = kw.get("metadata") or {}
        if not isinstance(metadata, dict):
            raise ValueError("ENTITY/set_relationship metadata must be an object")
        updated = world.update(
            EntityKind.CONTACT,
            existing.id,
            relationship=relationship,
            relationship_type=relationship_type,
            relationship_evidence=kw.get("evidence"),
            relationship_metadata=dict(metadata),
        )
        return {
            "id": updated.id,
            "relationshipType": relationship_type,
            "created": created,
        }
    if sub == "log_interaction":
        return _log_entity_interaction(world, kw)
    if sub == "list":
        return _list_entities(world, kw)
    raise UnsupportedAction(
        f"unsupported action in execute path: ENTITY/{sub} — file gap in LIFEOPS_BENCH_GAPS.md"
    )


_ENTITY_INTENT_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"^list contacts whose family name is (?P<value>.+)$"), "family_name"),
    (re.compile(r"^list contacts where company is (?P<value>.+)$"), "company"),
    (
        re.compile(r"^list contacts where email ends with (?P<value>.+)$"),
        "email_suffix",
    ),
    (
        re.compile(r"^list contacts where phone starts with (?P<value>.+)$"),
        "phone_prefix",
    ),
    (
        re.compile(r"^list contacts where relationship is (?P<value>.+)$"),
        "relationship",
    ),
    (re.compile(r"^list contacts with (?P<value>.+) tag$"), "tag"),
)


def _parse_entity_list_filters(kw: dict[str, Any]) -> dict[str, Any]:
    raw_filters = kw.get("filters", {})
    if not isinstance(raw_filters, dict):
        raise ValueError("ENTITY/list filters must be an object")
    filters = dict(raw_filters)
    aliases = {
        "familyName": "family_name",
        "emailSuffix": "email_suffix",
        "phonePrefix": "phone_prefix",
    }
    for source_key, target_key in aliases.items():
        if source_key in filters and target_key not in filters:
            filters[target_key] = filters.pop(source_key)
        if source_key in kw and target_key not in filters:
            filters[target_key] = kw[source_key]
    for key in (
        "name",
        "family_name",
        "company",
        "email_suffix",
        "phone_prefix",
        "relationship",
        "tag",
        "missing",
    ):
        if key in kw and key not in filters:
            filters[key] = kw[key]

    intent = kw.get("intent")
    if intent is not None:
        if not isinstance(intent, str) or not intent.strip():
            raise ValueError("ENTITY/list intent must be a non-empty string")
        normalized = " ".join(intent.casefold().split())
        if normalized == "list contacts missing email":
            filters.setdefault("missing", "email")
        elif normalized == "list contacts where notes are empty":
            filters.setdefault("missing", "notes")
        elif normalized == "list family contacts missing phone":
            filters.setdefault("relationship", "family")
            filters.setdefault("missing", "phone")
        elif normalized not in {"list contacts", "list all contacts"}:
            match = None
            for pattern, field in _ENTITY_INTENT_PATTERNS:
                candidate = pattern.fullmatch(normalized)
                if candidate is not None:
                    match = (candidate, field)
                    break
            if match is None:
                raise ValueError(
                    "ENTITY/list intent cannot be represented by deterministic filters; "
                    "provide structured filters"
                )
            matched, field = match
            if matched is None:
                raise AssertionError("matched ENTITY/list intent unexpectedly vanished")
            filters.setdefault(field, matched.group("value").strip())

    allowed = {
        "name",
        "family_name",
        "company",
        "email_suffix",
        "phone_prefix",
        "relationship",
        "tag",
        "missing",
    }
    unknown = set(filters) - allowed
    if unknown:
        raise ValueError(f"ENTITY/list has unsupported filters: {sorted(unknown)}")
    for key, value in filters.items():
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"ENTITY/list filter {key!r} must be a non-empty string")
        filters[key] = value.strip()
    if filters.get("missing") not in {None, "email", "notes", "phone"}:
        raise ValueError("ENTITY/list missing filter must be email, notes, or phone")
    return filters


def _contact_matches_filters(contact: Contact, filters: dict[str, Any]) -> bool:
    def folded(key: str) -> str | None:
        value = filters.get(key)
        return value.casefold() if isinstance(value, str) else None

    name = folded("name")
    if name is not None and name not in contact.display_name.casefold():
        return False
    family_name = folded("family_name")
    if family_name is not None and contact.family_name.casefold() != family_name:
        return False
    company = folded("company")
    if company is not None and (
        contact.company is None or contact.company.casefold() != company
    ):
        return False
    email_suffix = folded("email_suffix")
    if email_suffix is not None and not contact.primary_email.casefold().endswith(
        email_suffix
    ):
        return False
    phone_prefix = filters.get("phone_prefix")
    if isinstance(phone_prefix, str) and not any(
        phone.startswith(phone_prefix) for phone in contact.phones
    ):
        return False
    relationship = folded("relationship")
    if relationship is not None and contact.relationship.casefold() != relationship:
        return False
    tag = folded("tag")
    if tag is not None and tag not in {item.casefold() for item in contact.tags}:
        return False
    missing = filters.get("missing")
    if missing == "email" and contact.primary_email.strip():
        return False
    if missing == "notes" and contact.notes not in {None, ""}:
        return False
    if missing == "phone" and contact.phones:
        return False
    return True


def _list_entities(world: LifeWorld, kw: dict[str, Any]) -> dict[str, Any]:
    filters = _parse_entity_list_filters(kw)
    limit = _positive_limit(kw.get("limit"), default=100)
    contacts = sorted(
        (
            contact
            for contact in world.contacts.values()
            if _contact_matches_filters(contact, filters)
        ),
        key=lambda contact: (contact.display_name.casefold(), contact.id),
    )
    rows = [
        {
            "id": contact.id,
            "displayName": contact.display_name,
            "givenName": contact.given_name,
            "familyName": contact.family_name,
            "primaryEmail": contact.primary_email,
            "phones": list(contact.phones),
            "company": contact.company,
            "relationship": contact.relationship,
            "tags": list(contact.tags),
            "notes": contact.notes,
        }
        for contact in contacts[:limit]
    ]
    return {
        "ok": True,
        "effect": "none",
        "operation": "ENTITY/list",
        "filters": filters,
        "count": len(rows),
        "entities": rows,
    }


def _log_entity_interaction(world: LifeWorld, kw: dict[str, Any]) -> dict[str, Any]:
    entity_id_value = kw.get("entityId") or kw.get("id")
    if entity_id_value is not None and (
        not isinstance(entity_id_value, str) or not entity_id_value.strip()
    ):
        raise ValueError("ENTITY/log_interaction entityId/id must be non-empty")
    entity_id = entity_id_value.strip() if isinstance(entity_id_value, str) else None
    supplied_name = kw.get("name")
    if supplied_name is not None and (
        not isinstance(supplied_name, str) or not supplied_name.strip()
    ):
        raise ValueError("ENTITY/log_interaction name must be non-empty")
    supplied_name = supplied_name.strip() if isinstance(supplied_name, str) else None
    contact: Contact | None = None
    if entity_id is not None:
        contact = world.contacts.get(entity_id)
        if contact is None:
            raise KeyError(f"ENTITY/log_interaction contact not found: {entity_id}")
    elif supplied_name is not None:
        matches = _contact_matches(world, supplied_name)
        if len(matches) > 1:
            raise ValueError(
                f"ENTITY/log_interaction name is ambiguous: {supplied_name!r}"
            )
        if matches:
            contact = matches[0]
            entity_id = contact.id
    else:
        raise KeyError("ENTITY/log_interaction requires entityId/id or name")

    notes = kw.get("notes")
    if not isinstance(notes, str) or not notes.strip():
        raise ValueError("ENTITY/log_interaction requires non-empty notes")
    notes = notes.strip()
    channel = _validated_message_source(kw.get("channel"), field="channel")
    occurred_at_value = (
        kw.get("occurredAt")
        or kw.get("occurred_at")
        or kw.get("timestamp")
        or world.now_iso
    )
    if (
        not isinstance(occurred_at_value, str)
        or _try_parse_iso(occurred_at_value) is None
    ):
        raise ValueError(
            "ENTITY/log_interaction occurredAt must be a valid ISO date/time"
        )
    store_allowed = kw.get("storeAllowed", kw.get("store_allowed", True))
    if not isinstance(store_allowed, bool):
        raise ValueError("ENTITY/log_interaction storeAllowed must be boolean")
    subject_name = supplied_name or (
        contact.display_name if contact is not None else ""
    )
    source_name_mismatch = (
        contact is not None
        and supplied_name is not None
        and supplied_name.casefold() != contact.display_name.casefold()
    )
    if not store_allowed:
        return {
            "ok": True,
            "effect": "none",
            "operation": "ENTITY/log_interaction",
            "persisted": False,
            "privacyGuard": "storage_prohibited",
            "entityId": entity_id,
            "noteDigest": hashlib.sha256(notes.encode("utf-8")).hexdigest(),
        }

    record_id = _synthetic_id(
        "interaction",
        {
            "entityId": entity_id,
            "subjectName": subject_name,
            "notes": notes,
            "channel": channel,
            "occurredAt": occurred_at_value,
        },
    )
    record, replayed = world.create_interaction_record(
        record_id=record_id,
        entity_id=entity_id,
        subject_name=subject_name,
        notes=notes,
        channel=channel,
        occurred_at=occurred_at_value,
        source_name_mismatch=source_name_mismatch,
    )
    return {
        "ok": True,
        "effect": "created",
        "operation": "ENTITY/log_interaction",
        "id": record.id,
        "entityId": record.entity_id,
        "subjectName": record.subject_name,
        "occurredAt": record.occurred_at,
        "createdAt": record.created_at,
        "sourceNameMismatch": record.source_name_mismatch,
        "replayed": replayed,
    }
