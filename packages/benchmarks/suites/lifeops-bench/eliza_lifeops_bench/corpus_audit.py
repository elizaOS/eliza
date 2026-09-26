"""Builds a deterministic audit of scenario provenance and LifeWorld coverage.

The audit separates modeled read/terminal operations from explicit no-effect
failures, preserving every affected scenario and action in machine-readable
form. It is generated from the registered base corpus, never from edge copies,
so counts describe authored contracts rather than language-challenge runs.
"""

from __future__ import annotations

import argparse
import importlib
import json
import pkgutil
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

from .lifeworld.world import LifeWorld
from .runner import _execute_action, _normalize_action
from .scenarios import CORE_SCENARIOS
from .types import Action, Persona, Scenario, ScenarioMode

_PACKAGE_ROOT = Path(__file__).resolve().parents[1]
_SNAPSHOT_PATHS = {
    42: _PACKAGE_ROOT / "data" / "snapshots" / "tiny_seed_42.json",
    2026: _PACKAGE_ROOT / "data" / "snapshots" / "medium_seed_2026.json",
}

# These operations deliberately preserve LifeWorld while returning modeled
# data or completing a conversational boundary. Any other successful
# state-preserving operation is an audit failure rather than an implicit
# exemption.
MODELED_NO_MUTATION_OPERATIONS: dict[str, str] = {
    "BLOCK_LIST_ACTIVE/list_active": "modeled_read",
    "BLOCK_STATUS/status": "modeled_read",
    "BOOK_TRAVEL": "modeled_read",
    "BOOK_TRAVEL/prepare": "modeled_read",
    "BOOK_TRAVEL/search": "modeled_read",
    "CALENDAR/check_availability": "modeled_read",
    "CALENDAR/next_event": "modeled_read",
    "CALENDAR/propose_times": "modeled_read",
    "CALENDAR/search_events": "modeled_read",
    "ENTITY/list": "modeled_read",
    "ENTITY/log_interaction": "privacy_guard_or_persisted_write",
    "HEALTH/by_metric": "modeled_read",
    "HEALTH/status": "modeled_read",
    "HEALTH/summary": "modeled_read",
    "HEALTH/today": "modeled_read",
    "HEALTH/trend": "modeled_read",
    "HEALTH/trends": "modeled_read",
    "MESSAGE/list_channels": "modeled_read",
    "MESSAGE/read_channel": "modeled_read",
    "MESSAGE/read_with_contact": "modeled_read",
    "MESSAGE/search_inbox": "modeled_read",
    "MESSAGE/triage": "modeled_read_or_policy_write",
    "MONEY/list_transactions": "modeled_read",
    "MONEY/dashboard": "modeled_read",
    "MONEY/list_sources": "modeled_read",
    "MONEY/recurring_charges": "modeled_read",
    "MONEY/spending_summary": "modeled_read",
    "MONEY/subscription_audit": "modeled_read",
    "MONEY/subscription_status": "modeled_read",
    "MONEY_DASHBOARD/dashboard": "modeled_read",
    "MONEY_LIST_SOURCES/list_sources": "modeled_read",
    "MONEY_LIST_TRANSACTIONS/list_transactions": "modeled_read",
    "MONEY_RECURRING_CHARGES/recurring_charges": "modeled_read",
    "MONEY_SPENDING_SUMMARY/spending_summary": "modeled_read",
    "MONEY_SUBSCRIPTION_AUDIT/audit": "modeled_read",
    "MONEY_SUBSCRIPTION_STATUS/status": "modeled_read",
    "MONEY_SUBSCRIPTION_STATUS/subscription_status": "modeled_read",
    "REPLY": "conversational_terminal",
}

