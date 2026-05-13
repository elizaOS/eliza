"""Cross-stack contract diff test — §11.5 from the Synthesis Implementation Plan.

Validates that the Python runner (_ACTION_HANDLERS), the scorer
(_UMBRELLA_SUBACTIONS + _OWNER_SURFACE_ALIASES), and the TS fake
backend (LifeOpsFakeBackend.applyAction switch) are mutually consistent
on action names and parameter shapes for every supported umbrella.

Design
------
This is a snapshot-diff test.  The current contract is captured as a
JSON structure in this file (see EXPECTED_CONTRACT below).  The test
reads the live Python runtime state and validates it against that
snapshot.  If the contract drifts the test fails with a clear diff.

The TS fake backend is parsed from source (no Node execution required):
the test extracts `case "..."` labels from the `applyAction` switch so
it catches additions / removals without needing a TypeScript runtime.

Scope
-----
  1. Python runner `_ACTION_HANDLERS` keys — every key must appear in
     the EXPECTED_CONTRACT.python_runner_actions list.
  2. Scorer `_UMBRELLA_SUBACTIONS` keys — every umbrella must match the
     snapshot.  Discriminator field names and allowed subaction sets must
     match exactly.
  3. TS fake backend switch-case action names (extracted via regex) must
     match the snapshot.  The TS backend handles a strict *subset* of the
     Python runner's actions (HEALTH / LIFE_* / BLOCK / BOOK_TRAVEL /
     SCHEDULED_TASK_* are Python-only because LifeWorld side-effects are
     modelled there and not in the TS fake backend).
  4. For key umbrellas (CALENDAR, LIFE, HEALTH, ENTITY, MONEY,
     BOOK_TRAVEL, MESSAGE) the discriminator field and allowed subaction
     values must agree between the scorer and the runner _DISCRIMINATORS
     dict.

Updating the snapshot
---------------------
Run the test once with the --update-contract flag or set the env var
UPDATE_CROSS_STACK_CONTRACT=1.  This rewrites EXPECTED_CONTRACT in this
file with the current live state and then the test passes.  Review the
diff before committing — the point is to make drift explicit, not to
make it easy to auto-accept.

    UPDATE_CROSS_STACK_CONTRACT=1 python -m pytest \\
        tests/test_cross_stack_contract.py -v
"""

from __future__ import annotations

import json
import os
import re
import sys
import textwrap
from pathlib import Path
from typing import Any

import pytest

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).resolve().parents[4]
_BENCH_ROOT = Path(__file__).resolve().parents[1]
_TS_FAKE_BACKEND = (
    _REPO_ROOT
    / "packages"
    / "app-core"
    / "src"
    / "benchmark"
    / "lifeops-fake-backend.ts"
)

# ---------------------------------------------------------------------------
# Expected contract snapshot.
# This is the source of truth — update it deliberately (see module docstring).
# ---------------------------------------------------------------------------

