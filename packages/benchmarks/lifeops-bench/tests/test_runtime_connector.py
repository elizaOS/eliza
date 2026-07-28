"""Socket-level checks for the native runtime connector and exact G10 contract."""

from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import replace
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import cast

import pytest

from eliza_lifeops_bench.evidence import action_sha256
from eliza_lifeops_bench.runtime_connector import (
    CalendarPartialFailureEvaluator,
    ElizaRuntimeActionConnector,
    TRUSTED_RUNTIME_ACTION_SCHEMA,
    TRUSTED_RUNTIME_EVIDENCE_PROVENANCE_SCHEMA,
    production_parent_contract_registry,
)
from eliza_lifeops_bench.scenarios import WORLD_TRAVELING_COPARENT_SCENARIOS
from eliza_lifeops_bench.trusted_executor_server import (
    ConnectorExecution,
    ContractEvaluation,
    TrustedExecutorHttpError,
    ValidatedExecutionRequest,
)
from eliza_lifeops_bench.types import Action, TrustedActionPolicy

_TOKEN = "runtime-connector-test-token-0123456789abcdef"
_IDEMPOTENCY_KEY = (
    "lifeops-0123456789abcdef0123456789abcdef" "0123456789abcdef0123456789abcdef"
)
_OBSERVED_AT = "2026-07-27T19:00:00.000Z"


def _local_provenance() -> dict[str, object]:
    return {
        "schema": TRUSTED_RUNTIME_EVIDENCE_PROVENANCE_SCHEMA,
        "tier": "local_nonpublishable",
        "publishable": False,
        "configuration_basis": "default_local_configuration",
        "provider": None,
        "boundary": None,
        "account_identity_sha256": None,
        "provider_readback": "not_applicable",
    }


def _provider_provenance() -> dict[str, object]:
    return {
        "schema": TRUSTED_RUNTIME_EVIDENCE_PROVENANCE_SCHEMA,
        "tier": "provider_backed",
        "publishable": False,
        "configuration_basis": "explicit_server_configuration",
        "provider": "google-calendar",
        "boundary": "sandbox_connector",
        "account_identity_sha256": "a" * 64,
        "provider_readback": "not_verified",
    }


def _source(
    *,
    provider: str,
    account: str,
    status: str,
) -> dict[str, object]:
    key = {
        "provider": provider,
        "side": "owner",
        "grantId": f"grant:{account}",
        "connectorAccountId": account,
        "calendarId": "primary",
    }
    return {
        "key": key,
        "accountEmail": f"{account}@example.test",
        "summary": account,
        "primary": True,
        "accessRole": "owner",
        "includeInFeed": True,
        "selectionVersion": 1,
        "health": {
            "key": key,
            "summary": account,
            "accessRole": "owner",
            "visibility": "details",
            "status": status,
            "syncedAt": (_OBSERVED_AT if status in {"fresh", "stale"} else None),
            "error": (
                None
                if status in {"fresh", "stale"}
                else {
                    "code": "SOURCE_FAILED",
                    "message": "Provider observation failed.",
                    "retryable": True,
                }
            ),
        },
    }


def _snapshot(
    *,
    state: str = "partial",
    statuses: tuple[str, ...] = ("fresh", "stale", "error"),
) -> dict[str, object]:
    providers = ("google", "apple_calendar", "ics", "microsoft")
    accounts = ("personal", "family", "school", "work")
    return {
        "state": state,
        "sources": [
            _source(
                provider=providers[index],
                account=accounts[index],
                status=status,
            )
            for index, status in enumerate(statuses)
        ],
        "observedAt": _OBSERVED_AT,
    }


def _request(action: Action | None = None) -> ValidatedExecutionRequest:
    selected = action or Action(
        name="CALENDAR_SOURCES",
        kwargs={"operation": "list"},
    )
    requirement = next(
        scenario.trusted_evidence_requirement
        for scenario in WORLD_TRAVELING_COPARENT_SCENARIOS
        if scenario.trusted_evidence_requirement is not None
        and scenario.trusted_evidence_requirement.contract_id == "G10"
    )
    now = datetime.now(timezone.utc)
    return ValidatedExecutionRequest(
        envelope={},
        run_id="run-1",
        run_nonce="nonce-1",
        run_started_at=now,
        scenario_id="m1.g10.partial_calendar_failure",
        seed=2026,
        tool_call_id="call-1",
        request_ordinal=1,
        action=selected,
        action_sha256=action_sha256(selected),
        contract_id="G10",
        contract_version=requirement.contract_version,
        contract_sha256=requirement.contract_sha256,
        requested_at=now,
    )


