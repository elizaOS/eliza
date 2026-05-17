"""Capability-taxonomy enums for LifeOpsBench scenario authoring.

Mirrors the canonical taxonomy at
``docs/audits/lifeops-2026-05-09/14-capability-taxonomy.md`` and the exporter at
``scripts/lifeops-bench/export-action-manifest.ts``. Scenario-side validation
in :mod:`validate` uses these to cross-check that ground-truth actions land in
the same domain the scenario is testing.

Keep these enums in lock-step with the TS exporter — when a new tag is added
there, add it here too. The validator will warn (not fail) on a mismatch so
authoring stays fast even when the taxonomy is in flux.
"""

from __future__ import annotations

from enum import Enum
from typing import Final

from ...types import Domain


class DomainTag(str, Enum):
    """Canonical `domain:*` tags. One per action."""

    CALENDAR = "domain:calendar"
    MAIL = "domain:mail"
    MESSAGES = "domain:messages"
    CONTACTS = "domain:contacts"
    REMINDERS = "domain:reminders"
    NOTES = "domain:notes"
    FINANCE = "domain:finance"
    TRAVEL = "domain:travel"
    HEALTH = "domain:health"
    SLEEP = "domain:sleep"
    FOCUS = "domain:focus"
    HOME = "domain:home"
    MUSIC = "domain:music"
    ENTITY = "domain:entity"
    META = "domain:meta"


class CapabilityTag(str, Enum):
    """Canonical `capability:*` tags. One or more per action."""

    READ = "capability:read"
    WRITE = "capability:write"
    UPDATE = "capability:update"
    DELETE = "capability:delete"
    SEND = "capability:send"
    SCHEDULE = "capability:schedule"
    EXECUTE = "capability:execute"


class SurfaceTag(str, Enum):
    """Canonical `surface:*` tags. One or more per action."""

    REMOTE_API = "surface:remote-api"
    DEVICE = "surface:device"
    INTERNAL = "surface:internal"
    ELIZA_CLOUD = "surface:eliza-cloud"


class RiskTag(str, Enum):
    """Canonical `risk:*` tags. Zero or one per action."""

    IRREVERSIBLE = "risk:irreversible"
    FINANCIAL = "risk:financial"
    USER_VISIBLE = "risk:user-visible"


class CostTag(str, Enum):
    """Canonical `cost:*` hints. Zero or one per action."""

    CHEAP = "cost:cheap"
    EXPENSIVE = "cost:expensive"


# Map scenario domains to the action domain tag the action is most likely to
# carry. Used for the soft cross-check in :func:`expected_domain_tag_for_scenario`.
# A scenario whose ``Domain`` field is ``CALENDAR`` is expected to drive a
# ground-truth action whose primary tag is ``domain:calendar``. Domains the
# scenario corpus does not currently cover (notes, home, music, sleep, entity)
# are intentionally absent — the validator skips them.
SCENARIO_DOMAIN_TO_ACTION_TAG: Final[dict[Domain, DomainTag]] = {
    Domain.CALENDAR: DomainTag.CALENDAR,
    Domain.MAIL: DomainTag.MAIL,
    Domain.MESSAGES: DomainTag.MESSAGES,
    Domain.CONTACTS: DomainTag.CONTACTS,
    Domain.REMINDERS: DomainTag.REMINDERS,
    Domain.FINANCE: DomainTag.FINANCE,
    Domain.TRAVEL: DomainTag.TRAVEL,
    Domain.HEALTH: DomainTag.HEALTH,
    Domain.SLEEP: DomainTag.HEALTH,
    Domain.FOCUS: DomainTag.FOCUS,
}


def expected_domain_tag_for_scenario(domain: Domain) -> DomainTag | None:
    """Return the action ``domain:*`` tag a ground-truth action for this
    scenario *should* carry, or None if no soft expectation exists.
    """
    return SCENARIO_DOMAIN_TO_ACTION_TAG.get(domain)


# ``domain:meta`` actions are universally allowed alongside any scenario domain
# (e.g. PROFILE, LIFEOPS pause, RESOLVE_REQUEST, TOGGLE_FEATURE). They are a
# horizontal capability, not a domain.
META_DOMAIN_TAG: Final[DomainTag] = DomainTag.META

ALL_TAG_VALUES: Final[frozenset[str]] = frozenset(
    {tag.value for tag in DomainTag}
    | {tag.value for tag in CapabilityTag}
    | {tag.value for tag in SurfaceTag}
    | {tag.value for tag in RiskTag}
    | {tag.value for tag in CostTag}
)


def is_canonical_tag(tag: str) -> bool:
    """Whether ``tag`` is one of the canonical taxonomy values."""
    return tag in ALL_TAG_VALUES


__all__ = [
    "ALL_TAG_VALUES",
    "CapabilityTag",
    "CostTag",
    "DomainTag",
    "META_DOMAIN_TAG",
    "RiskTag",
    "SCENARIO_DOMAIN_TO_ACTION_TAG",
    "SurfaceTag",
    "expected_domain_tag_for_scenario",
    "is_canonical_tag",
]