_NO_EFFECT_ACTION_NAMES = frozenset(
    {
        "BLOCK",
        "BLOCK_BLOCK",
        "BLOCK_LIST_ACTIVE",
        "BLOCK_RELEASE",
        "BLOCK_REQUEST_PERMISSION",
        "BLOCK_STATUS",
        "BLOCK_UNBLOCK",
        "BOOK_TRAVEL",
        "LIFE_SKIP",
        "LIFE_UPDATE",
        "MONEY_DASHBOARD",
        "MONEY_RECURRING_CHARGES",
        "MONEY_SPENDING_SUMMARY",
        "MONEY_SUBSCRIPTION_AUDIT",
        "MONEY_SUBSCRIPTION_STATUS",
    }
)

_AUDITED_UMBRELLA_OPERATIONS = frozenset(
    {
        "CALENDAR/bulk_reschedule",
        "CALENDAR/propose_times",
        "CALENDAR/update_preferences",
        "ENTITY/list",
        "ENTITY/log_interaction",
        "MESSAGE/draft_reply",
        "MESSAGE/list_channels",
        "MESSAGE/read_channel",
        "MESSAGE/read_with_contact",
        "MESSAGE/search_inbox",
        "MESSAGE/triage",
    }
)


def _operation_key(action: Action) -> str:
    normalized = _normalize_action(action)
    discriminator_field = (
        "operation"
        if normalized.name in {"MESSAGE", "CALENDAR_SOURCES"}
        else "subaction"
    )
    discriminator = normalized.kwargs.get(discriminator_field)
    return (
        f"{normalized.name}/{discriminator}"
        if isinstance(discriminator, str) and discriminator
        else normalized.name
    )


def _audited_operation_candidate(action: Action, operation: str) -> bool:
    normalized = _normalize_action(action)
    if normalized.name in _NO_EFFECT_ACTION_NAMES:
        return True
    if operation == "LIFE_DELETE/delete":
        target = normalized.kwargs.get("target")
        return not isinstance(target, str) or not target.startswith("reminder_")
    if operation.startswith("HEALTH/"):
        return operation != "HEALTH/by_metric"
    return operation in _AUDITED_UMBRELLA_OPERATIONS


def _expected_modeled_mutation(action: Action, operation: str) -> bool:
    normalized = _normalize_action(action)
    if operation in {
        "BLOCK/block",
        "BLOCK_BLOCK/block",
        "BLOCK_RELEASE/release",
        "BLOCK_REQUEST_PERMISSION/request_permission",
        "BLOCK_UNBLOCK/unblock",
        "BOOK_TRAVEL/hold",
        "CALENDAR/update_preferences",
        "HEALTH/delete_metric",
        "LIFE_DELETE/delete",
        "LIFE_SKIP/skip",
        "LIFE_UPDATE/update",
    }:
        return True
    if operation == "MESSAGE/draft_reply":
        return True
    if operation == "MESSAGE/triage":
        content = normalized.kwargs.get("content")
        return isinstance(content, str) and bool(content.strip())
    if operation == "ENTITY/log_interaction":
        return (
            normalized.kwargs.get(
                "storeAllowed",
                normalized.kwargs.get("store_allowed", True),
            )
            is not False
        )
    return False


def _scenario_action(
    scenario: Scenario,
    action: Action,
    *,
    action_index: int,
    operation: str,
    result: dict[str, Any],
) -> dict[str, Any]:
    return {
        "scenarioId": scenario.id,
        "actionIndex": action_index,
        "operation": operation,
        "action": {
            "name": action.name,
            "kwargs": action.kwargs,
        },
        "result": result,
    }


def _module_scenarios(module_name: str) -> list[Scenario]:
    module = importlib.import_module(module_name)
    scenarios: dict[int, Scenario] = {}
    for value in vars(module).values():
        if not isinstance(value, (list, tuple)):
            continue
        for item in value:
            if isinstance(item, Scenario):
                scenarios[id(item)] = item
    return list(scenarios.values())