@contextmanager
def _runtime_server(
    *,
    stand_in: bool = False,
    result: dict[str, object] | None = None,
    evidence_provenance: dict[str, object] | None = None,
    release_evidence: bool = False,
) -> Iterator[str]:
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            length = int(self.headers["Content-Length"])
            request = json.loads(self.rfile.read(length))
            observed_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            action_result = result or {
                "success": True,
                "data": {
                    "actionName": request["action"]["name"],
                    "operation": request["action"]["parameters"].get("operation"),
                    "snapshot": _snapshot(),
                },
            }
            response = {
                "schema": TRUSTED_RUNTIME_ACTION_SCHEMA,
                "ok": action_result["success"],
                "task_id": request["task_id"],
                "action": request["action"]["name"],
                "idempotency_key": request["idempotency_key"],
                "risk": request["risk"],
                "requested_at": request["requested_at"],
                "observed_at": observed_at,
                "runtime": {
                    "native_runtime_class": "@elizaos/core.AgentRuntime",
                    "native_runtime_api": "Action.handler",
                    "transport": "trusted_runtime_http",
                    "stand_in": stand_in,
                    "release_evidence": release_evidence,
                    "evidence_provenance": (
                        evidence_provenance
                        if evidence_provenance is not None
                        else _local_provenance()
                    ),
                    "action_tags": ["domain:calendar", "capability:read"],
                },
                "result": action_result,
            }
            body = json.dumps(response).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, _format: str, *_args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        host, port = cast(tuple[str, int], server.server_address)
        yield f"http://{host}:{port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def _read_policy() -> TrustedActionPolicy:
    return TrustedActionPolicy(
        name="CALENDAR_SOURCES",
        discriminator_field="operation",
        allowed_discriminators=("list",),
        risk="read",
        max_calls=12,
    )


def _proposal_policy() -> TrustedActionPolicy:
    return TrustedActionPolicy(
        name="CALENDAR_SOURCES",
        discriminator_field="operation",
        allowed_discriminators=("select",),
        risk="proposal",
        max_calls=1,
    )


def _applied_result(
    *,
    commit_kind: str,
    domain_idempotency_key: object,
) -> dict[str, object]:
    return {
        "success": True,
        "data": {"actionName": "CALENDAR_SOURCES"},
        "effectReceipts": [
            {
                "receiptId": "calendar-source-effect-1",
                "operation": "calendar.source.select",
                "outcome": "applied",
                "observedAt": _OBSERVED_AT,
                "resource": {
                    "kind": "calendar.source.selection",
                    "id": "source-selection-1",
                    "version": "1",
                },
                "artifacts": [],
                "idempotency": {
                    "key": domain_idempotency_key,
                    "replayed": False,
                },
                "trustedRuntimeInvocation": {
                    "idempotencyKey": _IDEMPOTENCY_KEY,
                },
                "commit": {
                    "kind": commit_kind,
                    "id": "source-selection-commit-1",
                    "committedAt": _OBSERVED_AT,
                },
            }
        ],
    }


@pytest.mark.parametrize(
    "evidence_provenance",
    [_local_provenance(), _provider_provenance()],
    ids=["local_nonpublishable", "provider_backed_not_verified"],
)
def test_native_runtime_connector_rejects_current_provenance_tiers(
    evidence_provenance: dict[str, object],
) -> None:
    with _runtime_server(evidence_provenance=evidence_provenance) as url:
        connector = ElizaRuntimeActionConnector(url, _TOKEN)
        with pytest.raises(
            TrustedExecutorHttpError,
            match="lacks verified server-owned provider readback",
        ):
            connector.execute(
                _request().action,
                idempotency_key=_IDEMPOTENCY_KEY,
                request=_request(),
                policy=_read_policy(),
            )


