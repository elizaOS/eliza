"""Named LifeOpsBench scenario suites for the multi-tier driver.

Three suites:

- ``SMOKE`` — 5 short STATIC scenarios that exercise the planner, tool call,
  cache hit, and multi-turn flows. Designed to finish in under 5 minutes
  end-to-end against ``MODEL_TIER=large`` and ``MODEL_TIER=frontier``.
- ``CORE`` — ~30 STATIC scenarios spread across all 11 LifeOps domains plus a
  handful of approval-flow scenarios. Used by the nightly job.
- ``FULL`` — everything in ``ALL_SCENARIOS``. Manual / dispatch only.

The suite IDs below are explicit subsets of real scenarios authored in
``eliza_lifeops_bench/scenarios/``. They are validated at import time:
unknown IDs raise immediately rather than surface as silent skips later in
the runner.
"""

from __future__ import annotations

from typing import Final

from .scenarios import ALL_SCENARIOS, SCENARIOS_BY_ID
from .types import Scenario

__all__ = [
    "CORE_SCENARIOS",
    "FULL_SCENARIOS",
    "SMOKE_SCENARIOS",
    "SUITES",
    "resolve_suite",
]


# ---------------------------------------------------------------------------
# Smoke — 5 short scenarios across 5 domains. All STATIC. Each must keep
# ``max_turns`` small so the suite finishes well under 5 minutes against the
# cloud tiers.
# ---------------------------------------------------------------------------

SMOKE_SCENARIO_IDS: Final[list[str]] = [
    "calendar.check_availability_thursday_morning",
    "mail.archive_specific_newsletter_thread",
    "reminders.create_pickup_reminder_tomorrow_9am",
    "health.step_count_today",
    "messages.send_imessage_to_hannah",
]


# ---------------------------------------------------------------------------
# Core — ~30 scenarios across every domain. Tilted toward short multi-turn
# planner work; includes one LIVE approval-flow scenario per major surface so
# the judge path is exercised on every nightly run.
# ---------------------------------------------------------------------------

CORE_SCENARIO_IDS: Final[list[str]] = [
    # calendar (3 + 1 approval)
    "calendar.check_availability_thursday_morning",
    "calendar.create_dentist_event_next_friday",
    "calendar.reschedule_roadmap_sync_to_afternoon",
    "calendar.cancel_tentative_launch_checklist",
    # mail (3)
    "mail.triage_unread_inbox",
    "mail.archive_specific_newsletter_thread",
    "mail.draft_reply_to_meeting_request",
    # messages (3)
    "messages.send_imessage_to_hannah",
    "messages.summarize_unread_whatsapp_family_chat",
    "messages.reply_in_climbing_buddies_telegram",
    # contacts (2)
    "contacts.add_new_freelance_collaborator",
    "contacts.update_phone_for_caleb_nguyen",
    # reminders (3)
    "reminders.create_pickup_reminder_tomorrow_9am",
    "reminders.complete_overdue_hiring_loop_followup",
    "reminders.list_overdue",
    # finance (2)
    "finance.spending_summary_last_week",
    "finance.list_active_subscriptions",
    # travel (2)
    "travel.search_flights_sfo_jfk_next_friday",
    "travel.airport_transfer_reminder_morning_of",
    # health (3)
    "health.step_count_today",
    "health.sleep_average_last_7_days",
    "health.log_morning_run_workout",
    # sleep (2)
    "sleep.set_bedtime_reminder_1030pm_daily",
    "sleep.create_morning_wakeup_7am",
    # focus (2)
    "focus.block_distracting_apps_25min",
    "focus.schedule_morning_focus_block_tomorrow",
    # LIVE / approval-flow lane — one per surface so the judge is exercised
    "smoke_live_mail_01",
    "live.reminders.daily_morning_affirmations",
    "live.sleep.set_morning_wake_up_alarm",
    "live.finance.monthly_summary_13",
]


def _resolve_ids(ids: list[str]) -> list[Scenario]:
    """Resolve a list of scenario IDs against ``SCENARIOS_BY_ID``.

    Unknown IDs raise ``ValueError`` immediately at import time so suite
    drift is caught in CI rather than silently skipped at run time.
    """
    missing = [sid for sid in ids if sid not in SCENARIOS_BY_ID]
    if missing:
        raise ValueError(
            "Unknown scenario id(s) in suite: " + ", ".join(missing)
        )
    return [SCENARIOS_BY_ID[sid] for sid in ids]


SMOKE_SCENARIOS: Final[list[Scenario]] = _resolve_ids(SMOKE_SCENARIO_IDS)
CORE_SCENARIOS: Final[list[Scenario]] = _resolve_ids(CORE_SCENARIO_IDS)
FULL_SCENARIOS: Final[list[Scenario]] = list(ALL_SCENARIOS)


SUITES: Final[dict[str, list[Scenario]]] = {
    "smoke": SMOKE_SCENARIOS,
    "core": CORE_SCENARIOS,
    "full": FULL_SCENARIOS,
}


def resolve_suite(name: str) -> list[Scenario]:
    """Return the scenario list for a named suite.

    Raises ``KeyError`` with a clear message if ``name`` is not a known suite.
    """
    key = name.strip().lower()
    if key not in SUITES:
        raise KeyError(
            f"Unknown suite {name!r}. Valid: {', '.join(sorted(SUITES))}"
        )
    return SUITES[key]