EXPECTED_CONTRACT: dict[str, Any] = {
    # -----------------------------------------------------------------------
    # Python runner: every key in _ACTION_HANDLERS (umbrella vocabulary only;
    # fine-grained CALENDAR.* / MAIL.* / REMINDER.* dotted forms are excluded
    # because they only appear in the inline conformance corpus, not in bench
    # scenarios that could drift).
    # -----------------------------------------------------------------------
    "python_runner_umbrella_actions": sorted([
        "BOOK_TRAVEL",
        "BLOCK",
        "BLOCK_BLOCK",
        "BLOCK_UNBLOCK",
        "BLOCK_LIST_ACTIVE",
        "BLOCK_RELEASE",
        "BLOCK_STATUS",
        "BLOCK_REQUEST_PERMISSION",
        "CALENDAR",
        "ENTITY",
        "HEALTH",
        "LIFE",
        "LIFE_COMPLETE",
        "LIFE_CREATE",
        "LIFE_DELETE",
        "LIFE_REVIEW",
        "LIFE_SKIP",
        "LIFE_SNOOZE",
        "LIFE_UPDATE",
        "MESSAGE",
        "MONEY",
        "MONEY_DASHBOARD",
        "MONEY_LIST_TRANSACTIONS",
        "MONEY_LIST_SOURCES",
        "MONEY_RECURRING_CHARGES",
        "MONEY_SPENDING_SUMMARY",
        "MONEY_SUBSCRIPTION_STATUS",
        "MONEY_SUBSCRIPTION_AUDIT",
        "MONEY_SUBSCRIPTION_CANCEL",
        "SCHEDULED_TASK_CREATE",
        "SCHEDULED_TASK_SNOOZE",
        "SCHEDULED_TASK_UPDATE",
        "SCHEDULED_TASKS",
        "SCHEDULED_TASKS_ACKNOWLEDGE",
        "SCHEDULED_TASKS_CANCEL",
        "SCHEDULED_TASKS_COMPLETE",
        "SCHEDULED_TASKS_DISMISS",
        "SCHEDULED_TASKS_GET",
        "SCHEDULED_TASKS_HISTORY",
        "SCHEDULED_TASKS_LIST",
        "SCHEDULED_TASKS_REOPEN",
        "SCHEDULED_TASKS_SKIP",
        "SCHEDULED_TASKS_SNOOZE",
        "SCHEDULED_TASKS_UPDATE",
        "SCHEDULED_TASKS_CREATE",
        # Promoted CALENDAR_* aliases
        "CALENDAR_CREATE_EVENT",
        "CALENDAR_UPDATE_EVENT",
        "CALENDAR_DELETE_EVENT",
        "CALENDAR_PROPOSE_TIMES",
        "CALENDAR_SEARCH_EVENTS",
        "CALENDAR_CHECK_AVAILABILITY",
        "CALENDAR_NEXT_EVENT",
        "CALENDAR_UPDATE_PREFERENCES",
        # Promoted MESSAGE_* aliases
        "MESSAGE_SEND",
        "MESSAGE_DRAFT_REPLY",
        "MESSAGE_MANAGE",
        "MESSAGE_TRIAGE",
        "MESSAGE_SEARCH_INBOX",
        "MESSAGE_LIST_CHANNELS",
        "MESSAGE_READ_CHANNEL",
        "MESSAGE_READ_WITH_CONTACT",
        # Contact-create aliases (P1-5)
        "ENTITY_CREATE_CONTACT",
        "CONTACT_CREATE",
        # Conversational terminal
        "REPLY",
    ]),

    # -----------------------------------------------------------------------
    # Scorer: _UMBRELLA_SUBACTIONS — umbrella → (discriminator_field, sorted subactions).
    # Only the main umbrellas that planners actually emit.
    # -----------------------------------------------------------------------
    "scorer_umbrella_subactions": {
        "BOOK_TRAVEL": {
            "field": "subaction",
            "values": sorted(["search", "prepare", "book", "cancel", "hold"]),
        },
        "BLOCK": {
            "field": "subaction",
            "values": sorted(["block", "unblock", "status", "request_permission", "release", "list_active"]),
        },
        "CALENDAR": {
            "field": "subaction",
            "values": sorted([
                "create_event", "update_event", "delete_event",
                "propose_times", "search_events", "check_availability",
                "next_event", "update_preferences",
            ]),
        },
        "ENTITY": {
            "field": "subaction",
            "values": sorted([
                "create", "add", "create_contact", "read", "list",
                "set_identity", "set_relationship", "log_interaction", "merge",
            ]),
        },
        "HEALTH": {
            "field": "subaction",
            "values": sorted(["today", "trend", "trends", "by_metric", "status", "summary"]),
        },
        "LIFE": {
            "field": "subaction",
            "values": sorted([
                "create", "complete", "snooze", "review", "delete",
                "update", "skip", "list",
                "policy_set_reminder", "policy_configure_escalation",
            ]),
        },
        "MESSAGE": {
            "field": "operation",
            "values": sorted([
                "send", "draft_reply", "manage", "triage",
                "search_inbox", "list_channels", "read_channel", "read_with_contact",
            ]),
        },
        "MONEY": {
            "field": "subaction",
            "values": sorted([
                "dashboard", "list_sources", "list_transactions", "spending_summary",
                "recurring_charges", "add_source", "remove_source", "import_csv",
                "subscription_audit", "subscription_cancel", "subscription_status",
            ]),
        },
        "SCHEDULED_TASK": {
            "field": "subaction",
            "values": sorted([
                "list", "get", "create", "update", "snooze", "skip",
                "complete", "acknowledge", "dismiss", "cancel", "reopen", "history",
            ]),
        },
    },

    # -----------------------------------------------------------------------
    # TS fake backend: case labels in LifeOpsFakeBackend.applyAction's switch.
    # The TS backend handles a SUBSET of the Python runner actions.
    # HEALTH / LIFE_* / BLOCK / BOOK_TRAVEL / SCHEDULED_TASK_* are deliberately
    # absent — these are Python-only because the mutations are modelled only
    # in LifeWorld (not in LifeOpsFakeBackend's in-process stores).
    # -----------------------------------------------------------------------
    "ts_fake_backend_switch_cases": sorted([
        # Calendar
        "CALENDAR",
        "calendar.create_event",
        "calendar.move_event",
        "calendar.cancel_event",
        "calendar.list_events",
        # Mail
        "mail.search",
        "mail.create_draft",
        "mail.send",
        "mail.archive",
        "mail.mark_read",
        # Reminders
        "reminders.create",
        "reminders.complete",
        "reminders.list",
        # Messages (granular dotted)
        "messages.send",
        "messages.send_draft",
        "messages.draft_reply",
        "messages.manage",
        "messages.triage",
        "messages.search_inbox",
        "messages.list_channels",
        "messages.read_channel",
        "messages.read_with_contact",
        # MESSAGE umbrella
        "MESSAGE",
        # Notes
        "notes.create",
        # ENTITY umbrella
        "ENTITY",
        # Contacts
        "contacts.search",
        "contacts.create",
        # MONEY umbrella
        "MONEY",
    ]),

    # -----------------------------------------------------------------------
    # TS fake backend: Python-only actions not in the TS backend.
    # These are expected gaps — TS does not model these mutations.
    # Any NEW entry here means a new TS gap that should be justified.
    # -----------------------------------------------------------------------
    "ts_python_only_gaps": sorted([
        "BOOK_TRAVEL",
        "BLOCK",
        "BLOCK_BLOCK",
        "BLOCK_UNBLOCK",
        "BLOCK_LIST_ACTIVE",
        "BLOCK_RELEASE",
        "BLOCK_STATUS",
        "BLOCK_REQUEST_PERMISSION",
        "HEALTH",
        "LIFE",
        "LIFE_COMPLETE",
        "LIFE_CREATE",
        "LIFE_DELETE",
        "LIFE_REVIEW",
        "LIFE_SKIP",
        "LIFE_SNOOZE",
        "LIFE_UPDATE",
        "MONEY_DASHBOARD",
        "MONEY_LIST_TRANSACTIONS",
        "MONEY_LIST_SOURCES",
        "MONEY_RECURRING_CHARGES",
        "MONEY_SPENDING_SUMMARY",
        "MONEY_SUBSCRIPTION_STATUS",
        "MONEY_SUBSCRIPTION_AUDIT",
        "MONEY_SUBSCRIPTION_CANCEL",
        "SCHEDULED_TASK_CREATE",
        "SCHEDULED_TASK_SNOOZE",
        "SCHEDULED_TASK_UPDATE",
        "SCHEDULED_TASKS",
        "SCHEDULED_TASKS_ACKNOWLEDGE",
        "SCHEDULED_TASKS_CANCEL",
        "SCHEDULED_TASKS_COMPLETE",
        "SCHEDULED_TASKS_DISMISS",
        "SCHEDULED_TASKS_GET",
        "SCHEDULED_TASKS_HISTORY",
        "SCHEDULED_TASKS_LIST",
        "SCHEDULED_TASKS_REOPEN",
        "SCHEDULED_TASKS_SKIP",
        "SCHEDULED_TASKS_SNOOZE",
        "SCHEDULED_TASKS_UPDATE",
        "SCHEDULED_TASKS_CREATE",
        # Promoted CALENDAR_* / MESSAGE_* / CONTACT_* aliases exist in
        # Python _ACTION_HANDLERS but resolve through umbrellaToLowercase
        # in the TS backend — they never need explicit case labels there.
        "CALENDAR_CREATE_EVENT",
        "CALENDAR_UPDATE_EVENT",
        "CALENDAR_DELETE_EVENT",
        "CALENDAR_PROPOSE_TIMES",
        "CALENDAR_SEARCH_EVENTS",
        "CALENDAR_CHECK_AVAILABILITY",
        "CALENDAR_NEXT_EVENT",
        "CALENDAR_UPDATE_PREFERENCES",
        "MESSAGE_SEND",
        "MESSAGE_DRAFT_REPLY",
        "MESSAGE_MANAGE",
        "MESSAGE_TRIAGE",
        "MESSAGE_SEARCH_INBOX",
        "MESSAGE_LIST_CHANNELS",
        "MESSAGE_READ_CHANNEL",
        "MESSAGE_READ_WITH_CONTACT",
        "ENTITY_CREATE_CONTACT",
        "CONTACT_CREATE",
        "REPLY",
    ]),
}