def test_native_runtime_connector_rejects_stand_in_provenance() -> None:
    with _runtime_server(stand_in=True) as url:
        connector = ElizaRuntimeActionConnector(url, _TOKEN)
        with pytest.raises(
            TrustedExecutorHttpError,
            match="native runtime protocol",
        ):
            connector.execute(
                _request().action,
                idempotency_key=_IDEMPOTENCY_KEY,
                request=_request(),
                policy=_read_policy(),
            )


def test_explicit_provider_configuration_cannot_set_release_evidence() -> None:
    with _runtime_server(
        evidence_provenance=_provider_provenance(),
        release_evidence=True,
    ) as url:
        connector = ElizaRuntimeActionConnector(url, _TOKEN)
        with pytest.raises(
            TrustedExecutorHttpError,
            match="native runtime protocol",
        ):
            connector.execute(
                _request().action,
                idempotency_key=_IDEMPOTENCY_KEY,
                request=_request(),
                policy=_read_policy(),
            )


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("schema", "eliza.trusted-runtime-evidence-provenance.v0"),
        ("publishable", True),
        ("configuration_basis", "operator_claim"),
        ("provider", "Google Calendar"),
        ("boundary", "operator_process"),
        ("boundary", []),
        ("account_identity_sha256", "A" * 64),
        ("account_identity_sha256", 7),
        ("provider_readback", "verified"),
    ],
)
def test_provider_provenance_rejects_noncanonical_fields(
    field: str,
    value: object,
) -> None:
    provenance = _provider_provenance()
    provenance[field] = value
    with _runtime_server(evidence_provenance=provenance) as url:
        connector = ElizaRuntimeActionConnector(url, _TOKEN)
        with pytest.raises(TrustedExecutorHttpError, match="provenance"):
            connector.execute(
                _request().action,
                idempotency_key=_IDEMPOTENCY_KEY,
                request=_request(),
                policy=_read_policy(),
            )


@pytest.mark.parametrize("mutation", ["missing", "extra"])
def test_provider_provenance_requires_exact_fields(mutation: str) -> None:
    provenance = _provider_provenance()
    if mutation == "missing":
        del provenance["provider_readback"]
    else:
        provenance["operator_verified"] = True
    with _runtime_server(evidence_provenance=provenance) as url:
        connector = ElizaRuntimeActionConnector(url, _TOKEN)
        with pytest.raises(
            TrustedExecutorHttpError,
            match="provenance fields",
        ):
            connector.execute(
                _request().action,
                idempotency_key=_IDEMPOTENCY_KEY,
                request=_request(),
                policy=_read_policy(),
            )


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("publishable", True),
        ("configuration_basis", "explicit_server_configuration"),
        ("provider", "local-provider"),
        ("boundary", "sandbox_connector"),
        ("account_identity_sha256", "a" * 64),
        ("provider_readback", "not_verified"),
    ],
)
def test_local_provenance_rejects_provider_claims(
    field: str,
    value: object,
) -> None:
    provenance = _local_provenance()
    provenance[field] = value
    with _runtime_server(evidence_provenance=provenance) as url:
        connector = ElizaRuntimeActionConnector(url, _TOKEN)
        with pytest.raises(
            TrustedExecutorHttpError,
            match="local evidence provenance",
        ):
            connector.execute(
                _request().action,
                idempotency_key=_IDEMPOTENCY_KEY,
                request=_request(),
                policy=_read_policy(),
            )


def test_native_runtime_connector_rejects_top_level_terminal_snapshot() -> None:
    result = {
        "success": True,
        "data": {
            "actionName": "CALENDAR_SOURCES",
            "terminalSnapshot": {"forged": True},
        },
    }
    with _runtime_server(result=result) as url:
        connector = ElizaRuntimeActionConnector(url, _TOKEN)
        with pytest.raises(
            TrustedExecutorHttpError,
            match="forbidden action-authored terminalSnapshot",
        ):
            connector.execute(
                _request().action,
                idempotency_key=_IDEMPOTENCY_KEY,
                request=_request(),
                policy=_read_policy(),
            )