def _scenario_module_names() -> list[str]:
    import eliza_lifeops_bench.scenarios as scenario_package

    names: set[str] = {
        "eliza_lifeops_bench.scenarios.expanded",
        "eliza_lifeops_bench.scenarios.personas",
    }
    prefix = scenario_package.__name__ + "."
    for info in pkgutil.walk_packages(scenario_package.__path__, prefix):
        if info.ispkg:
            continue
        if "._authoring." in info.name or info.name.endswith(
            ("._personas", ".schema_check", "._persona_specs")
        ):
            continue
        module = importlib.import_module(info.name)
        if any(
            isinstance(item, Scenario)
            for value in vars(module).values()
            if isinstance(value, (list, tuple))
            for item in value
        ):
            names.add(info.name)
    return sorted(names)


def _module_inventory() -> list[dict[str, Any]]:
    inventory: list[dict[str, Any]] = []
    for module_name in _scenario_module_names():
        scenarios = _module_scenarios(module_name)
        static = [item for item in scenarios if item.mode is ScenarioMode.STATIC]
        live = [item for item in scenarios if item.mode is ScenarioMode.LIVE]
        opening_modes = {item.opening_mode for item in scenarios}
        inventory.append(
            {
                "module": module_name,
                "baseScenarios": len(scenarios),
                "static": len(static),
                "live": len(live),
                "openingDelivery": (
                    "mixed"
                    if len(opening_modes) > 1
                    else (
                        "model_generated"
                        if opening_modes == {"simulated"}
                        else "authored"
                    )
                ),
                "staticRequiredOutputContracts": sum(
                    bool(item.required_outputs) for item in static
                ),
                "liveHiddenGoalLeaks": sum(
                    item.opening_mode == "authored" for item in live
                ),
                "trustedEvidenceContracts": sum(
                    item.trusted_evidence_requirement is not None for item in scenarios
                ),
            }
        )
    return inventory


def _persona_inventory(scenarios: Iterable[Scenario]) -> list[dict[str, Any]]:
    from .scenarios import _personas

    usage = Counter(item.persona.id for item in scenarios)
    personas = {
        value.id: value
        for name, value in vars(_personas).items()
        if name.startswith("PERSONA_") and isinstance(value, Persona)
    }
    return [
        {
            "id": persona_id,
            "name": personas[persona_id].name,
            "baseScenarioUses": usage[persona_id],
        }
        for persona_id in sorted(personas)
    ]