# ---------------------------------------------------------------------------
# Live-state readers
# ---------------------------------------------------------------------------


def _get_python_runner_umbrella_actions() -> list[str]:
    """Read _ACTION_HANDLERS from the live runner and return umbrella-only keys.

    Filters out fine-grained dotted keys (`CALENDAR.create`, `MAIL.send`, …)
    that only appear in the inline conformance corpus.
    """
    from eliza_lifeops_bench.runner import _ACTION_HANDLERS  # type: ignore[attr-defined]

    return sorted(k for k in _ACTION_HANDLERS if "." not in k)


def _get_scorer_umbrella_subactions() -> dict[str, dict[str, Any]]:
    """Read _UMBRELLA_SUBACTIONS from the live scorer."""
    from eliza_lifeops_bench.scorer import _UMBRELLA_SUBACTIONS  # type: ignore[attr-defined]

    result: dict[str, dict[str, Any]] = {}
    for umbrella, (field, values) in _UMBRELLA_SUBACTIONS.items():
        result[umbrella] = {"field": field, "values": sorted(values)}
    return result


def _extract_ts_switch_cases() -> list[str]:
    """Extract `case "..."` string literals from LifeOpsFakeBackend.applyAction.

    Reads the raw TypeScript source and uses a regex to find case labels
    inside the `applyAction` method's switch block.  This is intentionally
    a light-weight regex parse (not a full AST) because:
      - We only care about the outer switch in applyAction, not nested ones.
      - The file is well-structured and the switch is clearly delimited.
      - Avoiding a Node.js dependency keeps the test fast and self-contained.
    """
    if not _TS_FAKE_BACKEND.exists():
        pytest.skip(
            f"TS fake backend not found at {_TS_FAKE_BACKEND}. "
            "This test only runs in a local checkout with the eliza/ source tree."
        )

    src = _TS_FAKE_BACKEND.read_text(encoding="utf-8")

    # Locate the applyAction method body — find the opening `{` after the
    # method signature then walk to the matching `}` at the same depth.
    method_start = src.find("applyAction(name: string, kwargs:")
    if method_start == -1:
        pytest.fail("Could not find applyAction method in TS fake backend")

    brace_open = src.find("{", method_start)
    if brace_open == -1:
        pytest.fail("Could not find opening brace of applyAction")

    depth = 0
    method_body_start = brace_open
    method_body_end = brace_open
    for i, ch in enumerate(src[brace_open:], start=brace_open):
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                method_body_end = i
                break

    method_body = src[method_body_start:method_body_end + 1]

    # Extract all `case "..."` string literals inside the switch.
    # Pattern: `case` followed by a double-quoted string literal.
    # We deliberately exclude `default` and numeric / enum cases.
    case_re = re.compile(r'\bcase\s+"([^"]+)"')
    return sorted(set(case_re.findall(method_body)))


