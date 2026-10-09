"""Reference HTTP boundary for independently executed benchmark evidence.

The server authenticates runner requests, resolves an exact server-owned
contract, executes only its allowed connector action, and persists the signed
response before acknowledging it. SQLite serializes each run nonce so retries
reuse byte-identical evidence while connector idempotency covers crash recovery.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import re
import sqlite3
from collections.abc import Callable, Mapping, Sequence
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Protocol, TypeAlias, cast

from .evidence import (
    ARTIFACT_SCHEMA,
    EXTERNAL_REQUEST_SCHEMA,
    EXTERNAL_RESPONSE_SCHEMA,
    SIGNED_RECEIPT_SCHEMA,
    EvidenceVerificationError,
    action_sha256,
    canonical_json_bytes,
    sign_receipt,
)
from .types import (
    Action,
    TrustedActionPolicy,
    TrustedEvidenceBoundary,
    TrustedEvidenceRequirement,
)

JsonScalar: TypeAlias = str | int | float | bool | None
JsonValue: TypeAlias = (
    JsonScalar | list["JsonValue"] | dict[str, "JsonValue"]
)
JsonObject: TypeAlias = dict[str, JsonValue]

_LOGGER = logging.getLogger(__name__)
_IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$")
_ACTION_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_FIELD_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
_TOOL_CALL_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_SIGNATURE_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_MIN_HMAC_KEY_BYTES = 32
_MAX_REQUEST_BYTES = 1024 * 1024
_MAX_ARTIFACT_BYTES = 1024 * 1024
_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
_REQUEST_TOP_LEVEL_FIELDS = frozenset(
    {
        "schema",
        "run_id",
        "run_nonce",
        "run_started_at",
        "scenario_id",
        "seed",
        "tool_call_id",
        "request_ordinal",
        "action",
        "evidence_contract",
        "requested_at",
    }
)
_ACTION_FIELDS = frozenset({"name", "kwargs", "sha256"})
_CONTRACT_FIELDS = frozenset(
    {"contract_id", "contract_version", "contract_sha256"}
)


class TrustedExecutorHttpError(RuntimeError):
    """Structured failure translated by the outer HTTP boundary."""

    def __init__(self, status_code: int, public_message: str) -> None:
        super().__init__(public_message)
        self.status_code = status_code
        self.public_message = public_message


@dataclass(frozen=True)
class ValidatedExecutionRequest:
    """Authenticated request fields available to connector and contract code.

    Assertion IDs are deliberately absent. The evaluator is registered beside
    the contract and derives its observations from connector state.
    """

    envelope: JsonObject
    run_id: str
    run_nonce: str
    run_started_at: datetime
    scenario_id: str
    seed: int
    tool_call_id: str
    request_ordinal: int
    action: Action
    action_sha256: str
    contract_id: str
    contract_version: int
    contract_sha256: str
    requested_at: datetime


@dataclass(frozen=True)
class ConnectorExecution:
    """Provider result observed by the server-controlled contract evaluator."""

    payload: JsonObject
    observed_at: datetime
    succeeded: bool


@dataclass(frozen=True)
class AssertionArtifact:
    """One server-derived postcondition and its inspectable provider evidence."""

    assertion_id: str
    passed: bool
    subject: str
    revision: str
    evidence_kind: str
    evidence_reference: str


@dataclass(frozen=True)
class ContractEvaluation:
    """Postconditions derived from provider state after one connector action."""

    assertions: tuple[AssertionArtifact, ...]
    terminal: bool


@dataclass(frozen=True)
class ActionLineageEntry:
    """Immutable identity of one action in a nonce-scoped execution sequence."""

    request_ordinal: int
    tool_call_id: str
    action: str
    action_sha256: str

    def to_json(self) -> JsonObject:
        """Return the protocol representation signed into every artifact."""
        return {
            "request_ordinal": self.request_ordinal,
            "tool_call_id": self.tool_call_id,
            "action": self.action,
            "action_sha256": self.action_sha256,
        }


class TrustedConnector(Protocol):
    """Connector implementation whose provider writes honor idempotency keys."""

    def execute(
        self,
        action: Action,
        *,
        idempotency_key: str,
        request: ValidatedExecutionRequest,
        policy: TrustedActionPolicy,
    ) -> ConnectorExecution:
        """Execute an authorized action with its immutable contract context."""


class ServerOwnedContractEvaluator(Protocol):
    """Derives registered assertions without runner-supplied assertion data."""

    def evaluate(
        self,
        request: ValidatedExecutionRequest,
        execution: ConnectorExecution,
        action_lineage: tuple[ActionLineageEntry, ...],
    ) -> ContractEvaluation:
        """Evaluate provider postconditions for the registered contract."""


@dataclass(frozen=True)
class RegisteredEvidenceContract:
    """Exact requirement and evaluator installed on the executor."""

    requirement: TrustedEvidenceRequirement
    evaluator: ServerOwnedContractEvaluator


class EvidenceContractRegistry:
    """Immutable lookup table keyed by contract ID, version, and content hash."""

    def __init__(self, contracts: Sequence[RegisteredEvidenceContract]) -> None:
        entries: dict[tuple[str, int, str], RegisteredEvidenceContract] = {}
        for registered in contracts:
            _validate_requirement(registered.requirement)
            requirement = registered.requirement
            key = (
                requirement.contract_id,
                requirement.contract_version,
                requirement.contract_sha256,
            )
            if key in entries:
                raise ValueError(
                    "trusted executor contract registry contains a duplicate"
                )
            entries[key] = registered
        if not entries:
            raise ValueError(
                "trusted executor requires at least one evidence contract"
            )
        self._entries = entries

    def resolve(
        self,
        contract_id: str,
        contract_version: int,
        contract_sha256: str,
    ) -> RegisteredEvidenceContract:
        """Resolve only a byte-identical versioned contract."""
        registered = self._entries.get(
            (contract_id, contract_version, contract_sha256)
        )
        if registered is None:
            raise TrustedExecutorHttpError(
                403,
                "evidence contract is not registered at this executor",
            )
        return registered


class SqliteReplayStore:
    """Durable nonce ledger with atomic response publication and reuse."""

    def __init__(
        self,
        database_path: str | Path,
        *,
        busy_timeout: timedelta = timedelta(seconds=30),
    ) -> None:
        if busy_timeout <= timedelta(0):
            raise ValueError("SQLite busy timeout must be positive")
        self._database_path = str(database_path)
        if not self._database_path.strip() or self._database_path == ":memory:":
            raise ValueError(
                "trusted executor replay state requires a durable SQLite file"
            )
        self._busy_timeout_ms = int(busy_timeout.total_seconds() * 1000)
        Path(self._database_path).parent.mkdir(parents=True, exist_ok=True)
        with closing(self._connect()) as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS trusted_executor_runs (
                    run_nonce TEXT PRIMARY KEY NOT NULL,
                    run_id TEXT NOT NULL,
                    run_started_at TEXT NOT NULL,
                    scenario_id TEXT NOT NULL,
                    seed INTEGER NOT NULL,
                    contract_id TEXT NOT NULL,
                    contract_version INTEGER NOT NULL,
                    contract_sha256 TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS trusted_executor_executions (
                    run_nonce TEXT NOT NULL,
                    tool_call_id TEXT NOT NULL,
                    request_ordinal INTEGER NOT NULL,
                    request_sha256 TEXT NOT NULL,
                    action_name TEXT NOT NULL,
                    action_sha256 TEXT NOT NULL,
                    policy_index INTEGER NOT NULL,
                    response_bytes BLOB NOT NULL,
                    PRIMARY KEY (run_nonce, tool_call_id),
                    UNIQUE (run_nonce, request_ordinal),
                    FOREIGN KEY (run_nonce)
                        REFERENCES trusted_executor_runs(run_nonce)
                        ON DELETE RESTRICT
                );
                """
            )

    def execute_once(
        self,
        request: ValidatedExecutionRequest,
        request_sha256: str,
        build_response: Callable[
            [tuple[ActionLineageEntry, ...], Mapping[int, int]],
            tuple[bytes, int],
        ],
    ) -> bytes:
        """Reuse an exact request or atomically persist its first response.

        The immediate transaction deliberately spans provider dispatch. It
        serializes a nonce across threads/processes; if the process dies before
        commit, the same request hash yields the same provider idempotency key.
        """
        with closing(self._connect()) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            existing = connection.execute(
                """
                SELECT request_sha256, response_bytes
                FROM trusted_executor_executions
                WHERE run_nonce = ? AND tool_call_id = ?
                """,
                (request.run_nonce, request.tool_call_id),
            ).fetchone()
            if existing is not None:
                existing_sha = _database_text(existing[0], "request_sha256")
                if not hmac.compare_digest(existing_sha, request_sha256):
                    raise TrustedExecutorHttpError(
                        409,
                        "tool-call replay conflicts with its original request",
                    )
                return _database_bytes(existing[1], "response_bytes")

            run = connection.execute(
                """
                SELECT run_id, run_started_at, scenario_id, seed, contract_id,
                       contract_version, contract_sha256
                FROM trusted_executor_runs
                WHERE run_nonce = ?
                """,
                (request.run_nonce,),
            ).fetchone()
            expected_run = (
                request.run_id,
                _format_utc(request.run_started_at),
                request.scenario_id,
                request.seed,
                request.contract_id,
                request.contract_version,
                request.contract_sha256,
            )
            if run is None:
                if request.request_ordinal != 1:
                    raise TrustedExecutorHttpError(
                        409,
                        "a new run nonce must begin at request ordinal 1",
                    )
                connection.execute(
                    """
                    INSERT INTO trusted_executor_runs (
                        run_nonce, run_id, run_started_at, scenario_id, seed,
                        contract_id,
                        contract_version, contract_sha256
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (request.run_nonce, *expected_run),
                )
            elif tuple(run) != expected_run:
                raise TrustedExecutorHttpError(
                    409,
                    "run nonce conflicts with its original execution identity",
                )

            ordinal_collision = connection.execute(
                """
                SELECT tool_call_id
                FROM trusted_executor_executions
                WHERE run_nonce = ? AND request_ordinal = ?
                """,
                (request.run_nonce, request.request_ordinal),
            ).fetchone()
            if ordinal_collision is not None:
                raise TrustedExecutorHttpError(
                    409,
                    "request ordinal conflicts with an existing tool call",
                )

            rows = connection.execute(
                """
                SELECT request_ordinal, tool_call_id, action_name,
                       action_sha256, policy_index
                FROM trusted_executor_executions
                WHERE run_nonce = ?
                ORDER BY request_ordinal ASC
                """,
                (request.run_nonce,),
            ).fetchall()
            expected_ordinal = len(rows) + 1
            if request.request_ordinal != expected_ordinal:
                raise TrustedExecutorHttpError(
                    409,
                    "request ordinal is not the next contiguous run action",
                )

            prior_lineage: list[ActionLineageEntry] = []
            policy_counts: dict[int, int] = {}
            for index, row in enumerate(rows, start=1):
                ordinal = _database_int(row[0], "request_ordinal")
                if ordinal != index:
                    raise RuntimeError(
                        "trusted executor replay ledger has non-contiguous lineage"
                    )
                prior_lineage.append(
                    ActionLineageEntry(
                        request_ordinal=ordinal,
                        tool_call_id=_database_text(row[1], "tool_call_id"),
                        action=_database_text(row[2], "action_name"),
                        action_sha256=_database_text(row[3], "action_sha256"),
                    )
                )
                policy_index = _database_int(row[4], "policy_index")
                policy_counts[policy_index] = (
                    policy_counts.get(policy_index, 0) + 1
                )

            complete_lineage = (
                *prior_lineage,
                ActionLineageEntry(
                    request_ordinal=request.request_ordinal,
                    tool_call_id=request.tool_call_id,
                    action=request.action.name,
                    action_sha256=request.action_sha256,
                ),
            )
            response_bytes, policy_index = build_response(
                complete_lineage,
                policy_counts,
            )
            if len(response_bytes) > _MAX_RESPONSE_BYTES:
                raise TrustedExecutorHttpError(
                    502,
                    "connector result exceeds the executor response limit",
                )
            connection.execute(
                """
                INSERT INTO trusted_executor_executions (
                    run_nonce, tool_call_id, request_ordinal, request_sha256,
                    action_name, action_sha256, policy_index, response_bytes
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    request.run_nonce,
                    request.tool_call_id,
                    request.request_ordinal,
                    request_sha256,
                    request.action.name,
                    request.action_sha256,
                    policy_index,
                    response_bytes,
                ),
            )
            return response_bytes

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(
            self._database_path,
            timeout=self._busy_timeout_ms / 1000,
            isolation_level=None,
        )
        connection.execute(f"PRAGMA busy_timeout = {self._busy_timeout_ms}")
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA synchronous = FULL")
        return connection


