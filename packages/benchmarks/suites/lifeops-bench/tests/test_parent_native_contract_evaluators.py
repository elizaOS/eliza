"""Native evaluator checks over server-owned states produced by the real-action suite.

The paired TypeScript test drives registered actions against PGlite; these
checks prove the Python signer accepts those shapes and rejects tampering.
"""

from __future__ import annotations

import copy
import hashlib
import json
from datetime import datetime, timezone
from typing import cast

import pytest

from eliza_lifeops_bench.evidence import action_sha256, canonical_json_bytes
from eliza_lifeops_bench.runtime_connector import (
    production_parent_contract_registry,
)
from eliza_lifeops_bench.scenarios import (
    WORLD_TRAVELING_COPARENT_SCENARIOS,
)
from eliza_lifeops_bench.trusted_executor_server import (
    ActionLineageEntry,
    ConnectorExecution,
    JsonObject,
    ServerOwnedContractEvaluator,
    ValidatedExecutionRequest,
)
from eliza_lifeops_bench.types import Action, TrustedEvidenceRequirement

_NOW = datetime(2026, 7, 27, 20, 0, tzinfo=timezone.utc)
_STATE_SCHEMA = "lifeops.trusted-parent-contract-state.v1"
_FORMULA_SET = "childcare-work-scenario.formula-set.v1"


def _iso(value: datetime = _NOW) -> str:
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _scenario_and_requirement(
    contract_id: str,
) -> tuple[str, TrustedEvidenceRequirement]:
    matches = [
        (scenario.id, requirement)
        for scenario in WORLD_TRAVELING_COPARENT_SCENARIOS
        if (requirement := scenario.trusted_evidence_requirement) is not None
        and requirement.contract_id == contract_id
    ]
    assert len(matches) == 1
    return matches[0]


def _request(
    contract_id: str,
    action: Action,
    *,
    ordinal: int = 1,
) -> ValidatedExecutionRequest:
    scenario_id, requirement = _scenario_and_requirement(contract_id)
    return ValidatedExecutionRequest(
        envelope={},
        run_id=f"native-{contract_id.lower()}-run",
        run_nonce=f"native-{contract_id.lower()}-nonce",
        run_started_at=_NOW,
        scenario_id=scenario_id,
        seed=2026,
        tool_call_id=f"call-{ordinal}",
        request_ordinal=ordinal,
        action=action,
        action_sha256=action_sha256(action),
        contract_id=contract_id,
        contract_version=requirement.contract_version,
        contract_sha256=requirement.contract_sha256,
        requested_at=_NOW,
    )


def _lineage_entry(
    action: Action,
    *,
    ordinal: int,
) -> ActionLineageEntry:
    return ActionLineageEntry(
        request_ordinal=ordinal,
        tool_call_id=f"call-{ordinal}",
        action=action.name,
        action_sha256=action_sha256(action),
    )


def _history_entry(
    action_name: str,
    discriminator: str,
    operation: str,
    *,
    ordinal: int,
) -> dict[str, object]:
    return {
        "actionName": action_name,
        "discriminator": discriminator,
        "succeeded": True,
        "receiptIds": [f"receipt-{ordinal}"],
        "operations": [operation],
        "resourceKinds": [],
        "artifactKinds": [],
    }


def _execution(
    action_name: str,
    state: dict[str, object],
) -> ConnectorExecution:
    return ConnectorExecution(
        payload=cast(
            JsonObject,
            {
                "result": {
                    "success": True,
                    "data": {
                        "actionName": action_name,
                        "trustedParentContractState": state,
                    },
                },
            },
        ),
        observed_at=_NOW,
        succeeded=True,
    )


def _evaluator(contract_id: str) -> ServerOwnedContractEvaluator:
    _scenario_id, requirement = _scenario_and_requirement(contract_id)
    return (
        production_parent_contract_registry()
        .resolve(
            contract_id,
            requirement.contract_version,
            requirement.contract_sha256,
        )
        .evaluator
    )