# ---------------------------------------------------------------------------
# Diff helpers
# ---------------------------------------------------------------------------


def _list_diff(label: str, expected: list[str], actual: list[str]) -> list[str]:
    """Return lines describing additions / removals between two sorted lists."""
    exp_set = set(expected)
    act_set = set(actual)
    lines: list[str] = []
    added = sorted(act_set - exp_set)
    removed = sorted(exp_set - act_set)
    if added:
        lines.append(f"  {label}: ADDED (not in snapshot) — {added}")
    if removed:
        lines.append(f"  {label}: REMOVED (in snapshot but gone) — {removed}")
    return lines


def _subaction_diff(
    label: str,
    expected: dict[str, dict[str, Any]],
    actual: dict[str, dict[str, Any]],
) -> list[str]:
    """Return lines describing umbrella subaction drift."""
    lines: list[str] = []
    all_umbrellas = sorted(set(expected) | set(actual))
    for umbrella in all_umbrellas:
        exp = expected.get(umbrella)
        act = actual.get(umbrella)
        if exp is None:
            lines.append(f"  {label}/{umbrella}: ADDED new umbrella — {act}")
            continue
        if act is None:
            lines.append(f"  {label}/{umbrella}: REMOVED umbrella — was {exp}")
            continue
        if exp["field"] != act["field"]:
            lines.append(
                f"  {label}/{umbrella}: discriminator field changed "
                f"{exp['field']!r} → {act['field']!r}"
            )
        exp_vals = set(exp["values"])
        act_vals = set(act["values"])
        added = sorted(act_vals - exp_vals)
        removed = sorted(exp_vals - act_vals)
        if added:
            lines.append(
                f"  {label}/{umbrella}: subaction ADDED — {added}"
            )
        if removed:
            lines.append(
                f"  {label}/{umbrella}: subaction REMOVED — {removed}"
            )
    return lines


