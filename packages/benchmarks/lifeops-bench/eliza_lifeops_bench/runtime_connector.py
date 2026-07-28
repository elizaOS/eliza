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
from .parent_contracts import typed_parent_contract_evaluator
from .parenting_contracts import (
    GroundedParentingFrameworkEvaluator,
    ParentingSafetyBoundaryEvaluator,
)
from .scenarios import (
    WORLD_TRAVELING_COPARENT_SCENARIOS,
    WORLD_TRAVELING_COPARENT_UNINSTRUCTED_SCENARIOS,
)
from .trusted_executor_server import (
    ActionLineageEntry,
    AssertionArtifact,
    ConnectorExecution,
    ContractEvaluation,
    EvidenceContractRegistry,
    RegisteredEvidenceContract,
    ServerOwnedContractEvaluator,
    TrustedExecutorHttpError,
    ValidatedExecutionRequest,
)
from .types import Action, TrustedActionPolicy, TrustedEvidenceRequirement

TRUSTED_RUNTIME_ACTION_SCHEMA = "eliza.trusted-runtime-action.v1"
TRUSTED_RUNTIME_EVIDENCE_PROVENANCE_SCHEMA = (
    "eliza.trusted-runtime-evidence-provenance.v1"
)
_MAX_RUNTIME_RESPONSE_BYTES = 2 * 1024 * 1024
_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
_IDEMPOTENCY_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{15,255}$")
_PROVIDER_IDENTIFIER_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{1,63}$")
_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_SOURCE_STATUSES = frozenset({"fresh", "stale", "error", "disconnected"})
_SOURCE_STATES = frozenset({"complete", "partial", "unavailable"})
_RUNTIME_PROVENANCE_FIELDS = frozenset(
    {
        "native_runtime_class",
        "native_runtime_api",
        "transport",
        "stand_in",
        "release_evidence",
        "evidence_provenance",
        "action_tags",
    }
)
_EVIDENCE_PROVENANCE_FIELDS = frozenset(
    {
        "schema",
        "tier",
        "publishable",
        "configuration_basis",
        "provider",
        "boundary",
        "account_identity_sha256",
        "provider_readback",
    }
)
_PROVIDER_EVIDENCE_BOUNDARIES = frozenset({"sandbox_connector", "production_connector"})


@dataclass(frozen=True)
class _RuntimeEvidenceProvenance:
    """Validated server provenance relevant to effect-receipt release checks."""

    tier: str
    provider_readback_verified: bool


def _runtime_url(url: str) -> str:
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("trusted runtime URL must use HTTP or HTTPS")
    if not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("trusted runtime URL authority is invalid")
    if parsed.scheme == "http" and parsed.hostname not in _LOOPBACK_HOSTS:
        raise ValueError("plain HTTP trusted runtime URLs are restricted to loopback")
    if parsed.query or parsed.fragment:
        raise ValueError("trusted runtime URL cannot contain query or fragment")
    if parsed.path not in {
        "",
        "/",
        "/api/benchmark/trusted-runtime/action",
    }:
        raise ValueError("trusted runtime URL path is unsupported")
    return f"{parsed.scheme}://{parsed.netloc}/api/benchmark/trusted-runtime/action"


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


def _validate_runtime_provenance(
    runtime: dict[str, object],
) -> _RuntimeEvidenceProvenance:
    """Validate the closed v1 runtime/provenance union without releasing it."""
    if set(runtime) != _RUNTIME_PROVENANCE_FIELDS:
        raise TrustedExecutorHttpError(
            502,
            "trusted runtime provenance fields do not match the protocol",
        )
    action_tags = runtime.get("action_tags")
    if (
        runtime.get("native_runtime_class") != "@elizaos/core.AgentRuntime"
        or runtime.get("native_runtime_api") != "Action.handler"
        or runtime.get("transport") != "trusted_runtime_http"
        or runtime.get("stand_in") is not False
        or runtime.get("release_evidence") is not False
        or not isinstance(action_tags, list)
        or not all(isinstance(tag, str) and tag.strip() for tag in action_tags)
    ):
        raise TrustedExecutorHttpError(
            502,
            "trusted runtime response does not match the native runtime protocol",
        )
    provenance = _as_object(
        runtime.get("evidence_provenance"),
        "evidence provenance",
    )
    if set(provenance) != _EVIDENCE_PROVENANCE_FIELDS:
        raise TrustedExecutorHttpError(
            502,
            "trusted runtime evidence provenance fields do not match the protocol",
        )
    if provenance.get("schema") != TRUSTED_RUNTIME_EVIDENCE_PROVENANCE_SCHEMA:
        raise TrustedExecutorHttpError(
            502,
            "trusted runtime evidence provenance schema is unsupported",
        )
    tier = provenance.get("tier")
    if tier == "local_nonpublishable":
        if (
            provenance.get("publishable") is not False
            or provenance.get("configuration_basis") != "default_local_configuration"
            or provenance.get("provider") is not None
            or provenance.get("boundary") is not None
            or provenance.get("account_identity_sha256") is not None
            or provenance.get("provider_readback") != "not_applicable"
        ):
            raise TrustedExecutorHttpError(
                502,
                "trusted runtime local evidence provenance is invalid",
            )
        return _RuntimeEvidenceProvenance(
            tier="local_nonpublishable",
            provider_readback_verified=False,
        )
    if tier == "provider_backed":
        provider = provenance.get("provider")
        boundary = provenance.get("boundary")
        account_identity_sha256 = provenance.get("account_identity_sha256")
        if (
            provenance.get("publishable") is not False
            or provenance.get("configuration_basis") != "explicit_server_configuration"
            or not isinstance(provider, str)
            or not _PROVIDER_IDENTIFIER_PATTERN.fullmatch(provider)
            or not isinstance(boundary, str)
            or boundary not in _PROVIDER_EVIDENCE_BOUNDARIES
            or not isinstance(account_identity_sha256, str)
            or not _SHA256_PATTERN.fullmatch(account_identity_sha256)
            or provenance.get("provider_readback") != "not_verified"
        ):
            raise TrustedExecutorHttpError(
                502,
                "trusted runtime provider evidence provenance is invalid",
            )
        return _RuntimeEvidenceProvenance(
            tier="provider_backed",
            provider_readback_verified=False,
        )
    raise TrustedExecutorHttpError(
        502,
        "trusted runtime evidence provenance tier is unsupported",
    )