def build_corpus_audit(
    scenarios: Iterable[Scenario] = CORE_SCENARIOS,
) -> dict[str, Any]:
    """Return the canonical base-corpus audit document."""
    base_scenarios = list(scenarios)
    base_worlds = {
        seed: LifeWorld.from_json(path.read_text(encoding="utf-8"))
        for seed, path in _SNAPSHOT_PATHS.items()
    }
    gaps: list[dict[str, Any]] = []
    exemptions: list[dict[str, Any]] = []
    mutations: list[dict[str, Any]] = []
    unclassified_successes: list[dict[str, Any]] = []
    execution_errors: list[dict[str, Any]] = []

    for scenario in base_scenarios:
        if scenario.mode is not ScenarioMode.STATIC:
            continue
        base_world = base_worlds.get(scenario.world_seed)
        if base_world is None:
            execution_errors.append(
                {
                    "scenarioId": scenario.id,
                    "error": f"no snapshot for world seed {scenario.world_seed}",
                }
            )
            continue
        world = base_world.fork(now_iso=scenario.now_iso)
        for action_index, action in enumerate(scenario.ground_truth_actions):
            operation = _operation_key(action)
            audited_candidate = not (
                operation not in MODELED_NO_MUTATION_OPERATIONS
                and not _audited_operation_candidate(action, operation)
                and not _expected_modeled_mutation(action, operation)
            )
            before_revision = world.mutation_revision
            try:
                result = _execute_action(action, world)
            except Exception as exc:  # error-policy:J1 audit boundary translation
                execution_errors.append(
                    {
                        "scenarioId": scenario.id,
                        "actionIndex": action_index,
                        "operation": operation,
                        "errorType": type(exc).__name__,
                        "error": str(exc),
                    }
                )
                continue
            if not audited_candidate:
                continue
            record = _scenario_action(
                scenario,
                action,
                action_index=action_index,
                operation=operation,
                result=result,
            )
            changed = world.mutation_revision != before_revision
            if result.get("noop") is True:
                unclassified_successes.append(
                    {**record, "auditReason": "legacy noop marker remains"}
                )
            elif result.get("noEffect") is True:
                gaps.append(record)
            elif changed:
                mutations.append(record)
            elif _expected_modeled_mutation(action, operation):
                unclassified_successes.append(
                    {
                        **record,
                        "auditReason": (
                            "operation is modeled as a mutation but preserved world state"
                        ),
                    }
                )
            elif (
                operation in MODELED_NO_MUTATION_OPERATIONS and result.get("ok") is True
            ):
                exemptions.append(
                    {
                        **record,
                        "category": MODELED_NO_MUTATION_OPERATIONS[operation],
                    }
                )
            elif result.get("effect") == "none" and result.get("ok") is True:
                unclassified_successes.append(
                    {
                        **record,
                        "auditReason": (
                            "successful state-preserving operation is not in the "
                            "modeled exemption registry"
                        ),
                    }
                )
            else:
                unclassified_successes.append(
                    {
                        **record,
                        "auditReason": (
                            "audited operation returned an unclassified result shape"
                        ),
                    }
                )

    static = [item for item in base_scenarios if item.mode is ScenarioMode.STATIC]
    live = [item for item in base_scenarios if item.mode is ScenarioMode.LIVE]
    operation_counts = Counter(item["operation"] for item in gaps)
    affected_scenarios = {item["scenarioId"] for item in gaps}
    persona_ids = {item.persona.id for item in base_scenarios}
    library_persona_ids = {item["id"] for item in _persona_inventory(base_scenarios)}
    return {
        "schema": "lifeops.corpus-audit.v2",
        "baseCorpus": {
            "total": len(base_scenarios),
            "static": len(static),
            "live": len(live),
            "liveModelGeneratedOpenings": sum(
                item.opening_mode == "simulated" for item in live
            ),
            "liveAuthoredGoalLeaks": sum(
                item.opening_mode == "authored" for item in live
            ),
            "modelGeneratedOpenings": sum(
                item.opening_mode == "simulated" for item in base_scenarios
            ),
            "staticModelGeneratedOpenings": sum(
                item.opening_mode == "simulated" for item in static
            ),
            "staticAuthoredOpenings": sum(
                item.opening_mode == "authored" for item in static
            ),
            "staticSemanticOutputContracts": sum(
                bool(item.required_outputs) for item in static
            ),
            "trustedEvidenceContracts": sum(
                item.trusted_evidence_requirement is not None for item in live
            ),
        },
        "scenarioModules": _module_inventory(),
        "personas": _persona_inventory(base_scenarios),
        "personaIdsOutsideLibrary": sorted(persona_ids - library_persona_ids),
        "modeledNoMutationOperations": MODELED_NO_MUTATION_OPERATIONS,
        "noEffectGaps": {
            "affectedScenarioCount": len(affected_scenarios),
            "actionOccurrenceCount": len(gaps),
            "operationCounts": dict(sorted(operation_counts.items())),
            "occurrences": gaps,
        },
        "modeledNoMutationOccurrences": exemptions,
        "modeledMutationOccurrences": mutations,
        "unclassifiedSuccessfulNoEffects": unclassified_successes,
        "executionErrors": execution_errors,
    }


def main(argv: list[str] | None = None) -> int:
    """Write or print the deterministic audit JSON."""
    parser = argparse.ArgumentParser(prog="lifeops-corpus-audit")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    document = (
        json.dumps(
            build_corpus_audit(),
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )
        + "\n"
    )
    if args.output is None:
        print(document, end="")
    else:
        args.output.write_text(document, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