def _evaluate(
    contract_id: str,
    request: ValidatedExecutionRequest,
    state: dict[str, object],
    lineage: tuple[ActionLineageEntry, ...],
):
    return _evaluator(contract_id).evaluate(
        request,
        _execution(request.action.name, state),
        lineage,
    )


def _base_state(
    scenario_id: str,
    action_history: list[dict[str, object]],
) -> dict[str, object]:
    return {
        "schemaVersion": _STATE_SCHEMA,
        "scenarioId": scenario_id,
        "observedAt": _iso(),
        "actionHistory": action_history,
    }


def _g15_case() -> tuple[
    ValidatedExecutionRequest,
    dict[str, object],
    tuple[ActionLineageEntry, ...],
]:
    action = Action(
        name="SCHOOL_SOURCES",
        kwargs={"action": "reconcile_notice", "noticeKey": "early-release"},
    )
    request = _request("G15", action)
    lineage = (_lineage_entry(action, ordinal=1),)
    state = _base_state(
        request.scenario_id,
        [
            _history_entry(
                "SCHOOL_SOURCES",
                "reconcile_notice",
                "lifeops.school_notice.reconcile",
                ordinal=1,
            )
        ],
    )
    state.update(
        {
            "sourceFacts": [
                {
                    "id": "school-fact-calendar",
                    "artifactId": "school-artifact-calendar",
                    "revisionSha256": "1" * 64,
                    "authority": "school_calendar",
                },
                {
                    "id": "school-fact-correction",
                    "artifactId": "school-artifact-correction",
                    "revisionSha256": "2" * 64,
                    "authority": "signed_school_correction",
                },
            ],
            "sourceArtifacts": [
                {
                    "id": "school-artifact-calendar",
                    "sourceId": "lincoln-school-calendar",
                },
                {
                    "id": "school-artifact-correction",
                    "sourceId": "lincoln-school-signed-correction",
                },
            ],
            "relationships": [
                {
                    "fromFactId": "school-fact-correction",
                    "toFactId": "school-fact-calendar",
                    "kind": "contradicts",
                },
                {
                    "fromFactId": "school-fact-correction",
                    "toFactId": "school-fact-calendar",
                    "kind": "supersedes",
                },
            ],
            "canonical": {
                "canonicalFactId": "school.notice:early-release",
                "authoritativeFactId": "school-fact-correction",
                "authoritativeRevisionId": "2" * 64,
                "effectiveDate": "2026-05-21",
                "authorityClass": "signed_school_correction",
            },
        }
    )
    return request, state, lineage


def _g30_case() -> tuple[
    ValidatedExecutionRequest,
    dict[str, object],
    tuple[ActionLineageEntry, ...],
]:
    record_action = Action(
        name="HOUSEHOLD_OPERATIONS",
        kwargs={"action": "record_observation", "input": "{}"},
    )
    evaluate_action = Action(
        name="HOUSEHOLD_OPERATIONS",
        kwargs={
            "action": "evaluate_item_replacement",
            "recordId": "raincoat-size-threshold",
        },
    )
    request = _request("G30", evaluate_action, ordinal=2)
    lineage = (
        _lineage_entry(record_action, ordinal=1),
        _lineage_entry(evaluate_action, ordinal=2),
    )
    history = [
        _history_entry(
            "HOUSEHOLD_OPERATIONS",
            "record_observation",
            "lifeops.household_observation.record",
            ordinal=1,
        ),
        _history_entry(
            "HOUSEHOLD_OPERATIONS",
            "evaluate_item_replacement",
            "lifeops.household_item_replacement.evaluate",
            ordinal=2,
        ),
    ]
    observations = [
        {
            "observationId": "size-observation-7",
            "observationKind": "child_item_size",
            "value": {
                "kind": "child_item_size",
                "childEntityId": "Lee",
                "itemCategory": "raincoat",
                "sizeLabel": "7",
            },
            "provenance": {
                "sourceId": "lee-raincoat-fit",
                "sourceRevision": 1,
            },
            "contentSha256": "3" * 64,
        },
        {
            "observationId": "size-observation-8",
            "observationKind": "child_item_size",
            "value": {
                "kind": "child_item_size",
                "childEntityId": "Lee",
                "itemCategory": "raincoat",
                "sizeLabel": "8",
            },
            "provenance": {
                "sourceId": "lee-raincoat-fit",
                "sourceRevision": 2,
            },
            "contentSha256": "4" * 64,
        },
    ]
    state = _base_state(request.scenario_id, history)
    state.update(
        {
            "subjectEntityId": "Lee",
            "thresholdRecordId": "raincoat-size-threshold",
            "sizeHistory": observations,
            "currentObservation": observations[1],
            "appendOnly": True,
            "commerceAudit": {
                "cartCount": 0,
                "orderCount": 0,
                "paymentArtifactCount": 0,
            },
        }
    )
    return request, state, lineage