class TrustedExecutorApplication:
    """Authenticated execution service consumed by the benchmark HTTP client."""

    def __init__(
        self,
        *,
        request_hmac_key: bytes,
        request_key_id: str,
        receipt_hmac_key: bytes,
        receipt_key_id: str,
        provider: str,
        boundary: TrustedEvidenceBoundary,
        executor_version: str,
        contracts: EvidenceContractRegistry,
        connector: TrustedConnector,
        replay_store: SqliteReplayStore,
        request_ttl: timedelta = timedelta(minutes=2),
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        _validate_hmac_key(request_hmac_key)
        _validate_hmac_key(receipt_hmac_key)
        if hmac.compare_digest(request_hmac_key, receipt_hmac_key):
            raise ValueError(
                "request authentication and receipt signing require separate keys"
            )
        if request_key_id == receipt_key_id:
            raise ValueError(
                "request authentication and receipt signing require separate key IDs"
            )
        for value, field in (
            (request_key_id, "request_key_id"),
            (receipt_key_id, "receipt_key_id"),
            (provider, "provider"),
            (boundary, "boundary"),
            (executor_version, "executor_version"),
        ):
            _validate_identifier(value, field)
        if request_ttl <= timedelta(0):
            raise ValueError("trusted executor request TTL must be positive")
        self._request_hmac_key = bytes(request_hmac_key)
        self._request_key_id = request_key_id
        self._receipt_hmac_key = bytes(receipt_hmac_key)
        self._receipt_key_id = receipt_key_id
        self._provider = provider
        self._boundary = boundary
        self._executor_version = executor_version
        self._contracts = contracts
        self._connector = connector
        self._replay_store = replay_store
        self._request_ttl = request_ttl
        self._clock = clock or (lambda: datetime.now(timezone.utc))

    def handle(self, body: bytes, headers: Mapping[str, str]) -> bytes:
        """Authenticate, authorize, execute, attest, and persist one request."""
        if len(body) > _MAX_REQUEST_BYTES:
            raise TrustedExecutorHttpError(
                413,
                "trusted executor request exceeds the protocol limit",
            )
        request_timestamp = self._authenticate_request(body, headers)
        request = _parse_execution_request(body)
        registered = self._contracts.resolve(
            request.contract_id,
            request.contract_version,
            request.contract_sha256,
        )
        request_sha256 = hashlib.sha256(body).hexdigest()

        def build_response(
            lineage: tuple[ActionLineageEntry, ...],
            prior_policy_counts: Mapping[int, int],
        ) -> tuple[bytes, int]:
            now = _aware_utc(self._clock(), "executor clock")
            if abs(request.requested_at - request_timestamp) > self._request_ttl:
                raise TrustedExecutorHttpError(
                    401,
                    "signed request body is outside the authentication window",
                )
            if request.requested_at > now + self._request_ttl:
                raise TrustedExecutorHttpError(
                    401,
                    "signed request body is dated in the future",
                )
            policy_index = _authorize_action(
                request.action,
                registered.requirement.allowed_actions,
                prior_policy_counts,
            )
            idempotency_key = f"lifeops-{request_sha256}"
            try:
                execution = self._connector.execute(
                    Action(
                        name=request.action.name,
                        kwargs=dict(request.action.kwargs),
                    ),
                    idempotency_key=idempotency_key,
                    request=request,
                    policy=registered.requirement.allowed_actions[
                        policy_index
                    ],
                )
            # error-policy:J1 Translate the provider boundary while preserving
            # an unknown outcome for a retry under the same idempotency key.
            except Exception as exc:
                _LOGGER.exception(
                    "[TrustedExecutorApplication] Connector execution failed",
                    extra={
                        "run_id": request.run_id,
                        "tool_call_id": request.tool_call_id,
                    },
                )
                raise TrustedExecutorHttpError(
                    502,
                    "connector execution failed with an unknown provider outcome",
                ) from exc
            if not isinstance(execution.succeeded, bool):
                raise TrustedExecutorHttpError(
                    502,
                    "connector result success state must be boolean",
                )
            _canonical_server_json(
                execution.payload,
                failure_status=502,
                failure_message="connector returned an invalid JSON payload",
            )
            try:
                evaluation = registered.evaluator.evaluate(
                    request,
                    execution,
                    lineage,
                )
            # error-policy:J1 Contract evaluation is a server-owned boundary;
            # failures cannot be translated into successful evidence.
            except Exception as exc:
                _LOGGER.exception(
                    "[TrustedExecutorApplication] Contract evaluation failed",
                    extra={
                        "contract_id": request.contract_id,
                        "tool_call_id": request.tool_call_id,
                    },
                )
                raise TrustedExecutorHttpError(
                    500,
                    "server-owned evidence contract evaluation failed",
                ) from exc
            response = self._build_signed_response(
                request=request,
                request_sha256=request_sha256,
                execution=execution,
                evaluation=evaluation,
                lineage=lineage,
            )
            return response, policy_index

        return self._replay_store.execute_once(
            request,
            request_sha256,
            build_response,
        )

    def _authenticate_request(
        self,
        body: bytes,
        headers: Mapping[str, str],
    ) -> datetime:
        normalized = {key.lower(): value.strip() for key, value in headers.items()}
        if normalized.get("x-lifeops-key-id") != self._request_key_id:
            raise TrustedExecutorHttpError(
                401,
                "trusted executor request key is not recognized",
            )
        timestamp_text = normalized.get("x-lifeops-timestamp")
        signature = normalized.get("x-lifeops-signature")
        if timestamp_text is None or signature is None:
            raise TrustedExecutorHttpError(
                401,
                "trusted executor authentication headers are incomplete",
            )
        if not _SIGNATURE_PATTERN.fullmatch(signature):
            raise TrustedExecutorHttpError(
                401,
                "trusted executor request signature is invalid",
            )
        timestamp = _parse_datetime(
            timestamp_text,
            "authentication timestamp",
            failure_status=401,
        )
        now = _aware_utc(self._clock(), "executor clock")
        if abs(now - timestamp) > self._request_ttl:
            raise TrustedExecutorHttpError(
                401,
                "trusted executor request timestamp is stale",
            )
        expected = hmac.new(
            self._request_hmac_key,
            timestamp_text.encode("utf-8") + b"\n" + body,
            hashlib.sha256,
        ).hexdigest()
        if not hmac.compare_digest(signature, expected):
            raise TrustedExecutorHttpError(
                401,
                "trusted executor request signature mismatch",
            )
        return timestamp

    def _build_signed_response(
        self,
        *,
        request: ValidatedExecutionRequest,
        request_sha256: str,
        execution: ConnectorExecution,
        evaluation: ContractEvaluation,
        lineage: tuple[ActionLineageEntry, ...],
    ) -> bytes:
        observed_at = _aware_utc(execution.observed_at, "connector observed_at")
        issued_at = _aware_utc(self._clock(), "executor clock")
        if observed_at < request.requested_at:
            raise TrustedExecutorHttpError(
                502,
                "connector observation predates its authenticated request",
            )
        if observed_at > issued_at:
            raise TrustedExecutorHttpError(
                502,
                "connector observation is dated in the future",
            )
        payload_bytes = _canonical_server_json(
            execution.payload,
            failure_status=502,
            failure_message="connector returned an invalid JSON payload",
        )
        assertions = _validate_evaluation(
            evaluation,
            self._contracts.resolve(
                request.contract_id,
                request.contract_version,
                request.contract_sha256,
            ).requirement,
            execution_succeeded=execution.succeeded,
        )
        artifact: JsonObject = {
            "schema": ARTIFACT_SCHEMA,
            "run_id": request.run_id,
            "run_nonce": request.run_nonce,
            "scenario_id": request.scenario_id,
            "seed": request.seed,
            "tool_call_id": request.tool_call_id,
            "request_ordinal": request.request_ordinal,
            "action": request.action.name,
            "action_sha256": request.action_sha256,
            "contract_id": request.contract_id,
            "contract_version": request.contract_version,
            "contract_sha256": request.contract_sha256,
            "provider": self._provider,
            "boundary": self._boundary,
            "executor_version": self._executor_version,
            "observed_at": _format_utc(observed_at),
            "terminal": evaluation.terminal,
            "action_lineage": [entry.to_json() for entry in lineage],
            "assertions": [assertion_to_json(item) for item in assertions],
        }
        artifact_bytes = _canonical_server_json(
            artifact,
            failure_status=500,
            failure_message="contract evaluator produced an invalid artifact",
        )
        if len(artifact_bytes) > _MAX_ARTIFACT_BYTES:
            raise TrustedExecutorHttpError(
                500,
                "contract artifact exceeds the protocol limit",
            )
        passed_assertions = [
            item.assertion_id for item in assertions if item.passed
        ]
        success = execution.succeeded
        artifact_sha256 = hashlib.sha256(artifact_bytes).hexdigest()
        receipt_id = (
            f"receipt/{request_sha256[:32]}/{artifact_sha256[:16]}"
        )
        receipt: JsonObject = {
            "schema": SIGNED_RECEIPT_SCHEMA,
            "receipt_id": receipt_id,
            "signing_key_id": self._receipt_key_id,
            "executor_version": self._executor_version,
            "provider": self._provider,
            "boundary": self._boundary,
            "run_id": request.run_id,
            "run_nonce": request.run_nonce,
            "scenario_id": request.scenario_id,
            "seed": request.seed,
            "tool_call_id": request.tool_call_id,
            "request_ordinal": request.request_ordinal,
            "action": request.action.name,
            "action_sha256": request.action_sha256,
            "contract_id": request.contract_id,
            "contract_version": request.contract_version,
            "contract_sha256": request.contract_sha256,
            "assertion_ids": passed_assertions,
            "success": success,
            "attestation_kind": (
                "terminal_postcondition" if evaluation.terminal else "operation"
            ),
            "observed_at": _format_utc(observed_at),
            "issued_at": _format_utc(issued_at),
            "artifact_sha256": artifact_sha256,
            "payload_sha256": hashlib.sha256(payload_bytes).hexdigest(),
            "request_sha256": request_sha256,
        }
        receipt["signature"] = sign_receipt(
            cast(dict[str, object], receipt),
            self._receipt_hmac_key,
        )
        response: JsonObject = {
            "schema": EXTERNAL_RESPONSE_SCHEMA,
            "payload": execution.payload,
            "artifact": artifact,
            "receipt": receipt,
        }
        return _canonical_server_json(
            response,
            failure_status=500,
            failure_message="executor response violates the JSON protocol",
        )


def assertion_to_json(assertion: AssertionArtifact) -> JsonObject:
    """Render one validated assertion without accepting caller JSON fragments."""
    return {
        "assertion_id": assertion.assertion_id,
        "passed": assertion.passed,
        "subject": assertion.subject,
        "revision": assertion.revision,
        "evidence": {
            "kind": assertion.evidence_kind,
            "reference": assertion.evidence_reference,
        },
    }


def make_trusted_executor_handler(
    application: TrustedExecutorApplication,
    *,
    path: str = "/execute",
) -> type[BaseHTTPRequestHandler]:
    """Create a bounded stdlib handler suitable for ``ThreadingHTTPServer``."""
    if not path.startswith("/") or "?" in path or "#" in path:
        raise ValueError("trusted executor path must be an absolute URL path")

    class TrustedExecutorRequestHandler(BaseHTTPRequestHandler):
        """Thin HTTP transport; all policy and state live in the application."""

        protocol_version = "HTTP/1.1"
        server_version = "LifeOpsTrustedExecutor/1"

        def do_POST(self) -> None:
            """Read one bounded request and translate its structured outcome."""
            try:
                self._handle_post()
            # error-policy:J1 This is the outer HTTP transport boundary.
            except TrustedExecutorHttpError as exc:
                self._send_error(exc.status_code, exc.public_message)
            # error-policy:J1 Unexpected server faults are logged and remain
            # visibly distinct from a successful evidence response.
            except Exception:
                _LOGGER.exception(
                    "[TrustedExecutorRequestHandler] Request failed",
                    extra={"path": self.path},
                )
                self._send_error(500, "trusted executor internal failure")

        def do_GET(self) -> None:
            """Reject non-execution methods without exposing server state."""
            self._send_error(405, "trusted executor accepts POST only")

        def _handle_post(self) -> None:
            if self.path != path:
                raise TrustedExecutorHttpError(
                    404,
                    "trusted executor endpoint was not found",
                )
            for header_name in (
                "Content-Length",
                "Content-Type",
                "Content-Encoding",
                "X-LifeOps-Key-Id",
                "X-LifeOps-Timestamp",
                "X-LifeOps-Signature",
            ):
                if len(self.headers.get_all(header_name, [])) > 1:
                    raise TrustedExecutorHttpError(
                        400,
                        "duplicate trusted executor headers are forbidden",
                    )
            transfer_encoding = self.headers.get("Transfer-Encoding")
            if transfer_encoding:
                raise TrustedExecutorHttpError(
                    400,
                    "chunked trusted executor requests are forbidden",
                )
            content_encoding = self.headers.get(
                "Content-Encoding", "identity"
            ).strip().lower()
            if content_encoding not in {"", "identity"}:
                raise TrustedExecutorHttpError(
                    415,
                    "compressed trusted executor requests are forbidden",
                )
            content_type = self.headers.get("Content-Type", "").split(
                ";", 1
            )[0].strip().lower()
            if content_type != "application/json":
                raise TrustedExecutorHttpError(
                    415,
                    "trusted executor request must be application/json",
                )
            length_text = self.headers.get("Content-Length")
            try:
                content_length = int(length_text) if length_text else -1
            except ValueError as exc:
                raise TrustedExecutorHttpError(
                    400,
                    "trusted executor Content-Length is invalid",
                ) from exc
            if content_length < 0:
                raise TrustedExecutorHttpError(
                    411,
                    "trusted executor requires Content-Length",
                )
            if content_length > _MAX_REQUEST_BYTES:
                raise TrustedExecutorHttpError(
                    413,
                    "trusted executor request exceeds the protocol limit",
                )
            body = self.rfile.read(content_length)
            if len(body) != content_length:
                raise TrustedExecutorHttpError(
                    400,
                    "trusted executor request body ended early",
                )
            response = application.handle(body, dict(self.headers.items()))
            self._send_json(200, response)

        def _send_error(self, status: int, message: str) -> None:
            error = _canonical_server_json(
                {"error": message},
                failure_status=500,
                failure_message="trusted executor could not encode an error",
            )
            self._send_json(status, error)

        def _send_json(self, status: int, body: bytes) -> None:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Encoding", "identity")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:
            """Route access logs through the package logger, never stderr."""
            _LOGGER.info(
                "[TrustedExecutorRequestHandler] " + format,
                *args,
                extra={"client": self.client_address[0]},
            )

    return TrustedExecutorRequestHandler


def _parse_execution_request(body: bytes) -> ValidatedExecutionRequest:
    raw = _decode_canonical_object(body)
    _require_exact_fields(raw, _REQUEST_TOP_LEVEL_FIELDS, "request")
    if raw.get("schema") != EXTERNAL_REQUEST_SCHEMA:
        raise TrustedExecutorHttpError(
            400,
            "trusted executor request schema is unsupported",
        )
    action_raw = _require_object(raw, "action")
    contract_raw = _require_object(raw, "evidence_contract")
    _require_exact_fields(action_raw, _ACTION_FIELDS, "action")
    _require_exact_fields(contract_raw, _CONTRACT_FIELDS, "evidence contract")

    run_id = _require_identifier(raw, "run_id")
    run_nonce = _require_identifier(raw, "run_nonce")
    scenario_id = _require_identifier(raw, "scenario_id")
    tool_call_id = _require_string(raw, "tool_call_id")
    if not _TOOL_CALL_ID_PATTERN.fullmatch(tool_call_id):
        raise TrustedExecutorHttpError(400, "tool_call_id has invalid syntax")
    seed = _require_integer(raw, "seed")
    request_ordinal = _require_positive_integer(raw, "request_ordinal")
    run_started_at = _parse_datetime(
        _require_string(raw, "run_started_at"),
        "run_started_at",
    )
    requested_at = _parse_datetime(
        _require_string(raw, "requested_at"),
        "requested_at",
    )
    if run_started_at > requested_at:
        raise TrustedExecutorHttpError(
            400,
            "run_started_at cannot follow requested_at",
        )

    action_name = _require_string(action_raw, "name")
    if not _ACTION_PATTERN.fullmatch(action_name):
        raise TrustedExecutorHttpError(400, "action name has invalid syntax")
    action_kwargs = _require_object(action_raw, "kwargs")
    action = Action(name=action_name, kwargs=cast(dict[str, object], action_kwargs))
    action_digest = _require_sha256(action_raw, "sha256")
    if not hmac.compare_digest(action_digest, action_sha256(action)):
        raise TrustedExecutorHttpError(400, "action digest does not match request")

    contract_id = _require_identifier(contract_raw, "contract_id")
    contract_version = _require_positive_integer(
        contract_raw,
        "contract_version",
    )
    contract_sha256 = _require_sha256(contract_raw, "contract_sha256")
    return ValidatedExecutionRequest(
        envelope=raw,
        run_id=run_id,
        run_nonce=run_nonce,
        run_started_at=run_started_at,
        scenario_id=scenario_id,
        seed=seed,
        tool_call_id=tool_call_id,
        request_ordinal=request_ordinal,
        action=action,
        action_sha256=action_digest,
        contract_id=contract_id,
        contract_version=contract_version,
        contract_sha256=contract_sha256,
        requested_at=requested_at,
    )


def _decode_canonical_object(body: bytes) -> JsonObject:
    def reject_duplicate_keys(
        pairs: list[tuple[str, JsonValue]],
    ) -> JsonObject:
        decoded: JsonObject = {}
        for key, value in pairs:
            if key in decoded:
                raise TrustedExecutorHttpError(
                    400,
                    "trusted executor request repeats a JSON object key",
                )
            decoded[key] = value
        return decoded

    try:
        decoded = json.loads(
            body,
            object_pairs_hook=reject_duplicate_keys,
            parse_constant=lambda _value: (_raise_non_finite_json()),
        )
    # error-policy:J3 The HTTP body is untrusted input; parse failures are an
    # explicit invalid request and never become a fabricated execution.
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise TrustedExecutorHttpError(
            400,
            "trusted executor request is not valid JSON",
        ) from exc
    if not isinstance(decoded, dict):
        raise TrustedExecutorHttpError(
            400,
            "trusted executor request must be a JSON object",
        )
    request = cast(JsonObject, decoded)
    try:
        canonical = canonical_json_bytes(request)
    # error-policy:J3 Canonical validation rejects unsupported JSON values at
    # the untrusted transport boundary.
    except EvidenceVerificationError as exc:
        raise TrustedExecutorHttpError(
            400,
            "trusted executor request violates canonical JSON limits",
        ) from exc
    if canonical != body:
        raise TrustedExecutorHttpError(
            400,
            "trusted executor request must use canonical JSON bytes",
        )
    return request


def _raise_non_finite_json() -> JsonValue:
    raise TrustedExecutorHttpError(
        400,
        "trusted executor request contains a non-finite number",
    )


def _authorize_action(
    action: Action,
    policies: tuple[TrustedActionPolicy, ...],
    prior_policy_counts: Mapping[int, int],
) -> int:
    for index, policy in enumerate(policies):
        if action.name != policy.name:
            continue
        if policy.discriminator_field is not None:
            discriminator = action.kwargs.get(policy.discriminator_field)
            if discriminator not in policy.allowed_discriminators:
                continue
        missing = [
            field
            for field in policy.required_kwargs
            if not isinstance(action.kwargs.get(field), str)
            or not cast(str, action.kwargs[field]).strip()
        ]
        if missing:
            raise TrustedExecutorHttpError(
                403,
                "action lacks contract-required authorization fields",
            )
        if prior_policy_counts.get(index, 0) >= policy.max_calls:
            raise TrustedExecutorHttpError(
                403,
                "action exceeds the contract call limit",
            )
        return index
    raise TrustedExecutorHttpError(
        403,
        "action is not allowed by the registered evidence contract",
    )


def _validate_evaluation(
    evaluation: ContractEvaluation,
    requirement: TrustedEvidenceRequirement,
    *,
    execution_succeeded: bool,
) -> tuple[AssertionArtifact, ...]:
    if not isinstance(evaluation.terminal, bool):
        raise TrustedExecutorHttpError(
            500,
            "contract evaluator terminal state must be boolean",
        )
    allowed = set(requirement.required_assertion_ids)
    seen: set[str] = set()
    for assertion in evaluation.assertions:
        _validate_identifier(assertion.assertion_id, "assertion_id")
        if assertion.assertion_id not in allowed:
            raise TrustedExecutorHttpError(
                500,
                "contract evaluator returned an unregistered assertion",
            )
        if assertion.assertion_id in seen:
            raise TrustedExecutorHttpError(
                500,
                "contract evaluator repeated an assertion",
            )
        seen.add(assertion.assertion_id)
        for value, field in (
            (assertion.subject, "assertion subject"),
            (assertion.revision, "assertion revision"),
            (assertion.evidence_kind, "assertion evidence kind"),
            (assertion.evidence_reference, "assertion evidence reference"),
        ):
            if not value.strip():
                raise TrustedExecutorHttpError(
                    500,
                    f"{field} cannot be empty",
                )
        if assertion.passed and not execution_succeeded:
            raise TrustedExecutorHttpError(
                500,
                "failed connector execution cannot attest a passed assertion",
            )
    return evaluation.assertions


def _validate_requirement(requirement: TrustedEvidenceRequirement) -> None:
    _validate_identifier(requirement.contract_id, "contract_id")
    if requirement.contract_version <= 0:
        raise ValueError("contract_version must be positive")
    if not _SHA256_PATTERN.fullmatch(requirement.contract_sha256):
        raise ValueError("contract_sha256 must be a lowercase SHA-256 digest")
    if (
        not requirement.required_assertion_ids
        or len(set(requirement.required_assertion_ids))
        != len(requirement.required_assertion_ids)
    ):
        raise ValueError(
            "evidence contract assertions must be non-empty and unique"
        )
    for assertion_id in requirement.required_assertion_ids:
        _validate_identifier(assertion_id, "required assertion_id")
    if not requirement.allowed_actions:
        raise ValueError("evidence contract requires an action policy")
    for policy in requirement.allowed_actions:
        if not _ACTION_PATTERN.fullmatch(policy.name):
            raise ValueError("evidence contract action name is invalid")
        if policy.risk not in {"read", "proposal", "approved_write"}:
            raise ValueError("evidence contract action risk is invalid")
        if policy.max_calls <= 0:
            raise ValueError("evidence contract max_calls must be positive")
        if policy.discriminator_field is None:
            if policy.allowed_discriminators:
                raise ValueError(
                    "action policy without discriminator cannot allow values"
                )
        elif not policy.allowed_discriminators:
            raise ValueError(
                "action policy discriminator requires allowed values"
            )
        elif not _FIELD_PATTERN.fullmatch(policy.discriminator_field):
            raise ValueError("action policy discriminator field is invalid")
        if (
            len(set(policy.allowed_discriminators))
            != len(policy.allowed_discriminators)
            or any(
                not isinstance(item, str) or not item.strip()
                for item in policy.allowed_discriminators
            )
        ):
            raise ValueError(
                "action policy discriminator values must be non-empty and unique"
            )
        if len(set(policy.required_kwargs)) != len(policy.required_kwargs):
            raise ValueError("action policy required kwargs must be unique")
        if any(
            not isinstance(field, str)
            or not _FIELD_PATTERN.fullmatch(field)
            for field in policy.required_kwargs
        ):
            raise ValueError("action policy required kwargs are invalid")
        if policy.risk == "approved_write" and not policy.required_kwargs:
            raise ValueError(
                "approved-write action policy requires an approval binding"
            )


def _canonical_server_json(
    value: object,
    *,
    failure_status: int,
    failure_message: str,
) -> bytes:
    try:
        return canonical_json_bytes(value)
    # error-policy:J1 Values from connector/contract boundaries must surface as
    # an explicit protocol failure rather than a healthy-looking response.
    except EvidenceVerificationError as exc:
        raise TrustedExecutorHttpError(
            failure_status,
            failure_message,
        ) from exc


def _require_exact_fields(
    value: Mapping[str, JsonValue],
    expected: frozenset[str],
    label: str,
) -> None:
    if frozenset(value) != expected:
        raise TrustedExecutorHttpError(
            400,
            f"trusted executor {label} fields do not match the protocol",
        )


def _require_object(value: Mapping[str, JsonValue], field: str) -> JsonObject:
    item = value.get(field)
    if not isinstance(item, dict):
        raise TrustedExecutorHttpError(
            400,
            f"trusted executor request {field} must be an object",
        )
    return item


def _require_string(value: Mapping[str, JsonValue], field: str) -> str:
    item = value.get(field)
    if not isinstance(item, str) or not item.strip():
        raise TrustedExecutorHttpError(
            400,
            f"trusted executor request {field} must be a non-empty string",
        )
    return item.strip()


def _require_identifier(value: Mapping[str, JsonValue], field: str) -> str:
    item = _require_string(value, field)
    if not _IDENTIFIER_PATTERN.fullmatch(item):
        raise TrustedExecutorHttpError(
            400,
            f"trusted executor request {field} has invalid syntax",
        )
    return item


def _require_integer(value: Mapping[str, JsonValue], field: str) -> int:
    item = value.get(field)
    if not isinstance(item, int) or isinstance(item, bool):
        raise TrustedExecutorHttpError(
            400,
            f"trusted executor request {field} must be an integer",
        )
    return item


def _require_positive_integer(
    value: Mapping[str, JsonValue],
    field: str,
) -> int:
    item = _require_integer(value, field)
    if item <= 0:
        raise TrustedExecutorHttpError(
            400,
            f"trusted executor request {field} must be positive",
        )
    return item


def _require_sha256(value: Mapping[str, JsonValue], field: str) -> str:
    item = _require_string(value, field)
    if not _SHA256_PATTERN.fullmatch(item):
        raise TrustedExecutorHttpError(
            400,
            f"trusted executor request {field} must be a SHA-256 digest",
        )
    return item


def _parse_datetime(
    value: str,
    field: str,
    *,
    failure_status: int = 400,
) -> datetime:
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(normalized)
    # error-policy:J3 Timestamp text is untrusted protocol input.
    except ValueError as exc:
        raise TrustedExecutorHttpError(
            failure_status,
            f"trusted executor {field} must be an ISO timestamp",
        ) from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise TrustedExecutorHttpError(
            failure_status,
            f"trusted executor {field} must include a timezone",
        )
    return parsed.astimezone(timezone.utc)


def _format_utc(value: datetime) -> str:
    return (
        _aware_utc(value, "timestamp")
        .isoformat(timespec="microseconds")
        .replace("+00:00", "Z")
    )


def _aware_utc(value: datetime, field: str) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise TrustedExecutorHttpError(
            500,
            f"{field} must be timezone-aware",
        )
    return value.astimezone(timezone.utc)


def _validate_hmac_key(key: bytes) -> None:
    if not isinstance(key, bytes) or len(key) < _MIN_HMAC_KEY_BYTES:
        raise ValueError(
            f"executor HMAC key must contain at least {_MIN_HMAC_KEY_BYTES} bytes"
        )


def _validate_identifier(value: str, field: str) -> None:
    if not _IDENTIFIER_PATTERN.fullmatch(value):
        raise ValueError(f"{field} has invalid syntax")


def _database_text(value: object, field: str) -> str:
    if not isinstance(value, str):
        raise RuntimeError(f"trusted executor replay {field} is corrupt")
    return value


def _database_int(value: object, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise RuntimeError(f"trusted executor replay {field} is corrupt")
    return value


def _database_bytes(value: object, field: str) -> bytes:
    if not isinstance(value, bytes):
        raise RuntimeError(f"trusted executor replay {field} is corrupt")
    return value