def _validate_effect_receipts(
    result: dict[str, object],
    *,
    policy: TrustedActionPolicy,
    idempotency_key: str,
    provenance: _RuntimeEvidenceProvenance,
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
            or not isinstance(outcome, str)
            or outcome not in {"applied", "preview", "noop", "failed", "rolled_back"}
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
            idempotency.get("key") is not None
            and (
                not isinstance(idempotency.get("key"), str)
                or not cast(str, idempotency["key"]).strip()
            )
        ) or not isinstance(idempotency.get("replayed"), bool):
            raise TrustedExecutorHttpError(
                502,
                "runtime effect receipt has invalid domain idempotency state",
            )
        invocation = _as_object(
            receipt.get("trustedRuntimeInvocation"),
            "effect receipt trusted runtime invocation",
        )
        if invocation != {"idempotencyKey": idempotency_key}:
            raise TrustedExecutorHttpError(
                502,
                "runtime effect receipt is not bound to the executor invocation",
            )
        outcomes.add(cast(str, outcome))
        if outcome == "applied":
            commit = _as_object(
                receipt.get("commit"),
                "applied effect receipt commit",
            )
            commit_kind = commit.get("kind")
            if (
                not isinstance(commit_kind, str)
                or commit_kind not in {"durable", "provider_accepted"}
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
            if commit_kind == "provider_accepted":
                domain_key = idempotency.get("key")
                if (
                    not isinstance(domain_key, str)
                    or not domain_key.strip()
                    or domain_key != idempotency_key
                ):
                    raise TrustedExecutorHttpError(
                        502,
                        (
                            "provider-accepted effect receipt domain idempotency "
                            "does not match the authenticated invocation"
                        ),
                    )
                if not provenance.provider_readback_verified:
                    raise TrustedExecutorHttpError(
                        502,
                        (
                            "provider-accepted effect receipt lacks verified "
                            "server-owned provider readback provenance"
                        ),
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
            or payload.get("requested_at") != body["requested_at"]
        ):
            raise TrustedExecutorHttpError(
                502,
                "trusted runtime response identity does not match the request",
            )
        runtime = _as_object(payload.get("runtime"), "provenance")
        provenance = _validate_runtime_provenance(runtime)
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
        if "terminalSnapshot" in data:
            raise TrustedExecutorHttpError(
                502,
                (
                    "trusted runtime action result contains forbidden "
                    "action-authored terminalSnapshot data"
                ),
            )
        _validate_effect_receipts(
            result,
            policy=policy,
            idempotency_key=idempotency_key,
            provenance=provenance,
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
        raise TrustedExecutorHttpError(
            502,
            (
                "trusted runtime response lacks verified server-owned provider "
                f"readback provenance ({provenance.tier})"
            ),
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


def _validated_source_status(
    source: object,
    *,
    snapshot_observed_at: datetime,
) -> str | None:
    if not isinstance(source, dict):
        return None
    key = _valid_source_identity(source.get("key"))
    health = source.get("health")
    if key is None or not isinstance(health, dict):
        return None
    if _valid_source_identity(health.get("key")) != key:
        return None
    summary = source.get("summary")
    access_role = source.get("accessRole")
    account_email = source.get("accountEmail")
    include_in_feed = source.get("includeInFeed")
    selection_version = source.get("selectionVersion")
    if (
        not isinstance(summary, str)
        or not summary.strip()
        or not isinstance(source.get("primary"), bool)
        or not isinstance(access_role, str)
        or not access_role.strip()
        or (account_email is not None and not isinstance(account_email, str))
        or (include_in_feed is not None and not isinstance(include_in_feed, bool))
        or (
            selection_version is not None
            and (
                not isinstance(selection_version, int)
                or isinstance(selection_version, bool)
                or selection_version < 0
                or selection_version > 9_007_199_254_740_991
            )
        )
        or (include_in_feed is None) != (selection_version is None)
        or health.get("summary") != summary
        or health.get("accessRole") != access_role
    ):
        return None
    status = health.get("status")
    if not isinstance(status, str) or status not in _SOURCE_STATUSES:
        return None
    visibility = health.get("visibility")
    if not isinstance(visibility, str) or visibility not in {"details", "busy_only"}:
        return None
    synced_at = health.get("syncedAt")
    parsed_synced_at: datetime | None = None
    if synced_at is not None:
        parsed_synced_at = _parse_utc_timestamp(
            synced_at,
            "calendar source syncedAt",
        )
        if parsed_synced_at > snapshot_observed_at:
            return None
    error = health.get("error")
    if error is not None:
        if not isinstance(error, dict):
            return None
        if (
            not isinstance(error.get("code"), str)
            or not cast(str, error["code"]).strip()
            or not isinstance(error.get("message"), str)
            or not cast(str, error["message"]).strip()
            or not isinstance(error.get("retryable"), bool)
        ):
            return None
    if status == "fresh" and (parsed_synced_at is None or error is not None):
        return None
    if status == "stale" and parsed_synced_at is None and error is None:
        return None
    if status in {"error", "disconnected"} and error is None:
        return None
    return cast(str, status)


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
        state = snapshot.get("state")
        if (
            not isinstance(state, str)
            or state not in _SOURCE_STATES
            or not isinstance(sources, list)
            or not sources
            or not isinstance(observed_at, str)
        ):
            return ContractEvaluation(assertions=(), terminal=False)
        try:
            snapshot_observed_at = _parse_utc_timestamp(
                observed_at,
                "calendar snapshot observedAt",
            )
            statuses = [
                _validated_source_status(
                    source,
                    snapshot_observed_at=snapshot_observed_at,
                )
                for source in sources
            ]
        except TrustedExecutorHttpError:
            statuses = [None]
            snapshot_observed_at = execution.observed_at
        identities = [
            _valid_source_identity(source.get("key"))
            for source in sources
            if isinstance(source, dict)
        ]
        source_health_valid = (
            None not in statuses
            and len(identities) == len(sources)
            and None not in identities
            and len(set(identities)) == len(identities)
            and snapshot_observed_at <= execution.observed_at
            and (execution.observed_at - snapshot_observed_at).total_seconds() <= 5 * 60
        )
        fresh_count = statuses.count("fresh")
        degraded_count = sum(
            status in {"stale", "error", "disconnected"} for status in statuses
        )
        if fresh_count == len(statuses):
            expected_state = "complete"
        elif fresh_count > 0 and degraded_count > 0:
            expected_state = "partial"
        else:
            expected_state = "unavailable"
        partial = (
            source_health_valid
            and state == expected_state == "partial"
            and fresh_count > 0
            and degraded_count > 0
        )
        revision = hashlib.sha256(canonical_json_bytes(snapshot)).hexdigest()
        assertions: list[AssertionArtifact] = []
        if partial:
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
            terminal=partial,
        )


_PARENT_STATE_SCHEMA = "lifeops.trusted-parent-contract-state.v1"
_G15_SCENARIO = "m1.g15.school_source_correction"
_G30_SCENARIO = "m1.g30.child_size_history"
_G34_SCENARIO = "m1.g34.household_wide_care_math"
_G38_SCENARIO = "m1.g38.partner_nonuse_renegotiation"
_G15_NOTICE_KEY = "early-release"
_G30_CHILD = "Lee"
_G30_THRESHOLD = "raincoat-size-threshold"
_G38_ASSIGNMENT = "gutter-responsibility-assignment"
_G38_PARTNER = "trusted-parent-g38-partner"
_CARE_FORMULA_SET = "childcare-work-scenario.formula-set.v1"
_SHA256_ID = re.compile(r"^sha256:[0-9a-f]{64}$")


def _native_lineage_matches(
    request: ValidatedExecutionRequest,
    lineage: tuple[ActionLineageEntry, ...],
    state: dict[str, object],
) -> bool:
    if not lineage:
        return False
    current = lineage[-1]
    if (
        current.request_ordinal != request.request_ordinal
        or current.tool_call_id != request.tool_call_id
        or current.action != request.action.name
        or current.action_sha256 != request.action_sha256
    ):
        return False
    history = state.get("actionHistory")
    if not isinstance(history, list) or len(history) != len(lineage):
        return False
    return all(
        isinstance(observation, dict)
        and observation.get("actionName") == entry.action
        and observation.get("succeeded") is True
        for observation, entry in zip(history, lineage, strict=True)
    )


def _native_parent_state(
    execution: ConnectorExecution,
    *,
    action_name: str,
    scenario_id: str,
) -> tuple[dict[str, object], dict[str, object]] | None:
    if not execution.succeeded:
        return None
    result = execution.payload.get("result")
    if not isinstance(result, dict) or result.get("success") is not True:
        return None
    data = result.get("data")
    if not isinstance(data, dict) or data.get("actionName") != action_name:
        return None
    state = data.get("trustedParentContractState")
    if not isinstance(state, dict):
        return None
    observed_at = _timestamp_or_none(state.get("observedAt"))
    if (
        state.get("schemaVersion") != _PARENT_STATE_SCHEMA
        or state.get("scenarioId") != scenario_id
        or observed_at is None
        or observed_at > execution.observed_at
        or (execution.observed_at - observed_at).total_seconds() > 5 * 60
    ):
        return None
    return cast(dict[str, object], data), cast(dict[str, object], state)


def _timestamp_or_none(value: object) -> datetime | None:
    try:
        return _parse_utc_timestamp(value, "trusted state timestamp")
    except TrustedExecutorHttpError:
        return None


def _string_list(value: object, *, minimum: int = 1) -> list[str] | None:
    if (
        not isinstance(value, list)
        or len(value) < minimum
        or not all(isinstance(item, str) and item.strip() for item in value)
        or len(value) != len(set(value))
    ):
        return None
    return cast(list[str], value)


def _native_revision(value: object) -> str:
    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()


def _native_assertion(
    assertion_id: str,
    *,
    subject: str,
    revision: str,
    reference: str,
) -> AssertionArtifact:
    return AssertionArtifact(
        assertion_id=assertion_id,
        passed=True,
        subject=subject,
        revision=revision,
        evidence_kind="eliza_runtime_action_and_production_state",
        evidence_reference=reference,
    )


def _final_history_action(
    state: dict[str, object],
    *,
    action_name: str,
    discriminator: str,
    operation: str,
) -> bool:
    history = state.get("actionHistory")
    if not isinstance(history, list) or not history:
        return False
    current = history[-1]
    if not isinstance(current, dict):
        return False
    operations = current.get("operations")
    return (
        current.get("actionName") == action_name
        and current.get("discriminator") == discriminator
        and current.get("succeeded") is True
        and isinstance(current.get("receiptIds"), list)
        and bool(current["receiptIds"])
        and isinstance(operations, list)
        and operation in operations
    )


class SchoolCorrectionEvaluator:
    """Evaluate G15 from reconciled source facts and graph relationships."""

    def evaluate(
        self,
        request: ValidatedExecutionRequest,
        execution: ConnectorExecution,
        lineage: tuple[ActionLineageEntry, ...],
    ) -> ContractEvaluation:
        if (
            request.contract_id != "G15"
            or request.scenario_id != _G15_SCENARIO
            or request.action.name != "SCHOOL_SOURCES"
            or request.action.kwargs.get("action") != "reconcile_notice"
            or request.action.kwargs.get("noticeKey") != _G15_NOTICE_KEY
        ):
            return ContractEvaluation(assertions=(), terminal=False)
        objects = _native_parent_state(
            execution,
            action_name="SCHOOL_SOURCES",
            scenario_id=_G15_SCENARIO,
        )
        if objects is None:
            return ContractEvaluation(assertions=(), terminal=False)
        _data, state = objects
        if not _native_lineage_matches(
            request, lineage, state
        ) or not _final_history_action(
            state,
            action_name="SCHOOL_SOURCES",
            discriminator="reconcile_notice",
            operation="lifeops.school_notice.reconcile",
        ):
            return ContractEvaluation(assertions=(), terminal=False)
        facts = state.get("sourceFacts")
        artifacts = state.get("sourceArtifacts")
        relationships = state.get("relationships")
        canonical = state.get("canonical")
        if (
            not isinstance(facts, list)
            or len(facts) != 2
            or not isinstance(artifacts, list)
            or len(artifacts) != 2
            or not isinstance(relationships, list)
            or not isinstance(canonical, dict)
        ):
            return ContractEvaluation(assertions=(), terminal=False)
        fact_rows = [
            cast(dict[str, object], fact) for fact in facts if isinstance(fact, dict)
        ]
        artifact_rows = [
            cast(dict[str, object], artifact)
            for artifact in artifacts
            if isinstance(artifact, dict)
        ]
        if len(fact_rows) != 2 or len(artifact_rows) != 2:
            return ContractEvaluation(assertions=(), terminal=False)
        fact_ids = _string_list([fact.get("id") for fact in fact_rows], minimum=2)
        revisions = _string_list(
            [fact.get("revisionSha256") for fact in fact_rows],
            minimum=2,
        )
        artifact_ids = _string_list(
            [artifact.get("id") for artifact in artifact_rows],
            minimum=2,
        )
        source_ids = _string_list(
            [artifact.get("sourceId") for artifact in artifact_rows],
            minimum=2,
        )
        if (
            fact_ids is None
            or revisions is None
            or artifact_ids is None
            or source_ids is None
            or any(
                not isinstance(revision, str)
                or not re.fullmatch(r"[0-9a-f]{64}", revision)
                for revision in revisions
            )
            or {fact.get("artifactId") for fact in fact_rows} != set(artifact_ids)
            or {fact.get("authority") for fact in fact_rows}
            != {"school_calendar", "signed_school_correction"}
        ):
            return ContractEvaluation(assertions=(), terminal=False)
        authoritative_id = canonical.get("authoritativeFactId")
        authoritative_fact = next(
            (fact for fact in fact_rows if fact.get("id") == authoritative_id),
            None,
        )
        prior_ids = set(fact_ids).difference({authoritative_id})
        relation_kinds = {
            relationship.get("kind")
            for relationship in relationships
            if isinstance(relationship, dict)
            and relationship.get("fromFactId") == authoritative_id
            and relationship.get("toFactId") in prior_ids
        }
        provenance_ok = (
            canonical.get("canonicalFactId") == f"school.notice:{_G15_NOTICE_KEY}"
            and authoritative_fact is not None
            and authoritative_fact.get("authority") == "signed_school_correction"
            and canonical.get("authoritativeRevisionId")
            == authoritative_fact.get("revisionSha256")
            and canonical.get("effectiveDate") == "2026-05-21"
            and canonical.get("authorityClass") == "signed_school_correction"
            and relation_kinds == {"contradicts", "supersedes"}
        )
        revision = _native_revision(state)
        assertions: list[AssertionArtifact] = []
        if provenance_ok:
            assertions.append(
                _native_assertion(
                    "G15.world.1",
                    subject="school-source-fact-supersession",
                    revision=revision,
                    reference=(
                        "runtime-action://SCHOOL_SOURCES/result/data/"
                        "trustedParentContractState"
                    ),
                )
            )
            assertions.append(
                _native_assertion(
                    "G15.world.2",
                    subject="school-canonical-authority",
                    revision=revision,
                    reference=(
                        "runtime-action://SCHOOL_SOURCES/result/data/"
                        "trustedParentContractState/canonical"
                    ),
                )
            )
        return ContractEvaluation(
            assertions=tuple(assertions),
            terminal=provenance_ok,
        )


class ChildSizeHistoryEvaluator:
    """Evaluate G30 from two durable observations and the action receipt trail."""

    def evaluate(
        self,
        request: ValidatedExecutionRequest,
        execution: ConnectorExecution,
        lineage: tuple[ActionLineageEntry, ...],
    ) -> ContractEvaluation:
        if (
            request.contract_id != "G30"
            or request.scenario_id != _G30_SCENARIO
            or request.action.name != "HOUSEHOLD_OPERATIONS"
            or request.action.kwargs.get("action") != "evaluate_item_replacement"
            or request.action.kwargs.get("recordId") != _G30_THRESHOLD
        ):
            return ContractEvaluation(assertions=(), terminal=False)
        objects = _native_parent_state(
            execution,
            action_name="HOUSEHOLD_OPERATIONS",
            scenario_id=_G30_SCENARIO,
        )
        if objects is None:
            return ContractEvaluation(assertions=(), terminal=False)
        _data, state = objects
        if not _native_lineage_matches(
            request, lineage, state
        ) or not _final_history_action(
            state,
            action_name="HOUSEHOLD_OPERATIONS",
            discriminator="evaluate_item_replacement",
            operation="lifeops.household_item_replacement.evaluate",
        ):
            return ContractEvaluation(assertions=(), terminal=False)
        history_actions = state.get("actionHistory")
        history = state.get("sizeHistory")
        current = state.get("currentObservation")
        audit = state.get("commerceAudit")
        if (
            not isinstance(history_actions, list)
            or not any(
                isinstance(action, dict)
                and action.get("actionName") == "HOUSEHOLD_OPERATIONS"
                and action.get("discriminator") == "record_observation"
                and action.get("succeeded") is True
                and isinstance(action.get("operations"), list)
                and "lifeops.household_observation.record" in action["operations"]
                for action in history_actions[:-1]
            )
            or not isinstance(history, list)
            or len(history) != 2
            or not isinstance(current, dict)
            or not isinstance(audit, dict)
        ):
            return ContractEvaluation(assertions=(), terminal=False)
        rows = [
            cast(dict[str, object], item) for item in history if isinstance(item, dict)
        ]
        if len(rows) != 2:
            return ContractEvaluation(assertions=(), terminal=False)
        sizes: set[str] = set()
        source_revisions: set[int] = set()
        observation_ids: set[str] = set()
        for row in rows:
            value = row.get("value")
            provenance = row.get("provenance")
            observation_id = row.get("observationId")
            digest = row.get("contentSha256")
            if (
                row.get("observationKind") != "child_item_size"
                or not isinstance(value, dict)
                or value.get("kind") != "child_item_size"
                or value.get("childEntityId") != _G30_CHILD
                or value.get("itemCategory") != "raincoat"
                or value.get("sizeLabel") not in {"7", "8"}
                or not isinstance(provenance, dict)
                or provenance.get("sourceId") != "lee-raincoat-fit"
                or not isinstance(provenance.get("sourceRevision"), int)
                or not isinstance(observation_id, str)
                or not observation_id
                or not isinstance(digest, str)
                or not re.fullmatch(r"[0-9a-f]{64}", digest)
            ):
                return ContractEvaluation(assertions=(), terminal=False)
            sizes.add(cast(str, value["sizeLabel"]))
            source_revisions.add(cast(int, provenance["sourceRevision"]))
            observation_ids.add(observation_id)
        current_value = current.get("value")
        current_row = next(
            (
                row
                for row in rows
                if row.get("observationId") == current.get("observationId")
            ),
            None,
        )
        history_ok = (
            state.get("subjectEntityId") == _G30_CHILD
            and state.get("thresholdRecordId") == _G30_THRESHOLD
            and state.get("appendOnly") is True
            and sizes == {"7", "8"}
            and source_revisions == {1, 2}
            and len(observation_ids) == 2
            and isinstance(current_value, dict)
            and current_value.get("kind") == "child_item_size"
            and current_value.get("sizeLabel") == "8"
            and current_row == current
        )
        no_purchase = (
            audit.get("cartCount") == 0
            and audit.get("orderCount") == 0
            and audit.get("paymentArtifactCount") == 0
        )
        revision = _native_revision(state)
        assertions: list[AssertionArtifact] = []
        if history_ok:
            assertions.append(
                _native_assertion(
                    "G30.world.1",
                    subject="child-raincoat-size-history",
                    revision=revision,
                    reference=(
                        "runtime-action://HOUSEHOLD_OPERATIONS/result/data/"
                        "trustedParentContractState/sizeHistory"
                    ),
                )
            )
        if history_ok and no_purchase:
            assertions.append(
                _native_assertion(
                    "G30.world.2",
                    subject="child-size-no-purchase-audit",
                    revision=revision,
                    reference=(
                        "runtime-action://HOUSEHOLD_OPERATIONS/result/data/"
                        "trustedParentContractState/commerceAudit"
                    ),
                )
            )
        return ContractEvaluation(
            assertions=tuple(assertions),
            terminal=history_ok and no_purchase,
        )


def _contains_maternal_field(value: object) -> bool:
    if isinstance(value, dict):
        return any(
            "maternal" in str(key).lower()
            or "mother" in str(key).lower()
            or _contains_maternal_field(item)
            for key, item in value.items()
        )
    if isinstance(value, list):
        return any(_contains_maternal_field(item) for item in value)
    return False


class HouseholdCareMathEvaluator:
    """Evaluate G34 from canonical inputs and the versioned calculation."""

    def evaluate(
        self,
        request: ValidatedExecutionRequest,
        execution: ConnectorExecution,
        lineage: tuple[ActionLineageEntry, ...],
    ) -> ContractEvaluation:
        if (
            request.contract_id != "G34"
            or request.scenario_id != _G34_SCENARIO
            or request.action.name != "OWNER_FINANCES"
            or request.action.kwargs.get("action") != "childcare_work_scenario"
        ):
            return ContractEvaluation(assertions=(), terminal=False)
        scenario_json = request.action.kwargs.get("scenarioJson")
        if not isinstance(scenario_json, str):
            return ContractEvaluation(assertions=(), terminal=False)
        try:
            source = json.loads(scenario_json)
        except (TypeError, ValueError):
            return ContractEvaluation(assertions=(), terminal=False)
        if not isinstance(source, dict):
            return ContractEvaluation(assertions=(), terminal=False)
        objects = _native_parent_state(
            execution,
            action_name="OWNER_FINANCES",
            scenario_id=_G34_SCENARIO,
        )
        if objects is None:
            return ContractEvaluation(assertions=(), terminal=False)
        _data, state = objects
        if not _native_lineage_matches(request, lineage, state):
            return ContractEvaluation(assertions=(), terminal=False)
        calculation = state.get("calculation")
        if not isinstance(calculation, dict):
            return ContractEvaluation(assertions=(), terminal=False)
        source_options = source.get("options")
        result_options = calculation.get("options")
        revisions = calculation.get("inputRevisionIds")
        if (
            source.get("schemaVersion") != "childcare-work-scenario.v1"
            or calculation.get("schemaVersion") != source.get("schemaVersion")
            or calculation.get("scenarioId") != source.get("scenarioId")
            or calculation.get("householdId") != source.get("householdId")
            or calculation.get("asOf") != source.get("asOf")
            or calculation.get("status") != "complete"
            or not isinstance(source_options, list)
            or len(source_options) != 2
            or not isinstance(result_options, list)
            or len(result_options) != 2
            or not isinstance(revisions, list)
            or len(revisions) != 2
            or not all(
                isinstance(revision, str) and _SHA256_ID.fullmatch(revision)
                for revision in revisions
            )
            or len(set(cast(list[str], revisions))) != 2
            or calculation.get("comparableFormulaSetId") != _CARE_FORMULA_SET
        ):
            return ContractEvaluation(assertions=(), terminal=False)
        expected_revisions: list[str] = []
        source_model_ids: list[str] = []
        source_constraint_ids: set[str] = set()
        for option in source_options:
            if not isinstance(option, dict):
                return ContractEvaluation(assertions=(), terminal=False)
            option_id = option.get("optionId")
            childcare = option.get("childcare")
            if (
                not isinstance(option_id, str)
                or not option_id
                or not isinstance(childcare, list)
                or not childcare
            ):
                return ContractEvaluation(assertions=(), terminal=False)
            source_model_ids.append(option_id)
            for child in childcare:
                if not isinstance(child, dict) or not isinstance(
                    child.get("childEntityId"), str
                ):
                    return ContractEvaluation(assertions=(), terminal=False)
                source_constraint_ids.add(cast(str, child["childEntityId"]))
            payload = {
                "schemaVersion": source["schemaVersion"],
                "scenarioId": source.get("scenarioId"),
                "householdId": source.get("householdId"),
                "asOf": source.get("asOf"),
                "currency": source.get("currency"),
                "option": option,
            }
            expected_revisions.append(
                f"sha256:{hashlib.sha256(canonical_json_bytes(payload)).hexdigest()}"
            )
        model_ids: list[str] = []
        sensitivity_ids: list[str] = []
        constraint_ids: set[str] = set()
        for option in result_options:
            if not isinstance(option, dict) or option.get("status") != "complete":
                return ContractEvaluation(assertions=(), terminal=False)
            option_id = option.get("optionId")
            sensitivity = option.get("sensitivity")
            children = option.get("childcareCostByChild")
            if (
                not isinstance(option_id, str)
                or not option_id
                or not isinstance(sensitivity, list)
                or not sensitivity
                or not isinstance(children, list)
            ):
                return ContractEvaluation(assertions=(), terminal=False)
            model_ids.append(option_id)
            for item in sensitivity:
                if not isinstance(item, dict) or not isinstance(item.get("path"), str):
                    return ContractEvaluation(assertions=(), terminal=False)
                sensitivity_ids.append(f"{option_id}:{item['path']}")
            for child in children:
                if not isinstance(child, dict) or not isinstance(
                    child.get("childEntityId"), str
                ):
                    return ContractEvaluation(assertions=(), terminal=False)
                constraint_ids.add(cast(str, child["childEntityId"]))
        comparable = (
            cast(list[str], revisions) == expected_revisions
            and model_ids == source_model_ids
            and len(set(model_ids)) == 2
            and len(set(sensitivity_ids)) >= 2
        )
        guardrails = calculation.get("guardrails")
        household_owned = (
            comparable
            and constraint_ids == source_constraint_ids
            and bool(source_constraint_ids)
            and not _contains_maternal_field(source)
            and not _contains_maternal_field(calculation)
            and isinstance(guardrails, list)
            and all(isinstance(item, str) for item in guardrails)
            and any("household decision support" in item for item in guardrails)
        )
        revision = _native_revision(state)
        assertions: list[AssertionArtifact] = []
        if comparable:
            assertions.append(
                _native_assertion(
                    "G34.world.1",
                    subject="comparable-childcare-work-models",
                    revision=revision,
                    reference=(
                        "runtime-action://OWNER_FINANCES/result/data/"
                        "trustedParentContractState/calculation"
                    ),
                )
            )
        if household_owned:
            assertions.append(
                _native_assertion(
                    "G34.world.2",
                    subject="household-owned-care-constraints",
                    revision=revision,
                    reference=(
                        "runtime-action://OWNER_FINANCES/result/data/"
                        "trustedParentContractState/calculation/options"
                    ),
                )
            )
        return ContractEvaluation(
            assertions=tuple(assertions),
            terminal=household_owned,
        )


class ResponsibilityRenegotiationEvaluator:
    """Evaluate G38 from immutable revisions, provider signals, and review rows."""

    def evaluate(
        self,
        request: ValidatedExecutionRequest,
        execution: ConnectorExecution,
        lineage: tuple[ActionLineageEntry, ...],
    ) -> ContractEvaluation:
        if (
            request.contract_id != "G38"
            or request.scenario_id != _G38_SCENARIO
            or request.action.name != "HOUSEHOLD_OPERATIONS"
            or request.action.kwargs.get("action") != "assess_responsibility"
            or request.action.kwargs.get("recordId") != _G38_ASSIGNMENT
        ):
            return ContractEvaluation(assertions=(), terminal=False)
        objects = _native_parent_state(
            execution,
            action_name="HOUSEHOLD_OPERATIONS",
            scenario_id=_G38_SCENARIO,
        )
        if objects is None:
            return ContractEvaluation(assertions=(), terminal=False)
        _data, state = objects
        if not _native_lineage_matches(
            request, lineage, state
        ) or not _final_history_action(
            state,
            action_name="HOUSEHOLD_OPERATIONS",
            discriminator="assess_responsibility",
            operation="lifeops.household_responsibility.assess",
        ):
            return ContractEvaluation(assertions=(), terminal=False)
        revisions = state.get("revisions")
        current = state.get("currentAssignment")
        signals = state.get("signals")
        reviews = state.get("reviews")
        prior_ids = _string_list(
            state.get("priorAssignmentRevisionIds"),
            minimum=1,
        )
        owner_ids = _string_list(state.get("assignmentOwnerIds"), minimum=1)
        proposal_ids = _string_list(state.get("proposalIds"), minimum=1)
        if (
            not isinstance(revisions, list)
            or len(revisions) < 2
            or not isinstance(current, dict)
            or not isinstance(signals, list)
            or not isinstance(reviews, list)
            or prior_ids is None
            or owner_ids is None
            or proposal_ids is None
        ):
            return ContractEvaluation(assertions=(), terminal=False)
        revision_rows = [
            cast(dict[str, object], revision)
            for revision in revisions
            if isinstance(revision, dict)
        ]
        current_owners = current.get("owners")
        current_revision = current.get("revision")
        if (
            len(revision_rows) != len(revisions)
            or current.get("kind") != "responsibility_assignment"
            or current.get("recordId") != _G38_ASSIGNMENT
            or not isinstance(current_revision, int)
            or not isinstance(current_owners, dict)
            or set(current_owners.values()) != {_G38_PARTNER}
            or sorted(owner_ids) != [_G38_PARTNER]
        ):
            return ContractEvaluation(assertions=(), terminal=False)
        current_revision_number = cast(int, current_revision)
        expected_prior = [
            f"{revision.get('recordId')}:{revision.get('revision')}:"
            f"{revision.get('contentSha256')}"
            for revision in revision_rows
            if isinstance(revision.get("revision"), int)
            and cast(int, revision["revision"]) < current_revision_number
        ]
        immutable = (
            state.get("historyImmutable") is True
            and prior_ids == expected_prior
            and all(
                revision.get("kind") == "responsibility_assignment"
                and revision.get("recordId") == _G38_ASSIGNMENT
                and isinstance(revision.get("contentSha256"), str)
                and bool(
                    re.fullmatch(
                        r"[0-9a-f]{64}",
                        cast(str, revision["contentSha256"]),
                    )
                )
                and isinstance(revision.get("owners"), dict)
                and set(cast(dict[str, object], revision["owners"]).values())
                == {_G38_PARTNER}
                for revision in revision_rows
            )
        )
        signal_rows = [
            cast(dict[str, object], signal)
            for signal in signals
            if isinstance(signal, dict)
            and signal.get("assignmentRecordId") == _G38_ASSIGNMENT
            and signal.get("assignmentRevision") == current.get("revision")
            and signal.get("ownerEntityId") == _G38_PARTNER
            and signal.get("signalKind") in {"dismissed", "overdue"}
        ]
        review_rows = [
            cast(dict[str, object], review)
            for review in reviews
            if isinstance(review, dict)
            and review.get("assignmentRecordId") == _G38_ASSIGNMENT
            and review.get("assignmentRevision") == current.get("revision")
            and review.get("state") == "proposed"
            and review.get("ownerChanges") == []
        ]
        successor_gate = (
            len(signal_rows) >= 2
            and {review.get("reviewId") for review in review_rows} == set(proposal_ids)
            and state.get("acceptedSuccessorAgreementCount") == 0
            and state.get("unapprovedOwnerChangeCount") == 0
        )
        revision = _native_revision(state)
        assertions: list[AssertionArtifact] = []
        if immutable:
            assertions.append(
                _native_assertion(
                    "G38.world.1",
                    subject="responsibility-assignment-history",
                    revision=revision,
                    reference=(
                        "runtime-action://HOUSEHOLD_OPERATIONS/result/data/"
                        "trustedParentContractState/revisions"
                    ),
                )
            )
        if immutable and successor_gate:
            assertions.append(
                _native_assertion(
                    "G38.world.2",
                    subject="responsibility-successor-gate",
                    revision=revision,
                    reference=(
                        "runtime-action://HOUSEHOLD_OPERATIONS/result/data/"
                        "trustedParentContractState/reviews"
                    ),
                )
            )
        return ContractEvaluation(
            assertions=tuple(assertions),
            terminal=immutable and successor_gate,
        )


@dataclass(frozen=True)
class TypedThenNativeEvaluator:
    """Prefer the universal typed snapshot, then try a native exact adapter."""

    typed: ServerOwnedContractEvaluator
    native: ServerOwnedContractEvaluator

    def evaluate(
        self,
        request: ValidatedExecutionRequest,
        execution: ConnectorExecution,
        action_lineage: tuple[ActionLineageEntry, ...],
    ) -> ContractEvaluation:
        typed_result = self.typed.evaluate(
            request,
            execution,
            action_lineage,
        )
        if typed_result.terminal or typed_result.assertions:
            return typed_result
        return self.native.evaluate(request, execution, action_lineage)


def _parent_requirement(contract_id: str) -> TrustedEvidenceRequirement:
    matches = [
        scenario.trusted_evidence_requirement
        for scenario in WORLD_TRAVELING_COPARENT_SCENARIOS
        if scenario.trusted_evidence_requirement is not None
        and scenario.trusted_evidence_requirement.contract_id == contract_id
    ]
    if len(matches) != 1:
        raise RuntimeError(f"expected exactly one parent-suite contract {contract_id}")
    return matches[0]


def production_parent_contract_registry() -> EvidenceContractRegistry:
    """Return all 48 exact contracts with server-owned typed evaluators.

    Contracts whose native actions do not yet emit their required terminal
    snapshot remain registered but nonterminal. This distinction lets the
    signer reject missing production artifacts after an authorized dispatch
    without ever converting generic handler success into benchmark evidence.
    """
    contracts: list[RegisteredEvidenceContract] = []
    for index in range(1, 49):
        requirement = _parent_requirement(f"G{index}")
        typed = typed_parent_contract_evaluator(requirement)
        evaluator = (
            TypedThenNativeEvaluator(
                typed=typed,
                native=CalendarPartialFailureEvaluator(),
            )
            if requirement.contract_id == "G10"
            else (
                TypedThenNativeEvaluator(
                    typed=typed,
                    native=SchoolCorrectionEvaluator(),
                )
                if requirement.contract_id == "G15"
                else (
                    TypedThenNativeEvaluator(
                        typed=typed,
                        native=ChildSizeHistoryEvaluator(),
                    )
                    if requirement.contract_id == "G30"
                    else (
                        TypedThenNativeEvaluator(
                            typed=typed,
                            native=HouseholdCareMathEvaluator(),
                        )
                        if requirement.contract_id == "G34"
                        else (
                            GroundedParentingFrameworkEvaluator()
                            if requirement.contract_id == "G35"
                            else (
                                ParentingSafetyBoundaryEvaluator()
                                if requirement.contract_id == "G36"
                                else (
                                    TypedThenNativeEvaluator(
                                        typed=typed,
                                        native=ResponsibilityRenegotiationEvaluator(),
                                    )
                                    if requirement.contract_id == "G38"
                                    else typed
                                )
                            )
                        )
                    )
                )
            )
        )
        contracts.append(
            RegisteredEvidenceContract(
                requirement=requirement,
                evaluator=evaluator,
            )
        )
    # Uninstructed catalog variants share a contract_id with their base row
    # but carry a bumped version and a different content hash; the registry
    # keys on the full (id, version, sha) tuple, so both must be registered
    # or a live uninstructed run 403s at the executor.
    for scenario in WORLD_TRAVELING_COPARENT_UNINSTRUCTED_SCENARIOS:
        variant = scenario.trusted_evidence_requirement
        if variant is None:
            raise RuntimeError(
                f"uninstructed variant {scenario.id} lacks a "
                "trusted evidence requirement"
            )
        contracts.append(
            RegisteredEvidenceContract(
                requirement=variant,
                evaluator=typed_parent_contract_evaluator(variant),
            )
        )
    return EvidenceContractRegistry(tuple(contracts))
