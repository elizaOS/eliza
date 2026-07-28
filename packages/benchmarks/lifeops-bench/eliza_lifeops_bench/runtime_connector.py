"""Production-backed connector and exact postcondition evaluators.

The connector calls the dedicated elizaOS runtime process, validates native
runtime provenance and canonical effect receipts, and exposes only structured
action results to the signing server. Registered contract evaluators inspect
provider-backed result data; they never infer assertions from prose.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import cast
from urllib.parse import urlsplit

import httpx

from .evidence import canonical_json_bytes
from .scenarios import WORLD_TRAVELING_COPARENT_SCENARIOS
from .trusted_executor_server import (
    ActionLineageEntry,
    AssertionArtifact,
    ConnectorExecution,
    ContractEvaluation,
    EvidenceContractRegistry,
    JsonObject,
    RegisteredEvidenceContract,
    TrustedExecutorHttpError,
    ValidatedExecutionRequest,
)
from .types import Action, TrustedActionPolicy, TrustedEvidenceRequirement

TRUSTED_RUNTIME_ACTION_SCHEMA = "eliza.trusted-runtime-action.v1"
_MAX_RUNTIME_RESPONSE_BYTES = 2 * 1024 * 1024
_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
_IDEMPOTENCY_PATTERN = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._:/-]{15,255}$"
)
_SOURCE_STATUSES = frozenset(
    {"fresh", "stale", "error", "disconnected"}
)
_SOURCE_STATES = frozenset({"complete", "partial", "unavailable"})


def _runtime_url(url: str) -> str:
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("trusted runtime URL must use HTTP or HTTPS")
    if not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("trusted runtime URL authority is invalid")
    if parsed.scheme == "http" and parsed.hostname not in _LOOPBACK_HOSTS:
        raise ValueError(
            "plain HTTP trusted runtime URLs are restricted to loopback"
        )
    if parsed.query or parsed.fragment:
        raise ValueError("trusted runtime URL cannot contain query or fragment")
    if parsed.path not in {
        "",
        "/",
        "/api/benchmark/trusted-runtime/action",
    }:
        raise ValueError("trusted runtime URL path is unsupported")
    return (
        f"{parsed.scheme}://{parsed.netloc}"
        "/api/benchmark/trusted-runtime/action"
    )


def _as_object(value: object, field: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise TrustedExecutorHttpError(
            502,
            f"trusted runtime {field} must be an object",
        )
    return cast(dict[str, object], value)


def _parse_utc_timestamp(value: object, field: str) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise TrustedExecutorHttpError(
            502,
            f"trusted runtime {field} must be an ISO timestamp",
        )
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(normalized)
    # error-policy:J3 Runtime response timestamps are untrusted transport data.
    except ValueError as exc:
        raise TrustedExecutorHttpError(
            502,
            f"trusted runtime {field} must be an ISO timestamp",
        ) from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise TrustedExecutorHttpError(
            502,
            f"trusted runtime {field} must include a timezone",
        )
    return parsed.astimezone(timezone.utc)


def _validate_effect_receipts(
    result: dict[str, object],
    *,
    policy: TrustedActionPolicy,
    idempotency_key: str,
) -> None:
    if result.get("success") is not True:
        return
    receipts = result.get("effectReceipts")
    if policy.risk == "read" and receipts is None:
        return
    if not isinstance(receipts, list) or not receipts:
        raise TrustedExecutorHttpError(
            502,
            (
                "successful mutating runtime action returned no effect receipts"
                if policy.risk != "read"
                else "runtime action returned invalid effect receipt data"
            ),
        )
    outcomes: set[str] = set()
    for raw_receipt in receipts:
        receipt = _as_object(raw_receipt, "effect receipt")
        receipt_id = receipt.get("receiptId")
        operation = receipt.get("operation")
        outcome = receipt.get("outcome")
        observed_at = receipt.get("observedAt")
        if (
            not isinstance(receipt_id, str)
            or not receipt_id
            or not isinstance(operation, str)
            or not operation
            or outcome
            not in {"applied", "preview", "noop", "failed", "rolled_back"}
        ):
            raise TrustedExecutorHttpError(
                502,
                "trusted runtime effect receipt identity is incomplete",
            )
        _parse_utc_timestamp(observed_at, "effect receipt observedAt")
        resource = _as_object(
            receipt.get("resource"),
            "effect receipt resource",
        )
        if (
            not isinstance(resource.get("kind"), str)
            or not cast(str, resource["kind"]).strip()
            or not isinstance(resource.get("id"), str)
            or not cast(str, resource["id"]).strip()
            or (
                resource.get("version") is not None
                and not isinstance(resource.get("version"), str)
            )
        ):
            raise TrustedExecutorHttpError(
                502,
                "trusted runtime effect receipt resource is incomplete",
            )
        artifacts = receipt.get("artifacts")
        if not isinstance(artifacts, list):
            raise TrustedExecutorHttpError(
                502,
                "trusted runtime effect receipt artifacts must be an array",
            )
        for artifact in artifacts:
            artifact_ref = _as_object(
                artifact,
                "effect receipt artifact",
            )
            if (
                not isinstance(artifact_ref.get("kind"), str)
                or not cast(str, artifact_ref["kind"]).strip()
                or not isinstance(artifact_ref.get("id"), str)
                or not cast(str, artifact_ref["id"]).strip()
            ):
                raise TrustedExecutorHttpError(
                    502,
                    "trusted runtime effect receipt artifact is incomplete",
                )
        idempotency = _as_object(
            receipt.get("idempotency"),
            "effect receipt idempotency",
        )
        if (
            idempotency.get("key") != idempotency_key
            or not isinstance(idempotency.get("replayed"), bool)
        ):
            raise TrustedExecutorHttpError(
                502,
                "runtime effect receipt is not bound to the executor idempotency key",
            )
        outcomes.add(outcome)
        if outcome == "applied":
            commit = _as_object(
                receipt.get("commit"),
                "applied effect receipt commit",
            )
            if (
                commit.get("kind") not in {"durable", "provider_accepted"}
                or not isinstance(commit.get("id"), str)
                or not cast(str, commit["id"]).strip()
            ):
                raise TrustedExecutorHttpError(
                    502,
                    "applied runtime effect receipt lacks commit proof",
                )
            _parse_utc_timestamp(
                commit.get("committedAt"),
                "effect receipt committedAt",
            )
    if policy.risk == "approved_write" and "applied" not in outcomes:
        raise TrustedExecutorHttpError(
            502,
            "approved write has no applied effect receipt",
        )
    if policy.risk == "proposal" and not outcomes.intersection(
        {"applied", "preview", "noop"}
    ):
        raise TrustedExecutorHttpError(
            502,
            "proposal action has no durable or explicit preview outcome",
        )


@dataclass(frozen=True)
class ElizaRuntimeActionConnector:
    """Calls a separately deployed native elizaOS action runtime."""

    url: str
    bearer_token: str
    timeout_s: float = 30.0

    def __post_init__(self) -> None:
        object.__setattr__(self, "url", _runtime_url(self.url))
        if len(self.bearer_token) < 32:
            raise ValueError(
                "trusted runtime bearer token must contain at least 32 characters"
            )
        if self.timeout_s <= 0:
            raise ValueError("trusted runtime timeout must be positive")

    def execute(
        self,
        action: Action,
        *,
        idempotency_key: str,
        request: ValidatedExecutionRequest,
        policy: TrustedActionPolicy,
    ) -> ConnectorExecution:
        """Execute one exact handler call and validate its runtime provenance."""
        if not _IDEMPOTENCY_PATTERN.fullmatch(idempotency_key):
            raise TrustedExecutorHttpError(
                500,
                "executor generated an invalid provider idempotency key",
            )
        parameters = dict(action.kwargs)
        supplied_key = parameters.get("idempotencyKey")
        if supplied_key is not None and supplied_key != idempotency_key:
            raise TrustedExecutorHttpError(
                409,
                "action idempotencyKey conflicts with executor replay identity",
            )
        parameters["idempotencyKey"] = idempotency_key
        requested_at = datetime.now(timezone.utc)
        body = {
            "schema": TRUSTED_RUNTIME_ACTION_SCHEMA,
            "task_id": f"{request.scenario_id}:{request.run_id}",
            "action": {
                "name": action.name,
                "parameters": parameters,
            },
            "idempotency_key": idempotency_key,
            "risk": policy.risk,
            "requested_at": requested_at.isoformat().replace("+00:00", "Z"),
        }
        try:
            with httpx.Client(
                timeout=self.timeout_s,
                follow_redirects=False,
                trust_env=False,
            ) as client:
                response = client.post(
                    self.url,
                    content=canonical_json_bytes(body),
                    headers={
                        "Authorization": f"Bearer {self.bearer_token}",
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                        "Accept-Encoding": "identity",
                    },
                )
        # error-policy:J1 This connector is the runtime transport boundary.
        except httpx.HTTPError as exc:
            raise TrustedExecutorHttpError(
                502,
                "trusted runtime transport failed with an unknown action outcome",
            ) from exc
        if response.status_code != 200:
            raise TrustedExecutorHttpError(
                502,
                f"trusted runtime rejected the action with HTTP {response.status_code}",
            )
        if len(response.content) > _MAX_RUNTIME_RESPONSE_BYTES:
            raise TrustedExecutorHttpError(
                502,
                "trusted runtime response exceeds the connector limit",
            )
        try:
            decoded = response.json()
        # error-policy:J3 Runtime response JSON is untrusted transport data.
        except ValueError as exc:
            raise TrustedExecutorHttpError(
                502,
                "trusted runtime returned invalid JSON",
            ) from exc
        payload = _as_object(decoded, "response")
        expected_fields = {
            "schema",
            "ok",
            "task_id",
            "action",
            "idempotency_key",
            "risk",
            "requested_at",
            "observed_at",
            "runtime",
            "result",
        }
        if set(payload) != expected_fields:
            raise TrustedExecutorHttpError(
                502,
                "trusted runtime response fields do not match the protocol",
            )
        if (
            payload.get("schema") != TRUSTED_RUNTIME_ACTION_SCHEMA
            or payload.get("task_id") != body["task_id"]
            or payload.get("action") != action.name
            or payload.get("idempotency_key") != idempotency_key
            or payload.get("risk") != policy.risk
        ):
            raise TrustedExecutorHttpError(
                502,
                "trusted runtime response identity does not match the request",
            )
        runtime = _as_object(payload.get("runtime"), "provenance")
        if (
            runtime.get("native_runtime_class")
            != "@elizaos/core.AgentRuntime"
            or runtime.get("native_runtime_api") != "Action.handler"
            or runtime.get("transport") != "trusted_runtime_http"
            or runtime.get("stand_in") is not False
            or runtime.get("release_evidence") is not True
        ):
            raise TrustedExecutorHttpError(
                502,
                "trusted runtime response does not prove a native production path",
            )
        result = _as_object(payload.get("result"), "action result")
        success = result.get("success")
        if not isinstance(success, bool) or payload.get("ok") is not success:
            raise TrustedExecutorHttpError(
                502,
                "trusted runtime action success state is inconsistent",
            )
        data = _as_object(result.get("data"), "action result data")
        if data.get("actionName") != action.name:
            raise TrustedExecutorHttpError(
                502,
                "trusted runtime action result has mismatched action provenance",
            )
        _validate_effect_receipts(
            result,
            policy=policy,
            idempotency_key=idempotency_key,
        )
        observed_at = _parse_utc_timestamp(
            payload.get("observed_at"),
            "observed_at",
        )
        if observed_at < requested_at:
            raise TrustedExecutorHttpError(
                502,
                "trusted runtime observation predates the connector request",
            )
        canonical_json_bytes(payload)
        return ConnectorExecution(
            payload=cast(JsonObject, payload),
            observed_at=observed_at,
            succeeded=success,
        )


def _source_snapshot(
    execution: ConnectorExecution,
) -> dict[str, object] | None:
    result = execution.payload.get("result")
    if not isinstance(result, dict):
        return None
    data = result.get("data")
    if not isinstance(data, dict):
        return None
    snapshot = data.get("snapshot")
    return cast(dict[str, object], snapshot) if isinstance(snapshot, dict) else None


def _valid_source_identity(value: object) -> tuple[str, ...] | None:
    if not isinstance(value, dict):
        return None
    fields = (
        value.get("provider"),
        value.get("side"),
        value.get("grantId"),
        value.get("connectorAccountId"),
        value.get("calendarId"),
    )
    if not all(isinstance(item, str) and item.strip() for item in fields):
        return None
    return cast(tuple[str, ...], fields)


def _source_has_independent_health(source: object) -> bool:
    if not isinstance(source, dict):
        return False
    key = _valid_source_identity(source.get("key"))
    health = source.get("health")
    if key is None or not isinstance(health, dict):
        return False
    if _valid_source_identity(health.get("key")) != key:
        return False
    status = health.get("status")
    if status not in _SOURCE_STATUSES:
        return False
    if not isinstance(health.get("accessRole"), str):
        return False
    if health.get("visibility") not in {"details", "busy_only"}:
        return False
    synced_at = health.get("syncedAt")
    if synced_at is not None:
        _parse_utc_timestamp(synced_at, "calendar source syncedAt")
    error = health.get("error")
    if error is not None:
        if not isinstance(error, dict):
            return False
        if (
            not isinstance(error.get("code"), str)
            or not isinstance(error.get("message"), str)
            or not isinstance(error.get("retryable"), bool)
        ):
            return False
    if status == "error" and error is None:
        return False
    return True


class CalendarPartialFailureEvaluator:
    """Exact G10 evaluator over CALENDAR_SOURCES structured state."""

    def evaluate(
        self,
        request: ValidatedExecutionRequest,
        execution: ConnectorExecution,
        _action_lineage: tuple[ActionLineageEntry, ...],
    ) -> ContractEvaluation:
        if (
            request.action.name != "CALENDAR_SOURCES"
            or request.action.kwargs.get("operation") != "list"
            or not execution.succeeded
        ):
            return ContractEvaluation(assertions=(), terminal=False)
        snapshot = _source_snapshot(execution)
        if snapshot is None:
            return ContractEvaluation(assertions=(), terminal=False)
        sources = snapshot.get("sources")
        observed_at = snapshot.get("observedAt")
        if (
            snapshot.get("state") not in _SOURCE_STATES
            or not isinstance(sources, list)
            or not sources
            or not isinstance(observed_at, str)
        ):
            return ContractEvaluation(assertions=(), terminal=False)
        try:
            _parse_utc_timestamp(observed_at, "calendar snapshot observedAt")
            source_health_valid = all(
                _source_has_independent_health(source) for source in sources
            )
        except TrustedExecutorHttpError:
            source_health_valid = False
        identities = [
            _valid_source_identity(source.get("key"))
            for source in sources
            if isinstance(source, dict)
        ]
        source_health_valid = (
            source_health_valid
            and len(identities) == len(sources)
            and None not in identities
            and len(set(identities)) == len(identities)
        )
        partial = snapshot.get("state") == "partial"
        revision = hashlib.sha256(canonical_json_bytes(snapshot)).hexdigest()
        assertions: list[AssertionArtifact] = []
        if source_health_valid:
            assertions.append(
                AssertionArtifact(
                    assertion_id="G10.world.1",
                    passed=True,
                    subject="calendar-source-health-set",
                    revision=revision,
                    evidence_kind="eliza_runtime_action_result",
                    evidence_reference=(
                        "runtime-action://CALENDAR_SOURCES/result/data/snapshot"
                    ),
                )
            )
        if partial:
            assertions.append(
                AssertionArtifact(
                    assertion_id="G10.world.2",
                    passed=True,
                    subject="calendar-feed-aggregate-state",
                    revision=revision,
                    evidence_kind="eliza_runtime_action_result",
                    evidence_reference=(
                        "runtime-action://CALENDAR_SOURCES/result/data/snapshot/state"
                    ),
                )
            )
        return ContractEvaluation(
            assertions=tuple(assertions),
            terminal=source_health_valid and partial,
        )


def _parent_requirement(contract_id: str) -> TrustedEvidenceRequirement:
    matches = [
        scenario.trusted_evidence_requirement
        for scenario in WORLD_TRAVELING_COPARENT_SCENARIOS
        if scenario.trusted_evidence_requirement is not None
        and scenario.trusted_evidence_requirement.contract_id == contract_id
    ]
    if len(matches) != 1:
        raise RuntimeError(
            f"expected exactly one parent-suite contract {contract_id}"
        )
    return matches[0]


def production_parent_contract_registry() -> EvidenceContractRegistry:
    """Return only contracts with complete server-owned implementations.

    Unimplemented contracts are intentionally absent, so requests for them
    fail before connector dispatch instead of receiving generic success.
    """
    return EvidenceContractRegistry(
        (
            RegisteredEvidenceContract(
                requirement=_parent_requirement("G10"),
                evaluator=CalendarPartialFailureEvaluator(),
            ),
        )
    )