def test_nested_domain_terminal_snapshot_is_not_treated_as_evidence() -> None:
    result = {
        "success": True,
        "data": {
            "actionName": "CALENDAR_SOURCES",
            "domain": {"terminalSnapshot": {"domainValue": True}},
        },
    }
    with _runtime_server(result=result) as url:
        connector = ElizaRuntimeActionConnector(url, _TOKEN)
        with pytest.raises(
            TrustedExecutorHttpError,
            match="lacks verified server-owned provider readback",
        ):
            connector.execute(
                _request().action,
                idempotency_key=_IDEMPOTENCY_KEY,
                request=_request(),
                policy=_read_policy(),
            )


def test_native_runtime_connector_rejects_mutation_without_effect_receipt() -> None:
    action = Action(
        name="CALENDAR_SOURCES",
        kwargs={"operation": "select"},
    )
    result = {
        "success": True,
        "data": {"actionName": "CALENDAR_SOURCES"},
    }
    with _runtime_server(result=result) as url:
        connector = ElizaRuntimeActionConnector(url, _TOKEN)
        with pytest.raises(
            TrustedExecutorHttpError,
            match="no effect receipts",
        ):
            connector.execute(
                action,
                idempotency_key=_IDEMPOTENCY_KEY,
                request=_request(action),
                policy=_proposal_policy(),
            )


@pytest.mark.parametrize("domain_key", [None, "", "different-idempotency-key"])
def test_provider_accepted_receipt_requires_outer_domain_idempotency_key(
    domain_key: object,
) -> None:
    action = Action(name="CALENDAR_SOURCES", kwargs={"operation": "select"})
    with _runtime_server(
        result=_applied_result(
            commit_kind="provider_accepted",
            domain_idempotency_key=domain_key,
        ),
        evidence_provenance=_provider_provenance(),
    ) as url:
        connector = ElizaRuntimeActionConnector(url, _TOKEN)
        with pytest.raises(
            TrustedExecutorHttpError,
            match="domain idempotency",
        ):
            connector.execute(
                action,
                idempotency_key=_IDEMPOTENCY_KEY,
                request=_request(action),
                policy=_proposal_policy(),
            )


def test_provider_accepted_receipt_requires_verified_provider_readback() -> None:
    action = Action(name="CALENDAR_SOURCES", kwargs={"operation": "select"})
    with _runtime_server(
        result=_applied_result(
            commit_kind="provider_accepted",
            domain_idempotency_key=_IDEMPOTENCY_KEY,
        ),
        evidence_provenance=_provider_provenance(),
    ) as url:
        connector = ElizaRuntimeActionConnector(url, _TOKEN)
        with pytest.raises(
            TrustedExecutorHttpError,
            match="lacks verified server-owned provider readback provenance",
        ):
            connector.execute(
                action,
                idempotency_key=_IDEMPOTENCY_KEY,
                request=_request(action),
                policy=_proposal_policy(),
            )


def test_durable_local_receipt_is_structural_but_never_release_evidence() -> None:
    action = Action(name="CALENDAR_SOURCES", kwargs={"operation": "select"})
    with _runtime_server(
        result=_applied_result(
            commit_kind="durable",
            domain_idempotency_key=None,
        )
    ) as url:
        connector = ElizaRuntimeActionConnector(url, _TOKEN)
        with pytest.raises(
            TrustedExecutorHttpError,
            match="lacks verified server-owned provider readback",
        ):
            connector.execute(
                action,
                idempotency_key=_IDEMPOTENCY_KEY,
                request=_request(action),
                policy=_proposal_policy(),
            )


def _evaluate_g10(
    snapshot: dict[str, object],
    *,
    observed_at: datetime | None = None,
) -> ContractEvaluation:
    request = _request()
    execution = ConnectorExecution(
        payload={
            "result": {
                "success": True,
                "data": {
                    "actionName": "CALENDAR_SOURCES",
                    "snapshot": snapshot,
                },
            }
        },
        observed_at=observed_at
        or datetime.fromisoformat(_OBSERVED_AT.replace("Z", "+00:00")),
        succeeded=True,
    )
    return CalendarPartialFailureEvaluator().evaluate(
        request,
        execution,
        (),
    )


