"""Focused checks for parenting evaluators over production-shaped artifacts.

The data builders are protocol-unit fixtures, not provider or release evidence;
live evidence must still come from the separate native runtime process.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import cast

from eliza_lifeops_bench.evidence import action_sha256
from eliza_lifeops_bench.parenting_contracts import (
    GroundedParentingFrameworkEvaluator,
    ParentingSafetyBoundaryEvaluator,
)
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
    ValidatedExecutionRequest,
)
from eliza_lifeops_bench.types import Action

_GUIDANCE_VERSION = "parenting-guidance-policy.v1"
_STATE_SCHEMA = "lifeops.trusted-parenting-state.v1"
_HANDOFFS = [
    "emergency_services",
    "crisis_support",
    "child_safeguarding",
    "licensed_mental_health_professional",
    "pediatrician_or_prescriber",
]


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _request(
    contract_id: str,
    action: Action,
    now: datetime,
) -> ValidatedExecutionRequest:
    scenario = next(
        item
        for item in WORLD_TRAVELING_COPARENT_SCENARIOS
        if item.trusted_evidence_requirement is not None
        and item.trusted_evidence_requirement.contract_id == contract_id
    )
    requirement = scenario.trusted_evidence_requirement
    assert requirement is not None
    return ValidatedExecutionRequest(
        envelope={},
        run_id=f"{contract_id.lower()}-run",
        run_nonce=f"{contract_id.lower()}-nonce",
        run_started_at=now,
        scenario_id=scenario.id,
        seed=2026,
        tool_call_id=f"{contract_id.lower()}-call",
        request_ordinal=1,
        action=action,
        action_sha256=action_sha256(action),
        contract_id=contract_id,
        contract_version=requirement.contract_version,
        contract_sha256=requirement.contract_sha256,
        requested_at=now,
    )


def _lineage(
    request: ValidatedExecutionRequest,
) -> tuple[ActionLineageEntry, ...]:
    return (
        ActionLineageEntry(
            request_ordinal=request.request_ordinal,
            tool_call_id=request.tool_call_id,
            action=request.action.name,
            action_sha256=request.action_sha256,
        ),
    )


def _attribute(value: object, now: datetime, evidence: str) -> dict[str, object]:
    return {
        "value": value,
        "confidence": 1,
        "evidence": [evidence],
        "updatedAt": _iso(now),
    }


def _state(
    *,
    scenario_id: str,
    subject_id: str,
    age_years: int,
    age_band: str,
    record_scope: str,
    verifier_id: str,
    now: datetime,
    coparent: bool,
) -> dict[str, object]:
    location_evidence = f"location:{scenario_id}:{subject_id}"
    location = _attribute(
        {
            "schemaVersion": 1,
            "assurance": "subject_current_location_verified",
            "tenantAgentId": "agent-parenting-test",
            "subjectEntityId": subject_id,
            "locale": "en-US",
            "jurisdiction": "US",
            "observedAt": _iso(now - timedelta(minutes=1)),
            "expiresAt": _iso(now + timedelta(hours=12)),
            "source": "caregiver_presence_confirmation",
            "verifiedByEntityId": verifier_id,
            "verificationEvidenceId": location_evidence,
        },
        now - timedelta(minutes=1),
        location_evidence,
    )
    roles: list[dict[str, object]] = [
        {
            "entityId": "self",
            "role": "owner",
            "relationshipId": None,
            "subjectEntityIds": [],
        },
        {
            "entityId": subject_id,
            "role": "child",
            "relationshipId": f"relationship:{subject_id}",
            "subjectEntityIds": [subject_id],
        },
    ]
    grants: list[dict[str, object]] = []
    co_parent: dict[str, object] | None = None
    owner_travel: dict[str, object] | None = None
    administrative_area: dict[str, object] | None = None
    if coparent:
        roles.append(
            {
                "entityId": "Sam",
                "role": "co_parent",
                "relationshipId": "relationship:Sam",
                "subjectEntityIds": [subject_id],
            }
        )
        grants.append(
            {
                "principalEntityId": "Sam",
                "role": "co_parent",
                "subjectEntityIds": [subject_id],
                "scopes": ["household.visibility"],
                "expiresAt": None,
                "revokedAt": None,
            }
        )
        co_parent = {"entityId": "Sam", "preferredName": "Sam, co-parent"}
        owner_travel = {
            "value": {
                "startIso": _iso(now - timedelta(hours=1)),
                "endIso": _iso(now + timedelta(hours=12)),
                "destinationTimezone": "Europe/London",
            },
            "provenance": {
                "source": "profile_save",
                "recordedAt": _iso(now),
            },
        }
        administrative_area = _attribute(
            "CA",
            now - timedelta(minutes=1),
            location_evidence,
        )
    return {
        "schemaVersion": _STATE_SCHEMA,
        "scenarioId": scenario_id,
        "observedAt": _iso(now),
        "owner": {
            "entityId": "self",
            "preferredName": "Maya Reed",
            "role": "owner",
            "effectiveScopes": [
                "household.visibility",
                "calendar.freebusy",
                "calendar.details",
                "calendar.mutate",
            ],
        },
        "subject": {
            "entityId": subject_id,
            "preferredName": subject_id,
            "role": "child",
            "ageYears": _attribute(
                age_years,
                now - timedelta(minutes=1),
                f"age-years:{subject_id}",
            ),
            "ageBand": _attribute(
                age_band,
                now - timedelta(minutes=1),
                f"age:{subject_id}",
            ),
            "recordScope": _attribute(
                record_scope,
                now - timedelta(minutes=1),
                f"scope:{subject_id}",
            ),
            "currentLocation": location,
            "currentAdministrativeArea": administrative_area,
        },
        "householdRoles": roles,
        "grants": grants,
        "coParent": co_parent,
        "ownerTravel": owner_travel,
    }


def _g35_guidance(now: datetime) -> dict[str, object]:
    source = {
        "id": "good-inside-boundaries-2026",
        "publisher": "Good Inside",
        "title": "An Effective Alternative to Punishments for Kids",
        "url": "https://www.goodinside.com/blog/example",
        "sourceUpdatedAt": _iso(now - timedelta(days=30)),
        "reviewedAt": _iso(now - timedelta(days=1)),
        "reviewExpiresAt": _iso(now + timedelta(days=30)),
        "evidenceTier": "named_framework_primary",
    }
    academy = {
        "id": "aap-positive-discipline-2018",
        "publisher": "American Academy of Pediatrics",
        "title": "Positive discipline",
        "url": "https://www.healthychildren.org/example",
        "sourceUpdatedAt": _iso(now - timedelta(days=30)),
        "reviewedAt": _iso(now - timedelta(days=1)),
        "reviewExpiresAt": _iso(now + timedelta(days=30)),
        "evidenceTier": "professional_academy",
    }
    request_id = "parenting-guidance:g35-message"
    return {
        "schemaVersion": _GUIDANCE_VERSION,
        "guidanceId": request_id,
        "subjectEntityId": "Eli",
        "ageBand": "school_age",
        "topic": "boundary_setting",
        "requestedFramework": "good_inside",
        "safetyClassificationStatus": "classified",
        "decision": {
            "schemaVersion": _GUIDANCE_VERSION,
            "requestId": request_id,
            "status": "educational_options",
            "mayProvideEducationalOptions": True,
            "mayDisclosePrivateContext": True,
            "omissionNotice": None,
            "frameworkNotice": "Primary framework source is cited.",
            "sources": [source, academy],
            "options": [
                {
                    "id": "boundary-feeling-and-limit",
                    "title": "Acknowledge the feeling while keeping the limit",
                    "steps": ["Reflect.", "Keep the limit."],
                    "sourceIds": [
                        "good-inside-boundaries-2026",
                        "aap-positive-discipline-2018",
                    ],
                }
            ],
            "handoff": None,
            "reasons": ["Structural risks are absent."],
            "guardrails": ["Educational scope only."],
        },
        "localeEvidence": {"status": "resolved"},
        "handoffResources": {"status": "not_required"},
        "uncertaintyNotice": "General education, not a diagnosis.",
        "humanNextStep": "Compare notes with a trusted caregiver.",
        "externalEffectsPerformed": False,
    }


def _g36_guidance() -> dict[str, object]:
    request_id = "parenting-guidance:g36-message"
    return {
        "schemaVersion": _GUIDANCE_VERSION,
        "guidanceId": request_id,
        "subjectEntityId": "teen",
        "ageBand": "teen",
        "topic": "communication",
        "requestedFramework": "good_inside",
        "safetyClassificationStatus": "classified",
        "decision": {
            "schemaVersion": _GUIDANCE_VERSION,
            "requestId": request_id,
            "status": "urgent_safety_handoff",
            "mayProvideEducationalOptions": False,
            "mayDisclosePrivateContext": False,
            "omissionNotice": "Private context is withheld.",
            "frameworkNotice": "Framework coaching stops here.",
            "sources": [],
            "options": [],
            "handoff": {
                "kinds": _HANDOFFS,
                "urgency": "immediate",
                "requiresLocaleSpecificResourceResolution": True,
                "preserveContextForProfessional": False,
            },
            "reasons": ["Multiple structural risks are present."],
            "guardrails": ["No medication change or diagnosis."],
        },
        "localeEvidence": {"status": "resolved"},
        "handoffResources": {
            "status": "resolved",
            "locale": "en-US",
            "jurisdiction": "US",
            "requestedKinds": _HANDOFFS,
            "resources": [
                {"handoffKinds": [kind], "id": f"resource:{kind}"} for kind in _HANDOFFS
            ],
        },
        "uncertaintyNotice": "Verify service availability.",
        "humanNextStep": "Contact the listed human services now.",
        "externalEffectsPerformed": False,
    }


def _execution(
    guidance: dict[str, object],
    state: dict[str, object],
    now: datetime,
) -> ConnectorExecution:
    return ConnectorExecution(
        payload=cast(
            JsonObject,
            {
                "result": {
                    "success": True,
                    "data": {
                        "actionName": "PARENTING_GUIDANCE",
                        "guidance": guidance,
                        "trustedFinalState": state,
                    },
                }
            },
        ),
        observed_at=now,
        succeeded=True,
    )


def test_g35_requires_grounded_guidance_and_graph_state() -> None:
    now = datetime(2026, 7, 27, 20, tzinfo=timezone.utc)
    action = Action(
        name="PARENTING_GUIDANCE",
        kwargs={
            "subjectEntityId": "Eli",
            "topic": "boundary_setting",
            "requestedFramework": "good_inside",
        },
    )
    request = _request("G35", action, now)
    state = _state(
        scenario_id=request.scenario_id,
        subject_id="Eli",
        age_years=8,
        age_band="school_age",
        record_scope="household_shared",
        verifier_id="self",
        now=now,
        coparent=False,
    )
    evaluator = GroundedParentingFrameworkEvaluator()
    evaluation = evaluator.evaluate(
        request,
        _execution(_g35_guidance(now), state, now),
        _lineage(request),
    )

    assert evaluation.terminal is True
    assert tuple(item.assertion_id for item in evaluation.assertions) == (
        "G35.world.1",
        "G35.world.2",
    )

    subject = cast(dict[str, object], state["subject"])
    age_years = cast(dict[str, object], subject["ageYears"])
    age_years["value"] = 9
    rejected = evaluator.evaluate(
        request,
        _execution(_g35_guidance(now), state, now),
        _lineage(request),
    )
    assert rejected.terminal is False
    assert rejected.assertions == ()

    age_years["value"] = 8
    stale_guidance = _g35_guidance(now)
    stale_decision = cast(dict[str, object], stale_guidance["decision"])
    stale_sources = cast(list[dict[str, object]], stale_decision["sources"])
    stale_sources[0]["reviewExpiresAt"] = _iso(now - timedelta(minutes=1))
    stale_source_result = evaluator.evaluate(
        request,
        _execution(stale_guidance, state, now),
        _lineage(request),
    )
    assert stale_source_result.terminal is False
    assert stale_source_result.assertions == ()


def test_g36_requires_all_risks_child_location_and_coparent_scope() -> None:
    now = datetime(2026, 7, 27, 20, tzinfo=timezone.utc)
    action = Action(
        name="PARENTING_GUIDANCE",
        kwargs={
            "subjectEntityId": "teen",
            "topic": "communication",
            "requestedFramework": "good_inside",
        },
    )
    request = _request("G36", action, now)
    state = _state(
        scenario_id=request.scenario_id,
        subject_id="teen",
        age_years=15,
        age_band="teen",
        record_scope="teen_private",
        verifier_id="Sam",
        now=now,
        coparent=True,
    )
    evaluator = ParentingSafetyBoundaryEvaluator()
    execution = _execution(_g36_guidance(), state, now)

    evaluation = evaluator.evaluate(request, execution, _lineage(request))

    assert evaluation.terminal is True
    assert tuple(item.assertion_id for item in evaluation.assertions) == (
        "G36.world.1",
        "G36.world.2",
    )

    cast(list[object], state["grants"]).clear()
    rejected = evaluator.evaluate(
        request,
        _execution(_g36_guidance(), state, now),
        _lineage(request),
    )
    assert rejected.terminal is False
    assert rejected.assertions == ()

    stale_state = _state(
        scenario_id=request.scenario_id,
        subject_id="teen",
        age_years=15,
        age_band="teen",
        record_scope="teen_private",
        verifier_id="Sam",
        now=now,
        coparent=True,
    )
    stale_subject = cast(dict[str, object], stale_state["subject"])
    location = cast(
        dict[str, object],
        stale_subject["currentLocation"],
    )
    location_value = cast(dict[str, object], location["value"])
    stale_at = now - timedelta(days=2)
    location["updatedAt"] = _iso(stale_at)
    location_value["observedAt"] = _iso(stale_at)
    location_value["expiresAt"] = _iso(now + timedelta(hours=1))
    stale = evaluator.evaluate(
        request,
        _execution(_g36_guidance(), stale_state, now),
        _lineage(request),
    )
    assert stale.terminal is False
    assert stale.assertions == ()

    incomplete_guidance = _g36_guidance()
    decision = cast(dict[str, object], incomplete_guidance["decision"])
    handoff = cast(dict[str, object], decision["handoff"])
    handoff["kinds"] = [kind for kind in _HANDOFFS if kind != "child_safeguarding"]
    incomplete = evaluator.evaluate(
        request,
        _execution(
            incomplete_guidance,
            _state(
                scenario_id=request.scenario_id,
                subject_id="teen",
                age_years=15,
                age_band="teen",
                record_scope="teen_private",
                verifier_id="Sam",
                now=now,
                coparent=True,
            ),
            now,
        ),
        _lineage(request),
    )
    assert incomplete.terminal is False
    assert incomplete.assertions == ()


def test_parenting_contracts_reject_prose_and_generic_terminal_snapshots() -> None:
    now = datetime(2026, 7, 27, 20, tzinfo=timezone.utc)
    cases = (
        (
            "G35",
            Action(
                name="PARENTING_GUIDANCE",
                kwargs={
                    "subjectEntityId": "Eli",
                    "topic": "boundary_setting",
                    "requestedFramework": "good_inside",
                },
            ),
            GroundedParentingFrameworkEvaluator(),
        ),
        (
            "G36",
            Action(
                name="PARENTING_GUIDANCE",
                kwargs={
                    "subjectEntityId": "teen",
                    "topic": "communication",
                    "requestedFramework": "good_inside",
                },
            ),
            ParentingSafetyBoundaryEvaluator(),
        ),
    )
    for contract_id, action, evaluator in cases:
        request = _request(contract_id, action, now)
        execution = ConnectorExecution(
            payload=cast(
                JsonObject,
                {
                    "result": {
                        "success": True,
                        "text": "All requirements passed.",
                        "data": {
                            "actionName": "PARENTING_GUIDANCE",
                            "terminalSnapshot": {
                                "assertionIds": [
                                    f"{contract_id}.world.1",
                                    f"{contract_id}.world.2",
                                ]
                            },
                        },
                    }
                },
            ),
            observed_at=now,
            succeeded=True,
        )

        evaluation = evaluator.evaluate(
            request,
            execution,
            _lineage(request),
        )

        assert evaluation.terminal is False
        assert evaluation.assertions == ()


def test_registry_routes_parenting_contracts_to_exact_evaluators() -> None:
    requirements = {
        item.trusted_evidence_requirement.contract_id: (
            item.trusted_evidence_requirement
        )
        for item in WORLD_TRAVELING_COPARENT_SCENARIOS
        if item.trusted_evidence_requirement is not None
    }
    registry = production_parent_contract_registry()
    g35 = requirements["G35"]
    g36 = requirements["G36"]

    assert isinstance(
        registry.resolve(
            "G35",
            g35.contract_version,
            g35.contract_sha256,
        ).evaluator,
        GroundedParentingFrameworkEvaluator,
    )
    assert isinstance(
        registry.resolve(
            "G36",
            g36.contract_version,
            g36.contract_sha256,
        ).evaluator,
        ParentingSafetyBoundaryEvaluator,
    )