# ---------------------------------------------------------------------------
# Contract update helper (UPDATE_CROSS_STACK_CONTRACT=1)
# ---------------------------------------------------------------------------


def _update_contract_in_place(
    runner_actions: list[str],
    scorer_subactions: dict[str, dict[str, Any]],
    ts_cases: list[str],
) -> None:
    """Rewrite EXPECTED_CONTRACT in this source file with the current live state."""
    this_file = Path(__file__)
    src = this_file.read_text(encoding="utf-8")

    # Compute ts_python_only_gaps from the live data
    ts_umbrella_names = {c for c in ts_cases if not c[0].islower()}
    # Runner umbrella actions minus those in TS cases = Python-only gaps
    python_only = sorted(set(runner_actions) - set(ts_cases))

    new_contract = {
        "python_runner_umbrella_actions": runner_actions,
        "scorer_umbrella_subactions": scorer_subactions,
        "ts_fake_backend_switch_cases": ts_cases,
        "ts_python_only_gaps": python_only,
    }

    new_src = re.sub(
        r"^(EXPECTED_CONTRACT: dict\[str, Any\] = )(\{.*?\n\})",
        lambda m: m.group(1) + json.dumps(new_contract, indent=4, sort_keys=True),
        src,
        count=1,
        flags=re.DOTALL | re.MULTILINE,
    )
    if new_src == src:
        print(
            "[cross-stack contract] WARNING: Could not locate EXPECTED_CONTRACT "
            "block to update — manual update required.",
            file=sys.stderr,
        )
        return
    this_file.write_text(new_src, encoding="utf-8")
    print(
        "[cross-stack contract] EXPECTED_CONTRACT updated — review the diff before committing.",
        file=sys.stderr,
    )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_python_runner_umbrella_actions_match_snapshot() -> None:
    """Every umbrella action in _ACTION_HANDLERS must match the snapshot.

    If this test fails, the Python runner gained or lost an action name.
    Update EXPECTED_CONTRACT['python_runner_umbrella_actions'] deliberately.
    """
    actual = _get_python_runner_umbrella_actions()
    expected = sorted(EXPECTED_CONTRACT["python_runner_umbrella_actions"])

    diff = _list_diff("python_runner_umbrella_actions", expected, actual)
    assert not diff, (
        "Python runner _ACTION_HANDLERS umbrella keys drifted from snapshot.\n"
        "Update EXPECTED_CONTRACT['python_runner_umbrella_actions'] or fix the runner.\n"
        "\n".join(diff)
    )


def test_scorer_umbrella_subactions_match_snapshot() -> None:
    """Every umbrella in _UMBRELLA_SUBACTIONS must match the snapshot.

    If this test fails, the scorer gained/lost an umbrella or a subaction
    value changed.  Update EXPECTED_CONTRACT['scorer_umbrella_subactions']
    deliberately.
    """
    actual = _get_scorer_umbrella_subactions()
    expected = EXPECTED_CONTRACT["scorer_umbrella_subactions"]

    diff = _subaction_diff("scorer_umbrella_subactions", expected, actual)
    assert not diff, (
        "Scorer _UMBRELLA_SUBACTIONS drifted from snapshot.\n"
        "Update EXPECTED_CONTRACT['scorer_umbrella_subactions'] or fix the scorer.\n"
        "\n".join(diff)
    )