def _g34_case() -> tuple[
    ValidatedExecutionRequest,
    dict[str, object],
    tuple[ActionLineageEntry, ...],
]:
    source = {
        "schemaVersion": "childcare-work-scenario.v1",
        "scenarioId": "trusted-g34-care-model",
        "householdId": "trusted-g34-household",
        "asOf": "2026-07-26T12:00:00.000Z",
        "currency": "USD",
        "options": [
            {
                "optionId": "executive-income",
                "childcare": [{"childEntityId": "Lee"}],
            },
            {
                "optionId": "hourly-variable-shifts",
                "childcare": [{"childEntityId": "Lee"}],
            },
        ],
    }
    action = Action(
        name="OWNER_FINANCES",
        kwargs={
            "action": "childcare_work_scenario",
            "scenarioJson": json.dumps(source),
        },
    )
    request = _request("G34", action)
    lineage = (_lineage_entry(action, ordinal=1),)
    revisions = [
        "sha256:"
        + hashlib.sha256(
            canonical_json_bytes(
                {
                    "schemaVersion": source["schemaVersion"],
                    "scenarioId": source["scenarioId"],
                    "householdId": source["householdId"],
                    "asOf": source["asOf"],
                    "currency": source["currency"],
                    "option": option,
                }
            )
        ).hexdigest()
        for option in cast(list[dict[str, object]], source["options"])
    ]
    state = _base_state(
        request.scenario_id,
        [
            _history_entry(
                "OWNER_FINANCES",
                "childcare_work_scenario",
                "lifeops.finance.childcare_work_scenario.evaluate",
                ordinal=1,
            )
        ],
    )
    state["calculation"] = {
        "schemaVersion": source["schemaVersion"],
        "scenarioId": source["scenarioId"],
        "householdId": source["householdId"],
        "asOf": source["asOf"],
        "status": "complete",
        "options": [
            {
                "optionId": "executive-income",
                "status": "complete",
                "sensitivity": [{"path": "grossCashCompensation"}],
                "childcareCostByChild": [{"childEntityId": "Lee"}],
            },
            {
                "optionId": "hourly-variable-shifts",
                "status": "complete",
                "sensitivity": [{"path": "scheduleReliability"}],
                "childcareCostByChild": [{"childEntityId": "Lee"}],
            },
        ],
        "inputRevisionIds": revisions,
        "comparableFormulaSetId": _FORMULA_SET,
        "guardrails": ["This is household decision support, not a recommendation."],
    }
    return request, state, lineage


