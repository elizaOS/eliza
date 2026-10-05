"""The fixed 10-scenario STATIC sample MultitaskBench interleaves per lane.

The interference metric — mean per-task score at N minus at N=1 — is only
meaningful when the N=1 baseline and the N=5/N=10 lanes score the *same*
(scenario, seed) pairs. That forces a single frozen sample: five SMOKE ids
plus five CORE STATIC ids drawn from other domains (contacts, finance, focus,
sleep, travel) so all eleven LifeOps surfaces are represented without
overlapping the SMOKE set. Every id is STATIC — LIVE scenarios pull in a judge
and simulated user whose cost and nondeterminism would swamp the interference
signal.

The ids are validated against ``SCENARIOS_BY_ID`` at import (mirroring
``eliza_lifeops_bench.suites``) so sample drift fails in CI rather than
surfacing as a silent skip mid-run. Seeds come from each scenario's
``world_seed`` so the eliza world_factory resolves the matching on-disk
snapshot.
"""

from __future__ import annotations

from typing import Final

from eliza_lifeops_bench.scenarios import SCENARIOS_BY_ID
from eliza_lifeops_bench.types import Scenario

__all__ = [
    "MULTITASK_SAMPLE",
    "MULTITASK_SCENARIO_IDS",
    "sample_seed",
]


# Five SMOKE ids (calendar/mail/reminders/health/messages) plus five CORE
# STATIC ids from the remaining domains. Order is fixed: wave partitioning
# ``sample[k*n:(k+1)*n]`` must be deterministic across lanes, so this list is
# the canonical order the N=1/N=5/N=10 lanes all slice.
MULTITASK_SCENARIO_IDS: Final[list[str]] = [
    # SMOKE — 5 domains
    "calendar.check_availability_thursday_morning",
    "mail.archive_specific_newsletter_thread",
    "reminders.create_pickup_reminder_tomorrow_9am",
    "health.step_count_today",
    "messages.send_imessage_to_hannah",
    # CORE STATIC — 5 further domains, no SMOKE overlap
    "contacts.add_new_freelance_collaborator",
    "finance.spending_summary_last_week",
    "focus.block_distracting_apps_25min",
    "sleep.set_bedtime_reminder_1030pm_daily",
    "travel.search_flights_sfo_jfk_next_friday",
]


def _resolve_sample(ids: list[str]) -> list[Scenario]:
    """Resolve ids against ``SCENARIOS_BY_ID``, raising on any unknown id.

    Unknown ids raise ``ValueError`` at import so a bad sample is caught in
    CI, never skipped silently at run time.
    """
    missing = [sid for sid in ids if sid not in SCENARIOS_BY_ID]
    if missing:
        raise ValueError(
            "Unknown scenario id(s) in multitask sample: " + ", ".join(missing)
        )
    return [SCENARIOS_BY_ID[sid] for sid in ids]


MULTITASK_SAMPLE: Final[list[Scenario]] = _resolve_sample(MULTITASK_SCENARIO_IDS)


def sample_seed(scenario: Scenario) -> int:
    """The seed a scenario runs at in every lane.

    Fixed to ``world_seed`` (no per-lane offset) so the N=1 baseline and the
    N=5/N=10 lanes score the identical (scenario, seed) pair the interference
    delta subtracts across.
    """
    return scenario.world_seed
