"""Socket-level checks for the native runtime connector and exact G10 contract."""

from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from eliza_lifeops_bench.evidence import action_sha256
from eliza_lifeops_bench.runtime_connector import (
    CalendarPartialFailureEvaluator,
    ElizaRuntimeActionConnector,
    TRUSTED_RUNTIME_ACTION_SCHEMA,
    production_parent_contract_registry,
)
from eliza_lifeops_bench.scenarios import WORLD_TRAVELING_COPARENT_SCENARIOS
from eliza_lifeops_bench.trusted_executor_server import (
    ConnectorExecution,
    TrustedExecutorHttpError,
    ValidatedExecutionRequest,
)
from eliza_lifeops_bench.types import Action, TrustedActionPolicy

_TOKEN = "runtime-connector-test-token-0123456789abcdef"
_IDEMPOTENCY_KEY = (
    "lifeops-0123456789abcdef0123456789abcdef"
    "0123456789abcdef0123456789abcdef"
)


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
            "syncedAt": (
                "2026-07-27T19:00:00.000Z"
                if status in {"fresh", "stale"}
                else None
            ),
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


def _snapshot() -> dict[str, object]:
    return {
        "state": "partial",
        "sources": [
            _source(provider="google", account="personal", status="fresh"),
            _source(
                provider="apple_calendar",
                account="family",
                status="stale",
            ),
            _source(provider="ics", account="school", status="error"),
        ],
        "observedAt": "2026-07-27T19:00:00.000Z",
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
) -> Iterator[str]:
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            length = int(self.headers["Content-Length"])
            request = json.loads(self.rfile.read(length))
            observed_at = datetime.now(timezone.utc).isoformat().replace(
                "+00:00", "Z"
            )
            action_result = result or {
                "success": True,
                "data": {
                    "actionName": request["action"]["name"],
                    "operation": request["action"]["parameters"].get(
                        "operation"
                    ),
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
                    "release_evidence": not stand_in,
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
        host, port = server.server_address
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


def test_native_runtime_connector_preserves_structured_provider_state() -> None:
    with _runtime_server() as url:
        connector = ElizaRuntimeActionConnector(url, _TOKEN)
        execution = connector.execute(
            _request().action,
            idempotency_key=_IDEMPOTENCY_KEY,
            request=_request(),
            policy=_read_policy(),
        )

    assert execution.succeeded is True
    result = execution.payload["result"]
    assert isinstance(result, dict)
    data = result["data"]
    assert isinstance(data, dict)
    assert data["snapshot"] == _snapshot()


def test_native_runtime_connector_rejects_stand_in_provenance() -> None:
    with _runtime_server(stand_in=True) as url:
        connector = ElizaRuntimeActionConnector(url, _TOKEN)
        with pytest.raises(
            TrustedExecutorHttpError,
            match="native production path",
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
    policy = TrustedActionPolicy(
        name="CALENDAR_SOURCES",
        discriminator_field="operation",
        allowed_discriminators=("select",),
        risk="proposal",
        max_calls=1,
    )
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
                policy=policy,
            )


def test_g10_evaluator_derives_both_assertions_from_structured_snapshot() -> None:
    request = _request()
    execution = ConnectorExecution(
        payload={
            "result": {
                "success": True,
                "data": {
                    "actionName": "CALENDAR_SOURCES",
                    "snapshot": _snapshot(),
                },
            }
        },
        observed_at=datetime.now(timezone.utc),
        succeeded=True,
    )

    evaluation = CalendarPartialFailureEvaluator().evaluate(
        request,
        execution,
        (),
    )

    assert evaluation.terminal is True
    assert tuple(
        assertion.assertion_id for assertion in evaluation.assertions
    ) == ("G10.world.1", "G10.world.2")


def test_production_registry_fails_closed_for_unimplemented_contracts() -> None:
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
    with pytest.raises(
        TrustedExecutorHttpError,
        match="not registered",
    ):
        registry.resolve(
            g1.contract_id,
            g1.contract_version,
            g1.contract_sha256,
        )