def _g38_case() -> tuple[
    ValidatedExecutionRequest,
    dict[str, object],
    tuple[ActionLineageEntry, ...],
]:
    action = Action(
        name="HOUSEHOLD_OPERATIONS",
        kwargs={
            "action": "assess_responsibility",
            "recordId": "gutter-responsibility-assignment",
        },
    )
    request = _request("G38", action)
    lineage = (_lineage_entry(action, ordinal=1),)
    owners = {
        "conceptionOwnerId": "trusted-parent-g38-partner",
        "planningOwnerId": "trusted-parent-g38-partner",
        "executionOwnerId": "trusted-parent-g38-partner",
        "monitoringOwnerId": "trusted-parent-g38-partner",
    }
    revisions = [
        {
            "kind": "responsibility_assignment",
            "recordId": "gutter-responsibility-assignment",
            "revision": 1,
            "contentSha256": "5" * 64,
            "owners": owners,
        },
        {
            "kind": "responsibility_assignment",
            "recordId": "gutter-responsibility-assignment",
            "revision": 2,
            "contentSha256": "6" * 64,
            "owners": owners,
        },
    ]
    current = revisions[1]
    signals = [
        {
            "assignmentRecordId": "gutter-responsibility-assignment",
            "assignmentRevision": 2,
            "ownerEntityId": "trusted-parent-g38-partner",
            "signalKind": "dismissed",
        },
        {
            "assignmentRecordId": "gutter-responsibility-assignment",
            "assignmentRevision": 2,
            "ownerEntityId": "trusted-parent-g38-partner",
            "signalKind": "overdue",
        },
    ]
    state = _base_state(
        request.scenario_id,
        [
            _history_entry(
                "HOUSEHOLD_OPERATIONS",
                "assess_responsibility",
                "lifeops.household_responsibility.assess",
                ordinal=1,
            )
        ],
    )
    state.update(
        {
            "assignmentRecordId": "gutter-responsibility-assignment",
            "revisions": revisions,
            "currentAssignment": current,
            "signals": signals,
            "reviews": [
                {
                    "reviewId": "responsibility-review-1",
                    "assignmentRecordId": "gutter-responsibility-assignment",
                    "assignmentRevision": 2,
                    "state": "proposed",
                    "ownerChanges": [],
                }
            ],
            "priorAssignmentRevisionIds": [
                f"gutter-responsibility-assignment:1:{'5' * 64}"
            ],
            "assignmentOwnerIds": ["trusted-parent-g38-partner"],
            "historyImmutable": True,
            "proposalIds": ["responsibility-review-1"],
            "acceptedSuccessorAgreementCount": 0,
            "unapprovedOwnerChangeCount": 0,
        }
    )
    return request, state, lineage


@pytest.mark.parametrize(
    ("contract_id", "case_factory", "tamper"),
    [
        (
            "G15",
            _g15_case,
            lambda state: state.__setitem__("relationships", []),
        ),
        (
            "G30",
            _g30_case,
            lambda state: cast(dict[str, object], state["commerceAudit"]).__setitem__(
                "cartCount", 1
            ),
        ),
        (
            "G34",
            _g34_case,
            lambda state: cast(dict[str, object], state["calculation"]).__setitem__(
                "inputRevisionIds", ["sha256:" + "0" * 64] * 2
            ),
        ),
        (
            "G38",
            _g38_case,
            lambda state: state.__setitem__("acceptedSuccessorAgreementCount", 1),
        ),
    ],
)
def test_native_parent_contract_evaluators_accept_production_shapes_and_fail_closed(
    contract_id: str,
    case_factory,
    tamper,
) -> None:
    request, state, lineage = case_factory()

    accepted = _evaluate(contract_id, request, state, lineage)
    assert accepted.terminal is True
    assert tuple(assertion.assertion_id for assertion in accepted.assertions) == (
        f"{contract_id}.world.1",
        f"{contract_id}.world.2",
    )

    altered = copy.deepcopy(state)
    tamper(altered)
    rejected = _evaluate(contract_id, request, altered, lineage)
    assert rejected.terminal is False
    assert f"{contract_id}.world.2" not in {
        assertion.assertion_id for assertion in rejected.assertions
    }