def test_ts_fake_backend_switch_cases_match_snapshot() -> None:
    """TS fake backend applyAction switch cases must match the snapshot.

    If this test fails, the TS backend gained or lost a case label.
    Update EXPECTED_CONTRACT['ts_fake_backend_switch_cases'] deliberately.
    """
    actual = _extract_ts_switch_cases()
    expected = sorted(EXPECTED_CONTRACT["ts_fake_backend_switch_cases"])

    diff = _list_diff("ts_fake_backend_switch_cases", expected, actual)
    assert not diff, (
        "TS fake backend applyAction switch cases drifted from snapshot.\n"
        "Update EXPECTED_CONTRACT['ts_fake_backend_switch_cases'] or fix the TS backend.\n"
        "\n".join(diff)
    )


def test_ts_python_only_gaps_are_expected() -> None:
    """Python-only actions (in runner but not in TS backend) must match snapshot.

    The TS backend handles a strict subset of Python runner actions —
    HEALTH / LIFE_* / BLOCK / BOOK_TRAVEL / SCHEDULED_TASK_* are Python-only
    because mutations are modeled in LifeWorld only.

    If new Python actions appear that are NOT in the TS backend, they must be
    explicitly listed in EXPECTED_CONTRACT['ts_python_only_gaps'] with a
    justification comment, otherwise this test fails.
    """
    python_actions = set(_get_python_runner_umbrella_actions())
    ts_cases = set(_extract_ts_switch_cases())
    actual_gaps = sorted(python_actions - ts_cases)
    expected_gaps = sorted(EXPECTED_CONTRACT["ts_python_only_gaps"])

    diff = _list_diff("ts_python_only_gaps", expected_gaps, actual_gaps)
    assert not diff, (
        "Python-only action gap list drifted from snapshot.\n"
        "If a Python action should also be in the TS backend, implement it there\n"
        "and update EXPECTED_CONTRACT['ts_fake_backend_switch_cases'].\n"
        "If it's intentionally Python-only, add it to EXPECTED_CONTRACT['ts_python_only_gaps'].\n"
        "\n".join(diff)
    )


def test_scorer_and_runner_discriminators_agree_for_key_umbrellas() -> None:
    """For CALENDAR, LIFE, HEALTH, ENTITY, MONEY, BOOK_TRAVEL, MESSAGE:
    scorer _UMBRELLA_SUBACTIONS and runner _DISCRIMINATORS must agree on the
    discriminator field name and overlap substantially on allowed values.

    This is the concrete §11.5 requirement — agents that emit a subaction
    value must get credit from the scorer when it matches the runner's
    discriminator.
    """
    from eliza_lifeops_bench.runner import _DISCRIMINATORS  # type: ignore[attr-defined]
    from eliza_lifeops_bench.scorer import _UMBRELLA_SUBACTIONS  # type: ignore[attr-defined]

    # Umbrellas where agreement is required (T8 domains)
    key_umbrellas = [
        "CALENDAR",
        "MESSAGE",
        "ENTITY",
        "HEALTH",
        "LIFE",
        "MONEY",
        "BOOK_TRAVEL",
    ]

    failures: list[str] = []
    for umbrella in key_umbrellas:
        scorer_entry = _UMBRELLA_SUBACTIONS.get(umbrella)
        runner_entry = _DISCRIMINATORS.get(umbrella)

        if scorer_entry is None:
            failures.append(
                f"{umbrella}: missing from scorer _UMBRELLA_SUBACTIONS"
            )
            continue
        # Runner may not have an entry for all umbrellas (e.g. LIFE, BOOK_TRAVEL
        # are handled via explicit _ACTION_HANDLERS entries rather than a single
        # discriminator), so runner absence is not an error — just skip agreement
        # check for those.
        if runner_entry is None:
            continue

        scorer_field, scorer_values = scorer_entry
        runner_field, runner_values = runner_entry

        if scorer_field != runner_field:
            failures.append(
                f"{umbrella}: discriminator field mismatch — "
                f"scorer={scorer_field!r}, runner={runner_field!r}"
            )
            continue

        scorer_set = set(scorer_values)
        runner_set = set(runner_values)
        runner_only = sorted(runner_set - scorer_set)
        if runner_only:
            failures.append(
                f"{umbrella}: runner has subaction values the scorer won't fold: "
                f"{runner_only} — these emissions will get 0 action_score"
            )

    assert not failures, (
        "Scorer ↔ runner discriminator agreement failures for key umbrellas:\n"
        + "\n".join(f"  - {f}" for f in failures)
    )