@pytest.mark.parametrize("degraded_status", ["stale", "error", "disconnected"])
def test_g10_evaluator_requires_fresh_and_degraded_sources(
    degraded_status: str,
) -> None:
    evaluation = _evaluate_g10(
        _snapshot(statuses=("fresh", degraded_status)),
    )
    assert evaluation.terminal is True
    assert tuple(assertion.assertion_id for assertion in evaluation.assertions) == (
        "G10.world.1",
        "G10.world.2",
    )


@pytest.mark.parametrize(
    ("state", "statuses"),
    [
        ("partial", ("fresh", "fresh")),
        ("partial", ("stale", "error")),
        ("complete", ("fresh", "stale")),
        ("unavailable", ("fresh", "error")),
        ("complete", ("fresh", "fresh")),
        ("unavailable", ("stale", "disconnected")),
    ],
)
def test_g10_evaluator_rejects_nonpartial_or_contradictory_aggregates(
    state: str,
    statuses: tuple[str, ...],
) -> None:
    evaluation = _evaluate_g10(_snapshot(state=state, statuses=statuses))

    assert evaluation.terminal is False
    assert evaluation.assertions == ()


@pytest.mark.parametrize(
    "contradiction",
    [
        "fresh_with_error",
        "error_without_error",
        "source_health_role_mismatch",
        "duplicate_identity",
        "stale_without_observation",
    ],
)
def test_g10_evaluator_rejects_contradictory_source_health(
    contradiction: str,
) -> None:
    snapshot = _snapshot(statuses=("fresh", "error"))
    sources = snapshot["sources"]
    assert isinstance(sources, list)
    first = sources[0]
    second = sources[1]
    assert isinstance(first, dict)
    assert isinstance(second, dict)
    first_health = first["health"]
    second_health = second["health"]
    assert isinstance(first_health, dict)
    assert isinstance(second_health, dict)

    if contradiction == "fresh_with_error":
        first_health["error"] = {
            "code": "IMPOSSIBLE_FRESH_ERROR",
            "message": "Fresh state cannot also carry an error.",
            "retryable": False,
        }
    elif contradiction == "error_without_error":
        second_health["error"] = None
    elif contradiction == "source_health_role_mismatch":
        second_health["accessRole"] = "reader"
    elif contradiction == "duplicate_identity":
        second["key"] = first["key"]
        second_health["key"] = first["key"]
    else:
        second_health["status"] = "stale"
        second_health["syncedAt"] = None
        second_health["error"] = None

    evaluation = _evaluate_g10(snapshot)

    assert evaluation.terminal is False
    assert evaluation.assertions == ()


def test_g10_evaluator_rejects_stale_snapshot_capture() -> None:
    snapshot_time = datetime.fromisoformat(_OBSERVED_AT.replace("Z", "+00:00"))
    evaluation = _evaluate_g10(
        _snapshot(statuses=("fresh", "error")),
        observed_at=snapshot_time.replace(hour=snapshot_time.hour + 1),
    )

    assert evaluation.terminal is False
    assert evaluation.assertions == ()


def test_production_registry_registers_every_contract_fail_closed() -> None:
    registry = production_parent_contract_registry()
    g10 = _request()

    assert (
        registry.resolve(
            g10.contract_id,
            g10.contract_version,
            g10.contract_sha256,
        ).requirement.contract_id
        == "G10"
    )
    g1 = next(
        scenario.trusted_evidence_requirement
        for scenario in WORLD_TRAVELING_COPARENT_SCENARIOS
        if scenario.trusted_evidence_requirement is not None
        and scenario.trusted_evidence_requirement.contract_id == "G1"
    )
    registered = registry.resolve(
        g1.contract_id,
        g1.contract_version,
        g1.contract_sha256,
    )
    request = _request()
    g1_request = replace(
        request,
        contract_id=g1.contract_id,
        contract_version=g1.contract_version,
        contract_sha256=g1.contract_sha256,
    )
    missing_snapshot = registered.evaluator.evaluate(
        g1_request,
        ConnectorExecution(
            payload={
                "result": {
                    "success": True,
                    "data": {"actionName": g1_request.action.name},
                }
            },
            observed_at=datetime.now(timezone.utc),
            succeeded=True,
        ),
        (),
    )

    assert missing_snapshot.assertions == ()
    assert missing_snapshot.terminal is False
