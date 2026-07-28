"""Real-socket tests for the authenticated trusted-executor reference boundary."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

from eliza_lifeops_bench.evidence import (
    ARTIFACT_SCHEMA,
    EvidenceVerificationError,
    HmacSha256ReceiptVerifier,
    HttpTrustedToolExecutor,
    TrustedExecutionContext,
    action_sha256,
    canonical_json_bytes,
    execution_request_body,
)
from eliza_lifeops_bench.trusted_executor_server import (
    ActionLineageEntry,
    AssertionArtifact,
    ConnectorExecution,
    ContractEvaluation,
    EvidenceContractRegistry,
    RegisteredEvidenceContract,
    ServerOwnedContractEvaluator,
    SqliteReplayStore,
    TrustedExecutorApplication,
    ValidatedExecutionRequest,
    make_trusted_executor_handler,
)
from eliza_lifeops_bench.types import (
    Action,
    TrustedActionPolicy,
    TrustedEvidenceRequirement,
)

_REQUEST_KEY = b"server-request-authentication-key-v1!"
_RECEIPT_KEY = b"server-receipt-signing-key-v1-safe!"
_REQUEST_KEY_ID = "request-key-v1"
_RECEIPT_KEY_ID = "receipt-key-v1"
_PROVIDER = "calendar-loopback-sandbox"
_BOUNDARY = "sandbox_connector"
_EXECUTOR_VERSION = "reference-executor-v1"
_CONTRACT_SHA256 = hashlib.sha256(
    b"server-owned-source-contract-v1"
).hexdigest()
_ASSERTION_IDS = ("G1.world.1", "G1.world.2")


def _iso(value: datetime) -> str:
    return (
        value.astimezone(timezone.utc)
        .isoformat(timespec="microseconds")
        .replace("+00:00", "Z")
    )


def _requirement() -> TrustedEvidenceRequirement:
    return TrustedEvidenceRequirement(
        contract_id="G1",
        contract_version=1,
        contract_sha256=_CONTRACT_SHA256,
        required_assertion_ids=_ASSERTION_IDS,
        allowed_actions=(
            TrustedActionPolicy(
                name="CALENDAR_SOURCES",
                discriminator_field="operation",
                allowed_discriminators=("list",),
                risk="read",
                max_calls=3,
            ),
        ),
    )


def _context(
    *,
    tool_call_id: str = "call-1",
    request_ordinal: int = 1,
    action: Action | None = None,
    run_nonce: str = "nonce-1",
    run_id: str = "run-1",
    contract_sha256: str = _CONTRACT_SHA256,
    now: datetime | None = None,
) -> TrustedExecutionContext:
    requested_at = now or datetime.now(timezone.utc)
    return TrustedExecutionContext(
        run_id=run_id,
        run_nonce=run_nonce,
        run_started_at=requested_at,
        scenario_id="m1.g01.reference",
        seed=2026,
        tool_call_id=tool_call_id,
        request_ordinal=request_ordinal,
        action=action
        or Action(
            name="CALENDAR_SOURCES",
            kwargs={"operation": "list"},
        ),
        contract_id="G1",
        contract_version=1,
        contract_sha256=contract_sha256,
        requested_at=requested_at,
    )


class RecordingCalendarConnector:
    """Deterministic provider seam that records real server dispatches."""

    def __init__(
        self,
        *,
        oversized: bool = False,
        delay_seconds: float = 0,
    ) -> None:
        self.calls: list[tuple[Action, str]] = []
        self.oversized = oversized
        self.delay_seconds = delay_seconds

    def execute(
        self,
        action: Action,
        *,
        idempotency_key: str,
        request: ValidatedExecutionRequest,
        policy: TrustedActionPolicy,
    ) -> ConnectorExecution:
        del request, policy
        self.calls.append((action, idempotency_key))
        if self.delay_seconds:
            time.sleep(self.delay_seconds)
        if self.oversized:
            payload = {"ok": True, "value": "x" * (300 * 1024)}
        else:
            payload = {
                "ok": True,
                "revision": "provider-revision-42",
                "sources": [
                    {
                        "account": "work",
                        "selected": True,
                        "confidential": True,
                        "householdDetailSharing": False,
                    },
                    {
                        "account": "personal",
                        "selected": True,
                        "confidential": False,
                        "householdDetailSharing": True,
                    },
                    {
                        "account": "family",
                        "selected": True,
                        "confidential": False,
                        "householdDetailSharing": True,
                    },
                    {
                        "account": "school",
                        "selected": True,
                        "confidential": False,
                        "householdDetailSharing": True,
                    },
                    {
                        "account": "messages",
                        "selected": True,
                        "confidential": False,
                        "householdDetailSharing": False,
                    },
                ],
            }
        return ConnectorExecution(
            payload=payload,
            observed_at=datetime.now(timezone.utc),
            succeeded=True,
        )


class SourceContractEvaluator:
    """Server-owned G1 logic that derives IDs solely from provider state."""

    def __init__(self) -> None:
        self.requests: list[ValidatedExecutionRequest] = []

    def evaluate(
        self,
        request: ValidatedExecutionRequest,
        execution: ConnectorExecution,
        _action_lineage: tuple[ActionLineageEntry, ...],
    ) -> ContractEvaluation:
        self.requests.append(request)
        sources = execution.payload.get("sources")
        complete = isinstance(sources, list) and len(sources) == 5 and all(
            isinstance(item, dict) and item.get("selected") is True
            for item in sources
        )
        isolated = isinstance(sources, list) and any(
            isinstance(item, dict)
            and item.get("account") == "work"
            and item.get("confidential") is True
            and item.get("householdDetailSharing") is False
            for item in sources
        )
        revision = execution.payload.get("revision")
        assert isinstance(revision, str)
        assertions: list[AssertionArtifact] = []
        if complete:
            assertions.append(
                AssertionArtifact(
                    assertion_id="G1.world.1",
                    passed=True,
                    subject="household-source-set",
                    revision=revision,
                    evidence_kind="provider_state_snapshot",
                    evidence_reference="sandbox://calendar/sources",
                )
            )
        if isolated:
            assertions.append(
                AssertionArtifact(
                    assertion_id="G1.world.2",
                    passed=True,
                    subject="confidential-work-source",
                    revision=revision,
                    evidence_kind="provider_state_snapshot",
                    evidence_reference="sandbox://calendar/sources/work",
                )
            )
        return ContractEvaluation(
            assertions=tuple(assertions),
            terminal=True,
        )


class IntermediateOperationEvaluator:
    """Represents a successful step before terminal contract postconditions."""

    def evaluate(
        self,
        _request: ValidatedExecutionRequest,
        _execution: ConnectorExecution,
        _action_lineage: tuple[ActionLineageEntry, ...],
    ) -> ContractEvaluation:
        return ContractEvaluation(assertions=(), terminal=False)


def _application(
    database_path: Path,
    connector: RecordingCalendarConnector,
    evaluator: ServerOwnedContractEvaluator,
) -> TrustedExecutorApplication:
    registry = EvidenceContractRegistry(
        (
            RegisteredEvidenceContract(
                requirement=_requirement(),
                evaluator=evaluator,
            ),
        )
    )
    return TrustedExecutorApplication(
        request_hmac_key=_REQUEST_KEY,
        request_key_id=_REQUEST_KEY_ID,
        receipt_hmac_key=_RECEIPT_KEY,
        receipt_key_id=_RECEIPT_KEY_ID,
        provider=_PROVIDER,
        boundary=_BOUNDARY,
        executor_version=_EXECUTOR_VERSION,
        contracts=registry,
        connector=connector,
        replay_store=SqliteReplayStore(database_path),
    )


def _verifier() -> HmacSha256ReceiptVerifier:
    return HmacSha256ReceiptVerifier(
        _RECEIPT_KEY,
        signing_key_id=_RECEIPT_KEY_ID,
        allowed_providers={_PROVIDER},
        allowed_boundaries={_BOUNDARY},
        allowed_contract_ids={"G1"},
    )


@contextmanager
def _running_server(
    application: TrustedExecutorApplication,
) -> Iterator[str]:
    server = ThreadingHTTPServer(
        ("127.0.0.1", 0),
        make_trusted_executor_handler(application),
    )
    server.daemon_threads = True
    thread = threading.Thread(
        target=server.serve_forever,
        name="trusted-executor-test-server",
        daemon=True,
    )
    thread.start()
    try:
        host, port = server.server_address
        yield f"http://{host}:{port}/execute"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def _client(url: str) -> HttpTrustedToolExecutor:
    return HttpTrustedToolExecutor(
        url,
        _REQUEST_KEY,
        request_key_id=_REQUEST_KEY_ID,
        timeout_s=5,
    )


def _authenticated_headers(
    body: bytes,
    timestamp: datetime,
    *,
    signature: str | None = None,
) -> dict[str, str]:
    timestamp_text = _iso(timestamp)
    request_signature = signature or hmac.new(
        _REQUEST_KEY,
        timestamp_text.encode("utf-8") + b"\n" + body,
        hashlib.sha256,
    ).hexdigest()
    return {
        "Content-Type": "application/json",
        "Accept-Encoding": "identity",
        "X-LifeOps-Key-Id": _REQUEST_KEY_ID,
        "X-LifeOps-Timestamp": timestamp_text,
        "X-LifeOps-Signature": request_signature,
    }


def _raw_post(
    url: str,
    body: bytes,
    headers: dict[str, str],
) -> tuple[int, bytes]:
    request = Request(
        url,
        data=body,
        headers=headers,
        method="POST",
    )
    try:
        with urlopen(request, timeout=5) as response:
            return response.status, response.read()
    except HTTPError as exc:
        return exc.code, exc.read()


@pytest.mark.asyncio
async def test_allowed_read_returns_verifiable_terminal_artifact_over_socket(
    tmp_path: Path,
) -> None:
    connector = RecordingCalendarConnector()
    evaluator = SourceContractEvaluator()
    context = _context()
    with _running_server(
        _application(tmp_path / "replay.sqlite", connector, evaluator)
    ) as url:
        execution = await _client(url).execute(context)

    verified = _verifier().verify(context, execution, _requirement())
    assert verified.success is True
    assert verified.assertion_ids == _ASSERTION_IDS
    assert verified.attestation_kind == "terminal_postcondition"
    assert execution.artifact_manifest["schema"] == ARTIFACT_SCHEMA
    assert execution.artifact_manifest["terminal"] is True
    assert execution.artifact_manifest["action_lineage"] == [
        {
            "request_ordinal": 1,
            "tool_call_id": "call-1",
            "action": "CALENDAR_SOURCES",
            "action_sha256": action_sha256(context.action),
        }
    ]
    assert len(connector.calls) == 1
    assert connector.calls[0][1].startswith("lifeops-")
    assert len(connector.calls[0][1]) == len("lifeops-") + 64
    assert len(evaluator.requests) == 1
    assert "required_assertion_ids" not in json.dumps(
        evaluator.requests[0].envelope
    )


@pytest.mark.asyncio
async def test_successful_intermediate_operation_does_not_fabricate_claims(
    tmp_path: Path,
) -> None:
    connector = RecordingCalendarConnector()
    context = _context()
    with _running_server(
        _application(
            tmp_path / "replay.sqlite",
            connector,
            IntermediateOperationEvaluator(),
        )
    ) as url:
        execution = await _client(url).execute(context)

    verified = _verifier().verify(context, execution, _requirement())
    assert verified.success is True
    assert verified.assertion_ids == ()
    assert verified.attestation_kind == "operation"
    assert len(connector.calls) == 1


@pytest.mark.asyncio
async def test_unauthorized_action_is_rejected_before_connector_dispatch(
    tmp_path: Path,
) -> None:
    connector = RecordingCalendarConnector()
    evaluator = SourceContractEvaluator()
    context = _context(
        action=Action(
            name="CALENDAR_SOURCES",
            kwargs={"operation": "connect", "provider": "google"},
        )
    )
    with _running_server(
        _application(tmp_path / "replay.sqlite", connector, evaluator)
    ) as url:
        with pytest.raises(EvidenceVerificationError, match="HTTP 403"):
            await _client(url).execute(context)

    assert connector.calls == []
    assert evaluator.requests == []


@pytest.mark.asyncio
async def test_same_request_reuses_exact_response_without_second_connector_call(
    tmp_path: Path,
) -> None:
    connector = RecordingCalendarConnector()
    evaluator = SourceContractEvaluator()
    context = _context()
    with _running_server(
        _application(tmp_path / "replay.sqlite", connector, evaluator)
    ) as url:
        client = _client(url)
        first = await client.execute(context)
        second = await client.execute(context)

    assert second == first
    assert len(connector.calls) == 1
    assert len(evaluator.requests) == 1


@pytest.mark.asyncio
async def test_concurrent_same_request_serializes_to_one_connector_call(
    tmp_path: Path,
) -> None:
    connector = RecordingCalendarConnector(delay_seconds=0.1)
    evaluator = SourceContractEvaluator()
    context = _context()
    with _running_server(
        _application(tmp_path / "replay.sqlite", connector, evaluator)
    ) as url:
        first, second = await asyncio.gather(
            _client(url).execute(context),
            _client(url).execute(context),
        )

    assert second == first
    assert len(connector.calls) == 1
    assert len(evaluator.requests) == 1


@pytest.mark.asyncio
async def test_conflicting_tool_call_replay_is_rejected(
    tmp_path: Path,
) -> None:
    connector = RecordingCalendarConnector()
    evaluator = SourceContractEvaluator()
    first = _context()
    conflicting = replace(
        first,
        action=Action(
            name="CALENDAR_SOURCES",
            kwargs={"operation": "list", "view": "compact"},
        ),
    )
    with _running_server(
        _application(tmp_path / "replay.sqlite", connector, evaluator)
    ) as url:
        client = _client(url)
        await client.execute(first)
        with pytest.raises(EvidenceVerificationError, match="HTTP 409"):
            await client.execute(conflicting)

    assert len(connector.calls) == 1


@pytest.mark.asyncio
async def test_complete_lineage_is_carried_into_later_terminal_artifact(
    tmp_path: Path,
) -> None:
    connector = RecordingCalendarConnector()
    evaluator = SourceContractEvaluator()
    now = datetime.now(timezone.utc)
    first = _context(now=now)
    second = _context(
        now=now,
        tool_call_id="call-2",
        request_ordinal=2,
    )
    with _running_server(
        _application(tmp_path / "replay.sqlite", connector, evaluator)
    ) as url:
        client = _client(url)
        await client.execute(first)
        execution = await client.execute(second)

    lineage = execution.artifact_manifest["action_lineage"]
    assert isinstance(lineage, list)
    assert [entry["request_ordinal"] for entry in lineage] == [1, 2]
    assert [entry["tool_call_id"] for entry in lineage] == ["call-1", "call-2"]
    verified = _verifier().verify(second, execution, _requirement())
    assert verified.attestation_kind == "terminal_postcondition"


@pytest.mark.asyncio
async def test_contract_hash_drift_is_rejected_before_dispatch(
    tmp_path: Path,
) -> None:
    connector = RecordingCalendarConnector()
    evaluator = SourceContractEvaluator()
    context = _context(contract_sha256="a" * 64)
    with _running_server(
        _application(tmp_path / "replay.sqlite", connector, evaluator)
    ) as url:
        with pytest.raises(EvidenceVerificationError, match="HTTP 403"):
            await _client(url).execute(context)

    assert connector.calls == []


def test_stale_or_bad_request_authentication_is_rejected(
    tmp_path: Path,
) -> None:
    connector = RecordingCalendarConnector()
    evaluator = SourceContractEvaluator()
    body = canonical_json_bytes(execution_request_body(_context()))
    with _running_server(
        _application(tmp_path / "replay.sqlite", connector, evaluator)
    ) as url:
        bad_status, _ = _raw_post(
            url,
            body,
            _authenticated_headers(
                body,
                datetime.now(timezone.utc),
                signature="0" * 64,
            ),
        )
        stale_time = datetime.now(timezone.utc) - timedelta(minutes=10)
        stale_status, _ = _raw_post(
            url,
            body,
            _authenticated_headers(body, stale_time),
        )

    assert bad_status == 401
    assert stale_status == 401
    assert connector.calls == []


def test_request_cannot_smuggle_runner_assertion_ids(
    tmp_path: Path,
) -> None:
    connector = RecordingCalendarConnector()
    evaluator = SourceContractEvaluator()
    raw = execution_request_body(_context())
    raw["required_assertion_ids"] = ["G1.world.1", "G1.world.2"]
    body = canonical_json_bytes(raw)
    with _running_server(
        _application(tmp_path / "replay.sqlite", connector, evaluator)
    ) as url:
        status, _ = _raw_post(
            url,
            body,
            _authenticated_headers(body, datetime.now(timezone.utc)),
        )

    assert status == 400
    assert connector.calls == []
    assert evaluator.requests == []


@pytest.mark.asyncio
async def test_sqlite_restart_reuses_persisted_response(
    tmp_path: Path,
) -> None:
    database_path = tmp_path / "replay.sqlite"
    connector = RecordingCalendarConnector()
    first_evaluator = SourceContractEvaluator()
    context = _context()
    with _running_server(
        _application(database_path, connector, first_evaluator)
    ) as first_url:
        first = await _client(first_url).execute(context)

    second_evaluator = SourceContractEvaluator()
    with _running_server(
        _application(database_path, connector, second_evaluator)
    ) as second_url:
        second = await _client(second_url).execute(context)

    assert second == first
    assert len(connector.calls) == 1
    assert len(first_evaluator.requests) == 1
    assert second_evaluator.requests == []
    _verifier().verify(context, second, _requirement())


@pytest.mark.asyncio
async def test_oversized_connector_output_fails_closed(
    tmp_path: Path,
) -> None:
    connector = RecordingCalendarConnector(oversized=True)
    evaluator = SourceContractEvaluator()
    with _running_server(
        _application(tmp_path / "replay.sqlite", connector, evaluator)
    ) as url:
        with pytest.raises(EvidenceVerificationError, match="HTTP 502"):
            await _client(url).execute(_context())

    assert len(connector.calls) == 1
    assert evaluator.requests == []