def test_calendar_subaction_field_names_agree() -> None:
    """CALENDAR umbrella: scorer and runner must use 'subaction' (not 'action').

    Theme T8 §8.5: the manifest property was 'action', the runner uses 'subaction'.
    Both sides must agree on 'subaction' now.
    """
    from eliza_lifeops_bench.runner import _DISCRIMINATORS  # type: ignore[attr-defined]
    from eliza_lifeops_bench.scorer import _UMBRELLA_SUBACTIONS  # type: ignore[attr-defined]

    runner_field, _ = _DISCRIMINATORS["CALENDAR"]
    scorer_field, _ = _UMBRELLA_SUBACTIONS["CALENDAR"]
    assert runner_field == "subaction", (
        f"runner _DISCRIMINATORS['CALENDAR'] uses field {runner_field!r}, expected 'subaction'"
    )
    assert scorer_field == "subaction", (
        f"scorer _UMBRELLA_SUBACTIONS['CALENDAR'] uses field {scorer_field!r}, expected 'subaction'"
    )


def test_message_operation_field_name_agrees() -> None:
    """MESSAGE umbrella must use 'operation' (not 'subaction') in both scorer and runner."""
    from eliza_lifeops_bench.runner import _DISCRIMINATORS  # type: ignore[attr-defined]
    from eliza_lifeops_bench.scorer import _UMBRELLA_SUBACTIONS  # type: ignore[attr-defined]

    runner_field, _ = _DISCRIMINATORS["MESSAGE"]
    scorer_field, _ = _UMBRELLA_SUBACTIONS["MESSAGE"]
    assert runner_field == "operation", (
        f"runner _DISCRIMINATORS['MESSAGE'] uses field {runner_field!r}, expected 'operation'"
    )
    assert scorer_field == "operation", (
        f"scorer _UMBRELLA_SUBACTIONS['MESSAGE'] uses field {scorer_field!r}, expected 'operation'"
    )


def test_ts_backend_handles_calendar_umbrella() -> None:
    """TS backend must have a `CALENDAR` case (P0-5 fix)."""
    ts_cases = set(_extract_ts_switch_cases())
    assert "CALENDAR" in ts_cases, (
        "TS fake backend is missing the CALENDAR umbrella case — P0-5 regression"
    )


def test_ts_backend_handles_message_umbrella() -> None:
    """TS backend must have a `MESSAGE` case (P0-4 fix)."""
    ts_cases = set(_extract_ts_switch_cases())
    assert "MESSAGE" in ts_cases, (
        "TS fake backend is missing the MESSAGE umbrella case — P0-4 regression"
    )


def test_ts_backend_handles_entity_umbrella() -> None:
    """TS backend must have an `ENTITY` case (P1-5)."""
    ts_cases = set(_extract_ts_switch_cases())
    assert "ENTITY" in ts_cases, (
        "TS fake backend is missing the ENTITY umbrella case"
    )


def test_ts_backend_handles_money_umbrella() -> None:
    """TS backend must have a `MONEY` case."""
    ts_cases = set(_extract_ts_switch_cases())
    assert "MONEY" in ts_cases, (
        "TS fake backend is missing the MONEY umbrella case"
    )


# ---------------------------------------------------------------------------
# CLI support: UPDATE_CROSS_STACK_CONTRACT=1 rewrites the snapshot
# ---------------------------------------------------------------------------


def pytest_configure(config: pytest.Config) -> None:  # noqa: ARG001
    if os.environ.get("UPDATE_CROSS_STACK_CONTRACT") == "1":
        # Run readers eagerly and rewrite this file.  The subsequent test
        # run will then compare against the freshly written snapshot.
        try:
            runner_actions = _get_python_runner_umbrella_actions()
            scorer_subactions = _get_scorer_umbrella_subactions()
            ts_cases = _extract_ts_switch_cases()
            _update_contract_in_place(runner_actions, scorer_subactions, ts_cases)
        except Exception as exc:  # noqa: BLE001
            print(
                f"[cross-stack contract] WARNING: update failed — {exc}",
                file=sys.stderr,
            )
